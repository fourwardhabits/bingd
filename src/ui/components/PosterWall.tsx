import { Ionicons } from '@expo/vector-icons';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';

import { formatScore, type Bucket } from '@/features/collection/score';

import { theme } from '../tokens';
import { Poster } from './Poster';
import { SectionHeader } from './SectionHeader';
import { Text } from './Text';

export type PosterTile = {
  id: string;
  title: string;
  year?: number | null;
  posterUri?: string | null;
  blurhash?: string | null;
  /** Chipped onto the corner. Only for a title this user has ranked. */
  score?: number | null;
  bucket?: Bucket | null;
  /** On the viewer's watchlist. Only meaningful where `onToggleSave` is given. */
  saved?: boolean;
};

/**
 * The two ways artwork appears in bulk (design-system.md §8).
 *
 * They are the app's only decorative surfaces and they earn it by being
 * low-detail on purpose. A wall of covers is atmosphere; a label on every tile
 * competes with the screen the user is trying to reach. Everything a tile
 * cannot show goes into its accessibility label instead, so the information is
 * absent from the design rather than absent from the app.
 */

export type PosterShelfProps = {
  title: string;
  tiles: PosterTile[];
  onPressTile: (tile: PosterTile) => void;
  /** Turns the header into a button to the full list. */
  onPressAll?: () => void;
};

/**
 * Horizontal shelf, with the last card clipped at ~70%.
 *
 * That clip is the whole affordance. A shelf that happens to end flush with the
 * screen edge looks like a complete set, and the user never learns there is
 * more — so the width is derived from the screen rather than fixed, to make the
 * partial card happen on purpose instead of by luck.
 */
export function PosterShelf({ title, tiles, onPressTile, onPressAll }: PosterShelfProps) {
  const { width } = useWindowDimensions();
  const { gap, peek } = theme.layout.posterShelf;

  // Solve for a card width that leaves `peek` of one visible at the right edge:
  // gutter + n cards + n gaps + peek*card = width.
  const available = width - theme.layout.gutter;
  const columns = Math.max(2, Math.round((available + gap) / (theme.poster.md.width + gap) - peek));
  const cardWidth = Math.floor((available - columns * gap) / (columns + peek));

  if (tiles.length === 0) return null;

  return (
    <View style={styles.shelf}>
      <SectionHeader
        title={title}
        actionLabel={onPressAll ? 'All' : undefined}
        onPressAction={onPressAll}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.shelfRow, { gap }]}
        // Free scrolling rather than snapping. A shelf that snaps implies pages,
        // and these are a continuous run of titles.
        decelerationRate="fast"
      >
        {tiles.map((tile) => (
          <Tile key={tile.id} tile={tile} width={cardWidth} onPress={() => onPressTile(tile)} />
        ))}
      </ScrollView>
    </View>
  );
}

export type PosterGridProps = {
  title?: string;
  tiles: PosterTile[];
  onPressTile: (tile: PosterTile) => void;
  onPressAll?: () => void;
  /**
   * Adds a watchlist control to every tile.
   *
   * Absent on the collection walls, which show things already in it. Present on For
   * You, where saving is the point of the screen and a trip through the title page to
   * do it would be the slowest possible route to the product's core action (PRD §28).
   */
  onToggleSave?: (tile: PosterTile) => void;
  /** Long-press, for anything a wall of unlabelled artwork cannot say. */
  onLongPressTile?: (tile: PosterTile) => void;
};

/**
 * Three across, tight gutters, no titles.
 *
 * Titles under a grid double its height and halve how much of a collection is
 * visible at once, which is the opposite of what a grid is for. Wide gutters on
 * a light ground make it read as scattered rather than as a wall.
 */
