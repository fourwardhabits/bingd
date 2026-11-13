import type { ReactNode } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

/**
 * **A `SafeAreaView` that pads its edges in JavaScript, so a test can read the inset.**
 *
 * The real one applies its edges natively and produces no padding under Jest, which is how
 * a doubled top inset under a native-stack header shipped on screen after screen without a
 * test noticing (founder QA, 2026-11-12). This stand-in pads each declared edge from
 * `PADDED_INSETS`, exactly as the inbox's and Notification Settings' tests do
 * (`NotificationsInbox.test.tsx`, `NotificationPreferencesInset.test.tsx`).
 *
 * The side insets are not zero on purpose: a landscape iPhone has them, and "keeps the
 * horizontal insets" is only an assertion if there is something to keep.
 *
 * Used from a `jest.mock` factory, which may only reach outside itself through `require`:
 *
 *     jest.mock('react-native-safe-area-context', () =>
 *       jest.requireActual('@/test-utils/padded-safe-area').paddedSafeAreaModule(),
 *     );
 */
export const PADDED_INSETS = { top: 47, bottom: 34, left: 12, right: 16 } as const;

/** The testID every padded root carries. */
export const SAFE_AREA_TEST_ID = 'screen-safe-area';

export function paddedSafeAreaModule() {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const insets = PADDED_INSETS;
  return {
    SafeAreaProvider: ({ children }: { children: unknown }) => children,
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
    initialWindowMetrics: { frame: { x: 0, y: 0, width: 390, height: 844 }, insets },
    SafeAreaView: ({
      children,
      edges = ['top', 'bottom', 'left', 'right'],
      style,
      ...rest
    }: {
      children: ReactNode;
      edges?: readonly string[];
      style?: StyleProp<ViewStyle>;
    }) => (
      <View
        {...rest}
        testID={SAFE_AREA_TEST_ID}
        style={[
          style,
          {
            paddingTop: edges.includes('top') ? insets.top : 0,
            paddingBottom: edges.includes('bottom') ? insets.bottom : 0,
            paddingLeft: edges.includes('left') ? insets.left : 0,
            paddingRight: edges.includes('right') ? insets.right : 0,
          },
        ]}
      >
        {children}
      </View>
    ),
  };
}

/** The resolved padding of the outermost padded root a screen rendered. */
export function rootPadding(view: {
  getAllByTestId: (id: string) => { props: { style?: StyleProp<ViewStyle> } }[];
}): ViewStyle {
  const [root] = view.getAllByTestId(SAFE_AREA_TEST_ID);
  if (!root) throw new Error('the screen rendered no safe-area root');
  return StyleSheet.flatten(root.props.style);
}
