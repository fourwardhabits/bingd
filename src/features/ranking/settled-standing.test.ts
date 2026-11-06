import { rankingOf } from '@/test-utils/ranked-standing';

import { settleStanding } from './settled-standing';
import type { RankedSummaryTitle } from './RankedSummary';

/**
 * The summary's numbers are the ranking as it stands, derived the way the Collection
 * derives them (QA corrections, 2026-11-06). Pure: one read of the category in, each
 * title's place and score out.
 */

const title = (id: string, position: number, score: number, bucket = 'loved') =>
  ({ mediaItemId: id, title: id, position, score, bucket }) satisfies RankedSummaryTitle;

describe('settleStanding', () => {
  it('the QA case: two titles placed at #9 in turn end at #9 and #10, re-scored', () => {
    // Pitch Black landed at #9 of 22 (8.9); Allied then landed at #9 of 23 (also 8.9)
    // and pushed Pitch Black to #10, which in a band of 23 is 8.8.
    const snapshots = [title('pitch-black', 9, 8.9), title('allied', 9, 8.9)];
    const settled = settleStanding(
      snapshots,
      rankingOf({ loved: 23 }, { allied: 9, 'pitch-black': 10 }),
    );
    expect(settled.map((t) => [t.mediaItemId, t.position, t.score])).toEqual([
      ['pitch-black', 10, 8.8],
      ['allied', 9, 8.9],
    ]);
  });

  it('never reports two titles at one position, because the ranking cannot hold that', () => {
    const settled = settleStanding(
      [title('a', 3, 9), title('b', 3, 9), title('c', 3, 9)],
      rankingOf({ loved: 10 }, { c: 3, b: 4, a: 5 }),
    );
    const positions = settled.map((t) => t.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(positions).toEqual([5, 4, 3]);
  });

  it('keeps identical rounded scores at distinct positions: rounding, not a tie', () => {
    // A band of 101 steps 0.03 a place, so #50 (8.53) and #51 (8.50) both print 8.5.
    const settled = settleStanding(
      [title('x', 1, 10), title('y', 1, 10)],
      rankingOf({ loved: 101 }, { x: 50, y: 51 }),
    );
    expect(settled.map((t) => t.score)).toEqual([8.5, 8.5]);
    expect(settled.map((t) => t.position)).toEqual([50, 51]);
  });

  it('an insertion in a band above moves a title without re-scoring it', () => {
    // A title placed into It was fine shifts nothing in I liked it, but a title placed
    // into I liked it shifts every It was fine title down by one and re-scores none of
    // them — their band did not grow — though their position changed.
    const settled = settleStanding(
      [title('heat', 4, 6.2, 'fine')],
      rankingOf({ loved: 3, fine: 6 }, { heat: 5 }),
    );
    expect(settled[0]).toMatchObject({ position: 5, score: 6.2, bucket: 'fine' });
  });

  it('a re-ranked title takes its new band and score from the ranking', () => {
    // Placed as I liked it, then moved by a correction into It was fine.
    const settled = settleStanding(
      [title('ronin', 2, 9.7, 'loved')],
      rankingOf({ loved: 4, fine: 5 }, { ronin: 5 }),
    );
    expect(settled[0]).toMatchObject({ position: 5, score: 6.9, bucket: 'fine' });
  });

  it('a title the ranking no longer holds keeps its row and loses its numbers', () => {
    const settled = settleStanding([title('gone', 2, 9.5)], rankingOf({ loved: 4 }, {}));
    expect(settled[0]).toMatchObject({ mediaItemId: 'gone', position: null, score: null });
  });

  it('keeps the sitting order, poster and title untouched', () => {
    const snapshots = [
      { ...title('b', 1, 10), posterPath: '/b.jpg' },
      { ...title('a', 1, 10), posterPath: '/a.jpg' },
    ];
    const settled = settleStanding(snapshots, rankingOf({ loved: 2 }, { a: 1, b: 2 }));
    expect(settled.map((t) => [t.mediaItemId, t.posterPath])).toEqual([
      ['b', '/b.jpg'],
      ['a', '/a.jpg'],
    ]);
  });
});
