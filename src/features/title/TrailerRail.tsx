import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { videoUri } from '@/lib/images';
import { Text } from '@/ui/components';
import { inkAlpha, paperAlpha, theme } from '@/ui/tokens';

import type { TitleVideo } from './use-title-extras';

/**
 * The Trailers section of the Cinematic title page: one card per video, in a horizontal rail
 * (Cinematic Editorial brief, §5; a section rather than a tab since the title-page sprint,
 * 2026-11-06).
 *
 * **Thumbnails only when asked for.** A thumbnail is an image from YouTube's own host
 * (`i.ytimg.com`), which is a request to a third party carrying the reader's IP. When this
 * was a tab, those requests waited for the reader to open it. As an always-visible section
 * they would go out on every title page, so the cards draw without them — a play glyph on
 * Parchment, the name and where it plays — until the reader asks for previews
 * (`previews`), once per page. Opening a video is unchanged, and was always theirs to ask for.
 *
 * **No inline playback and no autoplay.** The app has no video player, and the brief says
 * not to add a native dependency for one, so a tap does exactly what the Original page's
 * row does: open the video on YouTube through `Linking`. The thumbnail is YouTube's own
 * still for that video id, loaded only once previews are asked for. A video whose key is not a
 * valid YouTube id has no thumbnail and no link — the same refusal `videoUri` makes for
 * the row.
 */
export function TrailerRail({
  videos,
  label,
  sub,
  previews = true,
  gutter,
}: {
  videos: readonly TitleVideo[];
  /** The video's name as the Original page prints it (`videoTitle`). */
  label: (video: TitleVideo) => string;
  /** Where it plays and what it is: `YouTube · Trailer`. */
  sub: (video: TitleVideo) => string;
  /** Load YouTube's thumbnails. False: draw the cards without them (see above). */
  previews?: boolean;
  /** Where the first card starts, when the page's content line is not the gutter. */
  gutter?: number;
}) {
  if (!videos.length) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.rail, gutter !== undefined && { paddingHorizontal: gutter }]}
      testID="trailer-rail"
    >
      {videos.map((video) => {
        const uri = video.site === 'YouTube' ? videoUri(video.key) : null;
        const still = uri && previews ? `https://i.ytimg.com/vi/${video.key}/hqdefault.jpg` : null;
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
          >
            <View style={styles.thumb}>
              {still ? (
                <Image
                  source={{ uri: still }}
                  contentFit="cover"
                  style={StyleSheet.absoluteFill}
                  accessibilityIgnoresInvertColors
                />
              ) : null}
              <View style={styles.play} pointerEvents="none">
                <Ionicons name="play" size={theme.layout.icon.md} color={theme.text.inverse} />
              </View>
            </View>
            <Text variant="callout" numberOfLines={1}>
              {label(video)}
            </Text>
            <Text variant="caption" tone="tertiary" numberOfLines={1}>
              {sub(video)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const THUMB_WIDTH = 184;

const styles = StyleSheet.create({
  rail: {
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[2],
  },
  card: { width: THUMB_WIDTH, gap: theme.space[1] },
  thumb: {
    width: THUMB_WIDTH,
    aspectRatio: 16 / 9,
    borderRadius: theme.radius.control,
    overflow: 'hidden',
    backgroundColor: theme.surface.sunken,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border.hairline,
  },
  play: {
    width: 44,
    height: 44,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: inkAlpha(0.55),
    borderWidth: 1,
    borderColor: paperAlpha(0.6),
  },
  pressed: { opacity: 0.7 },
});
