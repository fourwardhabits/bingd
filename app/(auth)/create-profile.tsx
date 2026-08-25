import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, StyleSheet, TextInput, View } from 'react-native';

import {
  applyInitialVisibility,
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
import { Button, Field, KeyboardScreen, Screen, SegmentedControl, Text } from '@/ui/components';
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
   * **Public, because that is what the column already does** — not because this screen
   * has an opinion. PRD §22 keeps public as the product default and `profiles.visibility`
   * defaults to it, so seeding the control any other way would show somebody a choice
   * whose answer differs from what `create_profile` is about to store.
   *
   * What has changed is that the default is now *shown* before the account exists
   * rather than described in a paragraph underneath the button that creates it.
   */
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
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
    try {
      await create();
    } finally {
      // **Cleared in a `finally`, after everything the submission does.**
      //
      // It used to be cleared the moment `create_profile` answered, which left the
      // button live while the visibility write was still in flight — so a second tap
      // could earn `already_exists`, invalidate the profile query, and let the router
      // gate admit somebody into the app before the account they asked to be private
      // was private. Review 41's first Major. The flag has to cover the whole act, not
      // the first call in it.
      setBusy(false);
    }
  };

  /**
   * The privacy choice, applied to whatever account this submission left behind.
   *
   * After `create_profile` rather than inside it: the RPC takes no visibility and giving
   * it one is a migration. `set_profile_visibility` is the same function the Privacy
   * screen calls, so this is the existing path rather than a second one.
   *
   * **Awaited before the gate is opened**, so that a private account is private before
   * the app lets anyone in — a beat spent public is a beat during which somebody's first
   * ranking is readable.
   *
   * **Not blocking.** A refusal leaves a real account with the default setting, and
   * holding somebody on a signup form for an account they already have is exactly the
   * dead end `already_exists` exists to prevent. They are told instead, and pointed at
   * the screen that finishes the job.
   *
   * A no-op for Public, which is the column default — so the only account this can ever
   * change is one whose owner asked for *more* privacy than they were about to get.
   * That is what makes it safe to call on the two uncertain outcomes below as well as on
   * the certain one.
   */
  const applyVisibility = async () => {
    const applied = await applyInitialVisibility(visibility);
    if (!applied.ok) {
      Alert.alert(
        'Your account is ready',
        'We could not set your profile to private just now. You can turn it on in Settings › Privacy.',
      );
    }
  };

  /** The gate re-reads the profile and moves the user. Navigating here would race it. */
  const openTheGate = () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.myProfile(auth.status === 'onboarding' ? auth.userId : 'none'),
    });

  const create = async () => {
    const result = await createProfile({
      username: normalised,
      displayName: displayName.trim() || null,
      dateOfBirth: dateOfBirth as string,
    });

    switch (result.outcome) {
      case 'created':
        // `created` only. `already_exists` below is a replay of an account that was
        // already there, and counting it would report a second signup for one person.
        track({ name: 'signup_completed' });
        await clearPendingDisplayName();
        await applyVisibility();
        await openTheGate();
        return;

      /**
       * A profile that exists already — which, on a screen only reachable without one,
       * is almost always this signup's own first attempt committing and losing its
       * reply.
       *
       * **So the visibility still has to be applied here**, and review 41's first Major
       * is the reason: the retry that lands on this branch is the same person making the
       * same choice, and skipping it admits them to an account that is public because
       * their first attempt is the one that won.
       *
       * The remaining case — a genuinely pre-existing account, created on another device
       * between the gate's read and this call — is safe for the same reason the helper
       * above is: Public writes nothing, so nothing can be made *more* visible than its
       * owner left it.
       */
      case 'already_exists':
        await applyVisibility();
        await openTheGate();
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
        //
        // **And the visibility goes with it** — review 41's second Major. This branch
        // is the one that admits a user on an *unproven* account, so it is the branch
        // where an unapplied Private is most likely to go unnoticed: the person is
        // shown an error, carried into the app by the gate anyway, and never told their
        // choice was dropped. `set_profile_visibility` raises 42704 when there is no
        // profile, which `applyInitialVisibility` reports as a failure rather than
        // throwing, so calling it on a maybe-account costs one refused request.
        if (result.outcome === 'failed' && result.changed) {
          await applyVisibility();
          await openTheGate();
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
        {/* **One line, not three.** The founder's screenshot of this screen on a
            physical device is mostly prose: an intro paragraph, a hint under every
            field, a paragraph about privacy under the button, and the legal line. The
            fields themselves — which are the whole point — were the smallest part of
            it. What survives here is the half of the sentence that is a *fact the
            reader needs before typing*; "you can change it later, once a month" is
            true, is not needed now, and is on the Settings screen that changes it. */}
        <View style={styles.intro}>
          <Text variant="title1">Pick your name</Text>
          <Text variant="footnote" tone="secondary">
            Your username is how friends find you.
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
            // The steady-state hint is gone: the rule it stated is already in
            // `usernameError`, which says it at the moment it is broken and in more
            // useful words. A permanent line restating a constraint nobody has hit yet
            // is a line of prose per field, which is what made this screen long.
            hint={
              checking
                ? 'Checking…'
                : available === true
                  ? 'Available.'
                  : settled && available === null
                    ? 'Could not check just now. You can still continue.'
                    : undefined
            }
          />

          <Field
            label="Display name"
            value={displayName}
            onChangeText={setDisplayName}
            autoCapitalize="words"
            maxLength={50}
            editable={!busy}
            hint="Optional."
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

                **"It is never shown to anyone" is gone, on founder review.** It was the
                broadest sentence on the screen and the only one this app cannot keep on
                its own account: "shown to anyone" reads as a claim about everything that
                ever touches the value — staff, processors, whoever operates the database
                — and what is actually true is narrower and checkable. The date lands in
                `profile_private`, which has RLS enabled with no policy and no select
                grant, so no API returns it to anybody including the person who typed it;
                it is on the analytics denylist; and nothing renders it on a profile.
                "Private and isn't shown on your profile" states exactly that and nothing
                wider. The whole handling story belongs in the Privacy Policy, which is
                linked at the foot of this screen.

                The rest is unchanged in meaning. The 13+ comparison is
                `create_profile`'s and is the only current reader. "May use age" is a
                hedge on purpose: nothing personalises anything from it yet, and claiming
                otherwise would be the opposite error. What is deliberately *not* here is
                "we don't save it", which would be false.

                **Copy only.** Storage, the age threshold, the analytics denylist and the
                RLS on `profile_private` are untouched by this change. */}
            <Text variant="caption" tone="tertiary">
              Your birthday is private and isn’t shown on your profile. We use it to
              confirm you’re 13 or older, and may use age to improve recommendations.
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

          {/**
            * **The choice, above the button that acts on it.**
            *
            * It used to be a paragraph *under* Create my account saying the account
            * starts public and can be changed in Settings — a description of a decision
            * already taken rather than a decision offered. The founder's correction is
            * that somebody should see and set this before the account exists.
            *
            * **The helper text is held to what the schema actually does.** A private
            * account is still findable: `search_users` moved to `can_discover_profile`
            * on 2026-08-19 precisely so somebody who knows you can find you and ask,
            * while `can_view_profile` keeps rankings, watchlist, reviews and activity
            * behind approval. So the sentence says "people can still find you" rather
            * than promising invisibility — the Privacy screen already learned this
            * lesson once, and a signup screen that overstates the protection is the
            * sentence somebody decides what to write against.
            *
            * The default stays Public (PRD §22), which is the column default too. The
            * control shows it rather than changing it.
            */}
          <View style={styles.visibility}>
            <Text variant="caption" tone="secondary">
              Profile visibility
            </Text>
            <SegmentedControl
              label="Profile visibility"
              value={visibility}
              onChange={setVisibility}
              disabled={busy}
              testID="profile-visibility"
              options={[
                {
                  id: 'public',
                  label: 'Public',
                  hint: 'Anyone can see your rankings and reviews.',
                },
                {
                  id: 'private',
                  label: 'Private',
                  hint: 'Only approved followers can see your activity.',
                },
              ]}
            />
            <Text variant="caption" tone="tertiary">
              {visibility === 'public'
                ? 'Anyone can see your rankings and reviews.'
                : 'People can still find you, but only approved followers can see your activity.'}
            </Text>
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

          {/* The paragraph that used to sit here — "Your account starts public, so
              people can find you and see what you rank. You can make it private
              whenever you like, in Settings." — is gone, and its job went with it. It
              existed because visibility was set by a column default and by nothing the
              reader did, so a sentence after the fact was the only way they would ever
              learn. There is a control above the button now, so the same sentence would
              be describing a choice the reader has just made for themselves. */}

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
  // Tightened along with the prose. The gap between the heading and the form was
  // `space[8]` on a screen that also padded itself `space[8]` top and bottom — three of
  // the largest steps in the scale, on the one screen with the most to fit.
  // `justifyContent` stays `center` so a short form still sits mid-screen on a large
  // phone rather than clinging to the status bar.
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    gap: theme.space[5],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[6],
  },
  intro: { gap: theme.space[2] },
  form: { gap: theme.space[4] },
  birth: { gap: theme.space[2] },
  visibility: { gap: theme.space[2] },
  birthRow: { flexDirection: 'row', gap: theme.space[3] },
  birthDay: { flex: 1 },
  birthYear: { flex: 1.4 },
});
