import { renderWithProviders } from '@/test-utils/render';

import { rankingPresentationOf, rankingStateOf, resumeSubject } from './ranking-state';
import { TitleRowActions } from './TitleRowActions';
import { watchedItems } from './watched-rows';
import type { LoggedEntry } from './use-collection';

/**
 * **Three internal states, two on screen** (founder, final UI simplification 2026-09-21):
 *
 *   ranked      a completed placement           → the personal score
 *   unfinished  a bucket chosen in bingd, never  → the ordinary unranked treatment,
 *               placed (comparisons abandoned)     whose tap resumes the session
 *   unranked    nothing yet — including an      → the ordinary unranked treatment
 *               imported title, whose Letterboxd
 *               star is never a bucket
 *
 * Search, Collection, list rows and the title page each have their own suite; this file
 * pins the shared definition and the compact row's four cases.
 */
describe('rankingStateOf', () => {
  it('keeps the three internal states distinct', () => {
    expect(rankingStateOf({ ranked: true, bucket: 'fine' })).toBe('ranked');
    expect(rankingStateOf({ ranked: true, bucket: null })).toBe('ranked');
    expect(rankingStateOf({ ranked: false, bucket: 'loved' })).toBe('unfinished');
    expect(rankingStateOf({ ranked: false, bucket: null })).toBe('unranked');
    expect(rankingStateOf({ ranked: false, bucket: undefined })).toBe('unranked');
  });

  it('collapses them to two for the screen', () => {
    expect(rankingPresentationOf('ranked')).toBe('ranked');
    expect(rankingPresentationOf('unfinished')).toBe('unranked');
    expect(rankingPresentationOf('unranked')).toBe('unranked');
  });
});

describe('resumeSubject', () => {
  const title = { id: 'm1', title: 'Heat', year: 1995, posterUri: null, kind: 'movie' as const };

  it('goes back into the bucket already chosen, as a first placement', () => {
    expect(resumeSubject(title, 'not_for_me')).toEqual({
      id: 'm1',
      title: 'Heat',
      bucket: 'notForMe',
      posterUri: null,
      kind: 'movie',
      mode: 'start',
    });
  });

  it('refuses a bucket it does not know', () => {
    expect(resumeSubject(title, 'nonsense')).toBeNull();
  });
});

const entry = (id: string, bucket: LoggedEntry['bucket']): LoggedEntry => ({
  mediaItemId: id,
  title: id,
  year: 2020,
  posterPath: null,
  genres: [],
  runtimeMinutes: 100,
  kind: 'movie',
  seriesTitle: null,
  language: 'en',
  bucket,
  watchedOn: null,
  addedAt: null,
});

describe('Collection rows carry the internal state', () => {
  it('marks a bucketed, unplaced title unfinished and an untouched import unranked', () => {
    const items = watchedItems([], [entry('abandoned', 'fine'), entry('imported', null)], 'movies');
    const byId = new Map(items.map((item) => [item.mediaItemId, item]));
    expect(byId.get('abandoned')).toMatchObject({ score: null, unfinished: true });
    expect(byId.get('imported')).toMatchObject({ score: null, unfinished: false });
  });
});

/**
 * The row takes only a score: the caller never tells it whether a title is untouched,
 * imported or unfinished, so it cannot draw them differently. The three unranked cases
 * are the same props, which is the point.
 */
const row = (score: { score: number; bucket: 'loved' } | null) =>
  renderWithProviders(
    <TitleRowActions
      name="Heat"
      kind="movie"
      score={score}
      saved={false}
      onRank={() => {}}
      onToggleWatchlist={() => {}}
    />,
  );

describe('the compact row is ranked or not', () => {
  it.each([
    ['untouched', null],
    ['watched or imported, never ranked', null],
    ['an unfinished native placement', null],
  ])('%s: the ordinary +', async (_case, score) => {
    const view = await row(score);
    view.getByLabelText('Log Heat');
    view.getByLabelText('Add Heat to Watchlist');
    expect(view.queryByLabelText('Not ranked. Rank this title.')).toBeNull();
    expect(view.queryByLabelText(/Finish ranking|Ranking not finished/)).toBeNull();
    expect(view.queryByLabelText(/out of 10/)).toBeNull();
  });

  it('ranked: the score, and nothing else', async () => {
    const view = await row({ score: 8.4, bucket: 'loved' });
    view.getByLabelText(/^8\.4 out of 10/);
    expect(view.queryByLabelText('Log Heat')).toBeNull();
    expect(view.queryByLabelText('Add Heat to Watchlist')).toBeNull();
  });
});
