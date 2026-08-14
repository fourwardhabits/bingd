import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { isAppleSignInAvailable, sendEmailCode, signInWithApple, signInWithGoogle } from '@/features/auth';
import { BrandLockup, Button, Field, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/** Email one-time code, plus Apple and Google sign-in (PRD §8). Every method
 *  resolves to one stable internal user UUID, so a user who signs in a
 *  different way next time is the same account. */
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
          hint="We will send a six-digit code. No password to remember."
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
