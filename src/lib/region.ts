import * as Localization from 'expo-localization';

/**
 * The country to ask about when the device will not say.
 *
 * A **US beta default**, and it is a stated limitation rather than a claim that
 * availability is the same everywhere. The adapter applies the same fallback for the
 * same reason; this one exists so the request carries an honest answer rather than
 * an empty field.
 */
export const DEFAULT_WATCH_REGION = 'US';

/** Resolved once per app run. See {@link watchRegion}. */
let cached: string | null = null;

/**
 * Which country's streaming availability this device should be told about.
 *
 * **Read from the phone, not from an account setting**, and read through
 * `expo-localization` — which has been a dependency since 2026-08-13 and is in every
 * binary in the field, so this adds no native module and cannot move the fingerprint.
 * That constraint is why it is this and not a geo-IP lookup or a new package: the
 * closed-test binary is pinned to its runtime version, and a native change would
 * strand it.
 *
 * `regionCode` is the region subtag of the device's locale — `US` from `en-US`, `GB`
 * from `en-GB`. It is null on a device whose locale carries no region at all, which
 * is uncommon and real.
 *
 * **What this deliberately is not.** A traveller sees their home market, and somebody
 * who reads English in a country whose services they do not subscribe to sees that
 * country. Region *selection* — letting a reader say which market they are actually
 * in — is deferred rather than half-built, and recorded as deferred in
 * `docs/reference/tmdb-integration.md`. Guessing harder here would not fix either case.
 *
 * Wrapped, because this reads a native module at call time and a block that is
 * allowed to fail soft must not be the thing that throws on a title page.
 */
export function watchRegion(): string {
  // Resolved once per app run, lazily. `getLocales` reads a native module, and this is
  // called from a component that renders on every title page — but resolving it at
  // module scope instead would put a native call in the import graph, which is the
  // shape that has cost this app a startup before. The device's region does not change
  // while the process is alive.
  if (cached) return cached;

  try {
    const code = Localization.getLocales()?.[0]?.regionCode;
    const upper = typeof code === 'string' ? code.trim().toUpperCase() : '';
    cached = /^[A-Z]{2}$/.test(upper) ? upper : DEFAULT_WATCH_REGION;
  } catch {
    cached = DEFAULT_WATCH_REGION;
  }

  return cached;
}
