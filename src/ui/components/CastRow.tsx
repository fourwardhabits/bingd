import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { fontFamily, theme } from '../tokens';
import { Avatar } from './Avatar';
import { Text } from './Text';

export type CastRowProps = {
  name: string;
  /** TMDB's portrait, already a URL, or null for the initial. */
  portraitUri?: string | null;
  /** Up to three titles they are known for. Empty draws no second line. */
  knownFor: string[];
  onPress: () => void;
};

/**
 * A performer, in Cast search results.
 *
 * Built on `UserRow`'s silhouette — a round portrait leads, so a person is never
 * mistaken for a title at a glance — with the one difference that matters: the second
 * line is **what they are known for**, not an @handle. A cast member is not a Bingd
 * account and has no handle, and "Titanic · Inception" is what tells two people who
 * share a name apart before either is opened.
 */
export function CastRow({ name, portraitUri, knownFor, onPress }: CastRowProps) {
  const context = knownFor.join(' · ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={context ? `${name}, known for ${knownFor.join(', ')}` : name}
      accessibilityHint="Opens their filmography"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Avatar size="sm" uri={portraitUri} name={name} />

      <View style={styles.copy}>
        <Text variant="callout" numberOfLines={1} style={styles.name}>
          {name}
        </Text>
        {context ? (
          <Text variant="caption" tone="tertiary" numberOfLines={1}>
            {context}
          </Text>
        ) : null}
      </View>

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
