import { bandSizes, scoreFor, type Bucket } from './score';
import type { RankedEntry } from './use-collection';

/**
 * **One poster per series: the effective show score** (founder spec t168u §2, 2026-11-13).
 *
 * Whole-show and season rankings stay two separate ladders. The TV Collection draws one
 * poster per parent series, and this derives the score that poster carries. It is a pure
 * function over the two pools every Collection surface already reads in full
 * (`useRankedCollection(user, 'tv_seasons' | 'tv_shows')`), so it costs no request, no
 * RPC and no per-series read, and nothing it computes is ever stored.
 *
 * ---------------------------------------------------------------------------
 * THE RULE (the interface contract shared with WS-COMM, 04)
 *
 *   1. The user ranked the show (`tv_shows`): **explicit**, that ranking's canonical
 *      score (`scoreFor` against the whole `tv_shows` band sizes, 1 dp).
 *   2. Else they ranked ≥ 1 season of it (`tv_seasons`, `seriesId` = the show):
 *      **average**, the arithmetic mean of those seasons' canonical scores (each 1 dp),
 *      **not rounded**. Each season once (the rankings key guarantees it); unranked
 *      seasons, watch events and placement snapshots are never read.
 *   3. Else: nothing. No ranked poster.
 *
 * Arithmetic is in integer tenths, so nothing here is a float mean: `sumTenths` is the
 * sum of `round(score × 10)` over the contributors and `n` is how many there are. The
 * display value rounds half-up to 1 dp, `floor((2 × sumTenths + n) / (2 × n)) / 10`,
 * because 8.6 and 8.7 average to 8.649999… as a float and `toFixed` would print 8.6.
 * Ordering compares `sumTenths_a × n_b` with `sumTenths_b × n_a`, which is exact.
 *
 * Band sizes are computed over each **whole** pool, never a filtered slice — scoring a
 * slice against itself would hand its top row a 10.
 */
export type ShowScoreSource = 'explicit' | 'average';

export type ShowProjection = {
  /** The parent series' media id: what the poster opens. */
  seriesId: string;
  source: ShowScoreSource;
  /** Σ round(score × 10) over the contributors. */
  sumTenths: number;
  /** How many contributors: 1 for an explicit score, the ranked-season count otherwise. */
  n: number;
  /** The exact effective score, for anything that needs a number (never for ordering). */
  score: number;
  /** Half-up to 1 dp, from the integer tenths. */
  display: number;
  /** The seasons of this series the user has ranked, whichever source wins. */
  rankedSeasonCount: number;
  /** The media ids whose rankings produce the score (rankings are keyed by user + item). */
  contributors: string[];
  /** The latest `rankedAt` among the contributors. */
  rankedAt: string | null;
  /**
   * The tie-break after the score and the source: the explicit show's `tv_shows`
   * position, or the best (lowest) contributing season position.
   */
  tiePosition: number;
  /** The explicit show's band, or null for an average. */
  bucket: Bucket | null;
  /** The series' display facts, resolved from whatever of it the user ranked. */
  title: string;
  posterPath: string | null;
  year: number | null;
  genres: string[];
  language: string | null;
  /** The ranked show row, when there is one. */
  show: RankedEntry | null;
  /** The ranked seasons, in season order. */
  seasons: RankedEntry[];
};

/** Half-up to 1 dp of `sumTenths / (10 × n)`, in integers. */
export const displayTenths = (sumTenths: number, n: number): number =>
  Math.floor((2 * sumTenths + n) / (2 * n)) / 10;

/** A canonical 1 dp score as integer tenths. */
const tenths = (score: number): number => Math.round(score * 10);

/**
 * Descending by effective score at full precision, then explicit before average, then
 * the tie position, then title (locale compare), then series id. Total and deterministic.
 */
export function compareShowProjections(a: ShowProjection, b: ShowProjection): number {
  const byScore = b.sumTenths * a.n - a.sumTenths * b.n;
  if (byScore !== 0) return byScore;
  const bySource = (a.source === 'explicit' ? 0 : 1) - (b.source === 'explicit' ? 0 : 1);
  if (bySource !== 0) return bySource;
  if (a.tiePosition !== b.tiePosition) return a.tiePosition - b.tiePosition;
  const byTitle = a.title.localeCompare(b.title);
  if (byTitle !== 0) return byTitle;
  return a.seriesId < b.seriesId ? -1 : a.seriesId > b.seriesId ? 1 : 0;
}

