import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { theme } from '../tokens';
import { EmptyScoreBadge, ScoreBadge } from './ScoreBadge';
import { SectionHeader } from './SectionHeader';
import { Text } from './Text';

export type ScoresSectionProps = {
  /** The app-wide mean, withheld below the sample size the server sets. */
  bingd: { score: number | null; ratingCount: number } | null;
  /** The mean over the accounts this viewer follows. One eligible rating is enough. */
  following: { score: number | null; ratingCount: number } | null;
};

/** Said the same way in both units, and it is the whole of the empty state. */
const NOT_ENOUGH = 'Not enough ratings';

/**
 * Below this, or under enough font scaling, the two units become two rows.
 *
 * **Raised from 340 with the horizontal composition.** Each unit now spends about 56pt
 * on the circle and the gap beside it before its words start, which the stacked version
 * did not: the circle sat *above* the label and the full column width was the text's.
 * At 340 that left roughly 90pt for a line whose widest content is `Not enough
 * ratings`, and it broke mid-word.
 *
 * 360 is the narrowest screen in ordinary use — a small Android, an iPhone 12 mini —
 * and at 360 each unit has about 100pt of text, where `Not enough` sets on one line and
 * `ratings` on the next. Below that is the 320-class device the brief calls "very
 * narrow", and it gets the full-width rows, which cost a little height and cost
 * legibility nothing.
 */
const TWO_COLUMN_MIN_WIDTH = 360;
const TWO_COLUMN_MAX_FONT_SCALE = 1.3;

/**
 * What other people thought, in the order the founder set.
 *
 *   **Bingd** — what everybody on the app thought.
 *   **Following** — what the people you chose to follow thought.
 *
 * Bingd leads because it is the app's own number and the one that is there to be
 * compared against; Following is the narrower, more personal reading of the same
 * question. It ran the other way until the founder's Preview pass.
 *
 * **A circle on the left with its words beside it**, twice, side by side — the
 * composition the founder asked for after reviewing the Preview. It was a circle
 * *above* its words, which made each unit a tall centred stack and the pair read as two
 * unrelated things rather than as one comparison. Horizontal, the number is where the
 * eye lands first and the label explains it, which is the order somebody reads them in
 * anyway.
 *
 * Below {@link TWO_COLUMN_MIN_WIDTH}, or with type scaled past
 * {@link TWO_COLUMN_MAX_FONT_SCALE}, the two units become two full-width rows. Same
 * composition, more room: the fallback is a wider line, not a different design.
 *
 * **The inset rule above the header** separates the scores from the actions over them.
 * Inset to the gutter and at the hairline the rest of the app uses — a full-bleed rule
 * would cut the page in half and announce a new screen, which this is not. It is the
 * only structural line on the title page and it is there because scores were reading as
 * a continuation of the action row rather than as their own block.
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
 * **The circle is always drawn.** Founder instruction, and it does two jobs. A unit
 * that grows a circle when the data arrives is a unit that moves; and the empty circle
 * is itself the honest statement that there is a score-shaped hole here rather than a
 * score. What it must never do is put a faded or greyed *number* in that hole, which
 * would be a fact the page does not believe.
 *
 * **Both units say the same four words when empty, and neither counts down.** `2 more
 * needed` turns a reader into a spectator of a number they cannot move, and the exact
 * shortfall is a property of a config value rather than of the film.
 */
export function ScoresSection({ bingd, following }: ScoresSectionProps) {
  const { width, fontScale } = useWindowDimensions();

  if (!following && !bingd) return null;

  const sideBySide = width >= TWO_COLUMN_MIN_WIDTH && fontScale <= TWO_COLUMN_MAX_FONT_SCALE;

  return (
    <View style={styles.section}>
      {/* Decorative and inset. No accessibility role: a screen reader announcing a
          separator here would put a word between the actions and the scores where the
          design puts a pause. */}
      <View testID="scores-divider" style={styles.divider} />

      <SectionHeader title="Scores" />

      {/* One container either way. The testID is how the layout test tells them apart:
          there is no role for "two columns", and reading it off the tree by shape made
          the test agree with any stack that happened to have a row in it. */}
      <View testID="scores-layout" style={sideBySide ? styles.columns : styles.rows}>
        {bingd ? (
          <Score
            score={bingd.score}
            // The product's own name, written the way the wordmark writes it. It sits
            // beside "Following", so the two labels name two populations — and this one
            // is the whole of bingd. rather than a generic "community".
            label="bingd."
            detail={ratingsDetail(bingd.ratingCount)}
            sideBySide={sideBySide}
          />
        ) : null}
        {following ? (
          <Score
            score={following.score}
            label="Following"
            detail={followingDetail(following.ratingCount)}
            sideBySide={sideBySide}
          />
        ) : null}
      </View>
    </View>
  );
}

/**
 * One score: the circle, then the label and the sample beside it.
 *
 * The composition is the same in both layouts and only the width changes, so the copy
 * rules cannot differ between them — which they could when one layout stacked and the
 * other did not.
 */
function Score({
  score,
  label,
  detail,
  sideBySide,
}: {
  score: number | null;
  label: string;
  /** How big the sample behind the number is. Only ever drawn when there is a number. */
  detail: string;
  sideBySide: boolean;
}) {
  const badge =
    score != null ? (
      <ScoreBadge score={score} bucket={null} size="md" />
    ) : (
      <EmptyScoreBadge size="md" label={`${label}: ${NOT_ENOUGH}`} />
    );

  return (
    <View testID="scores-unit" style={sideBySide ? styles.unit : styles.row}>
      {badge}
      <View style={styles.copy}>
        <Text variant="callout">{label}</Text>
        <Text
          variant="footnote"
          tone="secondary"
          // Two lines in a half-width unit, where "Not enough ratings" does not fit on
          // one. Truncating it would leave "Not enough" on the page, which reads as the
          // app trailing off mid-sentence.
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
 * Only reached with a number beside it. Below the threshold the unit says
 * {@link NOT_ENOUGH} and stops: no countdown, because "2 more needed" invites the
 * reader to watch a figure they cannot move and the exact shortfall is a property of a
 * config value rather than of the film.
 */
function ratingsDetail(ratingCount: number): string {
  return ratingCount === 1 ? '1 rating' : `${ratingCount} ratings`;
}

const styles = StyleSheet.create({
  section: { paddingTop: theme.space[5], gap: theme.space[2] },

  /** Inset to the gutter, at the app's hairline. Doubled because a single
   *  `hairlineWidth` rounds away to nothing on some Android densities, which is the
   *  same reason every other rule in the app is drawn this way. */
  divider: {
    marginHorizontal: theme.layout.gutter,
    marginBottom: theme.space[2],
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: theme.border.hairline,
  },

  // Two equal halves. Equal rather than content-sized, so the two circles sit at
  // predictable places and the pair reads as a comparison rather than as a sentence.
  columns: {
    flexDirection: 'row',
    paddingHorizontal: theme.layout.gutter,
    gap: theme.space[4],
  },
  unit: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },

  // The fallback: the same unit, one per line, with the whole width to set in.
  rows: { gap: theme.space[2] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    minHeight: theme.layout.rowMinHeight,
  },

  // `flexShrink` rather than `flex: 1`, so the text yields to the circle instead of the
  // circle being squeezed out of round. A score badge that is 40 wide and 44 tall is
  // the one thing on this section that must not happen.
  copy: { flexShrink: 1, gap: 2 },
});
