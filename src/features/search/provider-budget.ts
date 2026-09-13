import { PROVIDER_SEARCH_CACHE_MS } from '@/lib/query';

/**
 * What a provider search costs, and what this device does once the hourly budget is spent.
 *
 * Every TMDB lookup Search makes — a title search that reaches past the catalogue, and a
 * Cast search — spends one request against `tmdb.max_requests_per_hour`, a **per-account**
 * ceiling counted in fixed clock hours (`tmdb_note_request`, 20260815000000). Two rules
 * live here so both searches follow them identically.
 */

/**
 * The form a query is sent and cached under.
 *
 * TMDB's search is case-insensitive and treats runs of spaces as one, so `Network`,
 * `network` and `network ` are one question with one answer. They used to be three cache
 * entries, and so three charged requests: measured on staging on 2026-09-13, a reader
 * retyping a title with different capitalisation paid for it again every time.
 */
export function providerQueryOf(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Half an hour fresh. Held that long in memory too, by the app client's defaults for these
 * keys — see `PROVIDER_SEARCH_CACHE_MS` for why that half lives there.
 */
export const PROVIDER_CACHE_MS = PROVIDER_SEARCH_CACHE_MS;

/** The ceiling resets at the top of each hour, UTC — `date_trunc('hour', now())`. */
const HOUR_MS = 60 * 60_000;

let cooldownUntil = 0;

/**
 * Records that the server refused a provider search for this hour.
 *
 * The window is the server's clock hour, so the refusal holds until the next one. Asking
 * again before then cannot succeed: `tmdb_note_request` raises before any request leaves,
 * so every retry is an Edge Function invocation that is guaranteed to come back 429. The
 * only thing that can end it is the hour turning over, and that time is knowable here.
 *
 * Module state rather than query state because the budget is one thing shared by the
 * title search and Cast search — hitting it on one is hitting it on both.
 */
export function noteProviderRateLimited(now = Date.now()) {
  cooldownUntil = Math.ceil((now + 1) / HOUR_MS) * HOUR_MS;
}

/** When provider search comes back, or null while it is available. */
export function providerCooldownUntil(now = Date.now()): number | null {
  return cooldownUntil > now ? cooldownUntil : null;
}

/**
 * Lifts the cooldown for a deliberate retry.
 *
 * "Try again" is a person asking, which is different from the app asking on every
 * keystroke. It also covers the one case the local clock cannot see: a different account
 * signed in on this device inside the same hour has a budget of its own.
 */
export function clearProviderCooldown() {
  cooldownUntil = 0;
}

/**
 * "6:00 PM", or the device locale's equivalent — the moment the budget resets.
 *
 * Local time for a UTC boundary, which is correct everywhere including the half-hour
 * zones: in India the hour turns over at half past, and that is what this prints.
 */
export function cooldownClock(until: number): string {
  return new Date(until).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
