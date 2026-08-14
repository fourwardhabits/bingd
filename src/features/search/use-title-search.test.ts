import { renderHook, waitFor } from '@testing-library/react-native';

import { useDebounced, useTitleSearch, yearOf } from './use-title-search';

const mockRpc = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
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

describe('useTitleSearch', () => {
  it('does not search until there are two characters to search with', async () => {
    const { result, rerender } = await renderHook<
      ReturnType<typeof useTitleSearch>,
      { q: string }
    >(({ q }) => useTitleSearch(q), { initialProps: { q: '' } });

    expect(result.current.idle).toBe(true);

    await rerender({ q: 'i' });
    expect(result.current.idle).toBe(true);
    expect(mockRpc).not.toHaveBeenCalled();

    await rerender({ q: 'in' });
    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    expect(result.current.idle).toBe(false);
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

describe('yearOf', () => {
  it('takes the year from a date and nothing from null', () => {
    expect(yearOf('2010-07-08')).toBe(2010);
    expect(yearOf(null)).toBeNull();
  });
});
