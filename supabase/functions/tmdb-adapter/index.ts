/**
 * tmdb-adapter — the sole holder of the TMDB key and the sole caller of TMDB (AD-8).
 *
 * Nine actions, split by who may call them:
 *
 *   search    signed-in user   Titles TMDB knows and the local catalogue does not.
 *                              Writes them through, returns them Bingd-shaped.
 *   detail    signed-in user   Fills one title in: runtime, overview, artwork,
 *                              seasons, credits, trailers, certification. For a
 *                              season it also returns that season's episodes, off
 *                              the same response, for the Episodes tab.
 *   season-episodes
 *             signed-in user   One season's episodes on their own, for a tab whose
 *                              cache `detail` did not seed. Reads nothing into the
 *                              catalogue and writes nothing: episodes are display
 *                              metadata, never stored (PRD §10).
 *   similar   signed-in user   Caches what TMDB associates with one title, as the
 *                              `similar` facet. The candidate source behind For You.
 *   person    signed-in user   Caches one person and the titles TMDB credits them
 *                              on, writing those titles into the catalogue first.
 *   trending  service_role     Refreshes the four provider_list_cache lists. The
 *                              client reads that table directly; this only fills it.
 *   enrich    service_role     Drains tmdb_enrich_due. The Wikidata seed has ids
 *                              and no artwork; this is what gives it posters.
 *   refresh   service_role     Drains media_refresh_due, which is what keeps
 *                              provider data inside PRD §19's six-month window.
 *   hydrate-seasons
 *             service_role     Walks season_hydration_due behind a cursor, re-reading
 *                              each series' whole season list. The scoped backfill for
 *                              the counts a stale deployment never wrote.
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
  dueForSeasonHydration,
  claimFacet,
  claimPerson,
  noteRequest,
  putFacet,
  putList,
  putPerson,
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
  episodesOf,
  fromMovieDetail,
  fromSearchResult,
  fromSeasonDetail,
  fromSeriesDetail,
  personCredits,
  personRecord,
  seasonTarget,
  seasonsOf,
  type Episode,
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

/**
 * The per-attempt charge for one user's invocation.
 *
 * Handed to `tmdb.ts`, which calls it immediately before every outbound attempt —
 * including retries, which is the part that took two rounds of review to get right.
 * A charged unit and an HTTP request are the same thing now.
 *
 * Never constructed for a service-role caller: `enrich`, `refresh` and `trending` are
 * operator jobs, and there is no user whose ceiling they belong against.
 */
const chargeTo = (db: Db, userId: string) => () => noteRequest(db, userId);

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

