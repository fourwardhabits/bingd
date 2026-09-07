import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import RecommendationsScreen from '../../../app/(tabs)/recommendations';

/**
 * **Two primary media tabs, and People beside them rather than among them** (founder
 * addendum, 2026-09-06).
 *
 * People shipped as a `SegmentedControl` above the category dropdown, which left the
 * screen asking its one question twice: a Titles/People strip, and under it a
 * Movies/TV shows control that only meant anything on one side of the strip. Two
 * selectors stacked in a header is a reader working out which one owns which, so People
 * is now a third option in the control that was already there.
 *
 * What is asserted here is the shape of that control and the two things the change could
 * plausibly have broken: that People still draws the discovery lists and none of the
 * title-only chrome, and that a visit to People does not throw away the filter or the
 * Sent to you state the reader had set on the title side.
 *
 * `useForYou` is stood in for, as `SentToYou.test.tsx` does — the engine is not what
 * this file is about, and `for-you-stability.test.tsx` is the file that exercises the
 * real query.
 */

const mockPush = jest.fn();
const mockRpc = jest.fn();
let mockRpcResults: Record<string, unknown> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      return Promise.resolve({ data: mockRpcResults[name] ?? null, error: null });
    },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        gt: () => chain,
        in: () => chain,
        limit: () => chain,
        order: () => chain,
        then: (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null }),
      };
      return chain;
    },
  },
}));

jest.mock('expo-router', () => ({
  useFocusEffect: () => {},
  useRouter: () => ({ push: mockPush, replace: () => {}, back: () => {} }),
  Stack: { Screen: () => null },
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => 'operation-id' }));

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
 * One title on the wall and two genres in the pool, which is everything these tests ask
 * of the engine: something to see in the title modes, and something for the filter sheet
 * to offer.
 */
const poolItem = (id: string, title: string, genre: string) => ({
  mediaItemId: id,
  title,
  seriesTitle: null,
  kind: 'movie',
  year: 2010,
  posterPath: null,
  genres: [genre],
  language: 'en',
  runtimeMinutes: null,
  score: null,
  bucket: null,
  watchedOn: null,
});

const mockSlate = {
  items: [{ mediaItemId: 'film-1', title: 'Inception', year: 2010, posterPath: null }],
  candidatePool: [poolItem('pool-1', 'A Comedy', 'Comedy'), poolItem('pool-2', 'A Horror', 'Horror')],
  anchorsUsed: 0,
  lowData: true,
  taste: null,
};

jest.mock('@/features/recommendations/use-for-you', () => ({
  useForYou: () => ({
    data: mockSlate,
    isPending: false,
    isError: false,
    refetch: () => Promise.resolve(),
  }),
}));

const person = (over: Record<string, unknown> = {}) => ({
  user_id: 'anna-id',
  username: 'anna',
  display_name: 'Anna',
  avatar_path: null,
  visibility: 'public',
  ...over,
});

const recommendation = () => ({
  id: 'r1',
  sender_id: 'user-2',
  sender_username: 'ada',
  sender_display_name: 'Ada',
  sender_avatar_path: null,
  media_item_id: 'film-9',
  media_kind: 'movie',
  media_title: 'Heat',
  series_title: null,
  poster_path: null,
  release_date: '1995-12-15',
  genres: ['Comedy'],
  original_language: 'en',
  runtime_minutes: 170,
  recommended_at: '2026-08-15T10:00:00.000Z',
  opened_at: null,
});

const open = async () => {
  const view = await renderWithProviders(<RecommendationsScreen />);
  await waitFor(() => expect(view.getByRole('tab', { name: 'Movies' })).toBeTruthy());
  return view;
};

/**
 * The media control is a visible tab row (founder addendum, 2026-09-06) — one press,
 * both options always on screen, the same control Collection leads with.
 */
const choose = async (view: Awaited<ReturnType<typeof open>>, medium: 'Movies' | 'TV shows') => {
  await fireEvent.press(view.getByRole('tab', { name: medium }));
};

/** People is a chip in the utility row now, not a third tab. */
const openPeople = async (view: Awaited<ReturnType<typeof open>>) => {
  await fireEvent.press(view.getByText('People'));
};

/**
 * What the screen is showing.
 *
 * The dropdown announced itself — a closed control has to say what it is closed on. The
 * tab row says it structurally: both options visible, one carrying
 * `accessibilityState.selected`. People is not one of them, so it is read off the chip.
 */
