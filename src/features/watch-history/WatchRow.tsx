import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { formatWatchHistoryDate } from '@/features/collection/dates';
import type { Bucket } from '@/features/collection/score';
import { taggableWith, type Person } from '@/features/collection/use-companions';
import { fontFamily, theme } from '@/ui/tokens';
import { Button, EDIT_ICON_NAME, SaveButton, ScoreBadge, Text } from '@/ui/components';

import { RERANK_ICON, RERANK_LABEL } from './rerank';
import { WatchDetailsRows } from './WatchDetailsRows';
import {
  isFromDiary,
  normalWatchNote,
  WATCH_NOTE_MAX_LENGTH,
  type WatchEvent,
  type WatchRowLabel,
  type WatchScore,
} from './watch-history';

/** A note longer than this opens collapsed to three lines, with More. */
const NOTE_PREVIEW = 140;

/**
 * *Edit watch*'s glyph: the shared Edit glyph (workstream B's `EDIT_ICON_NAME`,
 * `create-outline`), swapped in at integration as FU1113-A planned. Same glyph as before.
 */
const EDIT_WATCH_ICON = EDIT_ICON_NAME;

export type WatchEdit = {
  /** Present only when the date was changed; null clears it. */
  watchedOn?: string | null;
  /**
   * Present only when this watch's note or its companions changed. `note` is always the
   * whole note to store on THIS watch (`watch_events.note`; null clears it);
   * `companionIds` is present only when the companions changed, and absent leaves them.
   */
  details?: { note: string | null; companionIds?: string[] };
  /**
   * Present only when the reader chose **Share as a review** in this editor (founder QA,
   * 2026-11-16): publish `note` as the title's review (`user_media.note`, `save_note`)
   * with this spoiler flag, after this watch's own note is written. The watch's note stays
   * private either way; nothing here ties the two together afterwards.
   */
  review?: { note: string; spoilers: boolean };
};

/**
 * What a save came to: the editor closes only on `ok`, and says `message` otherwise.
 * `cancelled` is the reader declining to replace their review: nothing was written, the
 * editor stays open with the draft, and there is nothing to say.
 */
export type WatchSaveResult =
  | { ok: true }
  | { ok: false; message: string }
  | { ok: false; cancelled: true };

export type WatchRowProps = {
  event: WatchEvent;
  label: WatchRowLabel;
  /** The opinion held at THIS watch (`scoresByWatch`) — never the current score. */
  score?: WatchScore | null;
  /** THIS watch's own note (`watch_events.note`): the card draws it and the editor edits it. */
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
   * Writes the edit. Resolves `ok` once every write it made succeeded, or the reason one
   * failed. Both Saves — the editor's own and Rerank's ask-first *Save* — wait for it: the
   * editor closes, or the ranking opens, only over a saved watch; a failure keeps the
   * editor open with the draft in it and says why there.
   */
  onSave: (edit: WatchEdit) => Promise<WatchSaveResult>;
  onRemove: () => void;
  /**
   * **Rerank** (founder spec §5, 2026-11-13; it was *Edit ranking*). It opens the title's
   * existing correction flow — *Update your rating*'s band chooser and comparisons, in
   * `rerank` / `rebucket` mode — and records no watch. Absent for a title with no ranking
   * to correct, or while another card's editor is open, and then it is not drawn.
   */
  onEditRanking?: () => void;
  /**
   * **Share as a review** (B5): offers THIS watch's saved note to the title's review
   * composer, as a draft. The caller asks before it replaces an existing review and opens
   * the composer; nothing is written by this tap, and the watch note is never touched.
   * Drawn only on a card with a saved note, beside Edit watch and Rerank; absent while any
   * card's editor is open.
   */
  onShareNote?: () => void;
  busy?: boolean;
};

/**
 * One watch, as a card in this title's own historical feed (founder QA, 2026-09-21; card
 * refinement, founder spec §5, 2026-11-13; hierarchy, FU1113-A).
 *
 *     March 4, 2024                    (9.0)     ← the date top-left, the score top-right,
 *     With Alex                                    top-aligned with the date
 *     From Letterboxd                            ← the quiet metadata, straight under it
 *
 *     Better the second time.                    ← this watch's own note, below the metadata
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
 *   Edit watch          this viewing's date, who with, and its own private note — the
 *                       note the card shows (`watch_events.note`), never the title's
 *                       review (FU1113-A).
 *   Rerank              the *current* ranking, through comparisons. No watch is created,
 *                       none is removed, and the scores frozen on earlier watches stay
 *                       frozen (`scoresByWatch`).
 *
 * And, on a card with a note, *Share as a review* (B5): not a fourth way to change this
 * watch but a door to the title's own review composer, opened on this note as a draft.
 * It writes nothing itself; the watch's note stays private on the watch.
 */
