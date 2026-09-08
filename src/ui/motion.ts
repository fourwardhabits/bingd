import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Whether the person using the app has asked the system to reduce motion.
 *
 * Honoured rather than consulted: design-system.md §10 requires that every
 * looping or transform animation has a still equivalent, and "reduce" for a
 * pulse means holding it at a legible opacity, not slowing it down.
 *
 * Subscribed to as well as read, because the setting can change while the app
 * is open — someone turning it on mid-session is very likely doing so because
 * of something they are looking at right now.
 */
export function useReducedMotion() {
  return useReducedMotionState().reduced;
}

/**
 * The same setting, with **whether the answer has arrived yet** alongside it — and that
 * distinction is independent review 78's second P1.
 *
 * `isReduceMotionEnabled` is asynchronous, so the first render of every component using
 * this hook sees `false`, and "not asked yet" is indistinguishable from "no". A one-shot
 * entrance that starts on mount therefore starts *before anybody has been asked*. The
 * ranking reveal did exactly that: a reader with Reduce Motion switched on got the full
 * 280ms entrance, once, every time, because by the time the real answer landed the
 * mount-only effect had already run and would not run again.
 *
 * A *looping* or *press-driven* animation does not care — the press happens long after
 * the answer, and a loop re-renders and settles — which is why this stayed invisible
 * until something mounted and animated once. So `useReducedMotion` above is unchanged for
 * every existing caller, and a one-shot uses this instead.
 *
 * `known` is false for one tick and then true for the life of the screen. A caller waits
 * for it before starting, and re-checks `reduced` afterwards so that turning the setting
 * on mid-animation stops it.
 */
export function useReducedMotionState() {
  const [reduced, setReduced] = useState(false);
  const [known, setKnown] = useState(false);

  useEffect(() => {
    let live = true;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!live) return;
        setReduced(enabled);
        setKnown(true);
      })
      .catch(() => {
        // A platform that cannot answer is a platform with no preference to honour, and
        // waiting for ever would mean an entrance that never plays. Treat it as answered.
        if (live) setKnown(true);
      });

    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);

    return () => {
      live = false;
      subscription.remove();
    };
  }, []);

  return { reduced, known };
}
