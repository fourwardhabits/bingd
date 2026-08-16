import { Pressable, StyleSheet, View } from 'react-native';

import { formatScore, type Bucket } from '@/features/collection/score';

import { theme } from '../tokens';
import { Text } from './Text';

export type ScoreBadgeProps = {
  /** Omit for a title that is logged but not yet compared. */
  score?: number | null;
  bucket?: Bucket | null;
  size?: 'md' | 'sm';
  /** Makes the unranked state a button into the ranking sheet. */
  onPress?: () => void;
};

const BAND_LABEL: Record<Bucket, string> = {
  loved: 'Loved it',
  fine: 'It was fine',
  not_for_me: 'Not for me',
};

/**
 * The derived 0–10 score, as a filled circle in its bucket's colour
 * (design-system.md §8).
 *
 * Filled rather than outlined, which is where this departs from Beli. Beli's
 * badge is a ring whose stroke and number share a colour that tracks the score;
 * on a light ground two of Bingd's three bucket colours measure under 3:1 as a
 * stroke, so two thirds of the app's most repeated element would have shipped
 * below the text floor. Filling inverts it — the fill carries the colour and
 * the ink carries the contrast, and all three pairs in §3 clear AA.
 */
export function ScoreBadge({ score, bucket, size = 'md', onPress }: ScoreBadgeProps) {
  const diameter = theme.layout.scoreBadge[size];

  if (score == null || bucket == null) {
    return <UnrankedBadge diameter={diameter} onPress={onPress} />;
  }

  const value = formatScore(score);

  return (
    <View
      accessible
      accessibilityRole="text"
      // "8.7" alone is a bare number in a list of film titles. The unit and the
      // bucket are what make it mean anything read aloud.
      accessibilityLabel={`${value} out of 10, ${BAND_LABEL[bucket]}`}
      style={[
        styles.circle,
        { width: diameter, height: diameter, backgroundColor: theme.bucket[bucketKey(bucket)] },
      ]}
    >
      <Text
        variant="score"
        style={[{ color: theme.bucketInk[bucketKey(bucket)] }, size === 'sm' && styles.small]}
        // The badge is a fixed circle, so the number cannot grow with Dynamic
        // Type without spilling out of it. The row around it still scales.
        maxFontSizeMultiplier={1.2}
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
      <Text variant="caption" tone="tertiary" maxFontSizeMultiplier={1.2}>
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

/** `bucket.notForMe` is camelCase in the palette; the data is snake_case. */
const bucketKey = (bucket: Bucket): 'loved' | 'fine' | 'notForMe' =>
  bucket === 'not_for_me' ? 'notForMe' : bucket;

const styles = StyleSheet.create({
  circle: {
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unranked: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.border.strong,
  },
  small: { fontSize: 15, lineHeight: 18 },
  pressed: { opacity: 0.7 },
});
