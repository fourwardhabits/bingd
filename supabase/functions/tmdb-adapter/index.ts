/**
 * tmdb-adapter — the sole holder of the TMDB key and the sole caller of TMDB (AD-8).
 *
 * Six actions, split by who may call them:
 *
 *   search    signed-in user   Titles TMDB knows and the local catalogue does not.
 *                              Writes them through, returns them Bingd-shaped.
 *   detail    signed-in user   Fills one title in: runtime, overview, artwork,
 *                              seasons, credits.
 *   similar   signed-in user   Caches what TMDB associates with one title, as the
 *                              `similar` facet. The candidate source behind For You.
 *   trending  service_role     Refreshes the four provider_list_cache lists. The
 *                              client reads that table directly; this only fills it.
 *   enrich    service_role     Drains tmdb_enrich_due. The Wikidata seed has ids
 *                              and no artwork; this is what gives it posters.
 *   refresh   service_role     Drains media_refresh_due, which is what keeps
 *                              provider data inside PRD §19's six-month window.
 *
 * Errors use the BGnnn vocabulary from api.md §8 so the client can respond to a
 * class of failure rather than parse a message.
 */

import {
  adminClient,
  catalogueRow,
  countEnrichmentBacklog,
  dueForEnrichment,
  dueForRefresh,
  facetIsFresh,
  noteRequest,
  putFacet,
  putList,
  RateLimited,
  searchResultsFor,
  tmdbIdOf,
  upsertSeasons,
  upsertTitles,
  type Db,
} from './store.ts';
import {
  creditsFacet,
  videosFacet,
  fromMovieDetail,
  fromSearchResult,
  fromSeasonDetail,
  fromSeriesDetail,
  seasonsOf,
  type TitleRow,
} from './normalize.ts';
import * as tmdb from './tmdb.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/**
 * TMDB's own guidance is to stay well inside about fifty requests a second, and a
 * batch of fifty issued at once is also fifty sockets from one isolate. Eight keeps
 * a hundred-title pass under ten seconds without approaching either limit.
 */
const BATCH_CONCURRENCY = 8;

/** One invocation's ceiling. A caller loops rather than asking for the world. */
const MAX_BATCH = 100;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const fail = (code: string, message: string, status: number) =>
  json({ error: { code, message } }, status);

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

type Caller = { kind: 'user'; id: string } | { kind: 'service' };

/**
 * Reads the `role` claim without verifying the signature, which is safe **only**
 * because `verify_jwt = true` in `supabase/config.toml`: the platform validates
 * every Authorization header against the project's JWT secret before this function
 * is invoked, so a token that reaches here has already been proven genuine.
 *
 * That is a real coupling and it is stated in both places. Setting `verify_jwt` to
 * false would not break anything visibly — user search would carry on working,
 * because that path resolves a user through `auth.getUser` — while quietly making
 * the two maintenance actions forgeable by anyone who can write a JSON object. If
 * that flag ever has to change, this function needs a signature check first.
 *
 * A plain equality test against `SUPABASE_SERVICE_ROLE_KEY` was the first attempt
 * and is kept as the fast path, but it cannot be the only one: Supabase now issues
 * `sb_secret_…` keys alongside the legacy JWTs, and which of the two the platform
 * injects is not something this function should have an opinion about.
 */
function claimsServiceRole(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  // base64url to base64: two substitutions and the padding atob insists on.
  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');

  try {
    return JSON.parse(atob(padded))?.role === 'service_role';
  } catch {
    return false;
  }
}

