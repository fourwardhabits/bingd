import { Image } from 'expo-image';
import type { ReactNode } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';

import type { HeroArtwork } from '@/lib/hero';
import { Poster } from '@/ui/components';
import { inkAlpha, theme } from '@/ui/tokens';

export type ImmersiveHeroProps = {
  artwork: HeroArtwork;
  /** The sharp poster for a poster-only title, and the initials frame for none. */
  posterUri: string | null;
  title: string;
  /** The status bar's height, which the top band has to clear. */
  topInset: number;
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
 * The Cinematic Editorial first screen (founder-approved direction, 2026-11-04).
 *
 *     ┌──────────────────────────────┐
 *     │   sharp backdrop             │  ← the band: the title's own image, unblurred
 *     │                              │
 *     │ ┌──────────────────────────┐ │  ← the module overlaps the band's lower edge,
 *     │░│ Title                    │░│    inset from both sides so the artwork shows
 *     │░│ Genre · Genre · +2       │░│    around it
 *     │░│ 2023 · R · 125m          │░│  ░ the same image, softened and darkened —
 *     │░│ [Rank] ▢ ▢ ▢             │░│    only behind the module
 *     │░│ Your score | bingd | Fol │░│
 *     │░└──────────────────────────┘░│
 *     └──────────────────────────────┘  ← a 12pt frame of artwork under the module,
 *       Paper, and the page continues      the same width as the margins beside it
 *
 * What it replaces: the first version extended a blurred, darkened copy of the artwork
 * behind the whole first screen and set the words in Parchment on it. The founder's
 * refinement keeps the image sharp where it is seen, confines the softened extension to
 * the strip behind the module, and puts everything that can be read or pressed on one
 * Paper surface in Ink — so the module is one object rather than words on a picture.
 *
 * **Natural height.** Nothing here is a fixed height that could clip: the band's height is
 * derived from the screen width, and the module is as tall as its contents — a long
 * title, large text, a stacked score row and a two-row action cluster all simply make it
 * taller, and the softened strip behind it grows with it.
 */
export function ImmersiveHero({
  artwork,
  posterUri,
  title,
  topInset,
  onHeight,
  onModuleTop,
  children,
}: ImmersiveHeroProps) {
  const { width } = useWindowDimensions();
  const barBand = topInset + NAV_BAR_HEIGHT;

  /**
   * The band: 16:9 of the width, made a quarter taller.
   *
   * Exactly 16:9 would show the whole frame, but the top bar sits over its first hundred
   * points and the module over its last few dozen, which leaves a letterbox of picture. A
   * quarter taller crops about a tenth from each side — enough to keep an off-centre
   * subject in frame on nearly every backdrop TMDB publishes — and gives the image the
   * room the brief asks for above the module.
   */
  const backdropBand = Math.round((width / BACKDROP_RATIO) * BAND_STRETCH);
  // A poster stands upright under the bar, with room for the module to overlap its foot.
  const posterBand = barBand + POSTER_HEIGHT + MODULE_OVERLAP;
  const band =
    artwork.treatment === 'backdrop' ? Math.max(backdropBand, barBand + MIN_VISIBLE) : posterBand;
  const moduleTop = band - MODULE_OVERLAP;

  return (
    <View
      testID="immersive-hero"
      onLayout={(event) => {
        onHeight?.(event.nativeEvent.layout.height);
        onModuleTop?.(moduleTop);
      }}
    >
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
                  blurRadius={30}
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
        {/* The scrim the top controls need on any artwork — the one `TitleHero` draws. */}
        {artwork.uri ? (
          <View
            pointerEvents="none"
            style={[styles.topScrim, { height: barBand, experimental_backgroundImage: TOP_SCRIM }]}
          />
        ) : null}
      </View>

      <View style={[styles.moduleRow, { marginTop: -MODULE_OVERLAP }]}>
        {/**
         * The softened extension, behind the module only.
         *
         * It starts where the sharp band ends and stops one inset below the module's
         * foot, so the module is framed by picture on three sides at one width, and
         * Paper continues below with a clean edge (post-QA sprint 2, 2026-11-05: the
         * picture used to end flush with the module, which read as unfinished). Full width, so the
         * strip beside each edge of the module is still picture. The same image, enlarged
         * to cover the strip from its bottom edge — the part of the frame the band was
         * just showing — then softened and darkened so it reads as the picture continuing
         * rather than a second picture.
         */}
        {artwork.uri ? (
          <View
            pointerEvents="none"
            testID="immersive-extension"
            style={[styles.extension, { top: MODULE_OVERLAP }]}
          >
            <Image
              source={{ uri: artwork.uri }}
              contentFit="cover"
              contentPosition="bottom"
              blurRadius={24}
              style={StyleSheet.absoluteFill}
              accessibilityIgnoresInvertColors
            />
            <View style={[StyleSheet.absoluteFill, styles.extensionDim]} />
          </View>
        ) : (
          <View
            pointerEvents="none"
            style={[styles.extension, styles.extensionPlain, { top: MODULE_OVERLAP }]}
          />
        )}

        <View testID="immersive-module" style={styles.module}>
          {children}
        </View>
      </View>
    </View>
  );
}

const NAV_BAR_HEIGHT = Platform.select({ android: 56, default: 44 }) as number;
const BACKDROP_RATIO = 16 / 9;
/** A quarter taller than 16:9 — see the band's note. */
const BAND_STRETCH = 1.25;
/** However wide the screen, at least this much picture shows between the bar and module. */
const MIN_VISIBLE = 120;
/** How far the module rises over the artwork. */
const MODULE_OVERLAP = 56;
const POSTER_HEIGHT = theme.poster.detail.height;
const POSTER_WIDTH = theme.poster.detail.width;
/** The module's inset from each screen edge and below it: the width of artwork showing. */
const MODULE_INSET = theme.space[3];

/** The same top scrim `TitleHero` draws, so the back and menu controls read on any art. */
const TOP_SCRIM = [
  'linear-gradient(to bottom,',
  `${inkAlpha(0.38)} 0%,`,
  `${inkAlpha(0.22)} 45%,`,
  `${inkAlpha(0.06)} 78%,`,
  `${inkAlpha(0)} 100%)`,
].join(' ');

const styles = StyleSheet.create({
  band: { overflow: 'hidden', backgroundColor: theme.surface.sunken },
  topScrim: { position: 'absolute', top: 0, left: 0, right: 0 },
  posterDim: { backgroundColor: inkAlpha(0.25) },
  posterSlot: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  moduleRow: { paddingHorizontal: MODULE_INSET, paddingBottom: MODULE_INSET },
  extension: { position: 'absolute', left: 0, right: 0, bottom: 0, overflow: 'hidden' },
  extensionDim: { backgroundColor: inkAlpha(0.35) },
  extensionPlain: { backgroundColor: theme.surface.sunken },
  /**
   * One Paper surface for everything that can be read or pressed. A hairline keeps its
   * edge where it meets Paper below; the lighter of the two elevations lifts it off the
   * picture without a heavy shadow.
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
