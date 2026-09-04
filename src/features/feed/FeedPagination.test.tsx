import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { BackHandler } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import FeedScreen from '../../../app/(tabs)/feed';

/**
 * ---------------------------------------------------------------------------
 * INFINITE SCROLL ON THE FEED (2026-09-04)
 *
 * **The defect.** The feed read thirty rows once and never asked for a thirty-first. A
 * reader whose network had produced more than thirty eligible activities saw thirty of
 * them and then nothing — which is indistinguishable, from the reader's side, from
 * having reached the end of everything their friends had ever done.
 *
 * `use-feed.test.ts` proves the *requests*: the page size, the keyset, that page 2 asks
 * for strictly older rows, that it keeps every filter page 1 had. This file proves the
 * *screen*, which is a different set of claims and the ones the founder can see:
 *
 *   1. **Approaching the bottom fetches the next page**, before the reader arrives there.
 *   2. **A flick through the threshold fetches it once**, not once per frame.
 *   3. **The true end is quiet.** No spinner, no repeated request, one small line.
 *   4. **A failed page 2 keeps page 1.** The footer offers the retry; the list survives.
 *   5. **Pull-to-refresh resets the pagination** and costs one request, not one per page.
 *
 * The Supabase boundary is mocked rather than the hooks, so the query keys, the page
 * params, the cursor and the flattening are all real — a hook-level fake would pass with
 * the screen wired to a query that never paginates.
 */

const PAGE = 20;

/** Every read of `feed_events`, with the keyset the caller asked for. */
const mockFeedReads: { or: string | null }[] = [];
/** One answer per read; falls back to an empty page once exhausted. */
let mockFeedQueue: { rows?: unknown[]; error?: unknown }[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: [], error: null }),
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const read: { or: string | null } = { or: null };
      const result = () => {
        if (table === 'follows') {
          return Promise.resolve({ data: [{ followee_id: 'friend' }], error: null });
        }
        if (table !== 'feed_events') return Promise.resolve({ data: [], error: null });
        mockFeedReads.push(read);
        const next = mockFeedQueue.shift();
        if (next?.error) return Promise.resolve({ data: null, error: next.error });
        return Promise.resolve({ data: next?.rows ?? [], error: null });
      };
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        gt: () => chain,
        or: (filter: string) => {
          read.or = filter;
          return chain;
        },
        order: () => chain,
        limit: () => result(),
        then: (resolve: (value: unknown) => unknown) => result().then(resolve),
      });
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: (callback: () => void) => callback(),
  useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
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

jest.mock('@/lib/prefs', () => ({
  readPref: () => Promise.resolve(null),
  writePref: () => Promise.resolve(),
}));

jest.mock('@/lib/analytics', () => ({ track: () => {} }));

// ---------------------------------------------------------------------------

/** A feed row whose title names its own index, so a page can be told from a page. */
const row = (n: number, over: Record<string, unknown> = {}) => {
  const at = `2026-08-${String(28 - (n % 27)).padStart(2, '0')}T00:00:00Z`;
  return {
    id: `event-${String(n).padStart(3, '0')}`,
    type: 'title_ranked',
    actor_id: 'friend',
    media_item_id: `film-${n}`,
    created_at: at,
    causal_at: at,
    causal_step: 0,
    payload: { position: 1, category: 'movies', bucket: 'loved', score: 8.7 },
    media_items: {
      kind: 'movie',
      title: `Film ${String(n).padStart(3, '0')}`,
      release_date: '2010-07-16',
      poster_path: null,
      genres: [],
      runtime_minutes: 100,
      parent: null,
    },
    profiles: { username: 'ada', display_name: 'Ada', avatar_path: null },
    ...over,
  };
};

/** A page the server filled, which is what tells the client there may be another. */
const fullPage = (from = 0) => Array.from({ length: PAGE }, (_, i) => row(from + i));

beforeEach(() => {
  mockFeedReads.length = 0;
  mockFeedQueue = [];
  jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((() => ({ remove: () => {} })) as never);
});

/**
 * Let the reads this screen started settle before the tree comes down.
 *
 * The Feed fires a second wave of queries every time the list grows — reactions and
 * comment counts are keyed by the ids on screen — so a test that asserts the instant a
 * page lands ends with those still in flight. React Query then notifies an unmounted
 * tree on its batching timer, which Jest reports as an update outside `act` and, at the
 * end of the run, as a worker that would not exit. Declared after the library's own
 * cleanup so it runs before it: Jest runs `afterEach` hooks in reverse.
 */
afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

type View = Awaited<ReturnType<typeof renderWithProviders>>;

const open = async () => {
  const view = await renderWithProviders(<FeedScreen />);
  await waitFor(() => expect(view.getByLabelText('Feed')).toBeTruthy());
  return view;
};

