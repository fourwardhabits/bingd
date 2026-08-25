import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type TextInput } from 'react-native';

import {
  isAppleSignInAvailable,
  signInWithApple,
  signInWithGoogle,
  signUpWithEmailPassword,
} from '@/features/auth';
import { BrandLockup, Button, Divider, Field, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * Creating an account with an email and a password.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE SCREEN
 *
 * Sign-in and sign-up were one screen for as long as the door was a one-time code,
 * because with `shouldCreateUser: true` they were genuinely the same act: type an
 * address, get a code, and whether an account was created was an implementation detail
 * nobody had to know.
 *
 * A password ends that. "Sign in" and "create an account" now do different things with
 * the same two fields, and a single form that guessed which one you meant would be
 * guessing about the one thing it must not get wrong — and would have to tell you
 * whether the address was taken in order to guess, which is the enumeration §13 rules
 * out. Two screens, one link each way.
 *
 * ---------------------------------------------------------------------------
 * IT DOES NOT SAY WHETHER THE EMAIL IS TAKEN
 *
 * `signUpWithEmailPassword` returns the same answer either way and Supabase sends
 * nothing for an address that already has a confirmed account. Somebody in that
 * position reaches the code screen and finds "Already have an account? Sign in" waiting
 * for them there — a way out that costs them one tap and tells them nothing the app
 * would not have told a stranger.
 *
 * ---------------------------------------------------------------------------
 * VERIFICATION HAPPENS IN BINGD
 *
 * "Confirm email" stays on — the founder's §3 is explicit that this must not be solved
 * by turning it off — and the confirmation carries a numeric code rather than a link.
 * So the next screen is `verify` in `signup` mode and the browser is never involved.
 */
export default function CreateAccountScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'create' | 'apple' | 'google' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const passwordField = useRef<TextInput>(null);

  useEffect(() => {
    isAppleSignInAvailable().then(setAppleAvailable).catch(() => setAppleAvailable(false));
  }, []);

  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  /**
   * Six, which is GoTrue's own default minimum and nothing beyond it.
   *
   * The founder's §2: *do not add unnecessary password complexity.* No character-class
   * rules, no maximum, no strength meter — those push people towards a password they
   * cannot remember, on a product whose recovery path is a one-time code rather than a
   * reset. The check exists so the button can be disabled with a reason instead of
   * spending a round trip to be told `weak_password`, and the server remains the
   * authority either way.
   */
  const longEnough = password.length >= 6;

  const submit = async () => {
    setBusy('create');
    setError(null);
    const result = await signUpWithEmailPassword(email, password);
    setBusy(null);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    if (result.needsVerification) {
      router.push({
        pathname: '/(auth)/verify',
        params: { email: email.trim(), mode: 'signup' },
      });
      return;
    }
    // A session came back, which means the project is not requiring confirmation.
    // Nothing to do: `useAuthRouting` sends them on to create a profile.
  };

  const submitProvider = async (
    provider: 'apple' | 'google',
    run: () => Promise<{ ok: boolean; cancelled?: boolean; message?: string }>,
  ) => {
    setBusy(provider);
    setError(null);
    const result = await run();
    setBusy(null);
    if (!result.ok && !result.cancelled) {
      setError(result.message ?? 'That did not work. Try again.');
    }
  };

  return (
    <Screen airy includeBottomInset>
      <View style={styles.intro}>
        <BrandLockup size="lg" />
        <Text variant="display">Create your account</Text>
        <Text variant="body" tone="secondary">
          We will email you a code to confirm it is you.
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
        />
        <Field
          ref={passwordField}
          label="Password"
          value={password}
          onChangeText={setPassword}
          autoCapitalize="none"
          // `new-password`, which is what asks a password manager to *generate* one
          // rather than offer what it already holds. The sign-in screen says
          // `current-password` for the mirror-image reason.
          autoComplete="new-password"
          autoCorrect={false}
          secureTextEntry
          textContentType="newPassword"
          returnKeyType="go"
          editable={busy === null}
          onSubmitEditing={looksLikeEmail && longEnough ? submit : undefined}
          hint="At least 6 characters."
          error={error ?? undefined}
        />

        <Button
          label={busy === 'create' ? 'Creating…' : 'Create account'}
          onPress={submit}
          disabled={!looksLikeEmail || !longEnough || busy !== null}
          disabledReason={
            busy !== null
              ? 'One moment.'
              : !looksLikeEmail
                ? 'Enter your email address first.'
                : 'Your password needs at least 6 characters.'
          }
        />
      </View>

      <View style={styles.providers}>
        <Divider label="or" />
        {appleAvailable ? (
          <Button
            label={busy === 'apple' ? 'One moment…' : 'Continue with Apple'}
            kind="secondary"
            onPress={() => submitProvider('apple', signInWithApple)}
            disabled={busy !== null}
            disabledReason="One moment."
          />
        ) : null}
        <Button
          label={busy === 'google' ? 'One moment…' : 'Continue with Google'}
          kind="secondary"
          onPress={() => submitProvider('google', signInWithGoogle)}
          disabled={busy !== null}
          disabledReason="One moment."
        />
      </View>

      <View style={styles.footer}>
        <Text variant="footnote" tone="secondary">
          Already have an account?
        </Text>
        {/* `back` where there is history, so returning to sign-in does not stack a
            second copy of it behind this screen. `replace` covers the cold entry. */}
        <Button
          label="Sign in"
          kind="tertiary"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(auth)/sign-in'))}
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
