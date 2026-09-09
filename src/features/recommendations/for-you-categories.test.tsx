import { fireEvent, waitFor, within } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import RecommendationsScreen from '../../../app/(tabs)/recommendations';

/**
 * **One selector, two categories** — For You is titles only (founder §A16, 2026-09-08).
 *
 * The history in one paragraph, because the shape of this file is the shape of that
 * argument. People shipped as a `SegmentedControl` above the category dropdown, which left
 * the screen asking its one question twice; it became a third option *inside* the dropdown;
 * and on 2026-09-08 it left this screen altogether for the Feed tab, beside Feed and
 * Leaderboard. The reason is not layout: a recommendations screen is not where a new
 * account builds a social graph, and People behind a dropdown here was never going to be
 * where activation happened.
 *
 * So what this file asserts is the two-option control, that **no** trace of People is left
 * on this screen, and that the title-only chrome the People branch used to be hidden from
 * is now unconditional.
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
  useLocalSearchParams: () => ({}),
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
  candidatePool: [
    poolItem('pool-1', 'A Comedy', 'Comedy'),
    poolItem('pool-2', 'A Horror', 'Horror'),
  ],
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
  await waitFor(() => expect(view.getByLabelText(/^Showing /)).toBeTruthy());
  return view;
};

/** The category control is a dropdown: open it, then choose — as Collection's is. */
const choose = async (view: Awaited<ReturnType<typeof open>>, category: string) => {
  await fireEvent.press(view.getByLabelText(/^Showing /));
  await fireEvent.press(view.getByRole('button', { name: new RegExp(`^${category}`) }));
};

/** What the trigger says it is showing, which is the only place the choice is stated. */
const showing = (view: Awaited<ReturnType<typeof open>>) =>
  view.getByLabelText(/^Showing /).props.accessibilityLabel;

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

describe('the one selector', () => {
  /**
   * The removed control, asserted by its absence in three ways: the word, the group
   * label it wore, and the role. `SegmentedControl` is a `radiogroup` of `radio`s, so a
   * screen with no radio on it cannot have grown a second copy of it under another name.
   */
  it('offers no Titles/People strip beside the category control', async () => {
    const view = await open();

    expect(view.queryByText('Titles')).toBeNull();
    expect(view.queryByLabelText('What to look at')).toBeNull();
    expect(view.queryAllByRole('radio')).toHaveLength(0);
  });

  it('offers Movies and TV shows, and nothing else', async () => {
    const view = await open();
    await fireEvent.press(view.getByLabelText(/^Showing /));

    // Matched at the start rather than exactly: the chosen option carries a checkmark,
    // and the glyph is a `Text` node that lands in the accessible name behind the label.
    expect(view.getByRole('button', { name: /^Movies/ })).toBeTruthy();
    expect(view.getByRole('button', { name: /^TV shows/ })).toBeTruthy();
    // §A16. People is a mode of the Feed tab now, and the option that used to open it here
    // is gone rather than hidden — a dropdown row nobody can reach is a dropdown row.
    expect(view.queryByRole('button', { name: /^People/ })).toBeNull();
    // The For You override. Collection lists the rankable unit, which is the season;
    // this wall holds series, and calling them seasons here would name something that is
    // not on screen.
    expect(view.queryByRole('button', { name: /^TV seasons/ })).toBeNull();
  });

  it('opens on Movies and says which one it is showing', async () => {
    const view = await open();

    expect(showing(view)).toBe('Showing Movies');
  });
});

/**
 * **People is gone from this screen** (§A16), and its absence is asserted three ways
 * because there were three places it could have been left behind: the dropdown option, the
 * suggestion lists it drew, and the reads that fed them.
 *
 * The last one is the point. A screen that no longer shows People but still calls
 * `people_mutuals` on every open would be spending a request per launch on a surface that
 * is not there — the kind of thing that survives a move because nothing on screen says it
 * is happening.
 */
describe('People, which is no longer here', () => {
  it('offers no way to reach it and draws none of it', async () => {
    mockRpcResults.people_mutuals = [person({ mutual_count: 3, mutual_names: ['Ben'] })];
    mockRpcResults.people_taste_matches = [
      person({ user_id: 'bo-id', username: 'bo', display_name: 'Bo', match_score: 91 }),
    ];

    const view = await open();
    await waitFor(() =>
      expect(view.getByLabelText(/^Save Inception to watchlist$/)).toBeTruthy(),
    );

    expect(showing(view)).toBe('Showing Movies');
    expect(view.queryByText('Mutuals')).toBeNull();
    expect(view.queryByText('Match')).toBeNull();
    expect(view.queryByText('Ben + 2 more')).toBeNull();
  });

  it('asks the server for no suggestions at all', async () => {
    const view = await open();
    await waitFor(() =>
      expect(view.getByLabelText(/^Save Inception to watchlist$/)).toBeTruthy(),
    );

    const asked = mockRpc.mock.calls.map(([name]) => name);
    expect(asked).not.toContain('people_mutuals');
    expect(asked).not.toContain('people_taste_matches');
  });
});

