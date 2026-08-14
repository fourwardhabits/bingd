import { act, renderHook, waitFor } from '@testing-library/react-native';

import { useDebounced, useSeasons, useTitleSearch, yearOf } from './use-title-search';

const mockRpc = jest.fn();
const mockSeasons = jest.fn();

type Read = { columns: string; filters: Record<string, unknown>; order: string[] };
// Prefixed so jest allows the mock factory below to reach it.
let mockRead: Read;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => {
      const chain = {
        select: (columns: string) => {
          mockRead.columns = columns;
          return chain;
        },
        eq: (column: string, value: unknown) => {
          mockRead.filters[column] = value;
          return chain;
        },
        order: (column: string) => {
          mockRead.order.push(column);
          return mockSeasons();
        },
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

// The hook under test is the debounce and the enabling rule. React Query is replaced by a
// thin stand-in so neither a QueryClientProvider nor its retry timers stand between the
// assertion and what was actually sent to the server.
jest.mock('@tanstack/react-query', () => {
  const { useEffect, useState } = jest.requireActual('react');
  return {
    keepPreviousData: 'keepPreviousData',
    useQuery: ({ queryKey, queryFn, enabled }: any) => {
      const [data, setData] = useState(undefined);
      useEffect(() => {
        if (!enabled) return undefined;
        let live = true;
        void Promise.resolve(queryFn()).then((value: unknown) => {
          if (live) setData(value);
        });
        return () => {
          live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [JSON.stringify(queryKey), enabled]);
      return { data, isPending: data === undefined && enabled, isError: false };
    },
  };
});

beforeEach(() => {
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ data: [], error: null });
  mockRead = { columns: '', filters: {}, order: [] };
  mockSeasons.mockReset();
  mockSeasons.mockResolvedValue({ data: [], error: null });
});

describe('useDebounced', () => {
  it('settles on the last value rather than on every one along the way', async () => {
    const { result, rerender } = await renderHook<string, { value: string }>(
      ({ value }) => useDebounced(value, 400),
      { initialProps: { value: 'i' } },
    );

    await rerender({ value: 'in' });
    await rerender({ value: 'ince' });
    await rerender({ value: 'incep' });

    // Still the first value: a fast typist must not produce five requests.
    expect(result.current).toBe('i');

    await waitFor(() => expect(result.current).toBe('incep'));
  });
});

/**
 * A real wait, not `waitFor`.
 *
 * `waitFor` returns the moment its callback passes, which for "nothing has happened yet" is
 * immediately — before any debounce could have fired. Both tests below are about something
 * *not* happening within a window, so the window has to actually elapse.
 */
const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

describe('useTitleSearch', () => {
  it('does not search until there are two characters to search with', async () => {
    const { result, rerender } = await renderHook<
      ReturnType<typeof useTitleSearch>,
      { q: string }
    >(({ q }) => useTitleSearch(q), { initialProps: { q: '' } });

    expect(result.current.idle).toBe(true);

    await rerender({ q: 'i' });
    await wait(400);

    // Well past the debounce, so a floor of one would have searched by now.
    expect(result.current.idle).toBe(true);
    expect(mockRpc).not.toHaveBeenCalled();

    await rerender({ q: 'in' });
    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    expect(result.current.idle).toBe(false);
  });

  it('holds a keystroke back long enough to be worth batching', async () => {
    // The floor above only proves that one character does not search. This proves the
    // second character does not search *immediately*: with no debounce a fast typist sends
    // one request per keystroke, which is the cost this hook exists to avoid.
    const { rerender } = await renderHook<ReturnType<typeof useTitleSearch>, { q: string }>(
      ({ q }) => useTitleSearch(q),
      { initialProps: { q: '' } },
    );

    await rerender({ q: 'in' });
    await wait(60);
    expect(mockRpc).not.toHaveBeenCalled();

    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
  });

  it('trims before searching, so a trailing space is not a second query', async () => {
    await renderHook(() => useTitleSearch('  inception  '));

    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    expect(mockRpc).toHaveBeenCalledWith('search_titles', {
      p_query: 'inception',
      p_limit: 25,
    });
  });

  it('returns an array even before the first answer arrives', async () => {
    // The list renders straight off this. Undefined here is a crash in FlashList rather
    // than an empty state.
    const { result } = await renderHook(() => useTitleSearch('inception'));
    expect(Array.isArray(result.current.results)).toBe(true);
  });

  it('asks for the results it can show and no more', async () => {
    await renderHook(() => useTitleSearch('inception'));
    await waitFor(() => expect(mockRpc).toHaveBeenCalled());

    // The server caps at 50 regardless; asking for 25 keeps the payload to what a person
    // will actually scroll through before retyping.
    expect(mockRpc.mock.calls[0][1].p_limit).toBe(25);
  });
});

describe('useSeasons', () => {
  it('reads the seasons of one series, in season order', async () => {
    // Without kind = 'season' this returns the series itself alongside its seasons, and the
    // picker offers the user something the database will refuse to log (AD-1). Without the
    // ordering, seasons appear in whatever order the planner chose.
    await renderHook(() => useSeasons('series-1'));

    await waitFor(() => expect(mockSeasons).toHaveBeenCalled());
    expect(mockRead.filters).toEqual({ parent_id: 'series-1', kind: 'season' });
    expect(mockRead.order).toEqual(['season_number']);
  });

  it('carries the poster, so a season is not always a placeholder', async () => {
    await renderHook(() => useSeasons('series-1'));

    await waitFor(() => expect(mockSeasons).toHaveBeenCalled());
    expect(mockRead.columns).toMatch(/poster_path/);
  });

  it('asks for nothing until there is a series', async () => {
    await renderHook(() => useSeasons(null));
    expect(mockSeasons).not.toHaveBeenCalled();
  });
});

describe('yearOf', () => {
  it('takes the year from a date and nothing from null', () => {
    expect(yearOf('2010-07-08')).toBe(2010);
    expect(yearOf(null)).toBeNull();
  });
});
