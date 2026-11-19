import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';

import { Avatar, EmptyState, SearchField, Text } from '@/ui/components';
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
 * **Who I watched with**: the people who can be tagged, searchable, with the chosen ones
 * always in view (founder QA, 2026-11-19).
 *
 * It replaces a 220pt inline list with no search and a hidden scroll indicator, which
 * stopped working once a reader had more mutuals than fit in it. Still drawn inside the
 * row it belongs to, in all three places that use it — Log, Log another watch and Edit
 * watch — because presenting a second sheet over the log sheet is the iOS hand-over that
 * froze onboarding (`Sheet.onDismissed`). What changed is everything inside the row:
 *
 *   · **Search** on display name and username, case- and accent-insensitive, with a
 *     leading `@` ignored, so `@raj`, `raj` and `Raj` all find Raj.
 *   · **The chosen people as chips above the list**, each one tap to remove, so a
 *     selection is visible however the list is filtered or scrolled.
 *   · **A taller list with its scroll bar showing**: up to about half the screen, so a
 *     long list reads as scrollable rather than as everyone there is.
 *   · **A fresh list on every open.** The mutuals are cached for five minutes, and a
 *     follow-back made on another phone moves none of this phone's caches. Opening the
 *     picker asks again, which is the one moment the answer is about to be used.
 *
 * Unchanged: the ten-person cap (the unchosen are disabled, not hidden, so the reason a
 * tap did nothing is visible), who is offered (mutual follows plus whoever is already on
 * this watch, `taggableWith`), and saving, which each caller still owns.
 */
export function CompanionPicker({
  people,
  selected,
  onToggle,
  max,
  loading = false,
}: CompanionPickerProps) {
  const queryClient = useQueryClient();
  const { height } = useWindowDimensions();
  const [query, setQuery] = useState('');

  // On open, not on every render: the picker mounts when its row expands.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ['taggable'] });
  }, [queryClient]);

  const full = selected.length >= max;
  const byId = new Map(people.map((person) => [person.id, person]));
  const chosen = selected
    .map((id) => byId.get(id))
    .filter((person): person is Person => Boolean(person));
  const needle = normalise(query.replace(/^@/, ''));
  const shown = needle
    ? people.filter(
        (person) => normalise(person.name).includes(needle) || normalise(person.username).includes(needle),
      )
    : people;
  const listHeight = Math.max(MIN_LIST, Math.min(MAX_LIST, Math.round(height * LIST_SHARE)));

  if (loading && !people.length) {
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
          body="People who follow you back show up here."
        />
      </View>
    );
  }

  return (
    <View style={styles.wrap} testID="companion-picker">
      <View style={styles.summary}>
        <Text variant="footnote" tone="secondary" testID="companion-count">
          {selected.length ? `${selected.length} of ${max} selected` : `Tag up to ${max} people`}
        </Text>
      </View>

      {chosen.length ? (
        <View style={styles.chips} testID="companion-chips">
          {chosen.map((person) => (
            <Pressable
              key={person.id}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${person.name}`}
              onPress={() => onToggle(person.id)}
              hitSlop={theme.space[1]}
              style={({ pressed }) => [styles.chip, pressed && styles.dim]}
            >
              <Avatar size="xs" uri={person.avatarUri} name={person.name} />
              <Text variant="footnote" numberOfLines={1} style={styles.chipName}>
                {person.name}
              </Text>
              <Ionicons name="close" size={theme.layout.icon.sm} color={theme.text.secondary} />
            </Pressable>
          ))}
        </View>
      ) : null}

      <SearchField
        value={query}
        onChangeText={setQuery}
        onClear={() => setQuery('')}
        placeholder="Search your people"
        accessibilityLabel="Search people to tag"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        testID="companion-search"
      />

      <ScrollView
        style={{ maxHeight: listHeight }}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
        persistentScrollbar
        testID="companion-list"
      >
        {shown.length ? (
          shown.map((person) => {
            const isSelected = selected.includes(person.id);
            // A full list disables the unchosen rather than hiding them, so the reason
            // the tap did nothing is visible rather than inferred.
            const disabled = full && !isSelected;

            return (
              <Pressable
                key={person.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: isSelected, disabled }}
                accessibilityLabel={person.name}
                accessibilityHint={disabled ? `You can tag up to ${max} people` : `@${person.username}`}
                onPress={() => onToggle(person.id)}
                disabled={disabled}
                style={({ pressed }) => [styles.row, (pressed || disabled) && styles.dim]}
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
          })
        ) : (
          <Text variant="footnote" tone="tertiary" style={styles.noMatch} testID="companion-no-match">
            Nobody you can tag matches “{query.trim()}”.
          </Text>
        )}
      </ScrollView>

      {full ? (
        <Text variant="caption" tone="tertiary">
          That is the most you can tag on one watch.
        </Text>
      ) : null}
    </View>
  );
}

/** Lower case, accents removed, so `zoe` finds Zoë and `JOSE` finds José. */
export const normalise = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

/** The list's height: about half the screen, never under five rows or over nine. */
const LIST_SHARE = 0.45;
const MIN_LIST = 240;
const MAX_LIST = 440;

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: theme.layout.gutter, gap: theme.space[2] },
  summary: { flexDirection: 'row', alignItems: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[1],
    maxWidth: '100%',
    minHeight: 32,
    paddingLeft: theme.space[1],
    paddingRight: theme.space[2],
    borderRadius: theme.radius.full,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.semantic.action,
    backgroundColor: theme.surface.sunken,
  },
  chipName: { flexShrink: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.rowMinHeight,
  },
  copy: { flex: 1, gap: 2 },
  status: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[2] },
  noMatch: { paddingVertical: theme.space[3] },
  dim: { opacity: 0.5 },
});
