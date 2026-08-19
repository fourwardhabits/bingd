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
        track({ name: 'account_created' });
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
        <Text variant="title1">Bingd is for ages 13 and over</Text>
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
