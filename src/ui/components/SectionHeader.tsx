import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type SectionHeaderProps = {
  title: string;
  actionLabel?: string;
  onPressAction?: () => void;
};

export function SectionHeader({ title, actionLabel, onPressAction }: SectionHeaderProps) {
  return (
    <View style={styles.row}>
      <Text variant="caption" tone="tertiary">
        {title.toUpperCase()}
      </Text>
      {actionLabel && onPressAction ? (
        <Pressable accessibilityRole="button" onPress={onPressAction}>
          <Text variant="footnote" tone="action">
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: theme.layout.minTapTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.layout.gutter,
  },
});
