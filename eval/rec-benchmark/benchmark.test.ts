import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_WORLD, generateWorld } from '@/features/recommendations/evaluation/world';

import type { ReplayExport, ReplayMedia, ReplayRanking } from '../rec-v2-replay/format';
import { syntheticExport } from '../rec-v2-replay/synthetic';
import { worldOf } from '../rec-v2-replay/replay';
import {
  BENCH_ENGINES,
  LeakError,
  MIN_FINAL_USERS,
  assertNoLeak,
  benchmark,
  bootstrap,
  forwardSplit,
  frozenWorld,
  hybridReport,
  modeOne,
  modeTwo,
  ndcg,
  pairwise,
  renderBenchmark,
  stratifiedSplit,
  unitsOf,
  verdictFor,
  type Unit,
} from './benchmark';

/**
 * The recommendation quality benchmark (`benchmark.ts`).
 *
 * Always: the ground-truth rules, the splits, the leakage invariants (and that a deliberately
 * leaky split is caught), the metrics, the statistics, the verdict rule, and an end-to-end run
 * on a small synthetic export whose report carries no key or id.
 *
 * Only through `run.mjs` (`REC_BENCHMARK=1`): a full run on a real export or the full synthetic.
 */

// ---------------------------------------------------------------------------
// A hand-built export, small enough to reason about
// ---------------------------------------------------------------------------

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const film = (n: number, lang = 'en', year = 2010): ReplayMedia => ({
  m: id(n),
  tmdb: n,
  kind: 'movie',
  parent: null,
  season: null,
  genres: ['Drama'],
  lang,
  year,
  popularity: 1000 - n,
  tile: true,
});
const series = (n: number): ReplayMedia => ({
  m: id(n),
  tmdb: n,
  kind: 'series',
  parent: null,
  season: null,
  genres: ['Drama'],
  lang: 'en',
  year: 2015,
  popularity: 1000 - n,
  tile: true,
});
const season = (n: number, parent: number, s: number): ReplayMedia => ({
  m: id(n),
  tmdb: n,
  kind: 'season',
  parent: id(parent),
  season: s,
  genres: [],
  lang: 'en',
  year: 2015 + s,
  popularity: null,
  tile: false,
});

function handExport(): ReplayExport {
  const media: ReplayMedia[] = [];
  for (let i = 1; i <= 30; i += 1) media.push(film(i));
  media.push(series(100), season(101, 100, 1), season(102, 100, 2), season(103, 100, 3));
  media.push(series(200), season(201, 200, 1), season(202, 200, 2));
  media.push(series(300), series(400), series(500), series(600));
  const rankings: ReplayRanking[] = [];
  let seq = 0;
  const rank = (
    u: number,
    m: number,
    c: ReplayRanking['c'],
    b: ReplayRanking['b'],
    p: number,
    day: number,
  ) => rankings.push({ u, m: id(m), c, b, p, day, seq: (seq += 1) });
  // Person 1: twelve films across all three buckets, and TV three ways.
  const buckets: ReplayRanking['b'][] = [
    'loved',
    'loved',
    'loved',
    'loved',
    'loved',
    'fine',
    'fine',
    'fine',
    'fine',
    'not_for_me',
    'not_for_me',
    'not_for_me',
  ];
  buckets.forEach((b, i) => rank(1, i + 1, 'movies', b, i + 1, 100 + i));
  rank(1, 100, 'tv_shows', 'loved', 1, 120); // explicit show, with seasons too
  rank(1, 101, 'tv_seasons', 'fine', 1, 121);
  rank(1, 102, 'tv_seasons', 'fine', 2, 122);
  rank(1, 201, 'tv_seasons', 'loved', 3, 123); // series 200 from its seasons only
  rank(1, 202, 'tv_seasons', 'not_for_me', 4, 124);
  rank(1, 300, 'tv_shows', 'fine', 2, 125);
  rank(1, 400, 'tv_shows', 'not_for_me', 3, 126);
  rank(1, 500, 'tv_shows', 'loved', 4, 127);
  // Person 2: loves films 20–24, follows nobody.
  for (let i = 0; i < 6; i += 1)
    rank(2, 20 + i, 'movies', i < 4 ? 'loved' : 'fine', i + 1, 90 + i);
  return {
    format: 'bingd-rec-v2-replay-export',
    version: 1,
    exported_day: 400,
    users: [
      { u: 1, visibility: 'public' },
      { u: 2, visibility: 'public' },
    ],
    rankings,
    logged: [
      { u: 1, m: id(3), b: 'loved' },
      { u: 1, m: id(102), b: null },
    ],
    follows: [{ follower: 1, followee: 2 }],
    media,
    similar: [
      { m: id(1), ids: [id(13), id(14), id(5)] },
      { m: id(2), ids: [id(4), id(15)] },
    ],
    trending: [
      { list: 'trending.movie.week', ids: [id(16), id(17), id(4)] },
      { list: 'trending.series.week', ids: [id(600), id(500)] },
    ],
  };
}

