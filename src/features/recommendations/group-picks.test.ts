import type { CollectionItem } from '@/features/collection/filters';

import {
  FALLBACK_FLOOR,
  GROUP_PICKS_MAX,
  GROUP_PICKS_MIN,
  STRONG_FLOOR,
  hasSharedSaves,
  reasonFor,
  selectGroupPicks,
  sourceMix,
  type GroupPick,
  type GroupPickSource,
} from './group-picks';

const item = (id: string, title: string, genre = `genre-${id}`): CollectionItem => ({
  mediaItemId: id,
  title,
  seriesTitle: null,
  kind: 'movie',
  year: 2020,
  posterPath: null,
  genres: [genre],
  language: 'en',
  runtimeMinutes: null,
  score: null,
  bucket: null,
  watchedOn: null,
  addedAt: null,
});

const pick = (
  id: string,
  groupScore: number,
  {
    source = 'group' as GroupPickSource,
    savedCount = 0,
    watchedCount = 0,
    rewatch = false,
    title = `Title ${id}`,
    genre,
  }: Partial<Omit<GroupPick, 'item' | 'groupScore'>> & { title?: string; genre?: string } = {},
): GroupPick => ({
  item: item(id, title, genre),
  savedCount,
  watchedCount,
  rewatch,
  source,
  groupScore,
  communityScore: null,
});

const strong = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => pick(`s${i + offset}`, STRONG_FLOOR + 0.3 - i * 0.001));

const fallback = (n: number) =>
  Array.from({ length: n }, (_, i) => pick(`f${i}`, FALLBACK_FLOOR + 0.05 - i * 0.001));

const trending = (n: number) =>
  Array.from({ length: n }, (_, i) => pick(`t${i}`, 0.15, { source: 'trending' }));

describe('what makes the list', () => {
  it('shows up to twenty strong picks', () => {
    const chosen = selectGroupPicks([...strong(25)]);
    expect(chosen).toHaveLength(GROUP_PICKS_MAX);
    expect(chosen.every((p) => p.groupScore >= STRONG_FLOOR)).toBe(true);
  });

  it('shows thirteen strong picks as thirteen, without padding', () => {
    const chosen = selectGroupPicks([...strong(13), ...trending(10)]);
    expect(chosen).toHaveLength(13);
    expect(chosen.every((p) => p.source !== 'trending')).toBe(true);
  });

  it('fills seven strong with credible fallback only to ten', () => {
    const chosen = selectGroupPicks([...strong(7), ...fallback(8)]);
    expect(chosen).toHaveLength(GROUP_PICKS_MIN);
    expect(chosen.slice(0, 7).every((p) => p.groupScore >= STRONG_FLOOR)).toBe(true);
  });

  it('reaches for trending only after group-derived fallback, and only toward ten', () => {
    const chosen = selectGroupPicks([...strong(4), ...fallback(2), ...trending(15)]);
    expect(chosen).toHaveLength(GROUP_PICKS_MIN);
    expect(chosen.filter((p) => p.source === 'trending')).toHaveLength(4);
    // Trending comes last, whatever order the pool held.
    expect(chosen.slice(0, 6).every((p) => p.source !== 'trending')).toBe(true);
  });

  it('shows six credible picks as six when there is nothing honest to fill with', () => {
    const chosen = selectGroupPicks([...strong(4), ...fallback(2)]);
    expect(chosen).toHaveLength(6);
  });

  it('never admits noise below the fallback floor', () => {
    const noise = Array.from({ length: 10 }, (_, i) => pick(`n${i}`, FALLBACK_FLOOR - 0.01));
    const chosen = selectGroupPicks([...strong(3), ...noise]);
    expect(chosen).toHaveLength(3);
  });

  it('holds the franchise ceiling at two, across every pass', () => {
    const franchise = [
      pick('a', 0.9, { title: 'Saga: First' }),
      pick('b', 0.89, { title: 'Saga: Second' }),
      pick('c', 0.88, { title: 'Saga: Third' }),
      pick('d', 0.5, { title: 'Elsewhere' }),
    ];
    const chosen = selectGroupPicks(franchise);
    expect(chosen.map((p) => p.item.mediaItemId)).toEqual(['a', 'b', 'd']);
  });

  it('holds the genre ceiling at forty percent of the wall', () => {
    const comedies = Array.from({ length: 12 }, (_, i) =>
      pick(`c${i}`, 0.9 - i * 0.001, { genre: 'Comedy' }),
    );
    const dramas = Array.from({ length: 12 }, (_, i) =>
      pick(`d${i}`, 0.5 - i * 0.001, { genre: 'Drama' }),
    );
    const chosen = selectGroupPicks([...comedies, ...dramas]);
    expect(chosen.filter((p) => p.item.genres[0] === 'Comedy')).toHaveLength(8);
    // Two genres at a ceiling of eight each is sixteen: a narrow pool yields a short
    // list rather than a relaxed cap, exactly as the For You wall behaves.
    expect(chosen).toHaveLength(16);
  });

  it('preserves the server order among what it admits', () => {
    const pool = strong(12);
    const chosen = selectGroupPicks(pool);
    expect(chosen.map((p) => p.item.mediaItemId)).toEqual(pool.map((p) => p.item.mediaItemId));
  });

  it('answers the same pool with the same list', () => {
    const pool = [...strong(8), ...fallback(4), ...trending(5)];
    expect(selectGroupPicks(pool)).toEqual(selectGroupPicks(pool));
  });
});

