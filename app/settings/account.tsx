import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';

import { signOut, useCurrentProfile } from '@/features/auth';
import { useAccountWrites } from '@/features/settings/use-account';
import { Button, Field, Screen, SectionHeader, Text } from '@/ui/components';
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

  const leave = async () => {
    await signOut();
    // Back to the root, which the auth routing resolves to the sign-in flow. Replaced
    // rather than pushed so the account screen is not behind a back gesture on a
    // session that no longer exists.
    router.replace('/');
  };

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
              const result = await deleteAccount(confirmation.trim());
              if (!result.ok) {
                setError(result.message);
                Alert.alert('Could not delete your account', result.message);
                return;
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

      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.section}>
          <SectionHeader title="Signed in as" />
          <View style={styles.body}>
            <Text variant="body">
              {profile.display_name || profile.username}
              <Text tone="secondary">{`  @${profile.username}`}</Text>
            </Text>
            <Button label="Sign out" kind="secondary" onPress={() => void leave()} />
            <Text variant="caption" tone="tertiary">
              Signing out leaves everything where it is. Sign back in on this or any
              other device and your collection is exactly as you left it.
            </Text>
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeader title="Delete your account" />
          <View style={styles.body}>
            <Text variant="body">
              This is permanent. There is no deactivation and nothing is held in
              reserve — once it is done, none of it can be recovered by you or by us.
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
                'Companion tags naming you, and everything in your notifications',
                'Your goals, your profile picture, and anything derived about you',
              ].map((line) => (
                <Text key={line} variant="caption" tone="tertiary">
                  ·  {line}
                </Text>
              ))}
            </View>

            <View style={styles.inventory}>
              <Text variant="caption" tone="secondary">
                Kept, with nothing left that points at you:
              </Text>
              {[
                'Your handle stays reserved, so nobody else can take it and inherit your old links',
                'Moderation reports, so a record of why an account was removed survives the account',
                'How many people joined through an invite, without naming who invited them',
              ].map((line) => (
                <Text key={line} variant="caption" tone="tertiary">
                  ·  {line}
                </Text>
              ))}
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
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { paddingBottom: theme.space[10] },
  section: { paddingTop: theme.space[5], gap: theme.space[1] },
  body: { paddingHorizontal: theme.layout.gutter, gap: theme.space[3] },
  inventory: { gap: 2 },
});
