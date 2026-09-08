import { Pressable, StyleSheet, View } from 'react-native';

import { formatScore } from '@/features/collection/score';

import { theme } from '../tokens';
import { EmptyScoreBadge, ScoreBadge, type ScoreBadgeVariant } from './ScoreBadge';
import { Text } from './Text';

export type ScoresSectionProps = {
  /**
   * **The reader's own score, and the first thing in the row** (founder, 2026-09-07).
   *
   * Absent entirely for a title that cannot be ranked — a series (PRD §10) — where there
   * is no personal score to have, as distinct from not having one yet.
   */
  you: {
    /** Null when this reader has not ranked it. Never a stand-in number. */
    score: number | null;
    /**
     * Ranked, but the number is not knowable yet.
     *
     * A score is derived from the size of the band it sits in (`score.ts`), so the
     * ranking row can be in hand a moment before the band sizes are. The two states read
     * differently and must: `Not ranked yet` under a dash is a fact about the reader,
     * and it is the wrong thing to say beside a control that says Ranked.
     */
    pending?: boolean;
    /** Leads where the Ranked control leads: the menu, or the log. */
    onPress?: () => void;
  } | null;
  /** The app-wide mean, withheld below the sample size the server sets. */
  bingd: { score: number | null; ratingCount: number } | null;
  /** The mean over the accounts this viewer follows. One eligible rating is enough. */
  following: { score: number | null; ratingCount: number } | null;
  /**
   * Opens the people behind the Following number (founder tranche 2026-08-27 §13).
   *
   * Only the Following unit becomes a control, and only while it has members: the
   * bingd. mean is a crowd with no list worth opening, and an empty unit made
   * tappable would be a button into a sheet with nothing to say. Wired by the title
   * page to `FollowingRatingsSheet`.
   */
  onPressFollowing?: () => void;
};

/** bingd.'s empty state: the app is short of a sample, which is not the same as nobody. */
const NOT_ENOUGH = 'Not enough ratings';

/**
 * Following's empty state (founder, physical Android, 2026-09-08).
 *
 * It read `None of your friends have ranked this` for one build, and on the device that
 * sentence set on three lines in a 114pt column and dragged the whole row taller. **The
 * heading has already said whose ratings these are** — the unit is labelled `Following` —
 * so the sentence was spending three lines restating its own label. Four words, one line,
 * and the same shape as the count it replaces.
 */
const NO_FOLLOWING = 'No ratings yet';

/** The reader's own empty state. A statement about them, so it is in the second person. */
const NOT_RANKED = 'Not ranked yet';

/** Said while the ranking row is in hand and the derived number is not. */
const SCORE_LOADING = 'Score loading';

