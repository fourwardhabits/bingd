import { FunctionsHttpError } from '@supabase/supabase-js';

import { note } from './flight-recorder';
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
    /**
     * The class of the underlying failure, where the function never spoke at all.
     *
     * **The distinction blocker 3 turns on.** `BG500` means the function answered and said
     * something went wrong inside it. A `FunctionsFetchError` or a `RequestDeadlineError`
     * means there was no answer — the same shape as the build-4 stall, and a different
     * investigation entirely. Both used to be reported as `BG500`, because there was no
     * code in the vocabulary for "no reply" and inventing one would have been a lie about
     * what the server said. So the transport class travels beside the code instead, and
     * the recorder prefers it when it is there.
     */
    readonly transport?: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }

  /** True where retrying the same request is pointless and a message is owed. */
  get isRateLimit() {
    return this.code === 'BG429';
  }
}

/**
 * One adapter call, and its outcome as a **code**.
 *
 * The founder's title search failed with "the wider search did not answer" while the same
 * query, run against the same deployed function with the same user, returned
 * *The Lizzie McGuire Movie* in under a second. So the failure is on the device and the
 * only useful question is which one of these it was — and until this existed, every one of
 * them arrived at the screen as the same sentence:
 *
 *   · `BG401` — the function did not recognise the caller. An auth problem wearing a
 *     search problem's clothes, and the one the local pass succeeding makes surprising.
 *   · `BG429` — the hourly TMDB allowance is spent. Already has its own copy on screen.
 *   · `BG502` — TMDB itself was unavailable.
 *   · `BG500` — everything else the function knows about.
 *   · `FunctionsFetchError` / `RequestDeadlineError` — it never got an answer at all,
 *     which is the same shape as the build-4 stall and belongs beside the network log.
 *
 * The code is a constant from `api.md` §8 and the class name is a class name. Neither is
 * anybody's data, and the query string — which is what somebody typed — is nowhere near
 * this.
 */
async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const action = typeof body.action === 'string' ? body.action : 'unknown';
  const began = Date.now();
  const record = (outcome: string) =>
    note('query', `adapter:${action}`, outcome, Date.now() - began);

  try {
    const value = await invoked<T>(body);
    record('ok');
    return value;
  } catch (error) {
    record(
      error instanceof AdapterError
        ? (error.transport ?? error.code)
        : classNameOf(error),
    );
    throw error;
  }
}

/** The call itself. Split out so the recording above wraps every lane out of it. */
async function invoked<T>(body: Record<string, unknown>): Promise<T> {
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

  // Not a structured refusal from the function, so the transport class comes with it —
  // see `AdapterError.transport`. `FunctionsFetchError` here means no answer arrived.
  throw new AdapterError('BG500', error.message, classNameOf(error));
}

/** The class name and never the message: a relayed error can echo what was sent. */
function classNameOf(error: unknown): string {
  if (error && typeof error === 'object') {
    const named = error as { name?: unknown };
    if (typeof named.name === 'string' && named.name) return named.name;
  }
  return typeof error;
}

/**
 * Titles TMDB knows about, written into the catalogue as a side effect.
 *
 * Every result already exists in `media_items` by the time this resolves, which is
 * what lets the caller push straight to `/title/{id}` — there is no "import this
 * title" step, and no id that means something only to TMDB.
 */
export async function searchProvider(query: string, limit = 10) {
  const data = await invoke<{ results: AdapterSearchResult[] }>({
    action: 'search',
    query,
    limit,
  });
  return data.results ?? [];
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
