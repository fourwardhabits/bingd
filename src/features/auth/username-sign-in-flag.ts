/**
 * Username-or-email sign-in — **off**, and off by a constant on purpose.
 *
 * Not a remote flag and not an `app_config` row: turning this on is a founder-approved OTA
 * that ships *after* the `username-sign-in` Edge Function and its migration are live in
 * production (docs/architecture/username-sign-in.md §9). A remote flag could be flipped
 * ahead of the server it depends on; a constant can only move with a reviewed release.
 *
 * While it is false the sign-in screen is exactly today's — one Email field, the same
 * copy, the same calls — and `verify-username` sends anybody who reaches it back to sign
 * in. It lives in a module with no imports so that reading it pulls in nothing else.
 */
export const USERNAME_SIGN_IN_ENABLED = false;
