import { ScrollView, StyleSheet } from 'react-native';

import { Option, Section } from '@/features/collection/CollectionFilterSheet';
import { DismissFooter, Sheet, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import {
  LEADERBOARD_METRICS,
  LEADERBOARD_TIMEFRAMES,
  type LeaderboardMetric,
  type LeaderboardTimeframe,
} from './use-leaderboard';

export type LeaderboardFilterSheetProps = {
  metric: LeaderboardMetric;
  onChangeMetric: (next: LeaderboardMetric) => void;
  timeframe: LeaderboardTimeframe;
  onChangeTimeframe: (next: LeaderboardTimeframe) => void;
  onClose: () => void;
};

const SECTION = theme.layout.section;

/**
 * **The board's two filters, in one sheet** (header consistency, founder spec 2026-11-22).
 *
 *     Filters
 *     TYPE         [All Titles] [Movies] [TV Shows] [Reviews]
 *     TIME PERIOD  [This month] [All time]
 *     ───────────────────────────────
 *                 Close
 *
 * It replaced the two text-and-chevron dropdowns under LEADERBOARD, and it is the grammar
 * the Filmography's Filters & Sort sheet already uses: the Collection sheet's `Section` /
 * `Option` chips, applied on the press, with the quiet Close (`DismissFooter`) pinned under
 * them — nothing here waits for Apply, because neither dropdown ever did. The chips are
 * `radio`: each section has exactly one value, as each dropdown had.
 *
 * **The same values and the same handlers.** The options are `LEADERBOARD_METRICS` and
 * `LEADERBOARD_TIMEFRAMES`, unchanged, and a press goes to the same `onChangeMetric` /
 * `onChangeTimeframe` the dropdowns called; re-choosing the value already on is not a
 * change, as before. So the query, the ordering, the remembered time range and the
 * analytics are what they were.
 *
 * Sized to its content (`size="content"`): a small picker, not a browsing list. Mounted
 * only while open.
 */
export function LeaderboardFilterSheet({
  metric,
  onChangeMetric,
  timeframe,
  onChangeTimeframe,
  onClose,
}: LeaderboardFilterSheetProps) {
  return (
    <Sheet
      visible
      onClose={onClose}
      label="Leaderboard filters"
      footer={<DismissFooter onPress={onClose} testID="leaderboard-filter-close" />}
    >
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.content}
        testID="leaderboard-filter-scroll"
      >
        <Text variant="headline" accessibilityRole="header" style={styles.part}>
          Filters
        </Text>
        <Section title="Type" radio>
          {LEADERBOARD_METRICS.map((option) => (
            <Option
              key={option.value}
              kind="radio"
              label={option.label}
              selected={option.value === metric}
              onPress={() => {
                if (option.value !== metric) onChangeMetric(option.value);
              }}
              testID={`leaderboard-filter-metric-${option.value}`}
            />
          ))}
        </Section>
        <Section title="Time period" radio>
          {LEADERBOARD_TIMEFRAMES.map((option) => (
            <Option
              key={option.id}
              kind="radio"
              label={option.label}
              selected={option.id === timeframe}
              onPress={() => {
                if (option.id !== timeframe) onChangeTimeframe(option.id);
              }}
              testID={`leaderboard-filter-timeframe-${option.id}`}
            />
          ))}
        </Section>
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // Free to shrink to what the sheet's cap leaves above the footer, so at the largest text
  // sizes on a small phone every chip is still reachable by scrolling.
  body: { flexShrink: 1 },
  content: {
    paddingTop: SECTION.above,
    paddingBottom: theme.space[4],
    gap: SECTION.between,
  },
  // The heading sits a heading's distance from its first section, not a section's: the
  // content's `between` gap taken back down to `headingToControls`, as on the Collection.
  part: {
    paddingHorizontal: theme.layout.gutter,
    marginBottom: SECTION.headingToControls - SECTION.between,
  },
});
