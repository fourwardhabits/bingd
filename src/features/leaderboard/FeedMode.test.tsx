import { cleanup, fireEvent, waitFor } from '@testing-library/react-native';
import { BackHandler, StyleSheet, type ViewStyle } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import FeedScreen from '../../../app/(tabs)/feed';

/**
 * The Feed ↔ Leaderboard toggle, the timeframe selector, and the board's rows.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE GUARDS
 *
 * **Two preferences that must not be conflated.** The founder was explicit: the
 * *timeframe* is remembered across launches and the *mode* is not. They live one line
 * apart in `feed.tsx`, they are both stored-preference-shaped, and swapping them would
 * mean the app opening on a scoreboard instead of the homepage. Every persistence test
 * below asserts one and denies the other.
 *
 * **Where the toggle is.** It spent a day in the app bar and the founder's physical
 * review moved it. The app bar is the one row identical on every tab, so a control that
 * appears on exactly one of them makes the app's most stable landmark move. Asserted as
 * an absence up there as well as a presence down here.
 *
 * **The row's hierarchy.** Name and handle share the first line; Match and its evidence
 * take the second; the count is never crushed; the whole row is one tap target.
 *
 * The RPCs are mocked at the boundary rather than the hooks, so the query keys, the
 * enabled-gating, the timeframe argument and the row mapping are all exercised — a
 * hook-level mock would pass with the board wired to the wrong timeframe.
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

/**
 * **The tab bar, captured rather than mounted.**
 *
 * The screen subscribes to its navigator's `tabPress`, which under this runner has no
 * navigator to come from — mounting a real `Tabs` to press one cell would be mounting
 * four other screens to test this one. So the mock records what the screen subscribed
 * with and `pressFeedTab` calls it, which is exactly what React Navigation does with it.
 *
 * `focused` is mutable because "already-selected" is the whole of the contract: the same
 * event fires when the reader arrives from another tab, and the screen must tell those
 * two apart.
 */
const tabPressHandlers: (() => void)[] = [];
const mockNavigation = {
  focused: true,
  addListener: (event: string, handler: () => void) => {
    if (event === 'tabPress') tabPressHandlers.push(handler);
    return () => {};
  },
  isFocused: () => mockNavigation.focused,
};

const pressFeedTab = () => {
  const handler = tabPressHandlers.at(-1);
  if (!handler) throw new Error('the screen subscribed to no tabPress');
  handler();
};

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  // The trending shelf refetches on focus. Called immediately here, which is what a
  // focused screen does.
  useFocusEffect: (callback: () => void) => callback(),
  useNavigation: () => mockNavigation,
}));

/** Mutable so a test can sign one reader out and another in. */
const mockProfile = { id: 'user-1' };

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({
    id: mockProfile.id,
    username: 'sai',
    display_name: 'Sai',
    avatar_path: null,
    avatarUri: null,
  }),
}));

/** A real preference store, so a remembered timeframe can be seeded and read back. */
const mockPrefStore: Record<string, unknown> = {};
const mockPrefWrites: { name: string; value: unknown }[] = [];
const mockPrefFailing = new Set<string>();

jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) =>
    mockPrefFailing.has(name)
      ? Promise.reject(new Error('store unavailable'))
      : Promise.resolve(mockPrefStore[name] ?? null),
  writePref: (name: string, value: unknown) => {
    mockPrefWrites.push({ name, value });
    mockPrefStore[name] = value;
    return Promise.resolve();
  },
}));

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({ track: (event: unknown) => mockTrack(event) }));

/**
 * **Android's hardware Back, captured rather than simulated.**
 *
 * `Platform.OS` is `ios` under this runner and `BackHandler.ios.js` is a stub that
 * never fires, so there is no event to dispatch. The screen registers its handler
 * unconditionally — deliberately, and for this reason among others — so the test takes
 * the callback the screen handed over and calls it, which is exactly what the Android
 * implementation does with it.
 */
