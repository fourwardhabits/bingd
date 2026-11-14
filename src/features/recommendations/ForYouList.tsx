import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { ScoreBadge, TitleRow, type PosterTile } from '@/ui/components';
import { theme } from '@/ui/tokens';

/** A wall tile, plus what a row says under the title that a poster leaves to its artwork. */
export type ForYouListTile = PosterTile & { kind?: 'movie' | 'series' | 'season' };

export type ForYouListProps = {
  /** The wall's own tiles, in the wall's own order: nothing is re-derived here. */
  tiles: readonly ForYouListTile[];
  onPressTile: (tile: PosterTile) => void;
  onToggleSave: (tile: PosterTile) => void;
  /** Absent on Top Rated, exactly as the poster wall's X is. */
  onDismissTile?: (tile: PosterTile) => void;
};

/**
 * **For You as a list** (FU1113-C): the poster wall's view mode, not a second wall.
 *
 * It is handed the **same tiles** the `PosterGrid` would draw and the **same three
 * handlers** — open, bookmark, dismiss — so a row can only ever hold the ids, the order
 * and the eligibility the wall holds, and pressing anything does exactly what the poster's
 * control does. A row is `TitleRow`'s compact anatomy: the poster thumbnail, the title and
 * year, and the kind under it.
 *
 * The trailing controls follow `TitleRowActions`' layout (glyph sizes, 12pt apart, slop to
 * 44pt) but not its binary: there is no `+` on this wall, because poster mode offers none,
 * and the reader's own score on Top Rated is drawn beside the bookmark, display-only, as
 * the poster's chip is. The spoken labels are the poster's own, so a screen reader hears
 * the same control in either mode.
 */
export function ForYouList({ tiles, onPressTile, onToggleSave, onDismissTile }: ForYouListProps) {
  return (
    <View testID="for-you-list">
      {tiles.map((tile, index) => (
        <TitleRow
          key={tile.id}
          title={tile.title}
          year={tile.year ?? null}
          posterUri={tile.posterUri ?? null}
          secondary={tile.kind ? KIND_LABEL[tile.kind] : undefined}
          divided={index < tiles.length - 1}
          onPress={() => onPressTile(tile)}
          trailing={
            <View style={styles.actions} testID={`for-you-row-actions-${tile.id}`}>
              {tile.score != null ? (
                <ScoreBadge score={tile.score} bucket={tile.bucket ?? null} size="sm" />
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: Boolean(tile.saved) }}
                accessibilityLabel={
                  tile.saved
                    ? `Remove ${tile.title} from watchlist`
                    : `Save ${tile.title} to watchlist`
                }
                onPress={() => onToggleSave(tile)}
                hitSlop={theme.space[3]}
                style={({ pressed }) => [styles.action, pressed && styles.pressed]}
              >
                <Ionicons
                  name={tile.saved ? 'bookmark' : 'bookmark-outline'}
                  size={theme.layout.icon.md}
                  color={tile.saved ? theme.semantic.action : theme.text.secondary}
                />
              </Pressable>
              {onDismissTile ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Not interested in ${tile.title}`}
                  accessibilityHint="Removes it from your recommendations"
                  onPress={() => onDismissTile(tile)}
                  hitSlop={theme.space[3]}
                  style={({ pressed }) => [styles.action, pressed && styles.pressed]}
                >
                  {/* Quiet rather than Maroon: dismissal is an exit, as on the poster. */}
                  <Ionicons name="close" size={theme.layout.icon.md} color={theme.text.tertiary} />
                </Pressable>
              ) : null}
            </View>
          }
        />
      ))}
    </View>
  );
}

/** The kind, in the words the rest of the app uses for it. */
const KIND_LABEL: Record<NonNullable<ForYouListTile['kind']>, string> = {
  movie: 'Movie',
  series: 'TV show',
  season: 'TV season',
};

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  action: { alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7 },
});
