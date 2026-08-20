import { StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Button } from './Button';
import { Text } from './Text';

/**
 * Every list surface needs all three of these, and collapsing them into one is
 * a frequent mistake — they read differently and offer different actions
 * (design-system.md §8).
 */
export type EmptyStateKind = 'nothingYet' | 'nothingMatches' | 'couldNotLoad';

export type EmptyStateProps = {
  kind: EmptyStateKind;
  title: string;
  /** Written in the Curious Collector voice: "Nothing here yet", not "No results found." */
  body: string;
  action?: { label: string; onPress: () => void };
  compact?: boolean;
};

export function EmptyState({ kind, title, body, action, compact = false }: EmptyStateProps) {
  return (
    <View style={[styles.container, compact && styles.compact]} accessibilityRole="summary">
      <Text variant={compact ? 'callout' : 'title2'} style={styles.centered}>
        {title}
      </Text>
      <Text variant={compact ? 'footnote' : 'body'} tone="secondary" style={styles.centered}>
        {body}
      </Text>
      {action ? (
        <Button
          label={action.label}
          kind={kind === 'couldNotLoad' ? 'secondary' : 'primary'}
          onPress={action.onPress}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[4],
    padding: theme.space[8],
  },
  compact: {
    gap: theme.space[2],
    paddingVertical: theme.space[4],
    paddingHorizontal: theme.layout.gutter,
  },
  centered: { textAlign: 'center' },
});
