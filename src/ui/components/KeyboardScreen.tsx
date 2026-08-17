import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

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
 * So the height is measured rather than assumed. Three things together, and each covers
 * something the others do not:
 *
 *   - **the keyboard's own height as bottom padding**, which is what makes the content
 *     scrollable past where the keyboard now is. This is the part that fixes Android
 *     edge-to-edge, and it is measured from the event rather than guessed at, because
 *     a keyboard with a suggestion strip and one without differ by fifty points.
 *   - **`automaticallyAdjustKeyboardInsets`** on iOS, which is the platform's own
 *     mechanism and does the same job more smoothly where it exists.
 *   - **`keyboardShouldPersistTaps="handled"`**, which is the one that gets forgotten.
 *     Without it the first tap on a button while the keyboard is up only dismisses the
 *     keyboard, and the user has to tap Save twice. That is the "primary action is
 *     reachable" half of the requirement, and it is invisible in a screenshot.
 *
 * `keyboardDidShow` rather than `keyboardWillShow` on Android, because Android does not
 * emit the `will` events at all — subscribing to them there produces a component that
 * compiles, renders, and never adjusts.
 */
export function KeyboardScreen({
  children,
  contentContainerStyle,
  extraOffset = 24,
  ...rest
}: KeyboardScreenProps) {
  const [keyboard, setKeyboard] = useState(0);
  const scroll = useRef<ScrollView>(null);

  useEffect(() => {
    // Android emits only the `did` pair. Subscribing to `will` there is a component
    // that never adjusts and looks correct in review.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const shown = Keyboard.addListener(showEvent, (event) => {
      setKeyboard(event.endCoordinates?.height ?? 0);
    });
    const hidden = Keyboard.addListener(hideEvent, () => setKeyboard(0));

    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  return (
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
  );
}

/** Nothing of its own to style; the ScrollView is the whole component. */
export const keyboardScreenStyles = StyleSheet.create({});
