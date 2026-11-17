import {
  bandSizes,
  bucketForScore,
  projectedScore,
  type Bucket,
} from '@/features/collection/score';
import {
  SLATE_SIZE,
  scoreSlate,
  type Candidate,
  type Scored,
} from '@/features/recommendations/rank';
import type { Medium } from '@/features/recommendations/use-for-you';

import {
  validateExport,
  type ReplayExport,
  type ReplayMedia,
  type ReplayRanking,
} from '../rec-v2-replay/format';
import {
  EXTENDED,
  LAUNCH_SEEDS,
  TRENDING,
  candidateOf,
  entropy,
  hybridCoverage,
  metOf,
  renumber,
  wall,
  worldOf,
  type Account,
  type Engine as ReplayEngine,
  type World,
} from '../rec-v2-replay/replay';

/**
 * # The recommendation quality benchmark (final engineering closeout, 2026-11-17)
 *
 * The question: **does an engine understand what a person likes?** The answer is not "look at
 * the posters". It is to hide some of a person's real rankings, recommend from the rest, and
 * check the hidden ones.
 *
 * This extends `eval/rec-v2-replay` rather than replacing it. The world, the server-source
 * mirrors (TMDB similar lists, trending, followees' Liked titles, the catalogue windows) and
 * the For You wall itself (`wall()`, the shipped anchor, taste, profile, coverage, scoring and
 * draw functions) are the replay's. What is new:
 *
 * - **A series-level TV target** ({@link unitsOf}), and movies and TV evaluated as separate
 *   experiments that never share a ladder.
 * - **Suite A, a stratified ladder holdout** ({@link stratifiedSplit}): about 20% of a
 *   person's titles in one medium, drawn across liked, fine and not-for-me where sizes allow,
 *   over several deterministic splits. This is the primary taste evaluation.
 * - **Suite B, a historical forward replay** ({@link forwardSplit}): train on what was ranked up
 *   to a cutoff, test on what came after, with other people's rankings frozen at the same day.
 *   It is **partially historical**: the catalogue, TMDB lists and trending are today's, not the
 *   cutoff day's.
 * - **Mode 1, common candidates** ({@link modeOne}): every engine scores exactly the held-out
 *   titles. That measures taste modelling, separate from retrieval. It is a diagnostic and is
 *   never the quality of the product's wall.
 * - **Mode 2, the full For You replay** ({@link modeTwo}): the normal sources, exclusions,
 *   scoring, diversity and draw. Did the liked held-out titles get retrieved and surfaced?
 * - **Leakage invariants** that run on every split ({@link assertNoLeak}), and a popularity
 *   baseline.
 * - **User-level statistics:** bootstrap intervals over people, not over title pairs, and paired
 *   per-person differences against V1.
 * - **A pre-registered verdict** ({@link verdictFor}), decided on a final half of the people
 *   that no tuning ever sees.
 *
 * Nothing here writes to anything. It reads an export (or a synthetic one) and prints
 * aggregates.
 */

// ---------------------------------------------------------------------------
// Configuration, pre-registered
// ---------------------------------------------------------------------------

export const HOLDOUT_SHARE = 0.2;
/** Suite A split seeds. Every engine sees exactly these splits. */
export const SPLIT_SEEDS = [101, 202, 303, 404, 505] as const;
/** Suite B: the share of a person's rankings (in time order) that are training. */
export const FORWARD_TRAIN_SHARE = 0.8;
/** At least this many units of a medium to be evaluated in it at all. */
export const MIN_UNITS = 5;
/** Fewer people than this in the final half of a medium: the verdict is INSUFFICIENT_EVIDENCE. */
export const MIN_FINAL_USERS = 15;
/** Within one bucket, a pair counts as ordered only if the true scores are this far apart (0–10). */
export const WITHIN_BAND_GAP = 1;
/** The non-inferiority margin a winner may lose on its other primary metric. */
export const NON_INFERIORITY = 0.02;
export const BOOTSTRAP_RESAMPLES = 2000;
export const BOOTSTRAP_SEED = 20261117;

/** A positive is a held-out *I liked it*. A missing ranking is never a negative. */
const POSITIVE: Bucket = 'loved';

/**
 * The engines benchmarked.
 *
 * - `popularity`: a baseline. Mode 1 scores by TMDB popularity; Mode 2 lists the trending
 *   and catalogue tiles by popularity.
 * - `v1`: the production default.
 * - `v2_metadata`: as shipped, dark.
 * - `v2_metadata_social`: the allowlist-only prototype (V2 metadata plus the follow graph on
 *   the Films wall).
 * - `v2_hybrid`: **not measurable** at today's size. It is reported as coverage, never as a
 *   score (`hybridCoverage`).
 */
export type BenchEngine = 'popularity' | 'v1' | 'v2_metadata' | 'v2_metadata_social';
export const BENCH_ENGINES: BenchEngine[] = [
  'popularity',
  'v1',
  'v2_metadata',
  'v2_metadata_social',
];
/** The configurations a verdict may pick. The baseline can win only as "other tested engine". */
const CANDIDATES: BenchEngine[] = ['v2_metadata', 'v2_metadata_social', 'popularity'];

// ---------------------------------------------------------------------------
// Ground truth: one unit per film, one unit per series
// ---------------------------------------------------------------------------

/**
 * One judgement the benchmark can hide and check.
 *
 * `score` is the unrounded 0–10 projection of the ladder position (`projectedScore`). Within one
 * ladder it orders titles exactly as the ordinal position does, so no displayed rounding enters
 * the ground truth.
 */
export type Unit = {
  /** The id a wall would show: the film, or the series. */
  id: string;
  medium: Medium;
  bucket: Bucket;
  score: number;
  /** TV: `show` is an explicit whole-show ranking; `seasons` is derived from ranked seasons. */
  source: 'film' | 'show' | 'seasons';
  /** TV derived from seasons: how many seasons it was averaged over. 1 for an explicit judgement. */
  coverage: number;
};

