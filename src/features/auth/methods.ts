import * as AppleAuthentication from 'expo-apple-authentication';
import * as Linking from 'expo-linking';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { releaseDeviceOnSignOut } from '@/features/notifications/push';
import { track } from '@/lib/analytics';
import { reportHandled } from '@/lib/monitoring';
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
// Email one-time code — the canonical Bingd-owned method
//
// One call, one screen, one `EmailOtpType`, for somebody who has an account and for
// somebody who does not. That is the founder's 2026-08-26 final decision and it is also
// what `@supabase/auth-js` documents: `signup` and `magiclink` are **deprecated** verify
// types, and `'email'` is the one "used when verifying an OTP sent to the user's email
// during sign-up or sign-in" — both, deliberately, in one type.
//
// The short-lived password-first amendment is gone from the ordinary path. What survives
// of it is `signInWithEmailPassword` below, which is now reachable only from a secondary
// screen and exists for store-review access. Nobody creates a password in v1.
// ---------------------------------------------------------------------------

/**
 * The one `EmailOtpType` this app sends, named where it is decided.
 *
 * Read off the installed `@supabase/auth-js@2.112.3` union rather than guessed, and
 * pinned as a literal in `methods.email.test.ts`. Its own documentation is the reason
 * there is one value here and not two:
 *
 *   > note: `signup` and `magiclink` types are deprecated
 *   > `email` – Used when verifying an OTP sent to the user's email during sign-up or
 *   > sign-in.
 *
 * GoTrue resolves it against whichever column holds the token — the signup confirmation
 * for an address that had no account, the magic-link one for an address that did — so
 * the client never has to know which of the two it is about to receive. That is what
 * makes a single unified flow possible, and a client that *did* have to know would have
 * to ask "do you already have an account?" before it could send anything.
 */
const EMAIL_OTP_TYPE = 'email' as const;

/**
 * Sends a six-digit code, to an address that may or may not already have an account.
 *
 * ---------------------------------------------------------------------------
 * `shouldCreateUser: true`, AND IT IS WHAT MAKES THIS ONE FLOW
 *
 * With it, GoTrue does the branching Bingd would otherwise have to: an unknown address
 * gets an `auth.users` row and a **Confirm signup** email, a known one gets a **Magic
 * Link** email, and both arrive as six digits that `verifyEmailCode` accepts. Nobody is
 * asked to declare whether they are signing up or signing in before typing their address,
 * which is the whole of §2 of the decision.
 *
 * ---------------------------------------------------------------------------
 * IT IS ALSO WHAT RESTORES ANTI-ENUMERATION
 *
 * This briefly ran with `shouldCreateUser: false`, and independent review 44 recorded the
 * consequence as an accepted risk: GoTrue answered a known address with a send and an
 * unknown one with `otp_disabled`, so repeated attempts told somebody whether an address
 * had a Bingd account. With `true` the two answers are identical — a send, either way —
 * and there is nothing left to probe. The risk is closed rather than accepted.
 *
 * The cost, stated plainly and unchanged since the first version of this function: a
 * mistyped address mints a permanent, profile-less `auth.users` row that nothing prunes
 * (`docs/architecture/auth.md` §8, still open).
 */
export async function sendEmailCode(email: string): Promise<SignInOutcome> {
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: { shouldCreateUser: true },
  });
  if (error) {
    const message =
      error.code === 'over_email_send_rate_limit'
        ? 'Too many emails just now. Wait a minute and try again.'
        : error.code === 'signup_disabled'
          ? 'New accounts are not being accepted right now.'
          : error.message;
    return { ok: false, cancelled: false, message };
  }
  return { ok: true };
}

/**
 * Turns the code into a session, whichever email carried it.
 *
 * A returning user is signed in. A new address is confirmed, which is the moment its
 * `auth.users` row becomes usable — and `useAuthRouting` sends it to `create-profile`,
 * because a session with no profile is the same state on this path as on Apple's and
 * Google's. There is no separate "finish signing up" step in this app and there does not
 * need to be one.
 */
