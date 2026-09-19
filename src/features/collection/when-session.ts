/**
 * The reader's last explicit answer to "when did you watch it?", carried to the next
 * title they log — and nothing more durable than that.
 *
 * **Why it exists (founder decision R4, 2026-09-19).** A new reader backfilling a
 * library through Search logs dozens of films they saw years ago, one after another.
 * The When row defaults to Today, which is right for the ordinary "I just watched this"
 * log and wrong for every one of those — so each was either an extra tap on *Earlier*
 * or a false current watch date that counts toward this year's goal and this month's
 * board. Carrying the reader's own last choice to the next new title removes the
 * repetition without the app ever guessing: the mode only changes when the reader
 * presses *Earlier* or *Today*.
 *
 * **What it deliberately is not.**
 *
 * - Not a preference. It lives in module memory, so an app restart forgets it, and it is
 *   never written to the device store or the server.
 * - Not a heuristic. Nothing here looks at account age, how many titles were logged, or
 *   how fast — the only inputs are the two explicit taps.
 * - Not sticky for a specific date. *Yesterday* and *Pick a date* leave the mode where it
 *   was: a date is information about that one title and says nothing about the next.
 *
 * **The session.** It ends after `IDLE_MS` without logging activity, measured on the
 * wall clock, so time spent in the background counts as idle: a reader who leaves the
 * app for half an hour comes back to the ordinary Today default. Each explicit choice,
 * and each new title logged under the carried mode, restarts the window. It is also
 * scoped to one account, so a second account on the device never inherits it.
 */

export type WhenMode = 'today' | 'earlier';

/** About thirty minutes of logging, after which the ordinary default comes back. */
export const WHEN_SESSION_IDLE_MS = 30 * 60 * 1000;

type WhenSession = { userId: string; mode: WhenMode; touchedAt: number };

let session: WhenSession | null = null;

/** The reader explicitly chose *Today* or *Earlier* while logging a new title. */
export function rememberWhen(userId: string, mode: WhenMode, now: number = Date.now()): void {
  session = { userId, mode, touchedAt: now };
}

/**
 * The mode a new title's sheet should open on, or null for the ordinary default.
 *
 * Expiry is applied here, on read, so no timer or listener has to be running for a
 * session to end — which is also what keeps it correct across a long background.
 */
export function carriedWhen(userId: string, now: number = Date.now()): WhenMode | null {
  if (!session || session.userId !== userId) return null;
  if (now - session.touchedAt > WHEN_SESSION_IDLE_MS) {
    session = null;
    return null;
  }
  return session.mode;
}

/**
 * A new title was logged under the carried mode, which is logging activity: the window
 * restarts. A no-op once the session has expired — using a stale mode is not allowed to
 * revive it.
 */
export function keepWhenAlive(userId: string, now: number = Date.now()): void {
  if (carriedWhen(userId, now) === null || !session) return;
  session = { ...session, touchedAt: now };
}

/** Forgets the session. Tests, and anything that must start clean. */
export function resetWhenSession(): void {
  session = null;
}
