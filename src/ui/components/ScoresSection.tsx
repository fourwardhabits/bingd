import { StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { EmptyScoreBadge, ScoreBadge } from './ScoreBadge';
import { SectionHeader } from './SectionHeader';
import { Text } from './Text';

export type ScoresSectionProps = {
  /** The mean over the accounts this viewer follows. One eligible rating is enough. */
  following: { score: number | null; ratingCount: number } | null;
  /** The app-wide mean, withheld below the sample size the server sets. */
  bingd: { score: number | null; ratingCount: number } | null;
};

/** Said the same way in both rows, and it is the whole of the empty state. */
const NOT_ENOUGH = 'Not enough ratings';

/**
 * What other people thought, in the order a reader cares about them.
 *
 *   **Following** — what the people you chose to follow thought.
 *   **Bingd** — what everybody on the app thought.
 *
 * The population widens as you go down and the reader's stake in it narrows, which is
 * why that is the order rather than the reverse.
 *
 * **Your own score is not here, and that is the founder's correction of 2026-08-18.**
 * It leads the hero, opposite the poster, with the rank context and the Ranked control
 * beside it. Repeating it as the first row of this section put the same number on the
 * page twice — and the second copy was the weaker of the two, because it had no rank
 * line and no way to change the rating. This section answers "what did everyone else
 * make of it", which is a different question and does not need the reader's own answer
 * restated to be asked.
 *
 * **Following activates on a single rating, Bingd does not.** One account you
 * deliberately follow is not a weak estimate of a crowd; it is that person's opinion,
 * and it is the only case a new account can produce at all. A Bingd mean over two
 * strangers is a different thing entirely: it looks like data and is not, so the number
 * waits for the sample the server sets — ten ratings.
 *
 * **The circle is always drawn.** Founder instruction, and it does two jobs. A row that
 * grows a circle when the data arrives is a row that moves; and the empty circle is
 * itself the honest statement that there is a score-shaped hole here rather than a
 * score. What it must never do is put a faded or greyed *number* in that hole, which
 * would be a fact the page does not believe.
 *
 * **Both rows say the same four words when empty, and neither counts down.** `2 more
 * needed` turns a reader into a spectator of a number they cannot move, and the exact
 * shortfall is a property of a config value rather than of the film. Two rows that are
 * empty for different underlying reasons still mean one thing to the person reading
 * them: there is not enough here to average yet.
 */
export function ScoresSection({ following, bingd }: ScoresSectionProps) {
  if (!following && !bingd) return null;

  return (
    <View style={styles.section}>
      <SectionHeader title="Scores" />

      {following ? (
        <ScoreRow
          score={following.score}
          label="Following"
          detail={followingDetail(following.ratingCount)}
        />
      ) : null}
      {bingd ? (
        <ScoreRow score={bingd.score} label="Bingd" detail={ratingsDetail(bingd.ratingCount)} />
      ) : null}
    </View>
  );
}

function ScoreRow({
  score,
  label,
  detail,
}: {
  score: number | null;
  label: string;
  /** How big the sample behind the number is. Only ever drawn when there is a number. */
  detail: string;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.value}>
        {score != null ? (
          <ScoreBadge score={score} bucket={null} size="md" />
        ) : (
          <EmptyScoreBadge size="md" label={`${label}: ${NOT_ENOUGH}`} />
        )}
      </View>
      <View style={styles.copy}>
        <Text variant="callout">{label}</Text>
        <Text variant="footnote" tone="secondary">
          {score == null ? NOT_ENOUGH : detail}
        </Text>
      </View>
    </View>
  );
}

/** How many of the reader's own people are behind the number. */
function followingDetail(ratingCount: number): string {
  return ratingCount === 1 ? '1 person you follow' : `${ratingCount} people you follow`;
}

/**
 * "128 ratings".
 *
 * Only reached with a number beside it. Below the threshold the row says
 * {@link NOT_ENOUGH} and stops: no countdown, because "2 more needed" invites the
 * reader to watch a figure they cannot move and the exact shortfall is a property of a
 * config value rather than of the film.
 */
function ratingsDetail(ratingCount: number): string {
  return ratingCount === 1 ? '1 rating' : `${ratingCount} ratings`;
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
  // Fixed, so an empty circle and a 7.4 put their labels in the same place.
  value: { width: theme.layout.scoreBadge.md + theme.space[3], alignItems: 'center' },
  copy: { flex: 1, gap: 2 },
});
