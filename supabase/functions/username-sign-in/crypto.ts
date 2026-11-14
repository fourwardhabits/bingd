import { CHALLENGE_ID_BYTES, USERNAME_PATTERN } from './limits.ts';

const encoder = new TextEncoder();

const toHex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * 256 bits from the platform CSPRNG, base64url. The only copy lives on the device that
 * asked; the database holds its SHA-256. Minted *before* the account is looked up, so a
 * hit and a miss cannot differ in how their id was made.
 */
export function newChallengeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CHALLENGE_ID_BYTES));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Unkeyed is enough for the challenge id: its preimage is 256 random bits. Looking a
 * challenge up by this hash is also what makes the lookup constant-time in the sense that
 * matters — an attacker cannot steer a b-tree comparison through a SHA-256.
 */
export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/**
 * Keyed, for the identifier and the IP: both are guessable, so an unkeyed hash of either
 * would be a lookup table away from the plain value. The `purpose` prefix keeps an IP and
 * a username that happen to share a spelling from sharing a bucket.
 */
export async function hmacHex(key: string, purpose: 'id' | 'ip', value: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', k, encoder.encode(`${purpose}:${value}`)));
}

/**
 * `create_profile`'s normalisation — `lower(btrim(...))` — and its format rule. Returns
 * null for anything that could not be a username, which the caller treats exactly like a
 * name nobody holds.
 *
 * Deliberately no `@` stripping: anything with an `@` is an email and belongs to the
 * client's email path, which this function never serves.
 */
export function normaliseUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().toLowerCase();
  return USERNAME_PATTERN.test(name) ? name : null;
}
