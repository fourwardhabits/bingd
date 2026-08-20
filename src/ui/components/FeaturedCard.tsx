import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Backdrop } from './Backdrop';
import { Text } from './Text';

export type FeaturedCardProps = {
  title: string;
  subtitle?: string;
  backdropUri?: string | null;
  onPress: () => void;
};

export function FeaturedCard({ title, subtitle, backdropUri, onPress }: FeaturedCardProps) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.card}>
      {backdropUri ? <Backdrop uri={backdropUri} scrim /> : null}
      <View style={styles.copy}>
        <Text variant="headline">{title}</Text>
        {subtitle ? (
          <Text variant="footnote" tone="secondary">
            {subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 260,
    gap: theme.space[2],
  },
  copy: {
    borderRadius: theme.radius.card,
    borderColor: theme.border.hairline,
    borderWidth: StyleSheet.hairlineWidth * 2,
    backgroundColor: theme.surface.raised,
    padding: theme.space[3],
    gap: theme.space[1],
  },
});
