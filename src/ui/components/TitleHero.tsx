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
   * Taller than the artwork's own 16:9, and no taller than it has to be.
   *
   * At a true 16:9 the fade starts almost immediately and the poster overlaps a strip
   * that has already become page. A little extra height is what the poster needs to sit
   * *in* the artwork rather than under it. Every point beyond that is paid for by the
   * sides of the image, which is what `HERO_RATIO` explains.
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
        /**
         * **Top centre, not centre.**
         *
         * It matters for the poster fallback and costs nothing for a backdrop. A poster
         * is far taller than this frame, so `cover` drops most of its height; taking
         * that from the bottom keeps the part somebody composed. A backdrop is wider
         * than the frame rather than taller, so it loses nothing vertically and this
         * only centres it horizontally, which is what you want either way.
         */
        contentPosition="top center"
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
 * The hero's aspect. Taller than the artwork's own 16:9, but only just.
 *
 * It was 1.4, and that is what the founder’s second look called "too cropped". The
 * arithmetic is the reason. `cover` scales an image until it fills both dimensions, so
 * a 16:9 backdrop in a frame narrower than 16:9 is scaled by height and loses the
 * *sides*: at 1.4 on a 412pt screen the image is drawn 523pt wide, and 111pt of what
 * somebody composed never reaches the screen. Nothing is lost from the top, which is
 * why anchoring the crop there never fixed it.
 *
 * 1.62 costs about forty points of height and takes the horizontal loss from 27% to
 * 10%, which is the difference between a backdrop and a detail of one. It is still
 * taller than 16:9, so the poster still rises into artwork rather than into Paper, and
 * the fade below moves with it.
 */
const HERO_RATIO = 1.62;

/**
 * One continuous gradient, drawn by the platform.
 *
 * **The banded implementation this replaced is the thing the founder rejected twice.**
 * It stacked opaque-ish views down the bottom of the hero, and the last version had
 * sixty of them at two points each with a smoothstep ramp — every step about one and a
 * half percent of alpha, which by any arithmetic should have been invisible. It was
 * not, and the reason is not the step size: eight-bit alpha on a large smooth ramp
 * produces contour bands that the eye finds precisely because the ramp *is* smooth.
 * More, thinner bands make that worse rather than better. No amount of tuning was going
 * to fix it, because the technique was the defect.
 *
 * A real gradient has the same eight-bit destination and does not band, because the
 * compositor interpolates and dithers it in hardware. So the answer had to be a real
 * one, and there were two ways to get one:
 *
 *   - **`expo-linear-gradient`**, which is a native module. Adding it changes the
 *     runtime fingerprint, which means every tester on the current build stops
 *     receiving over-the-air updates until they install a new APK. A steep price for
 *     one fade, and the reason the bands existed in the first place.
 *   - **`experimental_backgroundImage`**, which is React Native's own — landed in 0.76,
 *     typed in the 0.86 this app is on, implemented in the New Architecture that Expo
 *     SDK 57 enables by default. No new module, no fingerprint change, one view.
 *
 * The second, obviously. The `experimental_` prefix is React Native's, not a comment on
 * the stability of gradients; the API is a CSS `linear-gradient` string.
 *
 * FIVE STOPS, NOT TWO
 *
 * A two-stop ramp from transparent to Paper over the bottom 38% is linear, and linear
 * is the one curve that reads as a *ramp* rather than as a fade — you can see where it
 * starts. The stops below are an eased curve sampled at four points: almost nothing for
 * the first third of the fade, most of the change in the middle, and full Paper arriving
 * before the edge rather than at it. That is the same shape the smoothstep was going
 * for, expressed as something the compositor can interpolate rather than as sixty views.
 */
function Scrim({ height }: { height: number }) {
  void height;

  return (
    <View
      pointerEvents="none"
      style={[styles.scrim, { experimental_backgroundImage: SCRIM_GRADIENT }]}
    />
  );
}

/**
 * Where the fade begins, as a share of the hero.
 *
 * The founder's range is "approximately the bottom 30–40%". The frame lost height when
 * `HERO_RATIO` came down, so the fade starts a little later to keep the same amount of
 * artwork legible in absolute terms: two thirds of the hero is untouched, and the
 * poster's top edge still lands above the first stop that does anything.
 */
const SCRIM_GRADIENT = [
  'linear-gradient(to bottom,',
  `${paperAlpha(0)} 0%,`,
  `${paperAlpha(0)} 66%,`,
  `${paperAlpha(0.08)} 74%,`,
  `${paperAlpha(0.42)} 84%,`,
  `${paperAlpha(0.86)} 94%,`,
  `${paperAlpha(1)} 100%)`,
].join(' ');

const styles = StyleSheet.create({
  frame: { backgroundColor: theme.surface.sunken },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  dimmed: { opacity: 0.9 },
  // The whole frame now, not a band anchored to the bottom: the gradient's own stops
  // decide where the fade starts, so the view it is drawn on has to span the height
  // those percentages are measured against.
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  collapsed: { backgroundColor: theme.surface.sunken },
});
