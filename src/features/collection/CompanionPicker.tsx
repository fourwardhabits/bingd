import { Ionicons } from '@expo/vector-icons';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Avatar, EmptyState, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import type { Person } from './use-companions';

export type CompanionPickerProps = {
  people: Person[];
  selected: string[];
  onToggle: (id: string) => void;
  max: number;
  loading?: boolean;
};

/**
 * Who I watched with, as a list of the people who can actually be tagged.
 *
 * Not a search field. PRD §14 limits tagging to people the user follows or who follow
 * them, which for the launch cohort is a list you can see the whole of — searching a
 * set of twelve is worse than reading it. When that stops being true this gains a
 * filter, and the shape does not have to change.
 *
 * There is no invite affordance here. PRD §14 hands untaggable people to the
 * invitation flow, and that flow is not in this tranche; a control that leads nowhere
 * is worse than its absence.
 */
export function CompanionPicker({
  people,
  selected,
  onToggle,
  max,
  loading = false,
}: CompanionPickerProps) {
  const full = selected.length >= max;

  if (loading) {
    return (
      <Text variant="footnote" tone="tertiary" style={styles.status}>
        Finding your people…
      </Text>
    );
  }

  if (!people.length) {
    return (
      <View style={styles.status}>
        <EmptyState
          kind="nothingYet"
          compact
          title="Nobody to tag yet"
          body="Follow someone, or have them follow you, and they will show up here."
        />
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <ScrollView
        style={styles.list}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {people.map((person) => {
          const isSelected = selected.includes(person.id);
          // A full list disables the unchosen rather than hiding them, so the
          // reason the tap did nothing is visible rather than inferred.
          const disabled = full && !isSelected;

          return (
            <Pressable
              key={person.id}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: isSelected, disabled }}
              accessibilityLabel={person.name}
              accessibilityHint={disabled ? `You can tag up to ${max} people` : undefined}
              onPress={() => onToggle(person.id)}
              disabled={disabled}
              style={({ pressed }) => [
                styles.row,
                (pressed || disabled) && styles.dim,
              ]}
            >
              <Avatar size="sm" uri={person.avatarUri} name={person.name} />
              <View style={styles.copy}>
                <Text variant="callout" numberOfLines={1}>
                  {person.name}
                </Text>
                <Text variant="caption" tone="tertiary" numberOfLines={1}>
                  @{person.username}
                </Text>
              </View>
              <Ionicons
                name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                size={theme.layout.icon.md}
                color={isSelected ? theme.semantic.action : theme.border.strong}
              />
            </Pressable>
          );
        })}
      </ScrollView>

      {full ? (
        <Text variant="caption" tone="tertiary">
          That is the most you can tag on one watch.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: theme.layout.gutter, gap: theme.space[1] },
  // Bounded, so a long follow list does not turn the log sheet into a page. The
  // sheet's own scroll still works; this one takes over inside the section.
  list: { maxHeight: 220 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.rowMinHeight,
  },
  copy: { flex: 1, gap: 2 },
  status: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[2] },
  dim: { opacity: 0.5 },
});
