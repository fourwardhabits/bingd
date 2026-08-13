import * as Updates from 'expo-updates';
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
 */

/** Development builds load from the packager, so there is nothing to update. */
const enabled = Updates.isEnabled && !__DEV__;

let inFlight = false;

async function applyAnyUpdate() {
  // Guards against a second check starting while the first is still downloading,
  // which on a slow connection would otherwise fetch the same bundle twice.
  if (inFlight) return;
  inFlight = true;

  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return;

    const fetched = await Updates.fetchUpdateAsync();
    if (fetched.isNew) await Updates.reloadAsync();
  } catch {
    // Offline, or the update server is unreachable. Staying on the current version
    // is the correct outcome and there is nothing to tell the user: they did not ask
    // for an update and are not waiting for one.
  } finally {
    inFlight = false;
  }
}

export function startUpdateChecks() {
  if (!enabled) return () => {};

  let previous = AppState.currentState;
  const subscription = AppState.addEventListener('change', (next) => {
    const returning = previous !== 'active' && next === 'active';
    previous = next;
    if (returning) void applyAnyUpdate();
  });

  return () => subscription.remove();
}
