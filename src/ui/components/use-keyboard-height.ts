import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * How much of the screen the keyboard is currently covering, in points.
 *
 * **Measured rather than assumed, because under Android edge-to-edge the window does
 * not resize.** `windowSoftInputMode=adjustResize` is Expo's default and this app has
 * it, but edge-to-edge — on by default since SDK 54 — means the keyboard is drawn
 * *over* the app and `adjustResize` has nothing to adjust. A control in the lower half
 * of the screen is simply behind it, and nothing about the layout looks wrong.
 *
 * It is a measurement rather than a constant because a keyboard with a suggestion strip
 * and one without differ by about fifty points, and a reserve big enough for the larger
 * is dead space under the smaller.
 *
 * `keyboardDidShow` on Android, because Android does not emit the `will` events at all
 * — subscribing to them there produces a hook that compiles, runs, and always returns
 * zero.
 *
 * Returns 0 whenever the keyboard is down, so a caller can use it directly as a style
 * value without a conditional.
 */
export function useKeyboardHeight() {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const shown = Keyboard.addListener(showEvent, (event) => {
      setHeight(event.endCoordinates?.height ?? 0);
    });
    const hidden = Keyboard.addListener(hideEvent, () => setHeight(0));

    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  return height;
}
