import { PixelRatio, Pressable, StyleSheet, View } from 'react-native';

import { BUCKET_LABEL, formatScore, type Bucket } from '@/features/collection/score';

import { theme } from '../tokens';
import { Text } from './Text';

export type ScoreBadgeSize = 'md' | 'sm' | 'lg';

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
  /** Makes the unranked state a button into the ranking sheet. */
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
export function ScoreBadge({ score, bucket, size = 'md', onPress }: ScoreBadgeProps) {
  const { diameter, fontSize } = metrics(size);

  if (score == null) {
    return <UnrankedBadge diameter={diameter} onPress={onPress} />;
  }

  const value = formatScore(score);

  return (
    <View
      accessible
      accessibilityRole="text"
      // "8.7" alone is a bare number in a list of film titles. The unit is what
      // makes it mean anything read aloud.
      accessibilityLabel={
        bucket ? `${value} out of 10, ${BUCKET_LABEL[bucket]}` : `${value} out of 10`
      }
      style={[styles.circle, styles.filled, { width: diameter, height: diameter }]}
    >
      <Text
        variant="score"
        numberOfLines={1}
        style={[styles.ink, { fontSize, lineHeight: Math.round(fontSize * 1.15) }]}
        // The circle already grew with the font scale, so the number must not
        // grow again on top of it or the ratio the sizing depends on is lost.
        allowFontScaling={false}
      >
        {value}
      </Text>
    </View>
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
}: {
  size?: ScoreBadgeSize;
  label?: string;
}) {
  const { diameter } = metrics(size);

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[styles.circle, styles.empty, { width: diameter, height: diameter }]}
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
  pressed: { opacity: 0.7 },
});
