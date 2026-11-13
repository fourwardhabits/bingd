import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { formatWatchDate } from '@/features/collection/dates';
import type { Bucket } from '@/features/collection/score';
import { taggableWith, type Person } from '@/features/collection/use-companions';
import { fontFamily, theme } from '@/ui/tokens';
import { Button, SaveButton, ScoreBadge, Text } from '@/ui/components';

import { useTitleNote } from '@/features/collection/use-title-note';

import { RERANK_ICON, RERANK_LABEL } from './rerank';
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
   * **Rerank** (founder spec §5, 2026-11-13; it was *Edit ranking*). It opens the title's
   * existing correction flow — *Update your rating*'s band chooser and comparisons, in
   * `rerank` / `rebucket` mode — and records no watch. Absent for a title with no ranking
   * to correct, or while another card's editor is open, and then it is not drawn.
   */
  onEditRanking?: () => void;
  busy?: boolean;
};

/**
 * One watch, as a card in this title's own historical feed (founder QA, 2026-09-21; card
 * refinement, founder spec §5, 2026-11-13).
 *
 *     Mar 4, 2024                      (9.0)     ← the date is the anchor; the score is
 *     From Letterboxd                              centred on the date block
 *     With Alex
 *     Better the second time.
 *     ✎ Edit watch    ⇄ Rerank                   ← the two acts, with the watch's facts
 *
 * The score is the reader's score AT this watch, never the current one: a later Rerank
 * moves the title page, never this card (`scoresByWatch`). No poster (the reader is inside
 * the title) and no `#X of Y`.
 *
 * **Editing opens inside the card**, in place of the action line, behind one hairline:
 * a header with Rerank on the left and Cancel · Save on the right — the standard
 * `SaveButton`, top right of the editor — then the log sheet's own rows
 * (`WatchDetailsRows`), then Remove, the destructive act, last and apart. So Rerank sits
 * at the same height in both states, and never under Remove again.
 *
 * The three acts stay three (UI consistency sprint, 2026-11-10):
 *   Log another watch   a new viewing — the title page's, not this screen's.
 *   Edit watch          this viewing's date, who with, and the title's note.
 *   Rerank              the *current* ranking, through comparisons. No watch is created,
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
  // The date alone (founder QA, 2026-11-12). The row's place in the list already says which
  // watch came first; *(First watch)* on one entry read as a tag on a single row.
  const primary = dateLabel;
  const source = isFromDiary(event) ? 'From Letterboxd' : null;
  const withLine = companions.length
    ? `With ${companions.map((person) => person.name).join(', ')}`
    : null;
  const longNote = Boolean(note && note.length > NOTE_PREVIEW);
  // The quiet facts about where the date came from, on one line under the date, so an
  // imported or undated watch costs a card one line, not two.
  const provenance = [label === 'earlier' ? 'Date not recorded' : null, source]
    .filter(Boolean)
    .join(' · ');

  return (
    /**
     * **Each watch is a card** (UI wave, 2026-11-12): `surface.raised` on Paper,
     * `radius.card`, the hairline border `FeaturedCard` draws. The list spaces the cards.
     */
    <View style={styles.row} testID={`watch-row-${event.id}`}>
      {/**
       * **The date block and the score, centred on each other** (founder spec §5). The date
       * is the card's anchor in `headline`, with its provenance under it; the score circle
       * is centred on that block, so it lines up with the date whatever the provenance
       * line does — and nothing in this row changes when the editor opens, so it never
       * moves.
       */}
      <View style={styles.main} testID={`watch-main-${event.id}`}>
        <View style={styles.lead} testID={`watch-lead-${event.id}`}>
          <Text variant="headline" style={styles.date} testID={`watch-date-${event.id}`}>
            {primary}
          </Text>
          {provenance ? (
            <Text variant="footnote" tone="tertiary" testID={`watch-provenance-${event.id}`}>
              {provenance}
            </Text>
          ) : null}
        </View>

        {score ? (
          <View testID={`watch-score-${event.id}`}>
            <ScoreBadge score={score.score} bucket={score.bucket as Bucket | null} size="sm" />
          </View>
        ) : null}
      </View>

      {/* The watch's facts, the full width of the card so a long note reads as prose. */}
      {withLine || note ? (
        <View style={styles.facts}>
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
      ) : (
        /**
         * **Edit watch and Rerank, with the watch they belong to** (founder spec §5). Both
         * are quiet Maroon text actions with their glyphs, each a full 44pt target, on one
         * line that wraps at large text rather than running past the card.
         */
        <View style={styles.actionLine} testID={`watch-actions-${event.id}`}>
          <CardAction
            testID={`watch-edit-${event.id}`}
            icon="create-outline"
            label="Edit watch"
            accessibilityLabel={`Edit this watch, ${dateLabel}`}
            onPress={onEdit}
          />
          {onEditRanking ? (
            <CardAction
              testID={`watch-rerank-${event.id}`}
              icon={RERANK_ICON}
              label={RERANK_LABEL}
              accessibilityHint="Compares this title again. Records no new watch."
              onPress={onEditRanking}
            />
          ) : null}
        </View>
      )}
    </View>
  );
}

