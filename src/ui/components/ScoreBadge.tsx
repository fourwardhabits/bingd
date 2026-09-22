import { PixelRatio, Pressable, StyleSheet, View } from 'react-native';

import { BUCKET_LABEL, formatScore, type Bucket } from '@/features/collection/score';

import { theme } from '../tokens';
import { Text } from './Text';

export type ScoreBadgeSize = 'md' | 'sm' | 'lg' | 'detail';

/**
 * How much authority the circle claims (title detail, founder lock, 2026-09-07).
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS MORE THAN ONE, AND WHAT IT OVERRIDES
 *
 * The written rule was one deep Maroon fill everywhere a derived 0–10 score is stated
 * (`semantic.score`), and for a badge that appears *alone* — a feed row, a search row, a
 * collection wall — it is still exactly right and still the default.
 *
 * The title page's Scores row is the case that rule was not written for. It states three
 * scores side by side and they are three different claims: the reader's own, the mean
 * over the accounts they chose to follow, and bingd.'s. Three identical filled Maroon
 * circles say those three claims are interchangeable, which is the opposite of what the
 * section exists to say. The founder's direction is that the hierarchy is carried by the
 * treatment: **me filled, everyone else outlined.**
 *
 *   `filled`   the reader's own score. Parchment on Maroon, 7.4:1, unchanged, and still
 *              what every badge outside this one row draws.
 *   `outlined` somebody else's score. Maroon ring, Maroon number, no fill.
 *
 * ---------------------------------------------------------------------------
 * THERE WAS A THIRD, AND SAMPLE SIZE IS WHY IT IS GONE (founder, 2026-09-08)
 *
 * `quiet` drew a neutral ring and a neutral number for an aggregate with almost nothing
 * behind it — one rating, say — on the reading that one person's opinion should not look
 * statistically authoritative. On a device that reads as a *broken or stale* score
 * rather than a thin one, because grey on this page already means something else.
 *
 * The founder's rule is now one sentence with no exceptions in it: **a real score is
 * Maroon and no score is grey**. How deep the sample is is stated in words directly
 * under the number — `1 rating`, `128 ratings` — which is both more precise than a
 * colour and readable by somebody who cannot tell two greys apart. Whether there is a
 * number at all is still the server's decision (`score.community_min_ratings`), and
 * below it the unit draws {@link EmptyScoreBadge}'s grey disc and says so.
 *
 * The variant is deleted rather than left unused, so a later caller cannot reintroduce
 * confidence-by-colour by passing a string.
 */
export type ScoreBadgeVariant = 'filled' | 'outlined';

export type ScoreBadgeProps = {
  /** Omit for a title that is logged but not yet compared. */
  score?: number | null;
  /**
   * Carried for the spoken label only. It no longer decides the colour — see the
   * note below — but "8.7, I liked it" is still the useful thing to hear, and the
   * bands are closed so the caller usually has it anyway.
   */
  bucket?: Bucket | null;
  size?: ScoreBadgeSize;
  /**
   * Filled unless a caller says otherwise, so every badge outside the title page's
   * Scores row is untouched by the hierarchy this prop exists to express.
   */
  variant?: ScoreBadgeVariant;
  /**
   * Makes the badge a button into the canonical log-and-rank sheet — **in both states**
   * since 2026-09-06.
   *
   * It used to apply to the unranked ring alone, which made the more useful half of the
   * control dead: on a search row a reader who has already ranked something is shown
   * their own 9.0 and, until this, could do nothing with it. The founder's rule is that
   * the score is bingd.'s most useful state indicator, so it is also the place to press
   * to change it.
   *
   * Absent on every collection wall and every feed row, which is where the badge is
   * reporting rather than offering — so those are untouched.
   */
  onPress?: () => void;
};

/**
 * The derived 0–10 score, as a filled Maroon circle.
 *
 * **One colour, not three.** The badge used to take its fill from the bucket, which
 * put Maroon, Sage and Stone in the same column of a list. Founder decision,
 * 2026-08-16, after seeing it on a device: the number already says how good the
 * rating is, so tinting by band spends the app's scarcest visual resource restating
 * it — and it restated it weakly, because Sage against Paper reads as washed out
 * beside the Maroon above it. A single deep Maroon badge is a brand mark that
 * repeats down a list, which is what a Collection screen wants.
 *
 * The three-band palette is not gone; it lives on `BucketChip`, where colour is
 * distinguishing three choices rather than grading one answer. And nothing is lost
 * to accessibility by dropping the tint, because the tint was never the only
 * carrier: the bands are closed and non-overlapping, so the number itself says
 * which one it is (`score.ts`, `BAND_RANGE`).
 *
 * Filled rather than outlined, which is where this departs from Beli. On a light
 * ground Maroon as a hairline stroke measures under 3:1; filling inverts it, and
 * Parchment on Maroon is 7.4:1.
 */