const doc = handExport();
const w = worldOf(doc);
const rowsOf = (u: number) => doc.rankings.filter((r) => r.u === u);
const loggedOf = (u: number) =>
  doc.logged.filter((l) => l.u === u).map((l) => ({ m: l.m, b: l.b }));

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

describe('ground truth: units', () => {
  const units = unitsOf(rowsOf(1), w.media);
  const tv = units.filter((u) => u.medium === 'tv');

  it('gives one unit per film and one per series, never one per season', () => {
    expect(units.filter((u) => u.medium === 'movies')).toHaveLength(12);
    expect(tv.map((u) => u.id).sort()).toEqual(
      [id(100), id(200), id(300), id(400), id(500)].sort(),
    );
  });

  it('takes an explicit whole-show ranking over its seasons', () => {
    const show = tv.find((u) => u.id === id(100))!;
    expect(show).toMatchObject({ source: 'show', bucket: 'loved', coverage: 2 });
  });

  it('derives a show from its seasons only when it has no whole-show ranking', () => {
    const derived = tv.find((u) => u.id === id(200))!;
    expect(derived.source).toBe('seasons');
    expect(derived.coverage).toBe(2);
    // The mean of a liked and a not-for-me season falls in the fine band.
    expect(derived.bucket).toBe('fine');
  });

  it('orders a ladder exactly as its positions do, unrounded', () => {
    const films = units.filter((u) => u.medium === 'movies');
    const loved = films.filter((u) => u.bucket === 'loved').map((u) => u.score);
    expect([...loved].sort((a, b) => b - a)).toEqual(loved);
    expect(new Set(loved).size).toBe(loved.length);
  });
});

// ---------------------------------------------------------------------------
// Splits and leakage
// ---------------------------------------------------------------------------

describe('Suite A: stratified holdout', () => {
  it('holds out about a fifth, across buckets, deterministically, and keeps a liked unit to train on', () => {
    const a = stratifiedSplit(1, rowsOf(1), loggedOf(1), w.media, 'movies', 101)!;
    const b = stratifiedSplit(1, rowsOf(1), loggedOf(1), w.media, 'movies', 101)!;
    expect(a.test.map((u) => u.id)).toEqual(b.test.map((u) => u.id));
    expect(a.test.length).toBeGreaterThanOrEqual(2);
    expect(new Set(a.test.map((u) => u.bucket)).size).toBeGreaterThanOrEqual(2);
    expect(a.train.visible.some((r) => r.c === 'movies' && r.b === 'loved')).toBe(true);
    const c = stratifiedSplit(1, rowsOf(1), loggedOf(1), w.media, 'movies', 202)!;
    expect(c.test.map((u) => u.id)).not.toEqual(a.test.map((u) => u.id));
  });

  it('renumbers the remaining ladders 1..n and never touches the other medium', () => {
    const s = stratifiedSplit(1, rowsOf(1), loggedOf(1), w.media, 'movies', 101)!;
    const films = s.train.visible
      .filter((r) => r.c === 'movies')
      .map((r) => r.p)
      .sort((x, y) => x - y);
    expect(films).toEqual(films.map((_, i) => i + 1));
    expect(s.train.visible.filter((r) => r.c !== 'movies')).toHaveLength(
      rowsOf(1).filter((r) => r.c !== 'movies').length,
    );
  });

  it('hides a held-out series whole: its show ranking, every season, and logged rows of either', () => {
    for (const seed of [101, 202, 303, 404, 505]) {
      const s = stratifiedSplit(1, rowsOf(1), loggedOf(1), w.media, 'tv', seed);
      if (!s) continue;
      expect(() => assertNoLeak(s, w)).not.toThrow();
      for (const unit of s.test) {
        for (const r of s.train.visible)
          expect(r.m === unit.id || w.media.get(r.m)?.parent === unit.id).toBe(false);
      }
    }
  });

  it('skips a person with too little to split, rather than inventing a pairwise test', () => {
    expect(stratifiedSplit(2, rowsOf(2).slice(0, 3), [], w.media, 'movies', 101)).toBeNull();
  });
});

