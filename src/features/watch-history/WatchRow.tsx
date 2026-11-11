import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { formatWatchDate } from '@/features/collection/dates';
import type { Bucket } from '@/features/collection/score';
import { taggableWith, type Person } from '@/features/collection/use-companions';
import { fontFamily, theme } from '@/ui/tokens';
import { Button, ScoreBadge, SheetRow, Text } from '@/ui/components';

import { useTitleNote } from '@/features/collection/use-title-note';

import { WatchDetailsRows } from './WatchDetailsRows';
import {
  isFromDiary,
  type WatchEvent,
  type WatchRowLabel,
  type WatchScore,
} from './watch-history';

/** A note longer than this opens collapsed to three lines, with More. */
const NOTE_PREVIEW = 140;

export type WatchEdit = {
  /** Present only when the date was changed; null clears it. */
  watchedOn?: string | null;
  /** Present only when the note or the companions changed. */
  details?: { note: string | null; companionIds: string[] };
};

export type WatchRowProps = {
  event: WatchEvent;
  /** The title this watch belongs to — the editor writes its one note. */
  mediaItemId: string;
  label: WatchRowLabel;
  /** The opinion held at THIS watch (`scoresByWatch`) — never the current score. */
  score?: WatchScore | null;
  note?: string | null;
  companions?: Person[];
  /** The reader's mutual follows, for the editor's picker. */
  people: Person[];
  peopleLoading?: boolean;
  /** Whether this is the title's only viewing, which changes what removing it means. */
  onlyWatch: boolean;
  editing: boolean;
  onEdit: () => void;
  onDismissEdit: () => void;
  onSave: (edit: WatchEdit) => void;
  onRemove: () => void;
  /**
   * **Edit ranking**, offered inside the editor when the title is ranked (UI consistency
   * sprint, 2026-11-10). It opens the title's existing correction flow — *Update your
   * rating*'s band chooser and comparisons — and records no watch. Absent for a title with
   * no ranking to correct, and the row is not drawn.
   */
  onEditRanking?: () => void;
  busy?: boolean;
};

/**
 * One watch, as a line in this title's own historical feed (founder QA, 2026-09-21).
 *
 * **Left:** the date as the label — *(First watch)* on the earliest dated one only — then who
 * it was watched with and the watch's note, with More for a long one. **Right:** the
 * reader's score AT this watch, in the app's one score circle. Not the current score: a
 * later Update your rating moves the title page, never this row (`scoresByWatch`). No
 * poster (the reader is inside the title) and no `#X of Y` (the ledger keeps it; it is not
 * a historical opinion).
 *
 * **Edit** is a small text action directly under the date, and editing reuses the log
 * sheet's own rows (`WatchDetailsRows`) inline — no modal, so the ranking flow's sheets can
 * still stack. Editing a watch never touches the current ranking; that changes through
 * **Edit ranking**, a separate action in the editor that opens *Update your rating*'s
 * existing flow.
 *
 * The three acts stay three (UI consistency sprint, 2026-11-10):
 *   Log another watch   a new viewing — the title page's, not this screen's.
 *   Edit (this watch)   this viewing's date, who with, and the title's note.
 *   Edit ranking        the *current* ranking, through comparisons. No watch is created,
 *                       none is removed, and the scores frozen on earlier watches stay
 *                       frozen (`scoresByWatch`).
 */
