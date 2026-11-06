import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';

import type { HeroArtwork } from '@/lib/hero';
import { Poster } from '@/ui/components';
import { inkAlpha, paperAlpha, theme } from '@/ui/tokens';

export type ImmersiveHeroProps = {
  artwork: HeroArtwork;
  /** The sharp poster for a poster-only title, and the initials frame for none. */
  posterUri: string | null;
  title: string;
  /** The status bar's height, which the top band has to clear. */
  topInset: number;
  /**
   * The height of the page's visible area, measured from its scroll view: the opening
   * screen fills it, so About starts below the fold. Absent, the window's height stands in.
   */
  viewportHeight?: number;
  /** The chevron at the foot of the opening screen; absent, it is drawn as a hint only. */
  onPressMore?: () => void;
  /** The whole hero's height, artwork and module together. */
  onHeight?: (height: number) => void;
  /**
   * Where the floating module's top edge sits, from the top of the page. The top bar's
   * reveal ends here, so the bar is opaque before the module's controls pass under it.
   */
  onModuleTop?: (y: number) => void;
  /** The module's contents: title, genres, metadata, actions and scores. */
  children: ReactNode;
};

/**
 * The Cinematic Editorial opening screen (founder-approved direction, 2026-11-04; one full
 * viewport since the UI cohesion pass, 2026-11-06).
 *
 *     ┌──────────────────────────────┐
 *     │   sharp backdrop             │  ← the band: the title's own image, unblurred,
 *     │                              │    darkening a little into its foot
 *     │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│  ← the field: the same image, mirrored at the
 *     │▒┌──────────────────────────┐▒│    band's edge so it continues it, softened and
 *     │▒│ Title                    │▒│    darkened, to the foot of the screen
 *     │▒│ Genre · Genre · +2       │▒│
 *     │▒│ 2023 · R · 125m          │▒│  ← the module, in the lower part of the screen,
 *     │▒│ [Rank] ▢ ▢ ▢             │▒│    12pt in from each edge
 *     │▒│ Your score | bingd | Fol │▒│
 *     │▒└──────────────────────────┘▒│
 *     │▒▒▒▒▒▒▒▒▒▒▒▒▒⌄▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│  ← a quiet chevron: there is more below
 *     └──────────────────────────────┘  ← the fold; About starts on Paper below it
 *
 * **One opening screen, then an ordinary page.** The hero is at least as tall as the
 * visible area, so on a typical phone the first thing seen is the picture and the module,
 * and About is below the fold. Nothing snaps: the page scrolls as it always did.
 *
 * **Where the spare height goes.** The sharp band grows with the screen only up to 1.4×
 * the 16:9 frame (about 14% cropped from each side of a backdrop), so faces are not cut
 * to fill a tall phone. What is left is split above and below the module, more above, so
 * the module sits in the lower part with room on both sides and the chevron under it.
 *
 * **The field is the band continued, not a second picture.** It is the band's own frame —
 * the same crop, at the same size — reflected at the band's lower edge, then reflected back
 * at the next, so every edge in it meets the row of pixels it continues; then blurred and
 * darkened. Over its last 48pt the band softens into the field through three strips of the
 * same blurred frame, and it darkens into its foot while the field eases back out of a
 * slightly darker seam, so the change from sharp to soft is gradual and in shadow. No milky
 * gradient, no flat stripe, and no repeat seam.
 *
 * **Natural height.** The module is as tall as its contents. A long title, a watch date,
 * large text or a stacked score row make it taller; when it no longer fits, the spare
 * space is simply zero and the page scrolls. Nothing here is a fixed height that can clip.
 */
