import { Ionicons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';

import { formatScore, type Bucket } from '@/features/collection/score';

import { hapticSelection } from '../haptics';
import { usePressScale, usePulse } from '../press';
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
  /**
   * Whether the shelf draws its own heading.
   *
   * False when a caller has already put the title somewhere the shelf cannot reach — the
   * Feed draws it in a content header row shared with the mode toggle, and the same words
   * twice would be worse than either. `title` stays required: it is the shelf's
   * accessible name whether or not it is painted.
   */
  showTitle?: boolean;
};

/**
 * Horizontal shelf, with the last card clipped at ~70%.
 *
 * That clip is the whole affordance. A shelf that happens to end flush with the
 * screen edge looks like a complete set, and the user never learns there is
 * more — so the width is derived from the screen rather than fixed, to make the
 * partial card happen on purpose instead of by luck.
 */
export function PosterShelf({
  title,
  tiles,
  onPressTile,
  onPressAll,
  showTitle = true,
}: PosterShelfProps) {
  const { width } = useWindowDimensions();
  const { gap, peek } = theme.layout.posterShelf;

  // Solve for a card width that leaves `peek` of one visible at the right edge:
  // gutter + n cards + n gaps + peek*card = width.
  const available = width - theme.layout.gutter;
  const columns = Math.max(
    2,
    Math.round((available + gap) / (theme.poster.md.width + gap) - peek),
  );
  const cardWidth = Math.floor((available - columns * gap) / (columns + peek));

  if (tiles.length === 0) return null;

  return (
    <View style={styles.shelf} accessibilityLabel={showTitle ? undefined : title}>
      {showTitle ? (
        <SectionHeader
          title={title}
          level="title"
          actionLabel={onPressAll ? 'All' : undefined}
          onPressAction={onPressAll}
        />
      ) : null}
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
  /**
   * Adds a dismiss control under the watchlist one (founder, 2026-08-27).
   *
   * Only meaningful on a wall of *suggestions* — For You — where "not this one" is
   * feedback the reader has no other way to give. Collection walls show things the
   * reader chose, so they never pass it. Restrained on purpose: the same 28pt
   * corner treatment as the bookmark, an X rather than a word, and the label says
   * the act ("Not interested") because the glyph alone says nothing to a screen
   * reader.
   */
  onDismissTile?: (tile: PosterTile) => void;
  /**
   * Sets the first tile at twice the width beside the next two. For a wall in rank order
   * only, where the composition then states the ranking: Top ranked on a profile.
   */
  lead?: boolean;
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
  onDismissTile,
  onLongPressTile,
  lead = false,
}: PosterGridProps) {
  const { width } = useWindowDimensions();
  const { columns, gap } = theme.layout.posterGrid;

  const cardWidth = Math.floor(
    (width - theme.layout.gutter * 2 - gap * (columns - 1)) / columns,
  );

  if (tiles.length === 0) return null;

  const [first, second, third] = tiles;
  const mosaic = lead && first && second && third ? { first, second, third } : null;

  return (
    <View style={styles.grid}>
      {title ? (
        <SectionHeader
          title={title}
          level="title"
          actionLabel={onPressAll ? 'All' : undefined}
          onPressAction={onPressAll}
        />
      ) : null}
      {mosaic ? (
        <View style={[styles.leadRow, { gap }]}>
          {/* The same handlers as every other tile, so a caller's long press, save and
              dismiss reach the first three as well. */}
          <Tile
            tile={mosaic.first}
            width={cardWidth * 2 + gap}
            onPress={() => onPressTile(mosaic.first)}
            onLongPress={onLongPressTile ? () => onLongPressTile(mosaic.first) : undefined}
            onToggleSave={onToggleSave ? () => onToggleSave(mosaic.first) : undefined}
            onDismiss={onDismissTile ? () => onDismissTile(mosaic.first) : undefined}
          />
          {/* One and a half gaps: two posters and a gap must equal the lead's height. */}
          <View style={{ gap: gap * 1.5 }}>
            {[mosaic.second, mosaic.third].map((tile) => (
              <Tile
                key={tile.id}
                tile={tile}
                width={cardWidth}
                onPress={() => onPressTile(tile)}
                onLongPress={onLongPressTile ? () => onLongPressTile(tile) : undefined}
                onToggleSave={onToggleSave ? () => onToggleSave(tile) : undefined}
                onDismiss={onDismissTile ? () => onDismissTile(tile) : undefined}
              />
            ))}
          </View>
        </View>
      ) : null}
      <View style={[styles.gridRows, { gap }]}>
        {(mosaic ? tiles.slice(3) : tiles).map((tile) => (
          <Tile
            key={tile.id}
            tile={tile}
            width={cardWidth}
            onPress={() => onPressTile(tile)}
            onLongPress={onLongPressTile ? () => onLongPressTile(tile) : undefined}
            onToggleSave={onToggleSave ? () => onToggleSave(tile) : undefined}
            onDismiss={onDismissTile ? () => onDismissTile(tile) : undefined}
          />
        ))}
      </View>
    </View>
  );
}

