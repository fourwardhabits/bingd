import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { signOut, useCurrentProfile } from '@/features/auth';
import { deleteAllAvatars } from '@/features/profile/avatar';
import { useAccountWrites } from '@/features/settings/use-account';
import { Button, Field, KeyboardScreen, Screen, SectionHeader, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * Account & Data.
 *
 * Two controls that could not be more different in consequence, so they are separated
 * by the whole inventory of what deletion actually does rather than sitting side by
 * side as two buttons.
 *
 * **The deletion is real.** It is not a flag, not a hidden profile and not a support
 * ticket: `delete_account` removes the `auth.users` row, and every table in the schema
 * hangs off it through a foreign key that was given a deliberate delete rule. The four
 * things that are anonymised rather than removed are listed below in the same words
 * the migration uses, because a beta tester deciding whether to trust this app with a
 * year of their viewing deserves the actual answer rather than "we delete your data".
 *
 * **There is no "deactivate".** `profile_status` is (`active`, `suspended`) and there
 * is no third value; temporary deactivation is not a V1 state. Saying so here is
 * better than a control that pretends to hide an account and only signs it out.
 *
 * The confirmation is the caller's own handle, typed. A yes/no dialog is a mistap, and
 * this is the one action in the app that cannot be undone by any means.
 */
export default function AccountScreen() {
  const profile = useCurrentProfile();
  const router = useRouter();
  const { deleteAccount, busy } = useAccountWrites();
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);

  const matches = confirmation.trim().toLowerCase() === profile.username.toLowerCase();

  const destroy = () => {
    setError(null);
    Alert.alert(
      'Delete your account?',
      'This removes your account, your rankings, your watchlist, your notes and your activity. It cannot be undone and there is no way to recover any of it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete for good',
          style: 'destructive',
          onPress: () =>
            void (async () => {
              /**
               * The pictures go first, and through the Storage API.
               *
               * Deleting a `storage.objects` row in SQL removes the metadata and
               * leaves the file in the bucket — Supabase says so, and independent
               * review 14 raised an earlier version of this flow as a Blocker for
               * claiming otherwise. This call is the only thing that removes bytes;
               * `delete_account` sweeps whatever rows are left as a backstop.
               *
               * A failure here does not stop the deletion. Refusing to delete an
               * account because an object store did not answer would be the worse
               * outcome by a wide margin, and the sweep still makes the picture
               * unreachable. The person is told, because "we removed everything" and
               * "we removed everything except one file we could not reach" are
               * different sentences and only one of them is true.
               */
              const removed = await deleteAllAvatars(profile.id);

              const result = await deleteAccount(confirmation.trim());
              if (!result.ok) {
                setError(result.message);
                Alert.alert('Could not delete your account', result.message);
                return;
              }

              // Two independent ways to learn the pictures did not all go: the client's
              // own uncertainty, and the server's count of what is still there. The
              // second exists because `delete_account` cannot remove them — Supabase
              // refuses direct deletion from storage tables — so counting is the only
              // thing it can honestly do, and saying nothing would be the lie.
              if (removed === null || (result.avatarsRemaining ?? 0) > 0) {
                Alert.alert(
                  'Account deleted',
                  'Your account and everything in it is gone. One thing is not certain: your stored pictures could not be fully cleared, so some may still exist in storage even though nothing links to them any more.',
                );
              }

              // The account is gone; the session is the last thing pointing at it.
              await signOut();
              router.replace('/');
            })(),
        },
      ],
    );
  };

  return (
    <Screen includeBottomInset>
      <Stack.Screen
        options={{ headerShown: true, title: 'Account & Data', headerBackTitle: 'Back' }}
      />

      {/* The confirmation field is the last thing on a long page, which on Android
          edge-to-edge means the keyboard covers the field the moment it is focused and
          the Delete control under it with the same gesture. `KeyboardScreen` measures
          the keyboard rather than relying on a window resize that does not happen. */}
      <KeyboardScreen contentContainerStyle={styles.page}>
        {/* Sign out used to live here, beside permanent deletion. The founder's
            correction moved it to Settings' own list: one is how you finish for the
            day and the other cannot be undone, and a screen that offers them together
            invites the wrong tap. What is left here is only the irreversible thing,
            with the whole inventory above it — and the name of the account it will
            happen to, which is the one thing worth stating before an irreversible act. */}
        <View style={styles.section}>
          <SectionHeader title="Signed in as" />
          <View style={styles.body}>
            <Text variant="body">
              {profile.display_name || profile.username}
              <Text tone="secondary">{`  @${profile.username}`}</Text>
            </Text>
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeader title="Delete your account" />
          <View style={styles.body}>
            <Text variant="body">
              This is permanent. There is no deactivation and nothing is held in reserve — once
              it is done, none of it can be recovered by you or by us.
            </Text>

            <View style={styles.inventory}>
              <Text variant="caption" tone="secondary">
                Removed straight away:
              </Text>
              {[
                'Your account, sign-in method and profile',
                'Every ranking, watch, watchlist entry and note',
                'Your follows, followers and blocks, in both directions',
                'Your activity, reactions and comments — including comments on other people’s activity',
                'Recommendations you sent and were sent, and your invite link',
                'Companion tags naming you, and everything in your notifications',
                'Your goals, every picture you have uploaded, and anything derived about you',
              ].map((line) => (
                <Text key={line} variant="caption" tone="tertiary">
                  · {line}
                </Text>
              ))}
            </View>

            <View style={styles.inventory}>
              <Text variant="caption" tone="secondary">
                Kept, with nothing left that names you:
              </Text>
              {[
                'Your handle stays reserved, so nobody else can take it and inherit your old links',
                'How many people joined through an invite, without naming who invited them',
              ].map((line) => (
                <Text key={line} variant="caption" tone="tertiary">
                  · {line}
                </Text>
              ))}
            </View>

            {/* Said in its own category rather than folded into the one above, which
                is where it used to sit and where it was not true. A report holds free
                text somebody typed and, when it is about an account, that account's
                identifier — and both have to survive, or closing an account would be
                a way to erase every complaint made about it. Independent review 14
                found the earlier copy claiming otherwise. */}
            <View style={styles.inventory}>
              <Text variant="caption" tone="secondary">
                Kept as a safety record, and not anonymous:
              </Text>
              <Text variant="caption" tone="tertiary">
                · Reports made about you or by you, including what was written in them, and any
                action taken. An account that could delete the reports against it by closing
                itself would make reporting worthless.
              </Text>
            </View>

            <Field
              label={`Type ${profile.username} to confirm`}
              value={confirmation}
              onChangeText={setConfirmation}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              maxLength={24}
              hint="Your own handle, exactly. This is the only confirmation."
              error={error ?? undefined}
            />

            <Button
              label={busy ? 'Deleting…' : 'Delete my account'}
              onPress={destroy}
              disabled={busy || !matches}
              disabledReason="Type your handle above to enable this"
            />
          </View>
        </View>
      </KeyboardScreen>
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { paddingBottom: theme.space[10] },
  section: { paddingTop: theme.space[5], gap: theme.space[1] },
  body: { paddingHorizontal: theme.layout.gutter, gap: theme.space[3] },
  inventory: { gap: 2 },
});