export function ImmersiveHero({
  artwork,
  posterUri,
  title,
  topInset,
  viewportHeight,
  onPressMore,
  onHeight,
  onModuleTop,
  children,
}: ImmersiveHeroProps) {
  const { width, height: windowHeight } = useWindowDimensions();
  const viewport = Math.round(viewportHeight && viewportHeight > 0 ? viewportHeight : windowHeight);
  const barBand = topInset + NAV_BAR_HEIGHT;
  const band = bandHeight({ treatment: artwork.treatment, width, viewport, barBand });
  const onArtwork = Boolean(artwork.uri);
  // The field's softness is the band's own where the band is already soft (a poster-only
  // title's field), so the reflection at their edge is exact.
  const fieldBlur = artwork.treatment === 'backdrop' ? FIELD_BLUR : POSTER_BLUR;
  const chevronColor = onArtwork ? paperAlpha(0.88) : theme.text.secondary;

  return (
    <View
      testID="immersive-hero"
      style={[styles.hero, { minHeight: viewport }]}
      onLayout={(event) => onHeight?.(event.nativeEvent.layout.height)}
    >
      {/**
       * The field, from the band's foot to the foot of the opening screen: behind the
       * module, the spare space and the chevron alike, so the picture continues all the
       * way down and Paper begins with a clean edge where the hero ends.
       */}
      <View pointerEvents="none" testID="immersive-extension" style={[styles.field, { top: band }]}>
        {artwork.uri ? (
          <>
            {/* The band's own frame, band-high, flipped and flipped back down the field: a
                reflection at every edge, so each tile's first row is the row above it and
                nothing repeats with a seam. The first is the band mirrored. */}
            {FIELD_TILES.map((index) => (
              <Image
                key={index}
                source={{ uri: artwork.uri }}
                contentFit="cover"
                contentPosition="center"
                blurRadius={fieldBlur}
                style={[styles.tile, { top: index * band, height: band }, index % 2 === 0 && styles.mirror]}
                accessibilityIgnoresInvertColors
                testID={index === 0 ? 'immersive-extension-image' : `immersive-extension-tile-${index}`}
              />
            ))}
            {artwork.treatment === 'backdrop' ? (
              <>
                <View style={[StyleSheet.absoluteFill, styles.fieldDim]} />
                <View
                  style={[styles.fieldSeam, { experimental_backgroundImage: FIELD_SEAM }]}
                  testID="immersive-field-seam"
                />
              </>
            ) : (
              // A poster-only band is already the soft field, dimmed as this is: the field
              // is its exact continuation, with no seam to put in shadow.
              <View style={[StyleSheet.absoluteFill, styles.posterDim]} />
            )}
          </>
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.fieldPlain]} />
        )}
      </View>

      <View testID="immersive-art" style={[styles.band, { height: band }]}>
        {artwork.treatment === 'backdrop' ? (
          <Image
            source={{ uri: artwork.uri }}
            contentFit="cover"
            contentPosition="center"
            transition={theme.duration.navigation}
            style={StyleSheet.absoluteFill}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <>
            {/* A poster-only title: the poster's own colours as a soft field, and the
                poster itself sharp and centred on it. No artwork at all: Parchment, and
                the designed initials frame — the brand's own fallback. */}
            {artwork.uri ? (
              <>
                <Image
                  source={{ uri: artwork.uri }}
                  contentFit="cover"
                  blurRadius={POSTER_BLUR}
                  style={StyleSheet.absoluteFill}
                  accessibilityIgnoresInvertColors
                />
                <View style={[StyleSheet.absoluteFill, styles.posterDim]} pointerEvents="none" />
              </>
            ) : null}
            <View style={[styles.posterSlot, { top: barBand }]} testID="immersive-poster">
              <Poster uri={posterUri} title={title} width={POSTER_WIDTH} />
            </View>
          </>
        )}
        {/**
         * The sharp backdrop softens into the field over its last 48pt rather than at one
         * row: six strips of the same frame, blurred as the field is and aligned with the
         * band, each a little more opaque. The same image at the same size and blur as the
         * field's tiles, so they share one decoded bitmap.
         */}
        {artwork.treatment === 'backdrop' && artwork.uri
          ? CROSSFADE.map(({ from, opacity }) => (
              <View
                key={from}
                pointerEvents="none"
                style={[styles.strip, { top: band - from, opacity }]}
                testID={`immersive-crossfade-${from}`}
              >
                <Image
                  source={{ uri: artwork.uri }}
                  contentFit="cover"
                  contentPosition="center"
                  blurRadius={FIELD_BLUR}
                  style={[styles.tile, { top: from - band, height: band }]}
                  accessibilityIgnoresInvertColors
                />
              </View>
            ))
          : null}
        {/* A backdrop darkens into its foot, to the depth the field starts at. */}
        {artwork.treatment === 'backdrop' && onArtwork ? (
          <View
            pointerEvents="none"
            testID="immersive-band-fade"
            style={[styles.bandFade, { experimental_backgroundImage: BAND_FADE }]}
          />
        ) : null}
        {/* The scrim the top controls need on any artwork — the one `TitleHero` draws. */}
        {onArtwork ? (
          <View
            pointerEvents="none"
            style={[styles.topScrim, { height: barBand, experimental_backgroundImage: TOP_SCRIM }]}
          />
        ) : null}
      </View>

      <View style={styles.spaceAbove} testID="immersive-space-above" />

      <View
        style={[styles.moduleRow, { marginTop: -MODULE_OVERLAP }]}
        onLayout={(event) => onModuleTop?.(Math.round(event.nativeEvent.layout.y))}
        testID="immersive-module-row"
      >
        <View testID="immersive-module" style={styles.module}>
          {children}
        </View>
      </View>

      <View style={styles.spaceBelow} testID="immersive-space-below" />

      <View style={styles.more}>
        {onPressMore ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="More about this title"
            accessibilityHint="Scrolls to About"
            onPress={onPressMore}
            style={({ pressed }) => [styles.chevron, pressed && styles.pressed]}
            testID="immersive-more"
          >
            <Ionicons
              name="chevron-down"
              size={CHEVRON}
              color={chevronColor}
              testID="immersive-more-glyph"
            />
          </Pressable>
        ) : (
          <View
            style={styles.chevron}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            testID="immersive-more"
          >
            <Ionicons
              name="chevron-down"
              size={CHEVRON}
              color={chevronColor}
              testID="immersive-more-glyph"
            />
          </View>
        )}
      </View>
    </View>
  );
}