/**
 * What other people made of this title.
 *
 * ---------------------------------------------------------------------------
 * THE HEADING IS BACK, AND FOLLOWING LEADS (founder, 2026-09-07)
 *
 * **`SCORES`.** It was removed on 2026-09-06 on the argument that the units name
 * themselves, and that is true of each unit and not of the pair: two circles with words
 * beside them, arriving under a synopsis with no heading, read as a continuation of the
 * synopsis. The heading costs one line of small Maroon capitals — the treatment every
 * other section in the app announces itself with — and it is what tells a reader that a
 * *different question* is being answered from here down. It also gives the block a
 * landmark a screen reader can jump to, which no arrangement of two units does.
 *
 * **Following first.** It ran bingd.-then-Following since the Preview pass. The founder's
 * order is the other way round now, and the reason is which number is worth more to the
 * person holding the phone: a mean over accounts they chose to follow is a signal about
 * their own taste, and the app-wide mean is a fact about the app. The narrower, more
 * personal reading leads; the broader one is the comparison beside it.
 *
 * ---------------------------------------------------------------------------
 * THE ROW SCROLLS SIDEWAYS, AND WHY THAT REPLACED THE RESPONSIVE FALLBACK
 *
 * There were two of these units and there will not always be two — a critics' aggregate
 * and a friends-only mean have both been asked for — so the row is built to take a third
 * without a rewrite. It was a flex pair that became two stacked full-width rows below
 * 360pt or past 130% type, which is a layout that has to be re-decided every time a unit
 * is added.
 *
 * Sizing each unit to its own content inside a horizontal scroller answers both at once.
 * When the units fit — which is every unit count this app has today, at every ordinary
 * width — the content is narrower than the viewport, it stays left-aligned, and nothing
 * about the layout changes. When they do not, because of a large text size or a third
 * unit, the row scrolls instead of breaking `Not enough ratings` mid-word, which is the
 * exact defect the old minimum width existed to avoid. `alwaysBounceHorizontal={false}`
 * so a row with nowhere to go does not rubber-band.
 *
 * The composition inside a unit is unchanged and is the founder's: a circle on the left
 * with its words beside it, so the number is where the eye lands and the label explains
 * it.
 *
 * ---------------------------------------------------------------------------
 * NO CARD, NO WASH, NO RULE (founder, 2026-09-07)
 *
 * The section is a heading, some air and two units. It has been given a tinted band and
 * a hairline in turn and both are gone: the page had been cut into six bands with rules
 * between them, and the founder's reading on a device is that the separation should come
 * from whitespace and type. A rule survives at exactly one place on this page — above the
 * tab row, which is where the page genuinely changes mode.
 *
 * ---------------------------------------------------------------------------
 * THE READER'S OWN SCORE IS NOW THE FIRST UNIT (founder, 2026-09-07)
 *
 * It was not, from 2026-08-18 until now, and the standing argument was that repeating it
 * here would put the same number on the page twice. That argument was correct and it has
 * been answered by removing the other copy: the number is no longer on the poster. The
 * poster carries artwork and nothing else.
 *
 * What that buys is the thing neither arrangement had. A score beside a poster is a
 * number with nothing to measure it against; the same number as the first of three is a
 * comparison the reader can read straight across — **me, then the people I chose, then
 * the room.** That progression is the section, and the section is the reason the page
 * exists. It is also why the order is fixed and not sorted: it is a hierarchy of
 * relevance to one reader, not a leaderboard.
 *
 * The three carry **no bucket word, no rank and no watch date**. Those were all proposed
 * for the cell under `Your score` and the founder cut them: the first is jargon this
 * screen has never spoken, and the other two are facts about the reader's history with
 * the title rather than qualifications of an aggregate. They stay in the identity block.
 *
 * ---------------------------------------------------------------------------
 * THREE UNITS STACK; TWO DID NOT HAVE TO
 *
 * Each unit is a circle with its words *beneath* it, and the row is three equal columns
 * of the content width. It was a circle with its words *beside* it inside a horizontal
 * scroller, which is the right composition for two units and impossible for three: at
 * 358pt a unit needs about 170 laid out sideways, so three of them ran off the screen and
 * the scroller — which existed to rescue the two-unit row at large text sizes — turned
 * bingd. into something the reader had to discover by swiping.
 *
 * Stacked, a unit is as wide as its column and overflows *downward*, by wrapping its own
 * sub-label, which is what a column is for. The row takes its height from the tallest and
 * never scrolls. That is why the scroller is gone rather than retained: with this
 * composition there is nothing left for it to rescue.
 *
 * **The supporting copy is a count, and it is short** (founder, physical Android,
 * 2026-09-08). Every unit's second line is now at most three words, because the first pass
 * wrote sentences — `1 person you follow`, `None of your friends have ranked this` — that
 * set on two and three lines in a third of the content width and made the whole section
 * read as noise. Both aggregates count ratings the same way; the labels above them are
 * what say *whose*.
 *
 * **Each unit still says its own empty state**, because the app being short of a sample,
 * nobody the reader follows having rated it, and the reader not having ranked it are three
 * different facts. What changed is their length, not the distinction. See `NO_FOLLOWING`,
 * `NOT_RANKED`, `NOT_ENOUGH`.
 *
 * **A ranked personal score has no second line at all.** See the `detail` prop on `Score`
 * for the list of things that have been tried there and cut.
 *
 * Neither aggregate counts down: `2 more needed` turns a reader into a spectator of a
 * figure they cannot move. The threshold that decides whether there is a number at all is
 * the server's (`score.community_min_ratings`) and this component has never known it.
 *
 * **The circle is always drawn.** A unit that grows a circle when the data arrives is a
 * unit that moves, and the empty circle is itself the honest statement that there is a
 * score-shaped hole here rather than a score. What it must never do is put a faded or
 * greyed *number* in that hole.
 *
 * ---------------------------------------------------------------------------
 * COLOUR MEANS ONE THING HERE (founder, physical QA, 2026-09-08)
 *
 * **A real score is Maroon. No score is a filled grey disc.** Nothing else is encoded in
 * the colour of a circle on this row — not how large the sample behind a number is, not
 * how recent it is, not how much the app trusts it.
 *
 * Two things changed to make that sentence true. bingd. used to go neutral below two
 * ratings, which put a real number in the same grey the empty state uses; it is outlined
 * Maroon at every count now, and the sample is stated in words underneath, where `1
 * rating` is more precise than any colour could be. And the empty circle used to hold an
 * em dash, which is a mark inside a circle — the one gesture this page reserves for
 * stating a number. It is empty.
 *
 * The three empty *sentences* still differ, because the three absences do. It is only
 * the shape that is now identical, which is the point: the reader sorts the row by
 * colour in a glance and reads the words for the rest.
 */
