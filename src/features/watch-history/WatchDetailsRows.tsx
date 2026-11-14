import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { CompanionPicker } from '@/features/collection/CompanionPicker';
import { formatWatchDate, today } from '@/features/collection/dates';
import { NoteClaims, NoteInput } from '@/features/collection/NoteComposer';
import type { TitleNote } from '@/features/collection/use-title-note';
import { taggableWith, type Person } from '@/features/collection/use-companions';
import { WatchDatePicker } from '@/features/collection/WatchDatePicker';
import { SheetRow, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { clampWatchNote, watchNoteLength } from './watch-history';

/** The same ceiling `set_watch_details` enforces through `watch_tags.max_per_watch`. */
const MAX_COMPANIONS = 10;

/** How close to a watch note's limit the count appears: the last tenth of 1,000. */
const NEAR_LIMIT = 100;

/**
 * Which note the Note row edits — two different objects, never one through the other.
 *
 *   title  The title's one note, the review (`user_media.note` via `save_note`), with its
 *          two claims, Share and Spoilers. *Log another watch* (`LogAnotherWatchSheet`).
 *   watch  This watch's own note (`watch_events.note` via `set_watch_details`): owner-only
 *          by schema, so it has no claims, only the line saying so. *Edit watch* in Watch
 *          History (FU1113-A). The caller holds the draft and writes it on its own Save.
 */
export type WatchDetailsNote =
  | { kind: 'title'; titleNote: TitleNote }
  | {
      kind: 'watch';
      value: string;
      onChangeText: (next: string) => void;
      /** The column's limit; typing stops here. */
      maxLength: number;
    };

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
   * The note the Note row edits (`WatchDetailsNote`). For `title`, the caller owns the
   * `useTitleNote` because it owns the commit: it must `flush()` when the reader presses
   * Save or picks a bucket. For `watch`, the caller owns the draft and its write.
   */
  note: WatchDetailsNote;
  /**
   * The hairline above the rows, which the log sheet draws. A Watch History card's editor
   * draws its own boundary above its header and passes `false`, so the editor is one ruled
   * region rather than two rules a few points apart (founder spec §5: fewer dividers).
   */
  ruled?: boolean;
  /**
   * Every control shut, values still shown: the Watch History editor passes it while its
   * Save is in flight (Codex review, #287). The save writes a snapshot of the draft and a
   * success closes the editor, so anything changed during the request would be dropped
   * without a word; shutting the controls means nothing can be.
   */
  disabled?: boolean;
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
 * **The Note row edits one of two notes, named by the caller** (`WatchDetailsNote`).
 *
 * *Log another watch* edits the title's one note, the review, with its two claims (founder
 * decision, 2026-09-25): there is one note per title and one place it is published from.
 *
 * *Edit watch* in Watch History edits **this watch's own note** (FU1113-A, 2026-11-13). The
 * card shows `watch_events.note`, so the editor behind it must edit that same field: when it
 * edited the review instead, a watch with its own note opened on a blank field (or on the
 * review), and typing there rewrote — and could publish — the review. The watch note is
 * owner-only by schema, so it has no Share or Spoilers, only a line that says so. Text is
 * never copied between the two notes.
 */
export function WatchDetailsRows({
  date,
  onDate,
  people,
  peopleLoading = false,
  companionIds,
  onToggleCompanion,
  note,
  ruled = true,
  disabled = false,
}: WatchDetailsRowsProps) {
  const [open, setOpen] = useState<Open>(null);
  const toggle = (row: Exclude<Open, null>) => setOpen((was) => (was === row ? null : row));

  const selected = taggableWith(people, []).filter((person) => companionIds.includes(person.id));
  const companionValue = companionIds.length
    ? companionIds.length === 1
      ? (selected[0]?.name ?? '1 person')
      : `${companionIds.length} people`
    : 'Add';
  const titleNote = note.kind === 'title' ? note.titleNote : null;
  // A watch's own note is the caller's draft, so it is always ready to open.
  const noteLoaded = titleNote ? titleNote.loaded : true;
  const written = (titleNote ? titleNote.note : note.kind === 'watch' ? note.value : '').trim();
  const words = written ? written.split(/\s+/).length : 0;
  const noteValue = !noteLoaded
    ? undefined
    : words
      ? titleNote?.visibility === 'public'
        ? `Shared · ${words} words`
        : `${words} words`
      : 'Add';

  return (
    <View style={[styles.rows, !ruled && styles.unruled]}>
      <SheetRow
        icon="people-outline"
        label="Who I watched with"
        value={companionValue}
        expanded={open === 'who'}
        onPress={disabled ? undefined : () => toggle('who')}
      />
      {open === 'who' ? (
        <View style={styles.expanded} pointerEvents={disabled ? 'none' : 'auto'}>
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
        // Shut until the stored note and the share preference are both read, so the share
        // state is settled — and on screen — before anything typed can be saved.
        onPress={noteLoaded && !disabled ? () => toggle('note') : undefined}
        disabledReason={noteLoaded ? undefined : 'Loading'}
      />
      {open === 'note' && titleNote?.loaded ? (
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
      {open === 'note' && note.kind === 'watch' ? (
        <View style={[styles.expanded, styles.noteBox]} testID="watch-note-editor">
          <NoteInput
            value={note.value}
            label="Note"
            editable={!disabled}
            // `NoteInput` draws the review's 2,000 ceiling; a watch's column holds 1,000,
            // so the draft stops there rather than failing on Save. Counted in code points,
            // as the column counts, so an emoji at the limit is never cut in half.
            onChangeText={(next) => note.onChangeText(clampWatchNote(next, note.maxLength))}
            // Nothing saves on blur: the editor's Save writes the watch, or Cancel drops it.
            onBlur={() => {}}
          />
          {/* Private by schema: no Share and no Spoilers, because nobody else reads it. */}
          <Text variant="footnote" tone="tertiary" testID="watch-note-private-hint">
            {watchNoteLength(note.value) >= note.maxLength - NEAR_LIMIT
              ? `Only you see this note · ${watchNoteLength(note.value)}/${note.maxLength}`
              : 'Only you see this note'}
          </Text>
        </View>
      ) : null}

      <SheetRow
        icon="calendar-outline"
        label="Watch date"
        // *Earlier*, the same word as the choice that produces it (T0b).
        value={date === null ? 'Earlier' : formatWatchDate(date)}
        expanded={open === 'date'}
        onPress={disabled ? undefined : () => toggle('date')}
      />
      {open === 'date' ? (
        <View style={styles.expanded} pointerEvents={disabled ? 'none' : 'auto'}>
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
  unruled: { borderTopWidth: 0, paddingTop: 0 },
  expanded: { paddingBottom: theme.space[2] },
  noteBox: { paddingHorizontal: theme.layout.gutter, gap: theme.space[2] },
});
