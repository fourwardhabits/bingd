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
   * which contradicts the *Adjust* control beside it; the neutral empty circle reads
   * "there is a score here and it has not arrived", which is what is true.
   */
  pending?: boolean;
  /** Leads into the rank intent — the same door the first action opens. */
  onPress: () => void;
};

/**
 * **My** score for this title, over the corner of its poster.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES, AND THE FOUNDER'S OBJECTION TO IT
 *
 * The number used to sit in a detached column on the right of the hero, opposite the
 * poster, with `#1 in TV` under it and a `✓ Ranked` button under that. The founder's
 * reading on a device: *`10.0` up there is not self-evidently mine.* And it is not —
 * a bare number beside a film's artwork is exactly where every other product puts a
 * critics' aggregate, so the app's one genuinely distinctive fact was wearing the
 * costume of the least distinctive one.
 *
 * So the number moves onto the poster, which is the one place on the page that can only
 * be about this title, and it carries the word **YOU**. The word is the whole point of
 * the change and is not decoration: it is what stops `10.0` reading as a rating somebody
 * else gave. bingd.'s distinctive element is the reader's ranked relationship to a
 * title, and this is where the page says so.
 *
 * ---------------------------------------------------------------------------
 * WHAT DID NOT CHANGE
 *
 * The number, the scale and where it comes from. It is still the derived 0–10 from the
 * title's position in its band (`score.ts`), still one decimal, still not a star rating
 * and still nothing this component computes or stores. The unranked state is still the
 * app's honest dashed ring — never a greyed `0.0`, never a faded number, because no
 * score has been earned and none of those say so (PRD §26.4).
 *
 * It is a control in both states, and leads where the first action leads: the score is
 * the most useful state indicator this app has, so it is also the place to press to
 * change it. That rule is `ScoreBadge`'s own since 2026-09-06 and is kept.
 */
export function PersonalScore({ score, bucket, pending, onPress }: PersonalScoreProps) {
  const ranked = score != null;

  return (
    <Pressable
      testID="personal-score"
      accessibilityRole="button"
      accessibilityState={{ selected: ranked }}
      /**
       * The whole sentence, because to a screen reader the badge is a circle and the
       * pill is three letters. "Your score" first: whose it is, is the fact the visual
       * treatment exists to carry, so it is the fact the spoken one leads with.
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
      {/* Named once, above, rather than three times over — the badge sets its own
          spoken label and the pill is a word, and a reader who lands here should hear
          one thing. */}
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {pending && !ranked ? (
          <EmptyScoreBadge size="lg" label="Your score is loading" />
        ) : (
          <ScoreBadge score={score} bucket={bucket} size="lg" />
        )}
      </View>

      {/**
       * `YOU`, on the ring rather than beside it.
       *
       * Overlapping the circle's lower edge makes the two one object: a caption set
       * under a badge is a second element the eye has to associate, and the founder's
       * note is that a naked `10.0` is not sufficient — so the word has to arrive with
       * the number rather than after it.
       *
       * Paper ground with a Maroon hairline, not a second filled Maroon shape: the
       * circle is already the page's chromatic element and a filled pill on top of it
       * would be two.
       */}
      <View style={styles.you}>
        <Text variant="caption" tone="action" allowFontScaling={false} style={styles.youInk}>
          YOU
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  column: { alignItems: 'center' },
  you: {
    // Onto the circle's lower edge. The pill is 18pt tall, so a third of it overlaps.
    marginTop: -6,
    paddingHorizontal: theme.space[2],
    height: 18,
    justifyContent: 'center',
    borderRadius: theme.radius.full,
    backgroundColor: theme.surface.base,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.semantic.action,
  },
  // Tight and letter-spaced: three capitals reading as a label rather than as a word in
  // a sentence. `allowFontScaling` is off for the same reason the badge's number is —
  // the pill is sized for this string and the ratio is what keeps it round.
  youInk: { fontSize: 10, lineHeight: 12, letterSpacing: 0.8 },
  pressed: { opacity: 0.7 },
});
