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
  const [state, setState] = useState({ reduced: false, known: false });

  useEffect(() => {
    let live = true;
    /**
     * **Three ways an answer can arrive, and they are not equal** (independent review
     * 78b, P1). The first version had two of them wrong.
     *
     * The *event* is always the freshest answer and always makes the preference known.
     * The *initial read* is a snapshot taken before it, so it must not overwrite an event
     * that has already spoken — the sequence review 78b named is an event reporting `true`
     * followed by an older read resolving `false`, which turned Reduce Motion back off
     * and let the entrance run.
     */
    let eventSeen = false;
    let initialSettled = false;

    const fromEvent = (reduced: boolean) => {
      eventSeen = true;
      if (live) setState({ reduced, known: true });
    };

    const fromInitialRead = (reduced: boolean) => {
      if (eventSeen || initialSettled || !live) return;
      initialSettled = true;
      setState({ reduced, known: true });
    };

    AccessibilityInfo.isReduceMotionEnabled()
      .then(fromInitialRead)
      // A platform that cannot answer has no preference to honour.
      .catch(() => fromInitialRead(false));

    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', fromEvent);

    /**
     * **And a bounded fallback, because "never answers" must not mean "never appears".**
     *
     * The whole point of `known` is that a one-shot entrance waits for it — so a promise
     * that never settles would leave the ranking reveal at opacity 0 permanently, which
     * is a blank score panel and by some distance the worst outcome this pass could
     * produce. After this long, an unanswered platform is treated as having no preference.
     *
     * Short enough that a reader never sees the wait — the panel is at opacity 0 for it,
     * and a real answer arrives in a frame or two on every platform that has one.
     */
    const fallback = setTimeout(() => fromInitialRead(false), UNANSWERED_FALLBACK_MS);

    return () => {
      live = false;
      clearTimeout(fallback);
      subscription.remove();
    };
  }, []);

  return state;
}

/**
 * How long a one-shot will wait to be told before assuming there is nothing to honour.
 *
 * 250ms: past any real platform's answer, and under the threshold at which a reader
 * would perceive the ranking reveal as slow to arrive rather than as arriving.
 */
const UNANSWERED_FALLBACK_MS = 250;