/**
 * A scroll event placing the reader `fromBottom` points above the end of the content.
 *
 * The three fields are the ones the handler reads and the ones the platform sends. The
 * content is deliberately much taller than the viewport, so "near the bottom" is a real
 * position in a real list rather than an artefact of a one-screen fixture.
 */
const scrollTo = async (view: View, fromBottom: number) => {
  const height = 6000;
  const viewport = 800;
  await act(async () => {
    fireEvent.scroll(view.getByTestId('feed-scroll'), {
      nativeEvent: {
        contentOffset: { y: height - viewport - fromBottom },
        contentSize: { height, width: 390 },
        layoutMeasurement: { height: viewport, width: 390 },
      },
    });
  });
};

const refresh = async (view: View) => {
  const control = view.getByTestId('feed-scroll').props.refreshControl;
  await act(async () => {
    control.props.onRefresh();
  });
};

/**
 * The rows for one fixture index, found by the watchlist control that belongs to it.
 *
 * Not `getByText('Film 007')`: `ActivityRow` draws the year in a nested `Text` inside the
 * title, so that element's text content is "Film 007 2010" and an exact match finds
 * nothing. The watchlist button carries the name on its own, exactly once per row, which
 * also makes it the right handle for counting a duplicate.
 */
const rowsFor = (view: View, n: number) =>
  view.queryAllByLabelText(`Add Film ${String(n).padStart(3, '0')} to your watchlist`);

const hasRow = (view: View, n: number) => rowsFor(view, n).length > 0;

/** Wait until a row is drawn, which is what "the page arrived" means to a reader. */
const seeRow = (view: View, n: number) => waitFor(() => expect(hasRow(view, n)).toBe(true));

/** Reads of `feed_events` only — the follow set and the enrichments are not pages. */
const pageReads = () => mockFeedReads.length;

// ---------------------------------------------------------------------------

describe('approaching the bottom', () => {
  it('fetches the next page before the reader reaches the last row', async () => {
    mockFeedQueue = [{ rows: fullPage() }, { rows: [row(100)] }];
    const view = await open();
    await seeRow(view, 0);
    expect(pageReads()).toBe(1);

    // 200 points from the end: inside the threshold, and still most of a screen of
    // rows away from actually running out.
    await scrollTo(view, 200);

    await waitFor(() => expect(pageReads()).toBe(2));
    expect(mockFeedReads[1]?.or).toContain('causal_at.lt.');
    await seeRow(view, 100);
  });

  it('appends the new page under the old one rather than replacing it', async () => {
    // "No jump" as an assertion a test runner can make: the rows the reader was looking
    // at are still mounted, in the same order, with the new ones after them.
    mockFeedQueue = [{ rows: fullPage() }, { rows: [row(100)] }];
    const view = await open();
    await scrollTo(view, 200);

    await seeRow(view, 100);
    expect(hasRow(view, 0)).toBe(true);
    expect(hasRow(view, 19)).toBe(true);
  });

  it('asks for nothing while the reader is still well short of the end', async () => {
    mockFeedQueue = [{ rows: fullPage() }];
    const view = await open();

    await scrollTo(view, 3000);

    expect(pageReads()).toBe(1);
  });

  it('asks once for a flick that crosses the threshold many times', async () => {
    /**
     * `onScroll` fires on every frame of a gesture, and the frames of one flick through
     * the bottom of the list are a dozen events inside the threshold. Without the
     * in-flight guard that is a dozen identical requests — React Query would collapse
     * them onto one cache entry and the network would still have carried them all.
     */
    mockFeedQueue = [{ rows: fullPage() }, { rows: [row(100)] }];
    const view = await open();

    await scrollTo(view, 700);
    await scrollTo(view, 500);
    await scrollTo(view, 300);
    await scrollTo(view, 100);

    await seeRow(view, 100);
    expect(pageReads()).toBe(2);
  });
});

describe('the true end', () => {
  it('stops asking once the server returns a short page', async () => {
    // Five rows against a page size of twenty: the feed is genuinely this short.
    mockFeedQueue = [{ rows: [row(0), row(1), row(2), row(3), row(4)] }];
    const view = await open();
    await seeRow(view, 0);

    await scrollTo(view, 50);
    await scrollTo(view, 0);

    expect(pageReads()).toBe(1);
  });

  it('says so once, quietly, under a list that has something in it', async () => {
    mockFeedQueue = [{ rows: [row(0)] }];
    const view = await open();

    await waitFor(() => expect(view.getByText(/all caught up/i)).toBeTruthy());
  });

  it('says nothing while there is another page to come', async () => {
    mockFeedQueue = [{ rows: fullPage() }];
    const view = await open();
    await seeRow(view, 0);

    expect(view.queryByText(/all caught up/i)).toBeNull();
  });

  it('leaves an empty feed to its own empty state', async () => {
    // "You're all caught up" under "Your feed is quiet right now" would be the screen
    // agreeing with itself. The empty state already says considerably more.
    mockFeedQueue = [{ rows: [] }];
    const view = await open();

    await waitFor(() => expect(view.getByText(/quiet right now/i)).toBeTruthy());
    expect(view.queryByText(/all caught up/i)).toBeNull();
  });
});

