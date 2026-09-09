import { useCallback, useSyncExternalStore } from 'react';

import { note } from '@/lib/flight-recorder';
import { withGrace } from '@/lib/grace';
import { readPref, writePref } from '@/lib/prefs';

/**
 * Whether this device has been shown the opening.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS THE ONLY PIECE OF STATE IN THE FLOW THAT IS NOT KEYED TO AN ACCOUNT
 *
 * The opening is the one screen that runs with no session (`01-screen-map.md` §2), so
 * there is no account to key it to. That is not a limitation being worked around, it is
 * the point of the screen: it exists so somebody meets the idea before they meet a form,
 * and anything that had to know who they were would have to come after the form.
 *
 * The consequence, stated rather than discovered later: two people sharing a phone see
 * the opening once between them, and somebody who signs out and back in does not see it
 * again. Both are correct. It is an introduction to the product, not to the account.
 *
 * ---------------------------------------------------------------------------
 * WHY A FAILURE MEANS "SEEN"
 *
 * `readPref` is SecureStore, which the founder's build-4 tranche established can hang
 * rather than fail, and `nextRoute` holds while this is unknown — it will not guess,
 * because guessing wrong either shows the opening to somebody who has dismissed it or
 * skips it on a genuine first launch.
 *
 * A hold needs a floor, and this is where it is: the read is bounded, and both a
 * rejection and a stall resolve to `true`. **Losing one screen is a smaller cost than
 * holding the whole app**, which is the same trade `withDeadline` takes in
 * `use-taste-onboarding.ts` and the lesson of the build-4 stranding. The failure mode is
 * a first-time user going straight to sign in, which is exactly where the product was a
 * week ago.
 */
const WELCOME_PREF = 'onboarding.welcome.seen';

/**
 * Four seconds, matching `FIRST_RUN_GRACE_MS` next door and for the same reason: this is
 * one Keychain lookup, so anything past this is not slow, it is stuck.
 */
const WELCOME_GRACE_MS = 4000;

/**
 * What this process knows, which outranks the disk for the life of the process.
 *
 * Module-level rather than component state because the writer (the opening) and the
 * reader (the router) are in different trees, and because a failed write must not send
 * somebody back to a screen they have already dismissed. The same shape, and the same
 * argument, as `intent` in `use-taste-onboarding.ts`.
 */
let seen: boolean | undefined;

const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

/** Exported for tests, which must not inherit a decision from the previous one. */
export function resetWelcomeSeen() {
  seen = undefined;
  publish();
}

/**
 * Reads the preference once per process and answers from memory afterwards.
 *
 * Safe to call repeatedly: a second call while the first is in flight simply reads the
 * same key again, and both resolve to the same answer. It is called from the router's
 * effect, which runs on every segment change, so the early return is what keeps that
 * from being a Keychain read per navigation.
 */
export async function hydrateWelcomeSeen(): Promise<boolean> {
  if (seen !== undefined) return seen;

  const answer = await withGrace(
    readPref<boolean>(WELCOME_PREF).then((value) => value === true),
    WELCOME_GRACE_MS,
    // See the header: unreadable and unresponsive both mean "do not hold the app".
    true,
  );

  note('onboarding', 'welcome.read', answer ? 'seen' : 'unseen');
  seen = answer;
  publish();
  return answer;
}

/**
 * Records that the opening has been shown, in memory first and then on disk.
 *
 * The memory write is synchronous and comes first, on the ordering rule the flow follows
 * everywhere: state the router depends on is recorded before anything that can fail. The
 * disk write is dispatched and its rejection swallowed, because a preference that did not
 * persist costs one extra screen on a future launch and nothing else.
 */
export async function markWelcomeSeen(): Promise<void> {
  seen = true;
  publish();
  await writePref<boolean>(WELCOME_PREF, true).catch(() => {});
}

/** The answer as a subscription, for the router. Undefined until `hydrateWelcomeSeen`. */
export function useWelcomeSeen(): boolean | undefined {
  return useSyncExternalStore(
    useCallback((onChange: () => void) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    }, []),
    () => seen,
    () => undefined,
  );
}
