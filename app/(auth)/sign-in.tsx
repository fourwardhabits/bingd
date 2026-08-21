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
import { BrandLockup, Button, Field, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/** Email one-time code, plus Apple and Google sign-in (PRD §8). Every method
 *  resolves to one stable internal user UUID, so a user who signs in a
 *  different way next time is the same account. */
export default function SignInScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // The code flow is the door for everyone; the password flow is sign-in only,
  // for accounts that already have one (store reviewers — see methods.ts). It is
  // a mode of the same form rather than a second screen, so nothing forks.
  const [withPassword, setWithPassword] = useState(false);
  const [busy, setBusy] = useState<'email' | 'password' | 'apple' | 'google' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const passwordField = useRef<TextInput>(null);

  // Asked rather than assumed from the platform: the entitlement can be missing
  // from a build, and a button that always fails is worse than no button.
  useEffect(() => {
    isAppleSignInAvailable().then(setAppleAvailable).catch(() => setAppleAvailable(false));
  }, []);

  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

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

  const submitPassword = async () => {
    setBusy('password');
    setError(null);
    const result = await signInWithEmailPassword(email, password);
    setBusy(null);
    if (!result.ok) setError(result.message ?? 'That did not work. Try again.');
    // No navigation on success: useAuthRouting moves the user, same as OAuth.
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
          returnKeyType={withPassword ? 'next' : 'go'}
          editable={busy === null}
          onSubmitEditing={
            withPassword
              ? () => passwordField.current?.focus()
              : looksLikeEmail
                ? submitEmail
                : undefined
          }
          error={!withPassword ? (error ?? undefined) : undefined}
          hint={
            withPassword ? undefined : 'We will send a six-digit code. No password to remember.'
          }
        />
        {withPassword ? (
          <Field
            ref={passwordField}
            label="Password"
            value={password}
            onChangeText={setPassword}
            autoCapitalize="none"
            autoComplete="current-password"
            autoCorrect={false}
            secureTextEntry
            textContentType="password"
            returnKeyType="go"
            editable={busy === null}
            onSubmitEditing={looksLikeEmail && password ? submitPassword : undefined}
            error={error ?? undefined}
          />
        ) : null}
        {withPassword ? (
          <Button
            label={busy === 'password' ? 'Signing in…' : 'Sign in'}
            onPress={submitPassword}
            disabled={!looksLikeEmail || !password || busy !== null}
            disabledReason={
              busy !== null ? 'Signing in, one moment.' : 'Enter your email and password first.'
            }
          />
        ) : (
          <Button
            label={busy === 'email' ? 'Sending…' : 'Continue with email'}
            onPress={submitEmail}
            disabled={!looksLikeEmail || busy !== null}
            disabledReason={
              looksLikeEmail ? 'Signing in, one moment.' : 'Enter your email address first.'
            }
          />
        )}
        <Button
          label={withPassword ? 'Email me a code instead' : 'Sign in with a password'}
          kind="tertiary"
          onPress={() => {
            setWithPassword(!withPassword);
            setError(null);
            setPassword('');
          }}
          disabled={busy !== null}
          disabledReason="Signing in, one moment."
        />
      </View>

      <View style={styles.providers}>
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { gap: theme.space[3], alignItems: 'flex-start' },
  form: { gap: theme.space[4] },
  providers: { gap: theme.space[3] },
});
