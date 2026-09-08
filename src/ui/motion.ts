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
    let readSettled = false;
    // Declared before the handlers that clear it; assigned below, after the subscription.
    let fallback: ReturnType<typeof setTimeout>;

    const fromEvent = (reduced: boolean) => {
      eventSeen = true;
      clearTimeout(fallback);
      if (live) setState({ reduced, known: true });
    };

    const fromInitialRead = (reduced: boolean) => {
      if (eventSeen || readSettled || !live) return;
      readSettled = true;
      clearTimeout(fallback);
      setState({ reduced, known: true });
    };

    AccessibilityInfo.isReduceMotionEnabled()
      .then(fromInitialRead)
      // A platform that cannot answer has no preference to honour.
      .catch(() => fromInitialRead(false));

    /**
     * **A bounded fallback, because "never answers" must not mean "never appears".**
     *
     * The whole point of `known` is that a one-shot entrance waits for it — so a promise
     * that never settles would leave the ranking reveal at opacity 0 permanently, which
     * is a blank score panel and by some distance the worst outcome this pass could
     * produce.
     *
     * **It releases `known` and nothing else**, and that distinction is independent
     * review 78c's P1. The first version answered `false` through the same path a real
     * read takes, which set `readSettled` — so a genuine `true` arriving at 260ms was
     * discarded and a reader with Reduce Motion on was left permanently marked as not
     * having it. Now the real read still applies whenever it lands, and if it says `true`
     * the reveal's effect re-runs and cuts the entrance short.
     *
     * The trade is deliberate and it is the honest one: on a platform slow to answer, a
     * Reduce Motion reader may see a fraction of an entrance before it snaps to rest.
     * That is worse than perfect and much better than either alternative — a blank panel
     * for ever, or a preference silently stuck at the wrong value.
     *
     * Cleared as soon as either real source answers, so a screen full of chips and tiles
     * does not leave a timer per control queued to do nothing.
     */
    fallback = setTimeout(() => {
      if (!live || eventSeen || readSettled) return;
      setState((current) => ({ ...current, known: true }));
    }, UNANSWERED_FALLBACK_MS);

    /**
     * Subscribed **after** the timer exists, which is independent review 78d's P2. A
     * platform that delivers the first event synchronously from `addEventListener` would
     * otherwise answer while `fallback` is still `undefined` — the `clearTimeout` in
     * `fromEvent` would be a harmless no-op, and the timer created afterwards would sit
     * for the full 250ms doing nothing. Ordering it this way makes the cancellation
     * unconditional rather than usually true.
     */
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', fromEvent);

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
