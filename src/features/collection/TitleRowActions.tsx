import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Bucket } from '@/features/collection/score';
import { ScoreBadge } from '@/ui/components';
import { theme } from '@/ui/tokens';

export type TitleRowActionsProps = {
  /** The name, for the controls' spoken labels. */
  name: string;
  kind: 'movie' | 'season' | 'series';
  /** The reader's own score, when the title is currently ranked. */
  score: { score: number; bucket: Bucket } | null;
  /** Logged (seen) but not ranked — the dashed Rank ring rather than the `+`. */
  watched: boolean;
  /**
   * A bucket chosen in bingd with no completed placement (`rankingStateOf` → `unfinished`):
   * **Finish** rather than **Rank**. Never true for an import — a star is not a bucket.
   */
  unfinished?: boolean;
  /** On the reader's Watchlist. Null when unknown, which hides the bookmark. */
  saved: boolean | null;
  busy?: boolean;
  /** The score, the Rank ring and the `+` all open the ordinary log sheet. */
  onRank: () => void;
  onToggleWatchlist: () => void;
};

/**
 * The trailing actions of a compact title row — **one contract for Search and Lists**
 * (founder QA, 2026-09-21; design-system.md §11b, "compact title rows").
 *
 *   ranked        the reader's score circle, and nothing else. A saved-for-later
 *                 control beside a title they have already rated is noise.
 *   unfinished    **Finish** — a bucket chosen here, comparisons never completed — then
 *                 the bookmark. Distinct from Rank so a half-done ranking reads as one.
 *   not ranked    the Rank/log action — the dashed `Rank` ring when the title is logged
 *                 but unranked, the `+` when it is not logged at all — then the one-tap
 *                 Watchlist bookmark.
 *
 * A series cannot be ranked (PRD §10): it never draws a score or a Rank ring, only the
 * `+`, which leads to its seasons. Share is not here on purpose: in browse and list
 * contexts it is secondary, and the title page carries it.
 *
 * Both controls carry `hitSlop` so each clears 44pt without growing the row, and they are
 * siblings of the row's own press target, not children of it.
 */
export function TitleRowActions({
  name,
  kind,
  score,
  watched,
  unfinished = false,
  saved,
  busy = false,
  onRank,
  onToggleWatchlist,
}: TitleRowActionsProps) {
  const rankable = kind !== 'series';

  if (rankable && score) {
    return (
      <View style={styles.actions} testID="title-row-actions-ranked">
        <ScoreBadge score={score.score} bucket={score.bucket} size="sm" onPress={onRank} />
      </View>
    );
  }

  return (
    <View style={styles.actions} testID="title-row-actions-unranked">
      {rankable && unfinished ? (
        <ScoreBadge size="sm" unfinished onPress={onRank} />
      ) : rankable && watched ? (
        <ScoreBadge size="sm" onPress={onRank} />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Log ${name}`}
          onPress={onRank}
          hitSlop={theme.space[2]}
          style={styles.action}
        >
          <Ionicons name="add-circle" size={theme.layout.icon.lg} color={theme.semantic.action} />
        </Pressable>
      )}

      {saved !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: saved, disabled: busy }}
          accessibilityLabel={saved ? `Remove ${name} from Watchlist` : `Add ${name} to Watchlist`}
          // `void`, not a returned promise: a handler that returns one makes the press
          // await the whole write.
          onPress={() => void onToggleWatchlist()}
          disabled={busy}
          hitSlop={theme.space[3]}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Ionicons
            name={saved ? 'bookmark' : 'bookmark-outline'}
            size={theme.layout.icon.md}
            color={saved ? theme.semantic.action : theme.text.secondary}
          />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  action: { alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7 },
});
