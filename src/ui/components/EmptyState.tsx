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

/**
 * **Balanced line breaks for the error state** (founder QA, 2026-11-12: *Check your
 * connection and try* / *again.*). Centred copy that leaves one word on its last line reads
 * as a mistake. Both are the platforms' own Text props, so no dependency and no copy change:
 * Android balances the lines (`textBreakStrategy`), and iOS pushes a word down rather than
 * leave an orphan (`lineBreakStrategyIOS`). Each platform ignores the other's prop. Only
 * `couldNotLoad`, which is the error state; the two empty states are unchanged.
 */
const BALANCED_LINES = {
  textBreakStrategy: 'balanced',
  lineBreakStrategyIOS: 'push-out',
} as const;

export function EmptyState({ kind, title, body, action, compact = false }: EmptyStateProps) {
  const lines = kind === 'couldNotLoad' ? BALANCED_LINES : undefined;
  return (
    <View style={[styles.container, compact && styles.compact]} accessibilityRole="summary">
      <Text variant={compact ? 'callout' : 'title2'} style={styles.centered} {...lines}>
        {title}
      </Text>
      <Text
        variant={compact ? 'footnote' : 'body'}
        tone="secondary"
        style={styles.centered}
        {...lines}
      >
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