describe('leakage invariants catch a deliberately leaky split', () => {
  const s = stratifiedSplit(1, rowsOf(1), loggedOf(1), w.media, 'tv', 101)!;
  const heldShow = s.test[0]!;

  it('a held-out season left in training', () => {
    const seasonRow: ReplayRanking = {
      u: 1,
      m: id(999),
      c: 'tv_seasons',
      b: 'loved',
      p: 99,
      day: 1,
      seq: 999,
    };
    const leakyWorld = worldOf({
      ...doc,
      media: [...doc.media, { ...season(999, 0, 9), parent: heldShow.id }],
    });
    const leaky = { ...s, train: { ...s.train, visible: [...s.train.visible, seasonRow] } };
    expect(() => assertNoLeak(leaky, leakyWorld)).toThrow(LeakError);
  });

  it('a held-out title still logged', () => {
    const leaky = {
      ...s,
      train: { ...s.train, logged: [...s.train.logged, { m: heldShow.id, b: null }] },
    };
    expect(() => assertNoLeak(leaky, w)).toThrow(LeakError);
  });

  it('an anchor that is a held-out title', () => {
    expect(() => assertNoLeak(s, w, [heldShow.id])).toThrow(LeakError);
  });

  it('and every engine refuses to score a leaky split, in both modes', () => {
    const leaky = {
      ...s,
      train: { ...s.train, logged: [...s.train.logged, { m: heldShow.id, b: null }] },
    };
    for (const engine of BENCH_ENGINES) {
      expect(() => modeOne(leaky, w, engine)).toThrow(LeakError);
      expect(() => modeTwo(leaky, w, engine)).toThrow(LeakError);
    }
  });

  it('an engine with the answer key would score perfectly, which is exactly what the invariants exist to rule out', () => {
    const m = stratifiedSplit(1, rowsOf(1), loggedOf(1), w.media, 'movies', 101)!;
    const truth = new Map(m.test.map((u) => [u.id, u.score]));
    expect(pairwise(m.test, (x) => truth.get(x)!).accuracy).toBe(1);
  });
});

describe('Suite B: forward replay', () => {
  it('trains only on what was ranked by the cutoff, and tests only on units first ranked after it', () => {
    // TV ranked early, films throughout: the last fifth of this person's rankings are films.
    const rows = rowsOf(1).map((r) =>
      r.c === 'movies' ? r : { ...r, day: 90 + (r.seq % 10) },
    );
    const s = forwardSplit(1, rows, loggedOf(1), w.media, 'movies')!;
    expect(s).not.toBeNull();
    expect(s.test.length).toBeGreaterThan(0);
    for (const r of s.train.visible) {
      const original = rows.find((o) => o.m === r.m)!;
      expect(original.day).toBeLessThanOrEqual(s.cutoffDay!);
    }
    for (const u of s.test) {
      const original = rows.find((o) => o.m === u.id)!;
      expect(original.day).toBeGreaterThanOrEqual(s.cutoffDay!);
    }
    expect(() => assertNoLeak(s, w)).not.toThrow();
  });

  it('freezes other people at the cutoff day', () => {
    const frozen = frozenWorld(doc, 92);
    expect((frozen.rankingsBy.get(2) ?? []).every((r) => r.day <= 92)).toBe(true);
    expect((frozen.rankingsBy.get(2) ?? []).length).toBeLessThan(rowsOf(2).length);
  });
});

// ---------------------------------------------------------------------------
// Metrics and statistics
// ---------------------------------------------------------------------------

const unit = (i: string, bucket: Unit['bucket'], score: number): Unit => ({
  id: i,
  medium: 'movies',
  bucket,
  score,
  source: 'film',
  coverage: 1,
});

