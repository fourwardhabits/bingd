import { renderWithProviders } from '@/test-utils/render';

import { rankingStateOf } from './ranking-state';
import { TitleRowActions } from './TitleRowActions';
import { watchedItems } from './watched-rows';
import type { LoggedEntry } from './use-collection';

/**
 * **Three ranking states that must stay distinct** (founder decision, 2026-09-21):
 *
 *   ranked      a completed placement           → the personal score
 *   unfinished  a bucket chosen in bingd, never  → Finish
 *               placed (comparisons abandoned)
 *   unranked    nothing yet — including an      → Rank
 *               imported title, whose Letterboxd
 *               star is never a bucket
 *
 * Search, Collection, list rows and the title page each have their own suite asserting
 * the same three; this file pins the shared definition and the compact row treatment.
 */
describe('rankingStateOf', () => {
  it('distinguishes the three states', () => {
    expect(rankingStateOf({ ranked: true, bucket: 'fine' })).toBe('ranked');
    expect(rankingStateOf({ ranked: true, bucket: null })).toBe('ranked');
    expect(rankingStateOf({ ranked: false, bucket: 'loved' })).toBe('unfinished');
    expect(rankingStateOf({ ranked: false, bucket: null })).toBe('unranked');
    expect(rankingStateOf({ ranked: false, bucket: undefined })).toBe('unranked');
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

describe('Collection rows carry the same state', () => {
  it('marks a bucketed, unplaced title unfinished and an untouched import unranked', () => {
    const items = watchedItems([], [entry('abandoned', 'fine'), entry('imported', null)], 'movies');
    const byId = new Map(items.map((item) => [item.mediaItemId, item]));
    expect(byId.get('abandoned')).toMatchObject({ score: null, unfinished: true });
    expect(byId.get('imported')).toMatchObject({ score: null, unfinished: false });
  });
});

const row = (props: Partial<Parameters<typeof TitleRowActions>[0]>) =>
  renderWithProviders(
    <TitleRowActions
      name="Heat"
      kind="movie"
      score={null}
      watched
      saved={false}
      onRank={() => {}}
      onToggleWatchlist={() => {}}
      {...props}
    />,
  );

describe('the compact row draws three distinct treatments', () => {
  it('ranked: the score', async () => {
    const view = await row({ score: { score: 8.4, bucket: 'loved' } });
    view.getByLabelText(/^8\.4 out of 10/);
    expect(view.queryByTestId('finish-badge', { includeHiddenElements: true })).toBeNull();
  });

  it('unfinished: Finish, never the dashed Rank', async () => {
    const view = await row({ unfinished: true });
    view.getByLabelText('Ranking not finished. Finish ranking this title.');
    expect(view.queryByLabelText('Not ranked. Rank this title.')).toBeNull();
  });

  it('an untouched import: Rank, never Finish', async () => {
    const view = await row({ unfinished: false });
    view.getByLabelText('Not ranked. Rank this title.');
    expect(view.queryByTestId('finish-badge', { includeHiddenElements: true })).toBeNull();
  });
});