const backHandlers: (() => boolean)[] = [];
const pressBack = () => {
  const handler = backHandlers.at(-1);
  if (!handler) throw new Error('the screen registered no hardware-back handler');
  return handler();
};

const TIMEFRAME_KEY = 'user-1.leaderboard.timeframe';

/** Board rows and standings, keyed `metric|timeframe` so the views cannot be confused. */
const mockBoard: Record<string, unknown[]> = {};
const mockStanding: Record<string, unknown> = {};
const boardKey = (args: Record<string, unknown>) => `${args.p_metric}|${args.p_timeframe}`;

const entry = (over: Record<string, unknown> = {}) => ({
  user_id: 'u-1',
  username: 'ada',
  display_name: 'Ada',
  avatar_path: null,
  visibility: 'public',
  metric_count: 9,
  rank: 1,
  is_you: false,
  match_percent: null,
  shared_count: 0,
  ...over,
});

beforeEach(() => {
  backHandlers.length = 0;
  tabPressHandlers.length = 0;
  mockNavigation.focused = true;
  jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation(((_event: string, handler: () => boolean) => {
      backHandlers.push(handler);
      return { remove: () => {} };
    }) as never);

  mockProfile.id = 'user-1';
  mockPush.mockClear();
  mockTrack.mockClear();
  for (const key of Object.keys(mockBoard)) delete mockBoard[key];
  for (const key of Object.keys(mockStanding)) delete mockStanding[key];
  for (const key of Object.keys(mockPrefStore)) delete mockPrefStore[key];
  mockPrefWrites.length = 0;
  mockPrefFailing.clear();

  mockRpc.mockReset();
  mockRpc.mockImplementation((name: string, args: Record<string, unknown>) => {
    if (name === 'leaderboard') {
      return Promise.resolve({ data: mockBoard[boardKey(args)] ?? [], error: null });
    }
    if (name === 'my_leaderboard_standing') {
      return Promise.resolve({
        data: [mockStanding[boardKey(args)] ?? { metric_count: 0, rank: null, entrants: 0 }],
        error: null,
      });
    }
    return Promise.resolve({ data: [], error: null });
  });
});

type View = Awaited<ReturnType<typeof renderWithProviders>>;

const open = async () => {
  const view = await renderWithProviders(<FeedScreen />);
  await waitFor(() => expect(view.getByLabelText('Feed')).toBeTruthy());
  return view;
};

const toBoard = async (view: View, expecting = 'This month') => {
  await fireEvent.press(view.getByLabelText('Leaderboard'));
  await waitFor(() => expect(view.getByLabelText(`Showing ${expecting}`)).toBeTruthy());
};

/** Open the timeframe dropdown and choose. The same two-step MediumSelector everywhere. */
const chooseTimeframe = async (view: View, from: string, to: string) => {
  await fireEvent.press(view.getByLabelText(`Showing ${from}`));
  await fireEvent.press(view.getByText(to));
  await waitFor(() => expect(view.getByLabelText(`Showing ${to}`)).toBeTruthy());
};

// ---------------------------------------------------------------------------

