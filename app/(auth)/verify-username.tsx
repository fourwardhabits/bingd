import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  InputAccessoryView,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type TextInput,
} from 'react-native';

import {
  clearPendingUsernameChallenge,
  pendingUsernameChallenge,
  sendUsernameCode,
  verifyUsernameCode,
} from '@/features/auth';
import { USERNAME_SIGN_IN_ENABLED } from '@/features/auth/username-sign-in-flag';
import { Button, Field, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * The same as `verify.tsx`'s, for the same reason: the server's per-account cooldown is
 * sixty seconds, and a button that comes back sooner invites a refusal. The username path
 * cannot even *see* that refusal (every send answers the same), so here it would be a
 * silent no-op rather than an error — which is worse.
 */
const RESEND_COOLDOWN_MS = 60_000;

/**
 * Two resends on top of the first send is three, which is the server's per-name hourly
 * limit. A fourth would be refused silently — same answer as a send, no new code — and
 * replace a working challenge with a dead one, so the control stops offering it.
 */
const MAX_RESENDS = 2;

const KEYBOARD_ACCESSORY = 'verify-username-code-accessory';

const countdown = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * The code screen for **username** sign-in. Behind `USERNAME_SIGN_IN_ENABLED` (false);
 * with it off, anybody who reaches this route is sent back to sign in.
 *
 * ---------------------------------------------------------------------------
 * A SEPARATE SCREEN, SO THE EMAIL ONE DOES NOT CHANGE BY A BYTE
 *
 * `verify.tsx` once carried a `mode` parameter and lost it deliberately. Adding one back
 * for this path would put the email flow's tested copy and behaviour behind a branch.
 * This screen shares its layout and its keyboard handling and nothing else.
 *
 * ---------------------------------------------------------------------------
 * IT NEVER NAMES AN ADDRESS, AND NEVER SAYS ONE WAS SENT TO
 *
 * This device does not know the email on the account, and does not know whether the
 * account exists: the server answers both the same. So the copy is conditional —
 * "if that account exists" — and points at "the email on your account". The escape is
 * "use your email instead", which is the path that works whatever went wrong here.
 *
 * The challenge is read from memory (`pendingUsernameChallenge`), not from route params:
 * see `features/auth/username-sign-in.ts`.
 */
export default function VerifyUsernameScreen() {
  const router = useRouter();
  const [held] = useState(() => (USERNAME_SIGN_IN_ENABLED ? pendingUsernameChallenge() : null));
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<'sent' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resends, setResends] = useState(0);
  const input = useRef<TextInput>(null);
  const [resendAt, setResendAt] = useState(() => Date.now() + RESEND_COOLDOWN_MS);
  const [now, setNow] = useState(() => Date.now());
  const sending = useRef(false);

  const remaining = Math.max(0, resendAt - now);
  const waiting = remaining > 0;
  const exhausted = resends >= MAX_RESENDS;

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  const complete = /^\d{6}$/.test(code.trim());

  const backToSignIn = () => {
    clearPendingUsernameChallenge();
    if (router.canGoBack()) router.back();
    else router.replace('/(auth)/sign-in');
  };

  const submit = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    const result = await verifyUsernameCode(code);
    sending.current = false;
    setBusy(false);
    if (!result.ok)
      setError(result.message ?? 'That code did not work. Check it, or send a new one.');
    // On success the router moves on, exactly as after an email code: a session with a
    // profile goes to the feed. A username always has a profile, so this never lands on
    // create-profile.
  };

  const resend = async () => {
    if (!held || sending.current || waiting || exhausted) return;
    sending.current = true;
    setResendAt(Date.now() + RESEND_COOLDOWN_MS);
    setNow(Date.now());
    setResends((n) => n + 1);
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await sendUsernameCode(held.username);
    setBusy(false);
    sending.current = false;
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setNotice('sent');
    setCode('');
    input.current?.focus();
  };

  if (!held) {
    return (
      <Screen airy includeBottomInset>
        <Text variant="title1">Start again</Text>
        <Text variant="body" tone="secondary">
          We lost track of which account to check. Enter your email or username once more.
        </Text>
        <Button label="Back to sign in" onPress={() => router.replace('/(auth)/sign-in')} />
      </Screen>
    );
  }

  return (
    <Screen airy includeBottomInset>
      <Pressable style={styles.body} accessible={false} onPress={() => Keyboard.dismiss()}>
        <View style={styles.intro}>
          <Text variant="title1">Check your email</Text>
          <Text variant="body" tone="secondary">
            If that account exists, we sent a six-digit code to the email on your account. Enter
            it to continue. It expires in 10 minutes.
          </Text>
        </View>

        <View style={styles.form}>
          <Field
            ref={input}
            label="Six-digit code"
            value={code}
            onChangeText={(next) => setCode(next.replace(/\D/g, '').slice(0, 6))}
            keyboardType="number-pad"
            inputMode="numeric"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            autoFocus
            maxLength={6}
            editable={!busy}
            onSubmitEditing={complete ? submit : undefined}
            inputAccessoryViewID={Platform.OS === 'ios' ? KEYBOARD_ACCESSORY : undefined}
            error={error ?? undefined}
            hint={
              notice === 'sent'
                ? 'If that account exists, a new code is on its way. It can take a moment.'
                : undefined
            }
          />
          <Button
            label={busy ? 'Checking…' : 'Continue'}
            onPress={submit}
            disabled={!complete || busy}
            disabledReason={complete ? 'Checking your code.' : 'Enter all six digits.'}
          />
          <Button
            label={
              exhausted
                ? 'No more codes for now'
                : waiting
                  ? `Resend code in ${countdown(remaining)}`
                  : 'Resend code'
            }
            kind="tertiary"
            onPress={resend}
            disabled={busy || waiting || exhausted}
            disabledReason={
              exhausted
                ? 'Try again later, or sign in with your email.'
                : waiting
                  ? 'Another code can be sent shortly.'
                  : 'One moment.'
            }
          />
          <Button
            label="Use your email instead"
            kind="tertiary"
            onPress={backToSignIn}
            disabled={busy}
            disabledReason="One moment."
          />
        </View>
      </Pressable>

      {Platform.OS === 'ios' ? (
        <InputAccessoryView nativeID={KEYBOARD_ACCESSORY}>
          <View style={styles.accessory}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Done. Hides the keyboard"
              onPress={() => Keyboard.dismiss()}
              hitSlop={theme.space[2]}
            >
              <Text variant="callout" tone="action">
                Done
              </Text>
            </Pressable>
          </View>
        </InputAccessoryView>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, justifyContent: 'center', gap: theme.space[8] },
  intro: { gap: theme.space[3] },
  form: { gap: theme.space[4] },
  accessory: {
    alignItems: 'flex-end',
    backgroundColor: theme.surface.raised,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border.hairline,
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[2],
  },
});
