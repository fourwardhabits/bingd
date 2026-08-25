import * as AppleAuthentication from 'expo-apple-authentication';
import * as Linking from 'expo-linking';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { releaseDeviceOnSignOut } from '@/features/notifications/push';
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
// Email and password — the default method since the founder's 2026-08-26 decision
//
// It used to be the other way round: `sendEmailCode` was the door and this was a
// sign-in-only affordance for store reviewers, who have no inbox to receive a code in.
// The decision reversed for a reason the friend beta made concrete — **a password is the
// only email method that sends no mail at all.** Every returning sign-in through it costs
// zero transactional email, which matters while the project is still on Supabase's
// built-in sender and its rate limit (docs/architecture/auth.md).
//
// Passwordless survives as an explicit secondary action, and §"Verifying a new account"
// below is why the change did not cost the in-app experience: a new password account is
// verified with a numeric code typed into Bingd, not a link tapped in a browser.
// ---------------------------------------------------------------------------

/** The four `EmailOtpType` values this app uses, named where they are decided. */
const OTP_TYPE = {
  /**
   * A token from **Confirm signup**, which is what `signUp` triggers.
   *
   * `'signup'` and not `'email'`, and the difference is not cosmetic: GoTrue looks the
   * token up in a different column per type, so verifying a signup token as `'email'`
   * fails with `otp_expired` — a wrong code, indistinguishable from a mistyped one, on
   * a path where the person definitely typed it correctly. Read off the installed
   * `@supabase/auth-js@2.112.3` union (`EmailOtpType`), not guessed, and pinned in
   * `methods.password.test.ts`.
   */
  signup: 'signup',
  /** A token from `signInWithOtp` on an address that already has an account. */
  passwordless: 'email',
} as const;

/**
 * What a sign-up attempt actually did.
 *
 * Richer than `SignInOutcome` because the caller has three destinations rather than two:
 * the verification screen, straight into the app, and back to the form.
 */
export type SignUpOutcome =
  | { ok: true; needsVerification: boolean }
  | { ok: false; message: string };

/**
 * Creates an account from an email and a password.
 *
 * ---------------------------------------------------------------------------
 * IT DOES NOT SAY WHETHER THE EMAIL WAS ALREADY TAKEN
 *
 * Supabase deliberately obfuscates that: for an address that already has a **confirmed**
 * account it returns a plausible-looking user with an empty `identities` array and sends
 * nothing. Reading that array and reporting "you already have an account" would turn this
 * form into an address-checker for anybody who wanted one, which is the enumeration the
 * obfuscation exists to prevent.
 *
 * So this returns the same `needsVerification: true` either way and the verification
 * screen carries a permanent "Sign in instead". Somebody who really does have an account
 * gets a way out without the app having confirmed anything about the address; somebody
 * who does not gets their code. An address that exists but is **unconfirmed** is the
 * common case of a person who closed the app mid-signup, and `signUp` genuinely resends
 * to it — so that person is simply back where they left off.
 *
 * ---------------------------------------------------------------------------
 * `needsVerification` IS READ FROM THE SESSION, NOT ASSUMED
 *
 * With "Confirm email" on — which is the intended configuration and the one the founder
 * asked not to weaken — `signUp` returns `session: null` and mail goes out. With it off
 * a session comes back and the account is already usable. Branching on what is in front
 * of us rather than on what the project is believed to be configured with means the
 * screen behaves correctly under either, instead of stranding somebody on a code screen
 * for a code that will never arrive.
 */
export async function signUpWithEmailPassword(
  email: string,
  password: string,
): Promise<SignUpOutcome> {
  const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });

  if (error) {
    const message =
      error.code === 'weak_password'
        ? 'Choose a longer password.'
        : error.code === 'over_email_send_rate_limit'
          ? 'Too many emails just now. Wait a minute and try again.'
          : error.code === 'signup_disabled'
            ? 'New accounts are not being accepted right now.'
            : error.message;
    return { ok: false, message };
  }

  const needsVerification = !data.session;
  if (!needsVerification) track({ name: 'sign_in_completed', props: { method: 'password' } });
  return { ok: true, needsVerification };
}

/**
 * Turns the code from a **Confirm signup** email into a session.
 *
 * The whole point of the amendment: the person never leaves Bingd. `verifyOtp` with a
 * token establishes the session directly, where `{{ .ConfirmationURL }}` would have
 * completed the sign-in inside a browser and produced a session this app never sees —
 * which is exactly what a friend-beta tester reported.
 */
export async function verifySignUpCode(email: string, code: string): Promise<SignInOutcome> {
  const { error } = await supabase.auth.verifyOtp({
    email: email.trim(),
    token: code.trim(),
    type: OTP_TYPE.signup,
  });
  if (error) return { ok: false, cancelled: false, message: error.message };
  track({ name: 'sign_in_completed', props: { method: 'password' } });
  return { ok: true };
}

