import {
  isExpired,
  isTooOldToShow,
  mixTrending,
  TRENDING_SHELF_SIZE,
  type TrendingCandidate,
} from './trending';

const candidate = (over: Partial<TrendingCandidate> & { mediaItemId: string }): TrendingCandidate => ({
  kind: 'movie',
  rank: 0,
  popularity: 100,
  ...over,
});

describe('mixing the two lists', () => {
  it('orders by popularity across both kinds', () => {
    const mixed = mixTrending([
      candidate({ mediaItemId: 'film-a', kind: 'movie', rank: 0, popularity: 50 }),
      candidate({ mediaItemId: 'show-a', kind: 'series', rank: 0, popularity: 90 }),
      candidate({ mediaItemId: 'film-b', kind: 'movie', rank: 1, popularity: 70 }),
    ]);

    expect(mixed.map((item) => item.mediaItemId)).toEqual(['show-a', 'film-b', 'film-a']);
  });

  it('does not alternate the two lists', () => {
    // Trend rank chooses who is on the shelf; it does not choose the order. A rank merge
    // would produce film, show, film, show regardless of the data.
    const mixed = mixTrending([
      candidate({ mediaItemId: 'film-1', kind: 'movie', rank: 0, popularity: 400 }),
      candidate({ mediaItemId: 'film-2', kind: 'movie', rank: 1, popularity: 380 }),
      candidate({ mediaItemId: 'film-3', kind: 'movie', rank: 2, popularity: 300 }),
      candidate({ mediaItemId: 'show-1', kind: 'series', rank: 0, popularity: 120 }),
    ]);

    expect(mixed.map((item) => item.kind)).toEqual(['movie', 'movie', 'movie', 'series']);
  });

  it('lets television lead when television is what is trending', () => {
    const mixed = mixTrending([
      candidate({ mediaItemId: 'film-1', kind: 'movie', rank: 0, popularity: 30 }),
      candidate({ mediaItemId: 'show-1', kind: 'series', rank: 0, popularity: 900 }),
      candidate({ mediaItemId: 'show-2', kind: 'series', rank: 1, popularity: 800 }),
    ]);

    expect(mixed.slice(0, 2).map((item) => item.mediaItemId)).toEqual(['show-1', 'show-2']);
  });

  it('sinks an unenriched row to the bottom rather than treating it as unpopular-but-known', () => {
    const mixed = mixTrending([
      candidate({ mediaItemId: 'unknown', rank: 0, popularity: null }),
      candidate({ mediaItemId: 'known', rank: 5, popularity: 1 }),
    ]);

    expect(mixed.map((item) => item.mediaItemId)).toEqual(['known', 'unknown']);
  });

  it('orders two unenriched rows by their own trend rank, deterministically', () => {
    const mixed = mixTrending([
      candidate({ mediaItemId: 'b', rank: 4, popularity: null }),
      candidate({ mediaItemId: 'a', rank: 1, popularity: null }),
    ]);

    expect(mixed.map((item) => item.mediaItemId)).toEqual(['a', 'b']);
  });

  it('breaks a popularity tie by trend rank', () => {
    const mixed = mixTrending([
      candidate({ mediaItemId: 'second', rank: 3, popularity: 10 }),
      candidate({ mediaItemId: 'first', rank: 1, popularity: 10 }),
    ]);

    expect(mixed.map((item) => item.mediaItemId)).toEqual(['first', 'second']);
  });

  it('keeps the shelf shallow', () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      candidate({ mediaItemId: `m-${index}`, rank: index, popularity: 100 - index }),
    );

    expect(mixTrending(many)).toHaveLength(TRENDING_SHELF_SIZE);
  });
});

/**
 * Founder decision, 2026-10-28. `popularity` builds up over weeks, so ranking all forty
 * rows by it let a blockbuster at daily rank 17 push out what was #1 today, and the
 * shelf showed the same titles for weeks.
 */