describe('a page that fails', () => {
  const failSecondPage = async () => {
    mockFeedQueue = [{ rows: fullPage() }, { error: { message: 'network' } }];
    const view = await open();
    await seeRow(view, 0);
    await scrollTo(view, 200);
    await waitFor(() => expect(view.getByText(/Could not load more/i)).toBeTruthy());
    return view;
  };

  it('keeps every row already on screen', async () => {
    // The regression this guards: an infinite query reports a failed page on the query
    // itself, so a screen testing `isError` alone throws away twenty rows the reader is
    // looking at because the twenty-first page timed out.
    const view = await failSecondPage();

    expect(hasRow(view, 0)).toBe(true);
    expect(hasRow(view, 19)).toBe(true);
    expect(view.queryByText('Could not load activity')).toBeNull();
  });

  it('does not re-request the failed page from the scroll position', async () => {
    // The reader is still sitting inside the threshold. Without the error guard that
    // position is a request loop against a connection that is already down.
    const view = await failSecondPage();
    const after = pageReads();

    await scrollTo(view, 100);
    await scrollTo(view, 50);

    expect(pageReads()).toBe(after);
  });

  it('retries only the page that failed', async () => {
    const view = await failSecondPage();
    mockFeedQueue = [{ rows: [row(100)] }];

    await act(async () => {
      fireEvent.press(view.getByText('Try again'));
    });

    await seeRow(view, 100);
    // The retry asked the same question the failure did, and page 1 was not re-read.
    expect(mockFeedReads[2]?.or).toBe(mockFeedReads[1]?.or);
    expect(pageReads()).toBe(3);
    expect(hasRow(view, 0)).toBe(true);
  });
});

describe('pull to refresh', () => {
  it('costs one read however many pages the reader had scrolled through', async () => {
    /**
     * `refetch()` on an infinite query re-runs every page it holds. Somebody four pages
     * down would spend four round trips to find out what is new at the top, which is not
     * what the gesture looks like it does. The screen trims to one page first.
     */
    mockFeedQueue = [{ rows: fullPage() }, { rows: fullPage(100) }, { rows: [row(200)] }];
    const view = await open();
    await scrollTo(view, 200);
    await seeRow(view, 100);
    await scrollTo(view, 200);
    await seeRow(view, 200);
    const before = pageReads();

    mockFeedQueue = [{ rows: [row(300)] }];
    await refresh(view);

    await seeRow(view, 300);
    expect(pageReads()).toBe(before + 1);
  });

  it('goes back to the newest page, with no cursor', async () => {
    mockFeedQueue = [{ rows: fullPage() }, { rows: [row(100)] }];
    const view = await open();
    await scrollTo(view, 200);
    await seeRow(view, 100);

    mockFeedQueue = [{ rows: [row(300)] }];
    await refresh(view);

    await seeRow(view, 300);
    expect(mockFeedReads.at(-1)?.or).toBeNull();
  });

  it('drops the pages it replaced rather than showing them twice', async () => {
    mockFeedQueue = [{ rows: fullPage() }, { rows: [row(100)] }];
    const view = await open();
    await scrollTo(view, 200);
    await seeRow(view, 100);

    mockFeedQueue = [{ rows: [row(300)] }];
    await refresh(view);

    await seeRow(view, 300);
    expect(hasRow(view, 100)).toBe(false);
    expect(rowsFor(view, 300)).toHaveLength(1);
  });

  it('can page again from the page it refreshed onto', async () => {
    // The pagination is reset, not disabled: a refresh that left `hasNextPage` false
    // would give the reader a twenty-row feed until they relaunched.
    mockFeedQueue = [{ rows: fullPage() }];
    const view = await open();
    await seeRow(view, 0);

    mockFeedQueue = [{ rows: fullPage(500) }, { rows: [row(600)] }];
    await refresh(view);
    await seeRow(view, 500);

    await scrollTo(view, 200);

    await seeRow(view, 600);
  });
});

describe('new activity arriving at the top', () => {
  it('does not duplicate a row the reader has already been served', async () => {
    /**
     * The \`OFFSET\` failure mode, asserted as an absence. Under an offset, an activity
     * posted while the reader is on page 1 shifts every later row down by one and page 2
     * re-serves the row page 1 already showed. Under a keyset, page 2 asks for rows after
     * a specific row, and a write at the top cannot change that answer — but the join
     * dedupes by id as well, because a refresh can move the boundary underneath.
     *
     * The fixture is the pathological case directly: page 2 comes back overlapping page 1.
     */
    mockFeedQueue = [{ rows: fullPage() }, { rows: [row(19), row(100)] }];
    const view = await open();
    await scrollTo(view, 200);

    await seeRow(view, 100);
    expect(rowsFor(view, 19)).toHaveLength(1);
  });
});
