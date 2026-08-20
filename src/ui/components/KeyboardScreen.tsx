import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import {
  Dimensions,
  Platform,
  ScrollView,
  TextInput,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useKeyboardHeight } from './use-keyboard-height';

export type KeyboardScreenProps = Omit<ScrollViewProps, 'children'> & {
  children: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  /**
   * Extra room under the focused field, beyond the keyboard itself.
   *
   * The default leaves the field's helper line and the control under it visible rather
   * than flush against the keyboard's top edge, which reads as "cut off" even when it
   * is technically on screen.
   */
  extraOffset?: number;
};

/**
 * Anything that can report where it is on screen.
 *
 * Structural rather than `TextInput`, because the two things handed to `ensureVisible`
 * have different static types and the same runtime capability: a `Field`'s own ref is a
 * `TextInput`, and `TextInput.State.currentlyFocusedInput()` returns the host element.
 * Naming the one method used is more honest than casting one to the other.
 */
type Measurable = {
  measureInWindow: (
    callback: (x: number, y: number, width: number, height: number) => void,
  ) => void;
};

/**
 * Lets a focused field ask the scroll view to move it clear of the keyboard.
 *
 * `Field` consumes this, so every form in the app gets the behaviour without its screen
 * knowing about it. Null outside a `KeyboardScreen`, where the behaviour would have
 * nothing to scroll. Returns a cleanup for the pending measurement, so an effect can
 * cancel one that a re-render has superseded.
 */
type EnsureVisible = (input: Measurable | null) => (() => void) | void;

const KeyboardScrollContext = createContext<EnsureVisible | null>(null);

/** For `Field`, which calls it on focus. Returns null where there is no scroll view. */
export const useEnsureVisible = () => useContext(KeyboardScrollContext);

/**
 * A scrolling surface that a keyboard cannot cover.
 *
 * **The founder found focused fields being hidden repeatedly on a physical Android
 * device, and called it release-blocking.** It is, and the cause is not the obvious one.
 *
 * The usual answer is `windowSoftInputMode=adjustResize`, which is Expo's default and
 * which this app has. It works by shrinking the window when the keyboard appears, so a
 * `ScrollView` shrinks with it and the content scrolls clear. **Under Android
 * edge-to-edge — on by default since Expo SDK 54 — the window does not resize.** The
 * keyboard is drawn over the app, `adjustResize` has nothing to adjust, and a field in
 * the lower half of the screen is simply behind it. Nothing about the layout looks
 * wrong; the field is just not there any more.
 *
 * So the height is measured rather than assumed. Four things together, and each covers
 * something the others do not:
 *
 *   - **the keyboard's own height as bottom padding**, which is what makes the content
 *     scrollable past where the keyboard now is. This is the part that fixes Android
 *     edge-to-edge, and it is measured from the event rather than guessed at, because
 *     a keyboard with a suggestion strip and one without differ by fifty points.
 *   - **scrolling the focused field into view**, which is the part that was missing and
 *     the reason the founder still found the bio covered. Padding makes the field
 *     *reachable*; nothing was making it *reached*. Android's own scroll-to-focus is
 *     driven by the window resize that edge-to-edge no longer performs, so on the
 *     screen this matters most it never fired. See `ensureVisible`.
 *   - **`automaticallyAdjustKeyboardInsets`** on iOS, which is the platform's own
 *     mechanism and does both jobs more smoothly where it exists.
 *   - **`keyboardShouldPersistTaps="handled"`**, which is the one that gets forgotten.
 *     Without it the first tap on a button while the keyboard is up only dismisses the
 *     keyboard, and the user has to tap Save twice. That is the "primary action is
 *     reachable" half of the requirement, and it is invisible in a screenshot.
 *
 * The measurement itself is `useKeyboardHeight`, which `Sheet` uses for the same reason
 * on a surface that cannot scroll its way clear.
 */
