import { Pressable, StyleSheet, View } from 'react-native';

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

/** bingd.'s empty state: the app has nothing to report yet. */
const NOT_ENOUGH = 'Not enough ratings';

/**
 * Following's empty state, in the founder's own words (2026-09-07).
 *
 * It said `Not enough ratings`, the same four words bingd. says, and that was wrong in a
 * way a shared string hides: the app being short of a sample and *nobody the reader
 * chose having seen this* are different facts, and only the second one is actionable.
 * The reader can go and follow somebody.
 */
const NO_FOLLOWING = 'None of your friends have ranked this';

/** The reader's own empty state. A statement about them, so it is in the second person. */
const NOT_RANKED = 'Not ranked yet';

/** Said while the ranking row is in hand and the derived number is not. */
const SCORE_LOADING = 'Score loading';

/**
 * Below this, a mean is drawn `quiet` rather than `outlined`.
 *
 * **Two, and it is the founder's sentence rather than a statistical choice**: "do not
 * make one person's score look statistically authoritative". One rating is one person,
 * and one person's opinion rendered in the same Maroon ring as twelve hundred is the
 * page telling a lie about its own confidence. At two the ring goes on.
 *
 * It governs **bingd. only**. Following is not the same claim: `1 person you follow`
 * already names the sample as a single named human the reader chose to follow, which is
 * the most useful signal on this page and is not pretending to be a statistic.
 *
 * Purely a *visual* threshold. Whether there is a number at all is the server's
 * decision (`score.community_min_ratings`) and this component still does not know it.
 */
const AUTHORITATIVE_MIN_RATINGS = 2;

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
 * sub-label, which is what a column is for. The row takes its height from the tallest,
 * so `None of your friends have ranked this` setting on three lines makes the row taller
 * and never makes it scroll. That is why the scroller is gone rather than retained: with
 * this composition there is nothing left for it to rescue.
 *
 * **Each unit says its own empty state in its own words.** They shared four — `Not enough
 * ratings` — and that hid a real distinction: the app being short of a sample, nobody the
 * reader follows having seen it, and the reader not having ranked it are three different
 * facts and only one of them is about the app. See `NO_FOLLOWING`, `NOT_RANKED`.
 *
 * Neither aggregate counts down: `2 more needed` turns a reader into a spectator of a
 * figure they cannot move. The threshold that decides whether there is a number at all is
 * the server's (`score.community_min_ratings`) and this component has never known it.
 *
 * **The circle is always drawn.** A unit that grows a circle when the data arrives is a
 * unit that moves, and the empty circle is itself the honest statement that there is a
 * score-shaped hole here rather than a score. What it must never do is put a faded or
 * greyed *number* in that hole.
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
              // No bucket word. `Loved` under a 9.4 was in the design draft and the
              // founder cut it: it restates the number in the app's own jargon on a
              // screen that has never used that vocabulary. And no rank and no watch
              // date — those stayed in the identity block, where they describe the
              // reader's history with the title rather than qualify an aggregate.
              detail={you.pending ? SCORE_LOADING : NOT_RANKED}
              emptyLabel={you.pending ? SCORE_LOADING : NOT_RANKED}
              onPress={you.onPress}
            />
          ) : null}
          {following ? (
            <Score
              score={following.score}
              // Outlined even at one rating: `1 person you follow` is a named human the
              // reader chose, not a thin statistic. See `AUTHORITATIVE_MIN_RATINGS`.
              variant="outlined"
              label="Following"
              detail={followingDetail(following.ratingCount)}
              emptyLabel={NO_FOLLOWING}
              onPress={
                following.ratingCount > 0 && onPressFollowing ? onPressFollowing : undefined
              }
            />
          ) : null}
          {bingd ? (
            <Score
              score={bingd.score}
              variant={
                bingd.ratingCount >= AUTHORITATIVE_MIN_RATINGS ? 'outlined' : 'quiet'
              }
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
 * One score: the circle, then the label and the sample beside it.
 *
 * Sized to its own content. Inside a horizontal scroller there is no half-width to set
 * in, so the copy rules that used to differ between two layouts are now one rule — which
 * is what removed `numberOfLines` from the line below. `Not enough ratings` sets on one
 * line at every text size because it is given the width it needs.
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
  /** How big the sample behind the number is. Only ever drawn when there is a number. */
  detail: string;
  /**
   * What this unit says when there is no number, in its own words.
   *
   * One string per unit rather than one shared across the row: "nobody you follow has
   * seen this" and "bingd. has too few ratings" and "you have not ranked this" are three
   * different facts, and the row said the same four words for all of them.
   */
  emptyLabel: string;
  /** Filled for the reader's own; outlined or quiet for everybody else's. */
  variant: ScoreBadgeVariant;
  /** Makes the unit a button into the list behind the number. See the section props. */
  onPress?: () => void;
  testID?: string;
}) {
  const badge =
    score != null ? (
      <ScoreBadge score={score} bucket={null} size="detail" variant={variant} />
    ) : (
      // `dash`, never the cream `empty` disc and never the dashed ring: an em dash in a
      // plain neutral ring is a *stated* absence, where a blank circle is
      // indistinguishable from one whose contents failed to arrive.
      <EmptyScoreBadge size="detail" dash label={`${label}: ${emptyLabel}`} />
    );

  const body = (
    <>
      {badge}
      <View style={styles.copy}>
        <Text variant="callout">{label}</Text>
        <Text variant="footnote" tone="secondary">
          {score == null ? emptyLabel : detail}
        </Text>
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

  // The whole unit is the target — a chevron or a link word would be a second
  // element competing with the number, and the hint carries what tapping does.
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${score == null ? emptyLabel : detail}`}
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

/** How many of the reader's own people are behind the number. */
function followingDetail(ratingCount: number): string {
  return ratingCount === 1 ? '1 person you follow' : `${ratingCount} people you follow`;
}

/**
 * "128 ratings".
 *
 * Only reached with a number beside it, which since 2026-09-05 means from the first
 * rating. Below the threshold the unit says {@link NOT_ENOUGH} and stops: no
 * countdown, because "2 more needed" invites the reader to watch a figure they cannot
 * move and the exact shortfall is a property of a config value rather than of the film.
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