/**
 * **The series-level TV target**, evaluation-only. This rule is never written to a real ladder.
 *
 * 1. An explicit whole-show ranking (`tv_shows`) is the series judgement, scored on the whole-show
 *    ladder.
 * 2. Without one, the series is labelled from its ranked seasons. The score is the mean of the
 *    seasons' projected scores on the season ladder. The bucket is the band that mean falls in
 *    (`bucketForScore`), and `coverage` records how many seasons it rests on.
 * 3. When both exist, the explicit show judgement is the target. The seasons stay part of the
 *    same unit, so they are hidden along with it.
 * 4. Five seasons of one show are one unit: they can never count as five successes.
 */
export function unitsOf(
  rows: readonly ReplayRanking[],
  media: ReadonlyMap<string, ReplayMedia>,
): Unit[] {
  const units: Unit[] = [];
  const ladder = (category: ReplayRanking['c']) => {
    const pool = rows.filter((r) => r.c === category).sort((a, b) => a.p - b.p);
    const sizes = bandSizes(pool.map((r) => ({ bucket: r.b })));
    return new Map(pool.map((r) => [r.m, projectedScore(r.b, r.p, sizes)]));
  };
  const films = ladder('movies');
  for (const r of rows) {
    if (r.c !== 'movies') continue;
    units.push({
      id: r.m,
      medium: 'movies',
      bucket: r.b,
      score: films.get(r.m)!,
      source: 'film',
      coverage: 1,
    });
  }
  const shows = ladder('tv_shows');
  const seasons = ladder('tv_seasons');
  const explicit = new Map<string, Unit>();
  for (const r of rows) {
    if (r.c !== 'tv_shows') continue;
    explicit.set(r.m, {
      id: r.m,
      medium: 'tv',
      bucket: r.b,
      score: shows.get(r.m)!,
      source: 'show',
      coverage: 1,
    });
  }
  const bySeries = new Map<string, number[]>();
  for (const r of rows) {
    if (r.c !== 'tv_seasons') continue;
    const series = media.get(r.m)?.parent;
    if (!series) continue;
    bySeries.set(series, [...(bySeries.get(series) ?? []), seasons.get(r.m)!]);
  }
  for (const [series, unit] of explicit)
    units.push({ ...unit, coverage: Math.max(1, bySeries.get(series)?.length ?? 1) });
  for (const [series, scores] of bySeries) {
    if (explicit.has(series)) continue;
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    units.push({
      id: series,
      medium: 'tv',
      bucket: bucketForScore(mean),
      score: mean,
      source: 'seasons',
      coverage: scores.length,
    });
  }
  return units;
}

/** Every ranking and logged id that would reveal a unit: the film, or the series and all its seasons. */
function revealsUnit(
  id: string,
  unitId: string,
  media: ReadonlyMap<string, ReplayMedia>,
): boolean {
  if (id === unitId) return true;
  const m = media.get(id);
  return m?.kind === 'season' && m.parent === unitId;
}

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** FNV-1a, for a stable per-(seed, user, unit) draw. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: a seeded generator for the bootstrap. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Splits
// ---------------------------------------------------------------------------

/** A train/test split of one person in one medium. */
export type Split = {
  key: number;
  medium: Medium;
  /** The person as the engines see them: visible rankings renumbered, logged titles. */
  train: Account;
  test: Unit[];
  /** Suite B: other people's rankings are cut at this day. Null in Suite A. */
  cutoffDay: number | null;
};

function trainingAccount(
  key: number,
  rows: readonly ReplayRanking[],
  logged: Account['logged'],
  test: readonly Unit[],
  media: ReadonlyMap<string, ReplayMedia>,
): Account {
  const hides = (id: string) => test.some((u) => revealsUnit(id, u.id, media));
  const visible = renumber(rows.filter((r) => !hides(r.m)));
  const loggedVisible = logged.filter((l) => !hides(l.m));
  // `held` is the replay's field, the positives by wall. It drives nothing in `wall()`.
  const held = { movies: new Set<string>(), tv: new Set<string>() };
  for (const u of test) if (u.bucket === POSITIVE) held[u.medium].add(u.id);
  return { key, visible, logged: loggedVisible, held };
}

/**
 * **Suite A.** About 20% of a person's units in one medium are hidden, stratified by bucket:
 * each bucket gives up its share by the largest-remainder rule, so liked, fine and not-for-me
 * are all represented where the person has them. Draws are deterministic in (seed, person, unit).
 * At least two units are held, and training keeps at least one liked unit (an anchor needs one).
 * Returns null for a person with fewer than {@link MIN_UNITS} units in the medium.
 */
export function stratifiedSplit(
  key: number,
  rows: readonly ReplayRanking[],
  logged: Account['logged'],
  media: ReadonlyMap<string, ReplayMedia>,
  medium: Medium,
  seed: number,
): Split | null {
  const units = unitsOf(rows, media).filter((u) => u.medium === medium);
  if (units.length < MIN_UNITS) return null;
  const total = Math.max(2, Math.round(units.length * HOLDOUT_SHARE));
  const byBucket = new Map<Bucket, Unit[]>();
  for (const u of units) byBucket.set(u.bucket, [...(byBucket.get(u.bucket) ?? []), u]);
  const quota = new Map<Bucket, number>();
  const remainders: [Bucket, number][] = [];
  let given = 0;
  for (const [bucket, list] of byBucket) {
    const exact = (list.length / units.length) * total;
    quota.set(bucket, Math.floor(exact));
    given += Math.floor(exact);
    remainders.push([bucket, exact - Math.floor(exact)]);
  }
  remainders.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [bucket] of remainders) {
    if (given >= total) break;
    quota.set(bucket, quota.get(bucket)! + 1);
    given += 1;
  }
  const test: Unit[] = [];
  for (const [bucket, list] of byBucket) {
    let take = quota.get(bucket)!;
    // Keep one liked unit in training: with none, no engine has an anchor to stand on.
    if (bucket === POSITIVE) take = Math.min(take, list.length - 1);
    const order = [...list].sort(
      (a, b) =>
        hash(`${seed}|${key}|${a.id}`) - hash(`${seed}|${key}|${b.id}`) ||
        (a.id < b.id ? -1 : 1),
    );
    test.push(...order.slice(0, Math.max(0, take)));
  }
  if (test.length < 2) return null;
  return {
    key,
    medium,
    train: trainingAccount(key, rows, logged, test, media),
    test,
    cutoffDay: null,
  };
}

