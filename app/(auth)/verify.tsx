import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { sendEmailCode, verifyEmailCode } from '@/features/auth';
import { Button, Field, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * The second half of the email method. Possession of the code is the verification,
 * which is what makes email the one method that cannot present the unverified
 * address problem in auth.md §2.
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
    // profile check knows that.
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
      <Screen airy>
        <Text variant="title1">Start again</Text>
        <Text variant="body" tone="secondary">
          We lost track of which address to check. Enter it once more.
        </Text>
        <Button label="Back to sign in" onPress={() => router.replace('/(auth)/sign-in')} />
      </Screen>
    );
  }

  return (
    <Screen airy>
      <View style={styles.intro}>
        <Text variant="title1">Check your email</Text>
        <Text variant="body" tone="secondary">
          We sent a six-digit code to {address}.
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
          label={busy ? 'Checking…' : 'Sign in'}
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
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { gap: theme.space[3] },
  form: { gap: theme.space[4] },
});
