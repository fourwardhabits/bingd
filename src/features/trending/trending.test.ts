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
    // A rank merge would produce film, show, film, show regardless of the data. The
    // decision was explicit that a mixed shelf must come from relevance rather than
    // from a quota, and this is the shape that would betray one.
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
