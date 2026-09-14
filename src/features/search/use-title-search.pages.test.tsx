import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { createQueryClient } from '@/lib/query';
import { AdapterError } from '@/lib/tmdb-adapter';

import { clearProviderCooldown } from './provider-budget';
import { useScrollGatedEnd } from './use-scroll-gated-end';
import { useTitleSearch } from './use-title-search';

/**
 * Exact titles and later pages, against a real QueryClient (2026-09-14).
 *
 * The app's own client, not the test helper's: pages are cached for half an hour through
 * `createQueryClient`'s provider defaults, and whether a page is reused rather than asked
 * for again is exactly what these tests are about.
 */

const mockRpc = jest.fn();
const mockProvider = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => Promise.resolve({ data: [], error: null }),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('@/lib/tmdb-adapter', () => {
  const actual = jest.requireActual('@/lib/tmdb-adapter');
  return {
    ...actual,
    searchProviderWithPeople: (...args: unknown[]) => mockProvider(...args),
  };
});

type Row = { id: string; title: string; kind?: 'movie' | 'series'; year?: number };

const title = ({ id, title: name, kind = 'movie', year = 2010 }: Row) => ({
  id,
  kind,
  title: name,
  release_date: `${year}-01-01`,
  poster_path: null,
  provenance: 'tmdb' as const,
  genres: [],
  runtime_minutes: null,
});

const page = (rows: Row[], pageNumber: number, totalPages: number) => ({
  titles: rows.map(title),
  people: [],
  page: pageNumber,
  totalPages,
});

/** What local `search_titles` holds for "don": two prefix matches, no exact title. */
const LOCAL_DON = [
  {
    id: 'local-darko',
    kind: 'movie',
    title: 'Donnie Darko',
    release_date: '2001-01-19',
    poster_path: null,
    provenance: 'tmdb',
  },
  {
    id: 'local-lookup',
    kind: 'movie',
    title: "Don't Look Up",
    release_date: '2021-12-24',
    poster_path: null,
    provenance: 'tmdb',
  },
];

/** TMDB's answer for "Don" as staging observed it: the exact film is not first. */
const DON_PAGE_ONE = [
  { id: 'don-juan', title: 'Don Juan', year: 1926 },
  { id: 'don-jon', title: 'Don Jon', year: 2013 },
  { id: 'dont-say', title: "Don't Say Good Luck", year: 2026 },
  { id: 'don-2006', title: 'Don', year: 2006 },
  { id: 'local-lookup', title: "Don't Look Up", year: 2021 },
];

const DON_PAGE_TWO = [
  { id: 'dead-dont-die', title: "The Dead Don't Die", year: 2019 },
  // Pages overlap: this is page 1's row again, and must not be drawn twice.
  { id: 'don-jon', title: 'Don Jon', year: 2013 },
  { id: 'don-mckay', title: 'Don McKay', year: 2009 },
];

let client: ReturnType<typeof createQueryClient>;

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

/** Past both debounces. */
const settle = () => wait(1000);

const calls = () =>
  mockProvider.mock.calls.map(([query, , pageNumber]) => `${query}#${pageNumber}`);

const mount = (initial: string) =>
  renderHook<ReturnType<typeof useTitleSearch>, { q: string }>(({ q }) => useTitleSearch(q), {
    initialProps: { q: initial },
    wrapper,
  });

beforeEach(() => {
  client = createQueryClient();
  clearProviderCooldown();
  mockRpc.mockReset();
  mockRpc.mockImplementation((fn: string, args: { p_query: string }) =>
    Promise.resolve({
      data: fn === 'search_titles' && args.p_query.toLowerCase() === 'don' ? LOCAL_DON : [],
      error: null,
    }),
  );
  mockProvider.mockReset();
  mockProvider.mockImplementation((query: string, _limit: number, pageNumber: number) => {
    if (query !== 'don')
      return Promise.resolve(page([{ id: `other-${query}`, title: query }], 1, 1));
    return Promise.resolve(
      pageNumber === 1 ? page(DON_PAGE_ONE, 1, 2) : page(DON_PAGE_TWO, 2, 2),
    );
  });
});

afterEach(() => {
  // The app client keeps unobserved entries for half an hour; nothing may outlive a test.
  client.clear();
});

