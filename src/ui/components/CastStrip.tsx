import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Avatar } from './Avatar';
import { Text } from './Text';

export type CastMember = {
  id: string;
  name: string;
  character?: string | null;
  avatarUri?: string | null;
};

export type CastStripProps = {
  cast: CastMember[];
  /** Routes to the person page. Omit and the strip is a display, not a control. */
  onPressMember?: (member: CastMember) => void;
};

/**
 * Top-billed cast, horizontally.
 *
 * The founder rejected initials-only as the intended state, and rightly — a row of
 * lettered circles is a placeholder that looks like a decision. So the strip now
 * renders TMDB's portrait when there is one, and falls back to `Avatar`'s initials
 * when there is not, which is the same treatment a user without a photograph gets.
 *
 * The fallback is not a lesser state to be designed around. Below the top few billed
 * roles most people have no portrait at all, so a strip that only worked with imagery
 * would be half-empty for every title; both forms are the same size and shape, and a
 * row can mix them without looking broken.
 */
export function CastStrip({ cast, onPressMember }: CastStripProps) {
  if (!cast.length) return null;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {cast.map((member) => {
        const label = member.character
          ? `${member.name}, who plays ${member.character}`
          : member.name;

        const content = (
          <>
            <Avatar size="lg" uri={member.avatarUri} name={member.name} />
            <Text variant="footnote" numberOfLines={1} style={styles.center}>
              {member.name}
            </Text>
            {member.character ? (
              <Text variant="caption" tone="tertiary" numberOfLines={1} style={styles.center}>
                {member.character}
              </Text>
            ) : null}
          </>
        );

        if (!onPressMember) {
          return (
            <View key={member.id} style={styles.item}>
              {content}
            </View>
          );
        }

        return (
          <Pressable
            key={member.id}
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={() => onPressMember(member)}
            style={({ pressed }) => [styles.item, pressed && styles.pressed]}
          >
            {content}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[2],
  },
  // Wide enough for two words of a name at footnote size without wrapping into a
  // third line, which is what made the old 92pt column ragged.
  item: {
    width: 96,
    gap: theme.space[1],
    alignItems: 'center',
  },
  center: { textAlign: 'center' },
  pressed: { opacity: 0.7 },
});
