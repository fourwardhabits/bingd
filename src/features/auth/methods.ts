import * as AppleAuthentication from 'expo-apple-authentication';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { releaseDeviceOnSignOut } from '@/features/notifications/push';
import { track } from '@/lib/analytics';
import { note } from '@/lib/flight-recorder';
import { withGrace } from '@/lib/grace';
import { reportHandled } from '@/lib/monitoring';
import { sessionStorage } from '@/lib/session-storage';
import { announceLocalSignOut, authStorageKey, supabase } from '@/lib/supabase';

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
 * The redirect target, and the guard around it.
 *
 * ===========================================================================
 * WHAT WENT WRONG, WHICH IS NOT WHAT THIS FILE USED TO SAY
 *
 * `docs/architecture/auth.md` claimed that "an unregistered value is refused by Supabase
 * before the provider is ever contacted — so the symptom names the redirect and not the
 * provider". **That is false, and it is the whole defect.** Probed against the production
 * project on 2026-09-10:
 *
 *   redirect_to=bingd://auth/callback   -> Location: bingd://auth/callback#...   honoured
 *   redirect_to=https://evil.example.com-> Location: https://bingd.app#...       fell back
 *   redirect_to omitted                 -> Location: https://bingd.app#...       fell back
 *
 * GoTrue does not refuse an unusable redirect. It substitutes `site_url` — which is
 * `https://bingd.app` — and contacts Google anyway. So the user authenticates
 * *successfully* and is then handed to the marketing site inside the auth sheet, with no
 * error raised anywhere and no session created. The founder hit exactly this from
 * TestFlight on build 10.
 *
 * `https://bingd.app/auth/callback` is *also* in the allow-list, and is no better: the
 * AASA claims only `/u/*`, `/lists/*`, `/title/*` and `/i/*`, so an https callback cannot
 * re-enter the app, and Cloudflare Pages serves `index.html` at 200 for the unmatched
 * path. Same dead end, by a different door.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TESTS COULD NOT SEE IT
 *
 * `methods.oauth.test.ts` mocked the thing under suspicion:
 *
 *     jest.mock('expo-linking', () => ({ createURL: (path) => `bingd://${path}` }));
 *
 * so `expect(...redirectTo).toBe('bingd://auth/callback')` asserted the mock's own return
 * value. `Linking.createURL` reads a native scheme registry that jest does not have, and
 * whatever it answers on a device, that assertion passes. The suite agreed with the
 * harness instead of with production — the same lesson `supabase/tests/harness.mjs`
 * records about RLS.
 *
 * ---------------------------------------------------------------------------
 * SO THE SOURCE OF TRUTH IS THE CONFIG, NOT THE HELPER
 *
 * The binary registered exactly one scheme and `app.config.ts` is where it is declared
 * (`variants[].scheme`: `bingd`, `bingd-dev`, `bingd-preview`). `Constants.expoConfig`
 * is that same resolved config read back at runtime, so the callback is **built** from it
 * rather than asked for. No magic string is duplicated here: change the scheme in
 * `app.config.ts` and this follows.
 *
 * `Linking.createURL` is still consulted, for one reason only — it is the value the
 * previous build actually sent, so a disagreement is the defect reporting itself. A
 * divergence is recorded and the *canonical* value is used regardless, because the
 * canonical value is the one the scheme registry and the Supabase allow-list agree on.
 *
 * Expo Go is the one environment with no custom scheme of its own; `exp://**` is
 * allow-listed for it and is accepted only when it is what `createURL` produced.
 */
const OAUTH_CALLBACK_PATH = 'auth/callback';

/** The scheme this binary registered, from the resolved Expo config. */
const registeredScheme = (): string | null => {
  const declared = Constants.expoConfig?.scheme;
  if (typeof declared === 'string' && declared.length > 0) return declared;
  if (Array.isArray(declared)) {
    return declared.find((s): s is string => typeof s === 'string' && s.length > 0) ?? null;
  }
  return null;
};

