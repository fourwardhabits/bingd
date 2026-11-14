/**
 * The numbers, in one place on the function side.
 *
 * The rate limits themselves are enforced in SQL (20261123000100), where they can be
 * serialised; they are repeated here only so the docs, the tests and the database can be
 * checked against one another. Changing one means changing all three, deliberately.
 */

/** Same rule as `profiles.username_format` and `create_profile`. */
export const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;

/** Anything longer is not a username and is not worth hashing at length. */
export const MAX_IDENTIFIER_LENGTH = 64;

/** 32 bytes, base64url without padding: 43 characters. */
export const CHALLENGE_ID_BYTES = 32;
export const CHALLENGE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Generous: a body is `{action, identifier}` or `{action, challengeId, code}`. */
export const MAX_BODY_BYTES = 2048;

/**
 * Every response is held until at least `floor + U(0, jitter)` ms after the request
 * arrived. The send floor only has to cover the database round trip, because the
 * GoTrue send itself runs after the response (`waitUntil`). The verify floor has to cover
 * GoTrue's `/verify`, which cannot be deferred because its result *is* the response.
 */
export const TIMING = {
  sendFloorMs: 900,
  verifyFloorMs: 1200,
  jitterMs: 250,
} as const;

/** Mirrors of the SQL constants, for the docs and the cross-check test. */
export const SQL_LIMITS = {
  challengeTtlMinutes: 10,
  maxAttempts: 5,
  sendsPerIdentifierPerHour: 3,
  sendsPerIpPerHour: 10,
  verifiesPerIpPerHour: 30,
  perAccountCooldownSeconds: 60,
  retentionHours: 24,
} as const;

/** The only sentences this function ever says. */
export const COPY = {
  sent: 'If that account exists, we sent a code to its email.',
  invalid: 'That code did not work. Check it, or send a new one.',
  limited: 'Too many attempts. Try again later.',
  badRequest: 'That request was not understood.',
  unavailable: 'Signing in with a username is not available right now. Use your email instead.',
} as const;

/** Minimum length of USERNAME_SIGN_IN_HASH_KEY. */
export const MIN_HASH_KEY_LENGTH = 32;
