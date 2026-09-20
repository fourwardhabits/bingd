import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { theme } from '@/ui/tokens';

export type ListCoverProps = {
  /** Up to four poster URIs, in list order. Fewer is ordinary; none is an empty list. */
  posterUris: string[];
  /** The cover's outer edge, in points. The tiles are half of it, less the seam. */
  size: number;
};

/**
 * A list's cover: the first four posters, 2×2.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS ALWAYS THE FIRST FOUR
 *
 * §D rules out a chosen cover, and this is why that costs nothing: a list's first few
 * titles *are* what it is about, because the owner put them there. A cover picker would
 * be one more decision between wanting a list and having one, and the first thing to go
 * stale when the list changes.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A GRID AND NOT A STACK
 *
 * A fanned stack of posters is the obvious treatment and it is the wrong one here: it
 * reads as *one* thing with decoration behind it, which is what a title's artwork
 * already means everywhere else in the app. Four equal tiles read as a set, which is
 * what a list is.
 *
 * Fewer than four fills what there is and leaves the rest as the empty frame, rather
 * than stretching one poster across the square. A one-title list looks like a
 * one-title list, which is honest and is also the state most new lists are in.
 *
 * `theme.surface.sunken` under every tile, so an empty list still draws a shape — a
 * transparent square would make the row's second and third lines look unattached.
 */
export function ListCover({ posterUris, size }: ListCoverProps) {
  const seam = StyleSheet.hairlineWidth;
  const tile = (size - seam) / 2;
  // Always four cells. The extras are the empty frame, which is what makes a short
  // list read as short rather than as a layout that failed.
  const cells = [0, 1, 2, 3].map((index) => posterUris[index] ?? null);

  return (
    <View
      testID="list-cover"
      style={[styles.cover, { width: size, height: size }]}
      // Decorative: every fact the cover carries is in the text beside it, and a
      // screen reader meeting four unlabelled images before the list's name would be
      // meeting the row's least useful part first.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {cells.map((uri, index) => (
        <View
          key={index}
          style={[styles.cell, { width: tile, height: tile }]}
          testID={uri ? 'list-cover-poster' : 'list-cover-empty'}
        >
          {uri ? (
            <Image
              source={{ uri }}
              style={styles.art}
              contentFit="cover"
              // The cover is small and repeated down a screen; a transition on each
              // one turns a scroll into a shimmer.
              transition={0}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  cover: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderRadius: theme.radius.control,
    overflow: 'hidden',
    backgroundColor: theme.surface.sunken,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border.hairline,
  },
  cell: { backgroundColor: theme.surface.sunken },
  art: { width: '100%', height: '100%' },
});
