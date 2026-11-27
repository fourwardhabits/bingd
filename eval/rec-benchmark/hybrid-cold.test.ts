import type { ReplayExport, ReplayMedia, ReplayRanking } from '../rec-v2-replay/format';
import {
  collaborativeMirror,
  neighbourWeight,
  neighboursOf,
  renumber,
  scoringEngine,
  wall,
  worldOf,
  type Account,
} from '../rec-v2-replay/replay';
import {
  HYBRID_MEASURABLE_SHARE,
  assertNoLeak,
  benchmark,
  coldSplit,
  hybridVerdictFor,
  modeOne,
  modeTwo,
} from './benchmark';

/**
 * The 2026-11-27 additions to the benchmark: V2 hybrid through a mirror of the shipped
 * `_refresh_taste_neighbours` / `collaborative_candidates`, the cold-start suites, and the
 * coverage gate on the hybrid's call. Synthetic and hand-built data only.
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const film = (n: number): ReplayMedia => ({
  m: id(n),
  tmdb: n,
  kind: 'movie',
  parent: null,
  season: null,
  genres: ['Drama'],
  lang: 'en',
  year: 2010,
  popularity: 1000 - n,
  tile: true,
});
const show = (n: number): ReplayMedia => ({ ...film(n), kind: 'series' });
const season = (n: number, parent: number, s: number): ReplayMedia => ({
  ...film(n),
  kind: 'season',
  parent: id(parent),
  season: s,
  popularity: null,
  tile: false,
});

/**
 * Reader 1 ranks films 1–8. Neighbours 2 and 3 (public) rank the same eight the same way and
 * both love film 9; only neighbour 2 loves film 10. Person 4 has the same taste but is
 * private. Person 5 (public) shares only three titles. Everyone but the reader also ranks show
 * 100: whole-show Loved by 2 and 3, and 3 also ranks a season of it Not for me.
 */
function handExport(): ReplayExport {
  const media: ReplayMedia[] = [];
  for (let i = 1; i <= 12; i += 1) media.push(film(i));
  media.push(show(100), season(101, 100, 1));
  const rankings: ReplayRanking[] = [];
  let seq = 0;
  const ladder = (u: number, ids: number[], buckets: ReplayRanking['b'][]) =>
    ids.forEach((m, i) =>
      rankings.push({
        u,
        m: id(m),
        c: 'movies',
        b: buckets[i]!,
        p: i + 1,
        day: 100 + i,
        seq: (seq += 1),
      }),
    );
  const B: ReplayRanking['b'][] = [
    'loved',
    'loved',
    'loved',
    'loved',
    'fine',
    'fine',
    'not_for_me',
    'not_for_me',
  ];
  ladder(1, [1, 2, 3, 4, 5, 6, 7, 8], B);
  ladder(2, [9, 10, 1, 2, 3, 4, 5, 6, 7, 8], ['loved', 'loved', ...B]);
  ladder(3, [9, 1, 2, 3, 4, 5, 6, 7, 8], ['loved', ...B]);
  ladder(4, [9, 10, 1, 2, 3, 4, 5, 6, 7, 8], ['loved', 'loved', ...B]);
  ladder(5, [9, 10, 1, 2, 3], ['loved', 'loved', 'loved', 'loved', 'loved']);
  rankings.push({
    u: 2,
    m: id(100),
    c: 'tv_shows',
    b: 'loved',
    p: 1,
    day: 200,
    seq: (seq += 1),
  });
  rankings.push({
    u: 3,
    m: id(100),
    c: 'tv_shows',
    b: 'loved',
    p: 1,
    day: 200,
    seq: (seq += 1),
  });
  rankings.push({
    u: 3,
    m: id(101),
    c: 'tv_seasons',
    b: 'not_for_me',
    p: 1,
    day: 201,
    seq: (seq += 1),
  });
  return {
    format: 'bingd-rec-v2-replay-export',
    version: 1,
    exported_day: 400,
    users: [
      { u: 1, visibility: 'public' },
      { u: 2, visibility: 'public' },
      { u: 3, visibility: 'public' },
      { u: 4, visibility: 'private' },
      { u: 5, visibility: 'public' },
    ],
    rankings,
    logged: [],
    follows: [],
    media,
    similar: [{ m: id(1), ids: [id(11)] }],
    trending: [{ list: 'trending.movie.week', ids: [id(12)] }],
  };
}

const doc = handExport();
const w = worldOf(doc);
const reader = (rows = doc.rankings.filter((r) => r.u === 1)): Account => ({
  key: 1,
  visible: renumber(rows),
  logged: [],
  held: { movies: new Set(), tv: new Set() },
});