describe('metrics', () => {
  const test = [
    unit('a', 'loved', 9.5),
    unit('b', 'loved', 7.2),
    unit('c', 'fine', 5),
    unit('d', 'not_for_me', 1),
  ];

  it('pairwise: cross-band and within-band separately, ties count a half', () => {
    const right = pairwise(test, (x) => ({ a: 4, b: 3, c: 2, d: 1 })[x]!);
    expect(right).toMatchObject({ accuracy: 1, crossBand: 1, withinBand: 1, pairs: 6 });
    const flat = pairwise(test, () => 0);
    expect(flat.accuracy).toBe(0.5);
    const close = pairwise([unit('a', 'loved', 8), unit('b', 'loved', 7.5)], () => 0);
    expect(close.pairs).toBe(0);
  });

  it('NDCG: 1 for the true order, lower otherwise, and unjudged ids carry no gain', () => {
    expect(ndcg(['a', 'b', 'c', 'd'], test)).toBeCloseTo(1, 10);
    expect(ndcg(['d', 'c', 'b', 'a'], test)!).toBeLessThan(1);
    expect(ndcg([], test)).toBe(0);
  });

  it('bootstrap is deterministic and brackets its mean', () => {
    const xs = [0.1, 0.4, 0.5, 0.9, 0.3];
    const a = bootstrap(xs)!;
    expect(bootstrap(xs)).toEqual(a);
    expect(a.lo).toBeLessThanOrEqual(a.mean);
    expect(a.hi).toBeGreaterThanOrEqual(a.mean);
  });
});