async function handleSearch(db: Db, query: string, limit: number, userId: string) {
  const trimmed = query.trim();
  // The same floor useTitleSearch applies. Below it every query matches half of
  // TMDB and spends a provider request to do it. Nothing is charged for a query that
  // returns here, because nothing is spent — it used to be charged before this line.
  if (trimmed.length < 2) return json({ results: [] });

  // Charged per outbound attempt rather than per call: the search, both genre lists
  // if this isolate is cold, and every retry of any of them.
  const charge = chargeTo(db, userId);

  const [{ results }, genres] = await Promise.all([
    tmdb.searchMulti(trimmed, charge),
    tmdb.genreNames(charge),
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
 * The cost is bounded on three sides — the client asks about at most six anchors,
 * `tmdb_claim_facet` lets exactly one caller in the world refresh a given facet at a
 * time, and every provider request this makes is charged to the caller's hourly
 * ceiling.
 *
 * "Every request" is the part that had to be fixed. Independent review found this
 * recording one and making three: the recommendations call, plus both genre lists on
 * a cold isolate. The ceiling is only a ceiling if it counts what actually goes out.
 *
 * A **season anchor resolves to its series**. TMDB has no season-level
 * recommendations, and the decision says discovery TV is series-level anyway. The
 * facet is written on the series row, which is where a later reader will look.
 */
async function handleSimilar(db: Db, mediaItemId: string, userId: string) {
  const row = await catalogueRow(db, mediaItemId);
  if (!row) return { id: mediaItemId, written: 0, reason: 'not_found' as const };

  // Where the facet belongs, which is not always what was asked about.
  const targetId = row.kind === 'season' ? row.parent_id : row.id;
  if (!targetId) return { id: mediaItemId, written: 0, reason: 'malformed_season' as const };

  // A season's parent is `not null` by constraint but is not constrained to *be* a
  // series, and this function is about to ask TMDB a /tv question about it. Ordinary
  // data cannot reach here — the adapter validates the parent when it inserts a
  // season — but the table does not enforce what this code assumes, so it is checked
  // rather than assumed. Raised by independent review.
  const target = targetId === row.id ? row : await catalogueRow(db, targetId);
  if (!target || (row.kind === 'season' && target.kind !== 'series')) {
    return { id: mediaItemId, written: 0, reason: 'malformed_season' as const };
  }

  const kind = row.kind === 'movie' ? 'movie' : 'tv';
  const tmdbId = row.kind === 'movie' ? row.tmdb_id : target.tmdb_id;
  // Checked before the claim, so a title TMDB cannot answer about does not hold a
  // two-minute claim that blocks nothing useful and expires into the same refusal.
  if (!tmdbId) return { id: targetId, written: 0, reason: 'no_tmdb_id' as const };

  // Atomic, and it subsumes the freshness check: losing means either the facet is
  // already good or somebody else is fetching it, and neither wants a second request.
  if (!(await claimFacet(db, targetId, 'similar'))) {
    return { id: targetId, written: 0, reason: 'cached' as const };
  }

  const charge = chargeTo(db, userId);
  const { results } = await tmdb.recommendations(kind, tmdbId, charge);
  const genres = await tmdb.genreNames(charge);
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
 *
 * **A season also returns its episodes.** That response already carries them — it is
 * where `episode_count` has come from since `20260820000400` — so handing the
 * normalized list back costs no additional provider request, and the season page
 * whose mount triggered this enrichment can seed its Episodes tab out of the answer
 * it was already waiting for. Nothing is stored; see `episodesOf`.
 */
async function enrichOne(
  db: Db,
  mediaItemId: string,
  // Present for `detail`, absent for the two maintenance batches: those run as
  // service_role against nobody's ceiling.
  charge?: tmdb.Charge,
  /**
   * Whether to normalize the season's episodes into the reply.
   *
   * True only for `detail`, which is a screen waiting for an answer. The
   * maintenance batches run a hundred seasons per invocation and render nothing, so
   * building two hundred episode objects per row there would be work whose only
   * consumer is the garbage collector. Gated explicitly rather than on `charge`
   * being present, which is a fact about billing and not about who is listening.
   */
  withEpisodes = false,
): Promise<{ enriched: boolean; reason?: string; episodes?: Episode[] }> {
  const row = await catalogueRow(db, mediaItemId);
  if (!row) return { enriched: false, reason: 'not_found' };

  if (row.kind === 'season') {
    if (!row.parent_id || row.season_number === null) {
      return { enriched: false, reason: 'malformed_season' };
    }
    const seriesTmdbId = await tmdbIdOf(db, row.parent_id);
    if (!seriesTmdbId) return { enriched: false, reason: 'no_tmdb_id' };

    const detail = await tmdb.seasonDetail(seriesTmdbId, row.season_number, charge);
    await upsertSeasons(db, row.parent_id, [fromSeasonDetail(detail)]);
    if (detail.credits) await putFacet(db, row.id, 'credits', creditsFacet(detail.credits));
    if (detail.videos) await putFacet(db, row.id, 'videos', videosFacet(detail.videos));
    // Additive, and only ever on a season. A client that predates the Episodes tab
    // reads `enriched` off this object and never looks at the rest, so the field is
    // invisible to every build already in the field.
    return withEpisodes ? { enriched: true, episodes: episodesOf(detail) } : { enriched: true };
  }

  if (!row.tmdb_id) return { enriched: false, reason: 'no_tmdb_id' };

  if (row.kind === 'movie') {
    const detail = await tmdb.movieDetail(row.tmdb_id, charge);
    await upsertTitles(db, [fromMovieDetail(detail)]);
    if (detail.credits) await putFacet(db, row.id, 'credits', creditsFacet(detail.credits));
    if (detail.videos) await putFacet(db, row.id, 'videos', videosFacet(detail.videos));
    return { enriched: true };
  }

  const detail = await tmdb.seriesDetail(row.tmdb_id, charge);
  const [stored] = await upsertTitles(db, [fromSeriesDetail(detail)]);
  if (stored) await upsertSeasons(db, stored.id, seasonsOf(detail));
  if (detail.credits) await putFacet(db, row.id, 'credits', creditsFacet(detail.credits));
  if (detail.videos) await putFacet(db, row.id, 'videos', videosFacet(detail.videos));
  return { enriched: true };
}

// ---------------------------------------------------------------------------
// season-episodes
// ---------------------------------------------------------------------------

/**
 * One season's episodes, for the Episodes tab, without touching the catalogue.
 *
 * **The fallback, not the usual path.** A season page enriches on mount and
 * `detail` already returns this same list off the same provider response, so the
 * common flow costs no request at all. This exists for the cases the seeding cannot
 * cover: an enrichment that failed silently, a row complete enough that `detail` was
 * never called, or a reader who opened the tab in a session where the seed was
 * evicted.
 *
 * **A user action, and charged.** It spends a provider request on somebody's behalf,
 * exactly like `detail`, `similar` and `person`, so it observes the same hourly
 * ceiling and there is deliberately no service-role path into it.
 *
 * **Nothing here is caller-controlled.** The body carries one Bingd uuid. The series
 * id and the season number are read out of `media_items`, which is the same trusted
 * resolution `enrichOne` performs, so no part of the outbound URL comes from the
 * request. That is the property worth stating: this is not a proxy.
 *
 * Read-only by design. `detail` is what keeps the catalogue current; a tab asking
 * what is in a season should not be a write.
 */
async function handleSeasonEpisodes(db: Db, mediaItemId: string, userId: string) {
  const row = await catalogueRow(db, mediaItemId);
  if (!row) return { id: mediaItemId, episodes: [], reason: 'not_found' as const };

  // Read before the target is resolved, and only when there is a parent to read.
  const parent = row.parent_id ? await catalogueRow(db, row.parent_id) : null;

  // Every refusal, in one pure function that tests can reach. Nothing below this
  // line comes from the request body.
  const target = seasonTarget(row, parent);
  if (!target.ok) return { id: mediaItemId, episodes: [], reason: target.reason };

  const detail = await tmdb.seasonDetail(
    target.seriesTmdbId,
    target.seasonNumber,
    // Charged per outbound attempt, retries included, exactly as `detail` is. There
    // is no path through this handler that reaches TMDB uncharged.
    chargeTo(db, userId),
  );
  return { id: mediaItemId, episodes: episodesOf(detail) };
}

// ---------------------------------------------------------------------------
// person
// ---------------------------------------------------------------------------

/**
 * One person and the titles TMDB credits them on, cached in `person_cache`.
 *
 * A **user** action, like `detail` and `similar` and for the same reason: it is
 * triggered by somebody opening a screen, and no schedule knows which face they
 * tapped. Bounded on the same three sides — one page opens one person, the claim
 * lets exactly one caller in the world refresh a given person at a time, and every
 * provider request it makes is charged to the caller's hourly ceiling.
 *
 * The credited titles are written through `tmdb_upsert_titles` first, so the page
 * renders posters, years and titles out of `media_items` like every other surface in
 * the app, and a credit is a real catalogue row the reader can open, rank and add to
 * their watchlist. That write is the whole reason the person page stops being a view
 * of the reader's own catalogue: what it lists is now what TMDB knows, and opening
 * one of them is not an import step.
 */
async function handlePerson(db: Db, personId: number, userId: string) {
  // Atomic, and it subsumes the freshness check: losing means either the row is
  // already good or somebody else is fetching it, and neither wants a second request.
  if (!(await claimPerson(db, personId))) {
    return { id: personId, written: 0, reason: 'cached' as const };
  }

  const charge = chargeTo(db, userId);
  const detail = await tmdb.personDetail(personId, charge);
  const genres = await tmdb.genreNames(charge);

  const { credits, total } = personCredits(detail, genres);

  // Paired by key rather than by index. `storeInOrder` filters out rows that failed
  // to store, so its output is shorter than its input exactly when something went
  // wrong — and a positional join would then attach every later credit's character
  // name to the wrong film rather than dropping one.
  const stored = await upsertTitles(db, credits.map((credit) => credit.row));
  const idByKey = new Map(stored.map((row) => [`${row.kind}:${row.tmdbId}`, row.id]));

  const rows = credits
    .map((credit) => ({ credit, id: idByKey.get(`${credit.row.kind}:${credit.row.tmdb_id}`) }))
    .filter((entry): entry is { credit: (typeof credits)[number]; id: string } => Boolean(entry.id));

  await putPerson(db, personId, {
    person: personRecord(detail),
    credits: rows.map(({ credit, id }) => ({
      id,
      kind: credit.row.kind,
      role: credit.role,
      as: credit.as,
    })),
    credit_total: total,
  });

  return { id: personId, written: rows.length, total };
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
        const query = String(body.query ?? '');
        // Charged inside `handleSearch`, after the two-character floor and for every
        // request it actually makes — the genre lists included. It used to be charged
        // here, which billed a query too short to spend anything and under-billed one
        // that spent three. Both directions found by independent review.
        const limit = clamp(body.limit, 10, 1, 20);
        return await handleSearch(db, query, limit, caller.id);
      }

      case 'detail': {
        if (caller.kind !== 'user') return fail('BG403', 'detail is a user action', 403);
        const id = String(body.mediaItemId ?? '');
        if (!id) return fail('BG400', 'mediaItemId is required', 400);
        // Charged per outbound attempt inside the TMDB client, retries included.
        // `withEpisodes`: this is a screen waiting, and a season's episodes ride back
        // on the response it is already waiting for.
        const result = await enrichOne(db, id, chargeTo(db, caller.id), true);
        if (!result.enriched && result.reason === 'not_found') {
          return fail('BG404', 'No such title', 404);
        }
        return json({ id, ...result });
      }

      // The Episodes tab's own fetch, for when `detail` did not seed it. A user
      // action and charged, like every other action a screen triggers.
      case 'season-episodes': {
        if (caller.kind !== 'user') {
          return fail('BG403', 'season-episodes is a user action', 403);
        }
        const id = String(body.mediaItemId ?? '');
        if (!id) return fail('BG400', 'mediaItemId is required', 400);
        const result = await handleSeasonEpisodes(db, id, caller.id);
        if (result.reason === 'not_found') return fail('BG404', 'No such title', 404);
        if (result.reason === 'not_a_season') {
          return fail('BG400', 'Episodes belong to a season', 400);
        }
        return json(result);
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

      // A user action, like detail and similar: somebody tapped a face, and no
      // schedule knows which. The person id is TMDB's own, which is what the cast
      // payload carries and what the route already uses.
      case 'person': {
        if (caller.kind !== 'user') return fail('BG403', 'person is a user action', 403);
        const personId = Number(body.personId);
        // A positive integer, not merely a finite number — which rules out the
        // decimals, negatives and exponent forms `Number.isFinite` waves through and
        // TMDB would 404 on after a charged request.
        if (!Number.isSafeInteger(personId) || personId <= 0) {
          return fail('BG400', 'personId must be a positive integer', 400);
        }
        return json(await handlePerson(db, personId, caller.id));
      }

      // service_role for the same reason enrich and refresh are: it spends four
      // provider requests plus eighty upserts in one call, on a schedule, and no
      // screen asks for it. Clients read the result straight from
      // provider_list_cache, which is world-readable.
      case 'trending': {
        if (caller.kind !== 'service') return fail('BG403', 'trending requires service role', 403);
        return await handleTrending(db);
      }

      // Maintenance. service_role only: all three spend provider quota in bulk, and
      // all three are jobs rather than anything a screen asks for.
      //
      // `hydrate-seasons` (20260903000100) is the scoped season backfill. It repairs a
      // series the only way a season list can be repaired — re-reading the series detail
      // and rewriting the whole list through `tmdb_upsert_seasons`, an upsert that
      // deletes nothing, so a ranking, a watch state and a season's progress all stay
      // attached to the row they were attached to.
      //
      // **It walks rather than drains.** `season_hydration_due` permanently contains a
      // series whose provider reports a season as having zero episodes, and one whose
      // provider has dropped a season it once named — so it never empties, and a
      // `remaining` over it could never reach zero. The caller carries `after`, the last
      // id of the previous page, and the pass is finished when a page comes back short.
      // `next` is what to send back; null means the walk is done.
      case 'enrich':
      case 'refresh':
      case 'hydrate-seasons': {
        if (caller.kind !== 'service') return fail('BG403', `${action} requires service role`, 403);
        const limit = clamp(body.limit, 25, 1, MAX_BATCH);
        const after = typeof body.after === 'string' && body.after ? body.after : undefined;
        const due =
          action === 'enrich'
            ? await dueForEnrichment(db, limit)
            : action === 'refresh'
              ? await dueForRefresh(db, limit)
              : await dueForSeasonHydration(db, limit, after);
        const result = await enrichBatch(db, due.map((row) => row.id));
        return json({
          action,
          attempted: due.length,
          ...result,
          remaining: action === 'enrich' ? await countEnrichmentBacklog(db) : undefined,
          // Present only for the walk, and only while there is more of it. `due.length <
          // limit` is the end: a short page cannot be followed by a full one over a set
          // ordered by a key nothing renumbers.
          next:
            action === 'hydrate-seasons' && due.length === limit
              ? (due[due.length - 1]?.id ?? null)
              : undefined,
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