/**
 * Scheme, host and path — never a query string and never a fragment.
 *
 * Everything secret in an OAuth callback lives in exactly those two places: the
 * authorization `code` is a query parameter and an implicit-flow token is a fragment. So
 * cutting at the first `?` or `#` is not a best-effort redaction, it is the whole
 * boundary, and what remains cannot carry a credential. Length is capped as well, so a
 * malformed value cannot turn a breadcrumb into a payload.
 */
export const sanitizeRedirect = (raw: unknown): string => {
  if (typeof raw !== 'string' || raw.length === 0) return '(empty)';
  const path = raw.split('#')[0]?.split('?')[0] ?? '';
  if (path.length === 0) return '(empty)';
  return path.length > 120 ? `${path.slice(0, 120)}…` : path;
};

export type OAuthRedirect =
  | { ok: true; url: string; sanitized: string }
  | { ok: false; problem: 'no_scheme' | 'not_the_app'; sanitized: string };

/**
 * Resolves the callback, or refuses. It never returns a value it has not checked.
 */
export function resolveOAuthRedirect(): OAuthRedirect {
  const scheme = registeredScheme();
  const produced = (() => {
    try {
      return Linking.createURL(OAUTH_CALLBACK_PATH);
    } catch {
      return '';
    }
  })();
  const sanitized = sanitizeRedirect(produced);

  /**
   * Expo Go is decided by the *environment*, not by the absence of a scheme.
   *
   * This first read "if there is no scheme, accept an `exp://` URL", which is wrong and
   * an independent review caught it: `app.config.ts` always declares a scheme and Expo
   * Go serves that same resolved config, so `registeredScheme()` never returns null
   * there. The branch was unreachable, Expo Go would have been sent
   * `bingd://auth/callback` — a scheme it has not registered — and the sheet would never
   * have come back. That is the very defect this function exists to prevent, reintroduced
   * one environment over.
   *
   * `executionEnvironment` is the honest discriminator: `storeClient` is Expo Go,
   * `standalone` and `bare` are builds that registered their own scheme. In Expo Go
   * `createURL` is authoritative — the wildcard `exp:` callback is allow-listed in
   * Supabase for exactly this — and everywhere else it is only evidence.
   */
  const inExpoGo =
    Constants.executionEnvironment === 'storeClient' || Constants.appOwnership === 'expo';

  if (inExpoGo) {
    if (sanitized.startsWith('exp://') && sanitized.endsWith(`/--/${OAUTH_CALLBACK_PATH}`)) {
      return { ok: true, url: produced, sanitized };
    }
    return { ok: false, problem: 'not_the_app', sanitized };
  }

  if (!scheme) return { ok: false, problem: 'no_scheme', sanitized };

  const canonical = `${scheme}://${OAUTH_CALLBACK_PATH}`;

  // The assertion is on the value about to be sent, not on the one that was produced.
  // It cannot fail as long as `scheme` is a scheme, and it is here so that a future
  // change to how the callback is built cannot quietly ship an https redirect again.
  if (sanitizeRedirect(canonical) !== canonical || canonical.includes('://.')) {
    return { ok: false, problem: 'not_the_app', sanitized: sanitizeRedirect(canonical) };
  }

  return { ok: true, url: canonical, sanitized: canonical };
}

/**
 * Kept as the public name the rest of the app and its tests already use. It answers the
 * checked value, and `signInWithGoogle` is the caller that handles a refusal.
 */
export const oauthRedirectUrl = () => {
  const resolved = resolveOAuthRedirect();
  return resolved.ok ? resolved.url : null;
};

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
const authSessionOptions = Platform.OS === 'ios' ? { preferEphemeralSession: true } : undefined;

