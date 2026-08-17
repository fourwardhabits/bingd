import { Stack } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { AvatarPicker } from '@/features/profile/AvatarPicker';
import { useAccountWrites } from '@/features/settings/use-account';
import { Button, Field, Screen, SectionHeader, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * Edit Profile.
 *
 * The approved profile header is preserved exactly — a large avatar with the name and
 * handle beside it — and this is the screen that changes what it says. Two fields,
 * because there are two editable identity fields in the model and no more.
 *
 * **There is no bio, and its absence is the decision rather than an omission.** There
 * is no `profiles.bio` column, and adding one is not a column: it is free text on a
 * public page, which means a moderation surface, a length rule, a control-character
 * rule, a report subject and a spoiler question. The founder's instruction was to
 * implement it only if backed by real persisted storage and reviewed writes, and
 * otherwise to ship no fake one — the hardcoded "Movie and TV collector" that used to
 * sit in the place a bio goes was removed when it was found. Blank until there is a
 * real one is the honest state.
 *
 * The handle is the field that costs something, so it says so before it is changed
 * rather than after: every rename permanently retires the old name
 * (`username_history` keeps the row so it can never be taken by anybody else), and
 * there is a thirty-day cooldown behind it.
 */
export default function EditProfileScreen() {
  const profile = useCurrentProfile();
  const { updateProfile, changeUsername, busy } = useAccountWrites();

  const [name, setName] = useState(profile.display_name || '');
  const [handle, setHandle] = useState(profile.username);
  const [nameError, setNameError] = useState<string | null>(null);
  const [handleError, setHandleError] = useState<string | null>(null);

  const nameChanged = name.trim() !== (profile.display_name || '');
  const handleChanged = handle.trim().toLowerCase() !== profile.username.toLowerCase();

  const saveName = async () => {
    setNameError(null);
    const result = await updateProfile(name.trim());
    if (!result.ok) {
      setNameError(result.message);
      return;
    }
    Alert.alert('Name updated');
  };

  const saveHandle = async () => {
    setHandleError(null);
    const next = handle.trim().toLowerCase();

    // Asked before the write rather than explained after it. The cost is not
    // reversible and is not obvious: the old handle is retired for good, and anyone
    // holding a link to it gets a redirect for ninety days and nothing after that.
    Alert.alert(
      `Change your handle to @${next}?`,
      `@${profile.username} will be retired — nobody else can take it, so your old links cannot end up pointing at a stranger. They redirect here for 90 days. You can change your handle again in 30 days.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Change handle',
          style: 'destructive',
          onPress: () =>
            void (async () => {
              const result = await changeUsername(next);
              if (!result.ok) {
                setHandleError(result.message);
                return;
              }
              Alert.alert('Handle updated', `You are now @${next}.`);
            })(),
        },
      ],
    );
  };

  return (
    <Screen includeBottomInset>
      <Stack.Screen options={{ headerShown: true, title: 'Edit Profile', headerBackTitle: 'Back' }} />

      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <AvatarPicker />

        <View style={styles.section}>
          <SectionHeader title="Name" />
          <View style={styles.body}>
            <Field
              label="Display name"
              value={name}
              onChangeText={setName}
              maxLength={50}
              autoCapitalize="words"
              autoCorrect={false}
              hint="What people see beside your picture. Up to 50 characters."
              error={nameError ?? undefined}
            />
            <Button
              label={busy ? 'Saving…' : 'Save name'}
              onPress={() => void saveName()}
              disabled={busy || !nameChanged || name.trim().length === 0}
              disabledReason={
                name.trim().length === 0 ? 'Enter a name first' : 'Nothing has changed yet'
              }
            />
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeader title="Handle" />
          <View style={styles.body}>
            <Field
              label="Handle"
              value={handle}
              onChangeText={(next) => setHandle(next.toLowerCase())}
              maxLength={24}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              hint="3 to 24 characters: lowercase letters, numbers and underscores."
              error={handleError ?? undefined}
            />
            <Text variant="caption" tone="tertiary">
              Changing your handle retires the old one: nobody else can ever take it, so an
              old link cannot end up pointing at a stranger. Links redirect here for 90
              days. You can change it again after 30 days, and you can always take a
              handle back that was yours.
            </Text>
            <Button
              label={busy ? 'Working…' : 'Change handle'}
              kind="secondary"
              onPress={() => void saveHandle()}
              disabled={busy || !handleChanged || handle.trim().length < 3}
              disabledReason={
                handle.trim().length < 3
                  ? 'A handle is at least 3 characters'
                  : 'Nothing has changed yet'
              }
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
});
