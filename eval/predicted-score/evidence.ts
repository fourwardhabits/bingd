/**
 * What a task may know about other people and about titles, and nothing more.
 *
 * Three rules hold everywhere in this file, and the leakage tests exist for them:
 *
 *   1. **The reader is never their own evidence.** Their rows are excluded from every
 *      population aggregate. Their held-out or future rows are excluded from their own side
 *      of every comparison, including Taste Match overlap.
 *   2. **Nothing after `asOf` exists** (P1). Another person's ranking, their band sizes, a
 *      follow and a Letterboxd star each count only if they were created strictly before the
 *      moment being replayed.
 *   3. **The populations are the app's own.** Community evidence uses `community_score`'s
 *      population: public, active, not blocked either way. Neighbour evidence uses
 *      `can_view_profile`'s: active and not blocked, and public or approvedly followed. A
 *      prediction built this way discloses nothing a reader could not already select row by
 *      row.
 */

import type { Bucket } from '@/features/collection/score';

import { CONTENT_WEIGHTS, TASTE_MATCH, YEAR_SCALE, type ModelConfig } from './config';
import { libraryView, placeOverall, type LibraryView, type Opinion } from './geometry';
import type { Category, Dataset, SnapshotRanking } from './snapshot';
import type { Task } from './tasks';

export type Population = 'public' | 'viewable';

export type OtherOpinion = Opinion & { v: string };

/** One piece of evidence about where the target would land, in the reader's own terms. */
export type Sample = { bucket: Bucket; q: number; w: number };

/** Caches for one evaluation run. Every key includes everything its value depends on. */
export class EvidenceCache {
  private views = new Map<string, LibraryView>();
  private matches = new Map<string, number | null>();
  private readerScoreCache = new Map<string, Map<string, number>>();
  private sims = new Map<string, number>();

  /** Each list in `created_at` order, so "as of" is a prefix and can share a cache entry. */
  private byTime = new Map<string, { rows: SnapshotRanking[]; times: number[] }>();

  constructor(readonly ds: Dataset) {}

  /**
   * Someone else's list in one category, as it stood before `asOf`.
   *
   * Keyed on *how many* of their rankings predate `asOf`, not on `asOf` itself. The subset is
   * always a prefix of their list in time order, so two moments with the same prefix read the
   * same view. P1 asks at a new moment for every task, and keying on the moment would miss the
   * cache every time.
   */
  viewOf(v: string, c: Category, asOf: number | null): LibraryView {
    const listKey = `${v}|${c}`;
    let timeline = this.byTime.get(listKey);
    if (!timeline) {
      const rows = [...(this.ds.library.get(listKey) ?? [])].sort((a, b) => a.t - b.t);
      timeline = { rows, times: rows.map((r) => r.t) };
      this.byTime.set(listKey, timeline);
    }
    let count = timeline.rows.length;
    if (asOf !== null) {
      let lo = 0;
      let hi = timeline.times.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (timeline.times[mid]! < asOf) lo = mid + 1;
        else hi = mid;
      }
      count = lo;
    }
    const key = `${listKey}|${count}`;
    let view = this.views.get(key);
    if (!view) {
      view = libraryView(timeline.rows.slice(0, count));
      this.views.set(key, view);
    }
    return view;
  }

  /** The reader's own scores as this task may see them: training plus the other category. */
  readerScores(task: Task): Map<string, number> {
    let scores = this.readerScoreCache.get(task.group);
    if (!scores) {
      scores = new Map<string, number>();
      for (const [m, op] of task.train.opinions) scores.set(m, op.score);
      const other = libraryView(task.otherCategory.filter((r) => !task.hidden.has(r.m)));
      for (const [m, op] of other.opinions) scores.set(m, op.score);
      this.readerScoreCache.set(task.group, scores);
    }
    return scores;
  }

  /** Taste Match between the reader (as this task sees them) and `v` (as of `asOf`). */
  tasteMatch(task: Task, v: string): number | null {
    const key = `${task.group}|${v}`;
    if (this.matches.has(key)) return this.matches.get(key)!;
    const mine = this.readerScores(task);
    const theirs = new Map<string, number>();
    for (const c of ['movies', 'tv_seasons'] as const) {
      for (const [m, op] of this.viewOf(v, c, task.asOf).opinions) theirs.set(m, op.score);
    }
    const pairs: [number, number][] = [];
    for (const [m, a] of mine) {
      const b = theirs.get(m);
      if (b !== undefined) pairs.push([a, b]);
    }
    const value = tasteMatchScore(pairs);
    this.matches.set(key, value);
    return value;
  }

  similarity(a: string, b: string): number {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    let value = this.sims.get(key);
    if (value === undefined) {
      value = contentSimilarity(this.ds, a, b);
      this.sims.set(key, value);
    }
    return value;
  }
}

