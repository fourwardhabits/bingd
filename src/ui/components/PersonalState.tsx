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
    <View style={[styles.column, ranked ? styles.ranked_ : styles.unrankedColumn]}>
      {ranked ? (
        <>
          <ScoreBadge score={score} bucket={bucket} size="lg" />
          <Text variant="caption" tone="secondary">
            Your score
          </Text>
          {ordinal ? (
            <Text variant="caption" tone="tertiary" numberOfLines={1} style={styles.ordinal}>
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
  /**
   * Right-aligned when ranked; left-aligned when not.
   *
   * The two states want opposite things and it took the founder's screenshots to see
   * why. **Ranked**, the column is a badge, a label and an ordinal — a block of
   * information whose natural spine is the screen's right edge, opposite the poster.
   * Centred it floated in whatever width was left over and lined up with nothing;
   * left-aligned it sat a gutter from the poster with a ragged right edge and a wide
   * empty channel beside it.
   *
   * **Unranked**, there is only a button, and a button pinned to the right edge of a
   * mostly-empty band reads as an afterthought. Left, hard against the poster, it reads
   * as the thing to do next — which it is.
   *
   * The two states no longer occupy the same height, and that is also deliberate: see
   * `unrankedColumn`.
   */
  column: { gap: theme.space[1] },
  ranked_: { alignItems: 'flex-end' },
  /**
   * The unranked state stops reserving room for a score that is not there.
   *
   * It used to hold the ranked layout's height so the region would not reflow when a
   * title went from one state to the other. The founder's screenshots of Ant-Man and
   * The Dark Tower are what that costs: a tall empty channel beside the poster with one
   * small button at the bottom of it, on every title nobody has ranked — which is most
   * of them, and all of them for a new account.
   *
   * A reflow when somebody ranks something is a reflow they caused, on a screen they
   * are looking at, immediately after an action. Dead space is on every page for ever.
   */
  unrankedColumn: { alignItems: 'flex-start', justifyContent: 'flex-start' },
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
