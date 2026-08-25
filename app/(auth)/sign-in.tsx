import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type TextInput } from 'react-native';

import {
  isAppleSignInAvailable,
  sendEmailCode,
  signInWithApple,
  signInWithEmailPassword,
  signInWithGoogle,
} from '@/features/auth';
import { BrandLockup, Button, Divider, Field, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * Sign in (PRD §23). Every method resolves to one stable internal user UUID, so a
 * person who signs in a different way next time is the same account.
 *
 * ---------------------------------------------------------------------------
 * PASSWORD IS THE DEFAULT, SINCE THE FOUNDER'S 2026-08-26 DECISION
 *
 * This screen used to lead with an email field that sent a one-time code, and password
 * was a mode you had to find. The order is now reversed, and the reason is not taste:
 * **a password is the only email method that sends no mail.** Every returning sign-in
 * through it costs zero transactional email, which is what makes the product usable
 * while the project is still on Supabase's built-in sender and its rate limit.
 *
 * Passwordless survives as one clearly secondary action, because two populations still
 * need it: everybody who created an account before this change and has no password, and
 * anybody who has forgotten theirs. It is the same screen and the same code flow it
 * always was — see `verify.tsx` — with `shouldCreateUser: false`, so it can no longer
 * quietly become a second registration route.
 *
 * ---------------------------------------------------------------------------
 * NO MODE SWITCH
 *
 * The old screen toggled one form between "code" and "password" with a tertiary button,
 * which meant the fields on screen depended on a state nothing on screen named. Both
 * fields are simply present now: the form is what it looks like, autofill can see a
 * complete credential pair, and "Sign in without a password" navigates rather than
 * mutating what is in front of you.
 */
export default function SignInScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'password' | 'code' | 'apple' | 'google' | null>(null);
  /**
   * The message, and **which field it belongs under**.
   *
   * One string bound to the password field was wrong the moment this screen gained a
   * second submit: 'we could not send a code to that address' is about the email, and
   * printing it under Password sends somebody to correct the one thing that was not the
   * problem. The field is part of the error because the error is only useful next to
   * what it is about.
   */
  const [error, setError] = useState<{ field: 'email' | 'password'; message: string } | null>(
    null,
  );
  const [appleAvailable, setAppleAvailable] = useState(false);
  const passwordField = useRef<TextInput>(null);

  // Asked rather than assumed from the platform: the entitlement can be missing
  // from a build, and a button that always fails is worse than no button.
  useEffect(() => {
    isAppleSignInAvailable().then(setAppleAvailable).catch(() => setAppleAvailable(false));
  }, []);

  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const submitPassword = async () => {
    setBusy('password');
    setError(null);
    const result = await signInWithEmailPassword(email, password);
    setBusy(null);

    if (result.ok) return; // useAuthRouting moves them, same as OAuth.

    /**
     * The account exists, the password was right, and the email was never verified.
     *
     * Somebody who created an account and closed Bingd before typing the code. Reporting
     * this as "that email and password do not match" would tell them something false
     * about a password they just typed correctly, and would keep telling them for ever —
     * the founder's §7. They go back to the code screen instead, which can resend.
     */
    if (result.unverified) {
      router.push({
        pathname: '/(auth)/verify',
        params: { email: email.trim(), mode: 'signup' },
      });
      return;
    }

    setError({ field: 'password', message: result.message ?? 'That did not work. Try again.' });
  };

  /**
   * The secondary method, and the one an account with no password needs.
   *
   * It sends before navigating, so a refusal — an unknown address, a rate limit — is
   * shown here beside the field somebody would fix, rather than on a code screen for a
   * code that was never sent.
   */
  const submitCode = async () => {
    setBusy('code');
    setError(null);
    const result = await sendEmailCode(email);
    setBusy(null);
    if (result.ok) {
      router.push({
        pathname: '/(auth)/verify',
        params: { email: email.trim(), mode: 'passwordless' },
      });
    } else {
      setError({ field: 'email', message: result.message ?? 'That did not work. Try again.' });
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
      // A provider failure belongs to neither field; the password field is where this
      // screen's messages live and is directly above the provider buttons.
      setError({ field: 'password', message: result.message ?? 'That did not work. Try again.' });
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
          returnKeyType="next"
          editable={busy === null}
          onSubmitEditing={() => passwordField.current?.focus()}
          error={error?.field === 'email' ? error.message : undefined}
        />
        <Field
          ref={passwordField}
          label="Password"
          value={password}
          onChangeText={setPassword}
          autoCapitalize="none"
          // `current-password`, not `new-password`: this is the field a manager should
          // fill from what it already holds, and the create-account screen is the one
          // that should be offered a generated one.
          autoComplete="current-password"
          autoCorrect={false}
          secureTextEntry
          textContentType="password"
          returnKeyType="go"
          editable={busy === null}
          onSubmitEditing={looksLikeEmail && password ? submitPassword : undefined}
          error={error?.field === 'password' ? error.message : undefined}
        />

        <Button
          label={busy === 'password' ? 'Signing in…' : 'Sign in'}
          onPress={submitPassword}
          disabled={!looksLikeEmail || !password || busy !== null}
          disabledReason={
            busy !== null ? 'Signing in, one moment.' : 'Enter your email and password first.'
          }
        />

        {/* Secondary, and it is also the answer to "forgot password": it signs somebody
            in without one. A reset that mailed a link would put the browser back in a
            flow this whole amendment exists to take it out of, and this needs no third
            email template to configure. Setting a *new* password afterwards is not built
            — recorded in the PRD rather than half-done here. */}
        <Button
          label={busy === 'code' ? 'Sending…' : 'Sign in without a password'}
          kind="tertiary"
          onPress={submitCode}
          disabled={!looksLikeEmail || busy !== null}
          disabledReason={
            busy !== null ? 'One moment.' : 'Enter your email address first.'
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

      <View style={styles.footer}>
        <Text variant="footnote" tone="secondary">
          New to bingd.?
        </Text>
        <Button
          label="Create account"
          kind="tertiary"
          onPress={() => router.push('/(auth)/create-account')}
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
  footer: { alignItems: 'center', gap: theme.space[1] },
});
