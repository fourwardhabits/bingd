import { emptyFilters, type CollectionItem } from './filters';
import {
  applyMove,
  bandRange,
  crosses,
  ladderOf,
  landingBucket,
  moveActions,
  notices,
  planMove,
  scoreAfter,
  screenBlock,
  undoOf,
  type Ladder,
} from './rerank';
import { bandSizes, scoreFor, type Bucket } from './score';
import type { RankedEntry } from './use-collection';

/**
 * #318: where a dragged title may go, decided without React. Every drop, every VoiceOver
 * move and every Undo goes through these, so they are the contract the gesture rests on.
 */

const item = (
  id: string,
  position: number | null,
  bucket: Bucket | null,
  extra: Partial<CollectionItem> = {},
): CollectionItem => ({
  mediaItemId: id,
  title: `Title ${id}`,
  seriesTitle: null,
  kind: 'movie',
  year: 2000,
  posterPath: null,
  genres: [],
  language: 'en',
  runtimeMinutes: 100,
  score: position == null ? null : 5,
  position,
  category: position == null ? null : 'movies',
  bucket,
  watchedOn: null,
  addedAt: null,
  ...extra,
});

/** loved ×3, fine ×2, not_for_me ×2, then one unranked title. */
const WALL = [
  item('a', 1, 'loved'),
  item('b', 2, 'loved'),
  item('c', 3, 'loved'),
  item('d', 4, 'fine'),
  item('e', 5, 'fine'),
  item('f', 6, 'not_for_me'),
  item('g', 7, 'not_for_me'),
  item('u', null, null),
];

const ladder = ladderOf(WALL, 'movies') as Ladder;

const entries = (ids: string[], buckets: Bucket[]): RankedEntry[] =>
  ids.map(
    (id, i) =>
      ({
        mediaItemId: id,
        title: `Title ${id}`,
        position: i + 1,
        bucket: buckets[i],
        category: 'movies',
      }) as unknown as RankedEntry,
  );

describe('screenBlock: only Watched, in Rating highest first, with no filters, is a ladder', () => {
  const ok = { segment: 'watched' as const, sort: { axis: 'rating' as const, direction: 'desc' as const }, filters: emptyFilters(), pool: 'movies' as const };

  it('allows the ranking order', () => {
    expect(screenBlock(ok)).toBeNull();
  });

  it.each([
    ['segment', { segment: 'watchlist' as const }],
    ['segment', { segment: 'unranked' as const }],
    ['tv-wall', { pool: null }],
    ['sort', { sort: { axis: 'rating' as const, direction: 'asc' as const } }],
    ['sort', { sort: { axis: 'year' as const, direction: 'desc' as const } }],
    ['sort', { sort: { axis: 'shuffle' as const, direction: 'desc' as const } }],
    ['filters', { filters: { ...emptyFilters(), genres: ['Drama'] } }],
    ['filters', { filters: { ...emptyFilters(), buckets: ['loved'] } }],
  ])('blocks %s', (block, change) => {
    expect(screenBlock({ ...ok, ...change } as Parameters<typeof screenBlock>[0])).toBe(block);
  });
});

