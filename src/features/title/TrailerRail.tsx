import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { videoUri } from '@/lib/images';
import { Text } from '@/ui/components';
import { brand, inkAlpha, paperAlpha, theme } from '@/ui/tokens';

import type { TitleVideo } from './use-title-extras';

/**
 * The Trailers section of the Cinematic title page: one card per video, in a horizontal rail
 * (Cinematic Editorial brief, §5; a section rather than a tab since the title-page sprint,
 * 2026-11-06).
 *
 * **Thumbnails only when asked for.** A thumbnail is an image from YouTube's own host
 * (`i.ytimg.com`), which is a request to a third party carrying the reader's IP. When this
 * was a tab, those requests waited for the reader to open it. As an always-visible section
 * they would go out on every title page, so the cards draw without them until the reader
 * asks for previews (`previews`), once per page. Opening a video is unchanged, and was
 * always theirs to ask for.
 *
 * **A video tile, not a missing picture** (final title refinement, 2026-11-06). The cards
 * used to be Parchment boxes with a play glyph, which on the phone read as artwork that had
 * failed to load. Each card is now an Ink 16:9 frame — the shape and colour of a video
 * before it plays — with a Parchment play button and the video's kind (`Trailer`, `Teaser`)
 * in its corner, unless its name already says it. That frame is the card before previews, while a preview loads, and for
 * good if YouTube has no still for the video (a removed or private one answers 404): the
 * still fades in over it when it arrives and is simply not drawn when it fails, so no
 * state is a blank rectangle.
 *
 * **No inline playback and no autoplay.** The app has no video player, and the brief says
 * not to add a native dependency for one, so a tap does exactly what the Original page's
 * row does: open the video on YouTube through `Linking`. The still is YouTube's own
 * `hqdefault` for that video id, which exists for every public video, and expo-image keeps
 * it in its disk cache like every other image in the app. A video whose key is not a valid
 * YouTube id has no still, no play button and no link — the same refusal `videoUri` makes
 * for the row.
 */
export function TrailerRail({
  videos,
  label,
  site,
  previews = true,
}: {
  videos: readonly TitleVideo[];
  /** The video's name as the Original page prints it (`videoTitle`). */
  label: (video: TitleVideo) => string;
  /** Where it plays, as a word: `YouTube`. */
  site: (video: TitleVideo) => string;
  /** Load YouTube's thumbnails. False: draw the cards without them (see above). */
  previews?: boolean;
}) {
  /** Stills YouTube could not serve on this page; their cards keep the plain frame. */
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  if (!videos.length) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.rail}
      testID="trailer-rail"
    >
      {videos.map((video) => {
        const uri = video.site === 'YouTube' ? videoUri(video.key) : null;
        const still =
          uri && previews && !failed.has(video.key)
            ? `https://i.ytimg.com/vi/${video.key}/hqdefault.jpg`
            : null;
        const kind = video.type || 'Video';
        // "Trailer" over a card already named "Trailer" says it twice.
        const showKind = kind.toLowerCase() !== label(video).trim().toLowerCase();
        return (
          <Pressable
            key={video.id}
            accessibilityRole="link"
            accessibilityLabel={`Play ${label(video)} on YouTube`}
            disabled={!uri}
            onPress={() => {
              if (uri) void Linking.openURL(uri);
            }}
            style={({ pressed }) => [styles.card, pressed && styles.pressed]}
            testID={`trailer-card-${video.key}`}
          >
            <View style={styles.thumb} testID="trailer-thumb">
              {still ? (
                <Image
                  source={{ uri: still }}
                  contentFit="cover"
                  transition={theme.duration.navigation}
                  style={StyleSheet.absoluteFill}
                  onError={() => setFailed((prev) => new Set(prev).add(video.key))}
                  // A removed or private video answers 404 *with* YouTube's grey 120×90
                  // placeholder, which a client that decodes the body draws as a grey
                  // logo in the frame (marquee cohesion sprint, measured against the
                  // real host). A real `hqdefault` is 480 wide, so anything this small is
                  // the placeholder and the card keeps its Ink frame.
                  onLoad={(event) => {
                    const width = event?.source?.width;
                    if (typeof width === 'number' && width <= PLACEHOLDER_WIDTH) {
                      setFailed((prev) => new Set(prev).add(video.key));
                    }
                  }}
                  accessibilityIgnoresInvertColors
                  testID="trailer-still"
                />
              ) : null}
              {showKind ? (
                <View style={styles.kind} pointerEvents="none">
                  <Text variant="caption" style={styles.kindText} numberOfLines={1}>
                    {kind}
                  </Text>
                </View>
              ) : null}
              {uri ? (
                <View style={styles.play} pointerEvents="none">
                  <Ionicons name="play" size={theme.layout.icon.md} color={theme.semantic.action} />
                </View>
              ) : null}
            </View>
            <Text variant="callout" numberOfLines={1}>
              {label(video)}
            </Text>
            <Text variant="caption" tone="tertiary" numberOfLines={1}>
              {site(video)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const THUMB_WIDTH = 184;
/** YouTube's "no thumbnail" image is 120×90; every real still here is 480 wide. */
const PLACEHOLDER_WIDTH = 200;
const PLAY_SIZE = 40;

const styles = StyleSheet.create({
  // No top padding: the section's space above the rail is outside the scroll view, where the
  // heading's Show previews slop can use it (final title refinement, 2026-11-06).
  rail: {
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
  },
  card: { width: THUMB_WIDTH, gap: theme.space[1] },
  thumb: {
    width: THUMB_WIDTH,
    aspectRatio: 16 / 9,
    borderRadius: theme.radius.control,
    overflow: 'hidden',
    backgroundColor: brand.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The video's kind, top left: on the plain frame and on a still alike, so it sits on a
  // small Ink plate that keeps it legible over a bright picture.
  kind: {
    position: 'absolute',
    top: theme.space[2],
    left: theme.space[2],
    paddingHorizontal: theme.space[2],
    paddingVertical: 1,
    borderRadius: theme.radius.full,
    backgroundColor: inkAlpha(0.6),
    maxWidth: THUMB_WIDTH - theme.space[4],
  },
  kindText: { color: paperAlpha(0.92) },
  play: {
    width: PLAY_SIZE,
    height: PLAY_SIZE,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: brand.parchment,
    // The glyph is a triangle; its centre of mass sits left of the box's centre.
    paddingLeft: 3,
  },
  pressed: { opacity: 0.7 },
});