export function ScoresSection({
  you,
  bingd,
  following,
  onPressFollowing,
}: ScoresSectionProps) {
  if (!you && !following && !bingd) return null;

  return (
    <View testID="scores-section" style={styles.section}>
      {/* The app's section treatment — small Maroon capitals, no rule — written here
          rather than through `SectionHeader` for the reason `WhereToWatch` gives about
          its own: that component owns a 44pt row and a full-width flex layout, and this
          heading is a label above a row. Casing is a style, so `uppercase` is
          applied rather than typed: a screen reader must not spell out "S C O R E S". */}
      <Text variant="sectionHeader" tone="action" style={styles.heading}>
        SCORES
      </Text>

      <View testID="scores-layout" style={styles.layout}>
          {/* Me, then the people I chose, then the room. The order is the whole
              argument for moving the personal score in here: on the poster it was a
              number beside artwork with nothing to compare it to, and here it is the
              first term of a comparison the reader can actually read left to right. */}
          {you ? (
            <Score
              testID="scores-unit-you"
              score={you.score}
              variant="filled"
              label="Your score"
              /**
               * **Nothing under the label when there is a score**, and this null is the
               * fix for the founder's `7.0 / Your score / Not ranked yet` (2026-09-08).
               *
               * Every candidate for this line has been cut in turn: the bucket word,
               * because it restates the number in jargon this screen has never used; the
               * rank and the watch date, because those are the reader's history with the
               * title and live in the identity block; and finally the word `Ranked`
               * itself, because a filled Maroon circle with a number in it has said so.
               *
               * It used to be passed the *empty* copy, which `Score` printed whenever
               * there was a number — the two states were chosen by two expressions. They
               * are one now; see `Score`.
               */
              detail={null}
              emptyLabel={you.pending ? SCORE_LOADING : NOT_RANKED}
              onPress={you.onPress}
            />
          ) : null}
          {following ? (
            <Score
              score={following.score}
              // Outlined at any count, as bingd. now is too: there is one treatment for
              // a stated number on this row and one for the absence of one.
              variant="outlined"
              label="Following"
              // The same words bingd. uses. The label above already says whose ratings
              // these are, so counting people spent two extra lines restating it.
              detail={ratingsDetail(following.ratingCount)}
              emptyLabel={NO_FOLLOWING}
              onPress={
                following.ratingCount > 0 && onPressFollowing ? onPressFollowing : undefined
              }
            />
          ) : null}
          {bingd ? (
            <Score
              score={bingd.score}
              /**
               * **Outlined at every count, including one** (founder, 2026-09-08).
               *
               * A thin sample used to draw a neutral ring and a neutral number. The
               * founder's ruling is that a real number must never go grey merely because
               * N is low: on the device that is indistinguishable from a score that
               * failed to load, and this row now has exactly one grey shape in it, which
               * means *no score*. How deep the sample is is stated in words on the line
               * below — `1 rating`, `128 ratings` — where it is precise rather than
               * implied, and legible to somebody who cannot tell two greys apart.
               */
              variant="outlined"
              // The product's own name, written the way the wordmark writes it. It sits
              // beside "Following", so the two labels name two populations — and this one
              // is the whole of bingd. rather than a generic "community".
              label="bingd."
              detail={ratingsDetail(bingd.ratingCount)}
              emptyLabel={NOT_ENOUGH}
            />
          ) : null}
      </View>
    </View>
  );
}

