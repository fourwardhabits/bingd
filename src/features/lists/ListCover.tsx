import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { theme } from '@/ui/tokens';

export type ListCoverProps = {
  /** Up to four poster URIs, in list order. Fewer is ordinary; none is an empty list. */
  posterUris: string[];
  /** The cover's outer edge, in points. */
  size: number;
};

/** Which of the three covers a list draws (founder QA, 2026-09-21). */
export function coverLayout(count: number): 'empty' | 'single' | 'mosaic' {
  if (count <= 0) return 'empty';
  return count >= 4 ? 'mosaic' : 'single';
}

/**
 * A list's cover, from its first posters (founder QA, 2026-09-21):
 *
 *   · **no posters** — a neutral placeholder with a list glyph, so an empty list still
 *     draws a shape and reads as a list rather than as a failed image;
 *   · **one to three** — the first poster, full cover. A half-empty 2×2 read as a layout
 *     that failed to load;
 *   · **four or more** — the 2×2 mosaic of the first four, which reads as a set.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS ALWAYS THE FIRST POSTERS
 *
 * §D rules out a chosen cover, and this is why that costs nothing: a list's first few
 * titles *are* what it is about, because the owner put them there. A cover picker would
 * be one more decision between wanting a list and having one.
 *
 * Used by every list card — My lists / Collection's Lists mode, the Profile shelf, and
 * the all-lists-by screen — so the rule is one function, not three.
 */
export function ListCover({ posterUris, size }: ListCoverProps) {
  const layout = coverLayout(posterUris.length);

  return (
    <View
      testID="list-cover"
      style={[styles.cover, { width: size, height: size }]}
      // Decorative: every fact the cover carries is in the text beside it.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {layout === 'empty' ? (
        <View style={styles.placeholder} testID="list-cover-empty">
          <Ionicons
            name="list-outline"
            size={Math.max(16, Math.round(size * 0.32))}
            color={theme.text.tertiary}
          />
        </View>
      ) : layout === 'single' ? (
        <Image
          testID="list-cover-poster"
          source={{ uri: posterUris[0] }}
          style={styles.art}
          contentFit="cover"
          // The cover is small and repeated down a screen; a transition on each one turns
          // a scroll into a shimmer.
          transition={0}
        />
      ) : (
        <Mosaic posterUris={posterUris.slice(0, 4)} />
      )}
    </View>
  );
}

/**
 * Two explicit rows of two cells, each cell `flex: 1`.
 *
 * **No arithmetic on the cover's width** (founder device QA, 2026-09-21). The first
 * version sized each tile as `(size - seam) / 2` inside a wrapping row, but the cover
 * draws a hairline border, so its inside is `size - 2 × hairline`: two tiles plus the
 * seam were a hair wider than the space they had, every tile wrapped onto its own line,
 * and the clipped square showed two half-width strips over beige. Flex cells fill
 * whatever the inside actually is, on every density.
 */
function Mosaic({ posterUris }: { posterUris: string[] }) {
  const rows = [posterUris.slice(0, 2), posterUris.slice(2, 4)];
  return (
    <View style={styles.grid}>
      {rows.map((row, r) => (
        <View key={r} style={styles.gridRow} testID="list-cover-row">
          {row.map((uri, c) => (
            <View key={c} style={styles.cell}>
              <Image
                testID="list-cover-poster"
                source={{ uri }}
                style={styles.art}
                contentFit="cover"
                transition={0}
              />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  cover: {
    borderRadius: theme.radius.control,
    overflow: 'hidden',
    backgroundColor: theme.surface.sunken,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border.hairline,
  },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  grid: { flex: 1, gap: StyleSheet.hairlineWidth },
  gridRow: { flex: 1, flexDirection: 'row', gap: StyleSheet.hairlineWidth },
  cell: { flex: 1, backgroundColor: theme.surface.sunken },
  art: { width: '100%', height: '100%' },
});
