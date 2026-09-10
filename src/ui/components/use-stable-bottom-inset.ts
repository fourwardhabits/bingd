import { initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useKeyboardHeight } from './use-keyboard-height';

/**
 * The bottom safe-area inset, held still while a keyboard is up.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS FOR
 *
 * The founder's physical pass on iOS 1.0.1 build 8: writing or editing a review in the
 * bottom sheet made the *title page behind it* jump downward, exposing a band of Paper
 * above the hero, and jump back when the keyboard went away. The sheet itself was
 * correct throughout, which is what made it hard to place.
 *
 * Traced rather than guessed, and the trace is short because the surface is small.
 * Nothing on the title page subscribes to the keyboard: `useKeyboardHeight` has exactly
 * two callers and both are inside the sheet (`Sheet`, `KeyboardScreen`). `Modal` adds no
 * layout to the tree it is written in. `useWindowDimensions` does not move for a
 * keyboard. That leaves **one** keyboard-reactive input to the page's own geometry —
 * `useSafeAreaInsets()` — and one consumer of it, `Screen`'s `includeBottomInset`.
 *
 * And that inset does move. iOS drops the home indicator's inset from
 * `safeAreaInsets.bottom` while the keyboard covers it, and Android under edge-to-edge
 * reports the IME there instead. Either way `Screen`'s `paddingBottom` changes
 * mid-typing, the page's scroll view is resized underneath a reader who is not touching
 * it, and the scroll view clamps its offset to the new frame — which is the content
 * sliding down, and sliding back when the keyboard leaves. Exactly one jump per keyboard
 * transition, on a page nobody was interacting with.
 *
 * ---------------------------------------------------------------------------
 * WHY HOLDING IT IS THE RIGHT ANSWER AND NOT A PAPER-OVER
 *
 * This inset answers one question: *how much room does the hardware take at the bottom
 * of the display.* The keyboard is not hardware and is not at the bottom of this screen
 * — it is over a modal in front of it — so a page resizing for it is the page answering
 * a question it was not asked.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HELD VALUE IS THE LAUNCH METRIC AND NOT A SNAPSHOT
 *
 * The obvious implementation remembers the last inset seen with the keyboard down. It
 * needs state written from an effect, which this codebase forbids for good reason, and
 * it needs the keyboard event and the inset change to arrive in a known order — which
 * neither platform promises.
 *
 * `initialWindowMetrics` needs neither. It is the window's own inset as measured before
 * the first render, it is a constant, and a keyboard cannot move it. The app is
 * `orientation: 'portrait'` (app.config.ts), so there is no second value it could have
 * been. If that ever changes, this becomes "the portrait inset while a keyboard is up",
 * which is a rotation-sized wrong rather than a jump on every keystroke session — and
 * the fallback below keeps it honest on any runtime that reports no metrics at all.
 *
 * The hero is untouched, the sheet is untouched, and every screen keeps its bottom
 * clearance — see `Screen`, which is the only caller.
 */
export function useStableBottomInset(): number {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();

  if (keyboard === 0) return insets.bottom;
  // Undefined where the provider was given no initial metrics, which is every test that
  // does not supply them. Falling back to the live value is the old behaviour, so
  // nothing is made worse by not knowing.
  return initialWindowMetrics?.insets.bottom ?? insets.bottom;
}