describe('an exact title', () => {
  it('leads the list, ahead of local and provider prefix matches (the "Don" report)', async () => {
    const { result } = await mount('Don');
    await settle();

    await waitFor(() => expect(result.current.results[0]?.id).toBe('don-2006'));
    expect(result.current.results.map((row) => row.title)).toEqual([
      'Don',
      'Donnie Darko',
      "Don't Look Up",
      'Don Juan',
      'Don Jon',
      "Don't Say Good Luck",
    ]);
  });

  it('moves nothing when no title is exactly what was typed', async () => {
    mockProvider.mockImplementation(() =>
      Promise.resolve(
        page(
          DON_PAGE_ONE.filter((row) => row.id !== 'don-2006'),
          1,
          1,
        ),
      ),
    );
    const { result } = await mount('Don');
    await settle();

    await waitFor(() => expect(result.current.results).toHaveLength(5));
    expect(result.current.results.map((row) => row.id)).toEqual([
      'local-darko',
      'local-lookup',
      'don-juan',
      'don-jon',
      'dont-say',
    ]);
  });

  it('keeps several titles of the same name in the provider’s order', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    mockProvider.mockImplementation(() =>
      Promise.resolve(
        page(
          [
            { id: 'psycho', title: 'Signs of a Psychopath' },
            { id: 'signs-2002', title: 'Signs', year: 2002 },
            { id: 'vital', title: 'Vital Signs' },
            { id: 'signs-2018', title: 'Signs', kind: 'series', year: 2018 },
          ],
          1,
          1,
        ),
      ),
    );
    const { result } = await mount('Signs');
    await settle();

    await waitFor(() => expect(result.current.results).toHaveLength(4));
    expect(result.current.results.map((row) => row.id)).toEqual([
      'signs-2002',
      'signs-2018',
      'psycho',
      'vital',
    ]);
  });
});