export function KeyboardScreen({
  children,
  contentContainerStyle,
  extraOffset = 24,
  onScroll,
  ...rest
}: KeyboardScreenProps) {
  const keyboard = useKeyboardHeight();
  const scroll = useRef<ScrollView>(null);
  /** The live scroll offset, so a correction can be applied relative to it. */
  const offset = useRef(0);

  /**
   * Moves a focused input above the keyboard, and only if it is not already.
   *
   * Measured **in the window** rather than relative to the scroll view. The two would
   * give the same answer through `measureLayout`, but that call wants a handle to the
   * scroll view's inner content view — an API whose shape has changed across
   * architectures — where `measureInWindow` is stable and the keyboard's own height is
   * already reported in the same coordinate space. The correction is then a delta on
   * the current offset, which needs no knowledge of the content's height at all.
   *
   * iOS is skipped: `automaticallyAdjustKeyboardInsets` already does this, and doing it
   * twice fights the platform's animation.
   */
  const ensureVisible = useCallback<EnsureVisible>(
    (input) => {
      if (Platform.OS === 'ios' || !input) return;
      // Nothing to move out of the way of yet. The usual first focus lands here — the
      // keyboard has not arrived — and the effect below runs this again the moment it
      // has. Checked before the timer rather than inside it, so a screen full of fields
      // does not leave a timeout per focus behind it.
      if (keyboard <= 0) return;

      // A moment for the padding change below to be laid out and for the keyboard
      // animation to commit its height, so the measurement is against what is on screen.
      const run = () => {
        input.measureInWindow((_x, y, _width, inputHeight) => {
          if (!Number.isFinite(y) || !Number.isFinite(inputHeight)) return;

          const keyboardTop = Dimensions.get('window').height - keyboard;
          const overlap = y + inputHeight + extraOffset - keyboardTop;
          if (overlap <= 0) return;

          scroll.current?.scrollTo({ y: offset.current + overlap, animated: true });
        });
      };

      const timer = setTimeout(run, SETTLE_MS);
      return () => clearTimeout(timer);
    },
    // The height is a dependency rather than a ref read at call time: a field focused
    // before the keyboard has arrived measures against the wrong window, and the
    // effect below re-runs this with the real height the moment it is known.
    [extraOffset, keyboard],
  );

  /**
   * The keyboard appearing is itself a reason to re-check.
   *
   * Focus usually comes first and the keyboard second, so the measurement taken on
   * focus can be against a window the keyboard has not yet covered. This runs again
   * once the height is known, against whatever is focused by then.
   */
  useEffect(() => {
    if (keyboard <= 0) return;
    return ensureVisible(TextInput.State.currentlyFocusedInput());
  }, [keyboard, ensureVisible]);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = event.nativeEvent.contentOffset.y;
    onScroll?.(event);
  };

  return (
    <KeyboardScrollContext.Provider value={ensureVisible}>
      <ScrollView
        ref={scroll}
        // The tap that would otherwise be eaten by the keyboard dismissing.
        keyboardShouldPersistTaps="handled"
        // Dragging the list away from a field puts the keyboard away with it, which is
        // what a reader expects from every other scrolling app on the phone.
        keyboardDismissMode="on-drag"
        // iOS only; a no-op elsewhere, which is why the measured padding below is not
        // conditional on platform.
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        onScroll={handleScroll}
        // Often enough to keep `offset` honest between corrections, rarely enough that
        // it is not a callback per frame on a form nobody is scrolling fast.
        scrollEventThrottle={32}
        contentContainerStyle={[
          contentContainerStyle,
          // Only while the keyboard is up. A constant reserve would be dead space on
          // every screen that uses this, which is the "arbitrary padding hack" the brief
          // rules out — and on iOS `automaticallyAdjustKeyboardInsets` is already doing
          // it, so this would double there.
          keyboard > 0 && Platform.OS !== 'ios'
            ? { paddingBottom: keyboard + extraOffset }
            : null,
        ]}
        {...rest}
      >
        {children}
      </ScrollView>
    </KeyboardScrollContext.Provider>
  );
}

/**
 * How long to wait before measuring.
 *
 * Long enough for the padding change above to have been laid out and for the keyboard's
 * own animation to have committed its height, short enough that nobody perceives the
 * correction as a second, separate movement.
 */
const SETTLE_MS = 120;
