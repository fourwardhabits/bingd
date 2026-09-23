import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Bucket } from '@/features/collection/score';
import { ScoreBadge } from '@/ui/components';
import { theme } from '@/ui/tokens';

export type TitleRowActionsProps = {
  /** The name, for the controls' spoken labels. */
  name: string;
  kind: 'movie' | 'season' | 'series';
  /** The reader's own score, when the title is currently ranked — the only thing that changes what is drawn. */
  score: { score: number; bucket: Bucket | null } | null;
  /** On the reader's Watchlist. Null when unknown, which hides the bookmark. */
  saved: boolean | null;
  busy?: boolean;
  /**
   * The score or the `+`. The caller decides what the tap does from the internal state
   * (`rankingStateOf`): an unfinished native placement resumes its session, anything else
   * opens the ordinary log sheet. The row never shows which.
   */
  onRank: () => void;
  onToggleWatchlist: () => void;
};

/**
 * The trailing actions of a compact title row — **one contract for Search, Lists and every
 * other compact row** (design-system.md §11b).
 *
 * **Binary, by founder decision (final UI simplification, 2026-09-21):**
 *
 *   ranked        the reader's score circle, and nothing else.
 *   not ranked    the ordinary Maroon `+`, then the one-tap Watchlist bookmark — the same
 *                 for a title never touched, a watched or imported title never ranked, and a
 *                 ranking left unfinished. No dashed ring and no Finish pill: the incomplete
 *                 state stays internal, where the tap uses it to resume.
 *
 * A series cannot be ranked (PRD §10), so it never draws a score; its `+` leads to its
 * seasons. Share is not here: in browse and list contexts it is secondary, and the title
 * page carries it. Both controls carry `hitSlop` so each clears 44pt without growing the
 * row, and they are siblings of the row's own press target, not children of it.
 */
export function TitleRowActions({
  name,
  kind,
  score,
  saved,
  busy = false,
  onRank,
  onToggleWatchlist,
}: TitleRowActionsProps) {
  if (kind !== 'series' && score) {
    return (
      <View style={styles.actions} testID="title-row-actions-ranked">
        <ScoreBadge score={score.score} bucket={score.bucket} size="sm" onPress={onRank} />
      </View>
    );
  }

  return (
    <View style={styles.actions} testID="title-row-actions-unranked">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Log ${name}`}
        onPress={onRank}
        hitSlop={theme.space[2]}
        style={styles.action}
      >
        <Ionicons name="add-circle" size={theme.layout.icon.lg} color={theme.semantic.action} />
      </Pressable>

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
