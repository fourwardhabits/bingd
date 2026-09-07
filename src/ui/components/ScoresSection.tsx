import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { EmptyScoreBadge, ScoreBadge } from './ScoreBadge';
import { Text } from './Text';

export type ScoresSectionProps = {
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

/** Said the same way in both units, and it is the whole of the empty state. */
const NOT_ENOUGH = 'Not enough ratings';

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
 * **The reader's own score is not in here**, and that is the founder's correction of
 * 2026-08-18, kept through every rearrangement since. It is on the poster, with `YOU` on
 * it (`PersonalScore`). Repeating it here would put the same number on the page twice
 * and the second copy would be the weaker one. This section answers "what did everyone
 * else make of it", which is a different question and does not need the reader's own
 * answer restated to be asked.
 *
 * **Both units activate on a single rating**, and both say the same four words when they
 * cannot. The threshold is the server's (`score.community_min_ratings`, now 1) and this
 * component has never known the number. Neither unit counts down: `2 more needed` turns a
 * reader into a spectator of a figure they cannot move.
 *
 * **The circle is always drawn.** A unit that grows a circle when the data arrives is a
 * unit that moves, and the empty circle is itself the honest statement that there is a
 * score-shaped hole here rather than a score. What it must never do is put a faded or
 * greyed *number* in that hole.
 */
export function ScoresSection({ bingd, following, onPressFollowing }: ScoresSectionProps) {
  if (!following && !bingd) return null;

  return (
    <View testID="scores-section" style={styles.section}>
      {/* The app's section treatment — small Maroon capitals, no rule — written here
          rather than through `SectionHeader` for the reason `WhereToWatch` gives about
          its own: that component owns a 44pt row and a full-width flex layout, and this
          heading is a label above a scroller. Casing is a style, so `uppercase` is
          applied rather than typed: a screen reader must not spell out "S C O R E S". */}
      <Text variant="sectionHeader" tone="action" style={styles.heading}>
        SCORES
      </Text>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        alwaysBounceHorizontal={false}
        style={styles.scroll}
      >
        {/* The row itself, rather than the scroller's content container: a container
            style cannot carry a testID, and what a layout test needs to read is the row
            the units are actually in. */}
        <View testID="scores-layout" style={styles.layout}>
          {following ? (
            <Score
              score={following.score}
              label="Following"
              detail={followingDetail(following.ratingCount)}
              onPress={
                following.ratingCount > 0 && onPressFollowing ? onPressFollowing : undefined
              }
            />
          ) : null}
          {bingd ? (
            <Score
              score={bingd.score}
              // The product's own name, written the way the wordmark writes it. It sits
              // beside "Following", so the two labels name two populations — and this one
              // is the whole of bingd. rather than a generic "community".
              label="bingd."
              detail={ratingsDetail(bingd.ratingCount)}
            />
          ) : null}
        </View>
      </ScrollView>
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
  onPress,
}: {
  score: number | null;
  label: string;
  /** How big the sample behind the number is. Only ever drawn when there is a number. */
  detail: string;
  /** Makes the unit a button into the list behind the number. See the section props. */
  onPress?: () => void;
}) {
  const badge =
    score != null ? (
      <ScoreBadge score={score} bucket={null} size="md" />
    ) : (
      <EmptyScoreBadge size="md" label={`${label}: ${NOT_ENOUGH}`} />
    );

  const body = (
    <>
      {badge}
      <View style={styles.copy}>
        <Text variant="callout">{label}</Text>
        <Text variant="footnote" tone="secondary">
          {score == null ? NOT_ENOUGH : detail}
        </Text>
      </View>
    </>
  );

  if (!onPress) {
    return (
      <View testID="scores-unit" style={styles.unit}>
        {body}
      </View>
    );
  }

  // The whole unit is the target — a chevron or a link word would be a second
  // element competing with the number, and the hint carries what tapping does.
  return (
    <Pressable
      testID="scores-unit"
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${score == null ? NOT_ENOUGH : detail}`}
      accessibilityHint="Opens the people behind this score"
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
  /** A section's air, and nothing else: no ground, no border, no radius. */
  section: { paddingTop: theme.space[6], gap: theme.space[3] },
  heading: { paddingHorizontal: theme.layout.gutter },
  // `flexGrow: 0` so the scroller takes its height from the units rather than expanding
  // into whatever the page offers it — the same note `SegmentedTabs` carries.
  scroll: { flexGrow: 0 },
  layout: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.layout.gutter,
    // Generous, because the gap is the only thing separating two units now that neither
    // has a box: at a smaller distance the pair reads as one four-part row.
    gap: theme.space[6],
  },
  unit: { flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  copy: { gap: 2 },
  pressed: { opacity: 0.7 },
});
