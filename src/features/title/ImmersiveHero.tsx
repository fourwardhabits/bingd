import { Image } from 'expo-image';
import { useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';

import type { HeroArtwork } from '@/lib/hero';
import { Poster } from '@/ui/components';
import { brand, inkAlpha, theme } from '@/ui/tokens';

/**
 * **The immersive title page's first screen** (Immersive Scroll experiment, 2026-11-04).
 *
 * Near full screen, and built so that no artwork has to be cropped to a phone's shape:
 *
 * ---------------------------------------------------------------------------
 * THE ARTWORK
 *
 * The backdrop is drawn sharp across the top at its own 16:9. When the screen has room
 * left over, the band grows to use it, but never past 4:3 — at most an eighth of the
 * width is lost from each side, so an off-centre subject survives. A single full-screen
 * cover crop, which suits one key art and cuts the face out of the next, is what this
 * avoids (founder brief §4).
 *
 * Behind everything is the same artwork blurred heavily under Ink at 0.45: the ambient
 * field that fills the rest of the screen, so the picture visibly continues below the
 * sharp band rather than stopping at a dark slab. The sharp band fades into that tint
 * over its lower part.
 *
 * The words are anchored at the foot of the screen and get their own scrim, a 72pt fade
 * into Ink at 0.7 on top of the ambient tint — about 0.83 Ink in total behind every word.
 * So no text is ever set on sharp artwork, and a white sky arrives under the title as a
 * dark grey: Parchment on that holds about 6.5:1, against 13:1 on plain Ink.
 *
 * With no backdrop, the band is the poster card on the blurred poster — the poster is the
 * art, and the only time it appears on this page. With no artwork at all, the designed
 * missing-poster state on plain Ink.
 *
 * ---------------------------------------------------------------------------
 * THE WORDS
 *
 * `children` is the identity, the scores and the actions, laid out by the title page
 * from the values the original page already computes. They stack below the band; with
 * larger text they push the screen taller rather than clipping, because the screen is a
 * minimum height, never a fixed one.
 */
export type ImmersiveHeroProps = {
  artwork: HeroArtwork;
  /** The poster card for the poster and no-artwork treatments. */
  posterUri: string | null;
  /** What the poster placeholder names when there is no artwork. */
  title: string;
  /** The status bar, which the navigation overlays along with the artwork. */
  topInset: number;
  /** Reports the screen's height, which decides when the bar above it turns solid. */
  onHeight?: (height: number) => void;
  children: ReactNode;
};

const NAV_BAR_HEIGHT = Platform.select({ android: 56, default: 44 }) as number;
/** How much of the window the first screen takes, so the next section visibly waits below. */
const SCREEN_SHARE = 0.86;
const BACKDROP_RATIO = 16 / 9;
const TALLEST_RATIO = 4 / 3;
/** The ambient tint over the blurred artwork. */
const AMBIENT_SCRIM = 0.45;
/** The extra Ink behind the words, on top of the ambient tint (about 0.83 in total). */
const BODY_SCRIM = 0.7;
const BODY_FADE = 72;
/**
 * Ink at the join between the sharp band and the blurred field, which then eases back to
 * the ambient tint. The two layers are the same picture at different scales, so their
 * colours cannot meet exactly; a darker waist is what keeps the join from reading as an edge.
 */
const SEAM = 0.7;
const SEAM_EASE = 96;

/** Below the band: from the seam's Ink back down to the ambient tint. */
const SEAM_GRADIENT = [
  'linear-gradient(to bottom,',
  `${inkAlpha(0.45)} 0%,`,
  `${inkAlpha(0)} 100%)`,
].join(' ');

export function ImmersiveHero({
  artwork,
  posterUri,
  title,
  topInset,
  onHeight,
  children,
}: ImmersiveHeroProps) {
  const { width, height: windowHeight } = useWindowDimensions();
  const [bodyHeight, setBodyHeight] = useState(0);
  const minHeight = Math.round(windowHeight * SCREEN_SHARE);

  const backdrop = artwork.treatment === 'backdrop';
  const natural = width / BACKDROP_RATIO;
  const tallest = width / TALLEST_RATIO;
  const posterBand = topInset + NAV_BAR_HEIGHT + theme.poster.detail.height + theme.space[6];
  const band = backdrop
    ? Math.round(Math.min(Math.max(natural, minHeight - bodyHeight), tallest))
    : Math.round(Math.max(natural, posterBand));

  return (
    <View
      testID="immersive-hero"
      style={[styles.frame, { minHeight }]}
      onLayout={(event) => onHeight?.(event.nativeEvent.layout.height)}
    >
      {artwork.uri ? (
        <Image
          source={{ uri: artwork.uri }}
          contentFit="cover"
          blurRadius={40}
          style={StyleSheet.absoluteFill}
          accessibilityIgnoresInvertColors
        />
      ) : null}
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: inkAlpha(artwork.uri ? AMBIENT_SCRIM : 1) }]}
      />

      <View testID="immersive-art" style={{ height: band }}>
        {backdrop ? (
          <>
            <Image
              source={{ uri: artwork.uri }}
              contentFit="cover"
              contentPosition="center"
              transition={theme.duration.navigation}
              style={StyleSheet.absoluteFill}
              accessibilityIgnoresInvertColors
            />
            <View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, { experimental_backgroundImage: ART_FADE }]}
            />
          </>
        ) : (
          <View style={[styles.posterBand, { paddingTop: topInset + NAV_BAR_HEIGHT }]}>
            <View style={styles.posterFrame}>
              <Poster uri={posterUri} title={title} size="detail" />
            </View>
          </View>
        )}
        <View
          pointerEvents="none"
          style={[
            styles.topScrim,
            { height: topInset + NAV_BAR_HEIGHT, experimental_backgroundImage: TOP_SCRIM },
          ]}
        />
      </View>

      {backdrop ? (
        <View
          pointerEvents="none"
          style={[styles.seam, { top: band, experimental_backgroundImage: SEAM_GRADIENT }]}
        />
      ) : null}

      {/* The space between the band and the words is the ambient artwork, and it is what
          puts the words at the foot of the screen. */}
      <View style={styles.spacer} />

      <View
        testID="immersive-body"
        style={[styles.body, artwork.uri ? styles.bodyOnArtwork : null]}
        onLayout={(event) => setBodyHeight(Math.round(event.nativeEvent.layout.height))}
      >
        {artwork.uri ? (
          <View
            pointerEvents="none"
            style={[styles.bodyFade, { experimental_backgroundImage: BODY_FADE_GRADIENT }]}
          />
        ) : null}
        {children}
      </View>
    </View>
  );
}

