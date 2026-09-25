import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { CompanionPicker } from '@/features/collection/CompanionPicker';
import { formatWatchDate, today } from '@/features/collection/dates';
import { NoteClaims, NoteInput } from '@/features/collection/NoteComposer';
import type { TitleNote } from '@/features/collection/use-title-note';
import { taggableWith, type Person } from '@/features/collection/use-companions';
import { WatchDatePicker } from '@/features/collection/WatchDatePicker';
import { SheetRow } from '@/ui/components';
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
  /**
   * The title's one note, from `useTitleNote`. The caller owns it because the caller owns
   * the commit: it must `flush()` when the reader presses Save or picks a bucket.
   */
  titleNote: TitleNote;
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
 * **The Note row edits the title's one note, with its two claims** (founder decision,
 * 2026-09-25). It used to edit `watch_events.note` — a private diary line, owner-only by
 * schema — which is why "Contains spoilers" and "Share as a review" had nowhere to go here
 * and the two rewatch surfaces read as a downgrade from the ordinary log sheet.
 *
 * There is still exactly one note per title and exactly one place it is published from; what
 * changed is that this is now one of the doors into it rather than a door into something
 * else that looked the same. The field and the chips are `NoteComposer`'s, so the three
 * entry points cannot drift again. `watch_events.note` is untouched and stays owner-only:
 * nothing writes it, and no existing row was rewritten (production held none).
 */
export function WatchDetailsRows({
  date,
  onDate,
  people,
  peopleLoading = false,
  companionIds,
  onToggleCompanion,
  titleNote,
}: WatchDetailsRowsProps) {
  const [open, setOpen] = useState<Open>(null);
  const toggle = (row: Exclude<Open, null>) => setOpen((was) => (was === row ? null : row));

  const selected = taggableWith(people, []).filter((person) => companionIds.includes(person.id));
  const companionValue = companionIds.length
    ? companionIds.length === 1
      ? (selected[0]?.name ?? '1 person')
      : `${companionIds.length} people`
    : 'Add';
  const written = titleNote.note.trim();
  const words = written ? written.split(/\s+/).length : 0;
  const noteValue = !titleNote.loaded
    ? undefined
    : words
      ? titleNote.visibility === 'public'
        ? `Shared · ${words} words`
        : `${words} words`
      : 'Add';

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
          <NoteInput
            value={titleNote.note}
            label="Note"
            onChangeText={titleNote.onChangeText}
            onBlur={() => void titleNote.flush()}
          />
          <NoteClaims
            visibility={titleNote.visibility}
            spoilers={titleNote.spoilers}
            onVisibility={titleNote.onVisibility}
            onSpoilers={titleNote.onSpoilers}
          />
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
