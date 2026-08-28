import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Avatar, Sheet, SkeletonRow, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { REACTIONS, type ReactionKind, type ReactionSummary } from './use-reactions';

export type ReactionDetailProps = {
  summary: ReactionSummary | null;
  /**
   * True while a summary is still on its way. The feed never needs this — its
   * summaries are already in hand when the sheet opens — but a comment's reactor
   * list is fetched on open (`use-comment-reactors`), and a sheet that only appears
   * once the network answers is a tap with no acknowledgement.
   */
  loading?: boolean;
  onClose: () => void;
  onPressPerson: (username: string) => void;
};

/**
 * Who reacted, and with what.
 *
 * The Feed row shows glyphs and a total; this is where the total becomes people.
 * Founder decision, 2026-08-16: everyone the viewer is authorised to see is named —
 * no friend-only masking. That is a display decision only, and it rests on the read
 * having been authorised already: `reactions_read` requires visibility of both the
 * reactor and the event's actor, so a blocked reactor never reaches this component.
 * Nothing here filters, and nothing here should start to.
 *
 * Tapping a person opens their profile, which applies its own access rules. Appearing
 * in this list is not a key to a profile — a private account the viewer does not
 * follow still resolves to the same access-safe page it always did.
 */
export function ReactionDetail({ summary, loading, onClose, onPressPerson }: ReactionDetailProps) {
  const [filter, setFilter] = useState<ReactionKind | null>(null);

  if (!summary) {
    if (!loading) return null;
    return (
      <Sheet visible onClose={onClose} label="Reactions">
        <View style={styles.loading}>
          <SkeletonRow count={2} />
        </View>
      </Sheet>
    );
  }

  const present = REACTIONS.filter((reaction) => (summary.byKind[reaction.kind] ?? 0) > 0);
  // A filter whose reaction nobody used would be a tab onto an empty list, so the
  // chips are built from what is actually there.
  const people = filter ? summary.people.filter((person) => person.kind === filter) : summary.people;

  return (
    <Sheet visible onClose={onClose} label="Reactions">
      <View style={styles.filters}>
        <FilterChip
          label="All"
          count={summary.total}
          selected={filter === null}
          onPress={() => setFilter(null)}
        />
        {present.map((reaction) => (
          <FilterChip
            key={reaction.kind}
            glyph={reaction.glyph}
            label={reaction.label}
            count={summary.byKind[reaction.kind] ?? 0}
            selected={filter === reaction.kind}
            onPress={() => setFilter(reaction.kind)}
          />
        ))}
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {people.map((person) => (
          <Pressable
            key={`${person.userId}-${person.kind}`}
            accessibilityRole="button"
            accessibilityLabel={`${person.name}, reacted ${labelOf(person.kind)}. Open their profile.`}
            onPress={() => onPressPerson(person.username)}
            style={({ pressed }) => [styles.person, pressed && styles.pressed]}
          >
            <Avatar size="sm" uri={person.avatarUri} name={person.name} />
            <View style={styles.personCopy}>
              <Text variant="callout" numberOfLines={1}>
                {person.name}
              </Text>
              <Text variant="caption" tone="tertiary" numberOfLines={1}>
                @{person.username}
              </Text>
            </View>
            <Text variant="title2" allowFontScaling={false} accessibilityElementsHidden>
              {glyphOf(person.kind)}
            </Text>
          </Pressable>
        ))}

        {/* Counted but not nameable: the reaction row was readable and the profile
            embed was not. Saying so is better than a list that silently disagrees
            with the total above it. */}
        {summary.total > summary.people.length && filter === null ? (
          <Text variant="footnote" tone="tertiary" style={styles.residual}>
            {summary.total - summary.people.length} more not shown
          </Text>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

function FilterChip({
  glyph,
  label,
  count,
  selected,
  onPress,
}: {
  glyph?: string;
  label: string;
  count: number;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={`${label}, ${count}`}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}
    >
      {glyph ? (
        <Text variant="callout" allowFontScaling={false} accessibilityElementsHidden>
          {glyph}
        </Text>
      ) : (
        <Text variant="footnote" tone={selected ? 'primary' : 'secondary'}>
          {label}
        </Text>
      )}
      <Text variant="footnote" tone={selected ? 'primary' : 'secondary'}>
        {count}
      </Text>
    </Pressable>
  );
}

const glyphOf = (kind: ReactionKind) =>
  REACTIONS.find((reaction) => reaction.kind === kind)?.glyph ?? '';
const labelOf = (kind: ReactionKind) =>
  REACTIONS.find((reaction) => reaction.kind === kind)?.label ?? kind;

const styles = StyleSheet.create({
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[3],
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[1],
    minHeight: theme.layout.control.chipHeight,
    paddingHorizontal: theme.space[3],
    borderRadius: theme.radius.full,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.raised,
  },
  chipSelected: { backgroundColor: theme.surface.sunken, borderColor: theme.semantic.action },
  list: { maxHeight: 360 },
  listContent: { paddingBottom: theme.space[4] },
  person: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    minHeight: theme.layout.rowMinHeight,
    paddingHorizontal: theme.layout.gutter,
  },
  personCopy: { flex: 1, gap: 2 },
  residual: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
  loading: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[3] },
  pressed: { opacity: 0.7 },
});
