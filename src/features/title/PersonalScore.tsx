import { Pressable, StyleSheet, View } from 'react-native';

import type { Bucket } from '@/features/collection/score';
import { BUCKET_LABEL, formatScore } from '@/features/collection/score';
import { EmptyScoreBadge, ScoreBadge, Text } from '@/ui/components';

export type PersonalScoreProps = {
  /** Null when this reader has not ranked it. Never a stand-in number. */
  score: number | null;
  bucket?: Bucket | null;
  /**
   * Ranked, but the number is not knowable yet.
   *
   * A score is derived from the size of the band it sits in (`score.ts`), so the ranking
   * row can be in hand a moment before the band sizes are — and in that moment the two
   * honest states say different things. The dashed ring reads "not ranked", which
   * contradicts the Ranked control on the page; the neutral empty circle reads "there is a
   * score here and it has not arrived", which is what is true.
   */
  pending?: boolean;
  /** Leads where the Ranked control leads: the menu, or the log. */
  onPress: () => void;
};

/**
 * **My** score for this title, on the corner of its poster, with the word for whose it is.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT SITS, AND THE TWO PLACES IT DID NOT WORK
 *
 * The number sat in a detached column opposite the poster until 2026-09-07, and the
 * founder's reading on a device was that `10.0` up there is not self-evidently *mine* —
 * a bare number beside a film's artwork is exactly where every other product puts a
 * critics' aggregate. It then sat *under* the poster for one revision, which produced a
 * tall empty column on the right of the page and a score that read as a separate block.
 *
 * It is anchored to the poster's lower-left corner now — the screen positions it, this
 * component only draws it — with twelve points of the circle overhanging onto Paper. That
 * is what attaches it to the artwork, the one thing on the page that can only be about
 * this title, without costing the column below the poster a single point of height. The
 * overhang onto Paper is what keeps the number legible whatever the artwork behind the
 * rest of it is, and it stays inside the gap between the poster and the identity column,
 * so it can neither cover the last words of a long title nor take a press meant for them.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WORDS ARE UNDERNEATH, AND WHY THERE IS NO WORD IN THE RING
 *
 * `Your score`, in `caption`, immediately beneath the circle. Ownership is stated rather
 * than symbolised — the floating `YOU` pill of the first redesign read as a sticker — and
 * the number is the dominant element by an order of magnitude of weight. Beneath rather
 * than above, because above the circle is the poster's artwork, and text over artwork is
 * the thing the whole identity block was moved off the hero to avoid.
 *
 * The unranked state is the dashed ring **with nothing in it**. It carried the word
 * "Rank" — the `ScoreBadge` unranked treatment — which, beside a button that says Rank,
 * was the same invitation twice. The honest statement of "no score yet" is the empty ring;
 * the button beside it is the invitation.
 *
 * ---------------------------------------------------------------------------
 * WHAT DID NOT CHANGE
 *
 * The number, the scale and where it comes from. It is still the derived 0–10 from the
 * title's position in its band (`score.ts`), still one decimal, still not a star rating
 * and still nothing this component computes or stores. It is a control in both states,
 * and leads where the Ranked control leads: the score is the most useful state indicator
 * this app has, so it is also a place to press to change it (`ScoreBadge`, 2026-09-06).
 */
export function PersonalScore({ score, bucket, pending, onPress }: PersonalScoreProps) {
  const ranked = score != null;

  return (
    <Pressable
      testID="personal-score"
      accessibilityRole="button"
      accessibilityState={{ selected: ranked }}
      /**
       * The whole sentence, because to a screen reader the badge is a circle. "Your score"
       * first: whose it is, is the fact this block exists to carry, so it is the fact the
       * spoken label leads with — exactly as the visible one does.
       */
      accessibilityLabel={
        ranked
          ? `Your score: ${formatScore(score)} out of 10${bucket ? `, ${BUCKET_LABEL[bucket]}` : ''}`
          : pending
            ? 'Your score is loading'
            : 'You have not ranked this yet'
      }
      accessibilityHint={
        ranked || pending ? 'Opens your rating options' : 'Opens the rating sheet'
      }
      onPress={onPress}
      // No slop. The circle is 56pt and the caption beneath it makes the control taller
      // still, so the 44pt target is met without it — and slop here would reach past the
      // gap into the identity column, which is the overlap review 75 found.
      style={({ pressed }) => [styles.column, pressed && styles.pressed]}
    >
      {/* Named once, in the label above, rather than three times over: the badge sets its
          own spoken label and a reader who lands here should hear one thing. */}
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {ranked ? (
          <ScoreBadge score={score} bucket={bucket} size="lg" />
        ) : (
          <EmptyScoreBadge
            size="lg"
            dashed={!pending}
            label={pending ? 'Your score is loading' : 'No score yet'}
          />
        )}
      </View>
      <Text variant="caption" tone="tertiary">
        Your score
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Left-aligned with the circle, which is the edge that overhangs onto Paper: the words
  // sit on the page, never on the artwork the circle's other side is over.
  column: { alignItems: 'flex-start', gap: 2 },
  pressed: { opacity: 0.7 },
});