/**
 * The sharp band's height.
 *
 * A backdrop: 16:9 of the width made a quarter taller (the first version's band), growing
 * toward 40% of the visible height on a tall phone, and never past 1.4× the 16:9 frame,
 * which is the most a backdrop is cropped at the sides. However wide the screen, at least
 * `MIN_VISIBLE` of picture shows between the bar and the module.
 *
 * A poster stands upright under the bar, with room for the module to overlap its foot.
 */
export function bandHeight({
  treatment,
  width,
  viewport,
  barBand,
}: {
  treatment: HeroArtwork['treatment'];
  width: number;
  viewport: number;
  barBand: number;
}): number {
  if (treatment !== 'backdrop') return barBand + POSTER_HEIGHT + MODULE_OVERLAP;
  const frame = width / BACKDROP_RATIO;
  const floor = Math.max(Math.round(frame * BAND_STRETCH), barBand + MIN_VISIBLE);
  const ceiling = Math.max(Math.round(frame * BAND_MAX_STRETCH), floor);
  return Math.min(Math.max(Math.round(viewport * BAND_SHARE), floor), ceiling);
}

const NAV_BAR_HEIGHT = Platform.select({ android: 56, default: 44 }) as number;
const BACKDROP_RATIO = 16 / 9;
/** A quarter taller than 16:9: the band's least height. */
const BAND_STRETCH = 1.25;
/** The most the band grows to fill a tall screen: about 14% cropped from each side. */
const BAND_MAX_STRETCH = 1.4;
/** How much of the visible height the band aims for, between those two. */
const BAND_SHARE = 0.4;
/** However wide the screen, at least this much picture shows between the bar and module. */
const MIN_VISIBLE = 120;
/** How far the module rises over the artwork when there is no spare height. */
const MODULE_OVERLAP = 56;
const POSTER_HEIGHT = theme.poster.detail.height;
const POSTER_WIDTH = theme.poster.detail.width;
/** The module's inset from each screen edge: the width of artwork showing beside it. */
const MODULE_INSET = theme.space[3];
const FIELD_BLUR = 24;
/** A poster-only title's soft band, and so its field. */
const POSTER_BLUR = 30;
/**
 * The cross-fade's strips, from the band's foot upward: how far up each starts, and how
 * opaque it is. Six 8pt steps, so no one step is large enough to read as an edge.
 */