const showing = (view: Awaited<ReturnType<typeof open>>): string => {
  if (view.queryByText('Mutuals')) return 'People';
  for (const name of ['Movies', 'TV shows'] as const) {
    if (view.getByRole('tab', { name }).props.accessibilityState?.selected) return name;
  }
  throw new Error('no media tab is selected');
};

beforeEach(() => {
  mockPush.mockReset();
  mockRpc.mockReset();
  mockRpcResults = {
    my_notifications: [],
    recommendations_to_me: [],
    recommendation_requests: { total: 0, senders: [] },
    people_mutuals: [],
    people_taste_matches: [],
  };
});

describe('the primary media tabs', () => {
  /**
   * The removed control, asserted by its absence in three ways: the word, the group
   * label it wore, and the role. `SegmentedControl` is a `radiogroup` of `radio`s, so a
   * screen with no radio on it cannot have grown a second copy of it under another name.
   */
  it('offers no Titles/People strip beside the media tabs', async () => {
    const view = await open();

    expect(view.queryByText('Titles')).toBeNull();
    expect(view.queryByLabelText('What to look at')).toBeNull();
    expect(view.queryAllByRole('radio')).toHaveLength(0);
  });

  it('offers exactly two, and People is not one of them', async () => {
    /**
     * **The founder's addendum, as an assertion.** Movies and TV switch the primary
     * media universe, so they are visible peer tabs. People is a different *kind* of
     * answer to "what next" rather than a different kind of title, so making it a third
     * tab made it a peer of the media universe — which it is not. It is a chip below.
     */
    const view = await open();

    expect(view.getByRole('tab', { name: 'Movies' })).toBeTruthy();
    expect(view.getByRole('tab', { name: 'TV shows' })).toBeTruthy();
    expect(view.queryByRole('tab', { name: 'People' })).toBeNull();
    // The For You override. Collection lists the rankable unit, which is the season;
    // this wall holds series, and calling them seasons here would name something that is
    // not on screen.
    expect(view.queryByRole('tab', { name: 'TV seasons' })).toBeNull();
  });

  it('opens on Movies, with both sides visible rather than one behind a sheet', async () => {
    const view = await open();

    expect(showing(view)).toBe('Movies');
    // The point of the change: the other side is readable without touching anything.
    expect(view.getByRole('tab', { name: 'TV shows' })).toBeTruthy();
  });
});

describe('People', () => {
  it('draws the discovery modes', async () => {
    mockRpcResults.people_mutuals = [person({ mutual_count: 3, mutual_names: ['Ben'] })];
    mockRpcResults.people_taste_matches = [
      person({ user_id: 'bo-id', username: 'bo', display_name: 'Bo', match_score: 91 }),
    ];

    const view = await open();
    await openPeople(view);

    // The two discovery modes as chips — Mutuals showing, Matches one press away.
    await waitFor(() => expect(view.getByText('Ben + 2 more')).toBeTruthy());
    expect(view.getByText('Matches')).toBeTruthy();
    expect(showing(view)).toBe('People');
  });

  it('keeps its own chip on screen, so the way in is also the way out', async () => {
    // A mode whose only exit is a *different* mode is a trap. The chip stays, selected,
    // and pressing it again returns to the wall the reader left.
    mockRpcResults.people_mutuals = [person({ mutual_count: 3, mutual_names: ['Ben'] })];
    const view = await open();

    await openPeople(view);
    await waitFor(() => expect(view.getByText('Ben + 2 more')).toBeTruthy());

    await fireEvent.press(view.getByText('People'));
    await waitFor(() => expect(view.getByLabelText(/^Save Inception to watchlist$/)).toBeTruthy());
  });

  it('is left behind by choosing a media tab, because that plainly means "show me films"', async () => {
    mockRpcResults.people_mutuals = [person({ mutual_count: 3, mutual_names: ['Ben'] })];
    const view = await open();

    await openPeople(view);
    await waitFor(() => expect(view.getByText('Ben + 2 more')).toBeTruthy());

    await choose(view, 'TV shows');
    await waitFor(() => expect(showing(view)).toBe('TV shows'));
  });

  /**
   * A chip that narrows a wall of films, over a list of people, would be a control with
   * nothing to act on. All four sit inside the title branch, so this is really an
   * assertion that the branch is drawn from the selector and not from something that can
   * drift away from it.
   */
  it('draws none of the title-only controls', async () => {
    mockRpcResults.people_mutuals = [person({ mutual_count: 3, mutual_names: ['Ben'] })];
    mockRpcResults.recommendations_to_me = [recommendation()];

    const view = await open();
    await waitFor(() => expect(view.getByText(/^Sent to you/)).toBeTruthy());
    await openPeople(view);

    await waitFor(() => expect(view.getByText('Ben + 2 more')).toBeTruthy());
    expect(view.queryByText(/^Sent to you/)).toBeNull();
    expect(view.queryByText(/^Filters/)).toBeNull();
    expect(view.queryByText('Refresh')).toBeNull();
    expect(view.queryByText('Clear all')).toBeNull();
    // The wall itself, which is the largest thing that would otherwise be left under a
    // heading that says Mutuals.
    expect(view.queryByLabelText(/^Save Inception to watchlist$/)).toBeNull();
  });
});

