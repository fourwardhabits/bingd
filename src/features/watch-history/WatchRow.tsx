import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { CompanionPicker } from '@/features/collection/CompanionPicker';
import { formatWatchDate, today } from '@/features/collection/dates';
import { taggableWith, type Person } from '@/features/collection/use-companions';
import { WatchDatePicker } from '@/features/collection/WatchDatePicker';
import { theme } from '@/ui/tokens';
import { Button, Field, SheetRow, Text } from '@/ui/components';

import { isFromDiary, type WatchEvent, type WatchRowLabel } from './watch-history';

/** The same ceiling `set_watch_details` enforces through `watch_tags.max_per_watch`. */
const MAX_COMPANIONS = 10;

export type WatchEdit = {
  /** Present only when the date was changed; null clears it. */
  watchedOn?: string | null;
  /** Present only when the note or the companions changed. */
  details?: { note: string | null; companionIds: string[] };
};

export type WatchRowProps = {
  event: WatchEvent;
  label: WatchRowLabel;
  /** Where the title stood after this viewing, collapsed from the ledger (`placementsByWatch`). */
  placement?: { position: number; categorySize: number };
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
 * One viewing, drawn like a feed row (founder QA, 2026-09-21).
 *
 * The date leads — *Sep 21, 2026 (First watch)* — with where the title stood after that
 * viewing on the right, *#4 of 11*, and the viewing's own details underneath when there are
 * any: who it was watched with and the note. There is no movement line here; each row
 * already carries its placement, so *Moved from…* belongs to the ranking's reveal alone.
 *
 * ---------------------------------------------------------------------------
 * **EDITED INLINE, AND THAT IS A STRUCTURAL DECISION** (§J.2)
 *
 * The pencil opens the editor in place — date, companions, note — rather than a sheet: a
 * row action inside a presented sheet is a view other sheets cannot then stack on, and the
 * ranking flow stacks sheets. So there is no modal here, at any depth.
 */
export function WatchRow({
  event,
  label,
  placement,
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
  const dateLabel = event.watchedOn ? formatWatchDate(event.watchedOn) : 'Earlier';
  // "First watch" only when it is first *and* dated (§D.2). The undated viewing reads
  // *Earlier*, which is the same word the When row uses for the choice that produces it.
  const primary = label === 'first' ? `${dateLabel} (First watch)` : dateLabel;
  const source = isFromDiary(event) ? 'From Letterboxd' : null;
  const withLine = companions.length
    ? `With ${companions.map((person) => person.name).join(', ')}`
    : null;

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
            <Text variant="body" tone="secondary" testID={`watch-note-${event.id}`}>
              {note}
            </Text>
          ) : null}
        </View>

        <View style={styles.side}>
          {placement ? (
            <Text
              variant="ordinal"
              tone="secondary"
              testID={`watch-placement-${event.id}`}
            >{`#${placement.position} of ${placement.categorySize}`}</Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Edit this watch"
            hitSlop={12}
            onPress={editing ? onDismissEdit : onEdit}
            testID={`watch-edit-${event.id}`}
          >
            <Ionicons name="pencil" size={16} color={theme.text.tertiary} />
          </Pressable>
        </View>
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
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState(note ?? '');
  const [selected, setSelected] = useState(() => companions.map((person) => person.id));

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );

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
      <SheetRow
        icon="calendar-outline"
        label="When?"
        value={date === null ? 'Earlier' : formatWatchDate(date)}
        expanded={picking}
        onPress={() => setPicking((was) => !was)}
      />
      {picking ? (
        <WatchDatePicker
          value={date}
          anchor={date ?? today()}
          onChange={(iso) => {
            setDate(iso);
            setPicking(false);
          }}
          // *Date not recorded* is an allowed answer here, exactly as *Earlier* is in the
          // log sheet (§J.2). Forgetting when is a state, not a failure to finish.
          onClear={() => {
            setDate(null);
            setPicking(false);
          }}
        />
      ) : null}

      <Text variant="footnote" tone="secondary">
        Watched with
      </Text>
      <CompanionPicker
        people={taggableWith(people, companions)}
        selected={selected}
        onToggle={toggle}
        max={MAX_COMPANIONS}
        loading={peopleLoading}
      />

      <Field
        label="Note"
        hint="Only you can see notes on a watch."
        value={draft}
        onChangeText={setDraft}
        maxLength={1000}
        multiline
      />

      <View style={styles.actions}>
        <Button label="Cancel" kind="secondary" onPress={onCancel} />
        <Button label="Save" disabled={busy} onPress={save} />
      </View>

      {/**
       * **The only watch says something different, because the server refuses it.**
       *
       * `delete_watch_event` raises `P0001 last_watch` rather than leaving a collection row
       * with no viewing behind it (§D.0). The row says what the reader actually means.
       */}
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={onRemove}
        style={styles.remove}
        testID={`watch-remove-${event.id}`}
      >
        <Text variant="body" tone="action">
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
  side: { alignItems: 'flex-end', gap: theme.space[2] },
  editor: { marginTop: theme.space[3], gap: theme.space[3] },
  actions: { flexDirection: 'row', gap: theme.space[3], justifyContent: 'flex-end' },
  remove: { paddingVertical: theme.space[1] },
});
