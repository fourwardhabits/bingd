import { isRelease } from '@/lib/env';

/**
 * Whether a surface should offer the way in to Diagnostics at all.
 *
 * Beta and below. A store build has no entry point, in the same way the recorder itself
 * records nothing there — the gate is stated twice on purpose, because a control that is
 * merely inert is still a control somebody can find.
 *
 * This is all that survives of the old `open.ts`. The signal it used to carry is gone:
 * each entry point now owns its own boolean and renders its own `DiagnosticsSheet`, because
 * a sheet mounted anywhere but inside the screen that opens it cannot be presented over a
 * native modal route. See `DiagnosticsSheet`.
 */
export const diagnosticsAvailable = !isRelease;