export function PosterGrid({
  title,
  tiles,
  onPressTile,
  onPressAll,
  onToggleSave,
  onLongPressTile,
}: PosterGridProps) {
  const { width } = useWindowDimensions();
  const { columns, gap } = theme.layout.posterGrid;

  const cardWidth = Math.floor(
    (width - theme.layout.gutter * 2 - gap * (columns - 1)) / columns,
  );

  if (tiles.length === 0) return null;

  return (
    <View style={styles.grid}>
      {title ? (
        <SectionHeader
          title={title}
          actionLabel={onPressAll ? 'All' : undefined}
          onPressAction={onPressAll}
        />
      ) : null}
      <View style={[styles.gridRows, { gap }]}>
        {tiles.map((tile) => (
          <Tile
            key={tile.id}
            tile={tile}
            width={cardWidth}
            onPress={() => onPressTile(tile)}
            onLongPress={onLongPressTile ? () => onLongPressTile(tile) : undefined}
            onToggleSave={onToggleSave ? () => onToggleSave(tile) : undefined}
          />
        ))}
      </View>
    </View>
  );
}

/**
 * One poster as a button.
 *
 * The label carries the title, the year and the score, because the tile shows
 * the first two nowhere and the third only as a two-character chip. A grid of
 * unlabelled images is the classic way to make a screen unusable without sight.
 */
function Tile({
  tile,
  width,
  onPress,
  onLongPress,
  onToggleSave,
}: {
  tile: PosterTile;
  width: number;
  onPress: () => void;
  onLongPress?: () => void;
  onToggleSave?: () => void;
}) {
  const { score } = tile;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={labelFor(tile)}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [{ width }, pressed && styles.pressed]}
    >
      <Poster uri={tile.posterUri} title={tile.title} blurhash={tile.blurhash} width={width} />
      {onToggleSave ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: Boolean(tile.saved) }}
          accessibilityLabel={
            tile.saved ? `Remove ${tile.title} from watchlist` : `Save ${tile.title} to watchlist`
          }
          onPress={onToggleSave}
          // A tile in a three-column grid is about 115pt wide, and a 44pt visual
          // control on it would cover most of the artwork. The glyph is 28pt and the
          // *touch target* is grown to the minimum with hitSlop, which is the only
          // way to keep both design-system.md §8's tap-target rule and a wall that
          // still reads as artwork.
          hitSlop={8}
          style={({ pressed }) => [styles.save, pressed && styles.pressed]}
        >
          <Ionicons
            name={tile.saved ? 'bookmark' : 'bookmark-outline'}
            size={16}
            color={theme.text.inverse}
          />
        </Pressable>
      ) : null}
      {score != null ? (
        <View
          // Maroon whatever the band, matching `ScoreBadge` since 2026-08-16. On a
          // wall the old bucket tint was at its worst: nine tiles, three colours,
          // none of them the poster's, all of them restating a number already
          // printed on top of them.
          style={styles.chip}
          // Already in the label above, and a chip that announces itself
          // separately makes every tile two stops instead of one.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text variant="caption" tone="inverse" allowFontScaling={false}>
            {formatScore(score)}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const labelFor = (tile: PosterTile) => {
  const parts = [tile.title];
  if (tile.year) parts.push(String(tile.year));
  if (tile.score != null) parts.push(`scored ${formatScore(tile.score)} out of 10`);
  // Announced on the tile as well as on its own control, because "Saved" is state a
  // sighted reader gets from a filled glyph they can see without touching anything.
  if (tile.saved) parts.push('saved');
  return parts.join(', ');
};

const styles = StyleSheet.create({
  shelf: { gap: theme.space[2] },
  shelfRow: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[1] },
  grid: { gap: theme.space[2] },
  gridRows: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: theme.layout.gutter,
  },
  save: {
    position: 'absolute',
    top: theme.space[1],
    right: theme.space[1],
    width: 28,
    height: 28,
    borderRadius: theme.radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.semantic.action,
  },
  chip: {
    position: 'absolute',
    right: theme.space[1],
    bottom: theme.space[1],
    minWidth: 34,
    paddingHorizontal: theme.space[1],
    paddingVertical: 2,
    borderRadius: theme.radius.control,
    alignItems: 'center',
    backgroundColor: theme.semantic.action,
  },
  pressed: { opacity: 0.7 },
});
