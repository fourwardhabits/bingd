import { FunctionsHttpError } from '@supabase/supabase-js';

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
