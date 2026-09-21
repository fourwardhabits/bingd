import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View, type AccessibilityActionEvent } from 'react-native';

import { Poster, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import type { ListItem } from './types';

const KIND_LABEL = { movie: 'Movie', season: 'Season', series: 'Series' } as const;

export type ListItemRowProps = {
  item: ListItem;
  /** Drawn only when the list is numbered. The ordinal, never the stored position. */
  showNumber: boolean;
  onPress: () => void;
  /**
   * Toggles the viewer's own Watchlist. Absent on the edit screen, where the row's
   * controls are about the *list* rather than about the reader.
   */
  onToggleWatchlist?: () => void;
  busy?: boolean;
  /**
   * The number drawn when the list is numbered. Defaults to the server's ordinal; the
   * list page passes the row's place in the order it is drawing, so the numbers follow
   * a drag the moment it lands rather than when the refetch does.
   */
  number?: number;
  /** The owner's lift for drag-to-reorder. Absent for a viewer. */
  onLongPress?: () => void;
  onPressOut?: () => void;
  /** The owner's per-row ⋯ (*Remove from list*). Absent for a viewer. */
  onMore?: () => void;
  /** The same moves as the drag, reachable without it (owner only). */
  accessibilityActions?: { name: string; label: string }[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
};

/**
 * One title on a list.
 *
 * ---------------------------------------------------------------------------
 * THE TRAILING CONTROL IS ONE OF TWO THINGS, AND NEVER THREE
 *
 * **Seen** is a tick and it is **inert**. There is nothing useful to offer somebody
 * about a title they have already watched from inside a list, and a control that did
 * something there would have to mean "log it again", which belongs on the title page.
 *
 * **Unseen** is the ordinary bookmark — the one-title Watchlist add, the same control
 * with the same meaning as everywhere else in the app.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NEVER A SCORE HERE
 *
 * Not the owner's, not the viewer's, not the community's. §F.11 is blunt about it: a
 * list never exposes the owner's scores, positions, buckets, watch dates or notes. A
 * curated list is a statement about what belongs together, and a column of numbers down
 * the side would quietly turn it into a ranking the owner did not make.
 */
export function ListItemRow({
  item,
  showNumber,
  onPress,
  onToggleWatchlist,
  busy = false,
  number,
  onLongPress,
  onPressOut,
  onMore,
  accessibilityActions,
  onAccessibilityAction,
}: ListItemRowProps) {
  const shown = number ?? item.ordinal;
  const detail = [item.year, KIND_LABEL[item.kind]].filter(Boolean).join(' · ');
  const seen = item.seen === true;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        showNumber ? `${shown}.` : null,
        item.name,
        detail,
        seen ? 'Seen' : null,
      ]
        .filter(Boolean)
        .join(' ')}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressOut={onPressOut}
      delayLongPress={350}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {showNumber ? (
        <Text
          variant="ordinal"
          tone="tertiary"
          style={styles.ordinal}
          // Spoken as part of the row's own label above, so it is not met twice.
          accessibilityElementsHidden
        >
          {shown}
        </Text>
      ) : null}

      <Poster uri={item.posterUri} title={item.name} size="row" />

      <View style={styles.lines}>
        <Text variant="callout" numberOfLines={2}>
          {item.name}
        </Text>
        {detail ? (
          <Text variant="footnote" tone="tertiary">
            {detail}
          </Text>
        ) : null}
      </View>

      {seen ? (
        <Ionicons
          name="checkmark"
          size={theme.layout.icon.md}
          color={theme.text.tertiary}
          // Inert, and said in the row's label. A tick that is in the tree twice reads
          // as a control the reader then cannot find.
          accessibilityElementsHidden
        />
      ) : onToggleWatchlist && item.watchlisted !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: item.watchlisted, disabled: busy }}
          accessibilityLabel={
            item.watchlisted ? `Remove ${item.name} from your Watchlist` : `Save ${item.name}`
          }
          disabled={busy}
          hitSlop={theme.space[2]}
          onPress={onToggleWatchlist}
        >
          <Ionicons
            name={item.watchlisted ? 'bookmark' : 'bookmark-outline'}
            size={theme.layout.icon.md}
            color={item.watchlisted ? theme.semantic.action : theme.text.secondary}
          />
        </Pressable>
      ) : (
        // An anonymous reader, or the edit screen. A fixed box so the rows stay
        // aligned whether or not a control is drawn.
        <View style={styles.spacer} />
      )}

      {onMore ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Options for ${item.name}`}
          hitSlop={theme.space[2]}
          onPress={onMore}
          testID={`list-item-more-${item.mediaItemId}`}
        >
          <Ionicons
            name="ellipsis-horizontal"
            size={theme.layout.icon.md}
            color={theme.text.tertiary}
          />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[2],
    minHeight: theme.layout.minTapTarget,
  },
  // Wide enough for three digits, so a list of 100+ does not shift its posters at the
  // hundredth row.
  ordinal: { minWidth: 28, textAlign: 'right' },
  lines: { flex: 1, gap: 2 },
  spacer: { width: theme.layout.icon.md },
  pressed: { opacity: 0.7 },
});
