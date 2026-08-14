import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Avatar } from './Avatar';
import { Poster } from './Poster';
import { Text } from './Text';

export type ActivityCardProps = {
  actorName: string;
  actorAvatarUri?: string | null;
  sentence: string;
  posterUri?: string | null;
  timeLabel: string;
  metadata?: string;
  onPress: () => void;
};

export function ActivityCard({
  actorName,
  actorAvatarUri,
  sentence,
  posterUri,
  timeLabel,
  metadata,
  onPress,
}: ActivityCardProps) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={styles.card}>
      <View style={styles.row}>
        <Avatar size="sm" uri={actorAvatarUri} name={actorName} />
        <View style={styles.copy}>
          <Text variant="callout">{sentence}</Text>
          {metadata ? (
            <Text variant="footnote" tone="secondary">
              {metadata}
            </Text>
          ) : null}
          <Text variant="footnote" tone="tertiary">
            {timeLabel}
          </Text>
        </View>
        <Poster uri={posterUri} title={sentence} size="xs" />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.surface.raised,
    borderColor: theme.border.hairline,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: theme.radius.card,
    marginHorizontal: theme.layout.gutter,
    padding: theme.space[3],
  },
  row: {
    flexDirection: 'row',
    gap: theme.space[3],
  },
  copy: {
    flex: 1,
    gap: 2,
  },
});
