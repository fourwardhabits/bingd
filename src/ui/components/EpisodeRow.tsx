import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type EpisodeRowProps = {
  episodeNumber: number;
  title?: string | null;
  /** Already formatted for display. `null` when TMDB published none. */
  airDate?: string | null;
  runtimeMinutes?: number | null;
  stillUri?: string | null;
  overview?: string | null;
};

/**
 * One episode on a season page, as a recognition cue.
 *
 * **Not a control and not a record.** It has no press target, no checkbox and no
 * score, because an episode is informational metadata in Bingd and nothing else: the
 * rankable unit is the season (PRD §10). What this row is for is helping somebody
 * who remembers watching a show work out *which season* they watched, which is the
 * question the ranking flow cannot ask for them.
 *
 * The hierarchy is ordered by how well each field triggers recognition. The number
 * and the title come first and carry the most weight; the date and runtime sit under
 * them as a quiet metadata line; the still is next because a picture is often what
 * settles it; the synopsis is last and clamped, because three lines is enough to
 * recognise something and a full paragraph twenty-four times over stops the page
 * being scannable.
 *
 * **Everything missing simply disappears.** No "Unknown", no "TBA", no grey
 * placeholder box where a still would be. An unaired episode legitimately has no
 * runtime, no still and often no synopsis, and drawing a frame around each absence
 * would make the common case look broken. If the provider has no title, the number
 * becomes the name — "Episode 4" — rather than the row rendering a blank line.
 */
export function EpisodeRow({
  episodeNumber,
  title,
  airDate,
  runtimeMinutes,
  stillUri,
  overview,
}: EpisodeRowProps) {
  // "3 · The Rains of Castamere", or "Episode 3" when TMDB has no name for it. The
  // number is never dropped: it is the field a reader scans down.
  const heading = title ? `${episodeNumber} · ${title}` : `Episode ${episodeNumber}`;

  // The same `·` separator the title page's own metadata line uses. Built by
  // filtering so that one missing half does not leave a stray separator, and the
  // whole line is absent when both are.
  const meta = [airDate, runtimeMinutes ? `${runtimeMinutes} min` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    // One node to a screen reader rather than four. Read in the order the eye takes
    // them, so a reader who cannot see the still still gets the recognition cues.
    <View
      accessible
      accessibilityLabel={[heading, meta, overview].filter(Boolean).join('. ')}
      style={styles.row}
    >
      <Text variant="callout">{heading}</Text>

      {meta ? (
        <Text variant="caption" tone="tertiary">
          {meta}
        </Text>
      ) : null}

      {stillUri ? (
        <Image
          source={{ uri: stillUri }}
          contentFit="cover"
          transition={theme.duration.state}
          style={styles.still}
          accessibilityIgnoresInvertColors
        />
      ) : null}

      {overview ? (
        <Text variant="body" tone="secondary" numberOfLines={3}>
          {overview}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[4],
    gap: theme.space[2],
  },
  still: {
    width: '100%',
    // 16:9, the same token the backdrop uses. `aspectRatio` rather than a fixed
    // height so the still stays correct at every screen width without a measurement.
    aspectRatio: theme.layout.aspect.backdrop,
    borderRadius: theme.radius.control,
    // A still is landscape artwork on a page that is otherwise type, and without a
    // ground it reads as floating when the image has light edges.
    backgroundColor: theme.surface.sunken,
    marginTop: theme.space[1],
  },
});
