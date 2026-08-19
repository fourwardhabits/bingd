import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Linking, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { queryKeys } from '@/lib/query';
import { Avatar, Button, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { pickAndUploadAvatar, removeAvatar } from './avatar';

/**
 * The profile picture control, in Settings.
 *
 * Settings rather than the profile page, because it is an edit and the profile
 * page is what other people see. It is also the only entry point: an avatar
 * cannot exist before a profile does, or the age gate in `create_profile` would
 * be unable to delete a refused account (20260813002200, and `set_avatar`
 * refuses it outright).
 */
export function AvatarPicker() {
  const profile = useCurrentProfile();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.myProfile(profile.id) });

  const choose = async () => {
    if (busy) return;
    setBusy(true);
    const result = await pickAndUploadAvatar(profile.id, profile.avatar_path);
    setBusy(false);

    if (result.outcome === 'denied') {
      // Not an error and not retryable in-app: once the system dialog has been
      // answered it does not reappear, so the only useful next step is Settings.
      Alert.alert(
        'Bingd cannot see your photos',
        'Allow photo access in your device settings to choose a picture.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open settings', onPress: () => void Linking.openSettings() },
        ],
      );
      return;
    }

    if (result.outcome === 'failed') {
      // `changed` is set only when `set_avatar` itself went unanswered — a failed resize
      // or a failed upload never reached it. The bytes are deliberately left in place in
      // that case (`avatar.ts`), so refetching is what tells this screen whether the
      // profile is already pointing at them. Independent review 21e's invariant.
      if (result.changed) await refresh();
      Alert.alert('Could not update your picture', result.message);
      return;
    }

    if (result.outcome === 'ok') await refresh();
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    const result = await removeAvatar(profile.avatar_path);
    setBusy(false);

    if (result.outcome === 'failed') {
      // `changed` means `set_avatar` may have cleared the pointer anyway, so the face on
      // screen may already be gone from the profile. Refetched before the alert rather
      // than instead of it (`lib/write-outcome.ts`). Independent review 21e.
      if (result.changed) await refresh();
      Alert.alert('Could not remove your picture', result.message);
      return;
    }
    await refresh();
  };

  return (
    <View style={styles.block}>
      <Text variant="subhead">Profile picture</Text>

      <View style={styles.row}>
        <Avatar
          size="lg"
          uri={profile.avatarUri}
          name={profile.display_name || profile.username}
        />
        <View style={styles.actions}>
          <Button
            label={busy ? 'Working…' : profile.avatarUri ? 'Change' : 'Choose a picture'}
            kind="secondary"
            disabled={busy}
            onPress={() => void choose()}
          />
          {profile.avatarUri ? (
            <Button label="Remove" kind="tertiary" disabled={busy} onPress={() => void remove()} />
          ) : null}
        </View>
      </View>

      <Text variant="footnote" tone="tertiary">
        Your picture is public. It appears wherever your name does.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    marginTop: theme.space[6],
    gap: theme.space[3],
    padding: theme.space[4],
    borderRadius: theme.radius.card,
    backgroundColor: theme.surface.raised,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space[4] },
  actions: { flex: 1, gap: theme.space[2], alignItems: 'flex-start' },
});
