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
 * Fills one title in: runtime, overview, artwork, credits, and a series' seasons.
 *
 * Returns whether anything was written, so a caller can avoid invalidating a query
 * that would come back identical.
 */
export async function enrichTitle(mediaItemId: string) {
  const data = await invoke<{ enriched: boolean; reason?: string }>({
    action: 'detail',
    mediaItemId,
  });
  return data;
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
