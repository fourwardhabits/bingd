import { QueryClient } from '@tanstack/react-query';

import type { RankedEntry } from '@/features/collection/use-collection';
import { queryKeys } from '@/lib/query';

import { seedPivotCard } from './pivot-card';
import type { SessionStep } from './session';

/**
 * `seedPivotCard` — the opponent's card without a second request.
 *
 * The case that matters is `rank_start`, which returns `pivot` and no `pivot_card`: before
 * this, the first comparison of every session read `media_items` in series with the RPC.
 */

const entry = (over: Partial<RankedEntry> & { mediaItemId: string }): RankedEntry =>
  ({
    title: 'Heat',
    kind: 'movie',
    posterPath: '/heat.jpg',
    seriesTitle: null,
    ...over,
  }) as RankedEntry;

const comparing = (pivotId: string, pivotCard?: unknown): SessionStep =>
  ({
    state: 'comparing',
    sessionId: 'session-1',
    subjectId: 'subject-1',
    pivotId,
    skipped: false,
    ...(pivotCard ? { pivotCard } : {}),
  }) as SessionStep;

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const cardIn = (qc: QueryClient, id: string) => qc.getQueryData(queryKeys.comparisonCard(id));

describe('seedPivotCard', () => {
  it('takes the card the answer carried, which is the server copy', () => {
    const qc = client();
    qc.setQueryData(queryKeys.rankings('user-1', 'movies'), [
      entry({ mediaItemId: 'pivot-1', title: 'From the band' }),
    ]);

    seedPivotCard(qc, 'user-1', comparing('pivot-1', { id: 'pivot-1', kind: 'movie', title: 'From the answer', poster_path: '/a.jpg' }));

    expect(cardIn(qc, 'pivot-1')).toMatchObject({ title: 'From the answer' });
  });

  it('seeds from the reader’s own band when the answer carried none — the rank_start case', () => {
    const qc = client();
    qc.setQueryData(queryKeys.rankings('user-1', 'movies'), [
      entry({ mediaItemId: 'other' }),
      entry({ mediaItemId: 'pivot-1', title: 'Sicario', posterPath: '/sicario.jpg' }),
    ]);

    seedPivotCard(qc, 'user-1', comparing('pivot-1'));

    expect(cardIn(qc, 'pivot-1')).toEqual({
      id: 'pivot-1',
      kind: 'movie',
      title: 'Sicario',
      poster_path: '/sicario.jpg',
    });
  });

  it('finds a season in the television band, and carries its own title', () => {
    const qc = client();
    qc.setQueryData(queryKeys.rankings('user-1', 'tv_seasons'), [
      entry({ mediaItemId: 'season-2', kind: 'season', title: 'Season 2', seriesTitle: 'Severance' }),
    ]);

    seedPivotCard(qc, 'user-1', comparing('season-2'));

    expect(cardIn(qc, 'season-2')).toMatchObject({ kind: 'season', title: 'Season 2' });
  });

  it('leaves the query to read a title the band does not hold', () => {
    const qc = client();
    qc.setQueryData(queryKeys.rankings('user-1', 'movies'), [entry({ mediaItemId: 'other' })]);

    seedPivotCard(qc, 'user-1', comparing('pivot-1'));

    expect(cardIn(qc, 'pivot-1')).toBeUndefined();
  });

  it('never reads another account’s band', () => {
    const qc = client();
    qc.setQueryData(queryKeys.rankings('user-2', 'movies'), [entry({ mediaItemId: 'pivot-1' })]);

    seedPivotCard(qc, 'user-1', comparing('pivot-1'));

    expect(cardIn(qc, 'pivot-1')).toBeUndefined();
  });

  it('does not overwrite a card already in the cache', () => {
    const qc = client();
    qc.setQueryData(queryKeys.comparisonCard('pivot-1'), { id: 'pivot-1', kind: 'movie', title: 'Read already', poster_path: null });
    qc.setQueryData(queryKeys.rankings('user-1', 'movies'), [entry({ mediaItemId: 'pivot-1', title: 'From the band' })]);

    seedPivotCard(qc, 'user-1', comparing('pivot-1'));

    expect(cardIn(qc, 'pivot-1')).toMatchObject({ title: 'Read already' });
  });

  it('survives a cache entry that is not a band at all', () => {
    // `RankingSheet.test.tsx` seeds these keys with a string to watch invalidations, and a
    // cast turned that into a crash on the one path that exists to save a round trip.
    const qc = client();
    qc.setQueryData(queryKeys.rankings('user-1', 'movies'), 'seeded');
    qc.setQueryData(queryKeys.rankings('user-1', 'tv_seasons'), { entries: [] });

    expect(() => seedPivotCard(qc, 'user-1', comparing('pivot-1'))).not.toThrow();
    expect(cardIn(qc, 'pivot-1')).toBeUndefined();
  });

  it('does nothing for a step that is not a comparison', () => {
    const qc = client();
    expect(() =>
      seedPivotCard(qc, 'user-1', { state: 'ended' } as SessionStep),
    ).not.toThrow();
  });
});
