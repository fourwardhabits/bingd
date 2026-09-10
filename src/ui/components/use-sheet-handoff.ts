import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';

/**
 * One sheet's dismissal, finished before the next one is presented.
 *
 * ===========================================================================
 * THE FAILURE THIS EXISTS FOR
 *
 * UIKit will not present a view controller over one that is still dismissing. Ask it to
 * and the presentation is refused, React believes it succeeded, and the transparent
 * window left behind sits above the screen and swallows every touch: what is underneath
 * draws correctly and is completely dead. Force-quitting clears it, because the window
 * belongs to the process — which is what makes it read as "the app froze" rather than as
 * anything to do with data.
 *
 * The founder hit it twice on clean accounts in iOS 1.0.1 build 11, on the first ranking
 * of onboarding. The shape is always the same: **one `<Modal>` unmounted and another
 * mounted in the same commit.**
 *
 *     setRanking({ ... });     // presents
 *     setLogging(null);        // dismisses — same render, same frame
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES INSTEAD
 *
 * The outgoing sheet stays **mounted** and is asked to close by `visible`, which is a
 * dismissal iOS can report finishing. `onDismissed` runs the queued work, and only then
 * does the next sheet mount. Nothing is timed and nothing is guessed: `onDismiss` is
 * fired from the dismissal's own completion handler on both the legacy and Fabric
 * renderers.
 *
 * **Android runs the work immediately**, and that is correct rather than a shortcut. An
 * Android modal is a view in the same window with no presented controller to serialise
 * against, and `onDismiss` is iOS-only in React Native — so waiting would strand the
 * flow on the platform that never had the bug.
 *
 * ---------------------------------------------------------------------------
 * HOW A SCREEN USES IT
 *
 *     const handoff = useSheetHandoff();
 *
 *     <LogSheet
 *       title={logging}
 *       visible={!handoff.dismissing}
 *       onDismissed={handoff.settled}
 *       onRank={(bucket, mode) => {
 *         const subject = { ... };
 *         handoff.handOff(() => {
 *           setRanking(subject);
 *           setLogging(null);
 *         });
 *       }}
 *     />
 *
 * The state the outgoing sheet is mounted from must survive the wait — `logging` above is
 * cleared *inside* the queued work rather than beside it, so the sheet has a component to
 * finish its dismissal against.
 *
 * One instance per screen is enough where only one sheet can be open at a time, which is
 * the case everywhere this is used: while the flag is set, the sheet that is not mounted
 * has nothing to hide.
 */
export function useSheetHandoff() {
  const [dismissing, setDismissing] = useState(false);
  const queued = useRef<(() => void) | null>(null);

  /** Close the sheet that is open, then run this. */
  const handOff = useCallback((run: () => void) => {
    if (Platform.OS !== 'ios') {
      run();
      return;
    }
    queued.current = run;
    setDismissing(true);
  }, []);

  /**
   * iOS has finished dismissing. Idempotent, because a second `onDismiss` — or a screen
   * that unmounted and remounted around one — must not run the same handoff twice.
   */
  const settled = useCallback(() => {
    const run = queued.current;
    queued.current = null;
    setDismissing(false);
    run?.();
  }, []);

  return { dismissing, handOff, settled };
}
