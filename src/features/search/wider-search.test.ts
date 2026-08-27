import { act, renderHook, waitFor } from '@testing-library/react-native';

import { AdapterError } from '@/lib/tmdb-adapter';

import { useTitleSearch } from './use-title-search';

/**
 * **The founder's third physical blocker: "lizzie", "McGuire", and nothing.**
 *
 *     Could not search wider
 *     Your catalogue has nothing, and the wider search did not answer.
 *
 * The server side of that chain was checked against bingd-nonprod, as a real signed-in
 * user, before a line of this was written — and it is healthy. `search_titles` answers in
 * under half a second, and the `tmdb-adapter` Edge Function returns *Lizzie McGuire*,
 * *The Lizzie McGuire Movie* and *Lizzie McGuire - Fashionably Lizzie* for the exact query,
 * the partial one and the surname alone, in 380–850ms. So the failure lives on the device,
 * and what this file pins is the client contract around it:
 *
 *   · **the wider search is asked at all**, for an exact title, a partial one, and a single
 *     word from inside one — the three shapes the founder used;
 *   · **its rows reach the screen**, merged behind the catalogue's own ranking;
 *   · **a wider failure is reported as a wider failure**, never as an empty catalogue;
 *   · **a failure is attributed to the query it belongs to** and not to the one the person
 *     has since typed;
 *   · **the retry retries both passes**, which is what the button on that empty state says.
 *
 * The one fact this cannot supply is which failure the phone had. That is why
 * `lib/tmdb-adapter.ts` now records the outcome as a `BGnnn` code and `logicalName` names
 * the function lane — so the next report says whether it was `BG401`, `BG429`, `BG502` or
 * a request that never came back at all.
 */

const mockRpc = jest.fn();
const mockSearchProvider = jest.fn();

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

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => Promise.resolve({ data: [], error: null }),
        order: () => Promise.resolve({ data: [], error: null }),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

// The same thin React Query stand-in `use-title-search.test.ts` uses, so the assertions are
// about the hook's own debounce and enabling rules rather than about a client's retry timers.
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
        setError(undefined);
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
        isPlaceholderData: false,
        isFetching: fetching,
        isFetched: fetched,
        refetch: () => {
          mockRefetches.push(String(queryKey));
          return Promise.resolve();
        },
      };
    },
  };
});

let mockRefetches: string[] = [];

const localRow = (id: string, title: string) => ({
  id,
  kind: 'movie',
  title,
  release_date: '2003-05-02',
  poster_path: null,
  provenance: 'wikidata',
});

const remoteRow = (id: string, title: string) => ({
  ...localRow(id, title),
  poster_path: '/from-tmdb.jpg',
  provenance: 'tmdb',
  genres: ['Family'],
  runtime_minutes: 94,
});

/** Longer than the provider's 800ms debounce, so the wider pass has really been reached. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
  });

/**
 * The mocked class rather than a look-alike: the hook uses `instanceof` to tell a spent
 * allowance from a broken lookup, and a structurally identical class fails that test
 * silently — reporting every rate limit as an ordinary failure, which is the wrong copy.
 */
const adapterFailure = (code: string) => new AdapterError(code, code);

beforeEach(() => {
  mockRpc.mockReset().mockResolvedValue({ data: [], error: null });
  mockSearchProvider.mockReset().mockResolvedValue([]);
  mockRefetches = [];
});

const search = async (query: string) => {
  const view = await renderHook<ReturnType<typeof useTitleSearch>, { q: string }>(
    ({ q }) => useTitleSearch(q),
    { initialProps: { q: query } },
  );
  await settle();
  return view;
};

// ---------------------------------------------------------------------------

