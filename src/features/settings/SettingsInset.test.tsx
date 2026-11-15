import { waitFor } from '@testing-library/react-native';

import { PADDED_INSETS, SAFE_AREA_TEST_ID, rootPadding } from '@/test-utils/padded-safe-area';
import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screens: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files.
import AccountScreen from '../../../app/settings/account';
import SettingsScreen from '../../../app/settings/index';
import ImportRoute from '../../../app/settings/import';
import PrivacyScreen from '../../../app/settings/privacy';
import EditProfileScreen from '../../../app/settings/profile';
import { ImportScreen } from '@/features/import/ImportScreen';

/**
 * **No doubled top inset under a Settings header** (founder QA, 2026-11-12: an oversized
 * gap between the Settings header and ACCOUNT).
 *
 * Each of these screens declares `headerShown: true`, and the native-stack header has
 * already consumed the status-bar inset, so `Screen`'s default top edge added it a second
 * time below the header. The inbox, Edit Profile and Notification Settings were fixed one
 * at a time; this is the rest of Settings, asserted as the resolved padding rather than as
 * the `edges` array, so the fix cannot be "the prop is right" while the band is still
 * there. See `@/test-utils/padded-safe-area` for the stand-in.
 */
jest.mock('react-native-safe-area-context', () =>
  jest.requireActual('@/test-utils/padded-safe-area').paddedSafeAreaModule(),
);

jest.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    rpc: () => Promise.resolve({ data: null, error: null }),
    storage: {
      from: () => ({
        list: () => Promise.resolve({ data: [], error: null }),
        remove: () => Promise.resolve({ error: null }),
      }),
    },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        single: () => Promise.resolve({ data: { visibility: 'public' }, error: null }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: [], error: null, count: 0 }),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useFocusEffect: () => {},
  useLocalSearchParams: () => ({}),
  useNavigation: () => ({ dispatch: () => {} }),
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  Stack: { Screen: () => null },
}));

jest.mock('expo-router/react-navigation', () => ({ usePreventRemove: () => {} }));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({
    id: 'user-1',
    username: 'sai',
    display_name: 'Sai',
    bio: null,
    avatar_path: null,
    avatarUri: null,
    visibility: 'public',
  }),
  signOut: () => Promise.resolve(),
}));

jest.mock('@/features/profile/AvatarPicker', () => ({ AvatarPicker: () => null }));

describe.each([
  ['Settings', SettingsScreen],
  ['Privacy', PrivacyScreen],
  ['Account & Data', AccountScreen],
  ['Import from', ImportRoute],
  // Already fixed on the base; held here so the five cannot drift apart again.
  ['Edit Profile', EditProfileScreen],
])('the top of %s', (_name, Route) => {
  const padding = async () => {
    const view = await renderWithProviders(<Route />);
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

/**
 * The importer is also the onboarding step, which has no stack header and draws its own
 * chrome inside the same `Screen` — so there, and only there, the top edge is still the
 * screen's. Removing it everywhere would put the onboarding header under the status bar.
 */
describe('the importer as an onboarding step', () => {
  it('still clears the status bar itself, because nothing above it does', async () => {
    const view = await renderWithProviders(
      <ImportScreen
        surface="onboarding"
        chooser
        onboarding={{ header: null, onLeave: () => {} }}
      />,
    );
    await waitFor(() =>
      expect(view.getAllByTestId(SAFE_AREA_TEST_ID).length).toBeGreaterThan(0),
    );
    const style = rootPadding(view);
    expect(style.paddingTop).toBe(PADDED_INSETS.top);
    expect(style.paddingLeft).toBe(PADDED_INSETS.left);
    expect(style.paddingRight).toBe(PADDED_INSETS.right);
  });
});