describe('trend rank decides who is on the shelf', () => {
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

  it("keeps today's top titles when a far more popular title sits at rank 17", () => {
    // The Spider-Man case: rank 17 with a long-accumulated popularity, against today's
    // top three with modest figures.
    const films = ranked('movie', 20, (rank) => (rank === 16 ? 473 : 50 - rank));
    const mixed = mixTrending([...films, ...ranked('series', 20, () => 10)]);

    expect(ids(mixed)).not.toContain('movie-16');
    expect(ids(mixed)).toEqual(expect.arrayContaining(['movie-0', 'movie-1', 'movie-2']));
  });

  it('takes exactly the top six of each kind, ordering only those by popularity', () => {
    // Popularity rises with rank here, so a popularity cut would take ranks 14–19 of
    // each list instead — the exact inversion this rule exists to prevent.
    const films = ranked('movie', 20, (rank) => 100 + rank * 10);
    const series = ranked('series', 20, (rank) => 105 + rank * 10);
    const mixed = mixTrending([...series, ...films]);

    expect(mixed).toHaveLength(12);
    expect([...ids(mixed)].sort()).toEqual(
      [
        'movie-0', 'movie-1', 'movie-2', 'movie-3', 'movie-4', 'movie-5',
        'series-0', 'series-1', 'series-2', 'series-3', 'series-4', 'series-5',
      ].sort(),
    );
    // And within the twelve, popularity alone sets the order.
    expect(ids(mixed)).toEqual([
      'series-5', 'movie-5', 'series-4', 'movie-4', 'series-3', 'movie-3',
      'series-2', 'movie-2', 'series-1', 'movie-1', 'series-0', 'movie-0',
    ]);
  });

  it('backfills from series, in trend order, when there are fewer than six films', () => {
    // The backfill follows trend rank, not popularity: series-9 is the most popular row
    // here and still is not chosen ahead of series-6 and series-7.
    const series = ranked('series', 12, (rank) => (rank === 9 ? 999 : 100 - rank));
    const mixed = mixTrending([...ranked('movie', 4), ...series]);

    expect(mixed).toHaveLength(12);
    expect(mixed.filter((item) => item.kind === 'movie')).toHaveLength(4);
    expect(ids(mixed.filter((item) => item.kind === 'series')).sort()).toEqual(
      ['series-0', 'series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-6', 'series-7'].sort(),
    );
  });

  it('backfills from films, in trend order, when there are fewer than six series', () => {
    const films = ranked('movie', 12, (rank) => (rank === 11 ? 999 : 100 - rank));
    const mixed = mixTrending([...films, ...ranked('series', 2)]);

    expect(mixed).toHaveLength(12);
    expect(mixed.filter((item) => item.kind === 'series')).toHaveLength(2);
    expect(ids(mixed.filter((item) => item.kind === 'movie')).sort()).toEqual(
      Array.from({ length: 10 }, (_, rank) => `movie-${rank}`).sort(),
    );
  });

  it('shows what there is when both lists are short', () => {
    const mixed = mixTrending([...ranked('movie', 3), ...ranked('series', 2)]);

    expect(mixed).toHaveLength(5);
  });

  it('counts ranks as they arrive, so a gap left by a missing title is not a slot', () => {
    // `useTrending` drops ids with no `media_items` row before mixing, which leaves gaps
    // in rank. The quota is six *usable* titles, so the next one down takes the place.
    const films = [0, 1, 3, 4, 5, 6, 7].map((rank) =>
      candidate({ mediaItemId: `movie-${rank}`, kind: 'movie', rank }),
    );
    const mixed = mixTrending([...films, ...ranked('series', 6)]);

    expect(ids(mixed.filter((item) => item.kind === 'movie')).sort()).toEqual(
      ['movie-0', 'movie-1', 'movie-3', 'movie-4', 'movie-5', 'movie-6'].sort(),
    );
  });

  it('orders equal popularity the same way whatever order the input arrived in', () => {
    const rows = [...ranked('movie', 6), ...ranked('series', 6)];
    const expected = [
      'movie-0', 'series-0', 'movie-1', 'series-1', 'movie-2', 'series-2',
      'movie-3', 'series-3', 'movie-4', 'series-4', 'movie-5', 'series-5',
    ];

    expect(ids(mixTrending(rows))).toEqual(expected);
    expect(ids(mixTrending([...rows].reverse()))).toEqual(expected);
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
