import { StyleSheet, View, useWindowDimensions } from 'react-native';

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

/** Said the same way in both columns, and it is the whole of the empty state. */
const NOT_ENOUGH = 'Not enough ratings';

/**
 * Below this, or under enough font scaling, the two columns become two rows.
 *
 * `Not enough ratings` is the widest thing either column has to hold. In half of a
 * 360pt screen, less the gutters, it wraps to two lines and still reads; below that it
 * starts breaking mid-word, and a reader who has turned type size up is exactly the
 * reader a cramped two-column row fails. Falling back to the old stacked rows costs a
 * little height on a narrow device and costs legibility nowhere.
 */
const TWO_COLUMN_MIN_WIDTH = 340;
const TWO_COLUMN_MAX_FONT_SCALE = 1.3;

/**
 * What other people thought, in the order a reader cares about them.
 *
 *   **Following** — what the people you chose to follow thought.
 *   **Bingd** — what everybody on the app thought.
 *
 * The population widens left to right and the reader's stake in it narrows, which is
 * why that is the order rather than the reverse.
 *
 * **Two columns, since the founder's final pass.** They were two full-width rows, and
 * two rows of a circle beside two short lines is a tall block saying very little —
 * especially in the state most titles are actually in, where both say "Not enough
 * ratings". Side by side they read as one comparison, which is what they are, and the
 * section costs about half the vertical space. Below {@link TWO_COLUMN_MIN_WIDTH}, or
 * with type scaled past {@link TWO_COLUMN_MAX_FONT_SCALE}, it falls back to the rows
 * rather than forcing a column to overflow.
 *
 * **Your own score is not here, and that is the founder's correction of 2026-08-18.**
 * It leads the hero, opposite the poster, with the rank context and the Ranked control
 * beside it. Repeating it here put the same number on the page twice — and the second
 * copy was the weaker of the two, because it had no rank line and no way to change the
 * rating. This section answers "what did everyone else make of it", which is a
 * different question and does not need the reader's own answer restated to be asked.
 *
 * **Following activates on a single rating, Bingd does not.** One account you
 * deliberately follow is not a weak estimate of a crowd; it is that person's opinion,
 * and it is the only case a new account can produce at all. A Bingd mean over two
 * strangers is a different thing entirely: it looks like data and is not, so the number
 * waits for the sample the server sets — ten ratings.
 *
 * **The circle is always drawn.** Founder instruction, and it does two jobs. A column
 * that grows a circle when the data arrives is a column that moves; and the empty
 * circle is itself the honest statement that there is a score-shaped hole here rather
 * than a score. What it must never do is put a faded or greyed *number* in that hole,
 * which would be a fact the page does not believe.
 *
 * **Both columns say the same four words when empty, and neither counts down.** `2 more
 * needed` turns a reader into a spectator of a number they cannot move, and the exact
 * shortfall is a property of a config value rather than of the film.
 */
export function ScoresSection({ following, bingd }: ScoresSectionProps) {
  const { width, fontScale } = useWindowDimensions();

  if (!following && !bingd) return null;

  const sideBySide =
    width >= TWO_COLUMN_MIN_WIDTH && fontScale <= TWO_COLUMN_MAX_FONT_SCALE;

  return (
    <View style={styles.section}>
      <SectionHeader title="Scores" />

      {/* One container either way. The testID is how the layout test tells them apart:
          there is no role for "two columns", and reading it off the tree by shape made
          the test agree with any stack that happened to have a row in it. */}
      <View testID="scores-layout" style={sideBySide ? styles.columns : styles.rows}>
        {following ? (
          <Score
            score={following.score}
            label="Following"
            detail={followingDetail(following.ratingCount)}
            stacked={sideBySide}
          />
        ) : null}
        {bingd ? (
          <Score
            score={bingd.score}
            label="Bingd"
            detail={ratingsDetail(bingd.ratingCount)}
            stacked={sideBySide}
          />
        ) : null}
      </View>
    </View>
  );
}

/**
 * One score. The circle above its words in the two-column layout, beside them in the
 * fallback — one component either way, so the copy rules cannot differ between them.
 */
function Score({
  score,
  label,
  detail,
  stacked,
}: {
  score: number | null;
  label: string;
  /** How big the sample behind the number is. Only ever drawn when there is a number. */
  detail: string;
  stacked: boolean;
}) {
  const badge =
    score != null ? (
      <ScoreBadge score={score} bucket={null} size="md" />
    ) : (
      <EmptyScoreBadge size="md" label={`${label}: ${NOT_ENOUGH}`} />
    );

  return (
    <View style={stacked ? styles.column : styles.row}>
      <View style={stacked ? styles.columnBadge : styles.rowBadge}>{badge}</View>
      <View style={stacked ? styles.columnCopy : styles.rowCopy}>
        <Text variant="callout">{label}</Text>
        <Text
          variant="footnote"
          tone="secondary"
          // Two lines in a half-width column, where "Not enough ratings" does not fit
          // on one. Truncating it would leave "Not enough" on the page, which reads as
          // the app trailing off mid-sentence.
          numberOfLines={2}
        >
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
 * Only reached with a number beside it. Below the threshold the column says
 * {@link NOT_ENOUGH} and stops: no countdown, because "2 more needed" invites the
 * reader to watch a figure they cannot move and the exact shortfall is a property of a
 * config value rather than of the film.
 */
function ratingsDetail(ratingCount: number): string {
  return ratingCount === 1 ? '1 rating' : `${ratingCount} ratings`;
}

const styles = StyleSheet.create({
  section: { paddingTop: theme.space[6], gap: theme.space[2] },

  // Two equal halves. Equal rather than content-sized, so the two circles sit at
  // predictable places and the pair reads as a comparison rather than as a sentence.
  columns: {
    flexDirection: 'row',
    paddingHorizontal: theme.layout.gutter,
    gap: theme.space[4],
  },
  column: { flex: 1, alignItems: 'center', gap: theme.space[1] },
  columnBadge: { alignItems: 'center' },
  columnCopy: { alignItems: 'center', gap: 2 },

  // The fallback: what this section was before, unchanged.
  rows: { gap: theme.space[2] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[4],
    paddingHorizontal: theme.layout.gutter,
    minHeight: theme.layout.rowMinHeight,
  },
  // Fixed, so an empty circle and a 7.4 put their labels in the same place.
  rowBadge: { width: theme.layout.scoreBadge.md + theme.space[3], alignItems: 'center' },
  rowCopy: { flex: 1, gap: 2 },
});