export function WatchRow({
  event,
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
  onShareNote,
  busy = false,
}: WatchRowProps) {
  const [expanded, setExpanded] = useState(false);
  // The full month and the year, this year's included, and never *Today* (UI refinement
  // B3, 2026-11-15): `formatWatchHistoryDate`, the Watch History screen's own form. The
  // date's `Text` has no line limit, so a long date in a large text size wraps.
  const dateLabel = event.watchedOn ? formatWatchHistoryDate(event.watchedOn) : 'Earlier';
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

  /**
   * **Where the action line sits: beside the score when nothing comes between** (UI
   * refinement B4, 2026-11-15).
   *
   * The card's top row is the date block and the score circle, top-aligned, so the row is
   * as tall as the taller of the two. The circle is 40pt (`scoreBadge.sm`, more at large
   * text) and a date alone is one 22pt `headline` line, so on a watch with no companion
   * and no provenance the row was the circle's height and the action line, below the row,
   * started 18pt under the date's last line: empty space that only a companion line
   * (22 + 4 + 18 = 44pt, taller than the circle) ever filled. Nothing reserved it by
   * name — it was the circle's height standing in for the date block's.
   *
   * So when the next thing after the date block is the action line — the card has no note
   * and is not being edited — the action line joins the date block's column, beside the
   * circle: it follows the date or the last metadata line directly, and the card is as
   * tall as its content or the circle, whichever is taller. The order is unchanged (date,
   * companions, provenance, acts) and Edit watch and Rerank keep their 44pt targets and
   * wrap inside the column, never under the circle.
   *
   * **With a note the line stays where it was**, under the note at the card's full width
   * (FU1113-A): the note is prose and keeps the card's whole measure, so it starts below
   * the circle, and the acts follow it. The editor, too, keeps the card's full width.
   */
  const actionsBesideScore = !note && !editing;
  const actions = (
    <View
      style={[styles.actionLine, !actionsBesideScore && styles.actionLineInset]}
      testID={`watch-actions-${event.id}`}
    >
      <CardAction
        testID={`watch-edit-${event.id}`}
        icon={EDIT_WATCH_ICON}
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
          // A write this screen started (a removal, a save) may still be in flight:
          // the ranking does not open over it (independent review).
          disabledReason={busy ? 'Saving' : undefined}
        />
      ) : null}
      {/**
       * **Share as a review, on the action line** (B5). The third of the card's acts, in
       * the same quiet form, because it is an act on this watch like the other two — and
       * here rather than inside the editor, because what it shares is the note the card
       * shows, which is the *saved* one: an editor's unsaved draft is never offered, and the
       * editor's own header (Rerank · Cancel · Save) stays as it is. Only on a card that has
       * a note — so it is always on the full-width line under the note (B4), never beside
       * the score.
       */}
      {note && onShareNote ? (
        <CardAction
          testID={`watch-share-${event.id}`}
          icon="people-outline"
          label="Share as a review"
          accessibilityLabel={`Share this watch’s note as a review, ${dateLabel}`}
          accessibilityHint="Opens your review with this note. Nothing is shared until you choose to."
          onPress={onShareNote}
          disabledReason={busy ? 'Saving' : undefined}
        />
      ) : null}
    </View>
  );

  return (
    /**
     * **Each watch is a card** (UI wave, 2026-11-12): `surface.raised` on Paper,
     * `radius.card`, the hairline border `FeaturedCard` draws. The list spaces the cards.
     */
    <View style={styles.row} testID={`watch-row-${event.id}`}>
      {/**
       * **Date top-left, score top-right** (FU1113-A). The date is the card's anchor in
       * `headline`; who it was watched with sits directly under it, then where the date
       * came from, both quieter. The score circle is top-aligned with the date row, and
       * nothing in this row changes when the editor opens, so it never moves.
       *
       * The date block is sized by its own lines — no height, no minimum, and no line
       * drawn for a companion who is not there — inside a column that takes what the
       * score leaves (B4).
       */}
      <View style={styles.main} testID={`watch-main-${event.id}`}>
        <View style={styles.leadColumn} testID={`watch-lead-column-${event.id}`}>
          <View style={styles.lead} testID={`watch-lead-${event.id}`}>
            <Text variant="headline" style={styles.date} testID={`watch-date-${event.id}`}>
              {primary}
            </Text>
            {withLine ? (
              <Text variant="footnote" tone="secondary" testID={`watch-with-${event.id}`}>
                {withLine}
              </Text>
            ) : null}
            {provenance ? (
              <Text variant="footnote" tone="tertiary" testID={`watch-provenance-${event.id}`}>
                {provenance}
              </Text>
            ) : null}
          </View>
          {actionsBesideScore ? actions : null}
        </View>

        {score ? (
          <View testID={`watch-score-${event.id}`}>
            <ScoreBadge score={score.score} bucket={score.bucket as Bucket | null} size="sm" />
          </View>
        ) : null}
      </View>

      {/* This watch's own note, under the metadata, the full width of the card so a long
          note reads as prose. */}
      {note ? (
        <View style={styles.noteBlock} testID={`watch-note-block-${event.id}`}>
          <Text
            variant="bodySecondary"
            tone="secondary"
            numberOfLines={longNote && !expanded ? 3 : undefined}
            testID={`watch-note-${event.id}`}
          >
            {note}
          </Text>
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

      {/**
       * **Edit watch and Rerank, with the watch they belong to** (founder spec §5). Both
       * are quiet Maroon text actions with their glyphs, each a full 44pt target, on one
       * line that wraps at large text rather than running past the card. Here, under the
       * note, only when the card has one; otherwise beside the score, above (B4).
       */}
      {editing || actionsBesideScore ? null : actions}
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
  /** THIS watch's saved note, the same value the card above draws. */
  note: string | null;
  companions: Person[];
  people: Person[];
  peopleLoading: boolean;
  onlyWatch: boolean;
  busy: boolean;
  /** Closes the editor without saving; also how the editor's own Save closes it. */
  onCancel: () => void;
  /** Writes the edit; `ok` once all of it landed. */
  onSave: (edit: WatchEdit) => Promise<WatchSaveResult>;
  onRemove: () => void;
  onEditRanking?: () => void;
}) {
  const [date, setDate] = useState(event.watchedOn);
  /**
   * **This watch's own note** (FU1113-A). The draft starts from the very value the card
   * shows (`watch_events.note`), so the editor never opens blank on a watch that has one,
   * and never on the title's review. It is written by Save, through `set_watch_details`,
   * on this `watch_event_id` only; Cancel drops it. The review is not read or written here.
   */
  const [noteDraft, setNoteDraft] = useState(() => note ?? '');
  const [selected, setSelected] = useState(() => companions.map((person) => person.id));
  /**
   * **Share as a review, chosen in the editor** (founder QA, 2026-11-16). Private until the
   * reader turns it on, every time the editor opens: editing a watch's note never publishes
   * or republishes anything by itself.
   */
  const [shareAsReview, setShareAsReview] = useState(false);
  const [spoilers, setSpoilers] = useState(false);
  /** Why the last save failed, said inside the editor that still holds the draft. */
  const [failure, setFailure] = useState<string | null>(null);

  /** What Save would write for this watch: only the parts the reader changed. */
  const pendingEdit = (): WatchEdit => {
    const edit: WatchEdit = {};
    if (date !== event.watchedOn) edit.watchedOn = date;
    const before = companions.map((person) => person.id).sort().join(',');
    const after = [...selected].sort().join(',');
    const companionsChanged = before !== after;
    const nextNote = normalWatchNote(noteDraft);
    const noteChanged = nextNote !== normalWatchNote(note);
    // `set_watch_details` always writes the note, so it carries the draft whichever of the
    // two changed; companions travel only when they changed, and absent leaves them.
    if (noteChanged || companionsChanged) {
      edit.details = {
        note: nextNote,
        ...(companionsChanged ? { companionIds: selected } : {}),
      };
    }
    // Shared only when chosen, and only text there is: an empty note is not a review.
    if (shareAsReview && nextNote) edit.review = { note: nextNote, spoilers };
    return edit;
  };

  const nothingToWrite = (edit: WatchEdit) =>
    edit.watchedOn === undefined && !edit.details && !edit.review;

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
   * Set from the first tap of Save until that save has finished, so it cannot be tapped
   * into twice before the screen's own `busy` turns on (independent review). The ref
   * answers synchronously; the state draws the controls disabled and Save as *Saving…*.
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

  /**
   * Writes the pending edit and waits for it. `true` once it landed (or there was nothing
   * to write). On a failure the editor stays open with every edit in it and the reason
   * under its header; the card above is untouched, because nothing is drawn as saved
   * before the server says so.
   */
  const commit = async (edit: WatchEdit): Promise<boolean> => {
    if (nothingToWrite(edit)) return true;
    setFailure(null);
    const result = await onSave(edit);
    if (!result.ok && 'message' in result && mounted.current) setFailure(result.message);
    return result.ok;
  };

  const save = async () => {
    if (shareAsReview && !normalWatchNote(noteDraft)) {
      setFailure('Write a note to share it as a review.');
      return;
    }
    if (!begin()) return;
    let saved = false;
    try {
      saved = await commit(pendingEdit());
    } finally {
      end();
    }
    if (saved && mounted.current) onCancel();
  };

  /**
   * **Rerank never drops an unsaved edit silently** (stabilization pass, 2026-11-11). With
   * nothing pending it opens the ranking flow as before. With a changed date, companions
   * or note it asks first, in the app's own confirm — a native alert, as removing a title
   * or signing out asks:
   *
   *   Save     writes the watch, and opens the ranking only once that write has landed.
   *            A failed write says why inside the editor and leaves it open with the
   *            edits still in it.
   *   Discard  drops the edits, as Cancel does, and opens the ranking.
   *   Cancel   nothing: the editor stays open with the edits in it.
   *
   * The note is one of these edits now (FU1113-A): it is this watch's, saved by Save, so
   * typed text is never written behind the reader's back nor lost without asking.
   */
  const editRanking = (open: () => void) => {
    if (inFlight.current) return;
    const edit = pendingEdit();
    if (nothingToWrite(edit)) {
      open();
      return;
    }
    Alert.alert(
      'Save changes to this watch?',
      'You changed this watch’s date, who you watched with, or its note.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => open() },
        {
          text: 'Save',
          onPress: () =>
            void (async () => {
              if (!begin()) return;
              let saved = false;
              try {
                saved = await commit(edit);
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
            disabled={busy || submitting}
            disabledReason={busy || submitting ? 'Saving' : undefined}
            onPress={() => void save()}
          />
        </View>
      </View>

      <WatchDetailsRows
        ruled={false}
        disabled={submitting}
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
        note={{
          kind: 'watch',
          value: noteDraft,
          onChangeText: setNoteDraft,
          maxLength: WATCH_NOTE_MAX_LENGTH,
          share: {
            visibility: shareAsReview ? 'public' : 'private',
            spoilers,
            onVisibility: (next) => {
              setShareAsReview(next === 'public');
              setFailure(null);
            },
            onSpoilers: setSpoilers,
          },
        }}
      />

      {failure ? (
        <Text
          variant="caption"
          tone="action"
          style={styles.failure}
          accessibilityLiveRegion="polite"
          testID={`watch-editor-error-${event.id}`}
        >
          {failure}
        </Text>
      ) : null}

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
  // The date block and the score, top-aligned: the circle's top meets the date row's.
  main: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
  },
  /**
   * Takes what the score leaves, so a long date wraps here rather than under the circle —
   * and so does the action line when it sits here (B4). Grows across, never down: in the
   * row only its width is flexible, and its height is its content's.
   */
  leadColumn: { flex: 1, minWidth: 0 },
  /**
   * The date block: the date and the metadata under it, sized by its own lines. The lines
   * sit `space[1]` apart at most, so they read as one block with the date.
   */
  lead: { gap: theme.space[1] },
  // The anchor: the card's one line in display weight.
  date: { fontFamily: fontFamily.sansSemibold },
  // The note, below the metadata with modest air above it.
  noteBlock: {
    gap: theme.space[1],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
  },
  more: { alignSelf: 'flex-start' },
  // Edit watch and Rerank. Wraps at large text; the card's bottom air is the row's own.
  actionLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: theme.space[4],
    paddingTop: theme.space[1],
    paddingBottom: theme.space[1],
  },
  // Under a note the line is the card's full width, so it takes the card's own gutter; in
  // the date block's column the top row's gutter already applies.
  actionLineInset: { paddingHorizontal: theme.layout.gutter },
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
  // A failed save's reason, inside the editor that still holds the draft.
  failure: { paddingHorizontal: theme.layout.gutter },
  // A full 44pt target for the destructive act, the word on the gutter.
  remove: {
    minHeight: theme.layout.minTapTarget,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: theme.layout.gutter,
    marginBottom: theme.space[1],
  },
});
