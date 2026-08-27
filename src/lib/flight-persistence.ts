import { readPref, writePref } from './prefs';
import { isRelease } from './env';
import {
  tailForPersistence,
  type EventChannel,
  type FlightEvent,
  type LastSession,
} from './flight-recorder';

/**
 * The tail of the last session, so a process that did not come back still says what it was
 * doing.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND — MORE IMPORTANTLY — WHAT IT IS NOT
 *
 * It is **not a crash reporter** and must never be described as one in the report it
 * produces. It cannot distinguish a JavaScript exception from the operating system
 * reclaiming a backgrounded app from the founder swiping the app away, and it will miss a
 * foreground crash entirely, because that terminates the process without passing through
 * here.
 *
 * What it does answer is narrower and still worth having on a device nobody can attach a
 * debugger to: *what was running last*. A previous session that ended with an unfinished
 * `rest:rankings` and a last route of `onboarding/taste` is a different story from one that
 * ended quiet on the feed, and neither is visible today.
 *
 * ---------------------------------------------------------------------------
 * WHY IT COSTS ALMOST NOTHING
 *
 * One write, on the transition out of `active`, of about a kilobyte. No timer, no
 * throttle, no write per event — which matters because the handset this ships to is
 * already warm and the last thing it needs is instrumentation with a duty cycle.
 *
 * The Keychain is a heavy place to put this and is used anyway, because it is the storage
 * this app already has and adding a filesystem dependency would move the fingerprint —
 * and this update has to land on the build already in the founder's hands.
 */

const KEY = 'diagnostics.lastSession';

/** Beta and below, like the recorder itself. */
const ENABLED = !isRelease;

/**
 * Called from the root layout when the app leaves the foreground.
 *
 * Never rejects: a diagnostic that can break the app it is diagnosing is worse than no
 * diagnostic. Deliberately not awaited by its caller either — iOS gives a backgrounding app
 * a moment, and holding it is not this module's business.
 */
export async function persistLastSession(route: string | undefined): Promise<void> {
  if (!ENABLED) return;
  try {
    await writePref<LastSession>(KEY, tailForPersistence(route));
  } catch {
    // The store refused. There is nothing to recover and nobody to tell.
  }
}

/**
 * Read once, when the Diagnostics sheet opens.
 *
 * Anything that does not parse into the expected shape is discarded rather than rendered:
 * this value survives an app update, so a payload written by an older build is a real
 * possibility and a half-shaped object reaching the formatter would be a crash in the one
 * screen that must not have one.
 */
export async function readLastSession(): Promise<LastSession | null> {
  if (!ENABLED) return null;
  try {
    const held: unknown = await readPref(KEY);
    if (!held || typeof held !== 'object') return null;
    const bag = held as Record<string, unknown>;
    if (typeof bag.endedAtIso !== 'string' || !Array.isArray(bag.events)) return null;

    return {
      endedAtIso: bag.endedAtIso,
      uptimeMs: typeof bag.uptimeMs === 'number' ? bag.uptimeMs : 0,
      route: typeof bag.route === 'string' ? bag.route : undefined,
      events: bag.events.slice(0, 12).map(sanitiseEvent),
      pending: Array.isArray(bag.pending)
        ? bag.pending.slice(0, 12).filter((name): name is string => typeof name === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * Every field of a stored event, coerced.
 *
 * **Review 51's fourth finding, and the shallow version of this check was worse than
 * useless.** It confirmed `events` was an array and then handed the elements straight to a
 * formatter that calls `padEnd` on `channel` and `label`. A payload from an older build —
 * which is an ordinary case, because this value outlives an app update — could therefore
 * throw inside the one screen that must not throw, or interpolate a string this build never
 * chose into text the founder is about to paste somewhere public.
 */
function sanitiseEvent(value: unknown): FlightEvent {
  const bag = (value ?? {}) as Record<string, unknown>;
  const text = (field: unknown, fallback: string) =>
    typeof field === 'string' ? field.slice(0, 40) : fallback;

  return {
    seq: typeof bag.seq === 'number' ? bag.seq : 0,
    at: typeof bag.at === 'number' ? bag.at : 0,
    // Narrowed to the channels this build knows; anything else is from a shape it does not.
    channel: KNOWN_CHANNELS.has(bag.channel as EventChannel)
      ? (bag.channel as EventChannel)
      : 'app',
    label: text(bag.label, '(unknown)'),
    detail: typeof bag.detail === 'string' ? bag.detail.slice(0, 40) : undefined,
    ms: typeof bag.ms === 'number' ? bag.ms : undefined,
  };
}

const KNOWN_CHANNELS = new Set<EventChannel>([
  'auth',
  'route',
  'onboarding',
  'signout',
  'push',
  'app',
  'store',
  'query',
]);