export type PosterGridListProps = {
  tiles: PosterTile[];
  onPressTile: (tile: PosterTile) => void;
  /** Space above the first row and below the last, inside the scroller. */
  paddingTop?: number;
  paddingBottom?: number;
};

/**
 * The same three-across wall as `PosterGrid`, **virtualised**, for a wall with no upper
 * bound (2026-09-16).
 *
 * `PosterGrid` draws every tile it is given into whatever scroller holds it, which is
 * right for the walls that are bounded by construction — For You's page, a profile's top
 * titles, a title's Similar tab. It was wrong for the Collection, which is as long as a
 * reader's library: a 688-title Letterboxd import mounted 688 tiles, each with its own
 * press animation, elevated frame and decoded image, and scrolling it lagged on the
 * device. This draws only the rows near the viewport and recycles the rest.
 *
 * It is a separate component rather than a mode of `PosterGrid` because it owns its own
 * scroller: a virtualised list nested inside a parent `ScrollView` measures its window as
 * its entire content and virtualises nothing. The caller gives it a flexing parent.
 *
 * **The tile is the same `Tile`**, so a wall drawn this way and one drawn by `PosterGrid`
 * cannot drift in size, label, chip or press feel. The gaps are the same too: every cell
 * is one third of the row, and the tile is aligned to the start, the centre or the end of
 * its third. With three tiles of `cardWidth` and two gaps filling the row exactly, that
 * places each gap at precisely `gap` — the arithmetic `PosterGrid` gets from `flexWrap`.
 */
export function PosterGridList({
  tiles,
  onPressTile,
  paddingTop = 0,
  paddingBottom = 0,
}: PosterGridListProps) {
  const { width } = useWindowDimensions();
  const { columns, gap } = theme.layout.posterGrid;

  const cardWidth = Math.floor(
    (width - theme.layout.gutter * 2 - gap * (columns - 1)) / columns,
  );

  return (
    <FlashList
      data={tiles}
      numColumns={columns}
      keyExtractor={(tile) => tile.id}
      // A sort or a filter replaces the data, and FlashList 2 would otherwise scroll to
      // keep whichever tile was first on screen in place — a jump to somewhere mid-wall
      // under a reader who only changed the order. A plain ScrollView kept the offset,
      // which is what this wall has always done.
      maintainVisibleContentPosition={GRID_POSITION}
      contentContainerStyle={{
        paddingHorizontal: theme.layout.gutter,
        paddingTop,
        paddingBottom,
      }}
      renderItem={({ item, index }) => (
        <View
          style={[
            styles.gridCell,
            { paddingBottom: gap },
            index % columns === 0
              ? styles.cellStart
              : index % columns === columns - 1
                ? styles.cellEnd
                : styles.cellCentre,
          ]}
        >
          <Tile tile={item} width={cardWidth} onPress={() => onPressTile(item)} />
        </View>
      )}
    />
  );
}

