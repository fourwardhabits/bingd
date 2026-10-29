import {
  isExpired,
  isTooOldToShow,
  mixTrending,
  TRENDING_SHELF_SIZE,
  type TrendingCandidate,
} from './trending';

/**
 * Rows carry a `popularity` the way the old ones did, so that every test below can show
 * it is ignored. It is not part of `TrendingCandidate` any more; `mixTrending` passes
 * extra fields through untouched and never reads them.
 */
type Row = TrendingCandidate & { popularity: number | null };

const candidate = (over: Partial<Row> & { mediaItemId: string }): Row => ({
  kind: 'movie',
  rank: 0,
  popularity: 100,
  ...over,
});

/** `count` rows of one kind, at trend ranks 0..count-1, with the given popularity. */
const ranked = (
  kind: 'movie' | 'series',
  count: number,
  popularity: (rank: number) => number | null = () => 100,
) =>
  Array.from({ length: count }, (_, rank) =>
    candidate({ mediaItemId: `${kind}-${rank}`, kind, rank, popularity: popularity(rank) }),
  );

const ids = (items: readonly TrendingCandidate[]) => items.map((item) => item.mediaItemId);

/** The normal shelf: film #1, series #1, film #2, series #2, … */
const INTERLEAVED = [
  'movie-0', 'series-0', 'movie-1', 'series-1', 'movie-2', 'series-2',
  'movie-3', 'series-3', 'movie-4', 'series-4', 'movie-5', 'series-5',
];

/**
 * Founder decisions, 2026-10-28. `popularity` builds up over weeks, so ranking all forty
 * rows by it let a blockbuster at daily rank 17 push out what was #1 today, and the
 * shelf showed the same titles for weeks.
 */
describe('trend rank decides who is on the shelf', () => {
  it("keeps today's top titles when a far more popular title sits at rank 17", () => {
    // The Spider-Man case: rank 17 with a long-accumulated popularity, against today's
    // top three with modest figures.
    const films = ranked('movie', 20, (rank) => (rank === 16 ? 473 : 50 - rank));
    const mixed = mixTrending([...films, ...ranked('series', 20, () => 10)]);

    expect(ids(mixed)).not.toContain('movie-16');
    expect(ids(mixed)).toEqual(expect.arrayContaining(['movie-0', 'movie-1', 'movie-2']));
  });

  it('takes exactly the top six of each kind, whatever their popularity', () => {
    // Popularity rises with rank here, so a popularity cut would take ranks 14–19 of
    // each list instead — the exact inversion this rule exists to prevent.
    const films = ranked('movie', 20, (rank) => 100 + rank * 10);
    const series = ranked('series', 20, (rank) => 105 + rank * 10);
    const mixed = mixTrending([...series, ...films]);

    expect(mixed).toHaveLength(12);
    expect([...ids(mixed)].sort()).toEqual([...INTERLEAVED].sort());
  });

  it('keeps the shelf shallow', () => {
    expect(mixTrending(ranked('movie', 40))).toHaveLength(TRENDING_SHELF_SIZE);
  });

  it('shows what there is when both lists are short', () => {
    const mixed = mixTrending([...ranked('movie', 3), ...ranked('series', 2)]);

    expect(ids(mixed)).toEqual(['movie-0', 'series-0', 'movie-1', 'series-1', 'movie-2']);
  });
});

/**
 * Founder decision, 2026-10-28, after QA of the first version: the shelf is shown in
 * daily trend order, not re-sorted by popularity. Today's #1 film had been sitting
 * eighth behind titles that were merely big.
 */
