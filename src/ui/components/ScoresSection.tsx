import { StyleSheet, View } from 'react-native';

import type { Bucket } from '@/features/collection/score';

import { theme } from '../tokens';
import { EmptyScoreBadge, ScoreBadge } from './ScoreBadge';
import { SectionHeader } from './SectionHeader';
import { Text } from './Text';

export type ScoresSectionProps = {
  /**
   * The reader's own, repeated here on purpose.
   *
   * It is also opposite the poster, and that used to be the argument for leaving it
   * out. The founder's amendment settles it the other way: this section is a
   * comparison, and a comparison with one of its three terms on a different part of
   * the page is a comparison the reader has to hold in their head.
   */
  yours?: { score: number | null; bucket: Bucket | null } | null;
  /**
   * The mean over the accounts this viewer follows. Omitted, rather than shown empty,
   * when the reader follows nobody — see the note below.
   */
  following?: {
    score: number | null;
    ratingCount: number;
    /** Drawn only for a reader who follows somebody. */
    followingCount: number;
  } | null;
  /** The app-wide mean. Withheld below its sample size, and the circle stays either way. */
  bingd: {
    score: number | null;
    ratingCount: number;
    minRatings: number;
  } | null;
};

/**
 * Three answers to the same question, in the order a reader cares about them.
 *
 *   **Your score** — what you thought.
 *   **Following** — what the people you chose to follow thought.
 *   **Bingd** — what everybody on the app thought.
 *
 * The population widens as you go down and the reader's stake in it narrows, which is
 * why that is the order rather than the reverse. "Community" was the old name for the
 * third row and it described a population rather than naming one; this is the app, and
 * the app has a name.
 *
 * **Following activates on a single rating, Bingd does not.** One account you
 * deliberately follow is not a weak estimate of a crowd; it is that person's opinion,
 * and it is the only case a new account can produce at all. A Bingd mean over two
 * strangers is a different thing entirely: it looks like data and is not, so the number
 * waits for the sample the server sets.
 *
 * **The circle is always drawn.** Founder instruction, and it does two jobs. A row that
 * grows a circle when the data arrives is a row that moves; and the empty circle is
 * itself the honest statement that there is a score-shaped hole here rather than a
 * score. What it must never do is put a faded or greyed *number* in that hole, which
 * would be a fact the page does not believe.
 *
 * **Below the threshold Bingd says "Not enough ratings yet" and stops.** It used to say
 * "2 ratings · 1 more needed", which turns a reader into a spectator of a counter and
 * tells them nothing they can act on. The count is not a secret; it is simply not
 * interesting until it means something.
 *
 * Two silences told apart, and this is the part that keeps Following discoverable. A
 * reader who **follows nobody** gets no row: it could only ever be empty. A reader who
 * **follows people, none of whom have seen this** is told exactly that, which is a real
 * answer and is also how anybody learns the feature exists before their following list
 * happens to overlap a film they open.
 */
export function ScoresSection({ yours, following, bingd }: ScoresSectionProps) {
  const showFollowing = Boolean(following && following.followingCount > 0);
  if (!yours && !showFollowing && !bingd) return null;

  return (
    <View style={styles.section}>
      <SectionHeader title="Scores" />

      {yours ? (
        <ScoreRow
          score={yours.score}
          bucket={yours.bucket}
          label="Your score"
          detail={yours.score == null ? 'You have not ranked this yet' : null}
          emptyLabel="You have not ranked this yet"
        />
      ) : null}

      {showFollowing && following ? (
        <ScoreRow
          score={following.score}
          label="Following"
          detail={followingDetail(following.ratingCount)}
          emptyLabel="Nobody you follow has ranked this"
        />
      ) : null}

      {bingd ? (
        <ScoreRow
          score={bingd.score}
          label="Bingd"
          detail={bingdDetail(bingd)}
          emptyLabel="Not enough ratings yet"
        />
      ) : null}
    </View>
  );
}

function ScoreRow({
  score,
  bucket,
  label,
  detail,
  emptyLabel,
}: {
  score: number | null;
  bucket?: Bucket | null;
  label: string;
  detail: string | null;
  emptyLabel: string;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.value}>
        {score != null ? (
          <ScoreBadge score={score} bucket={bucket ?? null} size="md" />
        ) : (
          <EmptyScoreBadge size="md" label={emptyLabel} />
        )}
      </View>
      <View style={styles.copy}>
        <Text variant="callout">{label}</Text>
        {detail ? (
          <Text variant="footnote" tone="secondary">
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** How many of the reader's own people are behind the number. */
function followingDetail(ratingCount: number): string {
  if (ratingCount === 0) return 'Nobody you follow has ranked this';
  if (ratingCount === 1) return '1 person you follow';
  return `${ratingCount} people you follow`;
}

/**
 * "128 ratings", or the fact that there are not enough of them to say.
 *
 * No countdown. "2 more needed" invites the reader to watch a number they cannot move,
 * and the exact shortfall is a property of a config value rather than of the film.
 */
function bingdDetail({
  score,
  ratingCount,
}: {
  score: number | null;
  ratingCount: number;
  minRatings: number;
}): string {
  if (score == null) return 'Not enough ratings yet';
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
