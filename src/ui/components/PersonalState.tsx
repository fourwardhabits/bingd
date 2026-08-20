import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Bucket } from '@/features/collection/score';

import { theme } from '../tokens';
import { EmptyScoreBadge, ScoreBadge } from './ScoreBadge';
import { Text } from './Text';

export type PersonalStateProps = {
  /** Null when this viewer has not ranked it. */
  score?: number | null;
  bucket?: Bucket | null;
  /** `#1 in Movies`. An ordinal, and only ever described as one. */
  ordinal?: string | null;
  /** Opens the log sheet — what the unranked state leads to. */
  onPress: () => void;
  /**
   * Opens the menu behind the Ranked control: change the rating, remove the ranking,
   * remove the title from the collection. Falls back to `onPress` where a caller has
   * no menu to offer.
   */
  onPressRanked?: () => void;
  /** A series cannot be ranked (PRD §10), so it gets neither control. */
  rankable?: boolean;
};

/**
 * What *I* have done with this title, opposite the poster.
 *
 * This region answers one question — my relationship to the title — and the founder's
 * structural reference is the Subscribed control: an obvious piece of state that is
 * also the way to change it.
 *
 * **Both states now draw a circle and both hang from the same right edge.** That is the
 * founder's correction after the device pass, and it undoes an over-correction. An
 * earlier round removed the circle from the unranked state to kill a tall empty channel
 * beside the poster; the channel was really caused by the column filling from the top,
 * which `scoreColumn`'s `flex-end` already fixed. Dropping the circle as well meant the
 * Rank button landed in a different place from the Ranked chip it turns into, so the one
 * control on the page moved the moment you used it. The circle costs one row and buys a
 * region that holds still.
 *
 * The unranked state is a filled Maroon button because it is an invitation; the ranked
 * state is an outlined chip because it is a fact you may edit.
 */
export function PersonalState({
  score,
  bucket,
  ordinal,
  onPress,
  onPressRanked,
  rankable = true,
}: PersonalStateProps) {
  if (!rankable) return null;

  const ranked = score != null;

  return (
    <View style={styles.column}>
      {ranked ? (
        <ScoreBadge score={score} bucket={bucket} size="lg" />
      ) : (
        // Not the dashed "Rank" ring: the button under it already says that, and two
        // invitations stacked on top of each other is one more than the region needs.
        <EmptyScoreBadge size="lg" label="You have not ranked this yet" />
      )}
      <Text variant="caption" tone="secondary">
        Your score
      </Text>
      {ordinal ? (
        <Text variant="caption" tone="tertiary" numberOfLines={1} style={styles.ordinal}>
          {ordinal}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: ranked }}
        accessibilityLabel={ranked ? 'Ranked. Change or remove this.' : 'Rank this title'}
        accessibilityHint={
          ranked ? 'Opens rating and collection options' : 'Opens the rating sheet'
        }
        onPress={ranked ? (onPressRanked ?? onPress) : onPress}
        hitSlop={theme.space[2]}
        style={({ pressed }) => [
          styles.control,
          ranked ? styles.ranked : styles.unranked,
          pressed && styles.pressed,
        ]}
      >
        <Ionicons
          name={ranked ? 'checkmark-circle' : 'star-outline'}
          size={theme.layout.icon.sm}
          color={ranked ? theme.semantic.action : theme.semantic.actionText}
        />
        <Text variant="callout" tone={ranked ? 'action' : 'inverse'}>
          {ranked ? 'Ranked' : 'Rank'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * Right-aligned in both states.
   *
   * The column is a block of information whose natural spine is the screen's right
   * edge, opposite the poster. Centred it floats in whatever width is left over and
   * lines up with nothing; left-aligned it sits a gutter from the poster with a ragged
   * right edge. The parent hangs it from the bottom, so the control is at the poster's
   * lower edge whichever state it is in.
   */
  column: { gap: theme.space[1], alignItems: 'flex-end' },
  // The ordinal can be the widest thing in the column, so it is allowed to use the
  // full width rather than pushing the badge's alignment around.
  ordinal: { alignSelf: 'stretch', textAlign: 'right' },
  control: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[1],
    minHeight: theme.layout.control.chipHeight,
    minWidth: 104,
    paddingHorizontal: theme.space[3],
    borderRadius: theme.radius.control,
    marginTop: theme.space[1],
  },
  unranked: { backgroundColor: theme.semantic.action },
  ranked: {
    backgroundColor: theme.surface.raised,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.semantic.action,
  },
  pressed: { opacity: 0.7 },
});