/** The latest of two ISO timestamps, either of which may be missing. */
const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

/** Season order inside a series: by number, then id, so "first ranked season" is stable. */
const bySeason = (a: RankedEntry, b: RankedEntry) =>
  (a.seasonNumber ?? Number.MAX_SAFE_INTEGER) - (b.seasonNumber ?? Number.MAX_SAFE_INTEGER) ||
  (a.mediaItemId < b.mediaItemId ? -1 : a.mediaItemId > b.mediaItemId ? 1 : 0);

/**
 * Every series the user has a ranked show or a ranked season of, with its effective
 * score, in Rating order. One pass over each pool, then one per series over its own
 * seasons: linear in the pools, whatever their size.
 *
 * A season with no `seriesId` (a catalogue row whose parent was never written) is its
 * own series, keyed by its own id, rather than dropped: it is still something the user
 * ranked, and the ladder underneath is untouched either way.
 */
export function projectShows(
  seasons: readonly RankedEntry[],
  shows: readonly RankedEntry[],
): ShowProjection[] {
  const seasonSizes = bandSizes(seasons);
  const showSizes = bandSizes(shows);

  const bySeries = new Map<string, RankedEntry[]>();
  for (const season of seasons) {
    const key = season.seriesId ?? season.mediaItemId;
    const list = bySeries.get(key);
    if (list) list.push(season);
    else bySeries.set(key, [season]);
  }
  const showById = new Map(shows.map((show) => [show.mediaItemId, show]));
  const keys = new Set<string>([...showById.keys(), ...bySeries.keys()]);

  const out: ShowProjection[] = [];
  for (const seriesId of keys) {
    const show = showById.get(seriesId) ?? null;
    const own = [...(bySeries.get(seriesId) ?? [])].sort(bySeason);

    let sumTenths: number;
    let n: number;
    let source: ShowScoreSource;
    let contributors: RankedEntry[];
    let tiePosition: number;
    if (show) {
      source = 'explicit';
      sumTenths = tenths(scoreFor(show.bucket, show.position, showSizes));
      n = 1;
      contributors = [show];
      tiePosition = show.position;
    } else {
      source = 'average';
      sumTenths = 0;
      tiePosition = Number.MAX_SAFE_INTEGER;
      for (const season of own) {
        sumTenths += tenths(scoreFor(season.bucket, season.position, seasonSizes));
        if (season.position < tiePosition) tiePosition = season.position;
      }
      n = own.length;
      contributors = own;
    }

    const first = own[0] ?? null;
    const facts = show ?? first!;
    out.push({
      seriesId,
      source,
      sumTenths,
      n,
      score: sumTenths / (10 * n),
      display: displayTenths(sumTenths, n),
      rankedSeasonCount: own.length,
      contributors: contributors.map((entry) => entry.mediaItemId),
      rankedAt: contributors.reduce<string | null>((at, entry) => later(at, entry.rankedAt), null),
      tiePosition,
      bucket: show ? show.bucket : null,
      title: show?.title ?? first?.seriesTitle ?? first?.title ?? '',
      // The series' own artwork first (embedded on each ranked season by
      // `readRankedCollection`), then the ranked show's row, then the first ranked
      // season's poster.
      posterPath:
        first?.seriesPosterPath ?? show?.posterPath ?? first?.posterPath ?? null,
      year: first?.seriesYear ?? show?.year ?? first?.year ?? null,
      genres: facts.genres,
      language: facts.language,
      show,
      seasons: own,
    });
  }

  return out.sort(compareShowProjections);
}

/** The projection for one series, or null when the user has ranked none of it. */
export function projectShow(
  seriesId: string,
  seasons: readonly RankedEntry[],
  shows: readonly RankedEntry[],
): ShowProjection | null {
  // Band sizes are over the whole pools, so this runs the whole projection rather than
  // a slice of it; it is linear and the pools are already in hand.
  return projectShows(seasons, shows).find((entry) => entry.seriesId === seriesId) ?? null;
}

/** "Average of 3 ranked seasons" / "Average of 1 ranked season". */
export const averageCaption = (count: number) =>
  `Average of ${count} ranked ${count === 1 ? 'season' : 'seasons'}`;
