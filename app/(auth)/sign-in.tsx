import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  classifyIdentifier,
  isAppleSignInAvailable,
  sendEmailCode,
  sendUsernameCode,
  signInWithApple,
  signInWithGoogle,
} from '@/features/auth';
import { USERNAME_SIGN_IN_ENABLED } from '@/features/auth/username-sign-in-flag';
import { BrandLockup, Button, Divider, Field, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * Sign in (PRD §23). Every method resolves to one stable internal user UUID, so a
 * person who signs in a different way next time is the same account.
 *
 * ---------------------------------------------------------------------------
 * THREE WAYS IN, AND A PASSWORD IS NOT ONE OF THEM
 *
 * The founder's final decision of 2026-08-26. Email, Apple, Google — and email means a
 * six-digit code, which is the only credential Bingd owns rather than borrows. Ordinary
 * users neither create nor manage a password in v1, so there is nothing here to forget,
 * reset, reuse, or leak.
 *
 * A brief amendment made email-and-password the default and gave this screen two fields
 * and two submits. It is reverted. What it left behind, deliberately, is
 * `password-sign-in` — one quiet line at the bottom of this screen, for the account a
 * store reviewer is handed. See `docs/release/store-review-access.md`.
 *
 * ---------------------------------------------------------------------------
 * ONE FIELD, AND NO "ARE YOU NEW?"
 *
 * There is no sign-up screen and no sign-up/sign-in choice, because `sendEmailCode`
 * passes `shouldCreateUser: true` and GoTrue decides: an address with an account is sent
 * a sign-in code, an address without one is created and sent a confirmation code, and
 * both are six digits typed into the same next screen. Somebody who cannot remember
 * whether they ever signed up does not have to.
 *
 * That is also what keeps the screen from answering the question. Both cases return the
 * same success, so nothing here can be used to find out whether an address has a Bingd
 * account.
 *
 * ---------------------------------------------------------------------------
 * EMAIL OR USERNAME — BEHIND `USERNAME_SIGN_IN_ENABLED`, WHICH IS FALSE
 *
 * Founder decision 2026-11-12: an existing account may type its username instead of its
 * email. With the constant off this screen is exactly the one above, and every branch
 * below reads the constant before it reads anything else. With it on, the one field takes
 * either: a value containing `@` goes down the email path **unchanged** (same call, same
 * `shouldCreateUser: true`, same next screen), and a username goes to the
 * `username-sign-in` Edge Function, which never tells this device the email or whether
 * the name exists. Sign-up stays email-only by construction: the username path cannot
 * create an account. docs/architecture/username-sign-in.md.
 */
export default function SignInScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<'email' | 'apple' | 'google' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);

  /**
   * The concurrency guard, and a ref rather than state for the reason `verify.tsx`
   * already records on its Resend control: two activations in one frame both read the
   * same render's `busy`, so `disabled` cannot refuse the second. Only a value that
   * changes synchronously can.
   *
   * It was missing here, and this screen has **two** ways to fire the same send — the
   * button and the keyboard's Go key — so the second one costs a real email at GoTrue.
   * The first send succeeds, the second lands inside the 60-second per-address cooldown
   * and comes back `over_email_send_rate_limit`, and what the person sees is a rate
   * limit on what was, to them, one attempt. The code they were told did not send is
   * already in their inbox.
   */
  const sending = useRef(false);

  // Asked rather than assumed from the platform: the entitlement can be missing
  // from a build, and a button that always fails is worse than no button.
  useEffect(() => {
    isAppleSignInAvailable().then(setAppleAvailable).catch(() => setAppleAvailable(false));
  }, []);

  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  // Read only when the constant is on, so that with it off nothing new is even evaluated.
  const identifier = USERNAME_SIGN_IN_ENABLED ? classifyIdentifier(email) : null;
  const canSubmit = identifier ? identifier.kind !== 'incomplete' : looksLikeEmail;

  /**
   * Sends before navigating, so a refusal — a rate limit, signups closed — is shown
   * beside the field somebody would fix, rather than on a code screen for a code that was
   * never sent. It is not a disclosure: neither of those answers depends on whether the
   * address has an account.
   */
  const submitEmail = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy('email');
    setError(null);
    const result = await sendEmailCode(email);
    sending.current = false;
    setBusy(null);
    /**
     * A cooldown refusal is a code that already went out, so it moves forward.
     *
     * `retryAfterSeconds` is only set when GoTrue refused because this address was sent
     * a working code less than a minute ago. Stopping here would leave somebody on the
     * email form being told their signup failed while the code sits in their inbox,
     * which is the failure mode the 2026-09-21 incident ended in. The remaining seconds
     * ride along so the next screen's countdown is the server's, not a guess.
     */
    if (result.ok || result.retryAfterSeconds !== undefined) {
      router.push({
        pathname: '/(auth)/verify',
        params: {
          email: email.trim(),
          ...(result.ok ? {} : { cooldown: String(result.retryAfterSeconds) }),
        },
      });
    } else {
      setError(result.message ?? 'That did not work. Try again.');
    }
  };

  /**
   * The username path. It always moves on to the code screen when the request was
   * understood, because the server's answer is the same for a name that exists and one
   * that does not — stopping here for either would be the disclosure the server avoids.
   */
  const submitUsername = async (username: string) => {
    if (sending.current) return;
    sending.current = true;
    setBusy('email');
    setError(null);
    const result = await sendUsernameCode(username);
    sending.current = false;
    setBusy(null);
    if (result.ok) router.push('/(auth)/verify-username');
    else setError(result.message);
  };

  const submitIdentifier = () => {
    if (identifier?.kind === 'username') return submitUsername(identifier.username);
    return submitEmail();
  };

  const submitProvider = async (
    provider: 'apple' | 'google',
    run: () => Promise<{ ok: boolean; cancelled?: boolean; message?: string }>,
  ) => {
    setBusy(provider);
    setError(null);
    const result = await run();
    setBusy(null);
    // A dismissed sheet is not a failure and must not leave a message on screen.
    if (!result.ok && !result.cancelled) {
      setError(result.message ?? 'That did not work. Try again.');
    }
    // No navigation on success: the router moves the user once the session and the
    // profile check agree on where they belong (useAuthRouting).
  };

  return (
    <Screen airy includeBottomInset>
      {/**
       * **This screen is the product introduction now** (founder, physical iOS 1.0.1
       * build 8).
       *
       * There was a screen in front of it — an opening with a headline, a drawn
       * comparison and two buttons that both led here. The founder's verdict after
       * carrying it around was that it was weaker than the form it introduced: the
       * poster frames were empty by construction (the catalogue is a cache and this
       * screen has no session to read it with), the copy explained a mechanism, and this
       * page already looked and sounded better. So there is one screen before the
       * account again, and it is this one.
       *
       * The copy says what the app is for rather than how it works. Movies **and TV
       * shows**, because half the product is television and the old line said "films and
       * seasons", which names a data model. No comparison, no ranking mechanic, no
       * "matches yours": those are step 4's to explain, to somebody who has said yes.
       */}
      <View style={styles.intro}>
        <BrandLockup size="lg" />
        <Text variant="display">Rank and share what you watch.</Text>
        <Text variant="body" tone="secondary">
          Rank movies and TV shows, see what your friends are watching, and find your next
          binge.
        </Text>
      </View>

      <View style={styles.form}>
        <Field
          label={USERNAME_SIGN_IN_ENABLED ? 'Email or username' : 'Email'}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect={false}
          keyboardType="email-address"
          inputMode="email"
          textContentType="emailAddress"
          returnKeyType="go"
          editable={busy === null}
          onSubmitEditing={
            USERNAME_SIGN_IN_ENABLED
              ? canSubmit
                ? submitIdentifier
                : undefined
              : looksLikeEmail
                ? submitEmail
                : undefined
          }
          error={error ?? undefined}
          // Says what happens next, and says it before the tap rather than after: no
          // password is the reassurance, and "code" is the word the next screen uses.
          hint={
            error
              ? undefined
              : USERNAME_SIGN_IN_ENABLED
                ? 'We will send a six-digit code to your email. No password to remember.'
                : 'We will send a six-digit code. No password to remember.'
          }
        />
        <Button
          label={
            busy === 'email'
              ? 'Sending…'
              : USERNAME_SIGN_IN_ENABLED
                ? 'Continue'
                : 'Continue with email'
          }
          onPress={USERNAME_SIGN_IN_ENABLED ? submitIdentifier : submitEmail}
          disabled={!canSubmit || busy !== null}
          disabledReason={
            canSubmit
              ? 'Signing in, one moment.'
              : USERNAME_SIGN_IN_ENABLED
                ? 'Enter your email or username first.'
                : 'Enter your email address first.'
          }
        />
      </View>

      <View style={styles.providers}>
        <Divider label="or" />
        {appleAvailable ? (
          <Button
            label={busy === 'apple' ? 'Signing in…' : 'Continue with Apple'}
            kind="secondary"
            onPress={() => submitProvider('apple', signInWithApple)}
            disabled={busy !== null}
            disabledReason="Signing in, one moment."
          />
        ) : null}
        <Button
          label={busy === 'google' ? 'Signing in…' : 'Continue with Google'}
          kind="secondary"
          onPress={() => submitProvider('google', signInWithGoogle)}
          disabled={busy !== null}
          disabledReason="Signing in, one moment."
        />
      </View>

      {/**
       * More sign-in options, which is one option, and it is not for you.
       *
       * A password signs in exactly one kind of account: one somebody deliberately gave a
       * password to, in the Supabase dashboard, so that App Review and Play review can
       * get past this screen without a mailbox. No ordinary Bingd account has one and
       * nothing in the app will ever offer to set one, so this is deliberately quiet —
       * `tertiary`, `sm`, and the secondary tone — rather than a fourth peer of the three
       * above. Making it look equivalent would invite people to hunt for a password they
       * do not have, and the failure would be silent and total.
       */}
      <View style={styles.more}>
        <Text variant="footnote" tone="tertiary">
          More sign-in options
        </Text>
        <Button
          label="Sign in with password"
          kind="tertiary"
          size="sm"
          tone="secondary"
          onPress={() => router.push('/(auth)/password-sign-in')}
          disabled={busy !== null}
          disabledReason="One moment."
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { gap: theme.space[3], alignItems: 'flex-start' },
  form: { gap: theme.space[4] },
  providers: { gap: theme.space[3] },
  more: { alignItems: 'center', gap: theme.space[1] },
});
