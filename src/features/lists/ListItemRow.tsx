import { Pressable, StyleSheet, View, type AccessibilityActionEvent } from 'react-native';

import { TitleRowActions } from '@/features/collection/TitleRowActions';
import type { Bucket } from '@/features/collection/score';
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
   * The number drawn when the list is numbered. Defaults to the server's ordinal; the
   * list page passes the row's place in the order it is drawing, so the numbers follow
   * a drag the moment it lands rather than when the refetch does.
   */
  number?: number;
  /** The reader's own score, when they have this title ranked (`useMyScores`). */
  score?: { score: number; bucket: Bucket } | null;
  /** A bucket chosen in bingd, no completed placement: **Finish** (`rankingStateOf`). */
  unfinished?: boolean;
  /** Opens the ordinary log sheet — the score, the Rank ring and the `+` all do. */
  onRank?: () => void;
  /** Toggles the reader's own Watchlist. */
  onToggleWatchlist?: () => void;
  busy?: boolean;
  /** The owner's lift for drag-to-reorder. Absent for a viewer. */
  onLongPress?: () => void;
  onPressOut?: () => void;
  /** The same moves as the drag, and Remove, reachable without either gesture. */
  accessibilityActions?: { name: string; label: string }[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
};

/**
 * One title on a list.
 *
 * ---------------------------------------------------------------------------
 * THE TRAILING ACTIONS ARE THE SHARED COMPACT-ROW CONTRACT
 *
 * `TitleRowActions`, exactly as Search draws it (founder QA, 2026-09-21): the reader's own
 * score circle when they have it ranked; otherwise the Rank/log action and the one-tap
 * Watchlist. These are the *reader's* state, never the owner's — §F.11 still holds: a list
 * never shows its owner's scores, positions, buckets, dates or notes.
 *
 * ---------------------------------------------------------------------------
 * THE NUMBER TAKES THE POSTER'S ANCHOR, IT DOES NOT PUSH THE ROW
 *
 * A numbered list used to insert a number column in front of the poster, so switching
 * Numbered on slid every poster and title to the right. Now the number is a small plate
 * centred on the poster's own centre line, sitting on its lower edge: the poster, the
 * title and the trailing actions are at the same x whether Numbered is on or off, and a
 * 1-, 2- or 3-digit number grows symmetrically about that line (design-system.md §11b).
 */
export function ListItemRow({
  item,
  showNumber,
  onPress,
  number,
  score = null,
  unfinished = false,
  onRank,
  onToggleWatchlist,
  busy = false,
  onLongPress,
  onPressOut,
  accessibilityActions,
  onAccessibilityAction,
}: ListItemRowProps) {
  const detail = [item.year, KIND_LABEL[item.kind]].filter(Boolean).join(' · ');
  const shown = number ?? item.ordinal;

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[
          showNumber ? `${shown}.` : null,
          item.name,
          detail,
          score ? null : item.seen === true ? 'Seen' : null,
        ]
          .filter(Boolean)
          .join(' ')}
        onPress={onPress}
        onLongPress={onLongPress}
        onPressOut={onPressOut}
        delayLongPress={350}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={onAccessibilityAction}
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}
      >
        <View style={styles.posterAnchor} testID={`list-poster-anchor-${item.mediaItemId}`}>
          <Poster uri={item.posterUri} title={item.name} size="row" />
          {showNumber ? (
            <View style={styles.numberPlate} testID={`list-number-${item.mediaItemId}`}>
              <Text
                variant="caption"
                tone="inverse"
                style={styles.numberText}
                // Spoken as part of the row's own label above, so it is not met twice.
                accessibilityElementsHidden
              >
                {shown}
              </Text>
            </View>
          ) : null}
        </View>

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
      </Pressable>

      {onRank && onToggleWatchlist && item.seen !== null ? (
        <TitleRowActions
          name={item.name}
          kind={item.kind}
          score={score}
          watched={item.seen === true}
          unfinished={unfinished}
          saved={item.watchlisted}
          busy={busy}
          onRank={onRank}
          onToggleWatchlist={onToggleWatchlist}
        />
      ) : null}
    </View>
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
    // Opaque, so a row slid aside to reveal Remove does not show the action through it.
    backgroundColor: theme.surface.base,
  },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  // The poster's own box: the number plate is positioned against it, so it can never
  // widen the row.
  posterAnchor: { width: theme.poster.row.width, height: theme.poster.row.height },
  numberPlate: {
    position: 'absolute',
    bottom: 3,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  numberText: {
    minWidth: 18,
    paddingHorizontal: 4,
    borderRadius: theme.radius.control,
    overflow: 'hidden',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    backgroundColor: theme.semantic.action,
  },
  lines: { flex: 1, gap: 2 },
  pressed: { opacity: 0.7 },
});