/**
 * **Suite B.** Training is the person's first {@link FORWARD_TRAIN_SHARE} of rankings in time
 * order (day, then the account's own order). The test is every unit of the medium first ranked
 * after that point. A series with any ranking before the cutoff is not a test unit, because its
 * show or seasons are already in training. The label is the person's final judgement, on today's
 * ladder.
 *
 * **Partially historical.** Other people's rankings are cut at the cutoff day
 * ({@link frozenWorld}), but the catalogue, TMDB lists and trending are today's. Logged titles
 * carry no date in the export, so only the test units' own logged rows are removed.
 *
 * **The ranking day is when a title was ranked, not when it was watched.** Backlog ranking is
 * common in bingd, so "later" here means ranked later.
 */
export function forwardSplit(
  key: number,
  rows: readonly ReplayRanking[],
  logged: Account['logged'],
  media: ReadonlyMap<string, ReplayMedia>,
  medium: Medium,
): Split | null {
  const ordered = [...rows].sort((a, b) => a.day - b.day || a.seq - b.seq);
  const cut = Math.floor(ordered.length * FORWARD_TRAIN_SHARE);
  if (cut < 1 || cut >= ordered.length) return null;
  const before = ordered.slice(0, cut);
  const cutoffDay = before[before.length - 1]!.day;
  const all = unitsOf(rows, media).filter((u) => u.medium === medium);
  const trainUnits = new Set(
    unitsOf(before, media)
      .filter((u) => u.medium === medium)
      .map((u) => u.id),
  );
  const touchedBefore = (unit: Unit) => before.some((r) => revealsUnit(r.m, unit.id, media));
  const test = all.filter((u) => !trainUnits.has(u.id) && !touchedBefore(u));
  if (trainUnits.size < MIN_UNITS - 1 || test.length === 0) return null;
  // Training is exactly the rankings at or before the cutoff, renumbered.
  const train = trainingAccount(key, before, logged, test, media);
  return { key, medium, train, test, cutoffDay };
}

/** Other people's rankings cut at `day`, for Suite B. The reader's own training rows are unchanged. */
export function frozenWorld(doc: ReplayExport, day: number): World {
  return worldOf({ ...doc, rankings: doc.rankings.filter((r) => r.day <= day) });
}

// ---------------------------------------------------------------------------
// Leakage invariants
// ---------------------------------------------------------------------------

export class LeakError extends Error {}

/**
 * Runs on every split. Throws if:
 *
 * - any held-out film or series is still visible in training: its ranking, a season of it, or
 *   a logged row of either;
 * - a held-out unit is in the "already met" exclusion set, which would make it unrecommendable
 *   for a reason the real reader would not have;
 * - an anchor is a held-out unit.
 *
 * Taste, the V2 profile, anchors and the social mirror's own-exclusions are all computed from
 * `train` alone inside `wall()`. So "not visible in training" is what keeps the answer out of
 * them. The ranking-derived taste-neighbour computation (`hybridCoverage`) also reads `train`
 * only, never the reader's full history.
 */
