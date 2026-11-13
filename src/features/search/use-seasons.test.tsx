import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { createQueryClient } from '@/lib/query';

import { useSeasons } from './use-title-search';

/**
 * `useSeasons` with no series, against the app's own client (2026-11-12).
 *
 * The app's client, not the test helper's: it retries twice (`retry: 2`), and the defect
 * was a refetch that ran with `seriesId === null`, sent `parent_id=eq.null`, was refused by
 * Postgres (22P02) and then retried — holding a season or movie page's pull-to-refresh
 * spinner for about three seconds. In React Query v5 `refetch()` ignores `enabled`, so only
 * a `skipToken` queryFn keeps that request from being made.
 */

const mockFrom = jest.fn();
const mockEq = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      mockFrom(table);
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          mockEq(column, value);
          return chain;
        },
        order: () => Promise.resolve({ data: [], error: null }),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

const wrapper = () => {
  const client = createQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, Wrapper };
};

let consoleError: jest.SpyInstance;

beforeEach(() => {
  mockFrom.mockReset();
  mockEq.mockReset();
  // React Query logs "Attempted to invoke queryFn when set to skipToken" in development
  // when a skipToken query is refetched; the page never does that (it refetches seasons
  // only on a whole-show page), but this hook-level test does it deliberately.
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('useSeasons with no series', () => {
  it('sends no request when refetched, rather than asking for parent_id = null', async () => {
    const { client, Wrapper } = wrapper();
    const { result } = await renderHook(() => useSeasons(null), { wrapper: Wrapper });

    await act(async () => {
      // Not awaited for its outcome: on a skipToken query it settles as an error, after
      // the client's own retries. What matters is that nothing reached the server.
      void result.current.refetch().catch(() => undefined);
    });

    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockEq).not.toHaveBeenCalledWith('parent_id', null);
    client.clear();
  });

  it('still reads the seasons of a series', async () => {
    const { client, Wrapper } = wrapper();
    const { result } = await renderHook(() => useSeasons('series-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockFrom).toHaveBeenCalledWith('media_items');
    expect(mockEq).toHaveBeenCalledWith('parent_id', 'series-1');

    mockFrom.mockClear();
    await act(async () => {
      await result.current.refetch();
    });
    expect(mockFrom).toHaveBeenCalledTimes(1);
    client.clear();
  });
});
