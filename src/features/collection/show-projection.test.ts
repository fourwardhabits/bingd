import { compareShowProjections, displayTenths, projectShow, projectShows } from './show-projection';
import type { RankedEntry } from './use-collection';

/**
 * The effective show score (WS-TVC, founder spec t168u §2) and the interface contract with
 * WS-COMM (04): explicit show score first, else the mean of the ranked seasons' canonical
 * scores at full precision, else nothing. Every vector is built through the real
 * `scoreFor` bands, so a season's score is what the Collection would draw for it.
 */

const at = (n: number) => `2026-10-${String(n).padStart(2, '0')}T00:00:00Z`;

const season = (
  id: string,
  seriesId: string,
  position: number,
  over: Partial<RankedEntry> = {},
): RankedEntry => ({
  mediaItemId: id,
  title: `Season ${over.seasonNumber ?? 1}`,
  year: 2020,
  posterPath: `/${id}.jpg`,
  genres: ['Drama'],
  runtimeMinutes: null,
  kind: 'season',
  seriesTitle: `Series ${seriesId}`,
  seasonNumber: 1,
  seriesId,
  language: 'en',
  bucket: 'loved',
  position,
  category: 'tv_seasons',
  rankedAt: at(1),
  seriesPosterPath: `/${seriesId}-poster.jpg`,
  seriesYear: 2019,
  ...over,
});

const show = (id: string, position: number, over: Partial<RankedEntry> = {}): RankedEntry => ({
  mediaItemId: id,
  title: `Series ${id}`,
  year: 2019,
  posterPath: `/${id}-own.jpg`,
  genres: ['Drama'],
  runtimeMinutes: null,
  kind: 'series',
  seriesTitle: null,
  seasonNumber: null,
  seriesId: null,
  language: 'en',
  bucket: 'loved',
  position,
  category: 'tv_shows',
  rankedAt: at(2),
  ...over,
});

/**
 * A `loved` season band of 31 titles: rank r scores 10 − (r − 1) × 0.1, so rank 1 is 10.0,
 * 11 is 9.0, 14 is 8.7, 15 is 8.6, 21 is 8.0, 27 is 7.4 and 31 is 7.0. Every slot not
 * claimed by the series under test is filler from another series.
 */
const lovedBand = (claims: Record<number, RankedEntry>): RankedEntry[] =>
  Array.from({ length: 31 }, (_, i) => {
    const rank = i + 1;
    return claims[rank] ?? season(`filler-${rank}`, `filler-series-${rank}`, rank);
  });

const pick = (seasons: RankedEntry[], shows: RankedEntry[], seriesId = 'S') =>
  projectShow(seriesId, seasons, shows);

describe('the golden vectors (contract with WS-COMM)', () => {
  it('V1: an explicit 10.0 wins over seasons 10.0 and 7.0', () => {
    // Two loved seasons alone in their band: 10.0 and 7.0.
    const seasons = [season('s1', 'S', 1), season('s2', 'S', 2, { seasonNumber: 2 })];
    const p = pick(seasons, [show('S', 1)])!;
    expect(p).toMatchObject({ source: 'explicit', display: 10, sumTenths: 100, n: 1 });
    expect(p.rankedSeasonCount).toBe(2);
    expect(p.contributors).toEqual(['S']);
  });

  it('V2: no show, seasons 10.0 and 7.0 → average 8.5', () => {
    const seasons = [season('s1', 'S', 1), season('s2', 'S', 2, { seasonNumber: 2 })];
    const p = pick(seasons, [])!;
    expect(p).toMatchObject({ source: 'average', sumTenths: 170, n: 2, display: 8.5 });
    expect(p.score).toBe(8.5);
    expect(p.contributors).toEqual(['s1', 's2']);
  });

  it('V3: seasons 8.6 and 8.7 → 8.65, displayed 8.7 (never the float 8.649999…)', () => {
    const band = lovedBand({
      14: season('s1', 'S', 14),
      15: season('s2', 'S', 15, { seasonNumber: 2 }),
    });
    const p = pick(band, [])!;
    expect(p).toMatchObject({ source: 'average', sumTenths: 173, n: 2, display: 8.7 });
    // The float route this replaces gets it wrong.
    expect(((8.6 + 8.7) / 2).toFixed(1)).toBe('8.6');
  });

  it('V4: seasons 9.0, 8.0 and 7.4 → 8.1333…, displayed 8.1', () => {
    const band = lovedBand({
      11: season('s1', 'S', 11),
      21: season('s2', 'S', 21, { seasonNumber: 2 }),
      27: season('s3', 'S', 27, { seasonNumber: 3 }),
    });
    const p = pick(band, [])!;
    expect(p).toMatchObject({ source: 'average', sumTenths: 244, n: 3, display: 8.1 });
    expect(p.score).toBeCloseTo(8.1333, 4);
  });

  it('V5: an explicit 6.9 shows, and once removed the 10.0/7.0 average 8.5 takes over', () => {
    const seasons = [season('s1', 'S', 1), season('s2', 'S', 2, { seasonNumber: 2 })];
    // A single `fine` show scores the band's top, 6.9.
    const ranked = pick(seasons, [show('S', 1, { bucket: 'fine' })])!;
    expect(ranked).toMatchObject({ source: 'explicit', display: 6.9, bucket: 'fine' });
    const removed = pick(seasons, [])!;
    expect(removed).toMatchObject({ source: 'average', display: 8.5, bucket: null });
  });

  it('V6: nothing ranked → no poster', () => {
    expect(pick([], [])).toBeNull();
    expect(projectShows([], [])).toEqual([]);
  });
});

