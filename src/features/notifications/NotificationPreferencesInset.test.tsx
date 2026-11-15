import { waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files.
import NotificationPreferencesScreen from '../../../app/settings/notification-preferences';

/**
 * **No doubled top inset on Notification Settings** (founder QA, 2026-11-12), the same fix
 * and the same test as the inbox's (`NotificationsInbox.test.tsx`, *the top of the page*).
 *
 * The screen declares `headerShown: true`, and the native-stack header has already consumed
 * the status-bar inset, so `Screen`'s default top edge added it a second time below the
 * header. Asserted as the resolved padding rather than as the `edges` array, so the fix
 * cannot be "the prop is right" while the band is still there.
 *
 * The real `SafeAreaView` applies its edges natively and produces no padding under Jest;
 * this stand-in pads each declared edge in JavaScript, exactly as the inbox test's does.
 */
const mockInsets = { top: 47, bottom: 24, left: 0, right: 0 };

jest.mock('react-native-safe-area-context', () => {
  const { View: RNView } = jest.requireActual('react-native');
  return {
    SafeAreaProvider: ({ children }: { children: unknown }) => children,
    useSafeAreaInsets: () => mockInsets,
    SafeAreaView: ({
      children,
      edges = ['top', 'bottom', 'left', 'right'],
      style,
      ...rest
    }: {
      children: unknown;
      edges?: readonly string[];
      style?: unknown;
    }) => (
      <RNView
        {...rest}
        testID="screen-safe-area"
        style={[
          style,
          {
            paddingTop: edges.includes('top') ? mockInsets.top : 0,
            paddingBottom: edges.includes('bottom') ? mockInsets.bottom : 0,
            paddingLeft: edges.includes('left') ? mockInsets.left : 0,
            paddingRight: edges.includes('right') ? mockInsets.right : 0,
          },
        ]}
      >
        {children}
      </RNView>
    ),
  };
});

jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: () => Promise.resolve({ data: [], error: null }) },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  Stack: { Screen: () => null },
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

describe('the top of Notification Settings', () => {
  const rootPadding = async () => {
    const view = await renderWithProviders(<NotificationPreferencesScreen />);
    await waitFor(() => expect(view.getByTestId('screen-safe-area')).toBeTruthy());
    return StyleSheet.flatten(view.getByTestId('screen-safe-area').props.style);
  };

  it('adds no second status-bar inset under the header', async () => {
    expect((await rootPadding()).paddingTop).toBe(0);
  });

  it('keeps the horizontal insets, which belong to nobody else', async () => {
    const style = await rootPadding();
    expect(style.paddingLeft).toBe(mockInsets.left);
    expect(style.paddingRight).toBe(mockInsets.right);
  });
});