describe('the three query shapes the founder used', () => {
  /**
   * A catalogue that has never heard of the title, which is what the founder's device had:
   * `search_titles` answered 0 rows for `lizzie`, `mcguire` and `lizzie mcguire` alike.
   * Everything below therefore rests entirely on the wider pass happening.
   */
  const KNOWN = [remoteRow('m1', 'The Lizzie McGuire Movie')];

  it('asks the wider search for a full title', async () => {
    mockSearchProvider.mockResolvedValue(KNOWN);

    const { result } = await search('the lizzie mcguire movie');

    expect(mockSearchProvider).toHaveBeenCalledWith('the lizzie mcguire movie', 20);
    await waitFor(() =>
      expect(result.current.results.map((row) => row.title)).toEqual([
        'The Lizzie McGuire Movie',
      ]),
    );
  });

  it('asks the wider search for a partial title', async () => {
    mockSearchProvider.mockResolvedValue(KNOWN);

    const { result } = await search('lizzie mcguire');

    expect(mockSearchProvider).toHaveBeenCalledWith('lizzie mcguire', 20);
    await waitFor(() => expect(result.current.results).toHaveLength(1));
  });

  it('asks the wider search for one word from inside a title', async () => {
    mockSearchProvider.mockResolvedValue(KNOWN);

    // The founder typed "McGuire" on its own. The catalogue had nothing under it, and a
    // gate that skipped the wider pass on a thin local answer is what the `spiderman`
    // tranche removed — this is the assertion that keeps it removed.
    const { result } = await search('mcguire');

    expect(mockSearchProvider).toHaveBeenCalledWith('mcguire', 20);
    await waitFor(() => expect(result.current.results).toHaveLength(1));
  });

  it('puts the catalogue first and the wider find after it', async () => {
    mockRpc.mockResolvedValue({ data: [localRow('local-1', 'Lizzie')], error: null });
    mockSearchProvider.mockResolvedValue(KNOWN);

    const { result } = await search('lizzie');

    await waitFor(() =>
      expect(result.current.results.map((row) => row.title)).toEqual([
        'Lizzie',
        'The Lizzie McGuire Movie',
      ]),
    );
  });
});

describe('when the wider search does not answer', () => {
  it('says so, rather than saying the catalogue is empty', async () => {
    mockSearchProvider.mockRejectedValue(adapterFailure('BG502'));

    const { result } = await search('lizzie mcguire');

    await waitFor(() => expect(result.current.providerFailed).toBe(true));
    // The distinction the whole empty state turns on: the app does not know whether this
    // title exists, so it must not claim it does not.
    expect(result.current.providerExhausted).toBe(false);
    expect(result.current.providerRateLimited).toBe(false);
  });

  it('separates a spent allowance from a broken lookup', async () => {
    mockSearchProvider.mockRejectedValue(adapterFailure('BG429'));

    const { result } = await search('lizzie mcguire');

    await waitFor(() => expect(result.current.providerRateLimited).toBe(true));
    expect(result.current.providerFailed).toBe(true);
  });

  it('retries both passes, not just the one that worked', async () => {
    mockSearchProvider.mockRejectedValue(adapterFailure('BG502'));

    const { result } = await search('lizzie mcguire');
    await waitFor(() => expect(result.current.providerFailed).toBe(true));

    await act(async () => {
      result.current.retry();
    });

    // Two refetches: the local pass and the provider pass. The button used to call only
    // the first, which is the half that had already succeeded.
    expect(mockRefetches).toHaveLength(2);
    expect(mockRefetches.some((key) => key.includes('provider'))).toBe(true);
  });

  it('recovers on the retry', async () => {
    mockSearchProvider
      .mockRejectedValueOnce(adapterFailure('BG502'))
      .mockResolvedValue([remoteRow('m1', 'The Lizzie McGuire Movie')]);

    const view = await renderHook<ReturnType<typeof useTitleSearch>, { q: string }>(
      ({ q }) => useTitleSearch(q),
      { initialProps: { q: 'lizzie mcguire' } },
    );
    await settle();
    await waitFor(() => expect(view.result.current.providerFailed).toBe(true));

    // A new query is the retry a person actually performs: they type the rest of the name.
    await view.rerender({ q: 'lizzie mcguire movie' });
    await settle();

    await waitFor(() => expect(view.result.current.providerFailed).toBe(false));
    expect(view.result.current.results).toHaveLength(1);
  });
});

describe('whose failure it is', () => {
  /**
   * **The attribution bug, and it is the founder's sentence pointed at the wrong search.**
   *
   * The provider observer keeps its key until the 800ms debounce catches up, so between
   * keystrokes it still holds the *previous* query's error. `providerExhausted` was already
   * gated on the two debounced values agreeing; `providerFailed` was not — so the screen
   * would draw "the wider search did not answer" over results for a query the wider search
   * had not yet been asked about.
   */
  it('does not blame a query the wider search has not been asked about yet', async () => {
    mockSearchProvider.mockRejectedValue(adapterFailure('BG502'));

    const view = await renderHook<ReturnType<typeof useTitleSearch>, { q: string }>(
      ({ q }) => useTitleSearch(q),
      { initialProps: { q: 'lizzie' } },
    );
    await settle();
    await waitFor(() => expect(view.result.current.providerFailed).toBe(true));

    // Typing on. The local pass debounces at 180ms and the provider at 800, so for that
    // window the two disagree and the wider search is deliberately not running.
    await view.rerender({ q: 'lizzie mcg' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(view.result.current.providerFailed).toBe(false);
    expect(view.result.current.providerRateLimited).toBe(false);
  });
});