/**
 * **The title-only controls are unconditional now.**
 *
 * They used to live inside the branch that People was the other half of, and the value of
 * asserting them here is that the branch is gone: a chip that appeared only when the
 * selector was not on People is a chip that can now only fail to appear for a real reason.
 */
describe('the title categories', () => {
  it('still draws the wall and the filter row on Movies', async () => {
    const view = await open();

    await waitFor(() =>
      expect(view.getByLabelText(/^Save Inception to watchlist$/)).toBeTruthy(),
    );
    expect(view.getByText(/^Sent to you/)).toBeTruthy();
    expect(view.getByText('Filters')).toBeTruthy();
  });

  it('still draws them on TV shows', async () => {
    const view = await open();
    await choose(view, 'TV shows');

    await waitFor(() => expect(showing(view)).toBe('Showing TV shows'));
    expect(view.getByLabelText(/^Save Inception to watchlist$/)).toBeTruthy();
    expect(view.getByText(/^Sent to you/)).toBeTruthy();
    expect(view.getByText('Filters')).toBeTruthy();
  });
});

/**
 * **Switching category is not a reset.**
 *
 * The reader's filters and their Sent to you chip are state of the screen rather than of
 * one wall, so moving between Movies and TV shows must leave both alone — a filter that has
 * to be set again after every switch is one nobody sets twice.
 *
 * This used to be asserted across a visit to People, which was the category that drew
 * neither control. People has left the screen (§A16) and the property it was guarding has
 * not, so the same two tests now cross the seam that is still here.
 */
describe('crossing between the two categories', () => {
  it('keeps an applied filter', async () => {
    const view = await open();

    await fireEvent.press(view.getByText('Filters'));
    await waitFor(() => expect(view.getByText('Comedy')).toBeTruthy());
    await fireEvent.press(view.getByText('Comedy'));
    await fireEvent.press(view.getByText('Apply'));
    await waitFor(() => expect(view.getByText('Filters · 1')).toBeTruthy());

    await choose(view, 'TV shows');
    await waitFor(() => expect(showing(view)).toBe('Showing TV shows'));

    expect(view.getByText('Filters · 1')).toBeTruthy();
  });

  it('keeps Sent to you turned on', async () => {
    mockRpcResults.recommendations_to_me = [recommendation()];
    const view = await open();

    await fireEvent.press(view.getByText(/^Sent to you/));
    await waitFor(() => expect(view.getByText('Heat (1995)')).toBeTruthy());

    await choose(view, 'TV shows');
    await waitFor(() => expect(showing(view)).toBe('Showing TV shows'));

    // Still the list rather than the wall, which is what the chip being on means.
    expect(view.getByText('Heat (1995)')).toBeTruthy();
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

});

/**
 * **The top controls are one row, and never two** (founder, physical Android, 2026-09-07).
 *
 * `Sent to you · N`, `Group Picks` and `Filters · N` wrapped onto two rows on a 360pt
 * phone, and the arithmetic does not allow them to fit at footnote size with counts. The
 * row is `nowrap` inside a horizontal scroller now — the same arrangement as the tab row —
 * so on every ordinary phone nothing changes and on a narrow one the row scrolls rather
 * than reflows. This test pins the contract rather than a width: no layout engine runs
 * here, so what can be asserted is that wrapping is structurally impossible and that the
 * overflow has somewhere to go.
 */
describe('the top controls', () => {
  it('are one row that scrolls sideways rather than wrapping', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('Group Picks')).toBeTruthy());

    const row = view.getByTestId('for-you-controls');
    const style = Array.isArray(row.props.style)
      ? Object.assign({}, ...row.props.style)
      : row.props.style;
    expect(style.flexDirection).toBe('row');
    expect(style.flexWrap).toBe('nowrap');

    const scroller = view.getByTestId('for-you-controls-scroller');
    expect(scroller.props.horizontal).toBe(true);
    // All three, in the row, in the founder's order.
    expect(within(row).getByText(/^Sent to you/)).toBeTruthy();
    expect(within(row).getByText('Group Picks')).toBeTruthy();
    expect(within(row).getByText(/^Filters/)).toBeTruthy();
  });
});
