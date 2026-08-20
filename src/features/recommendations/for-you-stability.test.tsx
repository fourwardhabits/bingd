import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import RecommendationsScreen from '../../../app/(tabs)/recommendations';

import { setRecommendationSeed } from './session-seed';

/**
 * The founder's Android Preview bug, and the freshness control added beside it.
 *
 * Tapping a poster's bookmark on For You added the title to the watchlist and then made
 * the whole recommendation wall flash white, reload and jump back to the top. Two causes,
 * both in this file's blast radius:
 *
 *   1. `useForYou`'s query **key** carried a fingerprint of the watchlist, so a bookmark
 *      changed the key. A changed key is a different cache entry, with no data in it, so
 *      the screen fell to `isPending`, replaced the wall with a skeleton and mounted a
 *      brand new `ScrollView` when the data returned. Scroll position lives on the
 *      instance; a new instance starts at zero.
 *   2. The bookmark handler additionally invalidated `['for-you', userId]` by prefix,
 *      because the slate used to carry `saved` on every item.
 *
 * **`useForYou` is deliberately not mocked here.** `SentToYou.test.tsx` stands it in,
 * which is right for what that file is about and is exactly why this defect could exist:
 * a stubbed hook has no query key to get wrong. These tests exercise the real query, the
 * real cache and the real invalidation, and assert on the cache itself rather than on
 * something that merely correlates with it.
 */

const mockRpc = jest.fn();
let mockRpcResults: Record<string, unknown> = {};
/** Rows per table, and the read counter that proves whether a refetch happened. */
let mockTables: Record<string, unknown[]> = {};
let mockSingle: Record<string, unknown> = {};
const mockReads: Record<string, number> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      /**
       * `set_watchlist` really adds the row, and that is not a nicety.
       *
       * The first draft of this file left the watchlist table empty after the write, so
       * the refetch returned the same rows, the old code's fingerprint did not move, and
       * **every test here passed against the defect**. A regression test that cannot fail
       * on the bug it is named after is worse than no test: it is a claim.
       *
       * With the row actually landing, the reconciling refetch changes the watchlist —
       * which is precisely the input the old query key was built from.
       */
      if (name === 'set_watchlist') {
        const { p_media_item_id: id, p_present: present } = args as {
          p_media_item_id: string;
          p_present: boolean;
        };
        const rows = (mockTables.watchlist ?? []) as { media_item_id: string }[];
        mockTables.watchlist = present
          ? [...rows.filter((row) => row.media_item_id !== id), { media_item_id: id, created_at: '2026-08-20T00:00:00.000Z' }]
          : rows.filter((row) => row.media_item_id !== id);
      }
      return Promise.resolve({ data: mockRpcResults[name] ?? null, error: null });
    },
    from: (table: string) => {
      mockReads[table] = (mockReads[table] ?? 0) + 1;
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'gt', 'order', 'limit']) {
        chain[method] = () => chain;
      }
      // `trendingFallback` is the one read that asks for a single row.
      chain.maybeSingle = () => Promise.resolve({ data: mockSingle[table] ?? null, error: null });
      chain.then = (resolve: (value: unknown) => unknown) =>
        resolve({ data: mockTables[table] ?? [], error: null });
      return chain;
    },
  },
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({
    id: 'user-1',
    username: 'sai',
    display_name: 'Sai',
    avatar_path: null,
    avatarUri: null,
  }),
}));

/**
 * Forty trending films with distinct popularity, and no anchors.
 *
 * Popularity-only is the honest low-data shape and it is the harder case for freshness:
 * `popularityPrior` is a log, so forty titles spread over two decades of popularity
 * produce a genuine but narrow score spread — which is exactly the situation the
 * temperature is scaled to the spread for.
 *
 * Forty rather than twenty, so a wall of twenty is a *choice* out of a pool and a
 * refresh has somewhere to move.
 */
const CANDIDATES = Array.from({ length: 40 }, (_, index) => ({
  id: `film-${index}`,
  title: `Film ${index}`,
  release_date: '2020-01-01',
  poster_path: null,
  kind: 'movie',
  genres: [['Drama', 'Comedy', 'Horror', 'Action'][index % 4]],
  original_language: 'en',
  popularity: 500 - index * 11,
}));

/** The bookmark on the first tile. Twenty of them are on screen; any one will do. */
const firstBookmark = (view: { getAllByLabelText: (m: RegExp) => unknown[] }) =>
  view.getAllByLabelText(/^Save Film \d+ to watchlist$/)[0] as Parameters<
    typeof fireEvent.press
  >[0];

/**
 * The titles on the wall, in the order they are drawn.
 *
 * The bare title, not the whole label: a saved tile announces ", saved" on the end, and
 * comparing full labels would make "the wall did not move" fail for the one tile that
 * was *supposed* to change. Identity and order is what these tests are about.
 */
