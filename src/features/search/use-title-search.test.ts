import { act, renderHook, waitFor } from '@testing-library/react-native';

import { AdapterError } from '@/lib/tmdb-adapter';

import { useDebounced, useSeasons, useTitleSearch, yearOf } from './use-title-search';

const mockRpc = jest.fn();
const mockSeasons = jest.fn();
const mockSearchProvider = jest.fn();

// The adapter is the network boundary this hook is allowed to cross, so it is faked
// rather than reached. Its error type has to be a real class: the hook uses
// `instanceof` to tell a rate limit apart from an ordinary failure.
jest.mock('@/lib/tmdb-adapter', () => ({
  searchProvider: (...args: unknown[]) => mockSearchProvider(...args),
  AdapterError: class AdapterError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
    get isRateLimit() {
      return this.code === 'BG429';
    }
  },
}));

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
        // The genre and season-count joins the local pass makes once it has ids.
        // Terminal, like `order`, so it resolves rather than returning the chain.
        in: () => Promise.resolve({ data: [], error: null }),
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
      const [error, setError] = useState(undefined);
      const [fetching, setFetching] = useState(false);
      const [fetched, setFetched] = useState(false);

      useEffect(() => {
        if (!enabled) return undefined;
        let live = true;
        setFetching(true);
        void Promise.resolve(queryFn())
          .then((value: unknown) => {
            if (live) setData(value);
          })
          .catch((cause: unknown) => {
            if (live) setError(cause);
          })
          .finally(() => {
            if (!live) return;
            setFetching(false);
            setFetched(true);
          });
        return () => {
          live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [JSON.stringify(queryKey), enabled]);

      return {
        data,
        error,
        isPending: data === undefined && enabled,
        isError: Boolean(error),
        // Always false here. The real flag marks the previous query's rows standing in
        // for this one's; the stub resolves each queryFn into its own state, so there
        // is no such thing, and reporting true would suppress the provider pass in
        // every test below.
        isPlaceholderData: false,
        isFetching: fetching,
        isFetched: fetched,
      };
    },
  };
});

beforeEach(() => {
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ data: [], error: null });
  mockRead = { columns: '', filters: {}, order: [] };
  mockSeasons.mockReset();
  mockSeasons.mockResolvedValue({ data: [], error: null });
  mockSearchProvider.mockReset();
  mockSearchProvider.mockResolvedValue([]);
});

/** A row as `search_titles` returns it, before the hook joins genres onto it. */
const localRow = (id: string, title: string) => ({
  id,
  kind: 'movie',
  title,
  release_date: '2010-01-01',
  poster_path: null,
  provenance: 'wikidata',
});