export async function signInWithGoogle(): Promise<SignInOutcome> {
  const resolved = resolveOAuthRedirect();

  /**
   * The refusal happens **before** the provider is contacted, and that ordering is the
   * point. Sending an unusable redirect does not fail — it succeeds all the way through
   * Google and then strands the person on `https://bingd.app` with no session and no
   * error. Stopping here costs one sign-in attempt; not stopping costs the account.
   *
   * Nothing recorded below can carry a credential: `sanitized` is scheme, host and path
   * with the query string and fragment already cut off, which is where an authorization
   * code or a token would be. No email, no identity, no URL parameters.
   */
  if (!resolved.ok) {
    track({ name: 'sign_in_redirect_rejected', props: { problem: resolved.problem } });
    note('auth', 'oauth redirect rejected', `${resolved.problem} ${resolved.sanitized}`);
    reportHandled(new Error(`OAuth redirect rejected: ${resolved.problem}`), {
      redirect: resolved.sanitized,
    });
    return {
      ok: false,
      cancelled: false,
      // Apple is named only where the button exists. `signInWithApple` is gated on
      // `AppleAuthentication.isAvailableAsync`, which is false on Android, so the
      // original wording sent half of the users to a control that is not on their
      // screen — advice that reads as the app being broken twice over.
      message:
        Platform.OS === 'ios'
          ? 'Google sign-in cannot start on this build. Use email or Apple to get in, and please report this.'
          : 'Google sign-in cannot start on this build. Use your email address to get in, and please report this.',
    };
  }

  const redirectTo = resolved.url;

  // A breadcrumb for the flight recorder on the way *in*, so a session that never comes
  // back still says which callback it left on. Sanitized for the same reason as above.
  note('auth', 'oauth redirect', resolved.sanitized);

  // skipBrowserRedirect because there is no browser to redirect: the URL is opened
  // in an in-app session so the result comes back to us rather than to the OS.
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true },
  });

  if (error || !data?.url) {
    return { ok: false, cancelled: false, message: error?.message ?? 'No authorization URL.' };
  }

  const result = await WebBrowser.openAuthSessionAsync(
    data.url,
    redirectTo,
    authSessionOptions,
  );
  if (result.type !== 'success') return cancelled;

  /**
   * The return leg is checked too, and for the same reason the outbound one is.
   *
   * `ASWebAuthenticationSession` reports `success` when it intercepts the scheme it was
   * given, so in principle this can only be the app's own callback. In principle is what
   * the outbound assumption was as well. If the URL that came back is not the callback
   * that was sent, the safe thing is to say the sign-in did not complete rather than to
   * parse a `code` out of a page we did not expect to be on.
   */
  const landed = sanitizeRedirect(result.url);
  if (landed !== resolved.sanitized) {
    track({ name: 'sign_in_redirect_rejected', props: { problem: 'wrong_landing' } });
    note('auth', 'oauth landed elsewhere', landed);
    reportHandled(new Error('OAuth callback landed on an unexpected URL'), {
      expected: resolved.sanitized,
      landed,
    });
    return {
      ok: false,
      cancelled: false,
      message: 'Google sent us somewhere unexpected. Please try again.',
    };
  }

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
//
// THE BUDGETS BELOW, AND WHY EACH OF THEM IS SHORT
//
// **Every step below is a promise the platform is allowed to never settle**, which is
// what the founder's build-4 device demonstrated: `Signing out…` sat for twenty seconds
// and did not arrive anywhere. Two of these are network calls and two are Keychain
// calls, and the previous version of this function awaited all four unbounded — so a
// single lost reply held the exit open for the life of the process, and the 8-second
// grace at the button was reached with the session still alive, which routing correctly
// read as "still signed in" and sent the person back where they came from.
//
// They add up to less than that grace on purpose. A bound that only the caller holds is
// a bound that hands the caller a live session; these end the session *within* the
// caller's patience so that the navigation which follows lands somewhere.
// ---------------------------------------------------------------------------

/**
 * Enough for the revoke `releaseDeviceOnSignOut` makes, including the three seconds it
 * already spends waiting for a registration that is still in flight. Cutting it shorter
 * would mean routinely leaving a live push token on a device somebody just left, and the
 * next account's follows and recommendations arriving on their lock screen.
 */