export function assertNoLeak(split: Split, w: World, anchors: readonly string[] = []) {
  for (const unit of split.test) {
    for (const r of split.train.visible) {
      if (revealsUnit(r.m, unit.id, w.media))
        throw new LeakError(`a held-out ${unit.medium} unit is still ranked in training`);
    }
    for (const l of split.train.logged) {
      if (revealsUnit(l.m, unit.id, w.media))
        throw new LeakError(`a held-out ${unit.medium} unit is still logged in training`);
    }
  }
  const met = metOf(split.train, w);
  for (const unit of split.test) {
    if (met.has(unit.id)) throw new LeakError('a held-out unit is excluded as already met');
  }
  const held = new Set(split.test.map((u) => u.id));
  for (const a of anchors) if (held.has(a)) throw new LeakError('an anchor is a held-out unit');
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const BUCKET_RANK: Record<Bucket, number> = { loved: 2, fine: 1, not_for_me: 0 };

/**
 * Pairwise preference accuracy for one person.
 *
 * - **Cross-band pairs:** held-out units in different buckets. The engine is right if it scores
 *   the better bucket higher.
 * - **Within-band pairs:** the same bucket, true scores at least {@link WITHIN_BAND_GAP} apart.
 * - A tie in the engine's score counts one half.
 *
 * Returned per person, so a heavy ranker's thousands of pairs weigh as one person when averaged.
 */
export function pairwise(test: readonly Unit[], scoreOf: (id: string) => number) {
  let cross = 0;
  let crossRight = 0;
  let within = 0;
  let withinRight = 0;
  for (let i = 0; i < test.length; i += 1) {
    for (let j = i + 1; j < test.length; j += 1) {
      const a = test[i]!;
      const b = test[j]!;
      const sameBand = a.bucket === b.bucket;
      if (sameBand && Math.abs(a.score - b.score) < WITHIN_BAND_GAP) continue;
      const aBetter = sameBand
        ? a.score > b.score
        : BUCKET_RANK[a.bucket] > BUCKET_RANK[b.bucket];
      const sa = scoreOf(a.id);
      const sb = scoreOf(b.id);
      const credit = sa === sb ? 0.5 : sa > sb === aBetter ? 1 : 0;
      if (sameBand) {
        within += 1;
        withinRight += credit;
      } else {
        cross += 1;
        crossRight += credit;
      }
    }
  }
  const all = cross + within;
  return {
    pairs: all,
    accuracy: all ? (crossRight + withinRight) / all : null,
    crossBand: cross ? crossRight / cross : null,
    withinBand: within ? withinRight / within : null,
  };
}

/**
 * NDCG@k with linear gain equal to the true 0–10 score. The ideal is the held-out units sorted by
 * true score.
 *
 * `ranked` holds **judged ids only**. For a wall, unjudged recommendations are removed first (a
 * condensed list): an unrated title is unknown, never a zero-gain dislike.
 */
export function ndcg(
  ranked: readonly string[],
  test: readonly Unit[],
  k = SLATE_SIZE,
): number | null {
  if (test.length === 0) return null;
  const gain = new Map(test.map((u) => [u.id, u.score]));
  const dcg = ranked
    .slice(0, k)
    .reduce((s, id, i) => s + (gain.get(id) ?? 0) / Math.log2(i + 2), 0);
  const ideal = [...test]
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .reduce((s, u, i) => s + u.score / Math.log2(i + 2), 0);
  return ideal > 0 ? dcg / ideal : null;
}

/** Mode 1, one person: every engine scores exactly the held-out units. */
export function modeOne(split: Split, w: World, engine: BenchEngine) {
  const kind = split.medium === 'movies' ? 'movie' : 'series';
  const candidates: Candidate[] = split.test
    .map((u) => w.media.get(u.id))
    .filter((m): m is ReplayMedia => m != null && m.kind === kind)
    .map((m) => candidateOf(m, w));
  let scores: Map<string, number>;
  let anchors: string[] = [];
  if (engine === 'popularity') {
    scores = new Map(candidates.map((c) => [c.mediaItemId, c.popularity ?? 0]));
  } else {
    // The same taste, profile and anchors the wall builds, through the shipped functions:
    // `wall()` is called for its model, and its own pool is ignored here.
    const built = wall(split.train, w, split.medium, engine as ReplayEngine, LAUNCH_SEEDS[0]);
    anchors = built.anchors.map((a) => a.mediaItemId);
    const scored = scoreSlate({
      candidates,
      anchors: built.anchors,
      taste: built.taste,
      exclude: new Set(),
      engine: engine === 'v1' ? 'v1' : 'v2_metadata',
      profile: built.profile,
    });
    scores = new Map(scored.map((s) => [s.mediaItemId, s.explanation.total]));
  }
  // The common candidate set is exactly the held-out units, for every engine.
  if (candidates.length !== split.test.filter((u) => w.media.get(u.id)?.kind === kind).length) {
    throw new LeakError('Mode 1 candidates are not exactly the held-out units');
  }
  assertNoLeak(split, w, anchors);
  const scoreOf = (id: string) => scores.get(id) ?? -1;
  const order = [...split.test]
    .sort((a, b) => scoreOf(b.id) - scoreOf(a.id) || hash(a.id) - hash(b.id))
    .map((u) => u.id);
  return { ...pairwise(split.test, scoreOf), ndcg20: ndcg(order, split.test) };
}

/** The popularity baseline's wall: trending and catalogue tiles of the medium, by popularity. */
function popularityWall(split: Split, w: World): Scored[] {
  const kind = split.medium === 'movies' ? 'movie' : 'series';
  const met = metOf(split.train, w);
  const ids = new Set([
    ...TRENDING[split.medium].flatMap((key) => w.trending.get(key) ?? []),
    ...w.catalogue[kind].map((m) => m.m),
  ]);
  return [...ids]
    .map((id) => w.media.get(id))
    .filter((m): m is ReplayMedia => m != null && m.tile && m.kind === kind && !met.has(m.m))
    .sort((a, b) => (b.popularity ?? -1) - (a.popularity ?? -1) || (a.m < b.m ? -1 : 1))
    .map((m) => ({
      ...candidateOf(m, w),
      explanation: {
        total: m.popularity ?? 0,
        anchors: [],
        genre: null,
        language: null,
        popularity: 0,
        lead: 'popular',
      },
    }));
}

export type WallMetrics = {
  recall20: number | null;
  recall50: number | null;
  poolRecall: number | null;
  ndcg20: number | null;
  dislikesTop20: number | null;
  nonEnglishShare: number;
  ownNonEnglish: number | null;
  languageCoverage: number | null;
  decadeCoverage: number | null;
  genreEntropy: number;
  topGenreShare: number;
  poolSize: number;
  seedOverlap: number;
  ms: number;
  poolViaAnchors: number | null;
  poolViaSocial: number | null;
  poolViaTrending: number | null;
  poolViaCatalogue: number | null;
};

const top = <T>(xs: readonly T[], n: number) => {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([x]) => x);
};

