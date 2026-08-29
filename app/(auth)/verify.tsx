import { useLocalSearchParams, useRouter } from 'expo-router';
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

import { sendEmailCode, verifyEmailCode } from '@/features/auth';
import { Button, Field, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * How long the resend control stays inert after a code has gone out.
 *
 * The founder's number. Long enough that a double-tap and an impatient second tap both
 * land inside it; short enough that somebody whose code genuinely did not arrive is not
 * left staring at a dead screen. It is a courtesy bound, not the security one — GoTrue's
 * own `over_email_send_rate_limit` is the real ceiling, and this exists so a reader meets
 * a countdown they can read instead of an error they cannot act on.
 */
const RESEND_COOLDOWN_MS = 30_000;

/** The iOS accessory bar's id. Native ids are strings and this is the only one here. */
const KEYBOARD_ACCESSORY = 'verify-code-accessory';

/** `0:29`, `0:05`. Seconds alone would read as a bare number beside a word. */
const countdown = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `0:${String(seconds).padStart(2, '0')}`;
};

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
 *
 * ---------------------------------------------------------------------------
 * THE KEYBOARD CAN BE PUT AWAY (founder device pass, 2026-08-29)
 *
 * `keyboardType="number-pad"` has no return key, so on iOS this screen had no gesture
 * that dismissed it at all — and the screen is short enough that the pad covered the two
 * tertiary controls under Continue. Two answers, because neither alone is enough:
 *
 *   - **tapping anywhere off the field**, which is what every other app on the phone
 *     does and what somebody tries first. The `Pressable` below wraps the content rather
 *     than sitting behind it, so it cannot swallow a tap meant for a control: React
 *     Native gives a child responder priority, and Continue keeps working with the
 *     keyboard up;
 *   - **a Done bar above the pad on iOS**, for the case where the content is entirely
 *     under the keyboard and there is nothing off-field left to tap. `InputAccessoryView`
 *     is an iOS component and is not mounted elsewhere; Android's own back gesture
 *     already dismisses, and its behaviour here is unchanged.
 *
 * Both call `Keyboard.dismiss()` — the native dismissal — rather than blurring a ref,
 * which is the ornamental version that leaves the pad on screen.
 */
export default function VerifyScreen() {
  const router = useRouter();
  const { email } = useLocalSearchParams<{ email?: string }>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<TextInput>(null);

  /**
   * When the resend control comes back, held as a deadline rather than as a ticking
   * number so that a re-render cannot lose a second of it.
   *
   * Seeded to a full cooldown on mount, because arriving here *is* the moment a code was
   * sent — the previous screen has just done it. A control that is live the instant the
   * screen appears invites the tap that earns `over_email_send_rate_limit`, which is a
   * dead end the reader cannot act on; a countdown is the same refusal said usefully.
   */
  const [resendAt, setResendAt] = useState(() => Date.now() + RESEND_COOLDOWN_MS);
  const [now, setNow] = useState(() => Date.now());
  /**
   * The concurrency guard, and a ref rather than state on purpose: two taps in one frame
   * both read the same render's `busy`, and only a value that changes synchronously can
   * refuse the second. `busy` is what the buttons *say*; this is what stops the send.
   */
  const sending = useRef(false);

  const remaining = Math.max(0, resendAt - now);
  const waiting = remaining > 0;

  // One timer, only while there is something to count down, and it stops itself at zero
  // rather than ticking for the life of the screen. The dependency is the *predicate*
  // and not `remaining`, so the interval is not torn down and rebuilt every second.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

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

  /**
   * Another code to the same address.
   *
   * `sendEmailCode` is the one path the sign-in screen uses, unchanged and with the same
   * `shouldCreateUser`, so a resend cannot create a second account and cannot land the
   * reader in a different flow from the one they started. The pending invite is device
   * local (`features/invite/pending.ts`) and is neither read nor written here, so
   * attribution survives however many codes are sent.
   *
   * **The cooldown is armed before the request, not after it.** Arming on success would
   * leave the control live for the whole round trip, which is exactly the window a
   * double-tap lands in; and a failed send has still cost an email attempt at GoTrue, so
   * a failure that re-opened the button immediately would be the fastest way to earn a
   * rate limit. The screen is never permanently disabled by one failure — the same
   * countdown runs and the control comes back.
   */
  const resend = async () => {
    if (sending.current || waiting) return;
    sending.current = true;
    setResendAt(Date.now() + RESEND_COOLDOWN_MS);
    setNow(Date.now());
    setBusy(true);
    // The old code's rejection is about a code that is being replaced, so it goes with
    // it — leaving it up would have the screen reporting a failure and a fresh send at
    // once.
    setError(null);
    setResent(false);
    const result = await sendEmailCode(address);
    setBusy(false);
    sending.current = false;
    if (!result.ok) {
      // Whatever GoTrue said, as `sendEmailCode` maps it — a rate limit or a closed
      // signup, never anything about whether this address has an account.
      setError(result.message ?? 'Could not send another code.');
      return;
    }
    setResent(true);
    // The field is cleared because the digits in it belong to a code that has just been
    // superseded, and focus returns so the next six go where they are typed.
    setCode('');
    input.current?.focus();
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
      {/* Wraps the content rather than sitting behind it — see the header. `accessible`
          is false so this does not become a control a screen reader has to walk past to
          reach the field; dismissal for those readers is the Done bar and the platform's
          own gesture. */}
      <Pressable style={styles.body} accessible={false} onPress={() => Keyboard.dismiss()}>
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
            ref={input}
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
            // iOS only. An unknown `nativeID` on Android is ignored rather than fatal,
            // but passing one would be claiming a bar that is never drawn.
            inputAccessoryViewID={Platform.OS === 'ios' ? KEYBOARD_ACCESSORY : undefined}
            error={error ?? undefined}
            hint={resent ? 'New code sent. It can take a moment to arrive.' : undefined}
          />
          <Button
            label={busy ? 'Checking…' : 'Continue'}
            onPress={submit}
            disabled={!complete || busy}
            disabledReason={complete ? 'Checking your code.' : 'Enter all six digits.'}
          />
          {/* The way to get another one, and the countdown is the refusal said usefully:
              a disabled button with no explanation is indistinguishable from a broken
              one. The wait rides in the label rather than on a line of its own, so the
              screen does not change height as it ticks. */}
          <Button
            label={waiting ? `Resend code in ${countdown(remaining)}` : 'Resend code'}
            kind="tertiary"
            onPress={resend}
            disabled={busy || waiting}
            disabledReason={waiting ? 'Another code can be sent shortly.' : 'One moment.'}
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
      </Pressable>

      {/* The one control a number pad does not come with. */}
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
  // The airy layout `Screen` gives its children, reproduced on the dismiss wrapper so
  // that inserting it changes nothing about where anything sits.
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
