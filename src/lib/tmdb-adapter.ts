import { FunctionsHttpError } from '@supabase/supabase-js';

import { productGenres } from './media-metadata';
import { supabase } from './supabase';

/**
 * The client half of the `tmdb-adapter` Edge Function.
 *
 * **This file holds no credential and talks to no provider.** It posts to a
 * function on Bingd's own Supabase project, which is the sole holder of the TMDB
 * key (AD-8). The distinction is the whole point of the architecture decision, so
 * it is worth stating where someone might otherwise add a fetch to api.themoviedb.org
 * "just for search": a key in the client bundle is a key published, and PRD §19
 * makes that a non-negotiable.
 *
 * What comes back is Bingd-shaped — `media_items` rows with Bingd uuids, already
 * written to the catalogue — so a remote result and a local one are the same object
 * and the caller does not know which is which.
 */

export type AdapterSearchResult = {
  id: string;
  kind: 'movie' | 'series' | 'season';
  title: string;
  release_date: string | null;
  poster_path: string | null;
  provenance: 'tmdb' | 'wikidata' | 'manual';
  genres: string[];
  runtime_minutes: number | null;
  season_count?: number;
};

/** The BGnnn vocabulary from api.md §8, as far as this surface can produce it. */
export class AdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }

  /** True where retrying the same request is pointless and a message is owed. */
  get isRateLimit() {
    return this.code === 'BG429';
  }
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('tmdb-adapter', { body });

  if (!error) return data as T;

  // supabase-js reports a non-2xx as an error whose body it has not read, so the
  // structured code the function sent is one await away and easy to drop on the
  // floor. Without this every failure reads as "Edge Function returned a non-2xx
  // status code", which tells a user nothing and tells Sentry less.
  if (error instanceof FunctionsHttpError) {
    try {
      const payload = (await error.context.json()) as { error?: { code?: string; message?: string } };
      if (payload?.error?.code) {
        throw new AdapterError(payload.error.code, payload.error.message ?? error.message);
      }
    } catch (parsed) {
      if (parsed instanceof AdapterError) throw parsed;
    }
  }

  throw new AdapterError('BG500', error.message);
}

/**
 * The product genres for adapter results, resolved here rather than at a screen.
 *
 * **The founder's photograph, 2026-08-30: the title page said Anime and the search row
 * for the same film said Animation.** The local half of search already normalised — it
 * reads `media_items` itself and goes through `productGenres` — but the provider half
 * returns the adapter's own rows, whose `genres` are the catalogue column verbatim, and
 * the merge in `useTitleSearch` prefers the remote copy for a title present in both. So
 * the moment a search reached TMDB, every row on the screen reverted to raw labels.
 *
 * Fixed at the adapter boundary and not at the screen, because that is the one place
 * every present and future caller of {@link searchProvider} passes through. The rule
 * itself is unchanged and lives where it already lived: `lib/media-metadata`.
 *
 * The extra input is `original_language`, which the adapter's payload does not carry and
 * the predicate needs, so this reads it back from `media_items` — a table read against
 * ids the adapter has just written, on a path that has already spent a provider request.
 * A failed or partial lookup leaves that row's genres exactly as they arrived: a search
 * result missing one label is a worse row, and a search that fails because a genre could
 * not be decorated is a worse product.
 */
async function withProductGenres(rows: AdapterSearchResult[]): Promise<AdapterSearchResult[]> {
  if (!rows.length) return rows;

  const { data, error } = await supabase
    .from('media_items')
    .select('id, kind, genres, original_language')
    .in(
      'id',
      rows.map((row) => row.id),
    );
  if (error || !data) return rows;

  const metaById = new Map(
    (data as { id: string; kind: string; genres: string[] | null; original_language: string | null }[]).map(
      (row) => [row.id, row],
    ),
  );

  return rows.map((row) => {
    const meta = metaById.get(row.id);
    if (!meta) return row;
    return {
      ...row,
      // A search result is a film or a series, never a season, so there is no parent to
      // inherit from and the subject is the row itself — the same reasoning the local
      // pass states.
      genres: productGenres({
        kind: meta.kind as 'movie' | 'series' | 'season',
        genres: meta.genres,
        language: meta.original_language,
      }),
    };
  });
}

/**
 * Titles TMDB knows about, written into the catalogue as a side effect.
 *
 * Every result already exists in `media_items` by the time this resolves, which is
 * what lets the caller push straight to `/title/{id}` — there is no "import this
 * title" step, and no id that means something only to TMDB.
 *
 * Genres come back as **product** genres — see {@link withProductGenres}.
 */
export async function searchProvider(query: string, limit = 10) {
  const data = await invoke<{ results: AdapterSearchResult[] }>({
    action: 'search',
    query,
    limit,
  });
  return withProductGenres(data.results ?? []);
}

/**
 * One episode of a season, as the Episodes tab renders it.
 *
 * Informational metadata and nothing else. An episode is not a `media_items` row, is
 * not rankable and is not loggable (PRD §10); this exists so a reader can recognise
 * which season of a show they actually watched. Every field but the number is
 * nullable, because the provider treats them that way and the row draws around
 * whatever is missing.
 */
export type TitleEpisode = {
  episode_number: number;
  title: string | null;
  air_date: string | null;
  runtime_minutes: number | null;
  still_path: string | null;
  overview: string | null;
};

