import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { queryKeys } from '@/lib/query';
import { Button, EmptyState, SectionHeader, SkeletonRow, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { GoalBar } from './GoalBar';
import { GoalSheet } from './GoalSheet';
import { currentYear, setWatchGoal, useWatchGoals } from './use-goals';
import type { GoalCategory } from './goals';

export type GoalsSectionProps = {
  userId: string;
  /** Overridable so a test — or a later year-in-review screen — can ask about another
   *  year without this component reaching for the clock itself. */
  year?: number;
};

/**
 * "Your 2026" on the profile: the goals the user set, and how far along they are.
 *
 * The section is present whether or not a goal exists, because a goal nobody can find
 * is a goal nobody sets. What changes is what it says: with no goal it offers to take
 * one, and it does that in one line rather than with an illustrated empty state — this
 * is optional, and an apologetic block about a thing the user has chosen not to do
 * would take more of the profile than the feature is worth.
 */
export function GoalsSection({ userId, year = currentYear() }: GoalsSectionProps) {
  const queryClient = useQueryClient();
  const goals = useWatchGoals(userId, year);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async (changes: { category: GoalCategory; target: number | null }[]) => {
    if (saving) return;
    setSaving(true);

    // Sequential, not `Promise.all`. Two goals is two rows and there is no latency
    // worth winning here, while a partial failure reported as one alert is much
    // easier to reason about when the writes did not race each other.
    const failures: string[] = [];
    for (const change of changes) {
      const result = await setWatchGoal({ year, ...change });
      if (!result.ok) failures.push(result.message);
    }

    setSaving(false);

    // Refetched regardless of failure: if the first write landed and the second did
    // not, the screen must show the half that stuck rather than the draft.
    await queryClient.invalidateQueries({ queryKey: queryKeys.goals(userId, year) });

    if (failures.length) {
      Alert.alert('Could not save your goals', failures[0]);
      return;
    }
    setEditing(false);
  };

  const statuses = goals.data?.statuses ?? [];

  return (
    <View style={styles.section}>
      <SectionHeader
        title={`Your ${year}`}
        // No action while the read is in flight or has failed: "Edit" on top of an
        // unknown current value opens a sheet that would happily write an empty draft
        // over a goal the user has actually set.
        actionLabel={goals.isSuccess && statuses.length > 0 ? 'Edit' : undefined}
        onPressAction={goals.isSuccess && statuses.length > 0 ? () => setEditing(true) : undefined}
      />

      {goals.isPending ? (
        <SkeletonRow count={2} />
      ) : goals.isError ? (
        <View style={styles.body}>
          <EmptyState
            kind="couldNotLoad"
            compact
            title="Could not load your goals"
            body="Check your connection and try again."
          />
        </View>
      ) : statuses.length === 0 ? (
        <View style={[styles.body, styles.prompt]}>
          <Text variant="footnote" tone="secondary" style={styles.promptCopy}>
            Set a goal for how many films or seasons you want to watch this year.
          </Text>
          <Button label="Set a goal" kind="secondary" onPress={() => setEditing(true)} />
        </View>
      ) : (
        <View style={[styles.body, styles.bars]}>
          {statuses.map((status) => (
            <GoalBar key={status.category} status={status} />
          ))}
        </View>
      )}

      <GoalSheet
        visible={editing}
        year={year}
        targets={goals.data?.targets ?? {}}
        saving={saving}
        onSave={(changes) => void save(changes)}
        onClose={() => setEditing(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingTop: theme.space[5], gap: theme.space[2] },
  body: { paddingHorizontal: theme.layout.gutter },
  bars: { gap: theme.space[4] },
  prompt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
  },
  promptCopy: { flex: 1 },
});
