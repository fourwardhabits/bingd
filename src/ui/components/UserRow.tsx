import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { fontFamily, theme } from '../tokens';
import { Avatar } from './Avatar';
import { Text } from './Text';

export type UserRowProps = {
  name: string;
  username: string;
  avatarUri?: string | null;
  /**
   * "Following", "Requested", "Follows you" — or nothing.
   *
   * A label and never a control. Tapping a row opens the profile, and the follow
   * action lives there: a Follow button inside a search result is one mis-tap away
   * from a relationship the user did not mean to start, and the person on the other
   * end is notified either way.
   */
  relationship?: string | null;
  onPress: () => void;
};

/**
 * A person, in a list of results.
 *
 * Deliberately a different shape from `TitleRow`, and that is the founder's rule
 * rather than a preference: "never intermix profile rows into the title ranking". A
 * title row leads with a poster — a portrait rectangle — and this leads with a round
 * avatar, so the two are distinguishable at a glance from the silhouette alone, before
 * any text is read. Anything that made them converge would be a regression.
 */
export function UserRow({ name, username, avatarUri, relationship, onPress }: UserRowProps) {
  return (
    <Pressable
      accessibilityRole="button"
      // The handle is in the label because two people can share a display name, and
      // the handle is the thing that identifies which one this is.
      accessibilityLabel={[name, `@${username}`, relationship].filter(Boolean).join(', ')}
      accessibilityHint="Opens their profile"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Avatar size="sm" uri={avatarUri} name={name} />

      <View style={styles.copy}>
        <Text variant="callout" numberOfLines={1} style={styles.name}>
          {name}
        </Text>
        <Text variant="caption" tone="tertiary" numberOfLines={1}>
          @{username}
        </Text>
      </View>

      {relationship ? (
        <Text variant="caption" tone="secondary" numberOfLines={1}>
          {relationship}
        </Text>
      ) : null}

      <Ionicons
        name="chevron-forward"
        size={theme.layout.icon.sm}
        color={theme.text.tertiary}
        accessibilityElementsHidden
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.rowMinHeight,
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[2],
  },
  copy: { flex: 1, gap: 2 },
  name: { fontFamily: fontFamily.sansSemibold },
  pressed: { opacity: 0.7 },
});
