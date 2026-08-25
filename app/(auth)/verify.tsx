import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { sendEmailCode, verifyEmailCode } from '@/features/auth';
import { Button, Field, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * The code screen, and the only one. Six digits, typed into Bingd, never a browser.
 *
 * ---------------------------------------------------------------------------
 * ONE MODE, WHICH IS THE POINT
 *
 * This screen briefly carried a `mode` parameter — `signup` or `passwordless` — because
 * the password-first amendment had two email flows verified with two different
 * `EmailOtpType`s. Both are gone. `verifyOtp({ type: 'email' })` is documented by
 * `@supabase/auth-js` as the type for a code "sent to the user's email during sign-up or
 * sign-in", and GoTrue resolves it against whichever column holds the token. `signup` and
 * `magiclink` are deprecated types and this app sends neither.
 *
 * So this screen does not know, and does not need to know, whether the person in front of
 * it just created an account or is coming back to one. Neither does the copy — which is
 * also what stops the screen from disclosing it. What happens after a successful verify is
 * the router's job either way: a session with no profile goes to `create-profile`, a
 * session with one goes to the feed, and that is the same rule Apple and Google land on.
 */
export default function VerifyScreen() {
  const router = useRouter();
  const { email } = useLocalSearchParams<{ email?: string }>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const address = typeof email === 'string' ? email : '';
  const complete = /^\d{6}$/.test(code.trim());

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await verifyEmailCode(address, code);
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
    // profile check knows that. A newly verified address lands on `create-profile`
    // because `nextRoute` sees a session with no profile, which is the same path every
    // other new account takes.
  };

  const resend = async () => {
    setBusy(true);
    setError(null);
    const result = await sendEmailCode(address);
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
        <Text variant="title1">Check your email</Text>
        {/* The address is named, because the commonest reason a code never arrives is
            that it went somewhere else — and somebody who can see the typo can fix it
            with the control at the bottom of this screen rather than by force-quitting.

            "code" and never "link". Bingd's email method is `verifyOtp` from end to end:
            nothing in this product completes a sign-in in a browser, and copy that
            hedged towards one would be teaching people to go looking for it.

            One sentence for a new account and a returning one alike. Saying "finish
            creating your account" to one and "sign in" to the other would tell whoever
            typed the address which of the two they were — from a flow whose whole
            anti-enumeration property is that it does not. */}
        <Text variant="body" tone="secondary">
          We sent a six-digit code to {address}. Enter it to continue. It expires in 10
          minutes.
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
          label={busy ? 'Checking…' : 'Continue'}
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
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { gap: theme.space[3] },
  form: { gap: theme.space[4] },
});