const DEVICE_RELEASE_GRACE_MS = 3500;
/** A Keychain delete of a parked Apple name. Cosmetic, so it gets the smallest budget. */
const PENDING_NAME_GRACE_MS = 800;
/** One round trip to end the session server-side, and no more than one. */
const REMOTE_SIGN_OUT_GRACE_MS = 2000;
/** Two Keychain operations that do not go anywhere near the network. */
const LOCAL_EXIT_GRACE_MS = 600;

/**
 * Runs one step of the teardown, bounded, and reports rather than throwing.
 *
 * Returns whether it actually finished, because for one of the four steps the answer
 * changes what happens next — see `signOut`.
 */
async function bounded(
  scope: string,
  work: Promise<unknown>,
  graceMs: number,
): Promise<boolean> {
  const settled = Symbol('settled');
  const failed = Symbol('failed');
  /**
   * Every stage, timed and named.
   *
   * The founder watches twenty seconds of "Signing out…" and the only question worth
   * answering is which of these five steps is the one still outstanding when it happens.
   * A `start` with no matching outcome in the report *is* the answer.
   */
  const began = Date.now();
  note('signout', scope, 'start');

  const outcome = await withGrace(
    work.then(
      () => settled,
      (error: unknown) => {
        reportHandled(error, { scope });
        return failed;
      },
    ),
    graceMs,
    // Distinct from `failed`: a step that has not answered yet is still running, and
    // the difference matters to whoever reads the report.
    'timeout' as const,
  );

  note(
    'signout',
    scope,
    outcome === 'timeout' ? 'timeout' : outcome === settled ? 'ok' : 'failed',
    Date.now() - began,
  );

  if (outcome === 'timeout')
    reportHandled(new Error(`${scope} did not answer in ${graceMs}ms`), { scope });
  return outcome === settled;
}

/**
 * Ends the session on the server, for **this device only**.
 *
 * `scope: 'local'` is explicit and is a correction rather than a tidy-up. The default is
 * `'global'`, which revokes every refresh token the account holds — so "Use a different
 * account" on one phone signed the same person out of their iPad and of any other
 * install, silently. Nothing in this product asks for that, and the one surface that
 * legitimately might (a stolen-device control) does not exist.
 */
async function endRemoteSession(): Promise<boolean> {
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) {
    reportHandled(error, { scope: 'signOut.supabase' });
    return false;
  }
  return true;
}

/**
 * Makes the credential on this device unusable without asking the network for permission.
 *
 * The Supabase session lives in one Keychain entry and `@supabase/auth-js` re-reads it on
 * every call — it holds no copy in memory — so deleting that entry is what "signed out on
 * this device" actually means. Doing it directly is the difference between an exit that
 * depends on a reply and one that does not.
 *
 * The second call is the tidy version of the same thing: with storage empty it finds no
 * access token, skips the server entirely, and emits `SIGNED_OUT`, which is what
 * `AuthProvider` normally listens for.
 *
 * **But it is not allowed to be the only way the app finds out, and that was independent
 * review 49's first blocker.** `_removeSession` awaits three storage operations before it
 * notifies — one of them a read of a PKCE key the mirror has never seen — and on the device
 * this hotfix is about, storage calls that do not answer are the whole problem. So the
 * event that tells the app it is signed out sat behind the thing that was stuck, routing
 * went on seeing a `ready` session, and the escaping user was sent back to the screen they
 * were leaving. `announceLocalSignOut` is the app saying it itself, unconditionally, once
 * the credential is gone from this device.
 *
 * **What this does not do, stated plainly: it does not revoke the refresh token
 * server-side.** That is `endRemoteSession`'s job and it is tried first. Where it could
 * not be reached, the token remains valid until it expires on its own — the same
 * residual as any sign-out taken offline, and a much smaller problem than a person who
 * cannot leave an account.
 */
