import * as Localization from 'expo-localization';

/**
 * The device's own timezone and locale region, as release awareness needs them
 * (docs/product/release-awareness.md, founder decision 5; migration 20260930000100).
 *
 * **Read from `expo-localization`**, which has been in every binary since 2026-08-13, so
 * this adds no native module and cannot move the fingerprint. It is the same source
 * `watchRegion` (`./region.ts`) reads — with one deliberate difference: **nothing here
 * falls back**. `watchRegion` answers a where-to-watch question and a US list is a
 * reasonable thing to show a device that says nothing. Here an unknown is reported as
 * unknown, because the founder's rule is that a timezone is never guessed, and a guessed
 * region would put a US release date on somebody else's phone.
 *
 * Each field is read on its own and each fails soft: a device whose calendar API throws
 * still reports its region, and one that reports neither reports nothing.
 */
export type DeviceContext = { timezone: string | null; region: string | null };

export function deviceContext(): DeviceContext {
  let timezone: string | null = null;
  let region: string | null = null;

  try {
    const zone = Localization.getCalendars()?.[0]?.timeZone;
    // An IANA name ("Europe/Warsaw", "America/Los_Angeles", "UTC"). The server validates
    // it against the zones Postgres knows; this only refuses what cannot be one.
    if (typeof zone === 'string' && /^[A-Za-z0-9_+\-/]{1,64}$/.test(zone.trim())) {
      timezone = zone.trim();
    }
  } catch {
    timezone = null;
  }

  try {
    const code = Localization.getLocales()?.[0]?.regionCode;
    const upper = typeof code === 'string' ? code.trim().toUpperCase() : '';
    region = /^[A-Z]{2}$/.test(upper) ? upper : null;
  } catch {
    region = null;
  }

  return { timezone, region };
}
