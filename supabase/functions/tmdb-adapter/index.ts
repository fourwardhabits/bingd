/**
 * tmdb-adapter — the sole holder of the TMDB key and the sole caller of TMDB (AD-8).
 *
 * Four actions, split by who may call them:
 *
 *   search   signed-in user   Titles TMDB knows and the local catalogue does not.
 *                             Writes them through, returns them Bingd-shaped.
 *   detail   signed-in user   Fills one title in: runtime, overview, artwork,
 *                             seasons, credits.
 *   enrich   service_role     Drains tmdb_enrich_due. The Wikidata seed has ids
 *                             and no artwork; this is what gives it posters.
 *   refresh  service_role     Drains media_refresh_due, which is what keeps
 *                             provider data inside PRD §19's six-month window.
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
  noteRequest,
  putFacet,
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

  const rows: TitleRow[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const row = fromSearchResult(result, genres);
    if (!row) continue;
    // /search/multi can repeat an id across media types, and the upsert would
    // then hit the same row twice in one statement — which Postgres refuses with
    // "ON CONFLICT DO UPDATE command cannot affect row a second time".
    const key = `${row.kind}:${row.tmdb_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
    if (rows.length >= limit) break;
  }

  const stored = await upsertTitles(db, rows);

  // Back into the order TMDB gave them in. `INSERT ... RETURNING` makes no promise
  // about row order once ON CONFLICT is involved, and TMDB's relevance ranking is
  // the only ordering signal these rows have — `popularity` was written by this
  // same request, so re-sorting on it would be deriving a worse copy of the answer
  // we were already handed.
  const byKey = new Map(stored.map((row) => [`${row.kind}:${row.tmdbId}`, row.id]));
  const ordered = rows
    .map((row) => byKey.get(`${row.kind}:${row.tmdb_id}`))
    .filter((id): id is string => Boolean(id));

  return json({ results: await searchResultsFor(db, ordered) });
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
