import { Image } from 'expo-image';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';

import { inkAlpha, paperAlpha, theme } from '../tokens';

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
   * The status-bar inset, used to scrim the chrome rather than to move the artwork.
   *
   * **This prop used to push the image down, and that band is what the founder saw
   * chopping the backdrop off** (physical Android, 2026-09-07). The reasoning behind it
   * was sound: the header is transparent, so the top of every backdrop sat under the
   * status bar and the back control, and sliding the artwork below them made the whole
   * picture visible. What it produced on a device was a solid horizontal band of
   * `surface.sunken` across the top of the app's one full-bleed surface — the artwork
   * did not reach the top of the screen, it *terminated under a bar*.
   *
   * So the image fills the frame again and the inset is spent on a scrim instead: a
   * short ink gradient over the top, under the chrome, which is what every full-bleed
   * hero does. The back control keeps its contrast, the backdrop reaches the top edge,
   * and the frame is exactly the backdrop's own 16:9 with nothing added to it.
   *
   * Zero where there is no transparent header over the hero — tests, and any caller
   * that has its own opaque bar — and then no scrim is drawn at all.
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
   * The backdrop's own 16:9, and nothing added to it.
   *
   * This replaces a fixed frame ratio (1.62, then 1.5): at any fixed ratio `cover` had
   * to crop something — wider than 16:9 and the bottom of the backdrop went under the
   * fade, narrower and the sides went, which is what the founder called "too cropped".
   * Sizing the frame *from* the artwork means the whole picture is on screen on every
   * device, at the shape it was composed in.
   *
   * **`topInset` is no longer added here** (2026-09-07). It was, so that the artwork
   * could start below the transparent header with the frame's warm ground behind the
   * bar — and that ground is the band the founder saw the backdrop stop under. The
   * chrome overlays the artwork now, with `TopScrim` for contrast, so the frame is the
   * image and the image is the frame.
   */
  const height = width / BACKDROP_RATIO;

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
        style={[styles.fill, blurred && styles.dimmed]}
        accessibilityIgnoresInvertColors
      />
      <Scrim height={height} />
      {topInset > 0 ? <TopScrim height={topInset + NAV_BAR_HEIGHT} /> : null}
    </View>
  );
}

/**
 * The bar height the chrome occupies below the status bar, mirrored from
 * `DetailHeader`. A constant rather than an import, because this component is in the
 * design system and that hook is a feature of two routes — the number is the platform’s,
 * not either module’s.
 */
const NAV_BAR_HEIGHT = Platform.select({ android: 56, default: 44 }) as number;

/**
 * Contrast for the back control, over the top of the artwork.
 *
 * The founder’s constraint is that the backdrop reaches the top of the screen, which
 * means the navigation controls sit *on* it — and a dark glyph on a pale backdrop is a
 * back button nobody can find. A short ink ramp under the chrome is the standard answer
 * and the one the celebration wall already uses: it costs no height, no module and no
 * fingerprint, and it is strongest exactly where the glyph is.
 *
 * Eased rather than linear, and gone well before the artwork’s subject: by the bottom of
 * the bar it is doing nothing at all.
 */
function TopScrim({ height }: { height: number }) {
  return (
    <View
      pointerEvents="none"
      style={[styles.topScrim, { height, experimental_backgroundImage: TOP_SCRIM_GRADIENT }]}
    />
  );
}

const TOP_SCRIM_GRADIENT = [
  'linear-gradient(to bottom,',
  `${inkAlpha(0.38)} 0%,`,
  `${inkAlpha(0.22)} 45%,`,
  `${inkAlpha(0.06)} 78%,`,
  `${inkAlpha(0)} 100%)`,
].join(' ');

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
  // Anchored to the top and only as tall as the chrome it exists to make legible.
  topScrim: { position: 'absolute', top: 0, left: 0, right: 0 },
  collapsed: { backgroundColor: theme.surface.sunken },
});
