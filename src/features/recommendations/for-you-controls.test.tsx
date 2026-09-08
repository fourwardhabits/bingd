import { waitFor, within } from '@testing-library/react-native';

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
 *   2. **Feature, feature, utility.** Sent to you and Group Picks are two of the things
 *      this app has that others do not, and they were drawn in exactly the grey of the
 *      Filters button beside them. They are Maroon now; Filters is not.
 *   3. **Air under the row.** The first row of posters sat against the chips, so the
 *      controls read as part of the wall rather than as what governs it.
 *
 * And the standing constraint all three had to respect: the row is **one line, always**.
 * It never wraps and it never gets taller.
 *
 * `useForYou` is stood in for, as `for-you-categories.test.tsx` does — the engine is not
 * what this file is about.
 */

const mockPush = jest.fn();
let mockRpcResults: Record<string, unknown> = {};

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
});

describe('the control row', () => {
  it('keeps its three controls on one line and never wraps', async () => {
    /**
     * **The founder's standing lock on this row.** Three chips with counts come to more
     * than a 360pt phone has between its gutters, so the row is a horizontal scroller
     * with `nowrap` inside it: when the chips fit, nothing about the layout differs from
     * a plain row, and when they do not, the row scrolls rather than becoming two lines
     * and pushing the wall down.
     *
     * Compaction was considered first and rejected: every value in the chip is already
     * on the 4pt scale, and buying back the sixteen points the arithmetic is short would
     * mean taking the chip off the grid the design system is built on.
     */
    const view = await open();

    const row = flatten(view.getByTestId('for-you-controls').props.style);
    expect(row.flexDirection).toBe('row');
    expect(row.flexWrap).toBe('nowrap');
    // And the thing that makes one row possible at every width.
    expect(view.getByTestId('for-you-controls-scroller').props.horizontal).toBe(true);
  });

  it('puts a deliberate seam between the controls and the first posters', async () => {
    /**
     * The wall has no top padding of its own, so this padding is the entire gap — and at
     * `space[2]` the founder's device showed posters touching the chips. `space[4]` is
     * the top of the design system's *control row → the content it governs* interval.
     */
    const row = flatten((await open()).getByTestId('for-you-controls').props.style);

    expect(row.paddingBottom).toBe(theme.space[4]);
    expect(row.paddingBottom).toBeGreaterThanOrEqual(theme.space[3]);
  });

  it('marks the two social features and leaves the utility grey', async () => {
    /**
     * **Feature, feature, utility** — the founder's hierarchy, and the whole of it. Read
     * off the border and the label colour together, because those are the two things the
     * treatment actually changes; the glyph follows the same `action` flag in the
     * component, so a divergence there would be a divergence in one expression.
     */
    const view = await open();

    for (const name of ['Sent to you', 'Group Picks']) {
      const chip = view.getByRole('button', { name });
      expect(flatten(chip.props.style).borderColor).toBe(theme.semantic.actionSubtle);
      expect(flatten(within(chip).getByText(name).props.style).color).toBe(
        theme.semantic.action,
      );
    }

    const filters = view.getByRole('button', { name: 'Filters' });
    expect(flatten(filters.props.style).borderColor).toBe(theme.border.hairline);
    expect(flatten(within(filters).getByText('Filters').props.style).color).toBe(
      theme.text.secondary,
    );
  });

  it('spends no extra height on the emphasis', async () => {
    /**
     * The founder's constraint was explicit: no giant coloured buttons, no cards, no
     * second row, no growth. Emphasis is colour and nothing else, so an emphasised chip
     * and a plain one are the same height to the pixel.
     */
    const view = await open();

    const social = flatten(view.getByRole('button', { name: 'Group Picks' }).props.style);
    const utility = flatten(view.getByRole('button', { name: 'Filters' }).props.style);

    expect(social.minHeight).toBe(utility.minHeight);
    expect(social.paddingHorizontal).toBe(utility.paddingHorizontal);
    expect(social.borderWidth).toBe(utility.borderWidth);
    // No fill either: a tinted ground here would read as a third selected state.
    expect(social.backgroundColor).toBe(utility.backgroundColor);
  });
});