describe('where the toggle lives', () => {
  /**
   * Founder acceptance A. Asserted as an *absence* in the app bar, not merely a presence
   * elsewhere: the bar is the one row identical on every tab, and a control that appears
   * on exactly one of them makes the app's most stable landmark move.
   */
  it('is not in the app bar, which holds the wordmark and the bell', async () => {
    /**
     * Walked from the tree rather than queried by role.
     *
     * `AppHeader` and `SectionHeader` both wear `accessibilityRole="header"`, so a role
     * query is ambiguous here — and the claim is structural anyway: is this control a
     * *descendant* of the app bar? The first header in tree order is the app bar.
     */
    const view = await open();
    const appBar = view.root?.queryAll(
      (node) => node.props.accessibilityRole === 'header',
    )[0];

    expect(appBar).toBeDefined();
    expect(
      appBar?.queryAll((node) => node.props.accessibilityLabel === 'Feed mode') ?? [],
    ).toHaveLength(0);
    // And the bell is still in it, untouched.
    expect(
      appBar?.queryAll((node) => /^Notifications/.test(String(node.props.accessibilityLabel))) ??
        [],
    ).not.toHaveLength(0);
  });

  it('is in the content header row instead', async () => {
    const view = await open();
    expect(view.getByLabelText('Feed mode')).toBeTruthy();
    expect(view.getByLabelText('Leaderboard')).toBeTruthy();
  });

  it('leaves the bell reachable in both modes', async () => {
    const view = await open();
    expect(view.getByLabelText(/^Notifications/)).toBeTruthy();

    await toBoard(view);
    expect(view.getByLabelText(/^Notifications/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe('the toggle', () => {
  it('opens on Feed, with the Activity heading and no board', async () => {
    const view = await open();

    expect(view.getByLabelText('Activity')).toBeTruthy();
    expect(view.queryByLabelText('Showing This month')).toBeNull();
  });

  it('switches to the Leaderboard on the trophy', async () => {
    const view = await open();
    await toBoard(view);

    expect(view.queryByLabelText('Activity')).toBeNull();
  });

  it('goes back to the Feed, with the feed untouched', async () => {
    // Founder acceptance: the board replaces the content area rather than being appended
    // to it, so what matters on the way back is that the feed's furniture is where it was.
    const view = await open();
    await toBoard(view);

    await fireEvent.press(view.getByLabelText('Feed'));

    await waitFor(() => expect(view.getByLabelText('Activity')).toBeTruthy());
    expect(view.queryByLabelText('Showing This month')).toBeNull();
  });

  it('does not read the board until it is opened', async () => {
    await open();
    expect(mockRpc.mock.calls.filter(([name]) => name === 'leaderboard')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

/**
 * The two preferences, and the line between them.
 *
 * This is what the founder's §2 is about, and every test here exists because the obvious
 * implementation gets one of the two wrong.
 */
describe('the timeframe, remembered — and the mode, not', () => {
  it('opens the board on This month when nothing has been chosen', async () => {
    const view = await open();
    await toBoard(view);

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('leaderboard', {
        p_metric: 'titles',
        p_timeframe: 'month',
        p_limit: 50,
      }),
    );
  });

  it('offers exactly the two timeframes', async () => {
    // Week and year were ruled out. Asserted as an absence so neither arrives without a
    // decision.
    const view = await open();
    await toBoard(view);
    await fireEvent.press(view.getByLabelText('Showing This month'));

    expect(view.getByText('All time')).toBeTruthy();
    expect(view.queryByText('This week')).toBeNull();
    expect(view.queryByText('This year')).toBeNull();
  });

  it('re-reads the board on All time, and says so in the heading', async () => {
    mockBoard['titles|all_time'] = [entry({ display_name: 'Bea', username: 'bea' })];
    const view = await open();
    await toBoard(view);

    await chooseTimeframe(view, 'This month', 'All time');

    await waitFor(() => expect(view.getByText('Bea')).toBeTruthy());
    expect(mockRpc).toHaveBeenCalledWith('leaderboard', {
      p_metric: 'titles',
      p_timeframe: 'all_time',
      p_limit: 50,
    });
  });

  it('records the choice, so the next visit starts there', async () => {
    const view = await open();
    await toBoard(view);
    await chooseTimeframe(view, 'This month', 'All time');

    await waitFor(() =>
      expect(mockPrefWrites).toContainEqual({ name: TIMEFRAME_KEY, value: 'all_time' }),
    );
  });

  it('keeps All time when the board is left and reopened', async () => {
    const view = await open();
    await toBoard(view);
    await chooseTimeframe(view, 'This month', 'All time');

    await fireEvent.press(view.getByLabelText('Feed'));
    await waitFor(() => expect(view.getByLabelText('Activity')).toBeTruthy());
    await toBoard(view, 'All time');
  });

  /**
   * The pair the founder drew a line between, in one test.
   *
   * A fresh launch opens **Feed** — the mode is not remembered — and tapping Trophy opens
   * on **All time**, because the timeframe is. Getting either half backwards is the
   * mistake this section exists to catch.
   */
  it('opens on Feed after a relaunch, and on the remembered timeframe when asked', async () => {
    const first = await open();
    await toBoard(first);
    await chooseTimeframe(first, 'This month', 'All time');
    // `cleanup()` rather than `unmount()`: the library unmounts every rendered tree again
    // after the test, and one already unmounted by hand makes that pass throw — which
    // breaks the *next* test for a reason that has nothing to do with what it asserts.
    await cleanup();

    const second = await open();

    expect(second.getByLabelText('Activity')).toBeTruthy();
    expect(second.queryByLabelText(/^Showing /)).toBeNull();

    await toBoard(second, 'All time');
  });

  it('records This month again when the reader switches back', async () => {
    mockPrefStore[TIMEFRAME_KEY] = 'all_time';
    const view = await open();
    await toBoard(view, 'All time');

    await chooseTimeframe(view, 'All time', 'This month');

    await waitFor(() =>
      expect(mockPrefWrites).toContainEqual({ name: TIMEFRAME_KEY, value: 'month' }),
    );
  });

  it('ignores a stored value the selector has no option for', async () => {
    mockPrefStore[TIMEFRAME_KEY] = 'this_week';
    const view = await open();
    await toBoard(view);
  });

  it('gives a second account the default rather than the first one’s choice', async () => {
    mockPrefStore[TIMEFRAME_KEY] = 'all_time';
    const view = await open();
    await toBoard(view, 'All time');
    await cleanup();

    mockProfile.id = 'user-2';
    const second = await open();
    await toBoard(second);
  });

  it('falls back to This month when the preference read fails', async () => {
    // A store that refuses should cost the reader their preference, not hand them the
    // previous account's — the cross-account leak `CollectionScreen` records.
    mockPrefStore[TIMEFRAME_KEY] = 'all_time';
    mockPrefFailing.add(TIMEFRAME_KEY);
    const view = await open();
    await toBoard(view);
  });
});

// ---------------------------------------------------------------------------

describe('the metrics', () => {
  it('offers exactly the four, in the founder’s order', async () => {
    const view = await open();
    await toBoard(view);

    for (const label of ['Titles', 'Movies', 'TV', 'Reviews']) {
      expect(view.getByText(label)).toBeTruthy();
    }
    expect(view.queryByText('Watched')).toBeNull();
  });

  it('re-reads the board on a chip, without resetting the timeframe', async () => {
    mockPrefStore[TIMEFRAME_KEY] = 'all_time';
    mockBoard['titles|all_time'] = [entry()];
    mockBoard['reviews|all_time'] = [entry({ username: 'bea', display_name: 'Bea' })];

    const view = await open();
    await toBoard(view, 'All time');
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    await fireEvent.press(view.getByText('Reviews'));

    await waitFor(() => expect(view.getByText('Bea')).toBeTruthy());
    expect(mockRpc).toHaveBeenCalledWith('leaderboard', {
      p_metric: 'reviews',
      p_timeframe: 'all_time',
      p_limit: 50,
    });
  });
});

// ---------------------------------------------------------------------------

describe('the row', () => {
  it('draws rank, name, handle and count', async () => {
    mockBoard['titles|month'] = [entry({ metric_count: 12, rank: 1 })];
    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.getByText('@ada')).toBeTruthy();
    expect(view.getByText('12')).toBeTruthy();
  });

  it('puts Match and its evidence on the second line', async () => {
    mockBoard['titles|month'] = [entry({ match_percent: 91, shared_count: 37 })];
    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByText('91% Match · 37 shared')).toBeTruthy());
  });

  it('says Match TBD, with the count, when there is no score yet', async () => {
    mockBoard['titles|month'] = [entry({ match_percent: null, shared_count: 3 })];
    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByText('Match TBD · 3 shared')).toBeTruthy());
  });

  /**
   * A 100% match with your own catalogue is a tautology, `taste_match` refuses the self
   * case, and an empty `Match TBD · 0 shared` on the row the reader looks at first would
   * be the feature appearing broken. "You" instead.
   */
  it('shows You on the reader’s own row, and never a self-Match', async () => {
    mockBoard['titles|month'] = [
      entry({ user_id: 'user-1', username: 'sai', display_name: 'Sai', is_you: true }),
    ];
    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByText('You')).toBeTruthy());
    expect(view.queryByText(/Match/)).toBeNull();
  });

  it('opens that person’s profile from any part of the row', async () => {
    mockBoard['titles|month'] = [entry({ match_percent: 91, shared_count: 37 })];
    const view = await open();
    await toBoard(view);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    // The whole row is one Pressable, so tapping the *second* line — not the name, the
    // handle or the avatar — must still navigate.
    await fireEvent.press(view.getByText('91% Match · 37 shared'));

    expect(mockPush).toHaveBeenCalledWith('/u/ada');
  });

  it('opens the reader’s own profile from their own row', async () => {
    mockBoard['titles|month'] = [
      entry({ user_id: 'user-1', username: 'sai', display_name: 'Sai', is_you: true }),
    ];
    const view = await open();
    await toBoard(view);
    await waitFor(() => expect(view.getByText('You')).toBeTruthy());

    await fireEvent.press(view.getByText('Sai'));

    expect(mockPush).toHaveBeenCalledWith('/u/sai');
  });

  it('keeps the count when the name and handle are both long', async () => {
    // The count is the other thing this screen is for; a long display name must cost the
    // handle its width, never the number.
    mockBoard['titles|month'] = [
      entry({
        display_name: 'Abisola Oluwaseun Adeyemi-Fitzgerald',
        username: 'abisolaoluwaseunadeyemi',
        metric_count: 64,
      }),
    ];
    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByText('64')).toBeTruthy());
    expect(view.getByText('Abisola Oluwaseun Adeyemi-Fitzgerald')).toBeTruthy();
  });

  it('gives tied people the same rank, as the server reported it', async () => {
    mockBoard['titles|month'] = [
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

  it('pins the reader’s standing when they are past the end of the page', async () => {
    mockBoard['titles|month'] = [entry()];
    mockStanding['titles|month'] = { metric_count: 2, rank: 84, entrants: 96 };

    const view = await open();
    await toBoard(view);

    await waitFor(() =>
      expect(view.getByLabelText('You are number 84 of 96, 2 titles')).toBeTruthy(),
    );
  });

  it('does not pin a second copy of a row already on screen', async () => {
    mockBoard['titles|month'] = [
      entry({ user_id: 'user-1', username: 'sai', display_name: 'Sai', is_you: true }),
    ];
    mockStanding['titles|month'] = { metric_count: 9, rank: 1, entrants: 1 };

    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByText('You')).toBeTruthy());
    expect(view.queryByLabelText(/^You are number/)).toBeNull();
  });

  it('pins nothing for somebody who has done nothing', async () => {
    mockBoard['titles|month'] = [entry()];
    mockStanding['titles|month'] = { metric_count: 0, rank: null, entrants: 1 };

    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.queryByLabelText(/^You are number/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/**
 * **A private account on the board, as a row and not as a profile** (20260902000100).
 *
 * The board used to omit an unapproved private account entirely, count and all. The
 * founder reversed that: a board that silently drops people also lies about where the
 * reader stands, and the account somebody cannot see is often the one they most want to
 * ask to follow.
 *
 * **The privacy is the server's**, and these tests are deliberately written so that they
 * would still fail if it were not. The fixtures carry `viewable: false` with
 * `match_percent` and `shared_count` null, which is exactly what `leaderboard` returns —
 * so what is asserted here is that the screen **draws the absence honestly**, not that it
 * conceals something it was handed. A client that received a real Match for such a row
 * would be reading a server that had stopped enforcing the rule, and no test on this
 * side could tell.
 */
describe('a private account on the board', () => {
  const privateEntry = (over: Record<string, unknown> = {}) =>
    entry({
      user_id: 'u-9',
      username: 'kit',
      display_name: 'Kit',
      visibility: 'private',
      viewable: false,
      match_percent: null,
      shared_count: null,
      ...over,
    });

  it('shows the row, with its position and its count', async () => {
    mockBoard['titles|month'] = [privateEntry({ rank: 2, metric_count: 7 })];
    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByText('Kit')).toBeTruthy());
    expect(view.getByText('@kit')).toBeTruthy();
    // The metric that explains the ranking, which is the one aggregate the founder
    // allowed: a position without a number would already imply a band.
    expect(view.getByText('7')).toBeTruthy();
    expect(view.getByLabelText(/^Number 2, Kit/)).toBeTruthy();
  });

  it('says Private to a screen reader and draws no Match line', async () => {
    mockBoard['titles|month'] = [privateEntry()];
    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByText('Kit')).toBeTruthy());
    expect(view.getByLabelText(/Number 1, Kit, @kit, Private/)).toBeTruthy();

    // Neither form. `Match TBD` would be the wrong sentence as well as the wrong
    // number: it means "not enough overlap yet", which is a fact about two catalogues,
    // and it would invite somebody to wait for a figure that is never coming.
    expect(view.queryByText(/Match/)).toBeNull();
    expect(view.queryByText(/shared/)).toBeNull();
  });

  it('never draws a shared count of zero for a row it cannot see', async () => {
    // The specific defect the hook used to have: `shared_count ?? 0`. Harmless while
    // every row was readable, and a claim about a collection this reader has never been
    // let into once they are not.
    mockBoard['titles|month'] = [privateEntry()];
    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByText('Kit')).toBeTruthy());
    expect(view.queryByText('0 shared')).toBeNull();
  });

  it('routes a tap to the profile, where the locked shell and Follow live', async () => {
    // The same destination as any other row. The shell is what refuses — nothing here
    // decides privacy, and a special case would be a second place for it to be wrong.
    mockBoard['titles|month'] = [privateEntry()];
    const view = await open();
    await toBoard(view);
    await waitFor(() => expect(view.getByText('Kit')).toBeTruthy());

    await fireEvent.press(view.getByText('Kit'));
    expect(mockPush).toHaveBeenCalledWith('/u/kit');
  });

  it('tells the reader where the tap goes before they take it', async () => {
    mockBoard['titles|month'] = [privateEntry()];
    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByText('Kit')).toBeTruthy());
    const row = view.getByLabelText(/Number 1, Kit/);
    expect(row.props.accessibilityHint).toMatch(/private profile/i);
    expect(row.props.accessibilityHint).toMatch(/follow/i);
  });

  it('gives an approved follower of a private account the ordinary row', async () => {
    // Private and viewable: the distinction the two flags exist for. Same visibility as
    // the rows above, opposite treatment, because approval is what Match is computed
    // across — and a client keying off `visibility` alone would get this one wrong.
    mockBoard['titles|month'] = [
      privateEntry({ viewable: true, match_percent: 74, shared_count: 21 }),
    ];
    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByText('74% Match · 21 shared')).toBeTruthy());
    // The lock stays: the account is still private and the profile still asks.
    expect(view.getByLabelText(/Number 1, Kit, @kit, Private/)).toBeTruthy();
  });

  it('marks no lock on a public account, and none on the reader themselves', async () => {
    mockBoard['titles|month'] = [
      entry({ user_id: 'u-1', username: 'ada', display_name: 'Ada', rank: 1 }),
      entry({
        user_id: 'user-1',
        username: 'sai',
        display_name: 'Sai',
        is_you: true,
        visibility: 'private',
        viewable: true,
        rank: 2,
      }),
    ];
    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.queryByLabelText(/Ada, @ada, Private/)).toBeNull();
    // Somebody with a private account knows it is private; a lock on their own row is
    // a label rather than information.
    expect(view.queryByLabelText(/Sai, @sai, Private/)).toBeNull();
  });

  it('counts the private row in the board the pinned standing is measured against', async () => {
    // `entrants` comes from the same population, so the denominator and the list agree.
    // They disagreed in the other direction before and were consistent; both moved.
    mockBoard['titles|month'] = [entry({ rank: 1 }), privateEntry({ rank: 2 })];
    mockStanding['titles|month'] = { metric_count: 1, rank: 3, entrants: 3 };

    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByText('Kit')).toBeTruthy());
    expect(view.getByLabelText('You are number 3 of 3, 1 title')).toBeTruthy();
  });

  it('keeps every row ordinary against a server that has not taken the migration', async () => {
    // The un-relaunched-server case, which is the mirror of the un-relaunched-phone rule
    // this project already follows: no `viewable` column means "as readable as it always
    // was", never "mute the whole board".
    mockBoard['titles|month'] = [entry({ match_percent: 88, shared_count: 12 })];
    delete (mockBoard['titles|month'][0] as Record<string, unknown>).viewable;

    const view = await open();
    await toBoard(view);

    await waitFor(() => expect(view.getByText('88% Match · 12 shared')).toBeTruthy());
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

  it('drops the “yet” on an all-time board, where it would read oddly', async () => {
    mockPrefStore[TIMEFRAME_KEY] = 'all_time';
    const view = await open();
    await toBoard(view, 'All time');

    await waitFor(() => expect(view.getByText('No watches here yet.')).toBeTruthy());
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

// ---------------------------------------------------------------------------

/**
 * **Back out of the board, rather than out of the app** (founder physical bug).
 *
 * Leaderboard is a *mode* of the Feed route, so the navigator had nothing to pop and
 * Android's Back exited bingd. from what the reader experienced as a second screen. The
 * founder's instruction was to fix it without inventing a route, so the assertions here
 * are about the handler's return value: `true` is "consumed", `false` is "carry on as
 * before", and the second is as much of the contract as the first.
 */
describe('the hardware back button', () => {
  it('returns to the Feed from the board, and consumes the press', async () => {
    const view = await open();
    await toBoard(view);

    expect(pressBack()).toBe(true);

    await waitFor(() => expect(view.getByLabelText('Activity')).toBeTruthy());
    expect(view.queryByLabelText('Showing This month')).toBeNull();
  });

  it('leaves the press alone on the Feed, so normal back behaviour is untouched', async () => {
    await open();
    expect(pressBack()).toBe(false);
  });

  it('keeps the remembered timeframe, which is a different preference', async () => {
    // The mode is not persisted and the timeframe is (§2/§6). Leaving the board by Back
    // must not be mistaken for a third thing that resets one of them.
    const view = await open();
    await toBoard(view);
    await chooseTimeframe(view, 'This month', 'All time');

    expect(pressBack()).toBe(true);
    await waitFor(() => expect(view.getByLabelText('Activity')).toBeTruthy());

    await toBoard(view, 'All time');
    expect(view.getByLabelText('Showing All time')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

/**
 * **Re-tapping the Feed tab while the board is showing** (founder, 2026-08-30).
 *
 * The other half of the complaint the hardware-Back handler answers, and the half iOS
 * has: every other tab in this app is its own root, so "press the tab you are on to get
 * back to the top of it" is a habit only this one broke — Leaderboard is a mode of the
 * route, so the press had nothing to pop and left the reader on the board.
 *
 * Both directions are asserted, because the second is what keeps this bounded: a press
 * that arrives while the reader is on *another* tab must change nothing, or coming back
 * to Feed would stop returning you to the board you left.
 */
describe('re-tapping the Feed tab', () => {
  it('returns to the Feed root from the board', async () => {
    const view = await open();
    await toBoard(view);

    pressFeedTab();

    await waitFor(() => expect(view.getByLabelText('Activity')).toBeTruthy());
    expect(view.queryByLabelText('Showing This month')).toBeNull();
  });

  it('changes nothing when the reader is already on the Feed root', async () => {
    const view = await open();
    expect(view.getByLabelText('Activity')).toBeTruthy();

    pressFeedTab();

    await waitFor(() => expect(view.getByLabelText('Activity')).toBeTruthy());
    expect(view.getByLabelText('Feed')).toBeTruthy();
  });

  it('does not leave the board when the press arrives from another tab', async () => {
    // `tabPress` fires for the Feed tab whether or not it was the one showing. Only the
    // already-selected case is this feature; the other is somebody navigating here.
    const view = await open();
    await toBoard(view);
    mockNavigation.focused = false;

    pressFeedTab();

    await waitFor(() => expect(view.getByLabelText('Showing This month')).toBeTruthy());
  });

  it('keeps the remembered timeframe, exactly as Back does', async () => {
    const view = await open();
    await toBoard(view);
    await chooseTimeframe(view, 'This month', 'All time');

    pressFeedTab();
    await waitFor(() => expect(view.getByLabelText('Activity')).toBeTruthy());

    await toBoard(view, 'All time');
    expect(view.getByLabelText('Showing All time')).toBeTruthy();
  });

  it('does not record a second leaderboard view for the return trip', async () => {
    // Leaving the board is not a decision to look at it, whichever way the reader
    // leaves — the same rule the Back handler follows by calling setMode directly.
    const view = await open();
    await toBoard(view);
    const views = () =>
      mockTrack.mock.calls.filter(
        ([event]) => (event as { name: string }).name === 'leaderboard_viewed',
      ).length;
    expect(views()).toBe(1);

    pressFeedTab();
    await waitFor(() => expect(view.getByLabelText('Activity')).toBeTruthy());

    expect(views()).toBe(1);
  });
});

// ---------------------------------------------------------------------------

/**
 * **The content header's left gutter** (founder physical finding).
 *
 * TRENDING NOW was inset and THIS MONTH ▼ was flush against the screen edge, because
 * `SectionHeader` pads itself and a section-sized `MediumSelector` deliberately does
 * not. The assertion is the sum of every horizontal inset from the control up to the
 * root, which is the only version of "where does this sit on the page" that cannot be
 * satisfied by moving the padding somewhere else.
 */
describe('the content header gutter', () => {
  const leftInsetOf = (node: { parent: unknown; props: Record<string, unknown> } | null) => {
    let total = 0;
    let current = node;
    while (current) {
      const style = (StyleSheet.flatten(current.props.style) ?? {}) as ViewStyle;
      total += Number(style.paddingLeft ?? style.paddingHorizontal ?? 0);
      current = current.parent as typeof current;
    }
    return total;
  };

  it('puts the timeframe selector on the page gutter', async () => {
    const view = await open();
    await toBoard(view);

    expect(leftInsetOf(view.getByLabelText('Showing This month'))).toBe(theme.layout.gutter);
  });

  /**
   * The obvious fix — a gutter on the row itself — would have doubled TRENDING NOW to
   * 32, because `SectionHeader` already carries one. So the row stays unpadded on the
   * left and the inset belongs to the board's occupant alone. Read off the toggle,
   * which is in that row in both modes and is the one thing on it that pads itself
   * nowhere.
   */
  it('leaves the row itself unpadded, so the heading opposite is not doubled', async () => {
    const view = await open();
    expect(leftInsetOf(view.getByLabelText('Feed mode'))).toBe(0);

    await toBoard(view);
    expect(leftInsetOf(view.getByLabelText('Feed mode'))).toBe(0);
  });
});
