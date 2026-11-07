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
  /**
   * The height of the page's visible area, measured from its scroll view. The sharp band
   * grows toward a share of it on a tall phone. Absent, the window's height stands in.
   */
  viewportHeight?: number;
  /** The whole hero's height, artwork and module together. */
  onHeight?: (height: number) => void;
  /**
   * Where the module's top edge sits, from the top of the page. The top bar's reveal ends
   * here, so the bar is opaque before the module's controls pass under it.
   */
  onModuleTop?: (y: number) => void;
  /** The module's contents: title, genres, metadata, director, actions and scores. */
  children: ReactNode;
};

/**
 * The Cinematic Editorial title page's head (founder direction, title-page sprint,
 * 2026-11-06).
 *
 *     ┌──────────────────────────────┐
 *     │   sharp backdrop             │  ← the band: the title's own image, unblurred
 *     │                              │
 *     │  ┌────────────────────────┐  │  ← the module rises over the band's lower 22%,
 *     │  │ Title                  │  │    12pt in from each edge, corners rounded
 *     └──┤ Genre · Genre · +2     ├──┘  ← the band ends; Paper from edge to edge
 *        │ 2023 · R · 125 min     │
 *        │ Directed by …          │     The module is closed by one hairline and no
 *        │ [Rank] ▢ ▢ ▢           │     shadow (final title refinement, 2026-11-06):
 *        │ You | bingd. | Follow. │     the card that rose over the picture. The
 *        └────────────────────────┘     sections below it are the page's own full
 *     About …                           width, on the app's 16pt gutter.
 *
 * **What went** (same brief): the blurred, darkened reflection of the backdrop that filled
 * the rest of the first screen, the strips that softened the band into it, the band's dark
 * foot, the spare height above and below the module, and the chevron. The page is as tall
 * as its contents and scrolls as an ordinary page; nothing snaps.
 *
 * **The band is unchanged**: 16:9 of the width made a quarter taller, growing toward 40% of
 * the visible height on a tall phone and never past 1.4× the 16:9 frame, so a backdrop is
 * never stretched to portrait and faces are not cut to fill a tall screen. A poster-only
 * title keeps its soft poster ground with the poster sharp on it — that is the band itself,
 * not an extension below it — and a title with no artwork keeps Parchment and the initials.
 *
 * **The overlap is a share of the band, not a fixed point**, so it scales with every phone:
 * 22% of the band's displayed height, within the brief's 20–25%, which leaves the band's
 * upper three-quarters — where a backdrop's subject usually is — clear.
 */
export function ImmersiveHero({
  artwork,
  posterUri,
  title,
  topInset,
  viewportHeight,
  onHeight,
  onModuleTop,
  children,
}: ImmersiveHeroProps) {
  const { width, height: windowHeight } = useWindowDimensions();
  const viewport = Math.round(viewportHeight && viewportHeight > 0 ? viewportHeight : windowHeight);
  const barBand = topInset + NAV_BAR_HEIGHT;
  const band = bandHeight({ treatment: artwork.treatment, width, viewport, barBand });
  const overlap = moduleOverlap(band);
  const onArtwork = Boolean(artwork.uri);

  return (
    <View
      testID="immersive-hero"
      style={styles.hero}
      onLayout={(event) => onHeight?.(event.nativeEvent.layout.height)}
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
            {/* A poster-only title: the poster's own colours as a soft ground, and the
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
        {/* The scrim the top controls need on any artwork — the one `TitleHero` draws. */}
        {onArtwork ? (
          <View
            pointerEvents="none"
            style={[styles.topScrim, { height: barBand, experimental_backgroundImage: TOP_SCRIM }]}
          />
        ) : null}
      </View>

      <View
        style={[styles.moduleRow, { marginTop: -overlap }]}
        onLayout={(event) => onModuleTop?.(Math.round(event.nativeEvent.layout.y))}
        testID="immersive-module-row"
      >
        <View testID="immersive-module" style={styles.module}>
          {children}
        </View>
      </View>
    </View>
  );
}

/**
 * The sharp band's height.
 *
 * A backdrop: 16:9 of the width made a quarter taller, growing toward 40% of the visible
 * height on a tall phone, and never past 1.4× the 16:9 frame, which is the most a backdrop
 * is cropped at the sides. However wide the screen, at least `MIN_VISIBLE` of picture shows
 * between the bar and the module.
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
  if (treatment !== 'backdrop') return barBand + POSTER_HEIGHT + POSTER_FOOT;
  const frame = width / BACKDROP_RATIO;
  const floor = Math.max(Math.round(frame * BAND_STRETCH), barBand + MIN_VISIBLE);
  const ceiling = Math.max(Math.round(frame * BAND_MAX_STRETCH), floor);
  return Math.min(Math.max(Math.round(viewport * BAND_SHARE), floor), ceiling);
}

/** How far the module rises over the band: a share of the band's displayed height. */
export function moduleOverlap(band: number): number {
  return Math.round(band * OVERLAP_SHARE);
}

/** The sheet's inset from each screen edge where it overlaps the artwork. */
export const SHEET_INSET = theme.space[3];
/** The module's own horizontal padding, which the page's sections below share. */
export const SHEET_PADDING = theme.space[4];
/** The page's one content line under the hero: the sheet's inset plus its padding. */
export const SHEET_CONTENT_INSET = SHEET_INSET + SHEET_PADDING;

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
/** The share of the band the module rises over (founder: 20–25%). */
const OVERLAP_SHARE = 0.22;
/** Below a poster-only title's poster: the room its band keeps for the module's overlap. */
const POSTER_FOOT = 56;
const POSTER_HEIGHT = theme.poster.detail.height;
const POSTER_WIDTH = theme.poster.detail.width;
/** A poster-only title's soft band. */
const POSTER_BLUR = 30;

/** The same top scrim `TitleHero` draws, so the back and menu controls read on any art. */
const TOP_SCRIM = [
  'linear-gradient(to bottom,',
  `${inkAlpha(0.38)} 0%,`,
  `${inkAlpha(0.22)} 45%,`,
  `${inkAlpha(0.06)} 78%,`,
  `${inkAlpha(0)} 100%)`,
].join(' ');

const styles = StyleSheet.create({
  hero: { flexDirection: 'column' },
  band: { overflow: 'hidden', backgroundColor: theme.surface.sunken },
  topScrim: { position: 'absolute', top: 0, left: 0, right: 0 },
  posterDim: { backgroundColor: inkAlpha(0.25) },
  posterSlot: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  moduleRow: { paddingHorizontal: SHEET_INSET },
  /**
   * **The title card** (final title refinement, 2026-11-06). Paper, rounded, inset 12pt, and
   * closed by one hairline — the app's quietest edge, no shadow — so it reads as the card
   * that rose over the artwork, and the page under it as ordinary full-width Paper. Without
   * the line the card vanished below the band and its 28pt text line read as misaligned
   * against the sections' 16pt gutter.
   */
  module: {
    backgroundColor: theme.surface.base,
    borderRadius: theme.radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border.hairline,
    paddingHorizontal: SHEET_PADDING,
    paddingTop: theme.space[4],
    paddingBottom: theme.space[4],
    gap: theme.space[3],
  },
});