/** Whether `v`'s rankings belong to `population` from the reader `u`'s side, at `asOf`. */
export function admits(
  ds: Dataset,
  population: Population,
  u: string,
  v: string,
  asOf: number | null,
): boolean {
  if (u === v) return false;
  const user = ds.users.get(v);
  if (!user || user.status !== 'active') return false;
  if (ds.blocked.has(`${u}|${v}`)) return false;
  if (user.visibility === 'public') return true;
  if (population === 'public') return false;
  const approvedAt = ds.following.get(u)?.get(v);
  return approvedAt !== undefined && (asOf === null || approvedAt < asOf);
}

/** Every other admissible person's opinion of the target, as it stood at `asOf`. */
export function othersOpinions(
  cache: EvidenceCache,
  task: Task,
  population: Population,
): OtherOpinion[] {
  const out: OtherOpinion[] = [];
  for (const row of cache.ds.raters.get(task.target.m) ?? []) {
    if (row.u === task.u) continue;
    if (row.c !== task.c) continue;
    if (task.asOf !== null && !(row.t < task.asOf)) continue;
    if (!admits(cache.ds, population, task.u, row.u, task.asOf)) continue;
    const op = cache.viewOf(row.u, task.c, task.asOf).opinions.get(row.m);
    if (op) out.push({ ...op, v: row.u });
  }
  return out;
}

/** Another person's opinion, carried into the reader's list under `transfer`. */
export function transferOpinion(
  op: Opinion,
  train: LibraryView,
  transfer: ModelConfig['transfer'],
): Sample {
  if (transfer === 'quantile') {
    const placed = placeOverall(op.overall, train.sizes);
    if (placed) return { ...placed, w: 1 };
  }
  return { bucket: op.bucket, q: op.q, w: 1 };
}

/**
 * `taste_match` (20260827001000), statement for statement.
 *
 * Proximity from the mean gap between the two scores, a Spearman term over midranks that
 * contributes nothing below eight shared titles and a quarter from twenty, and the whole thing
 * shrunk toward the stranger baseline by n / (n + prior). Null below the minimum overlap.
 */
export function tasteMatchScore(pairs: readonly (readonly [number, number])[]): number | null {
  const n = pairs.length;
  if (n < TASTE_MATCH.minCommon) return null;
  const meanGap = pairs.reduce((s, [a, b]) => s + Math.abs(a - b), 0) / n;
  const proximity = Math.max(0, Math.min(100, 100 * (1 - meanGap / 7)));
  const rho = pearson(midranks(pairs.map((p) => p[0])), midranks(pairs.map((p) => p[1])));
  const agreement = rho === null ? null : 50 * (rho + 1);
  const w = 0.25 * Math.max(0, Math.min(1, (n - 8) / 12));
  const blend = agreement === null ? proximity : (1 - w) * proximity + w * agreement;
  return Math.round(50 + (blend - 50) * (n / (n + TASTE_MATCH.shrinkPrior)));
}

/** SQL's `rank() over (order by x) + (count(*) over (partition by x) - 1) / 2.0`. */
export function midranks(values: readonly number[]): number[] {
  return values.map((x) => {
    let smaller = 0;
    let ties = 0;
    for (const y of values) {
      if (y < x) smaller += 1;
      else if (y === x) ties += 1;
    }
    return smaller + 1 + (ties - 1) / 2;
  });
}

/** Postgres `corr()`: null when either side has no variance. */
export function pearson(a: readonly number[], b: readonly number[]): number | null {
  const n = a.length;
  if (n < 2) return null;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  if (saa === 0 || sbb === 0) return null;
  return sab / Math.sqrt(saa * sbb);
}

/** The Taste-Match-weighted neighbours who ranked the target. A match at or below 50 weighs nothing. */
export function neighbourSamples(
  cache: EvidenceCache,
  task: Task,
  config: ModelConfig,
): Sample[] {
  const samples: Sample[] = [];
  for (const op of othersOpinions(cache, task, 'viewable')) {
    const match = cache.tasteMatch(task, op.v);
    if (match === null) continue;
    const w = Math.max(0, (match - TASTE_MATCH.stranger) / (100 - TASTE_MATCH.stranger));
    if (w <= 0) continue;
    samples.push({ ...transferOpinion(op, task.train, config.transfer), w });
  }
  return samples;
}

export function communitySamples(
  cache: EvidenceCache,
  task: Task,
  config: ModelConfig,
): Sample[] {
  return othersOpinions(cache, task, 'public').map((op) =>
    transferOpinion(op, task.train, config.transfer),
  );
}

// ---------------------------------------------------------------------------
// Content similarity (M3)
// ---------------------------------------------------------------------------

