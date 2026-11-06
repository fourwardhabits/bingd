import { rankingOf } from '@/test-utils/ranked-standing';

import { isOneRanking, readOneRanking, settleStanding } from './settled-standing';
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

  it('scores a midpoint the way score_for does: 0.85 is 0.9', () => {
    // I didn't like it, 40th of 53: exactly 0.85, which a floating-point copy printed 0.8.
    const settled = settleStanding(
      [title('x', 1, 1, 'not_for_me')],
      rankingOf({ not_for_me: 53 }, { x: 40 }),
    );
    expect(settled[0]!.score).toBe(0.9);
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

/**
 * **A read assembled from pages is checked before it is believed** (independent review, QA
 * corrections). Each page is its own request, so a placement elsewhere between two pages can
 * produce a list no database could hold.
 */
describe('one read, one ranking', () => {
  const row = (position: number, bucket: 'loved' | 'fine' | 'not_for_me') => ({ position, bucket });

  it('accepts positions 1…n once each with the bands in order', () => {
    expect(isOneRanking(rankingOf({ loved: 3, fine: 2, not_for_me: 2 }, {}))).toBe(true);
    expect(isOneRanking([])).toBe(true);
  });

  it('refuses a duplicate, a gap, or bands out of order', () => {
    expect(isOneRanking([row(1, 'loved'), row(1, 'loved'), row(2, 'loved')])).toBe(false);
    expect(isOneRanking([row(1, 'loved'), row(3, 'loved')])).toBe(false);
    expect(isOneRanking([row(1, 'fine'), row(2, 'loved')])).toBe(false);
  });

  it('reads again when a read is torn, and takes the first whole one', async () => {
    const torn = [...rankingOf({ loved: 3 }, {}), ...rankingOf({ loved: 1 }, { dup: 1 })];
    const whole = rankingOf({ loved: 4 }, {});
    const read = jest.fn().mockResolvedValueOnce(torn).mockResolvedValueOnce(whole);
    await expect(readOneRanking(read)).resolves.toBe(whole);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('gives up after three torn reads, so the summary withholds its numbers', async () => {
    const torn = [...rankingOf({ loved: 2 }, {}), ...rankingOf({ loved: 1 }, {})];
    const read = jest.fn().mockResolvedValue(torn);
    await expect(readOneRanking(read)).rejects.toThrow(/changed while it was being read/);
    expect(read).toHaveBeenCalledTimes(3);
  });
});
