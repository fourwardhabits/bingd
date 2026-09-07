import { diagnosticsAvailable } from '@/features/diagnostics/availability';

import { lastRouteSeen, note, tally } from './flight-recorder';
import { reportHandled } from './monitoring';

/**
 * What the app does with a render error it caught, in one place.
 *
 * Two boundaries call this — the root one around the navigator, and a route's own
 * (`app/title/[id].tsx`) — and they must agree about what is reported and what is
 * shown, because the difference between them is *where the error was caught*, not what
 * kind of thing it is.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RECORDER, WHEN THERE IS ALREADY SENTRY
 *
 * `reportHandled` has been the only destination for a caught render error, and this
 * project cannot read Sentry — it has not been able to for weeks (07_DO_NOT_REDISCOVER).
 * So a founder holding a device that says "Something went wrong" had no way to say
 * *what* went wrong, and neither did anybody they reported it to. The flight recorder is
 * the evidence channel that does work on that device, and the Diagnostics sheet is how
 * it is read. One caught error now lands in both.
 */

/**
 * The error's class name — `TypeError`, `RangeError` — and never its message.
 *
 * The same rule `NetworkRecord.errorClass` follows, for the same reason: the flight log
 * is copied off the device by hand, and a message can echo input. The message is shown
 * on the boundary instead, where it stays on the screen it came from.
 */
export function errorClassOf(error: unknown): string {
  if (error && typeof error === 'object') {
    const named = error as { name?: unknown; constructor?: { name?: string } };
    if (typeof named.name === 'string' && named.name) return named.name;
    if (named.constructor?.name) return named.constructor.name;
  }
  return typeof error;
}

/** How long a line somebody is expected to read back over a message can be. */
const MAX_LINE = 240;

/**
 * The one line a person can read back to somebody who can fix it, or nothing at all.
 *
 * Beta and below, on the same gate Diagnostics uses: a stranger's build says the calm
 * sentence and nothing else, and the founder's build also names the exception. Bounded,
 * because a React error message can run to paragraphs of component stack and a wall of
 * text under an apology is not a report anybody transcribes.
 */
export function errorLineFor(error: unknown, available = diagnosticsAvailable): string | null {
  if (!available) return null;
  const message = error instanceof Error ? error.message : String(error ?? '');
  const line = `${errorClassOf(error)}${message ? `: ${message}` : ''}`
    .replace(/\s+/g, ' ')
    .trim();
  if (!line) return null;
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

/**
 * Reports one caught render error to both channels.
 *
 * `stage` says which boundary caught it, which is the difference that matters when
 * reading the log back: `route_render` means the navigator went with it, `screen_render`
 * means the screen stopped and the stack survived.
 */
export function recordRenderError(error: unknown, stage: 'route_render' | 'screen_render') {
  reportHandled(error instanceof Error ? error : new Error(String(error)), { stage });
  tally(`render.caught.${stage}`);
  note('render', lastRouteSeen() ?? 'unknown', errorClassOf(error));
}
