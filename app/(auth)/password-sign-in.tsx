import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View, type TextInput } from 'react-native';

import { signInWithEmailPassword } from '@/features/auth';
import { Button, Field, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * Sign in with a password. A back door, and it is meant to read as one.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS AT ALL, IN AN APP WITH NO PASSWORDS
 *
 * Apple's App Review and Google Play review need to get past the sign-in screen, and a
 * reviewer has no access to any mailbox this app can send a code to. An OTP-only product
 * is therefore an unreviewable product — the rejection is "we could not sign in", and it
 * costs a submission round every time.
 *
 * So Supabase's password capability is kept and given exactly one visible use: an account
 * the founder provisions in the dashboard with a fixed password, handed to the stores in
 * their review-notes field. `docs/release/store-review-access.md` is the runbook, and no
 * credential for it is in this repository.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN DELIBERATELY DOES NOT HAVE
 *
 * **No way to create an account.** Account creation has exactly one door and it is the
 * code on the previous screen. A "create account" here would hand ordinary users a
 * password to invent, remember, and eventually lose — on a product with no reset flow,
 * because it has no passwords to reset.
 *
 * **No "forgot password".** An ordinary account has no password, so forgetting one is not
 * a state anybody can be in. Whoever is meant to be here was given the password with the
 * account.
 *
 * **No hint about whether an address exists or has a password.** Every failure says the
 * same sentence — see `signInWithEmailPassword`. An ordinary passwordless account simply
 * does not sign in here, and this screen does not announce that as a different fact from
 * a wrong password.
 */
export default function PasswordSignInScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordField = useRef<TextInput>(null);

  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const ready = looksLikeEmail && password.length > 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await signInWithEmailPassword(email, password);
    setBusy(false);
    // No navigation on success: `useAuthRouting` owns where a session belongs, exactly as
    // it does for the code flow and for OAuth. A push from here would race it.
    if (!result.ok) setError(result.message ?? 'That did not work. Try again.');
  };

  return (
    <Screen airy includeBottomInset>
      <View style={styles.intro}>
        <Text variant="title1">Sign in with password</Text>
        {/* Says who this is for, so somebody who arrived by curiosity leaves again
            instead of trying to guess a password they were never given. */}
        <Text variant="body" tone="secondary">
          For accounts that were set up with one. Everybody else signs in with a code,
          Apple, or Google.
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
          editable={!busy}
          onSubmitEditing={() => passwordField.current?.focus()}
        />
        <Field
          ref={passwordField}
          label="Password"
          value={password}
          onChangeText={setPassword}
          autoCapitalize="none"
          // `current-password`, never `new-password`: nothing in this app generates a
          // password, so a manager should only ever offer what it already holds.
          autoComplete="current-password"
          autoCorrect={false}
          secureTextEntry
          textContentType="password"
          returnKeyType="go"
          editable={!busy}
          onSubmitEditing={ready ? submit : undefined}
          // One message, under the password field, whatever the refusal was. Which field
          // was wrong is exactly the thing this screen must not say.
          error={error ?? undefined}
        />
        <Button
          label={busy ? 'Signing in…' : 'Sign in'}
          onPress={submit}
          disabled={!ready || busy}
          disabledReason={busy ? 'Signing in, one moment.' : 'Enter your email and password.'}
        />
        {/* `back` where there is history, so returning does not stack a second copy of
            the sign-in screen behind this one. `replace` covers a cold entry. */}
        <Button
          label="Back to sign in"
          kind="tertiary"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(auth)/sign-in'))}
          disabled={busy}
          disabledReason="One moment."
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { gap: theme.space[3] },
  form: { gap: theme.space[4] },
});
