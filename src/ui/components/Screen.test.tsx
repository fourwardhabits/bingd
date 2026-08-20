import { render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Screen } from './Screen';

const mockInsets = { top: 47, bottom: 24, left: 0, right: 0 };

jest.mock('react-native-safe-area-context', () => {
  const { View: RNView } = jest.requireActual('react-native');
  return {
    SafeAreaView: ({ children, ...rest }: { children: ReactNode }) => (
      <RNView {...rest}>{children}</RNView>
    ),
    useSafeAreaInsets: () => mockInsets,
  };
});

beforeEach(() => {
  mockInsets.bottom = 24;
});

/**
 * The padding on the view wrapping the children, reached through a child rather
 * than through a testID added to the source for this test's benefit.
 */
const bottomPaddingOf = async (props: Record<string, unknown> = {}) => {
  const view = await render(
    <Screen {...props}>
      <View testID="marker" />
    </Screen>,
  );
  const content = view.getByTestId('marker').parent;
  return StyleSheet.flatten(content?.props.style).paddingBottom;
};

describe('the bottom edge', () => {
  it('adds nothing under a tab screen', async () => {
    // The tab bar is already sized to the safe-area inset and paints its
    // surface behind the Android navigation buttons. Padding here on top of
    // that leaves a strip of Paper that content is clipped at rather than
    // scrolling under — the band the system nav bar appeared to sit on.
    expect(await bottomPaddingOf()).toBe(0);
  });

  it('clears the inset on a screen with nothing beneath it', async () => {
    expect(await bottomPaddingOf({ includeBottomInset: true })).toBe(24);
  });

  it('keeps a minimum where the inset is zero', async () => {
    // An older device with no gesture bar still needs content off the glass.
    mockInsets.bottom = 0;
    expect(await bottomPaddingOf({ includeBottomInset: true })).toBe(16);
  });
});