/**
 * Sends another **Confirm signup** code.
 *
 * `resend` rather than calling `signUp` again, which is what a second Post would
 * otherwise be. They are not equivalent: `signUp` carries a password and would overwrite
 * the pending one, so somebody who typed a different password on the second attempt
 * would end up with an account whose password is not the one they think they set.
 * `resend` carries nothing but the address.
 */
export async function resendSignUpCode(email: string): Promise<SignInOutcome> {
  const { error } = await supabase.auth.resend({ type: 'signup', email: email.trim() });
  if (error) {
    const message =
      error.code === 'over_email_send_rate_limit'
        ? 'Too many emails just now. Wait a minute and try again.'
        : error.message;
    return { ok: false, cancelled: false, message };
  }
  return { ok: true };
}

/**
 * The returning-user path, and now the common one.
 *
 * ---------------------------------------------------------------------------
 * `unverified` IS A THIRD OUTCOME, NOT A FAILURE MESSAGE
 *
 * Somebody who created an account and closed Bingd before typing the code comes back to
 * a password that is correct and an account that cannot be used. GoTrue answers
 * `email_not_confirmed`, and reporting that as "that email and password do not match" —
 * which is what a single failure branch does — tells them something false about the
 * password they just typed correctly, for ever. The founder's §7: *do not tell them
 * merely "invalid login" forever.*
 *
 * So the caller gets a distinct outcome and sends them to the verification screen. It
 * discloses nothing that the attempt did not already establish: whoever presented the
 * correct password for that address is not learning anything new about it.
 */
export type PasswordSignInOutcome =
  | { ok: true }
  | { ok: false; unverified: true }
  | { ok: false; unverified: false; message: string };

export async function signInWithEmailPassword(
  email: string,
  password: string,
): Promise<PasswordSignInOutcome> {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) {
    if (error.code === 'email_not_confirmed') return { ok: false, unverified: true };
    // Supabase's "Invalid login credentials" reads like a system fault; say what
    // it means. It is also deliberately the same answer for "no such account" and
    // "wrong password", which is GoTrue's anti-enumeration behaviour and is kept.
    const message =
      error.code === 'invalid_credentials'
        ? 'That email and password do not match.'
        : error.message;
    return { ok: false, unverified: false, message };
  }
  track({ name: 'sign_in_completed', props: { method: 'password' } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Email one-time code — now the explicit secondary method
// ---------------------------------------------------------------------------

/**
 * Sends a sign-in code to an address that **already has an account**.
 *
 * ---------------------------------------------------------------------------
 * `shouldCreateUser: false`, WHICH IS THE WHOLE OF THE CHANGE HERE
 *
 * It was `true`, correctly, while this was the door: an unknown address arriving here was
 * somebody signing up. It is now a *secondary sign-in*, and leaving it `true` would make
 * "Sign in without a password" a second, invisible registration route — one that mints a
 * permanent `auth.users` row for every typo, and produces an account with no password on
 * a screen whose sibling is the one that sets one.
 *
 * The cost is that an unknown address now fails instead of silently working, and GoTrue
 * reports that as `otp_disabled` ("Signups not allowed for otp"), whose wording describes
 * the *setting* rather than the situation. The caller says something usable instead —
 * and deliberately says the same thing it would say for a known address whose mail
 * failed, so this does not become an address-checker either.
 *
 * `docs/architecture/auth.md` §2's note that this method cannot present the unverified
 * address problem still holds: possession of the code is the verification.
 */
export async function sendEmailCode(email: string): Promise<SignInOutcome> {
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: { shouldCreateUser: false },
  });
  if (error) {
    const message =
      error.code === 'otp_disabled' || error.code === 'user_not_found'
        ? 'We could not send a code to that address. Check it, or create an account.'
        : error.code === 'over_email_send_rate_limit'
          ? 'Too many emails just now. Wait a minute and try again.'
          : error.message;
    return { ok: false, cancelled: false, message };
  }
  return { ok: true };
}

export async function verifyEmailCode(email: string, code: string): Promise<SignInOutcome> {
  const { error } = await supabase.auth.verifyOtp({
    email: email.trim(),
    token: code.trim(),
    type: OTP_TYPE.passwordless,
  });
  if (error) return { ok: false, cancelled: false, message: error.message };
  track({ name: 'sign_in_completed', props: { method: 'email_code' } });
  return { ok: true };
}

/** The two verification flows, so a screen can carry which one it is in. */
export type VerifyMode = 'signup' | 'passwordless';

/** Test seam and single source of truth for the two `EmailOtpType` values in use. */
export const EMAIL_OTP_TYPES = OTP_TYPE;

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
