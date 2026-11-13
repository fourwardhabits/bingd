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
        'bingd cannot see your photos',
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

      <Avatar size="lg" uri={profile.avatarUri} name={profile.display_name || profile.username} />

      {/**
       * **The app's ordinary action row** (founder QA, 2026-11-12), where this used to be
       * two controls stacked beside the picture in two different styles. The same `Button`
       * kinds and order as every other pair — Filters & Sort's *Clear all · Apply*, the goal
       * sheet's *Cancel · Save*: the secondary act on the left, the Maroon one on the right.
       * Under the picture rather than beside it, so the pair fits side by side at 320pt;
       * it wraps, like Filters & Sort's, at the largest text sizes.
       */}
      <View style={styles.actions} testID="avatar-actions">
        {profile.avatarUri ? (
          <Button
            label="Remove"
            kind="secondary"
            size="sm"
            hitSlop={COMPACT_SLOP}
            disabled={busy}
            disabledReason="Updating your picture."
            onPress={() => void remove()}
          />
        ) : null}
        <Button
          label={busy ? 'Working…' : profile.avatarUri ? 'Change' : 'Choose a picture'}
          size="sm"
          hitSlop={COMPACT_SLOP}
          disabled={busy}
          disabledReason="Updating your picture."
          onPress={() => void choose()}
        />
      </View>

      <Text variant="footnote" tone="tertiary">
        Your picture is public. It appears wherever your name does.
      </Text>
    </View>
  );
}

/**
 * **Less bulky, same target** (founder spec §7, 2026-11-13). The pair is drawn at
 * `Button`'s small size — 36pt, the slimmer Rank button's height — and this slop gives the
 * 8pt back, so each is still a 44pt target. Same kinds, same order, same words: only
 * their size changed.
 */
const COMPACT_SLOP = {
  top: (theme.layout.minTapTarget - theme.layout.control.compactAction.visibleHeight) / 2,
  bottom: (theme.layout.minTapTarget - theme.layout.control.compactAction.visibleHeight) / 2,
} as const;

const styles = StyleSheet.create({
  block: {
    marginTop: theme.space[6],
    gap: theme.space[3],
    padding: theme.space[4],
    borderRadius: theme.radius.card,
    backgroundColor: theme.surface.raised,
  },
  // The vertical padding holds the slop *inside* the row's box: Android delivers no touch
  // outside a parent's bounds, so slop that overhung the row would be decoration.
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space[2],
    paddingVertical: COMPACT_SLOP.top,
  },
});