const wall = (view: { queryAllByLabelText: (m: RegExp) => { props: Record<string, unknown> }[] }) =>
  view
    .queryAllByLabelText(/^Film \d+/)
    .map((node) => String(node.props.accessibilityLabel).replace(/,.*$/, ''));

/**
 * Press a bookmark and wait for the write to have **landed**, not merely to have been
 * sent.
 *
 * Waiting on the RPC call was the first draft, and it was too early by exactly the
 * interesting amount: the call fires, and only afterwards does the reconciling
 * invalidation refetch the watchlist and — under the old code — change the slate's query
 * key. Every assertion ran inside that gap, and the suite passed against the defect it
 * is named after.
 *
 * The bookmark flipping to "Remove" is the end of that chain: it means the watchlist
 * query has come back carrying the new row. Whatever the key was going to do, it has
 * done by then.
 */
const bookmarkAndSettle = async (view: {
  getAllByLabelText: (m: RegExp) => unknown[];
  queryAllByLabelText: (m: RegExp) => unknown[];
}) => {
  await fireEvent.press(firstBookmark(view));
  await waitFor(() =>
    expect(view.queryAllByLabelText(/^Remove Film \d+ from watchlist$/)).toHaveLength(1),
  );
};

beforeEach(() => {
  mockRpc.mockReset();
  mockRpcResults = { my_notifications: [], recommendations_to_me: [], set_watchlist: 'committed' };
  mockTables = {
    rankings: [],
    user_media: [],
    watchlist: [],
    media_items: CANDIDATES,
    media_cache: [],
  };
  mockSingle = { provider_list_cache: { payload: { ids: CANDIDATES.map((row) => row.id) } } };
  for (const key of Object.keys(mockReads)) delete mockReads[key];
  // A fixed arrangement, so a test that asserts "the wall did not move" is not quietly
  // asserting against a wall that was random to begin with.
  setRecommendationSeed(12345);
});

/** Every `for-you` entry currently in the cache. One, always — see the tests. */
const slateKeys = (client: { getQueryCache: () => { getAll: () => { queryKey: readonly unknown[] }[] } }) =>
  client
    .getQueryCache()
    .getAll()
    .map((query) => query.queryKey)
    .filter((key) => key[0] === 'for-you');

const renderWall = async () => {
  const view = await renderWithProviders(<RecommendationsScreen />);
  await waitFor(() => expect(wall(view).length).toBeGreaterThan(0));
  return view;
};

describe('bookmarking on the For You wall', () => {
  it('adds the exact title to the watchlist', async () => {
    const view = await renderWall();
    const first = wall(view)[0] as string;
    const id = `film-${first.match(/Film (\d+)/)?.[1]}`;

    await fireEvent.press(view.getByLabelText(`Save ${first.replace(/,.*$/, '')} to watchlist`));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'set_watchlist',
        expect.objectContaining({ p_media_item_id: id, p_present: true }),
      ),
    );
  });

  it('leaves the wall in place: same titles, same order', async () => {
    const view = await renderWall();
    const before = wall(view);

    await bookmarkAndSettle(view);

    // Not "the same length" and not "the same set". The founder's complaint was about
    // position, so the assertion is about position.
    expect(wall(view)).toEqual(before);
  });

  it('does not create a second slate in the cache', async () => {
    // The mechanical heart of the defect. One cache entry before, one after: the query
    // key did not move, so there was never an empty entry to fall into, never an
    // `isPending`, never a skeleton and never a fresh `ScrollView`. Asserting on the
    // cache rather than on the absence of a flash, because a synchronous flash is
    // exactly the thing a render test cannot see.
    const view = await renderWall();
    expect(slateKeys(view.client)).toHaveLength(1);
    const keyBefore = JSON.stringify(slateKeys(view.client)[0]);

    await bookmarkAndSettle(view);

    expect(slateKeys(view.client)).toHaveLength(1);
    expect(JSON.stringify(slateKeys(view.client)[0])).toBe(keyBefore);
  });

  it('does not refetch the candidates', async () => {
    // A bookmark must not re-read `media_items`. This is the half that the query key
    // alone would not have caught: the handler used to invalidate `['for-you']` by
    // prefix as well, which refetches an *unchanged* key.
    const view = await renderWall();
    const candidateReads = mockReads.media_items;

    await bookmarkAndSettle(view);

    expect(mockReads.media_items).toBe(candidateReads);
  });

  it('never drops the slate back into a loading state', async () => {
    /**
     * The symptom itself, as close as a render test can get to it.
     *
     * `slate.isPending` is what swaps the wall for `<SkeletonRow />`, and swapping a
     * `ScrollView` for a skeleton and back is what loses the scroll position — React
     * unmounts the old instance and the new one starts at offset zero. So the assertion
     * is that the slate query, once it has data, never returns to `pending` for the rest
     * of the interaction.
     *
     * Watched through the cache rather than through the tree, because the flash is
     * synchronous: by the time `waitFor` looks, the skeleton has already been replaced.
     */
    const view = await renderWall();

    const pendingAfterLoad: string[] = [];
    const unsubscribe = view.client.getQueryCache().subscribe((event) => {
      const key = event.query.queryKey;
      if (key[0] === 'for-you' && event.query.state.status === 'pending') {
        pendingAfterLoad.push(JSON.stringify(key));
      }
    });

    try {
      await bookmarkAndSettle(view);
    } finally {
      unsubscribe();
    }

    expect(pendingAfterLoad).toEqual([]);
  });

  it('still refetches the canonical watchlist, so the bookmark tells the truth', async () => {
    // The other direction, and the one a fix could break by simply removing the
    // invalidation. Review 21's reconciliation stands: the watchlist is re-read after
    // the write, and the bookmark ends up showing what the server holds.
    const view = await renderWall();
    const watchlistReads = mockReads.watchlist ?? 0;

    await fireEvent.press(firstBookmark(view));
    await waitFor(() => expect(mockReads.watchlist ?? 0).toBeGreaterThan(watchlistReads));
  });

  it('fills the bookmark from the watchlist rather than from the slate', async () => {
    // `saved` is no longer carried on a slate item. If the watchlist says a title is on
    // it, the poster must draw it as saved without the slate being rebuilt.
    mockTables.watchlist = [{ media_item_id: 'film-0', created_at: '2026-08-20T00:00:00.000Z' }];
    const view = await renderWall();

    await waitFor(() => expect(view.queryByLabelText(/^Remove Film 0 from watchlist$/)).toBeTruthy());
    expect(slateKeys(view.client)).toHaveLength(1);
  });
});

