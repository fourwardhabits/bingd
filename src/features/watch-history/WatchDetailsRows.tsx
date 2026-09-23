import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { CompanionPicker } from '@/features/collection/CompanionPicker';
import { formatWatchDate, today } from '@/features/collection/dates';
import { NoteInput } from '@/features/collection/LogSheet';
import { taggableWith, type Person } from '@/features/collection/use-companions';
import { WatchDatePicker } from '@/features/collection/WatchDatePicker';
import { SheetRow, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/** The same ceiling `set_watch_details` enforces through `watch_tags.max_per_watch`. */
const MAX_COMPANIONS = 10;

export type WatchDetailsRowsProps = {
  /** `YYYY-MM-DD`, or null for *Earlier* — seen, at a time nobody recorded. */
  date: string | null;
  onDate: (iso: string | null) => void;
  /** The reader's mutual follows, plus anybody already on this watch. */
  people: Person[];
  peopleLoading?: boolean;
  companionIds: string[];
  onToggleCompanion: (id: string) => void;
  note: string;
  onNote: (next: string) => void;
};

type Open = 'who' | 'note' | 'date' | null;

/**
 * A watch's own details — **Who I watched with, Note, Watch date** — in the log sheet's own
 * rows (founder QA, 2026-09-21: "reuse the ranking/log detail components rather than
 * creating parallel flows"; design-system.md §11b).
 *
 * The same `SheetRow`s, the same `CompanionPicker`, the same note field (`NoteInput`, the
 * log sheet's own) and the same `WatchDatePicker`, in the same order and **all closed by
 * default**, with the same `Add` values. Used by the rewatch sheet and by editing a watch in
 * Watch History, so the two cannot drift from the ordinary log.
 *
 * **No spoiler or Share-as-review chips here, deliberately.** A watch's note is a private
 * diary line (20261014000100: owner-only, never on any public surface). The public review
 * is the title's one note, written in the ordinary log sheet, and a second door into it from
 * a watch would be two places to publish one piece of writing.
 */
export function WatchDetailsRows({
  date,
  onDate,
  people,
  peopleLoading = false,
  companionIds,
  onToggleCompanion,
  note,
  onNote,
}: WatchDetailsRowsProps) {
  const [open, setOpen] = useState<Open>(null);
  const toggle = (row: Exclude<Open, null>) => setOpen((was) => (was === row ? null : row));

  const selected = taggableWith(people, []).filter((person) => companionIds.includes(person.id));
  const companionValue = companionIds.length
    ? companionIds.length === 1
      ? (selected[0]?.name ?? '1 person')
      : `${companionIds.length} people`
    : 'Add';
  const written = note.trim();
  const noteValue = written ? `${written.split(/\s+/).length} words` : 'Add';

  return (
    <View style={styles.rows}>
      <SheetRow
        icon="people-outline"
        label="Who I watched with"
        value={companionValue}
        expanded={open === 'who'}
        onPress={() => toggle('who')}
      />
      {open === 'who' ? (
        <View style={styles.expanded}>
          <CompanionPicker
            people={people}
            selected={companionIds}
            onToggle={onToggleCompanion}
            max={MAX_COMPANIONS}
            loading={peopleLoading}
          />
        </View>
      ) : null}

      <SheetRow
        icon="create-outline"
        label="Note"
        value={noteValue}
        expanded={open === 'note'}
        onPress={() => toggle('note')}
      />
      {open === 'note' ? (
        <View style={[styles.expanded, styles.noteBox]}>
          <NoteInput value={note} label="Note" onChangeText={onNote} onBlur={() => {}} />
          <Text variant="caption" tone="tertiary">
            Only you can see notes on a watch.
          </Text>
        </View>
      ) : null}

      <SheetRow
        icon="calendar-outline"
        label="Watch date"
        // *Earlier*, the same word as the choice that produces it (T0b).
        value={date === null ? 'Earlier' : formatWatchDate(date)}
        expanded={open === 'date'}
        onPress={() => toggle('date')}
      />
      {open === 'date' ? (
        <View style={styles.expanded}>
          <WatchDatePicker
            value={date}
            anchor={date ?? today()}
            onChange={(iso) => onDate(iso)}
            onClear={() => onDate(null)}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // The log sheet's own rule above its rows.
  rows: {
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: theme.border.hairline,
    paddingTop: theme.space[2],
  },
  expanded: { paddingBottom: theme.space[2] },
  noteBox: { paddingHorizontal: theme.layout.gutter, gap: theme.space[2] },
});