describe('integer-tenths rounding', () => {
  it.each([
    [173, 2, 8.7],
    [244, 3, 8.1],
    [245, 3, 8.2], // 8.1666… rounds up
    [175, 2, 8.8], // 8.75 is half, rounds up
    [100, 1, 10],
    [0, 4, 0],
  ])('displays %i tenths over %i as %d', (sum, n, display) => {
    expect(displayTenths(sum, n)).toBe(display);
  });
});

describe('the Rating order', () => {
  it('orders at full precision, not by the rounded display', () => {
    // 8.65 and 8.7 both display 8.7, but 8.7 is higher.
    const band = lovedBand({
      14: season('a1', 'A', 14),
      15: season('a2', 'A', 15, { seasonNumber: 2 }),
      13: season('b1', 'B', 13),
      12: season('b2', 'B', 12, { seasonNumber: 2 }), // 8.9 and 8.8 → 8.85
    });
    const order = projectShows(band, []).filter((p) => p.seriesId === 'A' || p.seriesId === 'B');
    expect(order.map((p) => p.seriesId)).toEqual(['B', 'A']);
  });

  it('puts an explicit score before an equal average', () => {
    const seasons = [season('a1', 'A', 1), season('a2', 'A', 2, { seasonNumber: 2 })];
    // Show B explicit at 8.5: a fine band cannot reach it, so build a 3-loved show pool.
    const shows = [show('X', 1), show('B', 2), show('Y', 3)];
    // Loved band of 3 shows: 10.0, 8.5, 7.0.
    const projected = projectShows(seasons, shows);
    const a = projected.find((p) => p.seriesId === 'A')!;
    const b = projected.find((p) => p.seriesId === 'B')!;
    expect(a.display).toBe(8.5);
    expect(b.display).toBe(8.5);
    expect(compareShowProjections(b, a)).toBeLessThan(0);
  });

  it('breaks an exact tie by position, then title, then id', () => {
    // Two single-season series sharing rank 1 of the `fine` band: both 6.9, same
    // position, same title — so the series id decides.
    const tie = [
      season('z1', 'Z', 1, { bucket: 'fine', seriesTitle: 'Alpha' }),
      season('y1', 'Y', 1, { bucket: 'fine', seriesTitle: 'Alpha' }),
    ];
    expect(projectShows(tie, []).map((p) => p.seriesId)).toEqual(['Y', 'Z']);
    // Forged around one projection: position first, then title, then id.
    const base = projectShows(tie, [])[0]!;
    const far = { ...base, tiePosition: 9, title: 'Aardvark', seriesId: 'a' };
    const beta = { ...base, tiePosition: 5, title: 'Beta', seriesId: 'b' };
    const alphaC = { ...base, tiePosition: 5, title: 'Alpha', seriesId: 'c' };
    const alphaA = { ...base, tiePosition: 5, title: 'Alpha', seriesId: 'a2' };
    expect([far, beta, alphaC, alphaA].sort(compareShowProjections).map((p) => p.seriesId)).toEqual([
      'a2',
      'c',
      'b',
      'a',
    ]);
  });

  it('is the same order whatever order the pools arrive in', () => {
    const band = lovedBand({
      3: season('a1', 'A', 3),
      9: season('b1', 'B', 9),
      20: season('b2', 'B', 20, { seasonNumber: 2 }),
    });
    const shows = [show('C', 1), show('D', 2)];
    const once = projectShows(band, shows).map((p) => p.seriesId);
    expect(projectShows([...band].reverse(), [...shows].reverse()).map((p) => p.seriesId)).toEqual(once);
  });
});