/** A row as the adapter returns it: already Bingd-shaped, and already enriched. */
const remoteRow = (id: string, title: string) => ({
  ...localRow(id, title),
  poster_path: '/from-tmdb.jpg',
  provenance: 'tmdb',
  genres: ['Drama'],
  runtime_minutes: 148,
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

/**
 * The second pass, which is the difference between a catalogue that looks small and one
 * that looks broken. The seed is a few hundred Wikidata titles, so most searches miss.
 */
describe('useTitleSearch reaching past the local catalogue', () => {
  /** Past both debounces — the provider's is deliberately the slower of the two. */
  const settle = () => wait(700);

  it('asks the provider when the local catalogue comes back thin', async () => {
    await renderHook(() => useTitleSearch('inception'));
    await settle();

    // Twenty, which is one TMDB page and the adapter's own cap. Asking for twelve
    // fetched a page of twenty and threw eight of it away after paying for them.
    expect(mockSearchProvider).toHaveBeenCalledWith('inception', 20);
  });

  /**
   * The founder's `spiderman` report, as a test.
   *
   * The catalogue held six Spider-Man films and the provider gate let anything with six
   * or more local rows through unasked, so the one title the user was looking for — the
   * newest, most popular entry in the franchise — could not appear at any position.
   * Typing *more* of the name found it, because a narrower query matched nothing locally
   * and was therefore allowed out to TMDB.
   *
   * Deliberately no Spider-Man in this test. The bug is not about that franchise; it is
   * about a row count being treated as evidence that the catalogue had answered, when
   * the catalogue only ever holds what somebody already searched for.
   */
  it('still asks the provider when the local catalogue answered in full', async () => {
    mockRpc.mockResolvedValue({
      data: Array.from({ length: 9 }, (_, i) => localRow(`local-${i}`, `Film ${i}`)),
      error: null,
    });

    await renderHook(() => useTitleSearch('inception'));
    await settle();

    expect(mockSearchProvider).toHaveBeenCalledWith('inception', 20);
  });

  it('waits longer than the local pass before spending a provider request', async () => {
    // Typed rather than mounted with. useDebounced seeds its state with whatever it is
    // first given, so a hook mounted straight onto a full query has nothing to debounce
    // — which never happens on the screen, where input starts empty and grows.
    const { rerender } = await renderHook<ReturnType<typeof useTitleSearch>, { q: string }>(
      ({ q }) => useTitleSearch(q),
      { initialProps: { q: '' } },
    );

    await rerender({ q: 'inception' });

    // Past the local debounce and short of the provider's: the cheap query has gone and
    // the expensive one has not.
    await wait(300);
    expect(mockRpc).toHaveBeenCalled();
    expect(mockSearchProvider).not.toHaveBeenCalled();

    await waitFor(() => expect(mockSearchProvider).toHaveBeenCalled());
  });

  it('adds a provider result the local pass never had', async () => {
    mockSearchProvider.mockResolvedValue([remoteRow('remote-1', 'Dune: Part Two')]);

    const { result } = await renderHook(() => useTitleSearch('dune'));
    await settle();

    await waitFor(() => expect(result.current.results).toHaveLength(1));
    expect(result.current.results[0]?.id).toBe('remote-1');
  });

  /**
   * The merge is on id and it can be, because the adapter upserts before it answers: a
   * title in both passes is genuinely one row. What makes this worth a test is which
   * copy wins — the local one's poster is null and the provider just filled it in, so
   * preferring local would show blank artwork for a title it had only just fetched.
   */
  it('prefers the provider copy of a row both passes returned', async () => {
    mockRpc.mockResolvedValue({ data: [localRow('shared', 'Dune')], error: null });
    mockSearchProvider.mockResolvedValue([remoteRow('shared', 'Dune')]);

    const { result } = await renderHook(() => useTitleSearch('dune'));
    await settle();

    await waitFor(() => expect(result.current.results[0]?.poster_path).toBe('/from-tmdb.jpg'));
    expect(result.current.results).toHaveLength(1);
  });

  it('reports a rate limit without throwing away the local results', async () => {
    mockRpc.mockResolvedValue({ data: [localRow('local-1', 'Dune')], error: null });
    mockSearchProvider.mockRejectedValue(new AdapterError('BG429', 'slow down'));

    const { result } = await renderHook(() => useTitleSearch('dune'));
    await settle();

    await waitFor(() => expect(result.current.providerRateLimited).toBe(true));
    expect(result.current.results).toHaveLength(1);
    expect(result.current.isError).toBe(false);
  });

  it('does not call a failed lookup an exhaustive one', async () => {
    // The distinction the empty state hangs on. A down adapter used to satisfy
    // providerExhausted, so a missing TMDB key rendered as "nothing matches" —
    // the catalogue confidently reporting the absence of a film it never
    // managed to ask about.
    mockSearchProvider.mockRejectedValue(new AdapterError('BG500', 'no key configured'));

    const { result } = await renderHook(() => useTitleSearch('spiderman'));
    await settle();

    await waitFor(() => expect(result.current.providerFailed).toBe(true));
    expect(result.current.providerExhausted).toBe(false);
  });

  it('calls a successful empty lookup exhaustive', async () => {
    const { result } = await renderHook(() => useTitleSearch('zzzzzz'));
    await settle();

    await waitFor(() => expect(result.current.providerExhausted).toBe(true));
    expect(result.current.providerFailed).toBe(false);
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
