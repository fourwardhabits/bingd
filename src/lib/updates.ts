import * as Updates from 'expo-updates';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

/**
 * Over-the-air updates.
 *
 * `expo-updates` already checks once at launch and applies what it finds on the
 * *next* launch. On its own that means a fix reaches a tester whenever they next
 * cold-start the app, which for an app people open a few times a week can be days.
 *
 * So this adds one thing: a check when the app returns to the foreground, applied
 * immediately. Returning from the background is the one moment a reload is not
 * disruptive — the user is arriving rather than mid-task — and it turns "days" into
 * "the next time they pick up their phone".
 *
 * Deliberately not done: checking on a timer, or reloading while the app is in use.
 * A reload mid-session throws away whatever is on screen, and the ranking flow is
 * exactly where someone would be when it fired.
 *
 * ---------------------------------------------------------------------------
 * **EXCEPT WHILE SOMEBODY IS STILL GETTING IN** (production dependency audit, 2026-09-21)
 *
 * "Returning from the background is not disruptive" is true of somebody who is signed in
 * and false of somebody who is not. Signing in with an email code *is* a trip to the
 * background: request the code, open Mail, copy it, come back. Apple and Google sign-in
 * and the notification permission prompt take the app to `inactive` and back, which the
 * listener below counts as a return. And the email being verified lives only in the code
 * screen's route params, so a reload lands the person on an empty sign-in form holding a
 * code they can no longer enter — and a second request inside the server's 60-second
 * `max_frequency` is refused.
 *
 * On a fresh store install this is not an edge case but the ordinary first run. The
 * binary launches its embedded bundle, the launch-time check downloads whatever newer
 * update its channel carries, and the first return to the foreground — Mail, almost
 * always — found it and reloaded.
 *
 * So the reload is now gated on the app being in a state where it loses nothing:
 * `isSafeToReload`. When it is not, the update is still downloaded, and `expo-updates`
 * launches it on the next cold start, or this applies it on the next foreground return
 * that is safe. Nothing is disabled; the reload only waits.
 *
 * **Why this has to be in the next store binary, although it is JavaScript.** On a fresh
 * install, the code deciding whether to reload is the *embedded* bundle's copy of this
 * file, since no update has run yet. An update carrying this guard cannot protect that
 * first reload: the update is only launched *by* that reload. Every fresh install of a
 * binary built before this change reloads once, unguarded, on its first qualifying
 * foreground return, for as long as its channel carries an update newer than its
 * embedded bundle. Only a binary whose embedded bundle includes this file closes it.
 * Once a device is running this code, from either source, the guard holds for every
 * update after.
 */

/**
 * Whether reloading now would cost the person nothing.
 *
 * Only a signed-in account with a profile, outside the two route groups where the app
 * is still being set up. Everything else waits:
 *
 *   - `signed-out`: the sign-in form, the code screen, the password screen.
 *   - `onboarding`: an account with no profile yet, on `create-profile`.
 *   - `loading` and `error`: not knowing where somebody is, which is not a reason to
 *     move them. It is the same rule `nextRoute` follows.
 *   - the `(auth)` and `onboarding` groups under any status: the first-run steps
 *     (taste, Letterboxd, people, the notification prompt) hold progress in screen
 *     state, and the notification prompt is itself a trip to `inactive`.
 *
 * Deliberately an allowlist of one state rather than a list of the unsafe ones. A new
 * status or a new pre-app route group is held back by default instead of reloaded.
 *
 * `status` and `group` are plain strings so that this module does not depend on the
 * auth feature; `app/_layout.tsx` passes `useAuth().status` and the first route segment.
 */
export function isSafeToReload(status: string, group: string | undefined): boolean {
  return status === 'ready' && group !== '(auth)' && group !== 'onboarding';
}

let inFlight = false;

/**
 * Set once a reload has been asked for, and never cleared.
 *
 * `reloadAsync` replaces the JavaScript context, so in practice nothing runs after it.
 * If it throws or returns without reloading, this stops the next foreground return from
 * asking again, and the one after that, for an update that has already shown it will
 * not apply this session. The cold start that follows launches it anyway.
 */
let reloadRequested = false;

async function applyAnyUpdate(canReload: () => boolean) {
  // Guards against a second check starting while the first is still downloading,
  // which on a slow connection would otherwise fetch the same bundle twice.
  if (inFlight || reloadRequested) return;
  inFlight = true;

  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return;

    // Downloaded whatever the state, so a held update is on disk for the next launch.
    const fetched = await Updates.fetchUpdateAsync();
    if (!fetched.isNew) return;

    // Asked *after* the download, not before the check. A download takes seconds on a
    // phone, and that is long enough to sign out, or for a new account to be routed
    // into its first-run steps.
    if (!canReload()) return;

    reloadRequested = true;
    await Updates.reloadAsync();
  } catch {
    // Offline, or the update server is unreachable. Staying on the current version
    // is the correct outcome and there is nothing to tell the user: they did not ask
    // for an update and are not waiting for one.
  } finally {
    inFlight = false;
  }
}

/**
 * Starts the foreground check. `canReload` is read at the moment a reload would happen.
 *
 * With no argument nothing is ever reloaded in the foreground, which is the safe
 * default: updates still download, and still apply on the next cold start.
 */
export function startUpdateChecks(canReload: () => boolean = () => false) {
  // Development builds load from the packager, so there is nothing to update. Read at
  // start rather than at import so a test can stand in for a release build.
  if (!Updates.isEnabled || __DEV__) return () => {};

  let previous = AppState.currentState;
  const subscription = AppState.addEventListener('change', (next) => {
    const returning = previous !== 'active' && next === 'active';
    previous = next;
    if (returning) void applyAnyUpdate(canReload);
  });

  return () => subscription.remove();
}

/**
 * `startUpdateChecks` for the root layout, with the latest `reloadSafe` in view.
 *
 * The listener is registered once. It reads the value through a ref, because a check
 * that started while it was safe may finish downloading after that stopped being true.
 */
export function useUpdateChecks(reloadSafe: boolean) {
  const safe = useRef(reloadSafe);

  useEffect(() => {
    safe.current = reloadSafe;
  }, [reloadSafe]);

  useEffect(() => startUpdateChecks(() => safe.current), []);
}

/** Test seam: the latch and the in-flight guard are per process, and a test is not one. */
export function resetUpdateChecks() {
  inFlight = false;
  reloadRequested = false;
}