export async function verifyEmailCode(email: string, code: string): Promise<SignInOutcome> {
  const { error } = await supabase.auth.verifyOtp({
    email: email.trim(),
    token: code.trim(),
    type: EMAIL_OTP_TYPE,
  });
  if (error) return { ok: false, cancelled: false, message: error.message };
  track({ name: 'sign_in_completed', props: { method: 'email_code' } });
  return { ok: true };
}

/** Test seam and single source of truth for the `EmailOtpType` in use. */
export const EMAIL_OTP_TYPES = { code: EMAIL_OTP_TYPE } as const;

// ---------------------------------------------------------------------------
// Password — retained, and reachable only from "Sign in with password"
//
// Supabase's password capability stays; the *product* affordance for it does not. There
// is no create-account-with-a-password screen and no password field in Settings, so in
// ordinary use nothing in Bingd ever sets one and this function has nothing to sign in.
//
// It exists for the account an App Store or Play reviewer is given: a store reviewer has
// no access to a mailbox, so an OTP-only app is an app whose sign-in screen review cannot
// get past. A password on one deliberately provisioned account is the smallest thing that
// solves it. See docs/release/store-review-access.md.
// ---------------------------------------------------------------------------

export async function signInWithEmailPassword(
  email: string,
  password: string,
): Promise<SignInOutcome> {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) {
    /**
     * One sentence for every way this can fail to be a session, and that is deliberate.
     *
     * `invalid_credentials` already covers "no such account" and "wrong password" with
     * one answer — GoTrue's own anti-enumeration, kept. `email_not_confirmed` and
     * `user_not_found` are folded into it here rather than reported separately: an
     * ordinary Bingd account has no password at all, so a distinct message for each of
     * these would describe the *state of an address* to whoever asked, from a screen
     * that is meant to be a back door for one provisioned account.
     *
     * The person this screen is actually for has correct credentials handed to them in a
     * review note, so the copy is not carrying anybody's recovery.
     */
    const message =
      error.code === 'over_request_rate_limit' || error.code === 'over_email_send_rate_limit'
        ? 'Too many attempts just now. Wait a minute and try again.'
        : 'We could not sign you in with that email and password.';
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

/**
 * How the iOS web sign-in session is opened, and why it is opened that way.
 *
 * ---------------------------------------------------------------------------
 * THE DIALOG THE FOUNDER PHOTOGRAPHED
 *
 *     "bingd" Wants to Use "abheeqyjzekiowkztfxv.supabase.co" to Sign In
 *
 * That is iOS asking permission before an `ASWebAuthenticationSession` is allowed to
 * read the Safari cookie jar for a domain, and it names the domain in the prompt. The
 * domain is the Supabase project host, because that is where the OAuth handshake
 * starts — so the first thing a new user is shown is a random-looking hostname they
 * have never heard of, attached to a permission request. It is the single worst
 * sentence in the sign-in flow and none of it is about Google.
 *
 * **Only one code path in this app can produce it.** `signInWithGoogle` below is the
 * only caller of `openAuthSessionAsync`; Apple goes through
 * `AppleAuthentication.signInAsync`, which is native and shows no browser at all, and
 * the two email methods are direct API calls. So this is scoped to Google on iOS.
 *
 * ---------------------------------------------------------------------------
 * WHAT EPHEMERAL CHANGES
 *
 * `preferEphemeralSession` sets `prefersEphemeralWebBrowserSession` on the session.
 * The browser then runs with its own empty cookie store rather than Safari's — and
 * because there is no shared state to ask about, iOS does not ask. The prompt is not
 * suppressed; it becomes inapplicable.
 *
 * Nothing about the security of the flow moves. This is still PKCE: the callback
 * carries a code, the exchange below is bound to a verifier held only by this client,
 * and the redirect is the same registered URL either way. The callback still arrives
 * as `result.url`, and a dismissed sheet still returns a non-`success` type, so
 * cancellation is unchanged.
 *
 * **The trade, stated plainly: the user signs in to Google every time.** With the
 * shared jar, somebody already signed in to Google in Safari would often be through in
 * one tap. Ephemeral gives that up — each sign-in is a full provider interaction, and
 * on a second sign-in on the same device it will not be remembered.
 *
 * That trade is worth taking *here* and would not be everywhere. Sign-in happens once
 * per install in practice: the Supabase session persists in `SecureStore` and is
 * refreshed, so the browser is not part of returning to the app. Weighing one extra
 * Google password entry per install against every new user's first impression being a
 * permission dialog about `abheeqyjzekiowkztfxv.supabase.co` is not a close call. It
 * also means the app stops leaving a signed-in Google session in the user's Safari,
 * which is a small privacy improvement on a shared device.
 *
 * **iOS only, and explicitly rather than incidentally.** The option is iOS-only in
 * `expo-web-browser` and Android would ignore it — but "ignored today" is a fact about
 * a library version, and Android's Custom Tabs flow is working and is not what the
 * founder reported. The platform check says the scope out loud so a future version
 * that starts honouring it cannot change Android's behaviour by accident.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 *
 * It is not the real fix, and it should not be mistaken for one. The reason the prompt
 * named a hostname nobody recognises is that the hostname *is* a hostname nobody
 * recognises. A Supabase custom domain — `auth.bingd.app` — is what makes every
 * remaining surface that shows the OAuth origin say the right thing: the address bar
 * inside the sheet, Google's own consent screen, and this dialog if it ever returns.
 * That is a DNS and Supabase-project change rather than a client one, so it is out of
 * scope for an OTA UI tranche, and it is recommended for production regardless of this.
 */
const authSessionOptions =
  Platform.OS === 'ios' ? { preferEphemeralSession: true } : undefined;

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

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo, authSessionOptions);
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
 *
 * **The push token is now one of those things, and it is the one with a name attached.**
 * A device registered to this account and left registered would deliver their follows,
 * comments and recommendations — with the sender's name and the film's title on the lock
 * screen — to whoever signs in next. So the release happens **here**, before the session
 * ends, because revoking needs a JWT and there is none a line later.
 *
 * It cannot fail loudly. `releaseDeviceOnSignOut` reports and returns rather than
 * throwing: a rejection here would leave somebody signed in, which is a worse outcome
 * than a stale token — and a stale token is not the last line of defence anyway.
 * `register_device_token` moves a device to whoever registers it next, so the account
 * that signs in after this takes the device whether or not this succeeded.
 */
