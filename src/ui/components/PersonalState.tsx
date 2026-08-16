import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Bucket } from '@/features/collection/score';

import { theme } from '../tokens';
import { ScoreBadge } from './ScoreBadge';
import { Text } from './Text';

export type PersonalStateProps = {
  /** Null when this viewer has not ranked it. */
  score?: number | null;
  bucket?: Bucket | null;
  /** `#1 in Movies`. An ordinal, and only ever described as one. */
  ordinal?: string | null;
  /** Opens the log sheet — the same confirm-first flow either state leads to. */
  onPress: () => void;
  /** A series cannot be ranked (PRD §10), so it gets neither control. */
  rankable?: boolean;
};

/**
 * What *I* have done with this title, opposite the poster.
 *
 * This region answers one question — my relationship to the title — and the founder's
 * structural reference is the Subscribed control: an obvious piece of state that is
 * also the way to change it. Two things it is deliberately not:
 *
 *   - **the community's number.** That was here, beside the reader's own, and the two
 *     competed: same size, same shape, one about you and one about everybody. The
 *     community score moved to its own section further down.
 *   - **an invisible hotspot.** The ranked state used to be a bare badge that happened
 *     to be tappable, with nothing saying so. There is now always a labelled control
 *     under the number, in both states, so nothing here is discoverable only by
 *     guessing.
 *
 * The unranked state is a filled Maroon button because it is an invitation; the ranked
 * state is an outlined chip because it is a fact you may edit. Same position, same
 * size, so the region does not reflow when a title goes from one to the other.
 */
export function PersonalState({
  score,
  bucket,
  ordinal,
  onPress,
  rankable = true,
}: PersonalStateProps) {
  if (!rankable) return null;

  const ranked = score != null;

  return (
    <View style={styles.column}>
      {ranked ? (
        <>
          <ScoreBadge score={score} bucket={bucket} size="lg" />
          <Text variant="caption" tone="secondary">
            Your score
          </Text>
          {ordinal ? (
            <Text variant="caption" tone="tertiary" numberOfLines={1}>
              {ordinal}
            </Text>
          ) : null}
        </>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: ranked }}
        accessibilityLabel={
          ranked ? 'Ranked. Change your rating.' : 'Rank this title'
        }
        accessibilityHint={ranked ? 'Opens the rating sheet' : undefined}
        onPress={onPress}
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
  column: { alignItems: 'center', gap: theme.space[1] },
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
