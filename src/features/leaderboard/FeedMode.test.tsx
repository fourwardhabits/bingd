import { cleanup, fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import FeedScreen from '../../../app/(tabs)/feed';

/**
 * The Feed ↔ Leaderboard toggle, and the board it opens (founder §§5–10, §26, §31).
 *
 * ---------------------------------------------------------------------------
 * THE THREE PROPERTIES WORTH A SCREEN TEST RATHER THAN A UNIT ONE
 *
 * **The default, and that it is not sticky.** §6 is a *negative* requirement — a fresh
 * launch must open on Feed, never on Leaderboard — and the only way to assert a negative
 * about persistence is to toggle, mount fresh, and look. It is also the requirement most
 * likely to be "improved" away by somebody adding the preference Collection has, which is
 * why the test says why in as many words.
 *
 * **That the bell survives.** The toggle is placed beside the one control that appears in
 * the same corner on every tab. A header that pushed it off, or made it unreachable, is a
 * regression in a control nothing else on this screen leads to.
 *
 * **That returning leaves the feed alone** (founder acceptance D). The board replaces the
 * content area; everything the feed owns has to still be there afterwards.
 *
 * The RPCs are mocked at the boundary rather than the hooks, so the query keys, the
 * enabled-gating and the row mapping are all exercised — a hook-level mock would pass
 * with the board wired to the wrong metric.
 */

const mockRpc = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => mockRpc(name, args),
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        or: () => chain,
        gt: () => chain,
        order: () => chain,
        limit: () => chain,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  // The trending shelf refetches on focus. Called immediately here, which is what a
  // focused screen does.
  useFocusEffect: (callback: () => void) => callback(),
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

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({ track: (event: unknown) => mockTrack(event) }));

/** The board rows the RPC answers with, per metric. */
const mockBoard: Record<string, unknown[]> = {};
/** The caller's own standing, per metric. */
const mockStanding: Record<string, unknown> = {};

const entry = (over: Record<string, unknown> = {}) => ({
  user_id: 'u-1',
  username: 'ada',
  display_name: 'Ada',
  avatar_path: null,
  visibility: 'public',
  metric_count: 9,
  rank: 1,
  is_you: false,
  ...over,
});

beforeEach(() => {
  mockPush.mockClear();
  mockTrack.mockClear();
  for (const key of Object.keys(mockBoard)) delete mockBoard[key];
  for (const key of Object.keys(mockStanding)) delete mockStanding[key];

  mockRpc.mockReset();
  mockRpc.mockImplementation((name: string, args: Record<string, unknown>) => {
    if (name === 'monthly_leaderboard') {
      return Promise.resolve({ data: mockBoard[args.p_metric as string] ?? [], error: null });
    }
    if (name === 'my_leaderboard_standing') {
      return Promise.resolve({
        data: [mockStanding[args.p_metric as string] ?? { metric_count: 0, rank: null, entrants: 0 }],
        error: null,
      });
    }
    return Promise.resolve({ data: [], error: null });
  });
});

const open = async () => {
  const view = await renderWithProviders(<FeedScreen />);
  await waitFor(() => expect(view.getByLabelText('Feed')).toBeTruthy());
  return view;
};

const toBoard = async (view: Awaited<ReturnType<typeof open>>) => {
  await fireEvent.press(view.getByLabelText('Leaderboard'));
  await waitFor(() => expect(view.getByText('This month')).toBeTruthy());
};

// ---------------------------------------------------------------------------

