import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

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
  /**
   * Writes the edit. Resolves `true` once every write it made succeeded, `false` when one
   * failed (the screen shows why). The editor's own Save does not wait for it; Edit
   * ranking's *Save* does, so it only moves on to the ranking once the watch is saved.
   */
  onSave: (edit: WatchEdit) => Promise<boolean>;
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
 * later Edit ranking moves the title page, never this row (`scoresByWatch`). No
 * poster (the reader is inside the title) and no `#X of Y` (the ledger keeps it; it is not
 * a historical opinion).
 *
 * **Edit** is a small text action directly under the date, and editing reuses the log
 * sheet's own rows (`WatchDetailsRows`) inline — no modal, so the ranking flow's sheets can
 * still stack. Editing a watch never touches the current ranking; that changes through
 * **Edit ranking**, a separate action in the editor that opens *Edit ranking*'s
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
  // The quiet facts about where the date came from, on one line so an imported or undated
  // watch costs a card one line, not two.
  const provenance = [label === 'earlier' ? 'Date not recorded' : null, source]
    .filter(Boolean)
    .join(' · ');

  return (
    /**
     * **Each watch is a card** (UI wave, 2026-11-12): the house card treatment —
     * `surface.raised` on Paper, `radius.card`, the hairline border `FeaturedCard` draws —
     * in place of a full-width row and a rule between rows. The list spaces the cards.
     * Everything inside is unchanged, the inline editor included: it opens inside the
     * card, under the facts, so the watch being edited stays one object on the page.
     */
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
      {provenance || withLine || note ? (
        <View style={styles.facts}>
          {provenance ? (
            <Text variant="footnote" tone="tertiary" testID={`watch-provenance-${event.id}`}>
              {provenance}
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
          onSave={onSave}
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
  /** Closes the editor without saving; also how the editor's own Save closes it. */
  onCancel: () => void;
  /** Writes the edit; `true` once all of it landed. */
  onSave: (edit: WatchEdit) => Promise<boolean>;
  onRemove: () => void;
  onEditRanking?: () => void;
}) {
  const [date, setDate] = useState(event.watchedOn);
  // The note here is the title's one note now, not this watch's private line.
  const titleNote = useTitleNote(mediaItemId);
  const [selected, setSelected] = useState(() => companions.map((person) => person.id));

  /** What Save would write for this watch: only the parts the reader changed. */
  const pendingEdit = (): WatchEdit => {
    const edit: WatchEdit = {};
    if (date !== event.watchedOn) edit.watchedOn = date;
    const before = companions.map((person) => person.id).sort().join(',');
    const after = [...selected].sort().join(',');
    // `note` is passed through untouched: nothing writes `watch_events.note` any more,
    // and an edit to companions must not quietly clear a line an older build saved.
    if (before !== after) edit.details = { note: note ?? null, companionIds: selected };
    return edit;
  };

  /**
   * Whether this editor is still the one open. A save that lands after the reader has
   * cancelled, or opened another watch's editor, must not then open the ranking over
   * whatever they are doing now (independent review).
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /**
   * Set from the first tap of Save or Edit ranking until that act has finished, so the
   * note's flush — a round trip, before the screen's own `busy` turns on — cannot be
   * tapped into twice (independent review). The ref answers synchronously; the state
   * draws the controls disabled.
   */
  const inFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const begin = () => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setSubmitting(true);
    return true;
  };
  const end = () => {
    inFlight.current = false;
    if (mounted.current) setSubmitting(false);
  };
  const locked = busy || submitting;

  const save = async () => {
    if (!begin()) return;
    // The note saves through `save_note`, on its own object, before the watch's own edit
    // goes anywhere — so a failure to write one is never reported as the other.
    try {
      await titleNote.flush();
    } finally {
      end();
    }
    // Not awaited, as before: the editor closes and the screen reports a failure.
    void onSave(pendingEdit());
    onCancel();
  };

  /**
   * **Edit ranking never drops an unsaved edit silently** (stabilization pass,
   * 2026-11-11). With nothing pending it opens the ranking flow as before. With a changed
   * date or companions it asks first, in the app's own confirm — a native alert, as
   * removing a title or signing out asks:
   *
   *   Save     writes the watch, and opens the ranking only once that write has landed.
   *            A failed write shows the screen's error line and leaves the editor open
   *            with the edits still in it.
   *   Discard  drops the date and companions, as Cancel does, and opens the ranking.
   *   Cancel   nothing: the editor stays open with the edits in it.
   *
   * The title's note is not one of these edits: it is written on blur and on flush, so it
   * is flushed before the ranking opens on either path, exactly as before.
   */
  const editRanking = (open: () => void) => {
    if (inFlight.current) return;
    const edit = pendingEdit();
    const goToRanking = async () => {
      if (!begin()) return;
      try {
        await titleNote.flush();
      } finally {
        end();
      }
      if (mounted.current) open();
    };
    if (edit.watchedOn === undefined && !edit.details) {
      void goToRanking();
      return;
    }
    Alert.alert(
      'Save changes to this watch?',
      'You changed this watch’s date or who you watched with.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => void goToRanking() },
        {
          text: 'Save',
          onPress: () =>
            void (async () => {
              if (!begin()) return;
              let saved = false;
              try {
                await titleNote.flush();
                saved = await onSave(edit);
              } finally {
                end();
              }
              if (saved && mounted.current) open();
            })(),
        },
      ],
    );
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
        <Button
          label="Cancel"
          kind="secondary"
          size="sm"
          disabled={submitting}
          disabledReason={submitting ? 'Saving' : undefined}
          onPress={onCancel}
        />
        <Button
          label="Save"
          size="sm"
          disabled={locked}
          disabledReason={locked ? 'Saving' : undefined}
          onPress={() => void save()}
        />
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
       * rating sheet opens on it; a changed date or companions are never dropped silently
       * — the reader chooses Save, Discard or Cancel first (`editRanking`).
       *
       * *Remove* is unchanged: the destructive act, behind Edit, exactly as before.
       */}
      <View style={styles.otherActions}>
        {onEditRanking ? (
          <View testID={`watch-edit-ranking-${event.id}`}>
            <SheetRow
              icon="swap-vertical-outline"
              label="Edit ranking"
              onPress={locked ? undefined : () => editRanking(onEditRanking)}
              disabledReason={locked ? 'Saving' : undefined}
            />
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={locked}
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
   * The card. Its inner gutters live on its parts rather than on the card, so the inline
   * editor can be the full width of the card — the log sheet's rows draw their own gutters,
   * which is the design system's 16pt card padding — without a negative margin pulling it
   * back out over padding it should never have been inside.
   *
   * No height, no `overflow: hidden`: at the largest text sizes, on a 320pt screen, the
   * date wraps and the card grows with it rather than clipping anything.
   */
  row: {
    marginHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
    backgroundColor: theme.surface.raised,
    borderRadius: theme.radius.card,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
  },
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
  // Wraps rather than overflowing the card when large text makes the two buttons wider
  // than a narrow card.
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
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