/**
 * Fills one title in: runtime, overview, artwork, credits, and a series' seasons.
 *
 * Returns whether anything was written, so a caller can avoid invalidating a query
 * that would come back identical.
 *
 * **For a season it also returns that season's episodes**, which the adapter reads
 * off the very same provider response it was already fetching. `use-enrichment`
 * seeds the Episodes cache from this, which is why opening the tab on an ordinary
 * season page costs no provider request of its own.
 */
export async function enrichTitle(mediaItemId: string) {
  const data = await invoke<{
    enriched: boolean;
    reason?: string;
    episodes?: TitleEpisode[];
  }>({
    action: 'detail',
    mediaItemId,
  });
  return data;
}

/**
 * One season's episodes, asked for on their own.
 *
 * The Episodes tab's fallback. `enrichTitle` already carries this list on the
 * response a season page waits for on mount, so this runs only when that seeding did
 * not happen — an enrichment that failed silently, or a row already complete enough
 * that `detail` was never called.
 *
 * The caller passes the season's Bingd id and nothing else. The series id and the
 * season number are read out of `media_items` inside the adapter, so no part of the
 * provider URL comes from this client, and the TMDB credential stays where AD-8 puts
 * it.
 */
export async function fetchSeasonEpisodes(mediaItemId: string) {
  const data = await invoke<{ id: string; episodes: TitleEpisode[]; reason?: string }>({
    action: 'season-episodes',
    mediaItemId,
  });
  return data.episodes ?? [];
}

/** How a title can be watched. Three, and TMDB's `flatrate` is Bingd's `stream`. */
export type WatchOffer = 'stream' | 'rent' | 'buy';

/**
 * One streaming service, and every way this title is offered on it.
 *
 * A service offered two ways — Apple TV rents and sells almost everything — is one
 * entry carrying both, not two rows with the same logo. `logo_path` is TMDB's path
 * form, like every other image in the app; `src/lib/images.ts` turns it into a URL.
 *
 * There is deliberately **no per-service link**. TMDB's payload carries none, so a
 * logo opens nothing: building `netflix.com/title/…` out of a provider name would be
 * a guess presented to the reader as a destination.
 */
export type WatchProvider = {
  provider_id: number;
  name: string;
  logo_path: string | null;
  offers: WatchOffer[];
};

export type WatchAvailability = {
  /** The country actually answered for, which may not be the one the device asked about. */
  region: string;
  /** TMDB's own watch-options page for this title in this region, or null. */
  link: string | null;
  providers: WatchProvider[];
};

/**
 * Where one title can be watched, from JustWatch by way of TMDB.
 *
 * **Read-only.** Unlike `similar` and `person` this caches nothing server-side and
 * writes nothing to the catalogue: availability moves on the provider's schedule, and
 * the only cache is this device's own query entry. One provider request per call,
 * charged to the reader's hourly ceiling like every other screen-triggered fetch.
 *
 * The caller passes the title's Bingd id and a country code. The country is used to
 * pick one bucket out of the response — the route has no region parameter — and the
 * TMDB id, series id and season number all come out of `media_items` inside the
 * adapter, so no part of the outbound URL comes from here.
 *
 * An empty `providers` list is a real answer: TMDB has nothing for this title in this
 * market. The caller draws nothing rather than an empty state.
 */
export async function fetchWatchProviders(
  mediaItemId: string,
  region: string,
): Promise<WatchAvailability> {
  const data = await invoke<Partial<WatchAvailability> & { reason?: string }>({
    action: 'watch-providers',
    mediaItemId,
    region,
  });
  return {
    region: data.region ?? region,
    link: data.link ?? null,
    providers: data.providers ?? [],
  };
}

/**
 * Caches what TMDB associates with one title, as the `similar` facet.
 *
 * The candidate source behind For You. The client reads the facet from `media_cache`
 * directly — it is catalogue data and world-readable — and only calls this when the
 * facet is missing or expired, so a warm slate costs no provider request at all. The
 * adapter re-checks freshness before spending one anyway, because a client's guard is
 * an optimisation and the server's is a limit.
 *
 * `id` is what the facet was written against, which is **not** always what was asked
 * about: a season resolves to its series, because TMDB has no season-level
 * recommendations.
 */
export async function cacheSimilar(mediaItemId: string) {
  return invoke<{ id: string; written: number; reason?: string }>({
    action: 'similar',
    mediaItemId,
  });
}

/**
 * Caches one person and the titles TMDB credits them on.
 *
 * `personId` is TMDB's, not a Bingd uuid — there is no Bingd person, deliberately
 * (20260817000500). It is what a `credits` payload carries and what `/person/{id}`
 * already routes on.
 *
 * Every credited title is written into `media_items` as a side effect, which is what
 * makes the person page a discovery surface rather than a filtered view of the
 * reader's own catalogue: a film they have never heard of is a real catalogue row by
 * the time it appears, so opening it, ranking it or saving it needs no import step.
 *
 * The client reads `person_cache` directly — it is catalogue data and world-readable
 * — and only calls this when the row is missing or expired. The adapter re-checks
 * before spending a provider request anyway, because a client's guard is an
 * optimisation and the server's is a limit.
 */
export async function cachePerson(personId: number) {
  return invoke<{ id: number; written: number; total?: number; reason?: string }>({
    action: 'person',
    personId,
  });
}