describe('the toggle', () => {
  it('opens on Feed, with the Activity heading and no board', async () => {
    const view = await open();

    expect(view.getByLabelText('Activity')).toBeTruthy();
    expect(view.queryByText('This month')).toBeNull();
  });

  it('switches to the Leaderboard on the trophy', async () => {
    const view = await open();
    await toBoard(view);

    expect(view.queryByLabelText('Activity')).toBeNull();
  });

  it('goes back to the Feed, with the feed untouched', async () => {
    // Founder acceptance D. The board replaces the content area rather than being
    // appended to it, so the assertion that matters on the way back is that the feed's
    // own furniture is exactly where it was.
    const view = await open();
    await toBoard(view);

    await fireEvent.press(view.getByLabelText('Feed'));

    await waitFor(() => expect(view.getByLabelText('Activity')).toBeTruthy());
    expect(view.queryByText('This month')).toBeNull();
  });

  /**
   * §6, and the reason it is a negative requirement: Leaderboard is an alternate surface,
   * not a way of drawing the homepage, so a launch that opened on it would have replaced
   * the homepage. Collection's toggle *is* persisted and this one must not be — the two
   * look alike deliberately, which is exactly why the difference needs a test.
   */
  it('does not survive a fresh launch', async () => {
    const first = await open();
    await toBoard(first);
    // `cleanup()` rather than `first.unmount()`: the library unmounts every rendered
    // tree again after the test, and a tree already unmounted by hand makes that second
    // pass throw — which leaves the *next* test rendering into a broken root and failing
    // for a reason that has nothing to do with what it asserts. Every test after this one
    // failed that way before the change, which is a good demonstration of why a
    // suspicious cascade is worth reading as one fault rather than fourteen.
    await cleanup();

    const second = await open();

    expect(second.getByLabelText('Activity')).toBeTruthy();
    expect(second.queryByText('This month')).toBeNull();
  });

  it('leaves the bell reachable in both modes', async () => {
    const view = await open();
    expect(view.getByLabelText(/^Notifications/)).toBeTruthy();

    await toBoard(view);
    expect(view.getByLabelText(/^Notifications/)).toBeTruthy();
  });

  it('does not read the board until it is opened', async () => {
    // The Feed is the default and most readers will never toggle. An eager read would be
    // a request per app open for a surface nobody asked for.
    await open();
    expect(mockRpc.mock.calls.filter(([name]) => name === 'monthly_leaderboard')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('the metrics', () => {
  it('opens on Titles', async () => {
    mockBoard.titles = [entry()];
    const view = await open();
    await toBoard(view);

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('monthly_leaderboard', {
        p_metric: 'titles',
        p_limit: 50,
      }),
    );
  });

  it('offers exactly the four, in the founder’s order', async () => {
    const view = await open();
    await toBoard(view);

    // The order is the product decision — Titles is the total and Movies and TV are its
    // two halves, so they sit beside it and the different question comes last.
    const labels = ['Titles', 'Movies', 'TV', 'Reviews'];
    for (const label of labels) expect(view.getByText(label)).toBeTruthy();
    expect(view.queryByText('Watched')).toBeNull();
    expect(view.queryByText('All Time')).toBeNull();
  });

  it('re-reads the board when a different chip is chosen', async () => {
    mockBoard.titles = [entry()];
    mockBoard.reviews = [entry({ username: 'bea', display_name: 'Bea', metric_count: 3 })];

    const view = await open();
    await toBoard(view);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    await fireEvent.press(view.getByText('Reviews'));

    await waitFor(() => expect(view.getByText('Bea')).toBeTruthy());
    expect(view.queryByText('Ada')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('the rows', () => {
  it('draws rank, name, handle and count', async () => {
    mockBoard.titles = [entry({ metric_count: 12, rank: 1 })];
    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.getByText('@ada')).toBeTruthy();
    expect(view.getByText('12')).toBeTruthy();
    expect(view.getByLabelText(/^Number 1, Ada, @ada, 12 titles/)).toBeTruthy();
  });

  it('opens a profile when a row is tapped', async () => {
    mockBoard.titles = [entry()];
    const view = await open();
    await toBoard(view);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    await fireEvent.press(view.getByText('Ada'));

    expect(mockPush).toHaveBeenCalledWith('/u/ada');
  });

  it('gives tied people the same rank, as the server reported it', async () => {
    // `rank()` shares a number on a tie and the next person is third. The row must draw
    // the server's rank rather than its own index, or a tie would silently renumber.
    mockBoard.titles = [
      entry({ user_id: 'u-1', username: 'ada', display_name: 'Ada', rank: 1, metric_count: 5 }),
      entry({ user_id: 'u-2', username: 'bea', display_name: 'Bea', rank: 1, metric_count: 5 }),
      entry({ user_id: 'u-3', username: 'cy', display_name: 'Cy', rank: 3, metric_count: 2 }),
    ];
    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByLabelText(/^Number 1, Ada/)).toBeTruthy());
    expect(view.getByLabelText(/^Number 1, Bea/)).toBeTruthy();
    expect(view.getByLabelText(/^Number 3, Cy/)).toBeTruthy();
  });

  it('marks the reader’s own row, and does not pin a second copy of it', async () => {
    mockBoard.titles = [entry({ user_id: 'user-1', username: 'sai', display_name: 'Sai', is_you: true })];
    mockStanding.titles = { metric_count: 9, rank: 1, entrants: 1 };

    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByLabelText(/, You$/)).toBeTruthy());
    // The pinned row's own label. Seeing yourself twice is the confusion §10 names.
    expect(view.queryByLabelText(/^You are number/)).toBeNull();
  });

  it('pins the reader’s standing when they are past the end of the page', async () => {
    mockBoard.titles = [entry()];
    mockStanding.titles = { metric_count: 2, rank: 84, entrants: 96 };

    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByLabelText('You are number 84 of 96, 2 titles')).toBeTruthy());
  });

  it('pins nothing for somebody who has done nothing this month', async () => {
    // Rank is null, not zero: a person with nothing to count has no position, and last
    // place is something you earn by being on the board.
    mockBoard.titles = [entry()];
    mockStanding.titles = { metric_count: 0, rank: null, entrants: 1 };

    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.queryByLabelText(/^You are number/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('an empty and sparse beta', () => {
  it('says what is true and invites the reader, per metric', async () => {
    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByText('No watches yet this month.')).toBeTruthy());
    expect(view.getByText('You could take the first spot.')).toBeTruthy();

    await fireEvent.press(view.getByText('Reviews'));
    await waitFor(() => expect(view.getByText('No reviews yet this month.')).toBeTruthy());
    expect(view.getByText('Yours could be the first.')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe('the two analytics events', () => {
  it('records the view on entering the board, and not on returning to the feed', async () => {
    const view = await open();
    await toBoard(view);

    expect(mockTrack).toHaveBeenCalledWith({
      name: 'leaderboard_viewed',
      props: { metric: 'titles' },
    });

    mockTrack.mockClear();
    await fireEvent.press(view.getByLabelText('Feed'));
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('records a metric change, and not a re-tap of the current chip', async () => {
    const view = await open();
    await toBoard(view);
    mockTrack.mockClear();

    await fireEvent.press(view.getByText('Titles'));
    expect(mockTrack).not.toHaveBeenCalled();

    await fireEvent.press(view.getByText('Movies'));
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'leaderboard_metric_selected',
      props: { metric: 'movies' },
    });
  });
});
