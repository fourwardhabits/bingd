import * as AppleAuthentication from 'expo-apple-authentication';
import * as Linking from 'expo-linking';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { track } from '@/lib/analytics';
import { supabase } from '@/lib/supabase';

/**
 * The three sign-in methods from docs/architecture/auth.md §1. Each one ends with
 * a Supabase session and nothing else — no profile, no navigation, no analytics.
 * Deciding where an authenticated user goes belongs to the router, because the
 * answer depends on whether a profile exists and that is the same question on a
 * cold start as after a sign-in (auth.md §4).
 */

export type SignInOutcome = { ok: true } | { ok: false; cancelled: boolean; message?: string };

const cancelled: SignInOutcome = { ok: false, cancelled: true };

/**
 * Apple returns the user's name **exactly once**, on the first authorization, and
 * never again (auth.md §3). It has to be captured at that moment or it is gone,
 * and there is no profile row yet to put it in — so it is parked here and read by
 * the profile screen.
 *
 * Reproducing the loss requires revoking the app in iOS Settings, which is not an
 * obvious step when a tester reports a blank display name, so getting this wrong
 * is expensive to diagnose later.
 */
const PENDING_NAME_KEY = 'bingd.pending_display_name';

export async function takePendingDisplayName(): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  const value = await SecureStore.getItemAsync(PENDING_NAME_KEY);
  return value?.trim() ? value.trim() : null;
}

async function parkPendingDisplayName(name: string) {
  if (Platform.OS !== 'web') await SecureStore.setItemAsync(PENDING_NAME_KEY, name);
}

export async function clearPendingDisplayName() {
  if (Platform.OS !== 'web') await SecureStore.deleteItemAsync(PENDING_NAME_KEY);
}

// ---------------------------------------------------------------------------
// Email one-time code
// ---------------------------------------------------------------------------

/**
 * Sends the code. Possession of it is the verification, which is why email OTP is
 * the one method that can never present the unverified-address problem in
 * auth.md §2.
 */
export async function sendEmailCode(email: string): Promise<SignInOutcome> {
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: { shouldCreateUser: true },
  });
  return error ? { ok: false, cancelled: false, message: error.message } : { ok: true };
}

export async function verifyEmailCode(email: string, code: string): Promise<SignInOutcome> {
  const { error } = await supabase.auth.verifyOtp({
    email: email.trim(),
    token: code.trim(),
    type: 'email',
  });
  if (error) return { ok: false, cancelled: false, message: error.message };
  track({ name: 'sign_in_completed', props: { method: 'email_code' } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Email + password
// ---------------------------------------------------------------------------

/**
 * Sign-in only, never sign-up: `signInWithPassword` cannot create an account, so
 * this adds no second registration flow. It exists because store review requires
 * reusable credentials that work without a one-time code — the email method above
 * delivers its code to an inbox a reviewer at Google or Apple does not have.
 * Ordinary accounts are created by code or OAuth and have no password set, so
 * this path simply fails for them; nothing about their flow changes.
 */
export async function signInWithEmailPassword(
  email: string,
  password: string,
): Promise<SignInOutcome> {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) {
    // Supabase's "Invalid login credentials" reads like a system fault; say what
    // it means. Every other error keeps its own message.
    const message =
      error.code === 'invalid_credentials'
        ? 'That email and password do not match.'
        : error.message;
    return { ok: false, cancelled: false, message };
  }
  track({ name: 'sign_in_completed', props: { method: 'password' } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Apple
// ---------------------------------------------------------------------------

/**
 * iOS only, by decision rather than by omission. Apple mandates the button
 * wherever a third-party sign-in is offered, and that mandate is Apple's platform.
 * The Android path would need a Services ID and a client secret Apple caps at six
 * months, which stops working with no warning — see app.config.ts.
 */
export async function isAppleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  return AppleAuthentication.isAvailableAsync();
}

export async function signInWithApple(): Promise<SignInOutcome> {
  try {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });

    if (!credential.identityToken) {
      return { ok: false, cancelled: false, message: 'Apple did not return a token.' };
    }

    // Before the exchange, so a network failure on the next line does not also
    // lose the one and only chance to read the name.
    const name = [credential.fullName?.givenName, credential.fullName?.familyName]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (name) await parkPendingDisplayName(name);

    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: credential.identityToken,
    });
    if (error) {
      // The parked name is cleared here, and only here, because this is the branch
      // that leaves it orphaned: no session was created, so nothing will sign out and
      // clear it, and no profile will be created and clear it either. It would sit in
      // the Keychain under a fixed key until someone else signed in on the same
      // device, and pre-fill their signup form with this person's legal name.
      await clearPendingDisplayName();
      return { ok: false, cancelled: false, message: error.message };
    }
    track({ name: 'sign_in_completed', props: { method: 'apple' } });
    return { ok: true };
  } catch (e) {
    // Apple reports a dismissed sheet as a thrown error rather than a result, so
    // without this a user who changes their mind sees a failure message.
    if (isCancellation(e)) return cancelled;
    return { ok: false, cancelled: false, message: messageOf(e) };
  }
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

/**
 * The redirect target. It must be registered in Supabase under Authentication >
 * URL Configuration, or the provider refuses the request — and it differs per
 * variant because the scheme does.
 */
export const oauthRedirectUrl = () => Linking.createURL('auth/callback');

export async function signInWithGoogle(): Promise<SignInOutcome> {
  const redirectTo = oauthRedirectUrl();

  // TEMPORARY: remove once the redirect URL is confirmed registered in Supabase.
  console.log('[oauth] redirectTo =', redirectTo);

  // skipBrowserRedirect because there is no browser to redirect: the URL is opened
  // in an in-app session so the result comes back to us rather than to the OS.
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true },
  });

  if (error || !data?.url) {
    return { ok: false, cancelled: false, message: error?.message ?? 'No authorization URL.' };
  }

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== 'success') return cancelled;

  // PKCE: the callback carries a short-lived code, not a token. The exchange is
  // what produces the session, and it is bound to a verifier held only by this
  // client — so a code intercepted from the URL is not usable by anyone else.
  const code = new URL(result.url).searchParams.get('code');
  if (!code) {
    return { ok: false, cancelled: false, message: 'The sign-in did not complete.' };
  }

  const exchange = await supabase.auth.exchangeCodeForSession(code);
  if (exchange.error) {
    return { ok: false, cancelled: false, message: exchange.error.message };
  }
  track({ name: 'sign_in_completed', props: { method: 'google' } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

/**
 * auth.md §5 also requires the outbox and the SQLite cache to be cleared here.
 * Neither exists yet; when they do, this is where they get torn down, and leaving
 * a note is better than leaving a silent omission — another account's queued
 * writes on a shared device are both a privacy leak and a correctness bug.
 */
export async function signOut() {
  await clearPendingDisplayName();
  await supabase.auth.signOut();
}

function isCancellation(e: unknown) {
  const code = (e as { code?: string } | null)?.code;
  return code === 'ERR_REQUEST_CANCELED' || code === 'ERR_CANCELED';
}

function messageOf(e: unknown) {
  return e instanceof Error ? e.message : 'Something went wrong.';
}
