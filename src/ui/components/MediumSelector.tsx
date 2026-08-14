import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type Medium = 'movies' | 'tv_seasons';

export type MediumSelectorProps = {
  value: Medium;
  onPress: () => void;
};

export function MediumSelector({ value, onPress }: MediumSelectorProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Switch between movies and TV seasons"
      onPress={onPress}
      style={styles.button}
    >
      <View style={styles.row}>
        <Text variant="title2">{value === 'movies' ? 'Movies' : 'TV seasons'}</Text>
        <Ionicons name="swap-horizontal" size={theme.layout.icon.sm} color={theme.text.secondary} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: theme.layout.minTapTarget,
    paddingHorizontal: theme.layout.gutter,
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
  },
});
