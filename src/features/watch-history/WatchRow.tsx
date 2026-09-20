import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { formatWatchDate, today } from '@/features/collection/dates';
import { WatchDatePicker } from '@/features/collection/WatchDatePicker';
import { theme } from '@/ui/tokens';
import { Text } from '@/ui/components';

import {
  isFromDiary,
  movementDirection,
  movementSentence,
  type WatchEvent,
  type WatchRowLabel,
} from './watch-history';

export type WatchRowProps = {
  event: WatchEvent;
  label: WatchRowLabel;
  /** The private movement this viewing produced, if it produced one (§E.2). */
  movement?: { outcome: 'placed' | 'moved' | 'unchanged' | 'kept'; fromPosition: number | null };
  position?: number;
  /** Whether this is the title's only viewing, which changes what ⋯ offers. */
  onlyWatch: boolean;
  editing: boolean;
  onEdit: () => void;
  onDismissEdit: () => void;
  onChangeDate: (iso: string | null) => void;
  onRemove: () => void;
  busy?: boolean;
};

/**
 * One viewing.
 *
 * ---------------------------------------------------------------------------
 * **THE DATE IS EDITED INLINE, AND THAT IS A STRUCTURAL DECISION** (§J.2)
 *
 * A pushed screen has the room for a date grid to open in place, and using it keeps the
 * iOS two-modal rule out of this surface entirely: a row action inside a presented sheet
 * is a view other sheets cannot then stack on, and the ranking flow stacks sheets. The
 * whole reason §J.2 rejected a bottom sheet for this screen — Revision 2 proposed one —
 * is that a history is a list with row-level actions and a keyboard-adjacent date field,
 * which is a screen's job.
 *
 * So there is no modal here, at any depth. ⋯ toggles the row open; the grid appears
 * under it; tapping a date writes and closes.
 */
export function WatchRow({
  event,
  label,
  movement,
  position,
  onlyWatch,
  editing,
  onEdit,
  onDismissEdit,
  onChangeDate,
  onRemove,
  busy = false,
}: WatchRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  // "First watch" only when it is first *and* dated (§D.2). The undated viewing reads
  // *Earlier*, which is the same word the When row uses for the choice that produces it.
  const title =
    label === 'earlier' ? 'Earlier' : label === 'first' ? 'First watch' : 'Rewatch';

  const dateLabel = event.watchedOn ? formatWatchDate(event.watchedOn) : null;
  const source = isFromDiary(event) ? 'Letterboxd' : null;

  const detail =
    label === 'earlier'
      ? 'Date not recorded'
      : [source && `from ${source}`].filter(Boolean).join(' · ') || null;

  const moved =
    movement && position !== undefined ? movementSentence(movement, position) : null;
  const direction =
    movement && position !== undefined ? movementDirection(movement, position) : null;

  return (
    <View style={styles.row} testID={`watch-row-${event.id}`}>
      <View style={styles.main}>
        <Text variant="caption" tone="tertiary" style={styles.date}>
          {dateLabel ?? 'Earlier'}
        </Text>

        <View style={styles.body}>
          <Text variant="body">
            {title}
            {detail ? <Text variant="body" tone="tertiary">{` · ${detail}`}</Text> : null}
          </Text>

          {/**
           * **Private, and exact at any depth** (§B.2, §E.2). `Moved from #118 → #72`
           * appears here and on the reveal and nowhere else — the feed payload carries no
           * ordinal at all, so there is no public counterpart of this line to keep in
           * step with.
           */}
          {moved ? (
            <Text variant="caption" tone="secondary" testID={`watch-movement-${event.id}`}>
              {moved}
              {direction ? (direction === 'up' ? '  ↑' : '  ↓') : ''}
            </Text>
          ) : null}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Watch options"
          hitSlop={12}
          onPress={() => setMenuOpen((open) => !open)}
          style={styles.more}
        >
          <Ionicons name="ellipsis-horizontal" size={18} color={theme.text.tertiary} />
        </Pressable>
      </View>

      {menuOpen ? (
        <View style={styles.menu}>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setMenuOpen(false);
              onEdit();
            }}
            style={styles.menuItem}
          >
            <Text variant="body" tone="action">
              Change date
            </Text>
          </Pressable>

          {/**
           * **The only watch says something different, because the server refuses it.**
           *
           * `delete_watch_event` raises `P0001 last_watch` rather than leaving a
           * collection row with no viewing behind it (§D.0). Offering *Remove this watch*
           * and then showing an error would be a control that exists to fail; the row
           * says what the reader actually means instead.
           */}
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => {
              setMenuOpen(false);
              onRemove();
            }}
            style={styles.menuItem}
          >
            <Text variant="body" tone="action">
              {onlyWatch ? 'Remove from collection…' : 'Remove this watch'}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {editing ? (
        <View style={styles.editor}>
          <WatchDatePicker
            value={event.watchedOn}
            anchor={event.watchedOn ?? today()}
            onChange={(iso) => {
              onChangeDate(iso);
              onDismissEdit();
            }}
            // *Date not recorded* is an allowed answer here, exactly as *Earlier* is in
            // the log sheet (§J.2). Forgetting when is a state, not a failure to finish.
            onClear={() => {
              onChangeDate(null);
              onDismissEdit();
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
  },
  main: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space[3] },
  // A fixed column, so the labels line up down the list rather than stepping in and out
  // with the width of "Yesterday" against "Mar 3".
  date: { width: 72 },
  body: { flex: 1, gap: theme.space[1] },
  more: { paddingLeft: theme.space[2] },
  menu: {
    marginTop: theme.space[2],
    marginLeft: 72 + theme.space[3],
    gap: theme.space[2],
  },
  menuItem: { paddingVertical: theme.space[1] },
  editor: { marginTop: theme.space[2] },
});