describe('the one reason each row gives', () => {
  it('counts savers when more than one person saved it', () => {
    expect(reasonFor(pick('x', 0.9, { savedCount: 4, source: 'saved' }))).toBe(
      '4 people saved this',
    );
  });

  it('says someone here saved it for a single saver, identifying nobody', () => {
    expect(reasonFor(pick('x', 0.9, { savedCount: 1, source: 'saved' }))).toBe(
      'Someone here saved this',
    );
  });

  it('names an eligible rewatch', () => {
    expect(reasonFor(pick('x', 0.6, { rewatch: true, watchedCount: 1, source: 'rewatch' }))).toBe(
      'Worth a rewatch',
    );
  });

  it('is honest about trending fill', () => {
    expect(reasonFor(pick('x', 0.15, { source: 'trending' }))).toBe('Trending now');
  });

  it('claims only group fit otherwise, never measured social proof', () => {
    const reason = reasonFor(pick('x', 0.7));
    expect(reason).toBe('Fits the group');
    expect(reason).not.toMatch(/match/i);
  });

  it('lets a saved rewatch lead with the save, which is the stronger fact', () => {
    expect(
      reasonFor(pick('x', 0.8, { savedCount: 2, rewatch: true, watchedCount: 1, source: 'saved' })),
    ).toBe('2 people saved this');
  });

  it('uses no em dashes anywhere in the vocabulary', () => {
    const reasons = [
      reasonFor(pick('a', 0.9, { savedCount: 3, source: 'saved' })),
      reasonFor(pick('b', 0.9, { savedCount: 1, source: 'saved' })),
      reasonFor(pick('c', 0.6, { rewatch: true, source: 'rewatch' })),
      reasonFor(pick('d', 0.15, { source: 'trending' })),
      reasonFor(pick('e', 0.7)),
    ];
    for (const reason of reasons) expect(reason).not.toContain('—');
  });
});

describe('the analytics tally', () => {
  it('counts every source in a fixed order and names no title', () => {
    const mix = sourceMix([
      pick('a', 0.9, { source: 'saved', savedCount: 2 }),
      pick('b', 0.8, { source: 'saved', savedCount: 2 }),
      pick('c', 0.7 ),
      pick('d', 0.6, { source: 'rewatch', rewatch: true }),
      pick('e', 0.15, { source: 'trending' }),
    ]);
    expect(mix).toBe('saved:2|group:1|rewatch:1|trending:1');
  });

  it('says zero out loud for an absent source', () => {
    expect(sourceMix([pick('a', 0.7)])).toBe('saved:0|group:1|rewatch:0|trending:0');
  });
});

describe('the zero-overlap line', () => {
  it('knows when nothing rests on a shared save', () => {
    expect(hasSharedSaves([pick('a', 0.7), pick('b', 0.6)])).toBe(false);
    expect(hasSharedSaves([pick('a', 0.7, { savedCount: 1 })])).toBe(true);
  });
});
