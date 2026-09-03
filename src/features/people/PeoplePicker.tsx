import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Avatar, SearchField, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * A person as the picker draws them. `Recipient` from `use-recommend` satisfies this
 * shape; the picker declares its own so that `features/people` does not import from
 * `features/recommendations` — the dependency runs the other way.
 */
export type PickerPerson = {
  id: string;
  username: string;
  name: string;
  avatarUri: string | null;
};

export type PeoplePickerProps = {
  people: readonly PickerPerson[];
  selected: ReadonlySet<string>;
  onToggle: (personId: string) => void;
  /** Renders every row inert — the sheet is mid-act and a tap must not move the set. */
  disabled?: boolean;
  /**
   * A row pinned above the list: always checked, never removable. Group Picks pins the
   * reader themselves, because a group they are not part of is not their group. Absent
   * for RecommendSheet, where the sender is the one person who cannot be a recipient.
   */
  pinned?: { name: string; avatarUri?: string | null };
  /**
   * The most people the whole selection may hold, counting the pinned row. At the cap
   * the unselected rows disable rather than disappear: a row that vanishes reads as a
   * bug, a row that is visibly full reads as a rule.
   */
  max?: number;
  searchPlaceholder: string;
  /** Bounded, so a long list of friends does not turn the sheet into a page. */
  listMaxHeight?: number;
};

/**
 * Above this many people the search field appears. Zero, after the physical
 * pass: even a short list is faster to type into than to scan, and a field
 * that appears only past a hidden threshold reads as a missing feature on the
 * device where the list happens to be short.
 */
const SEARCH_THRESHOLD = 0;

/**
 * A simple contains match over name and handle, for a list that has outgrown reading.
 *
 * Over the caller's own people and never over the directory. Searching everybody and
 * filtering the results on the client would make the picker a people-search that
 * happens to refuse most of what it finds, and would put accounts the person has no
 * relationship with in front of them. §16 of the tranche brief, and the server agrees:
 * `_may_recommend_to` tests the same edge the recommend picker's list is built from.
 */
export function filterPeople<T extends PickerPerson>(people: T[], query: string): T[] {
  // A leading @ is the handle sigil, not part of the handle — "@ben" must find ben,
  // exactly as Search's placeholder teaches people to type it.
  const needle = query.trim().toLowerCase().replace(/^@/, '');
  if (!needle) return people;
  return people.filter(
    (person) =>
      person.name.toLowerCase().includes(needle) ||
      person.username.toLowerCase().includes(needle),
  );
}

/**
 * The people picker: a search field over a scrolling list of checkbox rows.
 *
 * Extracted from `RecommendSheet` on 2026-09-03 so Group Picks could reuse it rather
 * than clone it. A move, not a redesign: the rows, the search rule, the empty-filter
 * copy and the accessibility contract are exactly what the recommend sheet shipped
 * with. What is new is optional and off by default — a pinned self row and a cap —
 * so RecommendSheet's behaviour is unchanged by construction.
 */
export function PeoplePicker({
  people,
  selected,
  onToggle,
  disabled = false,
  pinned,
  max,
  searchPlaceholder,
  listMaxHeight = 300,
}: PeoplePickerProps) {
  const [query, setQuery] = useState('');
  const shown = filterPeople([...people], query);

  // The pinned row spends one of the seats, which is what "a group of six" means.
  const full = max != null && selected.size + (pinned ? 1 : 0) >= max;

  return (
    <>
      {people.length > SEARCH_THRESHOLD ? (
        <View style={styles.search}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            onClear={() => setQuery('')}
            placeholder={searchPlaceholder}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
        </View>
      ) : null}

      {pinned ? (
        // Checked and inert, in the same shape as every row below it, so the reader's
        // own seat reads as part of the list rather than as a heading about it.
        <View
          accessibilityRole="checkbox"
          accessibilityState={{ checked: true, disabled: true }}
          accessibilityLabel={pinned.name}
          style={[styles.row, styles.pinned]}
        >
          <Avatar size="sm" uri={pinned.avatarUri ?? null} name={pinned.name} />
          <View style={styles.copy}>
            <Text variant="callout" numberOfLines={1}>
              {pinned.name}
            </Text>
          </View>
          <Ionicons name="checkbox" size={theme.layout.icon.md} color={theme.text.tertiary} />
        </View>
      ) : null}

      <ScrollView
        style={{ maxHeight: listMaxHeight }}
        contentContainerStyle={styles.listContent}
      >
        {shown.length === 0 ? (
          <Text variant="footnote" tone="tertiary" style={styles.status}>
            Nobody by that name.
          </Text>
        ) : (
          shown.map((person) => {
            const checked = selected.has(person.id);
            // At the cap only the unselected rows freeze: the chosen ones must stay
            // tappable or there would be no way to swap somebody out.
            const rowDisabled = disabled || (full && !checked);
            return (
              // The whole row is the checkbox — one target, not a row plus a
              // control that happen to agree. The glyph sits at the far right,
              // exactly where the per-row paper-plane used to: the same reach
              // now marks a person instead of firing a send.
              <Pressable
                key={person.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked, disabled: rowDisabled }}
                accessibilityLabel={`${person.name}, @${person.username}`}
                disabled={rowDisabled}
                onPress={() => onToggle(person.id)}
                style={({ pressed }) => [
                  styles.row,
                  pressed && styles.pressed,
                  full && !checked && styles.unavailable,
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
                  name={checked ? 'checkbox' : 'square-outline'}
                  size={theme.layout.icon.md}
                  color={checked ? theme.semantic.action : theme.text.secondary}
                />
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  listContent: { paddingHorizontal: theme.layout.gutter },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.rowMinHeight,
  },
  pinned: { paddingHorizontal: theme.layout.gutter },
  copy: { flex: 1, gap: 2 },
  pressed: { opacity: 0.6 },
  unavailable: { opacity: 0.4 },
  status: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[2] },
});