describe('V2 hybrid: the collaborative mirror', () => {
  it('weighs a neighbour as _taste_neighbour_weight does', () => {
    expect(neighbourWeight(55, 40)).toBe(0);
    expect(neighbourWeight(75, 5)).toBeCloseTo((20 / 45) * (5 / 15), 6);
    expect(neighbourWeight(85, 40)).toBeCloseTo((30 / 45) * (40 / 50), 6);
  });

  it('keeps public neighbours on at least five shared units, never a private account', () => {
    const keys = neighboursOf(reader(), w).map((n) => n.key);
    expect(keys.sort()).toEqual([2, 3]);
  });

  it('endorses a title two neighbours loved, never one only one neighbour loved', () => {
    const read = collaborativeMirror(reader(), w, 'movies');
    expect(read.neighbours).toBe(2);
    expect(read.rows.get(id(9))?.support).toBeGreaterThan(0);
    expect(read.rows.get(id(9))?.endorsers).toBe(2);
    expect(read.rows.has(id(10))).toBe(false);
    // Nothing the reader has met.
    for (let i = 1; i <= 8; i += 1) expect(read.rows.has(id(i))).toBe(false);
  });

  it('on TV takes a neighbour’s whole-show ranking over a season of it, once per series', () => {
    const read = collaborativeMirror(reader(), w, 'tv');
    const row = read.rows.get(id(100));
    expect(row?.endorsers).toBe(2);
    expect(row!.support).toBeGreaterThan(0);
    expect(read.rows.has(id(101))).toBe(false);
  });

  it('reads the reader’s training rankings only: hiding titles below five shared units leaves no neighbour', () => {
    const train = doc.rankings.filter((r) => r.u === 1).slice(0, 4);
    expect(neighboursOf(reader(train), w)).toEqual([]);
    expect(collaborativeMirror(reader(train), w, 'movies').rows.size).toBe(0);
  });

  it('puts an endorsed title in the hybrid’s pool as the collaborative source, and scores it with the shipped weights', () => {
    const built = wall(reader(), w, 'movies', 'v2_hybrid', 11);
    expect(built.via(id(9))).toBe('collaborative');
    const scored = built.scored.find((s) => s.mediaItemId === id(9));
    expect(scored?.explanation.collaborative?.endorsers).toBe(2);
    expect(scoringEngine('v2_hybrid')).toBe('v2_hybrid');
    expect(scoringEngine('v2_metadata+social')).toBe('v2_metadata');
  });
});

describe('Suite C: cold start at exactly k rankings', () => {
  const rows = doc.rankings.filter((r) => r.u === 2);
  it('trains on the first k rankings in time order and tests on every unit they do not reveal', () => {
    const s = coldSplit(2, rows, w.media, 'movies', 5)!;
    expect(s.train.visible).toHaveLength(5);
    expect(s.train.logged).toHaveLength(0);
    const trained = new Set(s.train.visible.map((r) => r.m));
    for (const u of s.test) expect(trained.has(u.id)).toBe(false);
    expect(() => assertNoLeak(s, w)).not.toThrow();
    // The TV unit is a test unit even though nothing about TV is in training.
    expect(coldSplit(2, rows, w.media, 'tv', 5)).toBeNull(); // one TV unit: fewer than two
  });

  it('skips a person who never got past k rankings', () => {
    expect(
      coldSplit(
        1,
        doc.rankings.filter((r) => r.u === 1),
        w.media,
        'movies',
        8,
      ),
    ).toBeNull();
  });

  it('runs every engine through both modes without a leak', () => {
    const s = coldSplit(2, rows, w.media, 'movies', 5)!;
    for (const engine of ['v1', 'v2_metadata', 'v2_metadata_social', 'v2_hybrid'] as const) {
      expect(() => modeOne(s, w, engine)).not.toThrow();
      expect(modeTwo(s, w, engine).seenShare).toBe(0);
    }
  });
});

describe('V2 hybrid’s call is gated on coverage', () => {
  const est = (mean: number, lo: number, hi: number, n = 30) => ({ mean, lo, hi, n });
  const winning = {
    table: {},
    paired: {
      final: {
        all: {
          v2_hybrid: {
            'm1.accuracy': est(0.05, 0.01, 0.09),
            'm2.recall50': est(0, -0.01, 0.01),
          },
        },
      },
    },
  };
  it('is not measurable below the coverage share, however good the numbers', () => {
    const v = hybridVerdictFor(winning, 30, {
      people: 30,
      withRows: Math.floor(30 * HYBRID_MEASURABLE_SHARE) - 1,
    });
    expect(v.call).toBe('INSUFFICIENT_EVIDENCE');
    expect(v.reason).toMatch(/not measurable/);
  });
  it('applies the pre-registered rule once measurable', () => {
    expect(hybridVerdictFor(winning, 30, { people: 30, withRows: 30 }).call).toBe(
      'TRIAL_OTHER_TESTED_ENGINE',
    );
  });
});

describe('end to end: Suite C5 on the hand-built export', () => {
  // The hand-built export, not a generated world: the 30-person generated world takes over a
  // minute through every engine, and CI already runs it for Suites A and B.
  it('runs, never shows a met title, and carries no verdict', () => {
    const results = benchmark(JSON.parse(JSON.stringify(doc)), 'C5');
    expect(results.some((r) => r.people > 0)).toBe(true);
    for (const r of results) {
      expect(r.verdict).toBeNull();
      for (const engine of ['v1', 'v2_metadata', 'v2_metadata_social', 'v2_hybrid'])
        expect(r.table.all?.all?.[engine]?.['m2.seenShare']?.mean ?? 0).toBe(0);
    }
  });
});