/** The band's lower part, darkening into the ambient tint below it. */
const ART_FADE = [
  'linear-gradient(to bottom,',
  `${inkAlpha(0)} 0%,`,
  `${inkAlpha(0)} 55%,`,
  `${inkAlpha(0.35)} 80%,`,
  `${inkAlpha(SEAM)} 100%)`,
].join(' ');

/** The fade above the words, into the Ink they sit on. */
const BODY_FADE_GRADIENT = [
  'linear-gradient(to bottom,',
  `${inkAlpha(0)} 0%,`,
  `${inkAlpha(BODY_SCRIM)} 100%)`,
].join(' ');

/** The same top scrim `TitleHero` draws, so the back and menu controls read on any art. */
const TOP_SCRIM = [
  'linear-gradient(to bottom,',
  `${inkAlpha(0.38)} 0%,`,
  `${inkAlpha(0.22)} 45%,`,
  `${inkAlpha(0.06)} 78%,`,
  `${inkAlpha(0)} 100%)`,
].join(' ');

const styles = StyleSheet.create({
  frame: { backgroundColor: brand.ink, overflow: 'hidden' },
  topScrim: { position: 'absolute', top: 0, left: 0, right: 0 },
  posterBand: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  posterFrame: { ...theme.elevation.e2, borderRadius: theme.radius.card },
  spacer: { flex: 1 },
  seam: { position: 'absolute', left: 0, right: 0, height: SEAM_EASE },
  bodyOnArtwork: { backgroundColor: inkAlpha(BODY_SCRIM) },
  bodyFade: { position: 'absolute', left: 0, right: 0, top: -BODY_FADE, height: BODY_FADE },
  body: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
    paddingBottom: theme.space[6],
    gap: theme.space[4],
  },
});
