import { emptyFilters, type CollectionItem } from './filters';
import {
  applyMove,
  bandRange,
  ladderOf,
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

  it('a drop across a band boundary is outside, either way, and never a move', () => {
    expect(planMove(ladder, 3, 2)).toMatchObject({ kind: 'outside', direction: 'up' });
    expect(planMove(ladder, 2, 3)).toMatchObject({ kind: 'outside', direction: 'down' });
    expect(planMove(ladder, 0, 6)).toMatchObject({ kind: 'outside', rung: { mediaItemId: 'a', bucket: 'loved' } });
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
});

describe('moveActions: the accessible equivalent of a drag', () => {
  it('offers one step and the band ends, and never crosses a band', () => {
    expect(moveActions(ladder, 1).map((a) => [a.name, a.to])).toEqual([
      ['moveUp', 0],
      ['moveDown', 2],
    ]);
    expect(moveActions(ladder, 0).map((a) => [a.name, a.to])).toEqual([
      ['moveDown', 1],
      ['moveToBottom', 2],
    ]);
    expect(moveActions(ladder, 2).map((a) => [a.name, a.to])).toEqual([
      ['moveUp', 1],
      ['moveToTop', 0],
    ]);
    expect(moveActions(ladder, 3).map((a) => [a.name, a.to])).toEqual([['moveDown', 4]]);
  });

  it('offers nothing for a band of one or a row that is not a rung', () => {
    const single = ladderOf([item('a', 1, 'loved'), item('b', 2, 'fine')], 'movies') as Ladder;
    expect(moveActions(single, 0)).toEqual([]);
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

  it('a refused crossing names the band and points at Rerank', () => {
    const notice = notices.outside({ mediaItemId: 'x', title: 'Heat', bucket: 'loved', position: 1 });
    expect(notice.message).toContain('I liked it');
    expect(notice.message).toContain('Rerank');
    expect(notice.action?.kind).toBe('openTitle');
    expect(notice.mediaItemId).toBe('x');
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
