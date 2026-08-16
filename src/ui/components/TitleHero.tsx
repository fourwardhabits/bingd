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
  /**
   * Taller than the artwork's own 16:9.
   *
   * The founder's note was that the image "ends too high". At 16:9 the hero is 219pt
   * on a 390pt screen, the fade starts almost immediately, and the poster overlaps a
   * strip that has already become page. Filling to 1:1.4 gives the artwork about
   * seventy more points, which is what the poster needs to sit *in* rather than
   * under — and the extra height is spent on the fade, so no more of the image is
   * legible than before, it simply arrives at the page more slowly.
   */
  const height = width / HERO_RATIO;

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

/** The hero's aspect. Deliberately taller than the artwork's own 16:9 — see above. */
const HERO_RATIO = 1.4;

/**
 * A banded fade standing in for a gradient.
 *
 * `expo-linear-gradient` would draw this in one view, and it is a native module —
 * adding it changes the fingerprint and forces every tester onto a new build, which is
 * a steep price for one fade.
 *
 * The first version used eight bands over the bottom 42% with squared alpha, and the
 * founder saw it for what it was: stripes. Squaring puts almost all of the change at
 * the *end* of the ramp, so the last two bands stepped 23 points of alpha in one
 * edge — the one place a hard line is most visible, because it lands on the pale part
 * of the artwork.
 *
 * Three things fix it, and all three are needed:
 *
 *   - **bands two points tall**, derived from the fade height rather than fixed at
 *     eight. Sixty-odd views instead of eight, each stepping about a percent and a
 *     half, which is below what the eye resolves against photographic content.
 *   - **smoothstep instead of squared.** `t²(3−2t)` is flat at both ends, so the fade
 *     begins imperceptibly *and* arrives at full Paper without a final jump.
 *   - **a full-strength finish.** `smoothstep(1)` is exactly 1, so the final band is
 *     opaque Paper sitting on the hero's bottom edge. That is the clean cutoff the
 *     brief asks for, and it needs no extra element — one that claimed to provide it
 *     would be dead code, since a child with `flex: 1` in an auto-height absolute
 *     container measures zero.
 */
function Scrim({ height }: { height: number }) {
  const fade = Math.round(height * SCRIM_SHARE);
  const count = Math.max(Math.ceil(fade / BAND_HEIGHT), 1);

  return (
    <View pointerEvents="none" style={styles.scrim}>
      {Array.from({ length: count }, (_, index) => {
        const t = (index + 1) / count;
        return (
          <View
            key={index}
            style={{
              height: BAND_HEIGHT,
              backgroundColor: paperAlpha(smoothstep(t)),
            }}
          />
        );
      })}
    </View>
  );
}

/** Flat at both ends: no visible start to the fade and no step at the finish. */
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Two points per band puts the alpha step below what the eye picks out. */
const BAND_HEIGHT = 2;

/**
 * How much of the hero the fade occupies.
 *
 * Well over half, because the founder's note was that the transition felt abrupt as
 * well as striped. A short ramp is a hard edge however many bands it has.
 */
const SCRIM_SHARE = 0.62;

const styles = StyleSheet.create({
  frame: { backgroundColor: theme.surface.sunken },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  dimmed: { opacity: 0.9 },
  // Anchored to the bottom, so the ramp finishes exactly where the artwork does.
  scrim: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  collapsed: { backgroundColor: theme.surface.sunken },
});