/** Mode 2, one person: the full wall, over the launch seeds. */
export function modeTwo(split: Split, w: World, engine: BenchEngine): WallMetrics {
  const positives = new Set(split.test.filter((u) => u.bucket === POSITIVE).map((u) => u.id));
  const dislikes = new Set(
    split.test.filter((u) => u.bucket === 'not_for_me').map((u) => u.id),
  );
  const judged = new Set(split.test.map((u) => u.id));
  const own = [...split.train.visible.map((r) => r.m), ...split.train.logged.map((l) => l.m)]
    .map((id) => w.media.get(id))
    .filter((m): m is ReplayMedia => m != null);
  const ownLangs = top(
    own.map((m) => m.lang).filter((l): l is string => !!l),
    3,
  );
  const ownDecades = top(
    own
      .map((m) => (m.year == null ? null : Math.floor(m.year / 10) * 10))
      .filter((d): d is number => d != null),
    3,
  );
  const ownNonEnglish = own.length
    ? own.filter((m) => m.lang && m.lang !== 'en').length / own.length
    : null;

  const sums = new Map<keyof WallMetrics, number>();
  const counts = new Map<keyof WallMetrics, number>();
  const add = (k: keyof WallMetrics, v: number | null) => {
    if (v == null || !Number.isFinite(v)) return;
    sums.set(k, (sums.get(k) ?? 0) + v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  const walls: string[][] = [];
  for (const seed of LAUNCH_SEEDS) {
    const started = performance.now();
    let scored: Scored[];
    let extended: Scored[];
    let items: Scored[];
    let via: ((id: string) => string) | null = null;
    let anchors: string[] = [];
    if (engine === 'popularity') {
      scored = popularityWall(split, w);
      extended = scored.slice(0, EXTENDED);
      items = scored.slice(0, SLATE_SIZE);
    } else {
      const built = wall(split.train, w, split.medium, engine as ReplayEngine, seed);
      ({ scored, extended, wall: items, via } = built);
      anchors = built.anchors.map((a) => a.mediaItemId);
    }
    add('ms', performance.now() - started);
    assertNoLeak(split, w, anchors);
    walls.push(items.map((s) => s.mediaItemId));
    const n = Math.max(1, items.length);
    if (positives.size) {
      add(
        'recall20',
        items.filter((s) => positives.has(s.mediaItemId)).length / positives.size,
      );
      add(
        'recall50',
        extended.filter((s) => positives.has(s.mediaItemId)).length / positives.size,
      );
      const pool = new Set(scored.map((s) => s.mediaItemId));
      const found = [...positives].filter((id) => pool.has(id));
      add('poolRecall', found.length / positives.size);
      if (via) {
        for (const source of ['anchors', 'social', 'trending', 'catalogue'] as const) {
          const key =
            `poolVia${source[0]!.toUpperCase()}${source.slice(1)}` as keyof WallMetrics;
          add(key, found.filter((id) => via!(id) === source).length / positives.size);
        }
      }
    }
    add(
      'ndcg20',
      ndcg(
        extended.map((s) => s.mediaItemId).filter((id) => judged.has(id)),
        split.test,
      ),
    );
    if (dislikes.size)
      add(
        'dislikesTop20',
        items.filter((s) => dislikes.has(s.mediaItemId)).length / dislikes.size,
      );
    const langs = items.map((s) => w.media.get(s.mediaItemId)?.lang ?? null);
    add('nonEnglishShare', langs.filter((l) => l && l !== 'en').length / n);
    add('ownNonEnglish', ownNonEnglish);
    if (ownLangs.length)
      add(
        'languageCoverage',
        ownLangs.filter((l) => langs.includes(l)).length / ownLangs.length,
      );
    const decades = items.map((s) => (s.year == null ? null : Math.floor(s.year / 10) * 10));
    if (ownDecades.length)
      add(
        'decadeCoverage',
        ownDecades.filter((d) => decades.includes(d)).length / ownDecades.length,
      );
    add('genreEntropy', entropy(items.map((s) => s.genres ?? [])));
    const genres = items.flatMap((s) => (s.genres ?? []).slice(0, 1));
    add(
      'topGenreShare',
      genres.length
        ? Math.max(...top(genres, 1).map((g) => genres.filter((x) => x === g).length)) /
            genres.length
        : 0,
    );
    add('poolSize', scored.length);
  }
  // Repeated recommendations across launches: mean Jaccard of the first page between seeds.
  let overlap = 0;
  let pairs = 0;
  for (let i = 0; i < walls.length; i += 1) {
    for (let j = i + 1; j < walls.length; j += 1) {
      const a = new Set(walls[i]);
      const b = new Set(walls[j]);
      const inter = [...a].filter((x) => b.has(x)).length;
      const union = new Set([...a, ...b]).size;
      overlap += union ? inter / union : 1;
      pairs += 1;
    }
  }
  add('seedOverlap', pairs ? overlap / pairs : null);
  const out = {} as WallMetrics;
  for (const k of WALL_KEYS) {
    const c = counts.get(k);
    (out as Record<string, number | null>)[k] = c ? sums.get(k)! / c : null;
  }
  return out;
}

export const WALL_KEYS: (keyof WallMetrics)[] = [
  'recall20',
  'recall50',
  'poolRecall',
  'ndcg20',
  'dislikesTop20',
  'nonEnglishShare',
  'ownNonEnglish',
  'languageCoverage',
  'decadeCoverage',
  'genreEntropy',
  'topGenreShare',
  'poolSize',
  'seedOverlap',
  'ms',
  'poolViaAnchors',
  'poolViaSocial',
  'poolViaTrending',
  'poolViaCatalogue',
];
export const MODE_ONE_KEYS = [
  'accuracy',
  'crossBand',
  'withinBand',
  'ndcg20',
  'pairs',
] as const;

// ---------------------------------------------------------------------------
// Statistics over people
// ---------------------------------------------------------------------------

export type Estimate = { mean: number; lo: number; hi: number; n: number };

/** Mean and a 95% percentile bootstrap interval, resampling people. */
export function bootstrap(
  values: readonly (number | null)[],
  seed = BOOTSTRAP_SEED,
): Estimate | null {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x));
  if (!v.length) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  if (v.length === 1) return { mean, lo: mean, hi: mean, n: 1 };
  const draw = rng(seed);
  const means: number[] = [];
  for (let r = 0; r < BOOTSTRAP_RESAMPLES; r += 1) {
    let s = 0;
    for (let i = 0; i < v.length; i += 1) s += v[Math.floor(draw() * v.length)]!;
    means.push(s / v.length);
  }
  means.sort((a, b) => a - b);
  return {
    mean,
    lo: means[Math.floor(0.025 * BOOTSTRAP_RESAMPLES)]!,
    hi: means[Math.ceil(0.975 * BOOTSTRAP_RESAMPLES) - 1]!,
    n: v.length,
  };
}

/** Dev or final, by a hash of the person's key in this export. Tuning may look only at dev. */
export const halfOf = (key: number): 'dev' | 'final' =>
  hash(`half|${key}`) % 2 === 0 ? 'dev' : 'final';

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

type PerPerson = {
  key: number;
  half: 'dev' | 'final';
  segment: string[];
  m1: Partial<Record<BenchEngine, Record<string, number | null>>>;
  m2: Partial<Record<BenchEngine, WallMetrics>>;
};

export type MediumResult = {
  medium: Medium;
  suite: 'A' | 'B';
  people: number;
  lowEvidence: number;
  cases: { held: number; positives: number; neutral: number; negatives: number; pairs: number };
  /** half → segment → engine → metric → estimate */
  table: Record<string, Record<string, Record<string, Record<string, Estimate | null>>>>;
  /** half → segment → engine → metric → paired engine − v1 */
  paired: Record<string, Record<string, Record<string, Record<string, Estimate | null>>>>;
  /** Suite A: per split seed, the all-people mean of the primary metrics, per engine. */
  stability: Record<
    string,
    Record<string, { accuracy: number | null; recall50: number | null }>
  >;
  verdict: Verdict;
};

export type Verdict = {
  call:
    | 'KEEP_V1'
    | 'TRIAL_V2_METADATA'
    | 'TRIAL_V2_SOCIAL'
    | 'TRIAL_OTHER_TESTED_ENGINE'
    | 'INSUFFICIENT_EVIDENCE';
  engine: BenchEngine | null;
  reason: string;
};