describe('the title categories', () => {
  it('still draws the wall and the filter row on Movies', async () => {
    const view = await open();

    await waitFor(() => expect(view.getByLabelText(/^Save Inception to watchlist$/)).toBeTruthy());
    expect(view.getByText(/^Sent to you/)).toBeTruthy();
    expect(view.getByText('Filters')).toBeTruthy();

  });

  it('still draws them on TV shows', async () => {
    const view = await open();
    await choose(view, 'TV shows');

    await waitFor(() => expect(showing(view)).toBe('TV shows'));
    expect(view.getByLabelText(/^Save Inception to watchlist$/)).toBeTruthy();
    expect(view.getByText(/^Sent to you/)).toBeTruthy();
    expect(view.getByText('Filters')).toBeTruthy();

  });
});

/**
 * **A look at People is not a reset.**
 *
 * The reader's filters and their Sent to you chip are state of the screen rather than of
 * the wall, so a category that has neither must leave both alone — a filter that has to
 * be set again after every glance at a suggestion list is one nobody sets twice.
 */
describe('coming back from People', () => {
  it('keeps an applied filter', async () => {
    const view = await open();

    await fireEvent.press(view.getByText('Filters'));
    await waitFor(() => expect(view.getByText('Comedy')).toBeTruthy());
    await fireEvent.press(view.getByText('Comedy'));
    await fireEvent.press(view.getByText('Apply'));
    await waitFor(() => expect(view.getByText('Filters · 1')).toBeTruthy());

    await openPeople(view);
    await waitFor(() => expect(view.queryByText('Filters · 1')).toBeNull());
    await choose(view, 'Movies');

    await waitFor(() => expect(view.getByText('Filters · 1')).toBeTruthy());
  });

  it('keeps Sent to you turned on', async () => {
    mockRpcResults.recommendations_to_me = [recommendation()];
    const view = await open();

    await fireEvent.press(view.getByText(/^Sent to you/));
    await waitFor(() => expect(view.getByText('Heat (1995)')).toBeTruthy());

    await openPeople(view);
    await waitFor(() => expect(view.queryByText('Heat (1995)')).toBeNull());
    await choose(view, 'Movies');

    // Still the list rather than the wall, which is what the chip being on means.
    await waitFor(() => expect(view.getByText('Heat (1995)')).toBeTruthy());
  });
});

/**
 * **Group Picks is an action chip, not a mode.** It sits in the same wrapping chip row,
 * opens a sheet, and belongs to the title categories only — People has no medium for a
 * group to pick over. The flow itself is exercised in `GroupPicksSheet.test.tsx`; what
 * this file owns is the entry point.
 */
describe('the Group Picks chip', () => {
  it('sits in the chip row and opens the flow', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('Group Picks')).toBeTruthy());

    await fireEvent.press(view.getByText('Group Picks'));
    await waitFor(() => expect(view.getByText("Who's watching?")).toBeTruthy());
  });

  it('is absent on People', async () => {
    mockRpcResults.people_mutuals = [person({ mutual_count: 3, mutual_names: ['Ben'] })];
    const view = await open();
    await openPeople(view);
    await waitFor(() => expect(view.getByText('Ben + 2 more')).toBeTruthy());
    expect(view.queryByText('Group Picks')).toBeNull();
  });
});
