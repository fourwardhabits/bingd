import { FunctionsHttpError } from '@supabase/supabase-js';

import { track } from '@/lib/analytics';
import { supabase } from '@/lib/supabase';

import type { SignInOutcome } from './methods';

/**
 * Sign in to an existing account with its **username** and a code sent to the email on
 * that account — without the email ever reaching this device. Behind
 * `USERNAME_SIGN_IN_ENABLED` (false). Design: docs/architecture/username-sign-in.md.
 *
 * The client's whole contract with the server is two calls to the `username-sign-in`
 * Edge Function:
 *
 *   send   { identifier }        → always 200 { challengeId, message }
 *   verify { challengeId, code } → 200 { session } | 400 one sentence | 429 try later
 *
 * A send answers the same whether or not the name exists, so nothing here can learn
 * whether it does — and nothing here tries to. Email sign-in, password sign-in, Apple,
 * Google and sign-up are untouched by this file; a value with an `@` never comes here.
 */

export { USERNAME_SIGN_IN_ENABLED } from './username-sign-in-flag';

/** Same as the sign-in screen's own test, so an address is recognised exactly as today. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Same as `profiles.username_format` and `create_profile` after `lower(btrim())`. */
const USERNAME = /^[a-z0-9_]{3,24}$/;

export type Identifier =
  | { kind: 'email'; email: string }
  | { kind: 'username'; username: string }
  | { kind: 'incomplete' };

/**
 * Which path a typed value takes. **Contains `@` → email**, unchanged; anything else that
 * is shaped like a username → the username path. This is a format check and nothing
 * more: it asks no server anything.
 */
export function classifyIdentifier(raw: string): Identifier {
  const value = raw.trim();
  if (value.includes('@'))
    return EMAIL.test(value) ? { kind: 'email', email: value } : { kind: 'incomplete' };
  const username = value.toLowerCase();
  return USERNAME.test(username) ? { kind: 'username', username } : { kind: 'incomplete' };
}

const SEND_FAILED = 'That did not work. Try again.';
const CODE_REFUSED = 'That code did not work. Check it, or send a new one.';
const TOO_MANY = 'Too many attempts. Try again later, or sign in with your email.';

// ---------------------------------------------------------------------------
// The challenge in hand
//
// Held in memory rather than in route params. A route param is navigation state, and
// navigation state is what crash reporting breadcrumbs; a challenge id plus a code is a
// sign-in, so it should not be anywhere a report can carry it. Lost on a cold start,
// which costs the person one more send.
// ---------------------------------------------------------------------------

type Pending = { challengeId: string; username: string };
let pending: Pending | null = null;

export const pendingUsernameChallenge = (): Pending | null => pending;
export const clearPendingUsernameChallenge = () => {
  pending = null;
};

export type UsernameSendOutcome = { ok: true } | { ok: false; message: string };

/**
 * Asks for a code for `username`. **Success means only that the request was understood**
 * — the server answers a name nobody holds, a limit, or a cooldown with exactly the same
 * body — so the caller always moves on to the code screen, and the code screen never
 * claims that an email was sent.
 */
export async function sendUsernameCode(username: string): Promise<UsernameSendOutcome> {
  try {
    const { data, error } = await supabase.functions.invoke('username-sign-in', {
      body: { action: 'send', identifier: username },
    });
    const challengeId = (data as { challengeId?: unknown } | null)?.challengeId;
    if (error || typeof challengeId !== 'string') return { ok: false, message: SEND_FAILED };
    pending = { challengeId, username };
    return { ok: true };
  } catch {
    return { ok: false, message: SEND_FAILED };
  }
}

/**
 * Exchanges the held challenge and a code for a session, then installs it.
 *
 * One sentence for every refusal the server can give about the code — wrong, expired,
 * used, locked, or a name that never existed — because the server gives one answer for
 * all of them and the screen must not invent a distinction.
 */
export async function verifyUsernameCode(code: string): Promise<SignInOutcome> {
  const held = pending;
  if (!held) return { ok: false, cancelled: false, message: CODE_REFUSED };
  try {
    const { data, error } = await supabase.functions.invoke('username-sign-in', {
      body: { action: 'verify', challengeId: held.challengeId, code: code.trim() },
    });
    if (error) {
      const limited = error instanceof FunctionsHttpError && error.context?.status === 429;
      return { ok: false, cancelled: false, message: limited ? TOO_MANY : CODE_REFUSED };
    }
    const session = (
      data as { session?: { access_token?: unknown; refresh_token?: unknown } } | null
    )?.session;
    if (
      typeof session?.access_token !== 'string' ||
      typeof session?.refresh_token !== 'string'
    ) {
      return { ok: false, cancelled: false, message: CODE_REFUSED };
    }
    const { error: setError } = await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    if (setError) return { ok: false, cancelled: false, message: CODE_REFUSED };
    pending = null;
    track({ name: 'sign_in_completed', props: { method: 'username_code' } });
    return { ok: true };
  } catch {
    return { ok: false, cancelled: false, message: CODE_REFUSED };
  }
}