async function resolveCaller(db: Db, req: Request): Promise<Caller | null> {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  // Recognised before `getUser`, which would resolve a service key to no user and
  // report it as an anonymous caller.
  if (token === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) return { kind: 'service' };
  if (claimsServiceRole(token)) return { kind: 'service' };

  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return null;
  return { kind: 'user', id: data.user.id };
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

async function handleSearch(db: Db, query: string, limit: number) {
  const trimmed = query.trim();
  // The same floor useTitleSearch applies. Below it every query matches half of
  // TMDB and spends a provider request to do it.
  if (trimmed.length < 2) return json({ results: [] });

  const [{ results }, genres] = await Promise.all([
    tmdb.searchMulti(trimmed),
    tmdb.genreNames(),
  ]);

  const rows = normalizeList(results, genres, limit);
  return json({ results: await searchResultsFor(db, await storeInOrder(db, rows)) });
}

/**
 * Search-shaped results into title rows, deduplicated and capped.
 *
 * The dedup is not tidiness: /search/multi can repeat an id across media types, and
 * a trending page can repeat one outright. Either way the upsert would hit the same
 * row twice in one statement, which Postgres refuses with "ON CONFLICT DO UPDATE
 * command cannot affect row a second time".
 */
function normalizeList(
  results: tmdb.TmdbSearchResult[],
  genres: Map<number, string>,
  limit: number,
  // The kind to fall back on when the response omits `media_type`, which the
  // single-kind endpoints are entitled to do and /movie/{id}/recommendations always
  // does. Omitted for /search/multi, where a missing type means a person.
  assume?: 'movie' | 'tv',
): TitleRow[] {
  const rows: TitleRow[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const row = fromSearchResult(result, genres, assume);
    if (!row) continue;
    const key = `${row.kind}:${row.tmdb_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
    if (rows.length >= limit) break;
  }
  return rows;
}

/**
 * Writes the rows and hands back their Bingd ids in the order TMDB gave them.
 *
 * `INSERT ... RETURNING` makes no promise about row order once ON CONFLICT is
 * involved, and the provider's own ordering — relevance for a search, trend rank
 * for a trending list — is the only ordering signal these rows have. `popularity`
 * was written by this same request, so re-sorting on it would derive a worse copy
 * of the answer we were already handed.
 */
async function storeInOrder(db: Db, rows: TitleRow[]): Promise<string[]> {
  const stored = await upsertTitles(db, rows);
  const byKey = new Map(stored.map((row) => [`${row.kind}:${row.tmdbId}`, row.id]));
  return rows
    .map((row) => byKey.get(`${row.kind}:${row.tmdb_id}`))
    .filter((id): id is string => Boolean(id));
}

// ---------------------------------------------------------------------------
// trending
// ---------------------------------------------------------------------------

/**
 * The four lists `provider_list_cache` holds, and the TMDB route behind each.
 *
 * `series` on our side is `tv` on theirs. The key uses media_kind because that is
 * what the payload's rows are — see the header of 20260816000900.
 */
const TRENDING_LISTS = [
  { key: 'trending.movie.day', kind: 'movie', window: 'day' },
  { key: 'trending.movie.week', kind: 'movie', window: 'week' },
  { key: 'trending.series.day', kind: 'tv', window: 'day' },
  { key: 'trending.series.week', kind: 'tv', window: 'week' },
] as const;

/** One TMDB trending page. Asking for more would be a second request per list. */
const TRENDING_SIZE = 20;

/**
 * Refreshes all four trending lists.
 *
 * The titles are written through `tmdb_upsert_titles` first and the cached payload
 * holds only their ids, so the poster and overview a trending row renders come from
 * `media_items` and expire on the retention clock rather than on this six-hour one.
 *
 * A list that fails is skipped rather than failing the call: three fresh lists and
 * one stale one is a better outcome than four stale ones, and the stale one still
 * has its previous payload to serve until it is refreshed.
 */
async function handleTrending(db: Db) {
  const genres = await tmdb.genreNames();
  const written: Record<string, number> = {};
  const failed: string[] = [];

  for (const list of TRENDING_LISTS) {
    try {
      const { results } = await tmdb.trending(list.kind, list.window);
      // The kind is asserted rather than read back. TMDB does send `media_type` on
      // these responses today, and a comment here used to say it "is not relied on"
      // — which was wrong, because `fromSearchResult` dropped any row without one.
      // The day TMDB stopped sending it, trending would have emptied silently.
      const ids = await storeInOrder(
        db,
        normalizeList(results, genres, TRENDING_SIZE, list.kind),
      );
      await putList(db, list.key, ids);
      written[list.key] = ids.length;
    } catch (cause) {
      console.error(`tmdb-adapter trending ${list.key} failed`, cause);
      failed.push(list.key);
    }
  }

  return json({ action: 'trending', written, failed });
}

// ---------------------------------------------------------------------------
// similar
// ---------------------------------------------------------------------------

/** One TMDB page is twenty. More would be a second request for a longer tail. */
const SIMILAR_SIZE = 20;

/**
 * What TMDB associates with one title, cached as the `similar` facet.
 *
 * This is the candidate source behind For You. It is a **user** action, like `detail`
 * and unlike `trending`: a slate needs the titles associated with the handful of
 * films that person ranked highest, and nobody else's schedule knows which those are.
 * The cost is bounded on three sides — the client asks for at most six anchors, each
 * answer is cached for every user under the facet TTL, and `noteRequest` applies the
 * same per-user hourly ceiling search does.
 *
 * A **season anchor resolves to its series**. TMDB has no season-level
 * recommendations, and the decision says trending and discovery TV are series-level
 * anyway. The facet is written on the series row, which is where a later reader will
 * look for it.
 */
async function handleSimilar(db: Db, mediaItemId: string, userId: string) {
  const row = await catalogueRow(db, mediaItemId);
  if (!row) return { id: mediaItemId, written: 0, reason: 'not_found' as const };

  // Where the facet belongs, which is not always what was asked about.
  const targetId = row.kind === 'season' ? row.parent_id : row.id;
  if (!targetId) return { id: mediaItemId, written: 0, reason: 'malformed_season' as const };

  // Before the quota is spent, not after. Two devices opening For You at the same
  // moment would otherwise each pay for the same list.
  if (await facetIsFresh(db, targetId, 'similar')) {
    return { id: targetId, written: 0, reason: 'cached' as const };
  }

  const kind = row.kind === 'movie' ? 'movie' : 'tv';
  const tmdbId = row.kind === 'movie' ? row.tmdb_id : await tmdbIdOf(db, targetId);
  if (!tmdbId) return { id: targetId, written: 0, reason: 'no_tmdb_id' as const };

  await noteRequest(db, userId);
  const { results } = await tmdb.recommendations(kind, tmdbId);
  const genres = await tmdb.genreNames();
  // `kind` as the fallback: /recommendations sends no `media_type` whatsoever, so
  // without it every row would be dropped and the facet would cache an empty list.
  const ids = await storeInOrder(db, normalizeList(results, genres, SIMILAR_SIZE, kind));

  // Written even when empty. An obscure title genuinely has no recommendations, and
  // caching that fact is what stops every slate rebuild asking TMDB again.
  await putFacet(db, targetId, 'similar', { ids });
  return { id: targetId, written: ids.length };
}

// ---------------------------------------------------------------------------
// detail
// ---------------------------------------------------------------------------

/**
 * Fills in one catalogue row and returns whether anything was written.
 *
 * A season is enriched through its parent, because TMDB has no endpoint that
 * takes a season's own id: the route is /tv/{series}/season/{n}.
 */
async function enrichOne(db: Db, mediaItemId: string): Promise<{ enriched: boolean; reason?: string }> {
  const row = await catalogueRow(db, mediaItemId);
  if (!row) return { enriched: false, reason: 'not_found' };

  if (row.kind === 'season') {
    if (!row.parent_id || row.season_number === null) {
      return { enriched: false, reason: 'malformed_season' };
    }
    const seriesTmdbId = await tmdbIdOf(db, row.parent_id);
    if (!seriesTmdbId) return { enriched: false, reason: 'no_tmdb_id' };

    const detail = await tmdb.seasonDetail(seriesTmdbId, row.season_number);
    await upsertSeasons(db, row.parent_id, [fromSeasonDetail(detail)]);
    if (detail.credits) await putFacet(db, row.id, 'credits', creditsFacet(detail.credits));
    if (detail.videos) await putFacet(db, row.id, 'videos', videosFacet(detail.videos));
    return { enriched: true };
  }

  if (!row.tmdb_id) return { enriched: false, reason: 'no_tmdb_id' };

  if (row.kind === 'movie') {
    const detail = await tmdb.movieDetail(row.tmdb_id);
    await upsertTitles(db, [fromMovieDetail(detail)]);
    if (detail.credits) await putFacet(db, row.id, 'credits', creditsFacet(detail.credits));
    if (detail.videos) await putFacet(db, row.id, 'videos', videosFacet(detail.videos));
    return { enriched: true };
  }

  const detail = await tmdb.seriesDetail(row.tmdb_id);
  const [stored] = await upsertTitles(db, [fromSeriesDetail(detail)]);
  if (stored) await upsertSeasons(db, stored.id, seasonsOf(detail));
  if (detail.credits) await putFacet(db, row.id, 'credits', creditsFacet(detail.credits));
  if (detail.videos) await putFacet(db, row.id, 'videos', videosFacet(detail.videos));
  return { enriched: true };
}

// ---------------------------------------------------------------------------
// enrich and refresh
// ---------------------------------------------------------------------------

/**
 * Runs `enrichOne` over a batch, a few at a time.
 *
 * One title failing does not fail the batch. A maintenance pass over hundreds of
 * rows will meet a deleted TMDB id eventually, and abandoning the other ninety-nine
 * because of it would mean the pass never completes and the backlog never shrinks.
 */
async function enrichBatch(db: Db, ids: string[]) {
  const failures: { id: string; error: string }[] = [];
  let enriched = 0;
  let skipped = 0;

  const queue = [...ids];
  const workers = Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      try {
        const result = await enrichOne(db, id);
        if (result.enriched) enriched += 1;
        else skipped += 1;
      } catch (cause) {
        failures.push({ id, error: (cause as Error).message });
      }
    }
  });

  await Promise.all(workers);
  return { enriched, skipped, failures };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('BG400', 'POST only', 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail('BG400', 'Body must be JSON', 400);
  }

  const action = String(body.action ?? '');
  const db = adminClient();

  const caller = await resolveCaller(db, req);
  if (!caller) return fail('BG401', 'Sign in to search titles', 401);

  try {
    switch (action) {
      case 'search': {
        if (caller.kind !== 'user') return fail('BG403', 'search is a user action', 403);
        await noteRequest(db, caller.id);
        const limit = clamp(body.limit, 10, 1, 20);
        return await handleSearch(db, String(body.query ?? ''), limit);
      }

      case 'detail': {
        if (caller.kind !== 'user') return fail('BG403', 'detail is a user action', 403);
        const id = String(body.mediaItemId ?? '');
        if (!id) return fail('BG400', 'mediaItemId is required', 400);
        await noteRequest(db, caller.id);
        const result = await enrichOne(db, id);
        if (!result.enriched && result.reason === 'not_found') {
          return fail('BG404', 'No such title', 404);
        }
        return json({ id, ...result });
      }

      // A user action for the same reason detail is: what a slate needs depends on
      // what this person ranked, and no schedule knows that. Bounded by the client
      // asking for at most six anchors, by the facet cache serving every user after
      // the first, and by the same hourly ceiling search observes.
      case 'similar': {
        if (caller.kind !== 'user') return fail('BG403', 'similar is a user action', 403);
        const id = String(body.mediaItemId ?? '');
        if (!id) return fail('BG400', 'mediaItemId is required', 400);
        const result = await handleSimilar(db, id, caller.id);
        if (result.reason === 'not_found') return fail('BG404', 'No such title', 404);
        return json(result);
      }

      // service_role for the same reason enrich and refresh are: it spends four
      // provider requests plus eighty upserts in one call, on a schedule, and no
      // screen asks for it. Clients read the result straight from
      // provider_list_cache, which is world-readable.
      case 'trending': {
        if (caller.kind !== 'service') return fail('BG403', 'trending requires service role', 403);
        return await handleTrending(db);
      }

      // Maintenance. service_role only: both spend provider quota in bulk, and
      // both are jobs rather than anything a screen asks for.
      case 'enrich':
      case 'refresh': {
        if (caller.kind !== 'service') return fail('BG403', `${action} requires service role`, 403);
        const limit = clamp(body.limit, 25, 1, MAX_BATCH);
        const due =
          action === 'enrich'
            ? await dueForEnrichment(db, limit)
            : await dueForRefresh(db, limit);
        const result = await enrichBatch(db, due.map((row) => row.id));
        return json({
          action,
          attempted: due.length,
          ...result,
          remaining: action === 'enrich' ? await countEnrichmentBacklog(db) : undefined,
        });
      }

      default:
        return fail('BG400', `Unknown action: ${action || '(none)'}`, 400);
    }
  } catch (cause) {
    if (cause instanceof RateLimited) {
      return fail('BG429', 'Too many searches. Try again shortly.', 429);
    }
    if (cause instanceof tmdb.TmdbError) {
      // 404 from TMDB is a title that does not exist there, which is a BG404 and
      // not a fault. Everything else upstream is a bad gateway from here.
      if (cause.status === 404) return fail('BG404', 'TMDB has no such title', 404);
      console.error('tmdb-adapter upstream failure', cause.message);
      return fail('BG502', 'The catalogue provider is unavailable', 502);
    }
    console.error('tmdb-adapter failure', cause);
    return fail('BG500', 'Something went wrong', 500);
  }
});

function clamp(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}
