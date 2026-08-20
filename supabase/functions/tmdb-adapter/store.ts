/**
 * Everything the adapter writes, and the only SQL it knows.
 *
 * The writes themselves are the four functions in 20260815000000, called as RPCs
 * for the same reason the client uses RPCs: `media_items_tmdb` is a partial unique
 * index that PostgREST's `.upsert()` cannot infer, and `media_cache.expires_at`
 * has to be derived from `app_config` rather than computed here.
 *
 * This module runs as `service_role`, which bypasses RLS. Nothing in it takes a
 * user id from the request body — the caller's identity is resolved from their JWT
 * in `index.ts` and passed down, so a client cannot spend somebody else's quota by
 * naming them.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { SeasonRow, TitleRow } from './normalize.ts';

export type Db = SupabaseClient;

export function adminClient(): Db {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** What the catalogue write path answers with: a Bingd id for a TMDB one. */
export type StoredTitle = { id: string; kind: 'movie' | 'series'; tmdbId: number };

export async function upsertTitles(db: Db, rows: TitleRow[]): Promise<StoredTitle[]> {
  if (!rows.length) return [];

  const { data, error } = await db.rpc('tmdb_upsert_titles', { p_items: rows });
  if (error) throw new Error(`tmdb_upsert_titles: ${error.message}`);

  return ((data ?? []) as {
    media_item_id: string;
    item_kind: 'movie' | 'series';
    provider_id: number;
  }[]).map((row) => ({ id: row.media_item_id, kind: row.item_kind, tmdbId: row.provider_id }));
}

export async function upsertSeasons(db: Db, parentId: string, rows: SeasonRow[]) {
  if (!rows.length) return [];

  const { data, error } = await db.rpc('tmdb_upsert_seasons', {
    p_parent_id: parentId,
    p_seasons: rows,
  });
  if (error) throw new Error(`tmdb_upsert_seasons: ${error.message}`);

  return ((data ?? []) as { media_item_id: string; season_no: number }[]).map((row) => ({
    id: row.media_item_id,
    seasonNumber: row.season_no,
  }));
}

/**
 * Replaces one provider list whole.
 *
 * Whole rather than merged is the property the table depends on: a trending list is
 * an ordering, and merging two orderings leaves titles in it that TMDB has stopped
 * featuring. See the header of 20260816000900.
 */
export async function putList(db: Db, listKey: string, ids: string[]) {
  const { error } = await db.rpc('tmdb_put_list', {
    p_list_key: listKey,
    p_payload: { ids },
  });
  if (error) throw new Error(`tmdb_put_list: ${error.message}`);
}

/**
 * Claims the right to spend a provider request refreshing one facet.
 *
 * True to exactly one caller while the facet is absent or expired; false to everyone
 * else, including everyone who arrives while the winner is still fetching. See
 * `20260816001000` — the mechanism is `media_cache`'s own primary key, and it
 * replaced a read-then-write check whose comment claimed a guarantee it did not have.
 *
 * A read-then-write check cannot do this. Two accounts opening For You on the same
 * anchor at the same moment both see it stale and both spend, and the per-user hourly
 * ceiling is no help at all because they are different users — which is precisely the
 * population that shares an anchor.
 */
export async function claimFacet(db: Db, mediaItemId: string, facet: string) {
  const { data, error } = await db.rpc('tmdb_claim_facet', {
    p_media_item_id: mediaItemId,
    p_facet: facet,
  });
  if (error) throw new Error(`tmdb_claim_facet: ${error.message}`);
  return data === true;
}

export async function putFacet(db: Db, mediaItemId: string, facet: string, payload: unknown) {
  const { error } = await db.rpc('tmdb_put_facet', {
    p_media_item_id: mediaItemId,
    p_facet: facet,
    p_payload: payload,
  });
  if (error) throw new Error(`tmdb_put_facet: ${error.message}`);
}

/**
 * The person equivalents of `claimFacet` and `putFacet`.
 *
 * Separate functions rather than a widened facet writer because `person_cache` is a
 * separate table with a key of its own — a person is not a facet of any title. The
 * mechanism is identical and 20260817000500 records why the table had to be.
 */
export async function claimPerson(db: Db, personId: number) {
  const { data, error } = await db.rpc('tmdb_claim_person', { p_person_id: personId });
  if (error) throw new Error(`tmdb_claim_person: ${error.message}`);
  return data === true;
}

export async function putPerson(db: Db, personId: number, payload: unknown) {
  const { error } = await db.rpc('tmdb_put_person', {
    p_person_id: personId,
    p_payload: payload,
  });
  if (error) throw new Error(`tmdb_put_person: ${error.message}`);
}