const STRIP = 8;
const CROSSFADE = [
  { from: 48, opacity: 0.14 },
  { from: 40, opacity: 0.28 },
  { from: 32, opacity: 0.42 },
  { from: 24, opacity: 0.58 },
  { from: 16, opacity: 0.74 },
  { from: 8, opacity: 0.9 },
] as const;
/**
 * Reflections down the field. Three band-heights cover any field this screen draws: the
 * field is the hero less the band, and even a hero grown well past the screen by large text
 * is under four bands tall. Past them, the field's own dark ground continues.
 */
const FIELD_TILES = [0, 1, 2] as const;
/** The field's darkening, which is also the depth the band fades to at its foot. */
const FIELD_DIM = 0.38;
/** A little deeper at the seam itself, easing back out, so the sharp-to-soft edge is in shadow. */
const SEAM_EXTRA = 0.14;
const CHEVRON = 22;

/** The same top scrim `TitleHero` draws, so the back and menu controls read on any art. */
const TOP_SCRIM = [
  'linear-gradient(to bottom,',
  `${inkAlpha(0.38)} 0%,`,
  `${inkAlpha(0.22)} 45%,`,
  `${inkAlpha(0.06)} 78%,`,
  `${inkAlpha(0)} 100%)`,
].join(' ');

/** The band's foot: clear, then down to the field's depth plus the seam's. */
const BAND_FADE = [
  'linear-gradient(to bottom,',
  `${inkAlpha(0)} 0%,`,
  `${inkAlpha(FIELD_DIM * 0.6)} 55%,`,
  `${inkAlpha(FIELD_DIM + SEAM_EXTRA)} 100%)`,
].join(' ');

/** The field's head: the seam's extra depth, easing out over its first stretch. */
const FIELD_SEAM = [
  'linear-gradient(to bottom,',
  `${inkAlpha(SEAM_EXTRA)} 0%,`,
  `${inkAlpha(0)} 100%)`,
].join(' ');

const styles = StyleSheet.create({
  hero: { flexDirection: 'column' },
  band: { overflow: 'hidden', backgroundColor: theme.surface.sunken },
  topScrim: { position: 'absolute', top: 0, left: 0, right: 0 },
  bandFade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 72 },
  posterDim: { backgroundColor: inkAlpha(0.25) },
  posterSlot: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  field: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
    // A deep ground under the reflections: never seen where they cover it, and dark
    // rather than grey wherever an edge of the blur lets it through.
    backgroundColor: inkAlpha(0.85),
  },
  tile: { position: 'absolute', left: 0, right: 0 },
  strip: { position: 'absolute', left: 0, right: 0, height: STRIP, overflow: 'hidden' },
  mirror: { transform: [{ scaleY: -1 }] },
  fieldDim: { backgroundColor: inkAlpha(FIELD_DIM) },
  fieldSeam: { position: 'absolute', top: 0, left: 0, right: 0, height: 56 },
  fieldPlain: { backgroundColor: theme.surface.sunken },
  /** Three parts of the spare height above the module to two below it. */
  spaceAbove: { flexGrow: 3 },
  spaceBelow: { flexGrow: 2 },
  moduleRow: { paddingHorizontal: MODULE_INSET },
  more: { alignItems: 'center', paddingTop: theme.space[1], paddingBottom: theme.space[2] },
  chevron: {
    width: theme.layout.minTapTarget,
    height: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
  /**
   * One Paper surface for everything that can be read or pressed. A hairline keeps its
   * edge; the lighter of the two elevations lifts it off the picture without a heavy
   * shadow.
   */
  module: {
    backgroundColor: theme.surface.base,
    borderRadius: theme.radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border.hairline,
    paddingHorizontal: theme.space[4],
    paddingTop: theme.space[4],
    paddingBottom: theme.space[3],
    gap: theme.space[3],
    ...theme.elevation.e1,
  },
});
