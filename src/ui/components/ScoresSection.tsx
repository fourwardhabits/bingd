import { StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { SectionHeader } from './SectionHeader';
import { Text } from './Text';

export type ScoresSectionProps = {
  community: {
    score: number | null;
    ratingCount: number;
    minRatings: number;
  } | null;
};

/**
 * Everyone else's number, given its own place further down the page.
 *
 * It used to sit beside the reader's own score in the hero, and the two competed:
 * identical shape, identical weight, one about you and one about the room. The
 * founder's amendment separates them — the hero answers "what did *I* think", and
 * this answers "what does everyone think" — which is also the order somebody reads a
 * title page in.
 *
 * Only what Bingd can truthfully support today. There is exactly one signal:
 *
 *   **Community** — the mean over public, active accounts the viewer could read
 *   individually, from live rankings, for this exact media item. Withheld below the
 *   configured sample size, and the count shown either way, because "2 ratings" tells
 *   a reader how much to trust what they are looking at where a mean of two does not.
 *
 * Deliberately absent, and worth naming so the absence reads as a decision:
 *
 *   **Following** — the mean over people the viewer follows. The data exists, but
 *   computing it needs each follower's band sizes, and `rankings` is scoped per owner
 *   by row level security. It therefore needs a definer aggregate of its own, with its
 *   own visibility argument and its own review. That is a backend change, not a
 *   polish-pass one, and inventing it here is how a social feature ships without the
 *   scrutiny its exposure deserves.
 *
 *   **Your score** — already prominent opposite the poster. Repeating it here would
 *   be the duplication the amendment asks to avoid.
 *
 * The number is never faded or tinted by how few ratings back it. A score is either
 * shown because it means something or withheld because it does not; a greyed-out
 * number is a third state that says "here is a fact we do not believe", which is not
 * a thing to put on a page.
 */
export function ScoresSection({ community }: ScoresSectionProps) {
  if (!community) return null;

  const { score, ratingCount, minRatings } = community;
  const short = Math.max(minRatings - ratingCount, 0);

  return (
    <View style={styles.section}>
      <SectionHeader title="Scores" />
      <View style={styles.row}>
        <View style={styles.value}>
          {score != null ? (
            <Text variant="title1" style={styles.number} allowFontScaling={false}>
              {score.toFixed(1)}
            </Text>
          ) : (
            // Not a zero and not a faded number: nothing has been earned yet, and
            // both of those would read as a verdict.
            <Text variant="title1" tone="tertiary" allowFontScaling={false}>
              —
            </Text>
          )}
        </View>
        <View style={styles.copy}>
          <Text variant="callout">Community</Text>
          <Text variant="footnote" tone="secondary">
            {label(ratingCount, short)}
          </Text>
        </View>
      </View>
    </View>
  );
}

/** "12 ratings", or exactly how far short of a number it is. */
function label(ratingCount: number, short: number) {
  if (ratingCount === 0) return 'No ratings yet';
  const ratings = ratingCount === 1 ? '1 rating' : `${ratingCount} ratings`;
  if (short <= 0) return ratings;
  return `${ratings} · ${short} more needed`;
}

const styles = StyleSheet.create({
  section: { paddingTop: theme.space[6], gap: theme.space[2] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[4],
    paddingHorizontal: theme.layout.gutter,
    minHeight: theme.layout.rowMinHeight,
  },
  // Fixed, so a "—" and a "7.4" put their labels in the same place.
  value: { width: 56, alignItems: 'center' },
  number: { color: theme.semantic.action },
  copy: { flex: 1, gap: 2 },
});
