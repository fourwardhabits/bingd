import { useQueryClient } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { AvatarPicker } from '@/features/profile/AvatarPicker';
import { useAccountWrites } from '@/features/settings/use-account';
import { queryKeys } from '@/lib/query';
import { Button, Field, KeyboardScreen, Screen, SectionHeader, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/** The bio's ceiling, matching `profiles.bio_shape`. */
const BIO_MAX = 120;

/**
 * Edit Profile — one form, one save.
 *
 * What this replaced had a Save button for the name and a separate control for the
 * handle, and told the reader about ninety-day redirects and reserved names underneath.
 * Two things were wrong with it, and the founder named both.
 *
 * **It exposed a seam a reader does not have.** "My profile" is one thing. A screen
 * with two saves can leave the name written and the handle refused, which is a
 * half-saved profile somebody has to reason about. `save_profile` is one transaction,
 * so the screen can be one form.
 *
 * **It explained the implementation.** Redirect windows, reservations, what happens to
 * old links — all true, all backend behaviour, and none of it a decision the person
 * typing a handle is making. What they need to know is the rule that binds them: the
 * shape, and that they can do it again in thirty days. The protections stay; the
 * lecture goes.
 *
 * The Bio is the founder's subheading concept as real data. There is a column now, it
 * is one line under the handle on every profile, and nothing here is hardcoded.
 */
export default function EditProfileScreen() {
  const profile = useCurrentProfile();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { saveProfile, busy } = useAccountWrites();

  const [name, setName] = useState(profile.display_name || '');
  const [handle, setHandle] = useState(profile.username);
  const [bio, setBio] = useState(profile.bio ?? '');
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const trimmedHandle = handle.trim().toLowerCase();
  const trimmedBio = bio.trim();

  const nameChanged = trimmedName !== (profile.display_name || '');
  const handleChanged = trimmedHandle !== profile.username.toLowerCase();
  const bioChanged = trimmedBio !== (profile.bio ?? '');
  const changed = nameChanged || handleChanged || bioChanged;

  const valid = trimmedName.length > 0 && trimmedHandle.length >= 3 && trimmedBio.length <= BIO_MAX;

  const save = async () => {
    setError(null);

    const commit = async () => {
      const result = await saveProfile({
        // Only what changed. Undefined leaves a field alone, which is what keeps a bio
        // edit from being charged the handle's thirty-day cooldown.
        displayName: nameChanged ? trimmedName : undefined,
        username: handleChanged ? trimmedHandle : undefined,
        // `''` rather than undefined when it has been emptied: null already means "do
        // not touch", so clearing needs a value of its own.
        bio: bioChanged ? trimmedBio : undefined,
      });

      if (!result.ok) {
        setError(result.message);
        return;
      }

      await queryClient.invalidateQueries({ queryKey: queryKeys.myProfile(profile.id) });
      router.back();
    };

    // Asked once, and only for the part that cannot be undone. A name and a bio are
    // edits; a handle is a decision, because the old one does not come back into
    // circulation and thirty days have to pass before the next one.
    if (handleChanged) {
      Alert.alert(
        `Change your handle to @${trimmedHandle}?`,
        'You can change it again in 30 days.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Save changes', onPress: () => void commit() },
        ],
      );
      return;
    }

    await commit();
  };

  return (
    <Screen includeBottomInset>
      <Stack.Screen options={{ headerShown: true, title: 'Edit Profile', headerBackTitle: 'Back' }} />

      <KeyboardScreen contentContainerStyle={styles.page}>
        <AvatarPicker />

        <View style={styles.section}>
          <SectionHeader title="About you" />
          <View style={styles.body}>
            <Field
              label="Display name"
              value={name}
              onChangeText={setName}
              maxLength={50}
              autoCapitalize="words"
              autoCorrect={false}
              hint="What people see beside your picture."
            />

            <Field
              label="Handle"
              value={handle}
              onChangeText={(next) => setHandle(next.toLowerCase())}
              maxLength={24}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              // The rule that binds them, and nothing about how it is enforced.
              hint={
                '3–24 characters.\nLowercase letters, numbers, and underscores.\nYou can change your handle every 30 days.'
              }
            />

            <Field
              label="Bio"
              value={bio}
              onChangeText={setBio}
              maxLength={BIO_MAX}
              multiline
              autoCapitalize="sentences"
              hint="A short line about you and your taste."
            />
            {/* Only once it is worth knowing. A counter from zero is a target. */}
            {bio.length > BIO_MAX - 30 ? (
              <Text variant="caption" tone={bio.length > BIO_MAX ? 'action' : 'tertiary'}>
                {BIO_MAX - bio.length} characters left
              </Text>
            ) : null}

            {error ? (
              <Text variant="footnote" tone="action">
                {error}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.body}>
          <Button
            label={busy ? 'Saving…' : 'Save changes'}
            onPress={() => void save()}
            disabled={busy || !changed || !valid}
            disabledReason={
              !valid ? 'Fill in a name and a handle first' : 'Nothing has changed yet'
            }
          />
        </View>
      </KeyboardScreen>
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { paddingBottom: theme.space[10] },
  section: { paddingTop: theme.space[5], gap: theme.space[1] },
  body: { paddingHorizontal: theme.layout.gutter, gap: theme.space[3], paddingTop: theme.space[3] },
});
