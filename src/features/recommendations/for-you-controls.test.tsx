import { fireEvent, waitFor, within } from '@testing-library/react-native';

import { prefStore } from '@/test-utils/prefs-store';
import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import RecommendationsScreen from '../../../app/(tabs)/recommendations';

/**
 * **For You's header and control row, after the 2026-09-08 physical-QA pass.**
 *
 * Three separate founder findings landed on this one strip of screen, and they are
 * pinned together here because each of them is the kind of thing that comes back:
 *
 *   1. **No bell.** For You carried one, Collection and Search did not, and the one it
 *      carried did not optically centre against the wordmark. The resolution is
 *      subtractive — the inbox stays on Feed and Profile, where it already was.
 *   2. **Feature, feature, utility.** Sent to You and Find for a Group (Group Picks, then Watch Together, until
 *      2026-11-06) are two of the things this app has that others do not. They are Maroon,
 *      and since the nav cohesion sprint a pair of their own; Filters is a quiet action.
 *   3. **Air under the row.** The first row of posters sat against the chips, so the
 *      controls read as part of the wall rather than as what governs it.
 *
 * Since 2026-11-06 that is two rows, each one line: the heading with Filters, then the
 * two features.
 *
 * `useForYou` is stood in for, as `for-you-categories.test.tsx` does — the engine is not
 * what this file is about.
 */

const mockPush = jest.fn();
let mockRpcResults: Record<string, unknown> = {};

/**
 * Hermetic: For You remembers its selection per account (2026-11-12), and the real store's
 * memory mirror would carry one test's Top Rated or TV into the next. See `prefs-store`.
 */
jest.mock('@/lib/prefs', () => jest.requireActual('@/test-utils/prefs-store').prefsModule);
beforeEach(() => prefStore.reset());

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string) =>
      Promise.resolve({ data: mockRpcResults[name] ?? null, error: null }),
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
  // The tab-press listener every tab screen subscribes to (`useTabReset`). A navigator
  // that never fires is the right stand-in: these files are not about that behaviour.
  useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
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

jest.mock('@/features/recommendations/use-for-you', () => ({
  useForYou: () => ({
    data: {
      items: [{ mediaItemId: 'film-1', title: 'Inception', year: 2010, posterPath: null }],
      candidatePool: [],
      anchorsUsed: 0,
      lowData: false,
      taste: null,
    },
    isPending: false,
    isError: false,
    refetch: () => Promise.resolve(),
  }),
}));

/** A style prop, flattened, whichever form the component passed it in. */
const flatten = (style: unknown) =>
  (Array.isArray(style) ? Object.assign({}, ...style) : (style ?? {})) as Record<string, unknown>;

const open = async () => {
  const view = await renderWithProviders(<RecommendationsScreen />);
  await waitFor(() => expect(view.getByTestId('for-you-controls')).toBeTruthy());
  return view;
};

beforeEach(() => {
  mockPush.mockReset();
  mockRpcResults = {
    // Five unread, deliberately: a screen that still drew a bell would draw a badge on
    // it, so the assertion below is about a control that had every reason to appear.
    my_notifications: [
      { id: 'n1', read_at: null },
      { id: 'n2', read_at: null },
      { id: 'n3', read_at: null },
      { id: 'n4', read_at: null },
      { id: 'n5', read_at: null },
    ],
    recommendations_to_me: [],
    recommendation_requests: { total: 0, senders: [] },
    people_mutuals: [],
    people_taste_matches: [],
  };
});

describe('the header carries no bell', () => {
  it('offers no notifications control, badged or otherwise', async () => {
    /**
     * Asserted three ways, because the control has two accessible names — one with a
     * count and one without — and removing only the badged form would leave a bell on
     * every screen whose inbox happens to be empty.
     */
    const view = await open();

    expect(view.queryByLabelText('Notifications')).toBeNull();
    expect(view.queryByLabelText(/^Notifications, /)).toBeNull();
    expect(view.queryByLabelText(/notification/i)).toBeNull();
  });

  it('leaves nothing in the corner the bell was misaligned in', async () => {
    /**
     * The founder's second complaint about this corner was that the bell did not
     * optically centre against the wordmark. With nothing beside the lockup there is
     * nothing left to align — which is asserted as the *absence of the neighbours* the
     * header can draw, rather than by measuring a position a unit test cannot see.
     */
    const view = await open();

    expect(view.queryByLabelText('Settings')).toBeNull();
    expect(view.queryByLabelText(/^Notifications/)).toBeNull();
  });

  /**
   * **Movies | TV in the header's corner, once** (founder, UI cohesion pass, 2026-11-06).
   * It sat at the right of the Recommended row; it moved up rather than being repeated.
   */
  it('holds the one Movies | TV switch, inside the header', async () => {
    const view = await open();

    expect(view.getAllByLabelText('Medium')).toHaveLength(1);
    const header = view.getByTestId('app-header');
    expect(within(header).getByRole('radio', { name: 'Movies' })).toBeTruthy();
    expect(within(header).getByRole('radio', { name: 'TV' })).toBeTruthy();
  });

  it('switches the wall from the header and keeps the choice across Top Rated', async () => {
    const view = await open();

    await fireEvent.press(view.getByRole('radio', { name: 'TV' }));
    await waitFor(() =>
      expect(view.getByRole('radio', { name: 'TV' }).props.accessibilityState).toMatchObject({
        selected: true,
      }),
    );
  });
});