const keysOf = (ds: Dataset, m: string): string[] => {
  const parent = ds.media.get(m)?.parent;
  return parent ? [m, parent] : [m];
};

/** Whether TMDB's association list of either title (or its series) names the other. */
function similarLink(ds: Dataset, a: string, b: string): boolean {
  const ka = keysOf(ds, a);
  const kb = keysOf(ds, b);
  for (const x of ka) {
    const list = ds.similar.get(x);
    if (list && kb.some((y) => list.has(y))) return true;
  }
  for (const y of kb) {
    const list = ds.similar.get(y);
    if (list && ka.some((x) => list.has(x))) return true;
  }
  return false;
}

/** Title-to-title similarity on 0–1, from catalogue facts only. */
export function contentSimilarity(ds: Dataset, a: string, b: string): number {
  if (a === b) return 1;
  const ma = ds.media.get(a);
  const mb = ds.media.get(b);
  if (!ma || !mb) return 0;
  const ga = new Set(ma.genres);
  const gb = new Set(mb.genres);
  const union = new Set([...ga, ...gb]).size;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared += 1;
  const genres = union === 0 ? 0 : shared / union;
  const language = ma.lang !== null && ma.lang === mb.lang ? 1 : 0;
  const year =
    ma.year !== null && mb.year !== null
      ? Math.exp(-Math.abs(ma.year - mb.year) / YEAR_SCALE)
      : 0;
  const link = similarLink(ds, a, b) ? 1 : 0;
  const sibling = ma.parent !== null && ma.parent === mb.parent ? 1 : 0;
  return (
    CONTENT_WEIGHTS.genres * genres +
    CONTENT_WEIGHTS.language * language +
    CONTENT_WEIGHTS.year * year +
    CONTENT_WEIGHTS.similarLink * link +
    CONTENT_WEIGHTS.sibling * sibling
  );
}

/**
 * Where a Letterboxd star would sit inside a bucket, **for this offline evaluation only**.
 *
 * The product never converts a star into a bingd bucket (founder, 2026-09-21; the importer's
 * mapping was removed and the server refuses one, 20261018000100). This harness keeps its
 * own copy of the old thresholds to measure what a star *could* predict, and writes nothing.
 */
const evaluationBucketFor = (rating: number): Bucket =>
  rating >= 3.5 ? 'loved' : rating >= 2.5 ? 'fine' : 'not_for_me';

export function starOpinion(rating: number): { bucket: Bucket; q: number } {
  const bucket = evaluationBucketFor(rating);
  const [top, bottom] = bucket === 'loved' ? [5, 3.5] : bucket === 'fine' ? [3, 2.5] : [2, 0.5];
  return { bucket, q: Math.min(1, Math.max(0, (top - rating) / (top - bottom))) };
}

/**
 * The reader's own titles most like the target, as evidence.
 *
 * Their rankings in the training view, and optionally their own Letterboxd stars on titles
 * they have not ranked. A star is only ever this reader's, is never the target's own, never
 * belongs to a hidden title, and in P1 must predate the moment being replayed.
 */
export function contentSamples(
  cache: EvidenceCache,
  task: Task,
  config: ModelConfig,
): { samples: Sample[]; neighbours: number } {
  type Candidate = { key: string; sim: number; bucket: Bucket; q: number; w: number };
  const candidates: Candidate[] = [];
  for (const row of task.train.rows) {
    const sim = cache.similarity(task.target.m, row.m);
    if (sim < config.contentTau) continue;
    const op = task.train.opinions.get(row.m)!;
    candidates.push({ key: row.m, sim, bucket: op.bucket, q: op.q, w: sim });
  }
  if (task.c === 'movies' && config.ownStarWeight > 0) {
    for (const star of cache.ds.stars.get(task.u) ?? []) {
      if (
        star.m === task.target.m ||
        task.hidden.has(star.m) ||
        task.train.opinions.has(star.m)
      )
        continue;
      if (task.asOf !== null && !(star.t < task.asOf)) continue;
      if (cache.ds.media.get(star.m)?.kind !== 'movie') continue;
      const sim = cache.similarity(task.target.m, star.m);
      if (sim < config.contentTau) continue;
      candidates.push({
        key: star.m,
        sim,
        ...starOpinion(star.rating),
        w: sim * config.ownStarWeight,
      });
    }
  }
  candidates.sort((x, y) => y.sim - x.sim || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const chosen = candidates.slice(0, config.contentK);
  return {
    samples: chosen.map(({ bucket, q, w }) => ({ bucket, q, w })),
    neighbours: chosen.length,
  };
}

/** Public raters of the target at `asOf`, the community support segment. */
export const communitySupport = (cache: EvidenceCache, task: Task): number =>
  othersOpinions(cache, task, 'public').length;