describe('ladderOf: the visible rows as positions 1..n of one pool, or nothing', () => {
  it('reads the ranked rows and stops at the unranked tail', () => {
    expect(ladder.rungs.map((r) => r.mediaItemId)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(ladder.rungs.map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('refuses a gap (a filtered screen would have one)', () => {
    expect(ladderOf([item('a', 1, 'loved'), item('c', 3, 'loved')], 'movies')).toBeNull();
  });

  it('refuses rows out of order (another sort)', () => {
    expect(ladderOf([item('b', 2, 'loved'), item('a', 1, 'loved')], 'movies')).toBeNull();
  });

  it('refuses a ranked row after an unranked one', () => {
    expect(ladderOf([item('a', 1, 'loved'), item('u', null, null), item('b', 2, 'loved')], 'movies')).toBeNull();
  });

  it('refuses a row from another pool: ordinals are never compared across pools', () => {
    expect(
      ladderOf([item('a', 1, 'loved'), item('s', 2, 'loved', { category: 'tv_seasons' })], 'movies'),
    ).toBeNull();
  });

  it('refuses a series poster carrying a season average, which is no ranking at all', () => {
    const average = item('show', 1, 'loved', {
      kind: 'series',
      category: 'tv_shows',
      showScore: { sumTenths: 87, n: 1, source: 'average', rankedSeasonCount: 2 },
    });
    expect(ladderOf([average], 'tv_shows')).toBeNull();
  });

  it('reads an explicit show ranking in the shows pool', () => {
    const show = item('show', 1, 'loved', { kind: 'series', category: 'tv_shows' });
    expect(ladderOf([show], 'tv_shows')?.rungs).toHaveLength(1);
  });
});

describe('bandRange', () => {
  it('finds each band', () => {
    expect(bandRange(ladder, 0)).toEqual({ lo: 0, hi: 2 });
    expect(bandRange(ladder, 2)).toEqual({ lo: 0, hi: 2 });
    expect(bandRange(ladder, 3)).toEqual({ lo: 3, hi: 4 });
    expect(bandRange(ladder, 6)).toEqual({ lo: 5, hi: 6 });
  });
});

describe('planMove', () => {
  it('moves up inside the band, anchored on the title at the target', () => {
    expect(planMove(ladder, 2, 0)).toEqual({
      kind: 'move',
      category: 'movies',
      mediaItemId: 'c',
      title: 'Title c',
      bucket: 'loved',
      toBucket: 'loved',
      fromPosition: 3,
      toPosition: 1,
      anchorId: 'a',
    });
  });

  it('moves down inside the band', () => {
    expect(planMove(ladder, 0, 2)).toMatchObject({ kind: 'move', fromPosition: 1, toPosition: 3, anchorId: 'c' });
  });

  it('an adjacent move swaps two neighbours', () => {
    expect(planMove(ladder, 3, 4)).toMatchObject({ kind: 'move', fromPosition: 4, toPosition: 5, anchorId: 'e' });
  });

  it('a drop where it started is a no-op, and nothing is sent', () => {
    expect(planMove(ladder, 1, 1)).toEqual({ kind: 'noop' });
  });

  /**
   * **Across a category** (founder, 2026-11-19). A drop takes the place of the title it
   * displaces and joins that title's category, either way and at any distance.
   */
  it('a drop among another category joins it, either way, at any distance', () => {
    // c (I liked it) onto d, the first It was fine: it is It was fine, at 4.
    expect(planMove(ladder, 2, 3)).toMatchObject({
      kind: 'move',
      bucket: 'loved',
      toBucket: 'fine',
      fromPosition: 3,
      toPosition: 4,
      anchorId: 'd',
    });
    // d (It was fine) onto c, the last I liked it: it is I liked it, at 3.
    expect(planMove(ladder, 3, 2)).toMatchObject({ toBucket: 'loved', toPosition: 3, anchorId: 'c' });
    // a, the best title, onto g, the worst: I didn't like it, last.
    expect(planMove(ladder, 0, 6)).toMatchObject({ toBucket: 'not_for_me', toPosition: 7, anchorId: 'g' });
    // g, the worst, onto a: I liked it, first.
    expect(planMove(ladder, 6, 0)).toMatchObject({ toBucket: 'loved', toPosition: 1, anchorId: 'a' });
    const move = planMove(ladder, 2, 3);
    if (move?.kind !== 'move') throw new Error('expected a move');
    expect(crosses(move)).toBe(true);
    expect(crosses(planMove(ladder, 0, 2) as Extract<typeof move, { kind: 'move' }>)).toBe(false);
  });

  it('landingBucket is the displaced title’s category, and its own where it started', () => {
    expect(landingBucket(ladder, 0, 0)).toBe('loved');
    expect(landingBucket(ladder, 0, 2)).toBe('loved');
    expect(landingBucket(ladder, 0, 3)).toBe('fine');
    expect(landingBucket(ladder, 6, 4)).toBe('fine');
    expect(landingBucket(ladder, 6, 99)).toBe('not_for_me');
  });

  it('a named category at the line moves the category without moving the title', () => {
    // c is the last I liked it; naming It was fine at its own place makes it the first.
    expect(planMove(ladder, 2, 2, 'fine')).toMatchObject({
      kind: 'move',
      bucket: 'loved',
      toBucket: 'fine',
      fromPosition: 3,
      toPosition: 3,
      anchorId: 'c',
    });
    // Its own category at its own place is still nothing.
    expect(planMove(ladder, 2, 2, 'loved')).toEqual({ kind: 'noop' });
  });

  it('a named category that is not a place there plans nothing', () => {
    // b is in the middle of I liked it: It was fine is not a place between a and c.
    expect(planMove(ladder, 1, 1, 'fine')).toBeNull();
    // A jump of two categories in place, past It was fine's titles, is not a place either.
    expect(planMove(ladder, 2, 2, 'not_for_me')).toBeNull();
    // Onto e (It was fine) but naming I liked it: d is above it, so not a place.
    expect(planMove(ladder, 0, 4, 'loved')).toBeNull();
  });

  it('the planned score across a category is the projection of the new place', () => {
    const move = planMove(ladder, 0, 4);
    if (move?.kind !== 'move') throw new Error('expected a move');
    // It was fine becomes three titles (d, e, a), with a at 5 = third of them.
    expect(scoreAfter(ladder, move)).toBe(scoreFor('fine', 5, { loved: 2, fine: 3, not_for_me: 2 }));
  });

  it('a drop past the end of the ladder clamps to its last rung, never onto an unranked title', () => {
    expect(planMove(ladder, 5, 99)).toMatchObject({ kind: 'move', toPosition: 7, anchorId: 'g' });
    expect(planMove(ladder, 6, 99)).toEqual({ kind: 'noop' });
  });

  it('a source that is not a rung plans nothing', () => {
    expect(planMove(ladder, 7, 0)).toBeNull();
    expect(planMove(ladder, -1, 0)).toBeNull();
  });

  it('the planned score is the projection every screen draws', () => {
    const move = planMove(ladder, 2, 0);
    if (move?.kind !== 'move') throw new Error('expected a move');
    expect(scoreAfter(ladder, move)).toBe(scoreFor('loved', 1, bandSizes(ladder.rungs)));
  });
});

describe('applyMove: the server shift, on a cached pool', () => {
  const pool = entries(['a', 'b', 'c', 'd', 'e'], ['loved', 'loved', 'loved', 'fine', 'fine']);
  const order = (list: RankedEntry[] | null) =>
    [...(list ?? [])].sort((x, y) => x.position - y.position).map((e) => e.mediaItemId);

  it('up: the ones between shift down', () => {
    expect(order(applyMove(pool, 'c', 1))).toEqual(['c', 'a', 'b', 'd', 'e']);
  });

  it('down: the ones between shift up', () => {
    expect(order(applyMove(pool, 'a', 3))).toEqual(['b', 'c', 'a', 'd', 'e']);
  });

  it('keeps positions 1..n, unique, and leaves the other band alone', () => {
    const after = applyMove(pool, 'c', 1) as RankedEntry[];
    expect(after.map((e) => e.position).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(after.filter((e) => e.bucket === 'fine')).toEqual(pool.filter((e) => e.bucket === 'fine'));
  });

  it('a no-op and an unknown title change nothing', () => {
    expect(order(applyMove(pool, 'b', 2))).toEqual(order(pool));
    expect(applyMove(pool, 'zzz', 1)).toBeNull();
  });

  it('every derived score in the band reflows, and band sizes do not change', () => {
    const after = applyMove(pool, 'c', 1) as RankedEntry[];
    const sizes = bandSizes(after);
    expect(sizes).toEqual(bandSizes(pool));
    const scoreOf = (id: string) => {
      const e = after.find((x) => x.mediaItemId === id) as RankedEntry;
      return scoreFor(e.bucket, e.position, sizes);
    };
    expect(scoreOf('c')).toBe(10);
    expect(scoreOf('b')).toBe(7);
  });
});

describe('undoOf: the reverse move, as an ordinary guarded move', () => {
  it('goes back to where it was, anchored on whoever holds that position now', () => {
    const pool = entries(['a', 'b', 'c', 'd'], ['loved', 'loved', 'loved', 'loved']);
    const move = planMove(ladderOf(pool.map((e) => item(e.mediaItemId, e.position, e.bucket)), 'movies') as Ladder, 3, 0);
    if (move?.kind !== 'move') throw new Error('expected a move');
    const after = applyMove(pool, move.mediaItemId, move.toPosition) as RankedEntry[];
    const back = undoOf(after, move);
    expect(back).toMatchObject({ mediaItemId: 'd', fromPosition: 1, toPosition: 4, anchorId: 'c' });
    const restored = applyMove(after, 'd', 4) as RankedEntry[];
    expect(restored.sort((x, y) => x.position - y.position).map((e) => e.mediaItemId)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('across a category, goes back to the category it came from, not the anchor’s', () => {
    // a b c | d e : c down onto d is It was fine at 4; undo is I liked it at 3.
    const pool = entries(['a', 'b', 'c', 'd', 'e'], ['loved', 'loved', 'loved', 'fine', 'fine']);
    const lad = ladderOf(pool.map((e) => item(e.mediaItemId, e.position, e.bucket)), 'movies') as Ladder;
    const move = planMove(lad, 2, 3);
    if (move?.kind !== 'move') throw new Error('expected a move');
    const after = applyMove(pool, move.mediaItemId, move.toPosition, move.toBucket) as RankedEntry[];
    expect(after.find((e) => e.mediaItemId === 'c')).toMatchObject({ position: 4, bucket: 'fine' });
    const back = undoOf(after, move);
    // d is at 3 now, and it is It was fine: the undo still names I liked it.
    expect(back).toMatchObject({
      mediaItemId: 'c',
      bucket: 'fine',
      toBucket: 'loved',
      fromPosition: 4,
      toPosition: 3,
      anchorId: 'd',
    });
    const restored = applyMove(after, 'c', 3, 'loved') as RankedEntry[];
    expect(
      restored.sort((x, y) => x.position - y.position).map((e) => [e.mediaItemId, e.bucket]),
    ).toEqual(pool.map((e) => [e.mediaItemId, e.bucket]));
  });
});

describe('applyMove across a category', () => {
  it('changes the moved title’s category only, and keeps positions 1..n', () => {
    const pool = entries(['a', 'b', 'c', 'd'], ['loved', 'loved', 'fine', 'fine']);
    const after = applyMove(pool, 'a', 3, 'fine') as RankedEntry[];
    const sorted = [...after].sort((x, y) => x.position - y.position);
    expect(sorted.map((e) => [e.mediaItemId, e.bucket])).toEqual([
      ['b', 'loved'],
      ['c', 'fine'],
      ['a', 'fine'],
      ['d', 'fine'],
    ]);
    expect(bandSizes(after)).toEqual({ loved: 1, fine: 3, not_for_me: 0 });
  });

  it('a change of category at the same place keeps every position', () => {
    const pool = entries(['a', 'b', 'c'], ['loved', 'loved', 'fine']);
    const after = applyMove(pool, 'b', 2, 'fine') as RankedEntry[];
    expect(after.map((e) => [e.mediaItemId, e.position, e.bucket])).toEqual([
      ['a', 1, 'loved'],
      ['b', 2, 'fine'],
      ['c', 3, 'fine'],
    ]);
  });
});

describe('moveActions: the accessible equivalent of a drag', () => {
  const spoken = (index: number, lad: Ladder = ladder) =>
    moveActions(lad, index).map((a) => [a.name, a.label, a.to, a.toBucket]);

  it('offers one step and the group ends inside a group', () => {
    expect(spoken(1)).toEqual([
      ['moveUp', 'Move up', 0, 'loved'],
      ['moveDown', 'Move down', 2, 'loved'],
    ]);
    expect(spoken(0)).toEqual([
      ['moveDown', 'Move down', 1, 'loved'],
      ['moveToBottom', 'Move to bottom of its group', 2, 'loved'],
    ]);
  });

  it('at a group’s edge, one step is the line into the next category', () => {
    expect(spoken(2)).toEqual([
      ['moveUp', 'Move up', 1, 'loved'],
      ['moveDown', 'Move down into It was fine', 2, 'fine'],
      ['moveToTop', 'Move to top of its group', 0, 'loved'],
    ]);
    expect(spoken(3)).toEqual([
      ['moveUp', 'Move up into I liked it', 3, 'loved'],
      ['moveDown', 'Move down', 4, 'fine'],
    ]);
    // The best title cannot go up and the worst cannot go down.
    expect(spoken(6)).toEqual([['moveUp', 'Move up', 5, 'not_for_me']]);
    // Every action is a move the planner accepts.
    for (let i = 0; i < 7; i += 1) {
      for (const action of moveActions(ladder, i)) {
        expect(planMove(ladder, i, action.to, action.toBucket)).toMatchObject({ kind: 'move' });
      }
    }
  });

  it('crosses an empty category one step at a time', () => {
    const gap = ladderOf([item('a', 1, 'loved'), item('b', 2, 'not_for_me')], 'movies') as Ladder;
    expect(spoken(1, gap)).toEqual([['moveUp', 'Move up into It was fine', 1, 'fine']]);
    expect(spoken(0, gap)).toEqual([['moveDown', 'Move down into It was fine', 0, 'fine']]);
  });

  it('offers nothing for a row that is not a rung', () => {
    expect(moveActions(ladder, 7)).toEqual([]);
  });
});

describe('a large collection', () => {
  it('reads, plans and applies a move across 2,000 titles quickly', () => {
    const buckets: Bucket[] = ['loved', 'fine', 'not_for_me'];
    const wall = Array.from({ length: 2000 }, (_, i) =>
      item(`t${i}`, i + 1, buckets[Math.floor((i * 3) / 2000)] as Bucket),
    );
    const pool = wall.map(
      (w) => ({ mediaItemId: w.mediaItemId, position: w.position, bucket: w.bucket }) as unknown as RankedEntry,
    );
    const started = Date.now();
    const big = ladderOf(wall, 'movies') as Ladder;
    const move = planMove(big, 600, 0);
    const after = move?.kind === 'move' ? applyMove(pool, move.mediaItemId, move.toPosition) : null;
    const elapsed = Date.now() - started;
    expect(big.rungs).toHaveLength(2000);
    expect(move).toMatchObject({ kind: 'move', fromPosition: 601, toPosition: 1 });
    expect(after?.find((e) => e.mediaItemId === 't600')?.position).toBe(1);
    expect(elapsed).toBeLessThan(200);
  });
});

describe('what the reader is told', () => {
  it('names the title, the new rank and the new score, with Undo', () => {
    expect(notices.moved('Heat', 4, 9.6)).toEqual({
      message: 'Moved “Heat” to #4 · 9.6',
      action: { kind: 'undo', label: 'Undo' },
      tone: 'info',
    });
  });

  it('a move across a category names the new category, the rank and the score, with Undo', () => {
    expect(notices.moved('Heat', 14, 4.6, 'fine')).toEqual({
      message: 'Moved “Heat” to It was fine · #14 · 4.6',
      action: { kind: 'undo', label: 'Undo' },
      tone: 'info',
    });
    expect(notices.undone('Heat', 3, 'loved').message).toBe('Moved “Heat” back to I liked it · #3');
  });

  it('a place the server refused says the list was refreshed, and never points at Rerank', () => {
    const notice = notices.outside('Heat');
    expect(notice.message).toContain('Heat');
    expect(notice.message).not.toContain('Rerank');
    expect(notice.message).not.toContain('within that group');
    expect(notice.tone).toBe('error');
  });

  it('a blocked long-press offers the way to an eligible view', () => {
    expect(notices.blocked('sort', { mediaItemId: 'x', title: 'Heat' })?.action?.kind).toBe('sortByRating');
    expect(notices.blocked('filters', { mediaItemId: 'x', title: 'Heat' })?.action?.kind).toBe('sortByRating');
    expect(notices.blocked('tv-wall', { mediaItemId: 'x', title: 'Heat' })?.action?.kind).toBe('reorderTv');
    expect(notices.blocked('unranked', { mediaItemId: 'x', title: 'Heat' })?.action?.kind).toBe('openTitle');
    expect(notices.blocked('segment', { mediaItemId: 'x', title: 'Heat' })).toBeNull();
  });

  it('a failure offers Retry and is an error, which does not fade', () => {
    expect(notices.failed('Heat')).toMatchObject({ action: { kind: 'retry' }, tone: 'error' });
    expect(notices.stale().tone).toBe('error');
  });
});