export function WatchRow({
  event,
  mediaItemId,
  label,
  score = null,
  note,
  companions = [],
  people,
  peopleLoading = false,
  onlyWatch,
  editing,
  onEdit,
  onDismissEdit,
  onSave,
  onRemove,
  onEditRanking,
  busy = false,
}: WatchRowProps) {
  const [expanded, setExpanded] = useState(false);
  const dateLabel = event.watchedOn ? formatWatchDate(event.watchedOn) : 'Earlier';
  // "First watch" only when it is first *and* dated (§D.2).
  const primary = label === 'first' ? `${dateLabel} (First watch)` : dateLabel;
  const source = isFromDiary(event) ? 'From Letterboxd' : null;
  const withLine = companions.length
    ? `With ${companions.map((person) => person.name).join(', ')}`
    : null;
  const longNote = Boolean(note && note.length > NOTE_PREVIEW);

  return (
    <View style={styles.row} testID={`watch-row-${event.id}`}>
      {/**
       * **The date and Edit on the left, the score on the right** (founder, UI consistency
       * sprint, 2026-11-10). Edit sits directly under the date it edits, so the score
       * circle is the only thing in the right column, level with the date — it no longer
       * moves down when Edit is drawn beside it, or up when the editor replaces Edit. Edit keeps the full 44pt
       * target the 2026-11-07 pass gave it, with the word centred in it.
       */}
      <View style={styles.main} testID={`watch-main-${event.id}`}>
        <View style={styles.lead}>
          <Text variant="headline" testID={`watch-date-${event.id}`}>
            {primary}
          </Text>
          {editing ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Edit this watch, ${dateLabel}`}
              onPress={onEdit}
              style={({ pressed }) => [styles.edit, pressed && styles.editPressed]}
              testID={`watch-edit-${event.id}`}
            >
              <Text variant="footnote" tone="action" style={styles.editLabel}>
                Edit
              </Text>
            </Pressable>
          )}
        </View>

        {score ? (
          <View testID={`watch-score-${event.id}`}>
            <ScoreBadge score={score.score} bucket={score.bucket as Bucket | null} size="sm" />
          </View>
        ) : null}
      </View>

      {/* The watch's facts, the full width of the row so a long note reads as prose. */}
      {label === 'earlier' || source || withLine || note ? (
        <View style={styles.facts}>
          {label === 'earlier' ? (
            <Text variant="footnote" tone="tertiary">
              Date not recorded
            </Text>
          ) : null}
          {source ? (
            <Text variant="footnote" tone="tertiary">
              {source}
            </Text>
          ) : null}
          {withLine ? (
            <Text variant="footnote" tone="secondary" testID={`watch-with-${event.id}`}>
              {withLine}
            </Text>
          ) : null}
          {note ? (
            <Text
              variant="bodySecondary"
              tone="secondary"
              numberOfLines={longNote && !expanded ? 3 : undefined}
              testID={`watch-note-${event.id}`}
            >
              {note}
            </Text>
          ) : null}
          {longNote ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setExpanded((was) => !was)}
              hitSlop={theme.space[2]}
              style={styles.more}
            >
              <Text variant="footnote" tone="action">
                {expanded ? 'Less' : 'More'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {editing ? (
        <WatchEditor
          event={event}
          mediaItemId={mediaItemId}
          note={note ?? null}
          companions={companions}
          people={people}
          peopleLoading={peopleLoading}
          onlyWatch={onlyWatch}
          busy={busy}
          onCancel={onDismissEdit}
          onSave={(edit) => {
            onSave(edit);
            onDismissEdit();
          }}
          onRemove={onRemove}
          onEditRanking={onEditRanking}
        />
      ) : null}
    </View>
  );
}

function WatchEditor({
  event,
  mediaItemId,
  note,
  companions,
  people,
  peopleLoading,
  onlyWatch,
  busy,
  onCancel,
  onSave,
  onRemove,
  onEditRanking,
}: {
  event: WatchEvent;
  mediaItemId: string;
  note: string | null;
  companions: Person[];
  people: Person[];
  peopleLoading: boolean;
  onlyWatch: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (edit: WatchEdit) => void;
  onRemove: () => void;
  onEditRanking?: () => void;
}) {
  const [date, setDate] = useState(event.watchedOn);
  // The note here is the title's one note now, not this watch's private line.
  const titleNote = useTitleNote(mediaItemId);
  const [selected, setSelected] = useState(() => companions.map((person) => person.id));

  const save = async () => {
    // The note saves through `save_note`, on its own object, before the watch's own edit
    // goes anywhere — so a failure to write one is never reported as the other.
    await titleNote.flush();

    const edit: WatchEdit = {};
    if (date !== event.watchedOn) edit.watchedOn = date;
    const before = companions.map((person) => person.id).sort().join(',');
    const after = [...selected].sort().join(',');
    // `note` is passed through untouched: nothing writes `watch_events.note` any more,
    // and an edit to companions must not quietly clear a line an older build saved.
    if (before !== after) edit.details = { note: note ?? null, companionIds: selected };
    onSave(edit);
  };

  return (
    <View style={styles.editor} testID={`watch-editor-${event.id}`}>
      <WatchDetailsRows
        date={date}
        onDate={setDate}
        people={taggableWith(people, companions)}
        peopleLoading={peopleLoading}
        companionIds={selected}
        onToggleCompanion={(id) =>
          setSelected((current) =>
            current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
          )
        }
        titleNote={titleNote}
      />

      <View style={styles.actions}>
        <Button label="Cancel" kind="secondary" size="sm" onPress={onCancel} />
        <Button label="Save" size="sm" disabled={busy} onPress={() => void save()} />
      </View>

      {/**
       * The only watch says something different, because the server refuses deleting it
       * (`P0001 last_watch`): a title in the collection has at least one watch, so what
       * the reader means is that the title should leave the collection.
       *
       * **And now it does that** (founder, 2026-09-25). The words were already
       * "Remove from collection…" and pressing them produced an error telling the reader
       * to go and remove it from their collection — which is what they had just pressed.
       * The ellipsis is gone with the contradiction: this is the act, not a doorway to
       * somewhere else that performs it.
       */}
      {/**
       * **The two acts that are not this watch's details** (founder, UI consistency
       * sprint, 2026-11-10), below the form and its Save so neither reads as a field.
       *
       * *Edit ranking* changes the title's current ranking through the existing flow and
       * leaves this watch alone. A note typed above is flushed first, as Save does, so the
       * rating sheet opens on it; the date and the companions are not saved, exactly as
       * Cancel leaves them — the sheet is about the ranking, not this viewing.
       *
       * *Remove* is unchanged: the destructive act, behind Edit, exactly as before.
       */}
      <View style={styles.otherActions}>
        {onEditRanking ? (
          <View testID={`watch-edit-ranking-${event.id}`}>
            <SheetRow
              icon="swap-vertical-outline"
              label="Edit ranking"
              onPress={
                busy
                  ? undefined
                  : () =>
                      void (async () => {
                        await titleNote.flush();
                        onEditRanking();
                      })()
              }
              disabledReason={busy ? 'Saving' : undefined}
            />
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={onRemove}
          style={({ pressed }) => [styles.remove, pressed && styles.editPressed]}
          testID={`watch-remove-${event.id}`}
        >
          <Text variant="footnote" tone="action">
            {onlyWatch ? 'Remove from collection' : 'Remove this watch'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * The row's gutters live on its parts rather than on the row, so the inline editor can be
   * the full width of the screen — the log sheet's rows draw their own gutters — without
   * a negative margin pulling it back out over padding it should never have been inside.
   */
  row: { paddingVertical: theme.space[3] },
  // Top-aligned: the score sits level with the date's line and never moves when Edit is
  // drawn under the date or gives way to the editor (independent review).
  main: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
  },
  // The date, then Edit under it. Takes what the score leaves, so a long date wraps here.
  lead: { flex: 1, alignItems: 'flex-start' },
  // The word centred in a full 44pt target, flush with the date's left edge.
  edit: {
    minHeight: theme.layout.minTapTarget,
    minWidth: theme.layout.minTapTarget,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  editLabel: { fontFamily: fontFamily.sansMedium },
  editPressed: { opacity: 0.6 },
  facts: { gap: theme.space[1], paddingHorizontal: theme.layout.gutter },
  more: { alignSelf: 'flex-start' },
  editor: { marginTop: theme.space[3], gap: theme.space[3] },
  actions: {
    flexDirection: 'row',
    gap: theme.space[3],
    justifyContent: 'flex-end',
    paddingHorizontal: theme.layout.gutter,
  },
  // A hairline, as above the detail rows, so the two acts read as apart from the form.
  otherActions: {
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: theme.border.hairline,
  },
  // A full 44pt target for the destructive act, the word on the gutter.
  remove: {
    minHeight: theme.layout.minTapTarget,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: theme.layout.gutter,
  },
});
