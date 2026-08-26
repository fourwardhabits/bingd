import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert } from 'react-native';

import { withGrace } from '@/lib/grace';
import { Button } from '@/ui/components';

import { signOut } from './methods';

/**
 * How long the escape waits for the teardown before navigating anyway.
 *
 * **A backstop now rather than the bound**, and that inversion is the build-4 fix.
 * `signOut` used to await four unbounded operations, so this timer was the only thing
 * standing between a tap and forever — and reaching it meant navigating with the session
 * *still alive*, which routing correctly reads as "still signed in" and answers by
 * sending the person straight back to the screen they were trying to leave. A bound that
 * only the caller holds hands the caller a live session.
 *
 * `signOut` now bounds each of its own steps and ends the local session whether or not
 * any of them answered (`methods.ts`), and its budgets add up to less than this on
 * purpose. So by the time this fires, the ordinary case has already happened; what it
 * still covers is the JavaScript thread itself being too busy to run those timers on
 * time, which is precisely the condition under which a person is most stuck.
 */
const SIGN_OUT_GRACE_MS = 8000;

/**
 * The escape route out of onboarding, for the account that is the wrong one.
 *
 * **The trap this exists to open** was found on the founder's own device: sign in with
 * an email OTP, land on "Pick your name", and there is no way back. Settings — the only
 * surface with Sign out — is behind the profile gate, and on iOS uninstalling does not
 * reliably clear the Keychain session, so reinstalling reopens the same screen for the
 * same account. Being signed in to an account you cannot leave is a dead end the auth
 * architecture never meant to have; this is the door.
 *
 * It renders on the onboarding surfaces where Settings is unreachable — the profile
 * form and the taste flow — as a quiet tertiary action that does not compete with the
 * screen's own work. A confirmation stands between the tap and the sign-out because
 * the button sits near primary actions on both screens, and a mistap that ends a
 * session mid-signup would cost the form's contents.
 *
 * On confirmation it runs the canonical `signOut` — the same helper Settings uses, so
 * the device-token release, the pending Apple-name clear, and the settle-don't-throw
 * contract (review 45) all come along — and then routes to the auth entry explicitly.
 * Explicitly, because routing leaves a signed-out person *inside* the `(auth)` group
 * alone: from "Pick your name" nothing else would move them. Local sign-out only; no
 * other device's session and nothing about the account itself is touched.
 */
export function UseDifferentAccountButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // The ref, not the state, is the re-entry guard: state updates are async and a
  // double-tap on the confirm sheet would start two sign-outs.
  const signingOut = useRef(false);

  const escape = async () => {
    if (signingOut.current) return;
    signingOut.current = true;
    setBusy(true);
    // Settles always — see `signOut` — and is *bounded* here besides: its contract is
    // "does not throw", not "does not hang", and the awaits inside it are storage and
    // network. `withGrace` also absorbs a rejection, so the settle-don't-throw contract
    // is not load-bearing at this call site — a rejection here is a `void` press
    // handler's, and would die silently exactly the way the build-4 buttons did.
    await withGrace(signOut(), SIGN_OUT_GRACE_MS, undefined);
    // Navigate whatever happened above: this button's one promise is a way out. If the
    // session genuinely survived a hung teardown, routing brings the person back to the
    // onboarding surface with this button reset — retryable, never trapped.
    router.replace('/(auth)/sign-in');
  };

  const confirm = () =>
    Alert.alert('Sign out and use another account?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', onPress: () => void escape() },
    ]);

  return (
    <Button
      label={busy ? 'Signing out…' : 'Use a different account'}
      kind="tertiary"
      tone="secondary"
      onPress={confirm}
      disabled={busy}
      disabledReason="Signing out."
    />
  );
}
