import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { formatWatchDate } from '@/features/collection/dates';
import type { Bucket } from '@/features/collection/score';
import { taggableWith, type Person } from '@/features/collection/use-companions';
import { theme } from '@/ui/tokens';
import { Button, ScoreBadge, Text } from '@/ui/components';

import { WatchDetailsRows } from './WatchDetailsRows';
import { isFromDiary, type WatchEvent, type WatchRowLabel, type WatchScore } from './watch-history';

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
 * **Edit** is a small text action, and editing reuses the log sheet's own rows
 * (`WatchDetailsRows`) inline — no modal, so the ranking flow's sheets can still stack.
 * Editing a watch never touches the current ranking; that changes through Update your
 * rating.
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
      <View style={styles.main}>
        <View style={styles.body}>
          <Text variant="headline" testID={`watch-date-${event.id}`}>
            {primary}
          </Text>
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
              variant="body"
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
            >
              <Text variant="footnote" tone="action">
                {expanded ? 'Less' : 'More'}
              </Text>
            </Pressable>
          ) : null}

          {editing ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Edit this watch, ${dateLabel}`}
              hitSlop={theme.space[2]}
              onPress={onEdit}
              style={styles.edit}
              testID={`watch-edit-${event.id}`}
            >
              <Ionicons name="pencil" size={11} color={theme.semantic.action} />
              <Text variant="caption" tone="action">
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
          onSave={(edit) => {
            onSave(edit);
            onDismissEdit();
          }}
          onRemove={onRemove}
        />
      ) : null}
    </View>
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
}: {
  event: WatchEvent;
  note: string | null;
  companions: Person[];
  people: Person[];
  peopleLoading: boolean;
  onlyWatch: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (edit: WatchEdit) => void;
  onRemove: () => void;
}) {
  const [date, setDate] = useState(event.watchedOn);
  const [draft, setDraft] = useState(note ?? '');
  const [selected, setSelected] = useState(() => companions.map((person) => person.id));

  const save = () => {
    const edit: WatchEdit = {};
    if (date !== event.watchedOn) edit.watchedOn = date;
    const nextNote = draft.trim() ? draft.trim() : null;
    const before = companions.map((person) => person.id).sort().join(',');
    const after = [...selected].sort().join(',');
    if (nextNote !== (note ?? null) || before !== after) {
      edit.details = { note: nextNote, companionIds: selected };
    }
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
        note={draft}
        onNote={setDraft}
      />

      <View style={styles.actions}>
        <Button label="Cancel" kind="secondary" size="sm" onPress={onCancel} />
        <Button label="Save" size="sm" disabled={busy} onPress={save} />
      </View>

      {/* The only watch says something different, because the server refuses it
          (`P0001 last_watch`): the reader means the title should leave the collection. */}
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={onRemove}
        style={styles.remove}
        testID={`watch-remove-${event.id}`}
      >
        <Text variant="footnote" tone="action">
          {onlyWatch ? 'Remove from collection…' : 'Remove this watch'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
  },
  main: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space[3] },
  body: { flex: 1, gap: theme.space[1] },
  edit: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[1],
    alignSelf: 'flex-start',
    paddingTop: theme.space[1],
  },
  // Pulled out to the screen's edges so the log sheet's rows sit at their own gutters.
  editor: { marginTop: theme.space[3], marginHorizontal: -theme.layout.gutter, gap: theme.space[3] },
  actions: {
    flexDirection: 'row',
    gap: theme.space[3],
    justifyContent: 'flex-end',
    paddingHorizontal: theme.layout.gutter,
  },
  remove: { paddingVertical: theme.space[1], paddingHorizontal: theme.layout.gutter },
});
