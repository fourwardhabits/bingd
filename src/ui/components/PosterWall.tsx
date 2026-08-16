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
};

/**
 * Three across, tight gutters, no titles.
 *
 * Titles under a grid double its height and halve how much of a collection is
 * visible at once, which is the opposite of what a grid is for. Wide gutters on
 * a light ground make it read as scattered rather than as a wall.
 */
export function PosterGrid({ title, tiles, onPressTile, onPressAll }: PosterGridProps) {
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
          <Tile key={tile.id} tile={tile} width={cardWidth} onPress={() => onPressTile(tile)} />
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
}: {
  tile: PosterTile;
  width: number;
  onPress: () => void;
}) {
  const { score, bucket } = tile;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={labelFor(tile)}
      onPress={onPress}
      style={({ pressed }) => [{ width }, pressed && styles.pressed]}
    >
      <Poster uri={tile.posterUri} title={tile.title} blurhash={tile.blurhash} width={width} />
      {score != null && bucket != null ? (
        <View
          style={[styles.chip, { backgroundColor: theme.bucket[bucketKey(bucket)] }]}
          // Already in the label above, and a chip that announces itself
          // separately makes every tile two stops instead of one.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text variant="caption" style={{ color: theme.bucketInk[bucketKey(bucket)] }}>
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
  return parts.join(', ');
};

const bucketKey = (bucket: Bucket): 'loved' | 'fine' | 'notForMe' =>
  bucket === 'not_for_me' ? 'notForMe' : bucket;

const styles = StyleSheet.create({
  shelf: { gap: theme.space[2] },
  shelfRow: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[1] },
  grid: { gap: theme.space[2] },
  gridRows: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: theme.layout.gutter,
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
  },
  pressed: { opacity: 0.7 },
});
