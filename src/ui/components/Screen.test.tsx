import { act, render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Keyboard, StyleSheet, View } from 'react-native';

import { Screen } from './Screen';

const mockInsets = { top: 47, bottom: 24, left: 0, right: 0 };
/** What the window reported before the first render, which no keyboard can move. */
const mockMetrics = { insets: { top: 47, bottom: 34, left: 0, right: 0 } };

jest.mock('react-native-safe-area-context', () => {
  const { View: RNView } = jest.requireActual('react-native');
  return {
    SafeAreaView: ({ children, ...rest }: { children: ReactNode }) => (
      <RNView {...rest}>{children}</RNView>
    ),
    useSafeAreaInsets: () => mockInsets,
    get initialWindowMetrics() {
      return mockMetrics;
    },
  };
});

beforeEach(() => {
  mockInsets.bottom = 24;
  listeners.clear();
  jest
    .spyOn(Keyboard, 'addListener')
    .mockImplementation(((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener);
      return { remove: () => listeners.delete(event) };
    }) as never);
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

/**
 * **The keyboard, captured rather than simulated**, which is the pattern
 * `ActivityScreen.test.tsx` already sets: `Keyboard` is a `NativeEventEmitter` with no
 * public emit and no native side under Jest, so the test takes the listener the hook
 * registered and hands it the frame the platform would have sent.
 *
 * Both event pairs are captured because the hook picks its pair from `Platform.OS`, and
 * this assertion is about neither platform in particular.
 */
const listeners = new Map<string, (payload: unknown) => void>();

const fire = (names: string[], payload: unknown) =>
  act(() => {
    const name = names.find((candidate) => listeners.has(candidate));
    if (!name) throw new Error('the screen subscribed to no keyboard event');
    listeners.get(name)!(payload);
  });

const keyboard = (height: number) =>
  height > 0
    ? fire(['keyboardWillShow', 'keyboardDidShow'], { endCoordinates: { height } })
    : fire(['keyboardWillHide', 'keyboardDidHide'], {});

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

/**
 * **A page does not resize because something in front of it opened a keyboard**
 * (founder, physical iOS 1.0.1 build 8).
 *
 * The title page behind the review sheet jumped downward while the composer was being
 * typed into and jumped back afterwards. The only keyboard-reactive input to that page's
 * geometry is this padding: iOS drops the home indicator from `safeAreaInsets.bottom`
 * while the keyboard covers it, Android under edge-to-edge reports the IME there, and
 * either way the scroll view was resized underneath a reader who was not touching it.
 *
 * The whole trace is in `use-stable-bottom-inset.ts`. What is asserted here is the
 * property: the number does not move for a keyboard, and it does move for a real change
 * once the keyboard is gone.
 */
describe('while a keyboard is up in front of the screen', () => {
  const openWith = async (props: Record<string, unknown> = {}) => {
    const view = await render(
      <Screen {...props}>
        <View testID="marker" />
      </Screen>,
    );
    const read = () =>
      StyleSheet.flatten(view.getByTestId('marker').parent?.props.style).paddingBottom;
    return { view, read };
  };

  it('ignores iOS dropping the home indicator under the keyboard', async () => {
    const { read } = await openWith({ includeBottomInset: true });
    expect(read()).toBe(24);

    // The device's own report while the keyboard covers the home indicator.
    mockInsets.bottom = 0;
    await keyboard(291);

    // The window's launch metric, which is the hardware fact the padding is about.
    expect(read()).toBe(34);
  });

  it('ignores an Android edge-to-edge report of the keyboard itself', async () => {
    const { read } = await openWith({ includeBottomInset: true });

    mockInsets.bottom = 291;
    await keyboard(291);

    expect(read()).toBe(34);
  });

  it('takes the live inset back once the keyboard has gone', async () => {
    const { read } = await openWith({ includeBottomInset: true });

    mockInsets.bottom = 0;
    await keyboard(291);
    expect(read()).toBe(34);

    await keyboard(0);
    // The floor, because the inset really is zero now. Nothing is sticky.
    expect(read()).toBe(16);
  });

  it('leaves a tab screen at zero either way', async () => {
    const { read } = await openWith();
    expect(read()).toBe(0);

    mockInsets.bottom = 291;
    await keyboard(291);

    expect(read()).toBe(0);
  });
});
