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
  /**
   * The mean over the accounts this viewer follows. Omitted, rather than shown empty,
   * when none of them have ranked the title — see the note below.
   */
  following?: {
    score: number | null;
    ratingCount: number;
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
 *   **Following** — the mean over the accounts the viewer follows, added 2026-08-16.
 *   It sits *above* Community, because the reader chose that population and did not
 *   choose the other one. Shown from a single rating, where Community waits for three:
 *   one person you deliberately follow is not a weak estimate of a crowd, it is their
 *   opinion, and it is the only case a new account can produce at all.
 *
 *   It is **omitted entirely** when nobody the viewer follows has ranked the title,
 *   rather than shown as "No ratings yet". That silence is a fact about the reader's
 *   own following list rather than about the film, and printing it on every title page
 *   of a new account is a row that never says anything. Community is different: there,
 *   "no ratings yet" is a true and useful statement about the title.
 *
 * Deliberately absent, and worth naming so the absence reads as a decision:
 *
 *   **Your score** — already prominent opposite the poster. Repeating it here would
 *   be the duplication the amendment asks to avoid.
 *
 * The number is never faded or tinted by how few ratings back it. A score is either
 * shown because it means something or withheld because it does not; a greyed-out
 * number is a third state that says "here is a fact we do not believe", which is not
 * a thing to put on a page.
 */
export function ScoresSection({ community, following }: ScoresSectionProps) {
  const showFollowing = Boolean(following && following.ratingCount > 0 && following.score != null);
  if (!community && !showFollowing) return null;

  return (
    <View style={styles.section}>
      <SectionHeader title="Scores" />

      {showFollowing && following ? (
        <ScoreRow
          score={following.score}
          label="Following"
          detail={
            following.ratingCount === 1
              ? '1 person you follow'
              : `${following.ratingCount} people you follow`
          }
        />
      ) : null}

      {community ? (
        <ScoreRow
          score={community.score}
          label="Community"
          detail={label(
            community.ratingCount,
            Math.max(community.minRatings - community.ratingCount, 0),
          )}
        />
      ) : null}
    </View>
  );
}

function ScoreRow({
  score,
  label: name,
  detail,
}: {
  score: number | null;
  label: string;
  detail: string;
}) {
  return (
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
        <Text variant="callout">{name}</Text>
        <Text variant="footnote" tone="secondary">
          {detail}
        </Text>
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
  number: { color: theme.semantic.score },
  copy: { flex: 1, gap: 2 },
});