const GRID_POSITION = { disabled: true } as const;

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
  onDismiss,
}: {
  tile: PosterTile;
  width: number;
  onPress: () => void;
  onLongPress?: () => void;
  onToggleSave?: () => void;
  onDismiss?: () => void;
}) {
  const { score } = tile;
  /**
   * **The wall is the app's most-pressed surface** (founder premium pass, 2026-09-08).
   *
   * For You, Collection's wall and every poster shelf are the same tile, and opening a
   * title from one of them is the commonest tap in the product. The opacity change alone
   * is what a *link* does; the scale is what makes a piece of artwork feel like an object
   * that was pushed.
   */
  const press = usePressScale();
  const bookmark = usePulse();

  return (
    <Animated.View style={press.pressStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={labelFor(tile)}
        onPress={onPress}
        onLongPress={onLongPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={({ pressed }) => [{ width }, pressed && styles.pressed]}
      >
        <Poster
          uri={tile.posterUri}
          title={tile.title}
          blurhash={tile.blurhash}
          width={width}
        />
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
      {/* Below the poster and outside its press, because a native `hitSlop` cannot reach past
          a parent: a 44pt box is the only way to a 44pt target, and a near miss here must
          not open the title. */}
        {onToggleSave || onDismiss ? (
        <View style={[styles.tileActions, { width }]}>
        {onToggleSave ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: Boolean(tile.saved) }}
            accessibilityLabel={
              tile.saved
                ? `Remove ${tile.title} from watchlist`
                : `Save ${tile.title} to watchlist`
            }
            /**
             * **Saving is a state change, so it pulses and it buzzes** (2026-09-08).
             *
             * The glyph swap happens between two frames: `bookmark-outline` becomes
             * `bookmark` with no moment at which anything moved, so on a device the change
             * is something a reader notices a beat later rather than something they see
             * happen. One small pulse plus the lightest haptic is what turns it into an
             * acknowledgement.
             *
             * **On the way on only.** `usePulse` gets the *new* state, and celebrating the
             * removal of a bookmark would be the app disagreeing with the reader. The
             * haptic fires either way, because both directions are the reader having done
             * something.
             */
            onPress={() => {
              hapticSelection();
              if (!tile.saved) bookmark.pulse();
              onToggleSave();
            }}
            style={({ pressed }) => [styles.save, pressed && styles.pressed]}
          >
            <Animated.View style={bookmark.pulseStyle}>
              <Ionicons
                name={tile.saved ? 'bookmark' : 'bookmark-outline'}
                size={20}
                color={tile.saved ? theme.semantic.action : theme.text.secondary}
              />
            </Animated.View>
          </Pressable>
        ) : null}
        {onDismiss ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Not interested in ${tile.title}`}
            accessibilityHint="Removes it from your recommendations"
            onPress={onDismiss}
            // Quiet rather than Maroon: dismissal is an exit, not the act of the wall.
            style={({ pressed }) => [styles.dismiss, pressed && styles.pressed]}
          >
            <Ionicons name="close" size={18} color={theme.text.tertiary} />
          </Pressable>
        ) : null}
        </View>
        ) : null}
    </Animated.View>
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
  leadRow: {
    flexDirection: 'row',
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.layout.posterGrid.gap,
  },
  // The width of the cell FlashList sized, never a flex share of it: a cell's height is
  // measured, and a flexing child would measure against the row instead of its tile.
  gridCell: { width: '100%' },
  cellStart: { alignItems: 'flex-start' },
  cellCentre: { alignItems: 'center' },
  cellEnd: { alignItems: 'flex-end' },
  tileActions: { flexDirection: 'row', justifyContent: 'space-between' },
  save: {
    width: theme.layout.minTapTarget,
    height: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismiss: {
    width: theme.layout.minTapTarget,
    height: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chip: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    width: 34,
    height: 34,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.semantic.score,
    borderWidth: 1.5,
    borderColor: theme.surface.base,
  },
  pressed: { opacity: 0.7 },
});
