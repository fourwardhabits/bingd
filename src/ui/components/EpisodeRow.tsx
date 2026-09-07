import { Image } from 'expo-image';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

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
 * **The clamp opens** (founder, physical Android, 2026-09-07). It was three lines with
 * no way past them, so an episode whose synopsis ran longer simply ended mid-sentence —
 * and the one case a reader most needs the rest of the text is the one where three lines
 * were not enough to recognise it. The affordance is the title page’s own: a `more` in
 * Maroon under the clamped text, which expands it in place. Scannability is preserved by
 * the default rather than by the ceiling: every row still opens clamped, and one open
 * row does not open the other twenty-three.
 *
 * **No `less`, which is the app’s existing convention** (the title page’s synopsis says
 * so too): once it is open the whole thing is visible and the control has nothing left
 * to promise. The row is still not a *record* — opening a synopsis logs nothing.
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
  /**
   * Per row, and deliberately not lifted.
   *
   * A season page holds twenty-odd of these and each one is its own question. Hoisting
   * this into the screen would make "which episodes are open" a piece of page state to
   * reset, persist and reason about, for a preference that lasts as long as somebody is
   * looking at one episode.
   */
  const [expanded, setExpanded] = useState(false);
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
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={expanded ? 'Collapse description' : 'Expand description'}
          onPress={() => setExpanded((open) => !open)}
          style={styles.synopsis}
        >
          <Text variant="body" tone="secondary" numberOfLines={expanded ? undefined : 3}>
            {overview}
          </Text>
          {/* No "less": the title page’s synopsis sets the convention, and once the
              text is open the control has nothing left to promise. Pressing again
              still closes it — the affordance is gone, not the behaviour. */}
          {expanded ? null : (
            <Text variant="callout" tone="action">
              more
            </Text>
          )}
        </Pressable>
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
  // The text and its affordance are one target, gapped like the row above them.
  synopsis: { gap: theme.space[1] },
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
