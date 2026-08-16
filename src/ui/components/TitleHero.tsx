import { Image } from 'expo-image';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { paperAlpha, theme } from '../tokens';

export type TitleHeroProps = {
  uri?: string | null;
  blurhash?: string | null;
  /** Height of the hero when there is no artwork, so the poster still overlaps
   *  something and the page does not become a different design. */
  collapsedHeight?: number;
  /**
   * Whether `uri` is a poster standing in for a backdrop (`lib/hero.ts`).
   *
   * A season has no backdrop of its own — TMDB does not publish one — so its hero
   * borrows the series' key art, and where even that is missing it falls back to a
   * poster. A poster in a 16:9 frame is the wrong shape by definition: cropping it
   * gives a band of somebody's chin, and fitting it gives two grey bars. Blurring is
   * what turns it into a *field* rather than a picture, which is all this surface
   * needs to be — the sharp copy of the same image is already on screen, overlapping
   * it, at the size it was drawn for.
   */
  blurred?: boolean;
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
export function TitleHero({
  uri,
  blurhash,
  collapsedHeight = 72,
  blurred = false,
}: TitleHeroProps) {
  const { width } = useWindowDimensions();
  const height = width / theme.layout.aspect.backdrop;

  // No artwork at all is still common — the seed catalogue ships without any. A short
  // warm band is not a failure state and does not pretend to be an image: no grey box,
  // and never a poster stretched to fill.
  if (!uri) return <View style={[styles.collapsed, { height: collapsedHeight }]} />;

  return (
    <View style={[styles.frame, { height }]}>
      <Image
        source={{ uri }}
        placeholder={blurhash ? { blurhash } : undefined}
        contentFit="cover"
        transition={theme.duration.navigation}
        // `blurRadius` is expo-image's own, so this costs no new native module and
        // no fingerprint change. Held down at 0.9 opacity as well: a blurred poster
        // at full strength is still the most saturated thing on a Paper page, and the
        // point is a field for the real poster to sit on, not a second subject.
        blurRadius={blurred ? POSTER_BLUR : 0}
        style={[styles.fill, blurred && styles.dimmed]}
        accessibilityIgnoresInvertColors
      />
      <Scrim height={height} />
    </View>
  );
}

/**
 * Enough to destroy the detail without turning the image to flat colour.
 *
 * Below about 20 a face is still legible and the eye reads it as a mistake; far above
 * it the frame becomes one hue and stops being artwork at all.
 */
const POSTER_BLUR = 28;

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
  dimmed: { opacity: 0.9 },
  scrim: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  collapsed: { backgroundColor: theme.surface.sunken },
});