async function forgetLocalSession(): Promise<void> {
  await bounded(
    'signOut.forgetLocal',
    sessionStorage.removeItem(authStorageKey),
    LOCAL_EXIT_GRACE_MS,
  );
  await bounded(
    'signOut.localTeardown',
    supabase.auth.signOut({ scope: 'local' }),
    LOCAL_EXIT_GRACE_MS,
  );
  // Last, and whatever the two above managed. Neither is allowed to be the reason the
  // app still believes it has a session.
  announceLocalSignOut();
}

/**
 * auth.md §5 also requires the outbox and the SQLite cache to be cleared here.
 * Neither exists yet; when they do, this is where they get torn down, and leaving
 * a note is better than leaving a silent omission — another account's queued
 * writes on a shared device are both a privacy leak and a correctness bug.
 *
 * **The push token is one of those things, and it is the one with a name attached.**
 * A device registered to this account and left registered would deliver their follows,
 * comments and recommendations — with the sender's name and the film's title on the lock
 * screen — to whoever signs in next. So the release happens **first**, while the session
 * still exists, because revoking needs a JWT and there is none afterwards.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER IS THE CONTRACT, AND IT IS: REMOTE FIRST, BRIEFLY; LOCAL ALWAYS.
 *
 * Everything that needs the network is attempted, each on its own short budget, and
 * none of it may hold the person. Then the local session is ended whether or not any of
 * it worked. That inversion is the fix for what the founder observed: previously the
 * *only* thing that ended the session was a round trip, so an unanswered request was an
 * account nobody could leave.
 *
 * It cannot fail loudly. Every step reports and returns; a rejection here would leave
 * somebody signed in, which is worse than a stale token — and a stale token is not the
 * last line of defence anyway, since `register_device_token` moves a device to whoever
 * registers it next.
 */
export async function signOut() {
  await bounded('signOut.releaseDevice', releaseDeviceOnSignOut(), DEVICE_RELEASE_GRACE_MS);

  /**
   * A stale pending name is cosmetic — it pre-fills a signup form — so it is bounded
   * like the rest and never allowed to be the reason a session survives a tap. That was
   * review 45's defect in its first form: an unguarded Keychain delete here meant the
   * teardown below never ran at all.
   */
  await bounded(
    'signOut.clearPendingDisplayName',
    clearPendingDisplayName(),
    PENDING_NAME_GRACE_MS,
  );

  const teardown = endRemoteSession();
  const ended = await bounded('signOut.supabase', teardown, REMOTE_SIGN_OUT_GRACE_MS);

  // Only when the server did not already do it. A successful `signOut` has removed the
  // stored session itself, so repeating the work would be two more Keychain calls and a
  // second `SIGNED_OUT` for no benefit.
  if (ended) return;

  await forgetLocalSession();

  /**
   * **One sweep after the teardown we stopped waiting for finally settles.**
   *
   * Independent review 49's second blocker. The abandoned `signOut` is still out there,
   * and inside it may be a token refresh that was already in flight when the Keychain
   * entry was deleted. `@supabase/auth-js` guards against writing a rotated session over a
   * removal *it* performed, but the direct deletion above is not one of those — so a
   * refresh that lands in the window between its own storage check and its write can put
   * a working session back on the device somebody just left. On the next launch they are
   * signed in to the account they escaped.
   *
   * Not awaited: the person has already gone, and the request deadline is what guarantees
   * this ever runs at all. Failures are swallowed because there is nobody left to tell.
   */
  void teardown
    .catch(() => {})
    .then(() => sessionStorage.removeItem(authStorageKey))
    .catch(() => {});
}

function isCancellation(e: unknown) {
  const code = (e as { code?: string } | null)?.code;
  return code === 'ERR_REQUEST_CANCELED' || code === 'ERR_CANCELED';
}

function messageOf(e: unknown) {
  return e instanceof Error ? e.message : 'Something went wrong.';
}