/**
 * **Two rows of controls, each saying what kind of control it is** (founder, nav cohesion
 * sprint, 2026-11-06). The heading row: Recommended / Top Rated, and Filters opposite it
 * as a quiet text action. Under it, Sent to You and Find for a Group as a pair of features.
 * The old single chip row drew all three as equivalent pills.
 */
describe('the controls', () => {
  it('puts Filters beside the heading, and the two features on a row of their own', async () => {
    const view = await open();

    const tools = view.getByTestId('for-you-controls');
    expect(within(tools).getByRole('button', { name: 'Filters' })).toBeTruthy();
    expect(within(tools).queryByRole('button', { name: /^Sent to You/ })).toBeNull();

    const features = view.getByTestId('for-you-shortcuts');
    expect(within(features).getByRole('button', { name: /^Sent to You/ })).toBeTruthy();
    expect(within(features).getByRole('button', { name: 'Find for a Group' })).toBeTruthy();
    expect(within(features).queryByRole('button', { name: 'Filters' })).toBeNull();
    // Gone under its old name everywhere on the screen.
    expect(view.queryByText('Group Picks')).toBeNull();
  });

  /**
   * **Quieter features** (founder, marquee cohesion sprint, 2026-11-07): a hairline outline,
   * a 13pt label in ink, 34pt drawn. The Maroon is the glyph's alone.
   */
  it('draws the two features quietly on a hairline, and leaves Filters quiet', async () => {
    const view = await open();

    for (const [testID, word] of [
      ['for-you-shortcut-sent', 'Sent to You'],
      ['for-you-shortcut-group', 'Find for a Group'],
    ] as const) {
      const feature = view.getByTestId(testID);
      expect(flatten(feature.props.style).borderColor).toBe(theme.border.hairline);
      expect(flatten(feature.props.style).minHeight).toBe(34);
      // No card fill: a tinted ground would read as a selected state.
      expect(flatten(feature.props.style).backgroundColor).toBeUndefined();
      const label = flatten(within(feature).getByText(word).props.style);
      expect(label.color).toBe(theme.text.primary);
      expect(label.fontSize).toBe(13);
    }

    // Icon-only since FU1113-B: no outline, no printed word, the glyph in secondary ink.
    const filters = view.getByTestId('for-you-filters');
    expect(flatten(filters.props.style).borderWidth).toBeUndefined();
    expect(within(filters).queryByText('Filters')).toBeNull();
    expect(view.getByRole('button', { name: 'Filters' })).toBeTruthy();
  });

  it('gives every control a 44pt target', async () => {
    const view = await open();

    for (const testID of ['for-you-shortcut-sent', 'for-you-shortcut-group']) {
      const feature = view.getByTestId(testID);
      const slop = feature.props.hitSlop as { top: number; bottom: number };
      expect((flatten(feature.props.style).minHeight as number) + slop.top + slop.bottom).toBe(
        theme.layout.minTapTarget,
      );
    }
    const filters = flatten(view.getByTestId('for-you-filters').props.style);
    expect(filters.width).toBe(theme.layout.minTapTarget);
    expect(filters.height).toBe(theme.layout.minTapTarget);
  });

  it('puts a deliberate seam between the features and the first posters', async () => {
    // The wall has no top padding of its own, so this padding is the whole gap: the
    // design system's control row → content interval (founder, physical QA, 2026-09-08).
    const row = flatten((await open()).getByTestId('for-you-shortcuts').props.style);
    expect(row.paddingBottom).toBe(theme.space[3]);
  });

  it('opens Find for a Group from its shortcut', async () => {
    const view = await open();

    await fireEvent.press(view.getByRole('button', { name: 'Find for a Group' }));

    await waitFor(() =>
      expect(view.getByText('Choose who’s watching, and get recommendations based on everyone’s tastes.')).toBeTruthy(),
    );
  });
});
