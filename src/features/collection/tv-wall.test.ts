import { COLLECTION_SORT_AXES, type CollectionItem } from './filters';
import type { Bucket } from './score';
import { landingIndex, planTvMove, tvMoveActions, tvWallOf, type TvWall } from './tv-wall';

/**
 * #319: the TV wall dragged directly. A drop is read against the explicit shows around it;
 * an average poster is promoted at that place. Mixed scores, both kinds, every edge.
 */

const RATING = { axis: COLLECTION_SORT_AXES.rating.axis, direction: 'desc' as const };

const explicit = (
  id: string,
  position: number,
  bucket: Bucket,
  score: number,
): CollectionItem => ({
  mediaItemId: id,
  title: id,
  seriesTitle: null,
  kind: 'series',
  year: 2020,
  posterPath: null,
  genres: [],
  language: 'en',
  runtimeMinutes: null,
  score,
  position,
  category: 'tv_shows',
  bucket,
  watchedOn: null,
  addedAt: null,
  showScore: {
    sumTenths: Math.round(score * 10),
    n: 1,
    source: 'explicit',
    rankedSeasonCount: 0,
  },
});

const average = (id: string, score: number, tie: number): CollectionItem => ({
  ...explicit(id, tie, 'loved', score),
  bucket: null,
  showScore: {
    sumTenths: Math.round(score * 10),
    n: 1,
    source: 'average',
    rankedSeasonCount: 2,
  },
});

/**
 * Explicit: E1 (I liked it, #1, 10.0), E2 (I liked it, #2, 7.0), E3 (It was fine, #3, 6.9).
 * Averages: A1 at 9.2, A2 at 5.0. On the wall: E1, A1, E2, E3, A2.
 */
const VISIBLE = [
  explicit('E1', 1, 'loved', 10),
  average('A1', 9.2, 3),
  explicit('E2', 2, 'loved', 7),
  explicit('E3', 3, 'fine', 6.9),
  average('A2', 5, 1),
];
const wall = tvWallOf(VISIBLE) as TvWall;

describe('tvWallOf', () => {
  it('reads the posters in order and the explicit shows as the tv_shows ladder', () => {
    expect(wall.posters.map((p) => [p.mediaItemId, p.explicit, p.bucket])).toEqual([
      ['E1', true, 'loved'],
      ['A1', false, 'loved'],
      ['E2', true, 'loved'],
      ['E3', true, 'fine'],
      ['A2', false, 'fine'],
    ]);
    expect(wall.shows.rungs.map((r) => [r.mediaItemId, r.position])).toEqual([
      ['E1', 1],
      ['E2', 2],
      ['E3', 3],
    ]);
  });

  it('is nothing when the explicit shows are not 1..m in display order', () => {
    expect(tvWallOf([VISIBLE[2]!, VISIBLE[0]!])).toBeNull();
  });

  it('ends at the first unranked poster', () => {
    const unranked = { ...average('U', 0, 0), score: null, showScore: null };
    expect(tvWallOf([...VISIBLE, unranked])?.posters).toHaveLength(5);
    expect(tvWallOf([VISIBLE[0]!, unranked, VISIBLE[2]!])).toBeNull();
  });
});

describe('planTvMove: an average poster is promoted at the drop', () => {
  it('above every explicit show: #1, in the category of the show it displaced', () => {
    expect(planTvMove(wall, 1, 0)).toEqual({
      kind: 'promote',
      category: 'tv_shows',
      mediaItemId: 'A1',
      title: 'A1',
      toBucket: 'loved',
      toPosition: 1,
      anchorId: 'E1',
    });
  });

  it('between two explicit shows: just below the one above', () => {
    expect(planTvMove(wall, 4, 2)).toMatchObject({
      kind: 'promote',
      mediaItemId: 'A2',
      toPosition: 2,
      anchorId: 'E2',
      toBucket: 'loved',
    });
  });

  it('past the last explicit show: m + 1, with no anchor', () => {
    expect(planTvMove(wall, 1, 4)).toMatchObject({
      kind: 'promote',
      mediaItemId: 'A1',
      toPosition: 4,
      anchorId: null,
      toBucket: 'fine',
    });
  });

  it('clamps a category that does not fit between its explicit neighbours', () => {
    // Between E1 and E2, both I liked it: nothing else is a place there.
    expect(planTvMove(wall, 4, 1, 'not_for_me')).toMatchObject({
      toPosition: 2,
      toBucket: 'loved',
    });
  });

  it('never names a season, and never a show it did not drop', () => {
    const plan = planTvMove(wall, 1, 0);
    expect(plan && 'mediaItemId' in plan ? plan.mediaItemId : null).toBe('A1');
  });
});

describe('planTvMove: an explicit show moves among the explicit shows', () => {
  it('onto another explicit show: to its place', () => {
    expect(planTvMove(wall, 0, 2)).toMatchObject({
      kind: 'move',
      mediaItemId: 'E1',
      fromPosition: 1,
      toPosition: 2,
      anchorId: 'E2',
      bucket: 'loved',
      toBucket: 'loved',
    });
  });

  it('up across a category line: recategorised, as on the Movies wall', () => {
    expect(planTvMove(wall, 3, 0)).toMatchObject({
      kind: 'move',
      mediaItemId: 'E3',
      toPosition: 1,
      bucket: 'fine',
      toBucket: 'loved',
    });
  });

  it('past average posters only: nothing to move, and it says so', () => {
    expect(planTvMove(wall, 0, 1)).toEqual({ kind: 'passover', title: 'E1' });
  });

  it('back where it was: a no-op', () => {
    expect(planTvMove(wall, 2, 2)).toEqual({ kind: 'noop' });
  });
});

describe('landingIndex: where the poster is drawn once the wall re-sorts', () => {
  it('a promotion lands among the averages by its new score', () => {
    // A2 at #2 of I liked it (three now): E1 10.0, A2 8.5, E2 7.0. A1's 9.2 stays above it.
    const plan = planTvMove(wall, 4, 2);
    if (plan?.kind !== 'promote') throw new Error('expected a promotion');
    expect(landingIndex(VISIBLE, wall, plan, RATING)).toBe(2);
  });

  it('a move re-scores every explicit show, so it can pass an average it was not dropped on', () => {
    const plan = planTvMove(wall, 0, 2);
    if (plan?.kind !== 'move') throw new Error('expected a move');
    // E2 10.0, then A1 9.2, then E1 7.0.
    expect(landingIndex(VISIBLE, wall, plan, RATING)).toBe(2);
  });
});

describe('tvMoveActions: the same places for a screen reader', () => {
  it('an average poster: rank it here, one show higher, one show lower', () => {
    expect(tvMoveActions(wall, 1).map((a) => [a.name, a.label, a.to])).toEqual([
      ['rankHere', 'Rank as a show here', 1],
      ['moveUp', 'Rank as a show, higher', 0],
      ['moveDown', 'Rank as a show, lower', 2],
    ]);
  });

  it('an explicit show: steps over averages to the next explicit show', () => {
    expect(tvMoveActions(wall, 0).map((a) => [a.name, a.to])).toEqual([['moveDown', 2]]);
  });
});
