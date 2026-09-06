import { Image } from 'expo-image';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { posterUri } from '@/lib/images';
import { inkAlpha, theme } from '@/ui/tokens';

import type { CelebrationGrid } from './celebration-posters';

export type CelebrationBackdropProps = {
  grid: CelebrationGrid;
};

/**
 * The wall of posters behind an award celebration.
 *
 * **Not `PosterGrid`.** That one is a content surface — gutters, tap targets, a
 * watchlist control on every tile, an accessible name per poster — and every one of
 * those properties is wrong here. This is atmosphere: edge to edge, nothing tappable,
 * one element as far as a screen reader is concerned, and deliberately not a thing the
 * reader is invited to interact with. Reusing the content grid would have meant turning
 * five of its features off.
 *
 * **Cropped at the edges, on purpose.** The cells are sized from the screen width and
 * the wall is centred and allowed to overflow, so the top and bottom rows run off the
 * screen rather than ending in a tidy band of background colour. A grid that fits
 * exactly reads as a diagram; one that is clipped reads as a wall that continues.
 *
 * **Every poster keeps its ratio.** `contentFit: 'cover'` inside a fixed 2:3 cell, which
 * is the ratio every poster in the catalogue already is — so "cover" crops nothing in
 * practice and is there for the occasional odd asset rather than as a design.
 *
 * **The scrim is what makes the card legible**, and it is a flat ink wash rather than a
 * blur. There is no cheap cross-platform blur in this app and adding one would be a
 * native dependency on a decorative surface; a wash costs nothing, works identically on
 * both platforms, and is what the rest of the app already does over artwork.
 *
 * Drawn behind everything with `pointerEvents: 'none'`, so nothing here can intercept a
 * press meant for Done.
 */
export function CelebrationBackdrop({ grid }: CelebrationBackdropProps) {
  const { width, height } = useWindowDimensions();

  // Wide enough that the columns reach both edges, then a little more so the last one
  // is cut rather than flush. The height follows from the poster ratio.
  const cell = Math.ceil(width / grid.columns);
  const cellHeight = Math.ceil(cell / theme.layout.aspect.poster);
  const wallHeight = cellHeight * grid.rows;

  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      // One decorative object. Twenty posters announced one at a time, in front of the
      // thing the screen is actually about, is the worst possible reading order.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View
        style={[
          styles.wall,
          {
            width: cell * grid.columns,
            height: wallHeight,
            // Centred vertically and allowed to run off both ends. A wall shorter than
            // the screen sits in the middle with the page's own colour around it, which
            // is the honest look for a small collection.
            top: Math.round((height - wallHeight) / 2),
          },
        ]}
      >
        {grid.posters.map((poster) => (
          <Image
            key={poster.key}
            // `posterUri` returns null for an empty path, and `celebrationGrid` has
            // already excluded those — `?? undefined` is what says so to the type
            // rather than a second filter that could disagree with the first.
            source={{ uri: posterUri(poster.posterPath, 'card') ?? undefined }}
            style={{ width: cell, height: cellHeight }}
            contentFit="cover"
            // No transition. Twenty posters fading in at slightly different times is a
            // shimmer behind a card somebody is trying to read.
            transition={0}
          />
        ))}
      </View>
      {/* Over the wall, under the card. */}
      <View style={styles.scrim} />
    </View>
  );
}

const styles = StyleSheet.create({
  wall: {
    position: 'absolute',
    // Centred horizontally, so an odd number of columns is cut evenly at both edges
    // rather than all on the right.
    alignSelf: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    overflow: 'hidden',
  },
  /**
   * A wash rather than a blur, and heavy enough to be a floor rather than a filter: the
   * card in front of it carries text at footnote size, and a scrim tuned to "you can
   * still see the posters" is a scrim that fails on the one poster that happens to be
   * mostly white.
   */
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: inkAlpha(0.72),
  },
});