describe('later pages', () => {
  it('asks for page 1 only, until the screen asks for more', async () => {
    const { result } = await mount('don');
    await settle();
    await waitFor(() => expect(result.current.hasMorePages).toBe(true));

    expect(calls()).toEqual(['don#1']);
  });

  it('appends page 2 beneath what is on screen, without a row twice', async () => {
    const { result } = await mount('don');
    await settle();
    await waitFor(() => expect(result.current.hasMorePages).toBe(true));
    const before = result.current.results.map((row) => row.id);

    await act(async () => {
      expect(result.current.loadMorePages()).toBe(true);
    });
    await waitFor(() => expect(result.current.results.length).toBeGreaterThan(before.length));

    const after = result.current.results.map((row) => row.id);
    // Nothing already on screen moved.
    expect(after.slice(0, before.length)).toEqual(before);
    // Page 2 minus the row page 1 already had.
    expect(after.slice(before.length)).toEqual(['dead-dont-die', 'don-mckay']);
    expect(new Set(after).size).toBe(after.length);
    expect(calls()).toEqual(['don#1', 'don#2']);
  });

  it('stops at the last page the provider reports', async () => {
    const { result } = await mount('don');
    await settle();
    await waitFor(() => expect(result.current.hasMorePages).toBe(true));

    await act(async () => {
      result.current.loadMorePages();
    });
    await waitFor(() => expect(result.current.hasMorePages).toBe(false));

    let asked = true;
    await act(async () => {
      asked = result.current.loadMorePages();
    });
    await wait(200);

    expect(asked).toBe(false);
    expect(calls()).toEqual(['don#1', 'don#2']);
  });

  it('asks for one page at a time, however often the end is reached', async () => {
    let release: () => void = () => {};
    mockProvider.mockImplementation((query: string, _limit: number, pageNumber: number) =>
      pageNumber === 1
        ? Promise.resolve(page(DON_PAGE_ONE, 1, 5))
        : new Promise((resolve) => {
            release = () =>
              resolve(
                page([{ id: `p${pageNumber}`, title: `Page ${pageNumber}` }], pageNumber, 5),
              );
          }),
    );
    const { result } = await mount('don');
    await settle();
    await waitFor(() => expect(result.current.hasMorePages).toBe(true));

    const answers: boolean[] = [];
    await act(async () => {
      answers.push(result.current.loadMorePages());
    });
    await act(async () => {
      answers.push(result.current.loadMorePages());
      answers.push(result.current.loadMorePages());
    });

    expect(answers).toEqual([true, false, false]);
    expect(calls()).toEqual(['don#1', 'don#2']);
    await act(async () => release());
  });

  it('reuses cached pages when the reader types away and back, and starts again from page 1', async () => {
    const { result, rerender } = await mount('don');
    await settle();
    await waitFor(() => expect(result.current.hasMorePages).toBe(true));
    await act(async () => {
      result.current.loadMorePages();
    });
    await waitFor(() => expect(result.current.hasMorePages).toBe(false));

    await rerender({ q: 'don 2' });
    await settle();
    // A new query is back to page 1 and has its own page count.
    expect(result.current.results.some((row) => row.id === 'dead-dont-die')).toBe(false);

    await rerender({ q: 'don' });
    await settle();
    await waitFor(() => expect(result.current.results[0]?.id).toBe('don-2006'));
    // Page 2 is not shown until asked for again, and asking again reads the cache.
    expect(result.current.results.some((row) => row.id === 'dead-dont-die')).toBe(false);
    await act(async () => {
      result.current.loadMorePages();
    });
    await waitFor(() =>
      expect(result.current.results.some((row) => row.id === 'dead-dont-die')).toBe(true),
    );

    expect(calls()).toEqual(['don#1', 'don#2', 'don 2#1']);
  });

  it('reports a refused page as rate limited, and asks for no more', async () => {
    mockProvider.mockImplementation((query: string, _limit: number, pageNumber: number) =>
      pageNumber === 1
        ? Promise.resolve(page(DON_PAGE_ONE, 1, 3))
        : Promise.reject(new AdapterError('BG429', 'slow down')),
    );
    const { result } = await mount('don');
    await settle();
    await waitFor(() => expect(result.current.hasMorePages).toBe(true));

    await act(async () => {
      result.current.loadMorePages();
    });
    await waitFor(() => expect(result.current.morePagesFailed).toBe(true));
    expect(result.current.morePagesRateLimited).toBe(true);
    // Page 1's rows stay, and they are not called "your catalogue only": page 1 did answer.
    expect(result.current.results[0]?.id).toBe('don-2006');
    expect(result.current.providerRateLimited).toBe(false);

    let asked = true;
    await act(async () => {
      asked = result.current.loadMorePages();
    });
    expect(asked).toBe(false);
    expect(calls()).toEqual(['don#1', 'don#2']);
  });

  it('draws no later page under a narrowing that turns the provider off', async () => {
    const { result } = await renderHook(() => useTitleSearch('don', { wide: false }), {
      wrapper,
    });
    await settle();

    let asked = true;
    await act(async () => {
      asked = result.current.loadMorePages();
    });
    expect(asked).toBe(false);
    expect(mockProvider).not.toHaveBeenCalled();
  });
});

describe('the end of the list, for a reader who is scrolling', () => {
  it('counts only after a drag, and once per drag', async () => {
    const onEnd = jest.fn(() => true);
    const { result } = await renderHook(() => useScrollGatedEnd(onEnd));

    // A short list reports its end with nobody touching it.
    await act(async () => result.current.onEndReached());
    expect(onEnd).not.toHaveBeenCalled();

    await act(async () => result.current.onScrollBeginDrag());
    await act(async () => result.current.onEndReached());
    await act(async () => result.current.onEndReached());
    expect(onEnd).toHaveBeenCalledTimes(1);

    await act(async () => result.current.onScrollBeginDrag());
    await act(async () => result.current.onEndReached());
    expect(onEnd).toHaveBeenCalledTimes(2);
  });

  it('keeps the gesture when nothing was asked, so the same drag can ask once a page lands, and no more', async () => {
    let ready = false;
    const onEnd = jest.fn(() => ready);
    const { result } = await renderHook(() => useScrollGatedEnd(onEnd));

    await act(async () => result.current.onScrollBeginDrag());
    await act(async () => result.current.onEndReached());
    ready = true;
    await act(async () => result.current.onEndReached());
    await act(async () => result.current.onEndReached());

    // Refused, then asked; after asking, the gesture is spent until the next drag.
    expect(onEnd).toHaveBeenCalledTimes(2);
    expect(onEnd.mock.results.map((entry) => entry.value)).toEqual([false, true]);
  });
});