describe('trend rank decides the order they appear in', () => {
  it('interleaves the two lists, film first at each rank', () => {
    expect(ids(mixTrending([...ranked('movie', 6), ...ranked('series', 6)]))).toEqual(INTERLEAVED);
  });

  it('shows the higher daily ranks before the lower ones, whatever their popularity', () => {
    // Popularity rises as trend rank falls — the order a popularity sort would reverse.
    const films = ranked('movie', 20, (rank) => 100 + rank * 10);
    const series = ranked('series', 20, (rank) => 105 + rank * 10);

    expect(ids(mixTrending([...series, ...films]))).toEqual(INTERLEAVED);
  });

  it('does not let a far more popular #4 or #5 jump ahead of #1', () => {
    // The 2026-10-28 shelf: Clayface at film #4 had nearly twice the popularity of
    // Verity at #1 and was shown second while Verity sat eighth.
    const films = ranked('movie', 6, (rank) => (rank === 3 ? 900 : rank === 4 ? 800 : 10));
    const series = ranked('series', 6, () => 5);
    const mixed = ids(mixTrending([...films, ...series]));

    expect(mixed[0]).toBe('movie-0');
    expect(mixed.indexOf('movie-3')).toBeGreaterThan(mixed.indexOf('movie-0'));
    expect(mixed.indexOf('movie-4')).toBeGreaterThan(mixed.indexOf('movie-0'));
    expect(mixed).toEqual(INTERLEAVED);
  });

  it('places a title with no popularity by its rank like any other', () => {
    // An unenriched row (seeded from Wikidata, never filled in) used to sink to the end.
    // Popularity is not read any more, so its trend rank alone places it.
    const films = ranked('movie', 6, (rank) => (rank === 0 ? null : 500));

    expect(ids(mixTrending([...films, ...ranked('series', 6)]))).toEqual(INTERLEAVED);
  });

  it('gives the same order whatever order the input arrived in', () => {
    const rows = [...ranked('movie', 6), ...ranked('series', 6)];
    // Series first, and the films backwards.
    const shuffled = [...rows.slice(6), ...rows.slice(0, 6).reverse()];

    expect(ids(mixTrending(rows))).toEqual(INTERLEAVED);
    expect(ids(mixTrending([...rows].reverse()))).toEqual(INTERLEAVED);
    expect(ids(mixTrending(shuffled))).toEqual(INTERLEAVED);
  });

  it('breaks a tie within one list by id, deterministically', () => {
    // Two ids at one rank cannot come from one payload, but nothing upstream forbids it.
    const twins = [
      candidate({ mediaItemId: 'b', kind: 'movie', rank: 0 }),
      candidate({ mediaItemId: 'a', kind: 'movie', rank: 0 }),
    ];

    expect(ids(mixTrending(twins))).toEqual(['a', 'b']);
    expect(ids(mixTrending([...twins].reverse()))).toEqual(['a', 'b']);
  });
});

describe('a short list, and the other kind filling in', () => {
  it('backfills from series in trend order when there are fewer than six films', () => {
    // series-9 is the most popular row here and is still not chosen ahead of series-6 and
    // series-7. The extra series follow everything the quota chose.
    const series = ranked('series', 12, (rank) => (rank === 9 ? 999 : 100 - rank));
    const mixed = mixTrending([...ranked('movie', 4), ...series]);

    expect(ids(mixed)).toEqual([
      'movie-0', 'series-0', 'movie-1', 'series-1', 'movie-2', 'series-2',
      'movie-3', 'series-3', 'series-4', 'series-5', 'series-6', 'series-7',
    ]);
  });

  it('backfills from films in trend order when there are fewer than six series', () => {
    const films = ranked('movie', 12, (rank) => (rank === 11 ? 999 : 100 - rank));
    const mixed = mixTrending([...films, ...ranked('series', 2)]);

    expect(ids(mixed)).toEqual([
      'movie-0', 'series-0', 'movie-1', 'series-1',
      'movie-2', 'movie-3', 'movie-4', 'movie-5', 'movie-6', 'movie-7', 'movie-8', 'movie-9',
    ]);
  });

  it('counts a gap left by a missing title as neither a slot nor a place in line', () => {
    // `useTrending` drops ids with no `media_items` row before mixing, which leaves gaps
    // in rank — film rank 2 is missing here. The quota is six *usable* films, so film
    // rank 6 takes the place, and film rank 3 is shown as the third film beside the
    // third series rather than a slot further down.
    const films = [0, 1, 3, 4, 5, 6, 7].map((rank) =>
      candidate({ mediaItemId: `movie-${rank}`, kind: 'movie', rank }),
    );

    expect(ids(mixTrending([...films, ...ranked('series', 6)]))).toEqual([
      'movie-0', 'series-0', 'movie-1', 'series-1', 'movie-3', 'series-2',
      'movie-4', 'series-3', 'movie-5', 'series-4', 'movie-6', 'series-5',
    ]);
  });

  it('shows a single kind in its own order when the other list is unusable', () => {
    expect(ids(mixTrending(ranked('series', 14)))).toEqual(
      Array.from({ length: 12 }, (_, rank) => `series-${rank}`),
    );
  });
});

describe('how old a cached list may be', () => {
  const now = Date.parse('2026-08-16T12:00:00Z');

  it('knows when it has passed its TTL', () => {
    expect(isExpired('2026-08-16T11:59:00Z', now)).toBe(true);
    expect(isExpired('2026-08-16T17:00:00Z', now)).toBe(false);
  });

  it('treats a missing or unparseable expiry as expired', () => {
    expect(isExpired(null, now)).toBe(true);
    expect(isExpired('soon', now)).toBe(true);
  });

  it('still shows a list a few hours past its TTL', () => {
    // Six hours is the TTL; the adapter's schedule slipping by an hour must not
    // leave a hole where the shelf was.
    expect(isTooOldToShow('2026-08-16T02:00:00Z', now)).toBe(false);
  });

  it('drops a list old enough that "trending now" would be a false claim', () => {
    expect(isTooOldToShow('2026-08-01T12:00:00Z', now)).toBe(true);
    expect(isTooOldToShow(null, now)).toBe(true);
  });
});
