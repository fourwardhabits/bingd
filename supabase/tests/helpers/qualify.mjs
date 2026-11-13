/**
 * Community-score contributor eligibility fixtures (20261119000100).
 *
 * Since 20261119000100 a rater's rankings count toward a community score only once that
 * rater has `score.contributor_min_rankings` (10) completed rankings in the category:
 * movies, or TV (seasons and whole shows combined). A test about something else (blocks,
 * agreement with Top Rated, a show's aggregate) whose raters each rank one or two titles
 * therefore needs those raters to be eligible first, and this is how it makes them so.
 *
 * Every filler goes through the real ranking engine (`rank_start` / `rank_answer`, via
 * the harness's `rankToCompletion`), not an insert, and every filler is placed in
 * **not_for_me with the incumbent winning every comparison**, so it lands at the bottom
 * of the bottom band. A filler never shares a band with a test's `loved` or `fine`
 * subject, so it moves none of their positions or scores (score_for reads a title's rank
 * and size *within its own band*). A test whose subject is itself not_for_me must account
 * for the fillers, or qualify after ranking it in a band of its own.
 *
 * Fillers are distinct fixture titles per call, so no two raters share one, and each has
 * exactly one rater: none of them ever reaches a support floor or shows up on a wall.
 *
 * Leaves `auth.uid()` set to the qualified user. Callers that act as somebody else next
 * say so with their own `actAs`.
 */

/** Distinct negative tmdb ids, far from every other fixture range in the suite. */
let seq = 7_000_000;

/**
 * Ranks `n` filler titles for `userId` in a group.
 *
 * @param t       the harness test API (`createTestDb()`'s result)
 * @param userId  whom to qualify
 * @param group   'movies' | 'seasons' | 'shows'
 * @param n       how many rankings to add (default 10, the threshold)
 */
export async function addFillerRankings(t, userId, group, n = 10) {
  await t.actAs(userId);
  const ids = [];
  if (group === 'movies') {
    for (let i = 0; i < n; i += 1) ids.push(await t.createMovie(`filler movie ${seq}`, seq++));
  } else if (group === 'shows') {
    for (let i = 0; i < n; i += 1) ids.push(await t.createSeries(`filler show ${seq}`, seq++));
  } else if (group === 'seasons') {
    const parent = await t.createSeries(`filler series ${seq}`, seq++);
    for (let i = 0; i < n; i += 1) ids.push(await t.createSeason(parent, i + 1, `S${i + 1}`));
  } else {
    throw new Error(`addFillerRankings: unknown group ${group}`);
  }
  for (const id of ids) {
    await t.rankToCompletion(id, 'not_for_me', async (pivot) => pivot);
  }
  return ids;
}

/** Makes a user movie-eligible: ten filler movie rankings. */
export const qualifyForMovies = (t, userId, n = 10) =>
  addFillerRankings(t, userId, 'movies', n);

/** Makes a user TV-eligible: ten filler season rankings (of one filler series). */
export const qualifyForTv = (t, userId, n = 10) => addFillerRankings(t, userId, 'seasons', n);

/** Reads `community_score` for one title as the current `auth.uid()`. */
export async function communityScore(t, mediaItemId) {
  const { rows } = await t.sql(`select * from community_score($1)`, [mediaItemId]);
  const row = rows[0];
  return {
    score: row.score == null ? null : Number(row.score),
    rating_count: row.rating_count,
    min_ratings: row.min_ratings,
  };
}

/**
 * Makes a user eligible for the category a title belongs to: movie fillers for a movie,
 * season fillers for a season or a series. For re-seeding suites written before
 * 20261119000100, whose raters rank one title each.
 */
export async function qualifyFor(t, userId, mediaItemId, n = 10) {
  const { rows } = await t.sql(`select kind from media_items where id = $1`, [mediaItemId]);
  const kind = rows[0]?.kind;
  if (!kind) throw new Error(`qualifyFor: no media item ${mediaItemId}`);
  return addFillerRankings(t, userId, kind === 'movie' ? 'movies' : 'seasons', n);
}
