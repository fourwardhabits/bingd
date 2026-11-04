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
  /**
   * Two cells, or three. See "WHY TWO, EXACTLY — AND WHY THREE" below: the tuple is
   * still closed rather than a bare array, so a caller cannot quietly grow this into a
   * strip of five unlabelled glyphs.
   */
  options:
    | readonly [IconToggleOption<T>, IconToggleOption<T>]
    | readonly [IconToggleOption<T>, IconToggleOption<T>, IconToggleOption<T>];
  value: T;
  onChange: (next: T) => void;
  /** Announced for the group. "View" on Collection, "Feed mode" on the Feed. */
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
 * WHY TWO, EXACTLY — AND WHY THREE
 *
 * The tuple type used to take precisely two options, with this reasoning: at three this
 * stops being a toggle and becomes a segmented control, which the app already has as
 * `SegmentedControl` with room for labels; a glyph-only cell is legible because there are
 * two of them and the pair is a question with two answers, and a third unlabelled icon is
 * a guess.
 *
 * **The founder has taken the other side of that, for the Feed** (tranche 2026-09-08 §A2).
 * The Feed's control gains People beside Feed and Leaderboard, and the instruction is
 * explicit that it uses "the same component family, dimensions, border radius, selected
 * Maroon treatment and visual weight" — no responsive font shrinking, no wrapping, no
 * sixth tab. `SegmentedControl` cannot be that: it is a labelled radio group with `flex: 1`
 * halves that spans its container, so putting it opposite `TRENDING NOW` in a content
 * header row would take the row's whole width for three words.
 *
 * So the tuple widens to two *or* three, and the original objection is answered rather
 * than dropped: a glyph is a guess when nothing else on the screen names it, and each of
 * these three cells has a name where the reader is already looking — the left half of the
 * same row is the heading of whatever the selected cell shows (`TRENDING NOW`,
 * `THIS MONTH`, `PEOPLE YOU MAY KNOW`). The `label` on every option is still what a screen
 * reader is given, and it is still required.
 *
 * It stays a closed tuple. Three is a decision, not the start of a series: a fourth cell
 * would put the control past the width the founder's §A2 fixes it at, and at that point
 * the answer is a different control rather than one more glyph.
 *
 * The arithmetic holds at three on the narrowest phone this app supports. Each cell is
 * `minTapTarget - space[2]` = 36pt wide, so the group is 108pt plus two hairlines; on a
 * 320pt screen the row's other side has 108pt of the 288pt between the gutters left over
 * for a heading, and `SectionHeader`'s `sectionHeader` variant truncates rather than
 * wrapping. `touch-targets.test.tsx` is where the 44pt claim is asserted.
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
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    overflow: 'hidden',
  },
  cell: {
    width: theme.layout.minTapTarget - theme.space[2],
    height: theme.layout.control.chipHeight,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surface.raised,
  },
  cellOn: { backgroundColor: theme.semantic.action },
  pressed: { opacity: 0.7 },
});