export async function signOut() {
  await releaseDeviceOnSignOut();

  /**
   * **Nothing between here and the session teardown may prevent it, and this is the line
   * that was one rejection away from not being true.** Independent review 45.
   *
   * `clearPendingDisplayName` is a Keychain/Keystore delete, and `SecureStore` rejects
   * rather than returning on a locked or unavailable store. An unguarded `await` there
   * meant the next line never ran: the person taps *Sign out*, sees nothing happen, and
   * is still signed in — with a rejected promise nobody catches, because all four callers
   * write `await signOut()` and then navigate.
   *
   * The worst caller is `app/settings/account.tsx`, where the account has **already been
   * deleted server-side** and this session is the last thing pointing at it.
   *
   * A stale pending name is a cosmetic problem; a session that outlives the tap is not.
   */
  try {
    await clearPendingDisplayName();
  } catch (e) {
    reportHandled(e, { scope: 'signOut.clearPendingDisplayName' });
  }

  /**
   * And the teardown itself cannot be the thing that throws either.
   *
   * `supabase.auth.signOut()` returns `{ error }` rather than rejecting for a server-side
   * failure — it clears the local session regardless, which is the behaviour that matters
   * here — but it reads storage on the way, and this function's contract to its callers is
   * that it settles. Where it genuinely could not end the session, the router sees a live
   * session and keeps the user where they are, which is the same outcome as today minus an
   * unhandled rejection.
   */
  try {
    await supabase.auth.signOut();
  } catch (e) {
    reportHandled(e, { scope: 'signOut.supabase' });
  }
}

function isCancellation(e: unknown) {
  const code = (e as { code?: string } | null)?.code;
  return code === 'ERR_REQUEST_CANCELED' || code === 'ERR_CANCELED';
}

function messageOf(e: unknown) {
  return e instanceof Error ? e.message : 'Something went wrong.';
}
