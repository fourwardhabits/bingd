import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { theme } from '../tokens';

export type IconToggleOption<T extends string> = {
  value: T;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  /** Announced, and the only name this control has — there is no visible label. */
  label: string;
};

export type IconToggleProps<T extends string> = {
  /** Two cells. See "WHY TWO, EXACTLY" below: a closed tuple, not a bare array. */
  options: readonly [IconToggleOption<T>, IconToggleOption<T>];
  value: T;
  onChange: (next: T) => void;
  /** Announced for the group. "View" on Collection. */
  label: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * Two glyphs in one segmented cell: pick a way of looking at this screen.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SHARED COMPONENT AND NOT A SECOND COPY
 *
 * It began inside `CollectionView` as a private `ModeButton` pair, which was right while
 * there was one of them. The founder's 2026-08-28 §5 asks the Feed's new
 * Feed/Leaderboard control to use "the SAME interaction and visual grammar" as
 * Collection's poster/list toggle — and the way to satisfy that is not to build a second
 * one carefully, it is to have one component.
 *
 * The distinction matters because these two controls are *deliberately different in
 * behaviour*: Collection's choice is persisted across launches and the Feed's is
 * explicitly not (§6, so a launch never opens on Leaderboard instead of the homepage).
 * Two controls that behave differently and look the same have to look the same by
 * construction, or the next tuning pass moves one and not the other and the reader is
 * left with two dialects of the same idea.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO, EXACTLY
 *
 * At three this stops being a toggle and becomes something with room for words. A
 * glyph-only cell is legible because there are two of them and the pair is a question with
 * two answers. The Feed held a third cell from 2026-09-08 until the founder moved its modes
 * to labelled `SegmentedTabs` on 2026-11-02, so the tuple is closed at two again.
 *
 * `radiogroup` rather than a switch, because a switch implies on/off and neither of
 * these has an off state — the reader is always looking at one of the two.
 */
export function IconToggle<T extends string>({
  options,
  value,
  onChange,
  label,
  style,
}: IconToggleProps<T>) {
  return (
    <View style={[styles.group, style]} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.value)}
            /**
             * 36 × 32 drawn. Vertical slop is the chip arithmetic and lifts every cell to
             * 44 tall; horizontal slop goes on the *outer* edges only. The cells touch, and
             * React Native hit-tests siblings last-first, so a left slop on any cell but
             * the first would take its neighbour's own right edge from it. Each outer edge
             * gets the eight points that make its cell 44 wide.
             *
             * **In a three-cell group the middle cell is therefore 36 × 44 rather than
             * 44 × 44**, and that is a measured concession rather than an oversight. There
             * is no distribution that fixes it: the cells are flush, so the only eight
             * points a middle cell could gain are ones it takes from a neighbour's *drawn*
             * area — a cell that looks pressable and is not is a worse defect than a cell
             * that is eight points narrow. What makes the trade acceptable here and nowhere
             * else is what a mis-tap costs: the neighbours are the other two answers to the
             * same question, nothing is destructive, and one more tap undoes it.
             * `touch-targets.test.tsx` pins all of this so it stays a decision.
             */
            hitSlop={{
              top: theme.layout.chipHitSlop.top,
              bottom: theme.layout.chipHitSlop.bottom,
              left: index === 0 ? theme.space[2] : 0,
              right: index === options.length - 1 ? theme.space[2] : 0,
            }}
            style={({ pressed }) => [
              styles.cell,
              selected && styles.cellOn,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons
              name={option.icon}
              size={theme.layout.icon.sm}
              color={selected ? theme.semantic.actionText : theme.text.secondary}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    flexDirection: 'row',
    borderRadius: theme.radius.control,
    overflow: 'hidden',
  },
  cell: {
    width: theme.layout.minTapTarget - theme.space[2],
    height: theme.layout.control.chipHeight,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surface.sunken,
  },
  cellOn: { backgroundColor: theme.semantic.action },
  pressed: { opacity: 0.7 },
});
