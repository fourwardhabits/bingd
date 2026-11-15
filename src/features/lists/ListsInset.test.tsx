import { waitFor } from '@testing-library/react-native';

import { PADDED_INSETS, SAFE_AREA_TEST_ID, rootPadding } from '@/test-utils/padded-safe-area';
import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screens: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files.
import ListScreen from '../../../app/lists/[id]';
import ProfileListsScreen from '../../../app/lists/by/[userId]';

/**
 * **No doubled top inset under a lists header** (founder QA, 2026-11-12), the Settings
 * root's fix on the two list routes the root layout gives a native-stack header.
 *
 *   - `lists/by/[userId]` (someone's lists, from a profile's `See all`) always shows it.
 *   - `lists/[id]` shows it until the list has loaded, when the page hides it and draws
 *     its own bar over the hero (`edges={[]}`, unchanged). So the loading skeleton and
 *     *List unavailable* are the two states that had the band.
 *
 * See `@/test-utils/padded-safe-area` for the stand-in.
 */
jest.mock('react-native-safe-area-context', () =>
  jest.requireActual('@/test-utils/padded-safe-area').paddedSafeAreaModule(),
);

/** `pending` holds `list_view` open forever, so the screen stays on its skeleton. */
let mockListView: 'pending' | null = 'pending';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (fn: string) =>
      fn === 'list_view' && mockListView === 'pending'
        ? new Promise(() => {})
        : Promise.resolve({ data: fn === 'list_view' ? null : [], error: null }),
    from: () => {
      const chain: Record<string, unknown> = {
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
      };
      for (const method of ['select', 'eq', 'in', 'gt', 'lt', 'gte', 'order', 'limit', 'or']) {
        chain[method] = () => chain;
      }
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('@/lib/analytics', () => ({ track: () => {} }));

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: () => {}, back: () => {} }),
  useLocalSearchParams: () => ({ id: 'list-1', userId: 'them', name: 'Maya' }),
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({
    id: 'user-1',
    username: 'sai',
    display_name: 'Sai',
    avatar_path: null,
    avatarUri: null,
    visibility: 'public',
  }),
}));

const padding = async (element: React.ReactElement, ready?: RegExp) => {
  const view = await renderWithProviders(element);
  await waitFor(() => {
    expect(view.getAllByTestId(SAFE_AREA_TEST_ID).length).toBeGreaterThan(0);
    if (ready) expect(view.getByText(ready)).toBeTruthy();
  });
  return rootPadding(view);
};

const expectHeaderOwnsTheTop = (style: ReturnType<typeof rootPadding>) => {
  expect(style.paddingTop).toBe(0);
  expect(style.paddingLeft).toBe(PADDED_INSETS.left);
  expect(style.paddingRight).toBe(PADDED_INSETS.right);
};

describe("the top of someone's lists", () => {
  it('adds no second status-bar inset under the header, and keeps the sides', async () => {
    expectHeaderOwnsTheTop(await padding(<ProfileListsScreen />));
  });
});

describe('the top of a list that has not loaded', () => {
  it('adds no second inset under the header while the list is loading', async () => {
    mockListView = 'pending';
    expectHeaderOwnsTheTop(await padding(<ListScreen />));
  });

  it('adds none on List unavailable either', async () => {
    mockListView = null;
    expectHeaderOwnsTheTop(await padding(<ListScreen />, /List unavailable/));
  });
});
