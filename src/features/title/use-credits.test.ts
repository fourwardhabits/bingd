import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { useCredits } from './use-credits';

/**
 * What a title page's credits read sends (reliability review, 2026-11-20).
 *
 * The hook used to open with `media_cache.select('*', { count: 'exact', head: true })` and no
 * filter: an exact count of every cached facet of every title, on every title page, before
 * the one row it needed. It changed nothing, because an empty cache already answers the
 * filtered read with no row. On production it was 4,853 calls at 85 ms each (max 7 s), and
 * it grows with the cache. These tests pin the one request that is left, and that the empty
 * and missing answers are unchanged.
 */

type Call = { table: string; select: string; options?: unknown; filters: [string, unknown][] };

const mockCalls: Call[] = [];
let mockRow: { payload: unknown } | null = null;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const call: Call = { table, select: '', filters: [] };
      mockCalls.push(call);
      const builder = {
        select: (columns: string, options?: unknown) => {
          call.select = columns;
          call.options = options;
          return builder;
        },
        eq: (column: string, value: unknown) => {
          call.filters.push([column, value]);
          return builder;
        },
        maybeSingle: () => Promise.resolve({ data: mockRow, error: null }),
        // A count read would await the builder itself.
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, count: 1, error: null }).then(resolve),
      };
      return builder;
    },
  },
  startSessionRefresh: () => () => {},
}));

beforeEach(() => {
  mockCalls.length = 0;
  mockRow = null;
});

describe('useCredits', () => {
  it('sends one filtered read of the credits facet, and no count of the whole cache', async () => {
    mockRow = {
      payload: {
        cast: [{ id: 1, name: 'Ada', character: 'Lead', profile_path: null }],
        crew: [{ id: 2, name: 'Bea', job: 'Director', department: 'Directing' }],
      },
    };
    const { result } = await renderHookWithProviders(() => useCredits('film-1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockCalls).toEqual([
      {
        table: 'media_cache',
        select: 'payload',
        options: undefined,
        filters: [
          ['media_item_id', 'film-1'],
          ['facet', 'credits'],
        ],
      },
    ]);
    expect(result.current.data).toEqual({
      cast: [{ id: '1', name: 'Ada', character: 'Lead', profilePath: null }],
      director: 'Bea',
      directors: ['Bea'],
      showrunner: null,
    });
  });

  it('answers null when the title has no credits row, as an empty cache always did', async () => {
    mockRow = null;
    const { result } = await renderHookWithProviders(() => useCredits('film-1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(mockCalls).toHaveLength(1);
  });

  it('sends nothing without a title', async () => {
    await renderHookWithProviders(() => useCredits(null));
    expect(mockCalls).toHaveLength(0);
  });
});
