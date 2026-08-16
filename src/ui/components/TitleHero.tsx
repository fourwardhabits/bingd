import { Image } from 'expo-image';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { paperAlpha, theme } from '../tokens';

export type TitleHeroProps = {
  uri?: string | null;
  blurhash?: string | null;
  /** Height of the hero when there is no artwork, so the poster still overlaps
   *  something and the page does not become a different design. */
  collapsedHeight?: number;
};

/**
 * The app's one full-bleed surface (design-system.md §1, §7).
 *
 * Everywhere else artwork is a printed object with a hairline and a margin of
 * Paper around it. Here it runs to the screen edges, because a title page whose
 * largest element is a 132pt poster on a flat field has no focal point and
 * reads as a form rather than as a page about a film.
 *
 * The bottom fades to Paper rather than ending at an edge. A hard edge makes
 * the hero a banner with a page beneath it; the fade makes them one surface,
 * which is what lets the poster and the genre pills straddle the boundary.
 */
export function TitleHero({ uri, blurhash, collapsedHeight = 72 }: TitleHeroProps) {
  const { width } = useWindowDimensions();
  const height = width / theme.layout.aspect.backdrop;

  // No backdrop is common — the seed catalogue ships without artwork of any
  // kind. A short warm band is not a failure state and does not pretend to be
  // an image: no grey box, and never the poster stretched to fill.
  if (!uri) return <View style={[styles.collapsed, { height: collapsedHeight }]} />;

  return (
    <View style={[styles.frame, { height }]}>
      <Image
        source={{ uri }}
        placeholder={blurhash ? { blurhash } : undefined}
        contentFit="cover"
        transition={theme.duration.navigation}
        style={styles.fill}
        accessibilityIgnoresInvertColors
      />
      <Scrim height={height} />
    </View>
  );
}

/**
 * A banded fade standing in for a gradient.
 *
 * `expo-linear-gradient` would draw this in one view, and it is a native module
 * — adding it changes the fingerprint and forces every tester onto a new build,
 * which is a steep price for one fade. Eight bands of increasing Paper over the
 * bottom third are indistinguishable at this size, because each step is under
 * three percent of alpha and the artwork beneath is never flat.
 */
function Scrim({ height }: { height: number }) {
  const band = Math.ceil((height * SCRIM_SHARE) / SCRIM_BANDS);

  return (
    <View pointerEvents="none" style={styles.scrim}>
      {Array.from({ length: SCRIM_BANDS }, (_, index) => (
        <View
          key={index}
          style={{
            height: band,
            // Squared, so the fade starts almost imperceptibly and accelerates
            // into the page. Linear alpha reads as a visible grey ramp.
            backgroundColor: paperAlpha(((index + 1) / SCRIM_BANDS) ** 2),
          }}
        />
      ))}
    </View>
  );
}

const SCRIM_BANDS = 8;
/** How much of the hero's height the fade occupies. */
const SCRIM_SHARE = 0.42;

const styles = StyleSheet.create({
  frame: { backgroundColor: theme.surface.sunken },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  scrim: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  collapsed: { backgroundColor: theme.surface.sunken },
});
