import { Pressable, StyleSheet, View } from 'react-native';

import type { Bucket } from '@/features/collection/score';
import { BUCKET_LABEL, formatScore } from '@/features/collection/score';
import { EmptyScoreBadge, ScoreBadge, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

export type PersonalScoreProps = {
  /** Null when this reader has not ranked it. Never a stand-in number. */
  score: number | null;
  bucket?: Bucket | null;
  /**
   * Ranked, but the number is not knowable yet.
   *
   * A score is derived from the size of the band it sits in (`score.ts`), so the ranking
   * row can be in hand a moment before the band sizes are — and in that moment the two
   * honest states say different things. The dashed ring reads "not ranked, rank it",
   * which contradicts the Ranked control below it; the neutral empty circle reads "there
   * is a score here and it has not arrived", which is what is true.
   */
  pending?: boolean;
  /** Leads where the Ranked control leads: the menu, or the log. */
  onPress: () => void;
};

/**
 * **My** score for this title, under its poster, with the word for whose it is.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS HAS BEEN, AND WHY IT IS NOW WORDS
 *
 * The number sat in a detached column opposite the poster until 2026-09-07, and the
 * founder's reading on a device was that `10.0` up there is not self-evidently *mine* —
 * a bare number beside a film's artwork is exactly where every other product puts a
 * critics' aggregate, so the app's one genuinely distinctive fact was wearing the costume
 * of the least distinctive one.
 *
 * The first answer was a `YOU` pill on the circle's lower edge. The founder rejected it
 * on review: a floating bubble on a badge is a sticker, and it reads as a notification
 * rather than as a label. The answer that stands is the plain one — **the words "Your
 * score", set quietly above the number.** Ownership is stated rather than symbolised,
 * nothing floats, and the number is still the dominant element in the block by an order
 * of magnitude of weight.
 *
 * It sits under the poster because the poster is the only thing on the page that can only
 * be about this title, and a score with no owner named beside artwork is precisely the
 * ambiguity the wording removes.
 *
 * ---------------------------------------------------------------------------
 * WHAT DID NOT CHANGE
 *
 * The number, the scale and where it comes from. It is still the derived 0–10 from the
 * title's position in its band (`score.ts`), still one decimal, still not a star rating
 * and still nothing this component computes or stores. The unranked state is still the
 * app's honest dashed ring — never a greyed `0.0`, never a faded number, because no score
 * has been earned and none of those say so (PRD §26.4).
 *
 * It is a control in both states, and leads where the Ranked control leads: the score is
 * the most useful state indicator this app has, so it is also a place to press to change
 * it. That rule is `ScoreBadge`'s own since 2026-09-06 and is kept.
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
      hitSlop={theme.space[2]}
      style={({ pressed }) => [styles.column, pressed && styles.pressed]}
    >
      {/* Quiet, small and above the number, which is the arrangement that reads as a
          label rather than as a caption competing with it. Never over artwork: this is
          the reason the whole identity row now starts below the hero. */}
      <Text variant="caption" tone="tertiary">
        Your score
      </Text>
      {/* Named once, in the label above, rather than three times over: the badge sets its
          own spoken label and a reader who lands here should hear one thing. */}
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {pending && !ranked ? (
          <EmptyScoreBadge size="lg" label="Your score is loading" />
        ) : (
          <ScoreBadge score={score} bucket={bucket} size="lg" />
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Centred under the poster, and gapped just enough that the words belong to the number
  // rather than sitting on it.
  column: { alignItems: 'center', gap: theme.space[1], paddingTop: theme.space[3] },
  pressed: { opacity: 0.7 },
});