/**
 * One score: the circle, then the label and, where there is one, the sample beneath it.
 *
 * ---------------------------------------------------------------------------
 * **ONE DERIVATION, SO THE NUMBER AND THE WORDS CANNOT DISAGREE** (founder, physical
 * Android, 2026-09-08).
 *
 * The device showed `7.0` above `Your score` above `Not ranked yet`, all at once, and the
 * cause was that the badge and the sub-label were chosen by two different expressions.
 * The caller passed the personal unit's *empty* copy as its `detail`, and `detail` is what
 * a unit with a number prints — so a ranked title stated its score and denied it in the
 * same breath.
 *
 * `ranked` below is computed once and decides all three things: which badge is drawn,
 * which line of copy sits under the label, and what a screen reader is told. A future
 * caller can pass whatever it likes; it can no longer make them contradict.
 */
function Score({
  score,
  label,
  detail,
  emptyLabel,
  variant,
  onPress,
  testID = 'scores-unit',
}: {
  score: number | null;
  label: string;
  /**
   * How big the sample behind the number is, drawn only when there *is* a number.
   *
   * **Null is a real answer**, and it is the personal unit's: a ranked title says `Your
   * score` and nothing else. The founder cut every candidate for that line in turn — the
   * bucket word, the rank, the watch date, and finally the word `Ranked` itself, which
   * restates the filled circle beside it.
   */
  detail: string | null;
  /**
   * What this unit says when there is no number, in its own words.
   *
   * One string per unit rather than one shared across the row: the reader not having
   * ranked it, nobody they follow having rated it, and bingd. being short of a sample are
   * three different facts.
   */
  emptyLabel: string;
  /** Filled for the reader's own; outlined for everybody else's. There is no third. */
  variant: ScoreBadgeVariant;
  /** Makes the unit a button into the list behind the number. See the section props. */
  onPress?: () => void;
  testID?: string;
}) {
  /** The one question this component asks. Everything below is an answer to it. */
  const ranked = score != null;
  /** The line under the label, or nothing at all. */
  const support = ranked ? detail : emptyLabel;

  const badge = ranked ? (
    <ScoreBadge score={score} bucket={null} size="detail" variant={variant} />
  ) : (
    /**
     * **A filled grey disc with nothing in it** (founder, 2026-09-08).
     *
     * `muted`, never the cream `empty` disc, never the dashed ring, and — as of this
     * pass — never the em dash it carried for a day. The rule the row now states is a
     * single sentence: a real score is Maroon, and no score is grey. A dash is a mark
     * inside a circle, and a mark inside a circle is how this page states a number, so
     * the dash was the last thing still blurring the two states together.
     *
     * The absence is named in the words beside it and, for a screen reader, in this
     * label — which is the only place the distinction between the three empty states
     * can be carried, since to a screen reader the shape says nothing at all.
     */
    <EmptyScoreBadge size="detail" muted label={`${label}: ${emptyLabel}`} />
  );

  const body = (
    <>
      {badge}
      <View style={styles.copy}>
        <Text variant="callout">{label}</Text>
        {support ? (
          <Text variant="footnote" tone="secondary">
            {support}
          </Text>
        ) : null}
      </View>
    </>
  );

  if (!onPress) {
    return (
      <View testID={testID} style={styles.unit}>
        {body}
      </View>
    );
  }

  /**
   * The whole unit is the target — a chevron or a link word would be a second element
   * competing with the number, and the hint carries what tapping does.
   *
   * The spoken label is assembled from the same `ranked`, and it names the **number**
   * before the sample. A `Pressable` with its own label absorbs its children's, so
   * without this a screen reader pressing a unit heard `Following. 6 ratings` and never
   * the 8.7 the row exists to state.
   */
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={[label, ranked ? `${formatScore(score)} out of 10` : null, support]
        .filter(Boolean)
        .join('. ')}
      accessibilityHint={
        testID === 'scores-unit-you'
          ? 'Opens your rating options'
          : 'Opens the people behind this score'
      }
      onPress={onPress}
      style={({ pressed }) => [styles.unit, pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  );
}

/**
 * "128 ratings". "1 rating".
 *
 * **Both aggregates say it the same way** (founder, 2026-09-08). Following used to count
 * people — `1 person you follow`, `6 people you follow` — which was more specific and
 * measurably worse: it wrapped to two and three lines in a third of the content width,
 * and every word past the number was restating the label directly above it. The unit is
 * called `Following`; the reader knows whose ratings they are.
 *
 * Only reached with a number beside it, which since 2026-09-05 means from the first
 * rating. Below the threshold the unit says {@link NOT_ENOUGH} and stops: no countdown,
 * because "2 more needed" invites the reader to watch a figure they cannot move and the
 * exact shortfall is a property of a config value rather than of the film.
 */
function ratingsDetail(ratingCount: number): string {
  return ratingCount === 1 ? '1 rating' : `${ratingCount} ratings`;
}

const styles = StyleSheet.create({
  /**
   * A section's air, and nothing else: no ground, no border, no radius.
   *
   * `space[7]` above, which is the page's section interval — genres are a footnote to
   * the synopsis and this is a different question being asked. `space[4]` between the
   * heading and the row, which is the founder's 14–16: a heading owns its content, and
   * at the old 12 the capitals sat on top of the circles.
   */
  section: { paddingTop: theme.space[7], gap: theme.space[4] },
  heading: { paddingHorizontal: theme.layout.gutter },
  /**
   * Three equal columns of the content width.
   *
   * `flex-start`, not `center`: the circles must sit on one line whatever their labels
   * do underneath, and a unit whose sub-label wraps to three lines would otherwise drag
   * its circle down out of alignment with the other two.
   */
  layout: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: theme.layout.gutter,
    gap: theme.space[2],
  },
  /**
   * One unit: circle, then its words beneath, left-aligned under the circle's left edge.
   *
   * `flex: 1` with `minWidth: 0` so the three share the row evenly and a long sub-label
   * wraps inside its own column instead of pushing the column wider — which, in a plain
   * row, is how one unit steals width from the two beside it.
   */
  unit: { flex: 1, minWidth: 0, alignItems: 'flex-start' },
  /**
   * `space[2]+2` under the circle. Below 8 the number and the word fuse into one object;
   * past 12 the unit stops reading as one at all.
   */
  copy: { marginTop: theme.space[2] + 2, gap: 2 },
  pressed: { opacity: 0.7 },
});
