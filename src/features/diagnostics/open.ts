import { isRelease } from '@/lib/env';

/**
 * How the Diagnostics sheet is asked for, from anywhere, without being a route.
 *
 * **A route was the obvious design and it does not work here**, which is worth writing
 * down because it is not obvious why. The founder needs this reachable from the taste
 * summary — "That is a start" — and `useAuthRouting` sends anybody on that account back to
 * `/onboarding/taste` from any other group. A `/settings/diagnostics` route would be
 * pushed and immediately replaced, on exactly the screen the diagnostics exist to explain.
 *
 * So it is a sheet rendered above the navigator instead: one host mounted in the root
 * layout, and a signal any surface can raise. Routing never sees it, so routing cannot
 * take it away.
 *
 * Beta and below only, in both halves — the openers are hidden and this refuses — so a
 * store build has no entry point even if one were left on a screen by accident.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

/** The host subscribes; returns its own unsubscribe so an effect can hand it back. */
export function onDiagnosticsRequested(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Raised by the About row and by the long-press on the onboarding summary. */
export function openDiagnostics(): void {
  if (isRelease) return;
  for (const listener of [...listeners]) listener();
}

/** Whether a surface should offer the way in at all. */
export const diagnosticsAvailable = !isRelease;