describe('refreshing the wall', () => {
  it('offers a Refresh control in the filter row', async () => {
    const view = await renderWall();
    expect(view.getByLabelText('Refresh recommendations')).toBeTruthy();
  });

  it('draws a different arrangement without refetching anything', async () => {
    const view = await renderWall();
    const before = wall(view);
    const candidateReads = mockReads.media_items;

    await fireEvent.press(view.getByLabelText('Refresh recommendations'));

    await waitFor(() => expect(wall(view)).not.toEqual(before));
    // The whole design of the split: a refresh is a sort over data already in the
    // cache. No network, and no new cache entry to fall into.
    expect(mockReads.media_items).toBe(candidateReads);
    expect(slateKeys(view.client)).toHaveLength(1);
  });

  it('keeps drawing a full wall of the same size', async () => {
    const view = await renderWall();
    const before = wall(view);

    await fireEvent.press(view.getByLabelText('Refresh recommendations'));
    await waitFor(() => expect(wall(view)).not.toEqual(before));

    // Freshness must not cost coverage. The diversity ceilings still run, so this is a
    // claim about the ceilings surviving the reordering rather than about the number 20.
    expect(wall(view)).toHaveLength(before.length);
  });

  it('draws only titles that were candidates, never anything else', async () => {
    // "Do not solve this by calling random shuffle on every render" — and do not solve
    // it by widening the pool either. Everything on a refreshed wall came from the same
    // scored candidate set.
    const view = await renderWall();
    await fireEvent.press(view.getByLabelText('Refresh recommendations'));

    await waitFor(() => {
      for (const label of wall(view)) {
        expect(CANDIDATES.some((row) => label.startsWith(row.title))).toBe(true);
      }
    });
  });

  it('does not move the wall when anything other than Refresh happens', async () => {
    // Rule A. The seed is the only thing that rearranges a visit, and nothing but the
    // Refresh control touches it — so a bookmark, which is the most common interaction
    // on this screen, leaves the arrangement exactly as it was.
    const view = await renderWall();
    const before = wall(view);

    await bookmarkAndSettle(view);
    expect(wall(view)).toEqual(before);

    // A medium switch and back tears the Movies slate down and builds it again —
    // `gcTime` is zero in tests, so this really is a fresh query rather than a cache
    // hit. The arrangement still has to come back identical, because the seed lives in
    // a module rather than in the screen's state. That is what stops For You reshuffling
    // every time somebody visits another tab and returns.
    const selector = () => view.getAllByLabelText(/^Showing /)[0]!;
    await fireEvent.press(selector());
    await fireEvent.press(view.getByText('TV shows'));
    await fireEvent.press(selector());
    await fireEvent.press(view.getByText('Movies'));

    await waitFor(() => expect(wall(view)).toEqual(before));
  });
});
