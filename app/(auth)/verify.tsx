import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  resendSignUpCode,
  sendEmailCode,
  verifyEmailCode,
  verifySignUpCode,
  type VerifyMode,
} from '@/features/auth';
import { Button, Field, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * The code screen, which both email flows end at.
 *
 * ---------------------------------------------------------------------------
 * ONE SCREEN, TWO MODES, AND THE MODE IS LOAD-BEARING
 *
 * A code from **Confirm signup** and a code from **Magic Link** look identical — six
 * digits in an email — and are verified against different columns. `verifyOtp` takes a
 * `type` for exactly that reason, and getting it wrong does not produce an error that
 * says so: GoTrue answers `otp_expired`, which this screen would report as "that code did
 * not work". The person would be looking at a correct code being told it is wrong.
 *
 * So the mode travels in the route rather than being inferred. It also decides what
 * *resend* means — `resend({ type: 'signup' })` for a new account, another
 * `signInWithOtp` for a returning one — which are different endpoints with different
 * rate limits, and neither works for the other flow.
 *
 * Defaulting to `passwordless` is deliberate: it is the mode reachable without a
 * password, so a link or a restored route that has lost its parameter degrades to the
 * flow that cannot leave somebody holding an unusable account.
 */
export default function VerifyScreen() {
  const router = useRouter();
  const { email, mode } = useLocalSearchParams<{ email?: string; mode?: string }>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const address = typeof email === 'string' ? email : '';
  const flow: VerifyMode = mode === 'signup' ? 'signup' : 'passwordless';
  const complete = /^\d{6}$/.test(code.trim());

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result =
      flow === 'signup'
        ? await verifySignUpCode(address, code)
        : await verifyEmailCode(address, code);
    setBusy(false);
    if (!result.ok) {
      setError(
        // Deliberately vague about which it was: an expired code and a wrong code
        // are the same next action, and distinguishing them tells an attacker
        // whether a guess was close.
        'That code did not work. Check it, or send a new one.',
      );
      return;
    }
    // Routing is the gate's job — this session may need onboarding, and only the
    // profile check knows that. A verified sign-up lands on `create-profile` because
    // `nextRoute` sees a session with no profile, which is the same path every other
    // new account takes.
  };

  const resend = async () => {
    setBusy(true);
    setError(null);
    const result =
      flow === 'signup' ? await resendSignUpCode(address) : await sendEmailCode(address);
    setBusy(false);
    setResent(result.ok);
    if (!result.ok) setError(result.message ?? 'Could not send another code.');
  };

  if (!address) {
    return (
      <Screen airy includeBottomInset>
        <Text variant="title1">Start again</Text>
        <Text variant="body" tone="secondary">
          We lost track of which address to check. Enter it once more.
        </Text>
        <Button label="Back to sign in" onPress={() => router.replace('/(auth)/sign-in')} />
      </Screen>
    );
  }

  return (
    <Screen airy includeBottomInset>
      <View style={styles.intro}>
        <Text variant="title1">
          {flow === 'signup' ? 'Verify your email' : 'Check your email'}
        </Text>
        {/* The address is named, because the commonest reason a code never arrives is
            that it went somewhere else — and somebody who can see the typo can fix it
            with the control at the bottom of this screen rather than by force-quitting.

            "code" and never "link". Bingd's email methods are `verifyOtp` from end to
            end: nothing in this product completes a sign-in in a browser, and copy that
            hedged towards one would be teaching people to go looking for it. */}
        <Text variant="body" tone="secondary">
          {flow === 'signup'
            ? `We sent a six-digit code to ${address}. Enter it to finish creating your account.`
            : `We sent a six-digit code to ${address}.`}{' '}
          It expires in 10 minutes.
        </Text>
      </View>

      <View style={styles.form}>
        <Field
          label="Six-digit code"
          value={code}
          onChangeText={(next) => setCode(next.replace(/\D/g, '').slice(0, 6))}
          keyboardType="number-pad"
          inputMode="numeric"
          // Lets iOS and Android offer the code straight from the notification,
          // which removes the app-switch that loses half of the people here.
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          autoFocus
          maxLength={6}
          editable={!busy}
          onSubmitEditing={complete ? submit : undefined}
          error={error ?? undefined}
          hint={resent ? 'Sent again. It can take a moment to arrive.' : undefined}
        />
        <Button
          label={busy ? 'Checking…' : flow === 'signup' ? 'Verify email' : 'Sign in'}
          onPress={submit}
          disabled={!complete || busy}
          disabledReason={complete ? 'Checking your code.' : 'Enter all six digits.'}
        />
        <Button
          label="Send a new code"
          kind="tertiary"
          onPress={resend}
          disabled={busy}
          disabledReason="One moment."
        />
        {/* The way out of a typo, which this screen did not have.
            Without it, somebody who typed their address wrong is on a screen waiting
            for an email that is never coming, with a Resend button that will keep
            sending it to the same wrong place. `back` rather than `replace`, so the
            screen they came from is the one with the address still in it. */}
        <Button
          label="Use a different email"
          kind="tertiary"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(auth)/sign-in'))}
          disabled={busy}
          disabledReason="One moment."
        />
        {/**
         * The escape hatch that keeps sign-up from having to say whether an address is
         * taken.
         *
         * Supabase obfuscates that deliberately, so `signUpWithEmailPassword` reports
         * "we sent a code" for an address that already has a confirmed account and sends
         * nothing. Without a visible way to the sign-in screen that person waits for a
         * code that is not coming; with one they leave under their own steam and the app
         * has still confirmed nothing about the address. Only on the sign-up flow — on
         * the passwordless one they are already signing in.
         */}
        {flow === 'signup' ? (
          <Button
            label="Already have an account? Sign in"
            kind="tertiary"
            onPress={() => router.replace('/(auth)/sign-in')}
            disabled={busy}
            disabledReason="One moment."
          />
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { gap: theme.space[3] },
  form: { gap: theme.space[4] },
});