describe('what a poster carries', () => {
  it('uses the series poster, then the show row, then the first ranked season', () => {
    const withParent = pick([season('s2', 'S', 1, { seasonNumber: 2 })], [])!;
    expect(withParent.posterPath).toBe('/S-poster.jpg');
    const showOnly = pick([], [show('S', 1)])!;
    expect(showOnly.posterPath).toBe('/S-own.jpg');
    const bare = pick(
      [
        season('s3', 'S', 1, { seasonNumber: 3, seriesPosterPath: null, posterPath: '/s3.jpg' }),
        season('s1', 'S', 2, { seasonNumber: 1, seriesPosterPath: null, posterPath: '/s1.jpg' }),
      ],
      [],
    )!;
    expect(bare.posterPath).toBe('/s1.jpg');
  });

  it('names the series, not a season, and takes the latest contributing rankedAt', () => {
    const p = pick(
      [
        season('s1', 'S', 1, { rankedAt: at(3) }),
        season('s2', 'S', 2, { seasonNumber: 2, rankedAt: at(9) }),
      ],
      [],
    )!;
    expect(p.title).toBe('Series S');
    expect(p.rankedAt).toBe(at(9));
    expect(p.seasons.map((s) => s.mediaItemId)).toEqual(['s1', 's2']);
  });

  it('counts each ranked season once and ignores everything that is not a ranking', () => {
    // The pools hold rankings only: one row per ranked season, whatever was watched.
    const p = pick([season('s1', 'S', 1), season('s2', 'S', 2, { seasonNumber: 2 })], [])!;
    expect(p.n).toBe(2);
  });
});

/** A9: nothing is stored, so each change to the pools is a change to the projection. */
describe('recompute', () => {
  const base = [season('s1', 'S', 1), season('s2', 'S', 2, { seasonNumber: 2 })];

  it('follows a season ranked, reranked and removed', () => {
    expect(pick([season('s1', 'S', 1)], [])!.display).toBe(10);
    expect(pick(base, [])!.display).toBe(8.5);
    // Reranked: the two swap places, the mean is the same.
    const swapped = [season('s1', 'S', 2), season('s2', 'S', 1, { seasonNumber: 2 })];
    expect(pick(swapped, [])!.display).toBe(8.5);
    expect(pick([season('s2', 'S', 1, { seasonNumber: 2 })], [])!.display).toBe(10);
  });

  it('follows the show ranked, reranked and removed (falling back to the average)', () => {
    expect(pick(base, [show('S', 1)])!.source).toBe('explicit');
    const reranked = pick(base, [show('X', 1), show('S', 2)])!;
    expect(reranked.display).toBe(7);
    expect(pick(base, [])!).toMatchObject({ source: 'average', display: 8.5 });
  });

  it('is per account: another user’s pools give another user’s projection', () => {
    const mine = pick(base, [])!;
    const theirs = pick([season('s1', 'S', 1, { bucket: 'fine' })], [])!;
    expect(mine.display).toBe(8.5);
    expect(theirs.display).toBe(6.9);
  });
});

/** A10: a substantial collection, one pass. */
describe('scale', () => {
  it('projects 300+ seasons across 40+ series plus 20 explicit shows to one entry per series', () => {
    const seasons: RankedEntry[] = [];
    let position = 0;
    for (let s = 0; s < 44; s += 1) {
      for (let n = 1; n <= 7; n += 1) {
        position += 1;
        seasons.push(
          season(`s${s}-${n}`, `series-${s}`, position, {
            seasonNumber: n,
            bucket: position <= 120 ? 'loved' : position <= 240 ? 'fine' : 'not_for_me',
          }),
        );
      }
    }
    const shows = Array.from({ length: 20 }, (_, i) =>
      show(i < 10 ? `series-${i}` : `solo-${i}`, i + 1, { bucket: i < 12 ? 'loved' : 'fine' }),
    );
    expect(seasons.length).toBeGreaterThanOrEqual(300);

    const started = Date.now();
    const projected = projectShows(seasons, shows);
    const elapsed = Date.now() - started;

    // 44 series with seasons, 10 of them also explicit, plus 10 explicit-only shows.
    expect(projected).toHaveLength(54);
    expect(new Set(projected.map((p) => p.seriesId)).size).toBe(54);
    expect(projected.filter((p) => p.source === 'explicit')).toHaveLength(20);
    expect(projected.every((p) => Number.isFinite(p.display))).toBe(true);
    // Sorted, and stays sorted.
    for (let i = 1; i < projected.length; i += 1) {
      expect(compareShowProjections(projected[i - 1]!, projected[i]!)).toBeLessThanOrEqual(0);
    }
    expect(elapsed).toBeLessThan(250);
  });
});
