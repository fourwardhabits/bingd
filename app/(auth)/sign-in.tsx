import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  isAppleSignInAvailable,
  sendEmailCode,
  signInWithApple,
  signInWithGoogle,
} from '@/features/auth';
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
 */
export default function SignInScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<'email' | 'apple' | 'google' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);

  // Asked rather than assumed from the platform: the entitlement can be missing
  // from a build, and a button that always fails is worse than no button.
  useEffect(() => {
    isAppleSignInAvailable().then(setAppleAvailable).catch(() => setAppleAvailable(false));
  }, []);

  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  /**
   * Sends before navigating, so a refusal — a rate limit, signups closed — is shown
   * beside the field somebody would fix, rather than on a code screen for a code that was
   * never sent. It is not a disclosure: neither of those answers depends on whether the
   * address has an account.
   */
  const submitEmail = async () => {
    setBusy('email');
    setError(null);
    const result = await sendEmailCode(email);
    setBusy(null);
    if (result.ok) {
      router.push({ pathname: '/(auth)/verify', params: { email: email.trim() } });
    } else {
      setError(result.message ?? 'That did not work. Try again.');
    }
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
      <View style={styles.intro}>
        <BrandLockup size="lg" />
        <Text variant="display">Keep what you watch.</Text>
        <Text variant="body" tone="secondary">
          Rank films and seasons against each other, and find out whose taste actually
          matches yours.
        </Text>
      </View>

      <View style={styles.form}>
        <Field
          label="Email"
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
          onSubmitEditing={looksLikeEmail ? submitEmail : undefined}
          error={error ?? undefined}
          // Says what happens next, and says it before the tap rather than after: no
          // password is the reassurance, and "code" is the word the next screen uses.
          hint={error ? undefined : 'We will send a six-digit code. No password to remember.'}
        />
        <Button
          label={busy === 'email' ? 'Sending…' : 'Continue with email'}
          onPress={submitEmail}
          disabled={!looksLikeEmail || busy !== null}
          disabledReason={
            looksLikeEmail ? 'Signing in, one moment.' : 'Enter your email address first.'
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
