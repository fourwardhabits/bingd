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
  /**
   * The status-bar inset, when the hero runs under a transparent header.
   *
   * **This is the founder's pull-down, made the resting state.** The title page draws
   * its header transparent, so the top of the frame sits under the status bar and the
   * navigation controls — and on the physical device the top of every backdrop was
   * occluded by them. Pulling the scroll view down slid the artwork below the bar and
   * produced the composition the founder wanted; no `contentPosition` value could,
   * because the top of the image was never *cropped*, it was *covered*.
   *
   * So the image starts this far down, with the frame's warm band behind the bar —
   * and the frame is taller by exactly this much, so the inset is not paid for out of
   * the artwork. The image box below the bar keeps the backdrop's own 16:9 (see
   * `height` in the component), which is what makes the whole picture, top edge
   * included, visible on every device.
   */
  topInset?: number;
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
  topInset = 0,
}: TitleHeroProps) {
  const { width } = useWindowDimensions();
  /**
   * The inset, plus the backdrop's own 16:9 — so the visible image box is exactly the
   * shape the artwork was composed in, on every device.
   *
   * This replaces a fixed frame ratio (1.62, then 1.5), and the founder's fourth look
   * is why: at any fixed ratio the image box — the frame minus `topInset` — is the
   * wrong shape on most devices, so `cover` always crops something. Wider than 16:9
   * and the bottom of the backdrop is lost under the fade; narrower and the sides go,
   * which is what the founder called "too cropped" back when the whole frame was 1.4.
   * Sizing the box *from* the artwork instead of reverse-engineering a ratio means the
   * full backdrop — its top edge included — is on screen everywhere: a 393pt phone
   * with a 59pt inset gets a 280pt frame (deeper than 1.5 gave it), a small-inset
   * Android does not pay for an inset it does not have, and the no-inset case (tests,
   * no transparent header) is a bare 16:9.
   */
  const height = topInset + width / BACKDROP_RATIO;

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
         * The image box is held to 16:9, so a standard backdrop is not cropped at
         * all — but not every artwork is standard. Anything taller than 16:9 (the
         * blurred poster fallback most of all, and the odd non-conforming backdrop)
         * is width-scaled by `cover` and cropped vertically, and anchoring to the
         * top keeps the part somebody composed while the loss goes under the fade.
         */
        contentPosition="top center"
        transition={theme.duration.navigation}
        // `blurRadius` is expo-image's own, so this costs no new native module and
        // no fingerprint change. Held down at 0.9 opacity as well: a blurred poster
        // at full strength is still the most saturated thing on a Paper page, and the
        // point is a field for the real poster to sit on, not a second subject.
        blurRadius={blurred ? POSTER_BLUR : 0}
        style={[styles.fill, { top: topInset }, blurred && styles.dimmed]}
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
 * TMDB backdrops are published at 16:9 (`w1280` is 1280×720), and the image box —
 * the frame minus `topInset` — is held to exactly this shape so `cover` has nothing
 * to crop in either direction. The full history of chasing this with fixed frame
 * ratios (1.4 → 1.62 → 1.5, each one a different wrong crop on some device) is in
 * the `height` comment inside the component.
 */
const BACKDROP_RATIO = 16 / 9;

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
