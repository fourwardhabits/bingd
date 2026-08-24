import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, StyleSheet, TextInput, View } from 'react-native';

import {
  clearPendingDisplayName,
  createProfile,
  signOut,
  takePendingDisplayName,
  usernameAvailability,
  useAuth,
} from '@/features/auth';
import { track } from '@/lib/analytics';
import { openLegal } from '@/lib/legal';
import { queryKeys } from '@/lib/query';
import { Button, Field, KeyboardScreen, Screen, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * Onboarding step one: the account itself.
 *
 * Reached whenever a session exists without a profile, which auth.md §4 treats as a
 * real state rather than a transient one — so a user who abandons this screen and
 * reopens the app comes back to it instead of to a broken empty account.
 */
export default function CreateProfileScreen() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const router = useRouter();

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [birth, setBirth] = useState({ day: '', month: '', year: '' });
  /**
   * The answer *and the name it is about*. Storing only the boolean lets a slow
   * reply for `ros` land while the field reads `rosalind`, and the form then reports
   * availability for a name nobody asked about.
   */
  const [checked, setChecked] = useState<{ name: string; available: boolean | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const monthRef = useRef<TextInput>(null);
  const dayRef = useRef<TextInput>(null);
  const yearRef = useRef<TextInput>(null);

  // Apple hands over the name exactly once, at the first authorization, and never
  // again (auth.md §3). It was parked at that moment; this is the only screen that
  // can still use it.
  useEffect(() => {
    takePendingDisplayName().then((name) => {
      if (name) setDisplayName((current) => current || name);
    });
  }, []);

  const normalised = username.trim().toLowerCase();
  const formatOk = /^[a-z0-9_]{3,24}$/.test(normalised);

  // Debounced so a five-character name is one request rather than five.
  const latest = useRef(0);
  useEffect(() => {
    if (!formatOk) return;
    const ticket = ++latest.current;
    const timer = setTimeout(async () => {
      const result = await usernameAvailability(normalised);
      // Discards a reply that a later keystroke has already made irrelevant.
      if (ticket === latest.current) setChecked({ name: normalised, available: result });
    }, 400);
    return () => clearTimeout(timer);
  }, [normalised, formatOk]);

  const settled = formatOk && checked?.name === normalised;
  const available = settled ? checked!.available : null;
  const checking = formatOk && !settled;

  const dateOfBirth = useMemo(() => {
    const month = Number(birth.month);
    const day = Number(birth.day);
    const year = Number(birth.year);
    if (!month || !day || !year || birth.year.length !== 4) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    // Constructed in UTC and read back, which rejects 31 February rather than
    // silently rolling it into March.
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date.toISOString().slice(0, 10);
  }, [birth]);

  const setMonth = (value: string) => {
    const clean = value.replace(/\D/g, '').slice(0, 2);
    setBirth((b) => ({ ...b, month: clean }));
    if (clean.length === 2) dayRef.current?.focus();
  };

  const setDay = (value: string) => {
    const clean = value.replace(/\D/g, '').slice(0, 2);
    setBirth((b) => ({ ...b, day: clean }));
    if (clean.length === 2) yearRef.current?.focus();
  };

  const setYear = (value: string) => {
    const clean = value.replace(/\D/g, '').slice(0, 4);
    setBirth((b) => ({ ...b, year: clean }));
  };

  const usernameError = () => {
    if (!username) return undefined;
    if (!formatOk) return '3–24 characters: lowercase letters, numbers, or underscores.';
    if (available === false) return 'That one is taken. Try another.';
    return undefined;
  };

  // `available !== false` rather than `=== true`: an availability check that could
  // not complete must not block signup, because the insert is the real authority and
  // it will refuse the name if it is taken. Requiring a successful check would make
  // a flaky connection look like a permanently unavailable username.
  const ready = formatOk && available !== false && dateOfBirth !== null && !busy;
  const birthError =
    birth.month.length === 2 && birth.day.length === 2 && birth.year.length === 4 && !dateOfBirth
      ? 'Enter a real date in MM/DD/YYYY.'
      : undefined;

  const submit = async () => {
    if (!dateOfBirth) return;

    // auth.md §4 requires an under-13 signup to be refused *and deleted*. That makes
    // a mistyped year destructive in a way no other field on this screen is, so the
    // date is confirmed before it is sent rather than after.
    const confirmed = await confirmDateOfBirth(dateOfBirth);
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    const result = await createProfile({
      username: normalised,
      displayName: displayName.trim() || null,
      dateOfBirth,
    });
    setBusy(false);

    switch (result.outcome) {
      case 'created':
        // `created` only. `already_exists` below is a replay of an account that was
        // already there, and counting it would report a second signup for one person.
        track({ name: 'signup_completed' });
        await clearPendingDisplayName();
        // The gate re-reads the profile and moves the user. Navigating from here as
        // well would race it.
        await queryClient.invalidateQueries({
          queryKey: queryKeys.myProfile(auth.status === 'onboarding' ? auth.userId : 'none'),
        });
        return;

      case 'already_exists':
        await queryClient.invalidateQueries({
          queryKey: queryKeys.myProfile(auth.status === 'onboarding' ? auth.userId : 'none'),
        });
        return;

      case 'under_13':
        // The account is already gone server-side. Ending the session locally keeps
        // the app from holding a token for a user that no longer exists.
        setRefused(true);
        await signOut();
        return;

      case 'username_taken':
        setChecked({ name: normalised, available: false });
        return;

      default:
        // The request was never answered, so the profile may exist. Re-reading it is
        // what lets the gate move somebody who already has an account instead of
        // leaving them on a form that will only ever answer `already_exists`
        // (`lib/write-outcome.ts`). Independent review 21e's invariant.
        if (result.outcome === 'failed' && result.changed) {
          await queryClient.invalidateQueries({
            queryKey: queryKeys.myProfile(auth.status === 'onboarding' ? auth.userId : 'none'),
          });
        }
        setError(result.message);
    }
  };

  if (refused) {
    return (
      <Screen airy includeBottomInset>
        <Text variant="title1">bingd. is for ages 13 and over</Text>
        <Text variant="body" tone="secondary">
          We could not create this account with that date of birth. We have not kept your
          details.
        </Text>
        {/*
          Without this the screen is a dead end. The session is already signed out, and
          routing only moves signed-out users who are *outside* the auth group, so it
          leaves this screen alone and there is nothing to tap. The only way out is
          force-quitting the app, which reads as a crash. Navigating explicitly rather
          than clearing `refused`, which would show the signup form to a signed-out user.
        */}
        <Button
          label="Done"
          kind="secondary"
          onPress={() => router.replace('/(auth)/sign-in')}
        />
      </Screen>
    );
  }

  return (
    <Screen includeBottomInset>
      {/* What this replaced was `KeyboardAvoidingView` with `behavior: undefined` on
          Android — which is not a behaviour, it is a deferral to
          `windowSoftInputMode=adjustResize`. Under edge-to-edge the window does not
          resize, so on the platform this app ships to first the component did nothing
          at all, and the birthday fields in the lower half of this form were behind
          the keyboard that had just been opened to fill them in. */}
      <KeyboardScreen contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.intro}>
          <Text variant="title1">Pick your name</Text>
          <Text variant="body" tone="secondary">
            Your username is how friends find you. You can change it later, once a
            month.
          </Text>
        </View>

        <View style={styles.form}>
          <Field
            label="Username"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username-new"
            maxLength={24}
            editable={!busy}
            error={usernameError()}
            hint={
              checking
                ? 'Checking…'
                : available === true
                  ? 'Available.'
                  : settled && available === null
                    ? 'Could not check just now. You can still continue.'
                    : 'Lowercase letters, numbers, and underscores.'
            }
          />

          <Field
            label="Display name"
            value={displayName}
            onChangeText={setDisplayName}
            autoCapitalize="words"
            maxLength={50}
            editable={!busy}
            hint="Optional. We will use your username if you leave this empty."
          />

          <View style={styles.birth}>
            <Text variant="caption" tone="secondary">
              Date of birth
            </Text>
            {/* **The question a beta tester actually asked.**
                The screen collected a birthday with no explanation at all — the two
                fields above it both carry a hint and this block carried none, so the
                only place the reason appeared was the refusal screen, which you see
                only if you are turned away.

                **Widened on 2026-08-25, with DOB-1.** The previous line said this is
                used to check you are 13 or over, full stop. That was true of the code
                and too narrow as a statement of intent: the founder's decision is to
                retain the date for eligibility *and* for future personalisation and
                aggregate taste analysis, so a promise that it is used for one thing
                only is a promise this app intends to outgrow. Better to say the honest
                thing now than to quietly broaden the use later under copy that ruled
                it out.

                Every clause is still literally true of what ships today. The 13+
                comparison is `create_profile`'s and is the only current reader. "May
                also help" is a hedge on purpose: nothing personalises anything from it
                yet, and claiming otherwise would be the opposite error. The value lands
                in `profile_private`, which has RLS enabled and no policy and no select
                grant, so no API returns it to anybody — including the person who typed
                it — and it is on the analytics denylist. What is deliberately *not*
                here is "we don't save it", which would be false. */}
            <Text variant="caption" tone="tertiary">
              We use your birthday to confirm you are 13 or older. It may also help us
              personalise recommendations as bingd. improves. It is never shown to anyone.
            </Text>
            <View style={styles.birthRow}>
              <View style={styles.birthDay}>
                <Field
                  ref={monthRef}
                  label="Month"
                  value={birth.month}
                  onChangeText={setMonth}
                  keyboardType="number-pad"
                  inputMode="numeric"
                  maxLength={2}
                  editable={!busy}
                  returnKeyType="next"
                  onSubmitEditing={() => dayRef.current?.focus()}
                  error={birthError}
                />
              </View>
              <View style={styles.birthDay}>
                <Field
                  ref={dayRef}
                  label="Day"
                  value={birth.day}
                  onChangeText={setDay}
                  keyboardType="number-pad"
                  inputMode="numeric"
                  maxLength={2}
                  editable={!busy}
                  returnKeyType="next"
                  onSubmitEditing={() => yearRef.current?.focus()}
                  error={birthError}
                />
              </View>
              <View style={styles.birthYear}>
                <Field
                  ref={yearRef}
                  label="Year"
                  value={birth.year}
                  onChangeText={setYear}
                  keyboardType="number-pad"
                  inputMode="numeric"
                  maxLength={4}
                  editable={!busy}
                  returnKeyType="done"
                  error={birthError}
                />
              </View>
            </View>
          </View>

          {error ? (
            <Text variant="caption" tone="action">
              {error}
            </Text>
          ) : null}

          <Button
            label={busy ? 'Creating…' : 'Create my account'}
            onPress={submit}
            disabled={!ready}
            disabledReason={
              busy
                ? 'Creating your account.'
                : 'Choose an available username and enter your date of birth.'
            }
          />

          {/* **The one thing a new account is never told.**
              Visibility is set by the column default and by nothing the user does,
              so until this line the first time anybody learned their profile was
              public was by finding the switch that turns it off. One sentence, under
              the button that creates the account, naming the setting and where to
              change it — deliberately not a screen, not a choice, and not a step:
              PRD §22 keeps public as the default, and this only stops it being a
              silent one. */}
          <Text variant="caption" tone="tertiary">
            Your account starts public, so people can find you and see what you rank.
            You can make it private whenever you like, in Settings.
          </Text>

          {/* **The acknowledgment, and deliberately not a checkbox.**

              A sentence under the button that creates the account is the standard
              form, and it is the honest one here: the act of creating the account is
              the agreement, so a tick box beside it asks the user to confirm the thing
              they are already doing. The two links are the substance — an
              acknowledgment referring to documents nobody can reach is worse than
              none, because it claims consent to something unread and unreachable.

              **Nothing is persisted, and that is a decision rather than an omission.**
              Storing an accepted-version stamp is what a product needs when it intends
              to *re-prompt* on a change — a versioned Terms table, a gate on the next
              launch, a screen that blocks the app until somebody taps Agree. None of
              that exists, none of it is planned for public v1, and adding the column
              now would be a legal data model with no reader, which is the kind of
              thing that later gets treated as evidence of a process that was never
              run. The account's creation timestamp already records when somebody
              agreed to the Terms as they stood that day. */}
          <Text variant="caption" tone="tertiary">
            By creating an account, you agree to the{' '}
            <Text
              variant="caption"
              tone="action"
              accessibilityRole="link"
              accessibilityHint="Opens in your browser"
              onPress={() => openLegal('terms')}
            >
              Terms of Use
            </Text>{' '}
            and{' '}
            <Text
              variant="caption"
              tone="action"
              accessibilityRole="link"
              accessibilityHint="Opens in your browser"
              onPress={() => openLegal('privacy')}
            >
              Privacy Policy
            </Text>
            .
          </Text>
        </View>
      </KeyboardScreen>
    </Screen>
  );
}

/**
 * A real confirmation rather than a courtesy one. The consequence of an under-13
 * date is deletion, so the number is read back in words the user can check at a
 * glance instead of as the three boxes they just typed.
 */
function confirmDateOfBirth(iso: string) {
  const readable = new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return new Promise<boolean>((resolve) => {
    Alert.alert(
      'Is this your date of birth?',
      `${readable}\n\nPlease confirm this is correct before continuing.`,
      [
        { text: 'Change it', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Yes, that is right', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    gap: theme.space[8],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[8],
  },
  intro: { gap: theme.space[3] },
  form: { gap: theme.space[4] },
  birth: { gap: theme.space[2] },
  birthRow: { flexDirection: 'row', gap: theme.space[3] },
  birthDay: { flex: 1 },
  birthYear: { flex: 1.4 },
});
