import { ScrollView, StyleSheet, View } from 'react-native';

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
};

export function CastStrip({ cast }: CastStripProps) {
  if (!cast.length) return null;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {cast.map((member) => (
        <View key={member.id} style={styles.item}>
          <Avatar size="md" uri={member.avatarUri} name={member.name} />
          <Text variant="footnote" numberOfLines={1} style={styles.center}>
            {member.name}
          </Text>
          {member.character ? (
            <Text variant="caption" tone="tertiary" numberOfLines={1} style={styles.center}>
              {member.character}
            </Text>
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
  },
  item: {
    width: 92,
    gap: theme.space[1],
    alignItems: 'center',
  },
  center: { textAlign: 'center' },
});
