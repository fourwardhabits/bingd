import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { useWatchGoals } from './use-goals';

type Read = {
  table: string;
  columns: string;
  filters: Record<string, unknown>;
  ranges: { op: string; column: string; value: unknown }[];
};

const reads: Read[] = [];
const rows: Record<string, unknown[]> = {};

/**
 * A recorder standing in for PostgREST, the same shape `use-collection.test.ts` uses.
 *
 * What can go wrong in this hook is a filter that is missing rather than data that is
 * wrong: an unscoped read of `watch_goals` looks perfect until there are two accounts,
 * and an unbounded read of `user_media` looks perfect until somebody has a decade of
 * watches in it.
 */
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const read: Read = { table, columns: '', filters: {}, ranges: [] };

      const chain = {
        select: (columns: string) => {
          read.columns = columns;
          reads.push(read);
          return chain;
        },
        eq: (column: string, value: unknown) => {
          read.filters[column] = value;
          return chain;
        },
        gte: (column: string, value: unknown) => {
          read.ranges.push({ op: 'gte', column, value });
          return chain;
        },
        lte: (column: string, value: unknown) => {
          read.ranges.push({ op: 'lte', column, value });
          return chain;
        },
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: rows[table] ?? [], error: null }),
      };

      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

const USER = 'user-1';

const watched = (mediaItemId: string, kind: string, watchedOn: string | null) => ({
  media_item_id: mediaItemId,
  watched_on: watchedOn,
  media_items: { kind },
});

beforeEach(() => {
  reads.length = 0;
  for (const key of Object.keys(rows)) delete rows[key];
});

const readOf = (table: string) => reads.find((read) => read.table === table);

describe('reading a year of goals', () => {
  it('asks only for this account and only for this year', async () => {
    const { result } = await renderHookWithProviders(() => useWatchGoals(USER, 2026));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(readOf('watch_goals')?.filters).toEqual({ user_id: USER, year: 2026 });
    expect(readOf('user_media')?.filters).toEqual({ user_id: USER });
    expect(readOf('user_media')?.ranges).toEqual([
      { op: 'gte', column: 'watched_on', value: '2026-01-01' },
      { op: 'lte', column: 'watched_on', value: '2026-12-31' },
    ]);
  });

  it('joins the media kind rather than assuming it', async () => {
    // `!inner`, so a row whose media item did not come back is absent rather than
    // defaulting to a movie and counting toward a goal it may not belong to.
    const { result } = await renderHookWithProviders(() => useWatchGoals(USER, 2026));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(readOf('user_media')?.columns).toContain('media_items!inner(kind)');
  });

  it('reports a status only for a medium with a goal', async () => {
    rows.watch_goals = [{ category: 'movies', target: 52 }];
    rows.user_media = [
      watched('a', 'movie', '2026-03-01'),
      watched('b', 'season', '2026-04-01'),
    ];

    const { result } = await renderHookWithProviders(() => useWatchGoals(USER, 2026));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The season was watched and is counted, but with no TV goal there is no bar to
    // put it on — and no bar is very different from a bar reading "1 of 0".
    expect(result.current.data?.counts).toEqual({ movies: 1, tv_seasons: 1 });
    expect(result.current.data?.statuses.map((s) => s.category)).toEqual(['movies']);
  });

  it('puts movies first whichever goal was set first', async () => {
    rows.watch_goals = [
      { category: 'tv_seasons', target: 12 },
      { category: 'movies', target: 52 },
    ];

    const { result } = await renderHookWithProviders(() => useWatchGoals(USER, 2026));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.statuses.map((s) => s.category)).toEqual([
      'movies',
      'tv_seasons',
    ]);
  });

  it('does not count a series toward either goal', async () => {
    rows.watch_goals = [
      { category: 'movies', target: 10 },
      { category: 'tv_seasons', target: 10 },
    ];
    rows.user_media = [watched('show', 'series', '2026-05-01')];

    const { result } = await renderHookWithProviders(() => useWatchGoals(USER, 2026));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.counts).toEqual({ movies: 0, tv_seasons: 0 });
  });

  it('re-checks the year itself rather than trusting the range filter', async () => {
    rows.watch_goals = [{ category: 'movies', target: 10 }];
    // A row the query filter should never have returned. If the hook trusted the
    // filter, this would land on the 2026 bar.
    rows.user_media = [watched('old', 'movie', '2019-05-01'), watched('new', 'movie', null)];

    const { result } = await renderHookWithProviders(() => useWatchGoals(USER, 2026));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.counts.movies).toBe(0);
  });
});