/** A quiet text action with its glyph, at a full 44pt target: the card's two acts. */
function CardAction({
  icon,
  label,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  disabledReason,
  testID,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  onPress?: () => void;
  /** Present while the act cannot be taken; drawn inert and said aloud. */
  disabledReason?: string;
  testID?: string;
}) {
  const disabled = Boolean(disabledReason) || !onPress;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={disabledReason ?? accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.cardAction,
        pressed && styles.editPressed,
        disabled && styles.inert,
      ]}
    >
      <Ionicons name={icon} size={theme.layout.icon.sm - 2} color={theme.semantic.action} />
      <Text variant="footnote" tone="action" style={styles.editLabel}>
        {label}
      </Text>
    </Pressable>
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
    /**
     * **The editor, contained in its card behind one hairline** (founder spec §5). Its
     * header holds the editor's own acts — Rerank on the left, where the action line had
     * it; Cancel, secondary, and the standard `SaveButton` at the top right — so Save
     * never sits below the form or out of sight of the date it saves, and nothing here
     * covers the date or the score above.
     */
    <View style={styles.editor} testID={`watch-editor-${event.id}`}>
      <View style={styles.editorHeader} testID={`watch-editor-header-${event.id}`}>
        <View style={styles.editorLead}>
          {onEditRanking ? (
            <CardAction
              testID={`watch-rerank-${event.id}`}
              icon={RERANK_ICON}
              label={RERANK_LABEL}
              accessibilityHint="Compares this title again. Records no new watch."
              onPress={() => editRanking(onEditRanking)}
              disabledReason={locked ? 'Saving' : undefined}
            />
          ) : null}
        </View>
        <View style={styles.editorActions}>
          <Button
            label="Cancel"
            kind="secondary"
            size="sm"
            hitSlop={COMPACT_SLOP}
            disabled={submitting}
            disabledReason={submitting ? 'Saving' : undefined}
            onPress={onCancel}
          />
          <SaveButton
            testID={`watch-save-${event.id}`}
            accessibilityLabel="Save"
            saving={submitting}
            disabled={busy}
            disabledReason={busy ? 'Saving' : undefined}
            onPress={() => void save()}
          />
        </View>
      </View>

      <WatchDetailsRows
        ruled={false}
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

      {/**
       * The only watch says something different, because the server refuses deleting it
       * (`P0001 last_watch`): a title in the collection has at least one watch, so what
       * the reader means is that the title should leave the collection — and it does that
       * (founder, 2026-09-25). Last and apart: the destructive act, behind Edit watch.
       */}
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
  );
}

/**
 * Cancel is drawn at `Button`'s small size — the compact action height, Save's own — and
 * this slop returns it to a 44pt target, inside the header row's padding.
 */
const COMPACT_SLOP = {
  top: (theme.layout.minTapTarget - theme.layout.control.compactAction.visibleHeight) / 2,
  bottom: (theme.layout.minTapTarget - theme.layout.control.compactAction.visibleHeight) / 2,
} as const;

const styles = StyleSheet.create({
  /**
   * The card. Its inner gutters live on its parts rather than on the card, so the inline
   * editor can be the full width of the card without a negative margin.
   *
   * No height, no `overflow: hidden`: at the largest text sizes, on a 320pt screen, the
   * date wraps and the card grows with it rather than clipping anything.
   */
  row: {
    marginHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    backgroundColor: theme.surface.raised,
    borderRadius: theme.radius.card,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
  },
  // The date block and the score, centred on each other.
  main: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
  },
  // Takes what the score leaves, so a long date wraps here rather than under the circle.
  lead: { flex: 1, gap: 2 },
  // The anchor: the card's one line in display weight.
  date: { fontFamily: fontFamily.sansSemibold },
  facts: { gap: theme.space[1], paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
  more: { alignSelf: 'flex-start' },
  // Edit watch and Rerank. Wraps at large text; the card's bottom air is the row's own.
  actionLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: theme.space[4],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[1],
    paddingBottom: theme.space[1],
  },
  // Glyph and word, the word centred in a full 44pt target.
  cardAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[1],
    minHeight: theme.layout.minTapTarget,
    minWidth: theme.layout.minTapTarget,
  },
  editLabel: { fontFamily: fontFamily.sansMedium },
  editPressed: { opacity: 0.6 },
  inert: { opacity: 0.4 },
  // One hairline: the boundary between the watch and the editing of it.
  editor: {
    marginTop: theme.space[2],
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: theme.border.hairline,
    paddingTop: theme.space[1],
    gap: theme.space[1],
  },
  // Rerank on the left, Cancel · Save at the top right; wraps rather than overflowing.
  editorHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    rowGap: theme.space[1],
    paddingHorizontal: theme.layout.gutter,
  },
  editorLead: { flexShrink: 1 },
  editorActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: theme.space[2],
    marginLeft: 'auto',
  },
  // A full 44pt target for the destructive act, the word on the gutter.
  remove: {
    minHeight: theme.layout.minTapTarget,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: theme.layout.gutter,
    marginBottom: theme.space[1],
  },
});