/**
 * Counts requests against the caller's hourly ceiling.
 *
 * 53400 is `configuration_limit_exceeded`, which api.md §8 maps to BG429 — and
 * which PostgREST would otherwise render as a 500, the caveat that section spells
 * out. Translating it here is what makes the mapping true for this surface.
 *
 * **One call, one outbound HTTP attempt.** This is not called per action; it is handed
 * to `tmdb.ts` as a `Charge` and invoked immediately before every `fetch`, retries
 * included. Two rounds of independent review were needed to get there. The first
 * version charged once per action and made up to three requests — the call plus both
 * genre lists on a cold isolate. The second predicted the genre cost and charged that
 * many, which was right about logical requests and still wrong about HTTP ones,
 * because `MAX_RETRIES` is 2 and a failing TMDB turns one logical request into three
 * attempts. A ceiling that counts something other than what leaves the machine is not
 * a ceiling.
 */
export class RateLimited extends Error {}

export async function noteRequest(db: Db, userId: string) {
  const { error } = await db.rpc('tmdb_note_request', { p_user_id: userId });
  if (!error) return;
  if (error.code === '53400') throw new RateLimited('TMDB request limit reached');
  throw new Error(`tmdb_note_request: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type CatalogueRow = {
  id: string;
  kind: 'movie' | 'series' | 'season';
  tmdb_id: number | null;
  parent_id: string | null;
  season_number: number | null;
};

export async function catalogueRow(db: Db, id: string): Promise<CatalogueRow | null> {
  const { data, error } = await db
    .from('media_items')
    .select('id, kind, tmdb_id, parent_id, season_number')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`media_items: ${error.message}`);
  return (data as CatalogueRow) ?? null;
}

export async function tmdbIdOf(db: Db, id: string): Promise<number | null> {
  const { data, error } = await db
    .from('media_items')
    .select('tmdb_id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`media_items: ${error.message}`);
  return (data?.tmdb_id as number | null) ?? null;
}

/**
 * The shape `useTitleSearch` already renders, built here so a remote result and a
 * local one are the same object on the client and can be merged without a mapper.
 */
export type SearchResult = {
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

export async function searchResultsFor(db: Db, ids: string[]): Promise<SearchResult[]> {
  if (!ids.length) return [];

  const { data, error } = await db
    .from('media_items')
    .select('id, kind, title, release_date, poster_path, provenance, genres, runtime_minutes')
    .in('id', ids);
  if (error) throw new Error(`media_items: ${error.message}`);

  const rows = (data ?? []) as Omit<SearchResult, 'season_count'>[];
  const seriesIds = rows.filter((row) => row.kind === 'series').map((row) => row.id);

  const counts = new Map<string, number>();
  if (seriesIds.length) {
    const { data: seasons, error: seasonError } = await db
      .from('media_items')
      .select('parent_id')
      .eq('kind', 'season')
      .in('parent_id', seriesIds);
    if (seasonError) throw new Error(`media_items seasons: ${seasonError.message}`);
    for (const season of (seasons ?? []) as { parent_id: string }[]) {
      counts.set(season.parent_id, (counts.get(season.parent_id) ?? 0) + 1);
    }
  }

  // Restored to the order TMDB returned them in, which is its relevance ranking
  // and the only ordering signal a freshly written row has — `popularity` is
  // set by this same request, so sorting on it here would just re-derive a worse
  // version of the order we were already given.
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is Omit<SearchResult, 'season_count'> => Boolean(row))
    .map((row) => ({
      ...row,
      season_count: row.kind === 'series' ? (counts.get(row.id) ?? 0) : undefined,
    }));
}

/** Ids a maintenance pass should enrich next, newest-referenced first. */
export async function dueForEnrichment(db: Db, limit: number) {
  const { data, error } = await db
    .from('tmdb_enrich_due')
    .select('id, kind, tmdb_id')
    .limit(limit);
  if (error) throw new Error(`tmdb_enrich_due: ${error.message}`);
  return (data ?? []) as { id: string; kind: 'movie' | 'series'; tmdb_id: number }[];
}

export async function dueForRefresh(db: Db, limit: number) {
  const { data, error } = await db
    .from('media_refresh_due')
    .select('id, kind, tmdb_id')
    .limit(limit);
  if (error) throw new Error(`media_refresh_due: ${error.message}`);
  return (data ?? []) as { id: string; kind: 'movie' | 'series' | 'season'; tmdb_id: number }[];
}

export async function countEnrichmentBacklog(db: Db) {
  const { count, error } = await db
    .from('tmdb_enrich_due')
    .select('id', { count: 'exact', head: true });
  if (error) throw new Error(`tmdb_enrich_due count: ${error.message}`);
  return count ?? 0;
}
