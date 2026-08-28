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
  options: readonly [IconToggleOption<T>, IconToggleOption<T>];
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
 * WHY TWO, EXACTLY
 *
 * The tuple type takes precisely two options. Not a limitation waiting to be lifted: at
 * three this stops being a toggle and becomes a segmented control, which this app already
 * has as `SegmentedControl` with room for labels. A glyph-only cell is legible because
 * there are two of them and the pair is a question with two answers; a third unlabelled
 * icon is a guess.
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
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.value)}
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