export function ScoreBadge({
  score,
  bucket,
  size = 'md',
  variant = 'filled',
  onPress,
}: ScoreBadgeProps) {
  const { diameter, fontSize } = metrics(size);

  if (score == null) {
    return <UnrankedBadge diameter={diameter} onPress={onPress} />;
  }

  const value = formatScore(score);
  // "8.7" alone is a bare number in a list of film titles. The unit is what makes it
  // mean anything read aloud.
  const spoken = bucket ? `${value} out of 10, ${BUCKET_LABEL[bucket]}` : `${value} out of 10`;

  /**
   * The circle carries the accessible name itself rather than being wrapped in a node
   * that does, and that is not incidental: a wrapper puts a view with no style between
   * the label and the fill, so anything reading the treatment off the labelled node —
   * `ScoreBadge.test.tsx` does exactly that — finds nothing. Pressability is added
   * *around* it below, where the role genuinely changes.
   */
  const circle = (
    <View
      accessible
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={spoken}
      // The score says what it is; the hint says what pressing it does. Without this a
      // screen reader announces a number that happens to be a button.
      accessibilityHint={onPress ? 'Opens your log, where you can rank it again' : undefined}
      style={[styles.circle, VARIANT_RING[variant], { width: diameter, height: diameter }]}
    >
      <Text
        variant="score"
        numberOfLines={1}
        style={[
          VARIANT_INK[variant],
          { fontSize, lineHeight: Math.round(fontSize * 1.15) },
        ]}
        // The circle already grew with the font scale, so the number must not
        // grow again on top of it or the ratio the sizing depends on is lost.
        allowFontScaling={false}
      >
        {value}
      </Text>
    </View>
  );

  if (!onPress) return circle;

  return (
    <Pressable
      onPress={onPress}
      hitSlop={theme.space[2]}
      style={({ pressed }) => pressed && styles.pressed}
    >
      {circle}
    </Pressable>
  );
}

/**
 * A title that has been logged but not compared.
 *
 * Deliberately not `0.0`, `#—`, or a dimmed number: no score has been earned
 * yet, and none of those say that (PRD §26.4). A dashed ring reads as an empty
 * slot, and the word makes it an invitation.
 */
function UnrankedBadge({ diameter, onPress }: { diameter: number; onPress?: () => void }) {
  const content = (
    <View style={[styles.circle, styles.unranked, { width: diameter, height: diameter }]}>
      <Text variant="caption" tone="tertiary" allowFontScaling={false}>
        Rank
      </Text>
    </View>
  );

  if (!onPress) return content;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Not ranked. Rank this title."
      hitSlop={theme.space[2]}
      style={({ pressed }) => pressed && styles.pressed}
    >
      {content}
    </Pressable>
  );
}

/**
 * The same circle with nothing in it yet.
 *
 * Used wherever a score has a place on the page but no value to put in it: a title
 * nobody has ranked, a Following mean with no followee who has seen it, a Bingd mean
 * still short of its sample. The founder’s instruction is that the circle stays in all
 * three cases, and the reason is layout as much as tone — a row that grows a circle
 * when the data arrives is a row that moves under the reader’s eye.
 *
 * Neutral rather than Maroon, and empty rather than a dash or a zero. A dash reads as a
 * verdict of nothing and a zero reads as a verdict of nought; an empty slot reads as an
 * empty slot. Screen readers get the sentence, because to them the shape says nothing at
 * all.
 */
export function EmptyScoreBadge({
  size = 'md',
  label = 'No score yet',
  dashed = false,
  muted = false,
}: {
  size?: ScoreBadgeSize;
  label?: string;
  /**
   * A dashed ring with nothing in it.
   *
   * **No longer used by the title page**, and deliberately not deleted: it is still the
   * right treatment for a slot a reader is expected to fill, wherever one appears. What
   * the founder ruled out on 2026-09-07 is a *floating* dashed circle on the title page
   * — a dashed ring beside a poster reads as a control somebody forgot to draw, and the
   * page's honest empty states now say so in words instead. See `dash`.
   */
  dashed?: boolean;
  /**
   * **A filled, muted grey disc with nothing inside it** — the Scores row's no-score
   * state (founder, physical QA, 2026-09-08).
   *
   * The founder's rule for that row is one sentence a reader should be able to state
   * after two seconds: *a real score is Maroon, no score is grey*. Anything drawn inside
   * the circle competes with that, because a mark inside a circle is exactly how this
   * page states a number — so there is **no dash, no line, no icon and no zero** here.
   *
   * It carried an em dash until now, on the argument that a blank circle is
   * indistinguishable from one whose contents failed to load. That argument is answered
   * by the fill rather than by a glyph: `empty` is a cream disc that reads as unpainted
   * content, and this is a *solid grey* one, which reads as a slot that is deliberately
   * empty. The words beside it — `Not ranked yet`, `No ratings yet`, `Not enough
   * ratings` — say which absence it is, and `label` says it to a screen reader, to which
   * the shape says nothing at all.
   */
  muted?: boolean;
}) {
  const { diameter } = metrics(size);

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[
        styles.circle,
        dashed ? styles.unranked : muted ? styles.muted : styles.empty,
        { width: diameter, height: diameter },
      ]}
    />
  );
}

