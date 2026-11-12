import { waitFor } from '@testing-library/react-native';

import { PADDED_INSETS, SAFE_AREA_TEST_ID, rootPadding } from '@/test-utils/padded-safe-area';
import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files.
import ActivityScreen from '../../../app/activity/[id]';

/**
 * **No doubled top inset under the Comments header** (founder QA, 2026-11-12), the Settings
 * root's fix on the screen a comment notification lands on. It declares
 * `headerShown: true`, as does the root layout's `activity/[id]`, and the native-stack
 * header has already consumed the status-bar inset. See `@/test-utils/padded-safe-area`.
 */
jest.mock('react-native-safe-area-context', () =>
  jest.requireActual('@/test-utils/padded-safe-area').paddedSafeAreaModule(),
);

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: 'event-1' }),
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    back: () => {},
    canGoBack: () => true,
  }),
}));

jest.mock('@/features/auth', () => ({
  useAuth: () => ({
    status: 'ready',
    userId: 'viewer-1',
    profile: { id: 'viewer-1', username: 'sai', display_name: 'Sai', avatarUri: null },
  }),
}));

jest.mock('@/features/collection/use-watched', () => ({
  useWatched: () => ({ data: new Set<string>() }),
  shouldMask: () => false,
}));

// Still loading: the inset is the `Screen`'s, whatever the body is showing.
jest.mock('@/features/feed/use-feed', () => ({
  useActivityEvent: () => ({
    data: undefined,
    isPending: true,
    isError: false,
    refetch: () => {},
  }),
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    rpc: () => Promise.resolve({ data: [], error: null }),
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => 'operation-1' }));

describe('the top of Comments', () => {
  const padding = async () => {
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() =>
      expect(view.getAllByTestId(SAFE_AREA_TEST_ID).length).toBeGreaterThan(0),
    );
    return rootPadding(view);
  };

  it('adds no second status-bar inset under the header', async () => {
    expect((await padding()).paddingTop).toBe(0);
  });

  it('keeps the horizontal insets, which belong to nobody else', async () => {
    const style = await padding();
    expect(style.paddingLeft).toBe(PADDED_INSETS.left);
    expect(style.paddingRight).toBe(PADDED_INSETS.right);
  });
});