describe('the verdict rule', () => {
  const est = (mean: number, lo: number, hi: number, n = 30) => ({ mean, lo, hi, n });
  const flat = est(0, -0.01, 0.01);
  // Every candidate needs both estimates; the others sit flat unless a test sets them.
  const with_ = (engine: string, acc: ReturnType<typeof est>, rec: ReturnType<typeof est>) => ({
    table: {},
    paired: {
      final: {
        all: {
          v2_metadata: { 'm1.accuracy': flat, 'm2.recall50': flat },
          v2_metadata_social: { 'm1.accuracy': flat, 'm2.recall50': flat },
          popularity: {
            'm1.accuracy': est(-0.2, -0.3, -0.1),
            'm2.recall50': est(-0.2, -0.3, -0.1),
          },
          [engine]: { 'm1.accuracy': acc, 'm2.recall50': rec },
        },
      },
    },
  });

  it('is INSUFFICIENT_EVIDENCE below the minimum final cohort, whatever the numbers', () => {
    expect(
      verdictFor(
        with_('v2_metadata', est(0.2, 0.1, 0.3), est(0.2, 0.1, 0.3)),
        MIN_FINAL_USERS - 1,
      ).call,
    ).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('trials a candidate that beats V1 on one primary metric and is non-inferior on the other', () => {
    expect(
      verdictFor(with_('v2_metadata', est(0.05, 0.01, 0.09), est(0, -0.01, 0.01)), 30).call,
    ).toBe('TRIAL_V2_METADATA');
    expect(
      verdictFor(with_('v2_metadata_social', est(0, -0.01, 0.01), est(0.1, 0.02, 0.2)), 30)
        .call,
    ).toBe('TRIAL_V2_SOCIAL');
  });

  it('keeps V1 when every candidate is clearly worse on one primary metric, even if it might be better on the other', () => {
    const both = {
      table: {},
      paired: {
        final: {
          all: {
            v2_metadata: {
              'm1.accuracy': est(0.01, -0.03, 0.05),
              'm2.recall50': est(-0.2, -0.28, -0.14),
            },
            v2_metadata_social: {
              'm1.accuracy': est(0.01, -0.03, 0.05),
              'm2.recall50': est(-0.2, -0.28, -0.14),
            },
          },
        },
      },
    };
    expect(verdictFor(both, 30).call).toBe('KEEP_V1');
  });

  it('never lets the popularity baseline decide a verdict', () => {
    const popular = {
      table: {},
      paired: {
        final: {
          all: {
            v2_metadata: {
              'm1.accuracy': est(-0.05, -0.09, -0.03),
              'm2.recall50': est(-0.05, -0.09, -0.03),
            },
            v2_metadata_social: {
              'm1.accuracy': est(-0.05, -0.09, -0.03),
              'm2.recall50': est(-0.05, -0.09, -0.03),
            },
            popularity: {
              'm1.accuracy': est(0.1, 0.05, 0.15),
              'm2.recall50': est(0.3, 0.2, 0.4),
            },
          },
        },
      },
    };
    expect(verdictFor(popular, 30).call).toBe('KEEP_V1');
  });

  it('keeps V1 when no candidate is better by more than the margin', () => {
    expect(
      verdictFor(with_('v2_metadata', est(-0.05, -0.09, -0.01), est(-0.04, -0.08, 0.01)), 30)
        .call,
    ).toBe('KEEP_V1');
  });

  it('is INSUFFICIENT_EVIDENCE when a primary estimate is missing or rests on too few people', () => {
    const missing = {
      table: {},
      paired: { final: { all: { v2_metadata: { 'm1.accuracy': est(0.1, 0.05, 0.2) } } } },
    };
    expect(verdictFor(missing, 30).call).toBe('INSUFFICIENT_EVIDENCE');
    // One contributing person gives a zero-width interval; it must not trigger a trial.
    expect(
      verdictFor(with_('v2_metadata', est(0.3, 0.3, 0.3, 1), est(0.3, 0.3, 0.3, 1)), 30).call,
    ).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('keeps V1 over a candidate that wins one metric but is clearly worse on the other', () => {
    expect(
      verdictFor(with_('v2_metadata', est(0.05, 0.01, 0.09), est(-0.1, -0.2, -0.05)), 30).call,
    ).toBe('KEEP_V1');
  });
});

// ---------------------------------------------------------------------------
// End to end, synthetic
// ---------------------------------------------------------------------------

describe('end to end on a small synthetic export', () => {
  // Small on purpose: this suite runs in CI beside timing-sensitive UI tests, and the full
  // pipeline (five splits, four engines, three launch seeds, both suites) is CPU-heavy. The
  // reference-size run is `run.mjs --synthetic`, not CI. (Below about 300 titles at this watched
  // median the A3 generator itself never finishes: it cannot draw enough distinct titles.)
  const small = { ...DEFAULT_WORLD, titles: 300, people: 30, watchedMedian: 22 };
  const synthetic = JSON.parse(JSON.stringify(syntheticExport(generateWorld(small))));

  it('runs every engine on both media, and its report names no person or title', () => {
    const results = benchmark(synthetic, 'A');
    expect(results.map((r) => r.medium)).toEqual(['movies', 'tv']);
    for (const r of results) {
      expect(r.people).toBeGreaterThan(0);
      for (const engine of BENCH_ENGINES) expect(r.table.all!.all![engine]).toBeDefined();
    }
    const report = renderBenchmark(results, hybridReport(synthetic), 'synthetic (small)');
    expect(report).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(report).toMatch(/NOT (MEASURABLE|REPLAYED)/);
  });

  it('Suite B runs too', () => {
    const results = benchmark(synthetic, 'B');
    expect(results.every((r) => r.suite === 'B')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The runner (run.mjs), off by default
// ---------------------------------------------------------------------------

/**
 * The synthetic reference world: the A3 generator at 300 people and 1,500 titles. The full
 * 4,000-person world takes hours through five splits, four engines and three launch seeds, and
 * the real cohort is tens of people, so this size is the representative one.
 */
const REFERENCE_WORLD = { ...DEFAULT_WORLD, titles: 1500, people: 300 };

const RUNNER = process.env.REC_BENCHMARK === '1';
(RUNNER ? describe : describe.skip)('REC_BENCHMARK_RUNNER', () => {
  it('REC_BENCHMARK_RUNNER', () => {
    const input =
      process.env.REC_BENCHMARK_SYNTHETIC === '1'
        ? JSON.parse(JSON.stringify(syntheticExport(generateWorld(REFERENCE_WORLD))))
        : (() => {
            const raw = JSON.parse(readFileSync(process.env.REC_BENCHMARK_EXPORT!, 'utf8'));
            return raw && typeof raw === 'object' && 'replay' in raw ? raw.replay : raw;
          })();
    const label =
      process.env.REC_BENCHMARK_SYNTHETIC === '1'
        ? 'synthetic reference world (300 people, 1,500 titles)'
        : 'real export';
    const results = [...benchmark(input, 'A'), ...benchmark(input, 'B')];
    const report = renderBenchmark(results, hybridReport(input), label);
    // eslint-disable-next-line no-console -- the runner's whole output
    console.log(report);
    if (process.env.REC_BENCHMARK_OUT) {
      mkdirSync(process.env.REC_BENCHMARK_OUT, { recursive: true });
      writeFileSync(join(process.env.REC_BENCHMARK_OUT, 'benchmark.md'), report);
    }
  }, 3_600_000);
});