const mean = (xs: readonly (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

function segmentsOf(split: Split, w: World): string[] {
  const n = split.train.visible.length;
  const out = ['all', n <= 10 ? 'sparse' : n <= 30 ? 'medium' : 'heavy'];
  const own = [...split.train.visible.map((r) => r.m)]
    .map((id) => w.media.get(id))
    .filter(Boolean) as ReplayMedia[];
  if (own.length && own.filter((m) => m.lang && m.lang !== 'en').length / own.length >= 0.2)
    out.push('non_english_taste');
  if (split.medium === 'tv') {
    const shows = split.train.visible.filter((r) => r.c === 'tv_shows').length;
    const seasons = split.train.visible.filter((r) => r.c === 'tv_seasons').length;
    out.push(shows >= seasons && shows > 0 ? 'whole_show_rankers' : 'season_rankers');
  }
  return out;
}

/**
 * **The pre-registered verdict** for one medium, on the final half only.
 *
 * The primary metrics are Mode 1 pairwise accuracy (taste) and Mode 2 Recall@50 (product).
 * An engine wins if its paired difference from V1 has a 95% interval above zero on one primary
 * metric, and is non-inferior on the other (interval above −{@link NON_INFERIORITY}). Among
 * winners, the largest Recall@50 gain is chosen.
 *
 * - Fewer than {@link MIN_FINAL_USERS} people in the final half: INSUFFICIENT_EVIDENCE.
 * - No winner, and no candidate's interval reaches above +{@link NON_INFERIORITY} on either
 *   primary metric: KEEP_V1. V1 is at least as good, within the margin.
 * - Otherwise: INSUFFICIENT_EVIDENCE. The result is inconclusive, and V1 stays.
 */
export function verdictFor(
  result: Pick<MediumResult, 'paired' | 'table'>,
  people: number,
): Verdict {
  if (people < MIN_FINAL_USERS) {
    return {
      call: 'INSUFFICIENT_EVIDENCE',
      engine: null,
      reason: `${people} people in the final half; at least ${MIN_FINAL_USERS} are needed`,
    };
  }
  const d = result.paired.final?.all ?? {};
  const winners: { engine: BenchEngine; gain: number }[] = [];
  let anyAbove = false;
  // A conclusive call needs both paired primary estimates for every candidate, each from at
  // least MIN_FINAL_USERS people: a person with no held-out like has no recall, and one with no
  // ordered pair has no accuracy, so the nominal cohort can be far larger than the evidence.
  const thin: string[] = [];
  for (const engine of CANDIDATES) {
    const acc = d[engine]?.['m1.accuracy'];
    const rec = d[engine]?.['m2.recall50'];
    if (!acc || !rec || acc.n < MIN_FINAL_USERS || rec.n < MIN_FINAL_USERS) {
      thin.push(`${engine} (accuracy n=${acc?.n ?? 0}, recall n=${rec?.n ?? 0})`);
    }
  }
  if (thin.length) {
    return {
      call: 'INSUFFICIENT_EVIDENCE',
      engine: null,
      reason: `too few people with both primary metrics in the final half: ${thin.join('; ')}; at least ${MIN_FINAL_USERS} each are needed`,
    };
  }
  for (const engine of CANDIDATES) {
    const acc = d[engine]!['m1.accuracy']!;
    const rec = d[engine]!['m2.recall50']!;
    if ((acc.lo > 0 && rec.lo > -NON_INFERIORITY) || (rec.lo > 0 && acc.lo > -NON_INFERIORITY))
      winners.push({ engine, gain: rec.mean });
    if (acc.hi > NON_INFERIORITY || rec.hi > NON_INFERIORITY) anyAbove = true;
  }
  if (winners.length) {
    const best = winners.sort((a, b) => b.gain - a.gain)[0]!.engine;
    const call =
      best === 'v2_metadata'
        ? 'TRIAL_V2_METADATA'
        : best === 'v2_metadata_social'
          ? 'TRIAL_V2_SOCIAL'
          : 'TRIAL_OTHER_TESTED_ENGINE';
    return {
      call,
      engine: best,
      reason: `${best} beats V1 on a primary metric and is non-inferior on the other, final half`,
    };
  }
  if (!anyAbove)
    return {
      call: 'KEEP_V1',
      engine: 'v1',
      reason:
        'no candidate is better than V1 by more than the margin on either primary metric, final half',
    };
  return {
    call: 'INSUFFICIENT_EVIDENCE',
    engine: null,
    reason:
      'inconclusive: some candidate may be better, but no interval excludes zero with non-inferiority, final half',
  };
}

export function benchmark(input: unknown, suite: 'A' | 'B' = 'A'): MediumResult[] {
  const doc = validateExport(input);
  const base = worldOf(doc);
  const rowsBy = new Map<number, ReplayRanking[]>();
  for (const r of doc.rankings) rowsBy.set(r.u, [...(rowsBy.get(r.u) ?? []), r]);
  const loggedBy = new Map<number, Account['logged']>();
  for (const l of doc.logged)
    loggedBy.set(l.u, [...(loggedBy.get(l.u) ?? []), { m: l.m, b: l.b }]);

  const results: MediumResult[] = [];
  for (const medium of ['movies', 'tv'] as Medium[]) {
    const people: PerPerson[] = [];
    let lowEvidence = 0;
    const cases = { held: 0, positives: 0, neutral: 0, negatives: 0, pairs: 0 };
    const stability: MediumResult['stability'] = {};
    for (const [key, rows] of rowsBy) {
      const logged = loggedBy.get(key) ?? [];
      const splits: { split: Split; w: World; seed: string }[] = [];
      if (suite === 'A') {
        for (const seed of SPLIT_SEEDS) {
          const split = stratifiedSplit(key, rows, logged, base.media, medium, seed);
          if (split) splits.push({ split, w: base, seed: String(seed) });
        }
      } else {
        const split = forwardSplit(key, rows, logged, base.media, medium);
        if (split)
          splits.push({ split, w: frozenWorld(doc, split.cutoffDay!), seed: 'forward' });
      }
      if (!splits.length) {
        lowEvidence += 1;
        continue;
      }
      const person: PerPerson = {
        key,
        half: halfOf(key),
        segment: segmentsOf(splits[0]!.split, base),
        m1: {},
        m2: {},
      };
      for (const engine of BENCH_ENGINES) {
        const m1s = splits.map(({ split, w }) => modeOne(split, w, engine));
        const m2s = splits.map(({ split, w }) => modeTwo(split, w, engine));
        person.m1[engine] = Object.fromEntries(
          MODE_ONE_KEYS.map((k) => [k, mean(m1s.map((m) => m[k]))]),
        );
        person.m2[engine] = Object.fromEntries(
          WALL_KEYS.map((k) => [k, mean(m2s.map((m) => m[k]))]),
        ) as WallMetrics;
        splits.forEach(({ seed }, i) => {
          stability[seed] ??= {};
          stability[seed]![engine] ??= { accuracy: 0, recall50: 0 };
          const s = stability[seed]![engine] as {
            accuracy: number | null;
            recall50: number | null;
            na?: number;
            nr?: number;
          };
          if (m1s[i]!.accuracy != null) {
            s.accuracy = (s.accuracy ?? 0) + m1s[i]!.accuracy!;
            s.na = (s.na ?? 0) + 1;
          }
          if (m2s[i]!.recall50 != null) {
            s.recall50 = (s.recall50 ?? 0) + m2s[i]!.recall50!;
            s.nr = (s.nr ?? 0) + 1;
          }
        });
      }
      for (const { split } of splits) {
        cases.held += split.test.length;
        cases.positives += split.test.filter((u) => u.bucket === 'loved').length;
        cases.neutral += split.test.filter((u) => u.bucket === 'fine').length;
        cases.negatives += split.test.filter((u) => u.bucket === 'not_for_me').length;
        cases.pairs += pairwise(split.test, () => 0).pairs;
      }
      people.push(person);
    }
    for (const bySeed of Object.values(stability)) {
      for (const s of Object.values(bySeed) as {
        accuracy: number | null;
        recall50: number | null;
        na?: number;
        nr?: number;
      }[]) {
        s.accuracy = s.na ? s.accuracy! / s.na : null;
        s.recall50 = s.nr ? s.recall50! / s.nr : null;
        delete s.na;
        delete s.nr;
      }
    }

    const metricsOf = (p: PerPerson, engine: BenchEngine): Record<string, number | null> => ({
      ...Object.fromEntries(MODE_ONE_KEYS.map((k) => [`m1.${k}`, p.m1[engine]?.[k] ?? null])),
      ...Object.fromEntries(WALL_KEYS.map((k) => [`m2.${k}`, p.m2[engine]?.[k] ?? null])),
    });
    const table: MediumResult['table'] = {};
    const paired: MediumResult['paired'] = {};
    for (const half of ['all', 'dev', 'final']) {
      const inHalf = people.filter((p) => half === 'all' || p.half === half);
      const segments = [...new Set(inHalf.flatMap((p) => p.segment))];
      table[half] = {};
      paired[half] = {};
      for (const segment of segments) {
        const group = inHalf.filter((p) => p.segment.includes(segment));
        table[half]![segment] = {};
        paired[half]![segment] = {};
        for (const engine of BENCH_ENGINES) {
          const rows = group.map((p) => metricsOf(p, engine));
          const keys = Object.keys(rows[0] ?? {});
          table[half]![segment]![engine] = Object.fromEntries(
            keys.map((k) => [k, bootstrap(rows.map((r) => r[k] ?? null))]),
          );
          if (engine === 'v1') continue;
          const base1 = group.map((p) => metricsOf(p, 'v1'));
          paired[half]![segment]![engine] = Object.fromEntries(
            keys.map((k) => [
              k,
              bootstrap(
                rows.map((r, i) =>
                  r[k] == null || base1[i]![k] == null ? null : r[k]! - base1[i]![k]!,
                ),
              ),
            ]),
          );
        }
      }
    }
    const finalPeople = people.filter((p) => p.half === 'final').length;
    const partial = { table, paired };
    results.push({
      medium,
      suite,
      people: people.length,
      lowEvidence,
      cases,
      table,
      paired,
      stability,
      verdict: verdictFor(partial, finalPeople),
    });
  }
  return results;
}

/**
 * V2 hybrid: how many people could receive any collaborative row at all. A coverage count over
 * full histories; nothing is scored, so nothing held out can be graded with it.
 */
export function hybridReport(input: unknown) {
  const doc = validateExport(input);
  const w = worldOf(doc);
  const accounts: Account[] = [];
  const rowsBy = new Map<number, ReplayRanking[]>();
  for (const r of doc.rankings) rowsBy.set(r.u, [...(rowsBy.get(r.u) ?? []), r]);
  for (const [key, rows] of rowsBy)
    accounts.push({
      key,
      visible: renumber(rows),
      logged: [],
      held: { movies: new Set(), tv: new Set() },
    });
  return hybridCoverage(accounts, w);
}

// ---------------------------------------------------------------------------
// The report: aggregates only, never a person key, title or id
// ---------------------------------------------------------------------------

const f = (e: Estimate | null | undefined, signed = false, digits = 3) =>
  e == null
    ? '—'
    : `${signed && e.mean >= 0 ? '+' : ''}${e.mean.toFixed(digits)} [${e.lo.toFixed(digits)}, ${e.hi.toFixed(digits)}]`;

const PRIMARY: [string, string][] = [
  ['m1.accuracy', 'M1 pairwise'],
  ['m1.crossBand', 'M1 cross-band'],
  ['m1.withinBand', 'M1 within-band'],
  ['m1.ndcg20', 'M1 NDCG@20'],
  ['m2.recall20', 'M2 R@20'],
  ['m2.recall50', 'M2 R@50'],
  ['m2.poolRecall', 'M2 pool recall'],
  ['m2.ndcg20', 'M2 NDCG@20 (judged)'],
];
const SECONDARY: [string, string][] = [
  ['m2.dislikesTop20', 'Held dislikes in top 20'],
  ['m2.nonEnglishShare', 'Non-English share'],
  ['m2.ownNonEnglish', 'Own non-English'],
  ['m2.languageCoverage', 'Own top-3 languages on wall'],
  ['m2.decadeCoverage', 'Own top-3 decades on wall'],
  ['m2.genreEntropy', 'Genre entropy'],
  ['m2.topGenreShare', 'Top-genre share'],
  ['m2.poolSize', 'Pool size'],
  ['m2.seedOverlap', 'Repeat across launches (Jaccard)'],
  ['m2.ms', 'ms per wall'],
];
const SOURCES_COLS: [string, string][] = [
  ['m2.poolRecall', 'Pool recall'],
  ['m2.poolViaAnchors', 'via anchors’ lists'],
  ['m2.poolViaSocial', 'via social'],
  ['m2.poolViaTrending', 'via trending'],
  ['m2.poolViaCatalogue', 'via catalogue fill'],
];

export function renderBenchmark(
  results: readonly MediumResult[],
  hybrid: ReturnType<typeof hybridReport>,
  label: string,
): string {
  const out: string[] = [];
  const line = (s = '') => out.push(s);
  line(`# Recommendation quality benchmark: ${label}`);
  line();
  line(
    'Aggregates only: no person key, title or id. Values are means over people with a 95% bootstrap interval over people, `[lo, hi]`. "engine − v1" rows are paired per person.',
  );
  line();
  line('## Verdicts (final half only, pre-registered rule)');
  line();
  line('| Suite | Medium | Verdict | Reason |');
  line('|---|---|---|---|');
  for (const r of results)
    line(
      `| ${r.suite} | ${r.medium === 'movies' ? 'Movies' : 'TV'} | **${r.verdict.call}** | ${r.verdict.reason} |`,
    );
  line();
  for (const r of results) {
    const name = r.medium === 'movies' ? 'Movies' : 'TV (series units)';
    line(`## Suite ${r.suite}, ${name}`);
    line();
    line(
      `${r.people} people evaluated, ${r.lowEvidence} low-evidence (fewer than ${MIN_UNITS} units, or no usable split). Held-out cases over all splits: ${r.cases.held} (liked ${r.cases.positives}, fine ${r.cases.neutral}, not for me ${r.cases.negatives}); ${r.cases.pairs} ordered pairs. Final half: ${Object.values(r.table.final?.all ?? {})[0]?.['m2.poolSize']?.n ?? 0} people.`,
    );
    line();
    for (const half of ['final', 'dev']) {
      const segs = r.table[half];
      if (!segs?.all) continue;
      line(
        `### ${half === 'final' ? 'Final holdout half' : 'Development half'}: primary metrics`,
      );
      line();
      line(`| Segment | Engine | n | ${PRIMARY.map(([, l]) => l).join(' | ')} |`);
      line(`|---|---|---|${PRIMARY.map(() => '---').join('|')}|`);
      for (const [segment, engines] of Object.entries(segs)) {
        for (const [engine, row] of Object.entries(engines)) {
          line(
            `| ${segment} | ${engine} | ${row['m2.poolSize']?.n ?? 0} | ${PRIMARY.map(([k]) => f(row[k])).join(' | ')} |`,
          );
        }
        for (const [engine, row] of Object.entries(r.paired[half]![segment] ?? {})) {
          line(
            `| ${segment} | ${engine} − v1 | ${row['m2.poolSize']?.n ?? 0} | ${PRIMARY.map(([k]) => f(row[k], true)).join(' | ')} |`,
          );
        }
      }
      line();
    }
    line('### Secondary metrics, all people');
    line();
    line(`| Engine | ${SECONDARY.map(([, l]) => l).join(' | ')} |`);
    line(`|---|${SECONDARY.map(() => '---').join('|')}|`);
    for (const [engine, row] of Object.entries(r.table.all?.all ?? {}))
      line(`| ${engine} | ${SECONDARY.map(([k]) => f(row[k], false, 2)).join(' | ')} |`);
    line();
    line('### Candidate retrieval: where held-out liked titles entered the pool, all people');
    line();
    line(`| Engine | ${SOURCES_COLS.map(([, l]) => l).join(' | ')} |`);
    line(`|---|${SOURCES_COLS.map(() => '---').join('|')}|`);
    for (const [engine, row] of Object.entries(r.table.all?.all ?? {})) {
      if (engine === 'popularity') continue;
      line(`| ${engine} | ${SOURCES_COLS.map(([k]) => f(row[k])).join(' | ')} |`);
    }
    line();
    if (r.suite === 'A') {
      line('### Stability across splits (all people, mean)');
      line();
      line(`| Split seed | ${BENCH_ENGINES.map((e) => `${e} M1 / R@50`).join(' | ')} |`);
      line(`|---|${BENCH_ENGINES.map(() => '---').join('|')}|`);
      for (const [seed, row] of Object.entries(r.stability)) {
        line(
          `| ${seed} | ${BENCH_ENGINES.map((e) => `${row[e]?.accuracy?.toFixed(3) ?? '—'} / ${row[e]?.recall50?.toFixed(3) ?? '—'}`).join(' | ')} |`,
        );
      }
      line();
    }
  }
  line('## V2 hybrid');
  line();
  line(
    `**NOT MEASURABLE.** A collaborative row needs two taste neighbours. ${hybrid.withTwo}/${hybrid.accounts} people have two or more, ${hybrid.withOne}/${hybrid.accounts} have one or more. It is neither better nor worse; it is not tested.`,
  );
  line();
  line('## Limitations printed with every run');
  line();
  for (const l of LIMITATIONS) line(`- ${l}`);
  return out.join('\n');
}

export const LIMITATIONS = [
  'Mode 1 (common candidates) measures taste modelling only; it is not the quality of the product wall.',
  'Suite B is partially historical: other people’s rankings are frozen at the cutoff day, but the catalogue, TMDB similar lists and trending are today’s; logged titles carry no date, so only the test units’ own logged rows are removed.',
  'A ranking day is when a title was ranked, not watched; backlog ranking makes “later” mean “ranked later”.',
  'Server sources are mirrored from the export (`eval/rec-v2-replay`), not called; walls are first launches (no dismissals, exposure memory, filters or TMDB fills).',
  'Recall counts held-out liked titles only. An unranked title is unknown, never a negative; wall NDCG is computed over judged titles only (condensed list).',
  'Franchise duplication is not measurable from the export (no collection data); series cannot duplicate on a wall because the TV wall’s unit is the series.',
  'Intervals resample people, not title pairs. With a cohort of tens of people they are wide: read direction and the paired intervals, not the third decimal.',
  'Dev/final halves are assigned within one export (its person keys are random per run). Tune only on dev; the verdict reads final.',
];