/**
 * How wide `10.0` is, as a multiple of the font size, in Inter SemiBold with
 * tabular figures: three digit advances of 0.60em and a period of 0.28em.
 *
 * The badge is sized for that string and only that string. Sizing for the common
 * `8.7` is what produced the defect the founder found — a perfect score, the one
 * number a user most wants to show someone, spilling out of its own circle in the
 * feed. And the font does not shrink for the shorter strings either: `score` is set
 * in tabular figures precisely so a column of badges holds still, and a `10.0` in
 * smaller type than the `8.7` above it would undo that at the one place it matters.
 */
const WIDEST_SCORE_EMS = 3 * 0.6 + 0.28;

/**
 * The fraction of the diameter a horizontal string may occupy inside a circle.
 *
 * Not the inscribed square's 0.707 — that is the bound for a shape as tall as it is
 * wide, and a line of text is roughly a third of its own width. 0.80 leaves visible
 * Maroon either side of `10.0` at every size, which is what "fits cleanly" means
 * here: not merely uncropped, but framed.
 */
const TEXT_SHARE = 0.8;

/** Beyond this, the badge would start pushing rows around rather than reading better. */
const MAX_FONT_SCALE = 1.3;

const BASE: Record<ScoreBadgeSize, number> = theme.layout.scoreBadge;

/**
 * Diameter and font size together, both scaled by the user's text size.
 *
 * Scaling the circle rather than freezing the number is the difference between a
 * badge that ignores Dynamic Type and one that honours it: the ratio between them
 * is what guarantees the fit, so either both move or neither does.
 */
function metrics(size: ScoreBadgeSize) {
  const scale = Math.min(PixelRatio.getFontScale(), MAX_FONT_SCALE);
  const diameter = Math.round(BASE[size] * scale);
  return {
    diameter,
    fontSize: Math.floor((diameter * TEXT_SHARE) / WIDEST_SCORE_EMS),
  };
}

/** Exported for the test that asserts every score from 0.0 to 10.0 fits. */
export const scoreBadgeMetrics = metrics;

const styles = StyleSheet.create({
  circle: {
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filled: { backgroundColor: theme.semantic.score },
  ink: { color: theme.semantic.scoreInk },
  unranked: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.border.strong,
  },
  // Solid where `unranked` is dashed: a dashed ring is an invitation to rank, and this
  // one is not always about the reader — it also stands in for other people’s numbers.
  empty: {
    backgroundColor: theme.surface.sunken,
    borderWidth: 2,
    borderColor: theme.border.strong,
  },
  /**
   * Somebody else's score, stated plainly: a Maroon ring with no fill.
   *
   * Two points rather than one, for the reason every rule in this app is drawn doubled —
   * a single point rounds away to nothing on some Android densities, and a ring that
   * disappears on one device is a circle that has become a bare number on it.
   *
   * The ring is `semantic.score` at full strength. A tinted ring measured under 3:1 and
   * read as disabled; the *number inside* is what carries contrast here (Maroon on
   * Paper, 7.6:1), so the ring can be honest about which colour it is.
   */
  outlined: { borderWidth: 2, borderColor: theme.semantic.score },
  outlinedInk: { color: theme.semantic.score },
  /**
   * No score at all: a filled muted grey disc, no ring and nothing inside.
   *
   * Filled rather than ringed on purpose. A ring around emptiness is still a ring, and
   * on this row the ring is what says *there is a number here* — Maroon for a stated one,
   * and until 2026-09-08 neutral for a thin one. With `quiet` gone from the Scores row
   * the ring means one thing again, and the absence of a score is a solid shape rather
   * than an outline of one.
   */
  muted: { backgroundColor: theme.semantic.scoreEmpty },
  pressed: { opacity: 0.7 },
});

/**
 * The ring and fill for each variant, and the ink that goes in it.
 *
 * Two lookups rather than one style each, because the pair must be chosen together: an
 * outlined ring with Parchment ink is Parchment on Paper, which is invisible. Keeping
 * them adjacent is what makes that mistake visible to the next reader of this file.
 */
const VARIANT_RING: Record<ScoreBadgeVariant, object> = {
  filled: styles.filled,
  outlined: styles.outlined,
};

const VARIANT_INK: Record<ScoreBadgeVariant, object> = {
  filled: styles.ink,
  outlined: styles.outlinedInk,
};
