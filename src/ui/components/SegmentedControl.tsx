import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type SegmentedControlOption<T extends string> = {
  id: T;
  label: string;
  /** Read out after the label, so a screen reader gets the consequence and not just the word. */
  hint?: string;
};

export type SegmentedControlProps<T extends string> = {
  /** Announced above the group. Required — an unlabelled group of two words is a riddle. */
  label: string;
  options: readonly SegmentedControlOption<T>[];
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  testID?: string;
};

/**
 * One choice out of two or three, made in place — [ Public ] [ Private ].
 *
 * **Why this is not `SegmentedTabs`.** That component is navigation: it wears
 * `tablist`/`tab`, it is drawn as an underline precisely so it reads as chrome, and it
 * changes which content is shown. This one is *an answer to a question* — it is a
 * radio group in the accessibility tree, it has a fill, and what it changes is a value
 * that gets saved. Using the tab component for a form field would tell every screen
 * reader that choosing Private navigates somewhere, which is the opposite of what it
 * does.
 *
 * **Why it is not three `Chip`s either.** `Chip` carries `accessibilityRole="button"`
 * and no group, so the two options would be announced as two unrelated buttons with no
 * indication that they are alternatives or which one is currently true. `BucketChoices`
 * is the app's existing radio group and gets this right, but it is 44pt circles built
 * for a scale of three feelings; a form field asking Public or Private is a strip.
 *
 * Selection is fill *and* border *and* `selected` state, never colour alone
 * (design-system.md §8). The whole strip is one hairline-bordered container so the
 * options read as two halves of one control rather than as two loose buttons — the
 * founder's objection to the ranking sheet's Undo and Skip, applied before it happens.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  testID,
}: SegmentedControlProps<T>) {
  return (
    <View
      style={[styles.group, disabled && styles.disabled]}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      testID={testID}
    >
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityHint={option.hint}
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => onChange(option.id)}
            style={({ pressed }) => [
              styles.option,
              selected && styles.optionSelected,
              pressed && !disabled && styles.pressed,
            ]}
          >
            <Text variant="callout" tone={selected ? 'primary' : 'secondary'}>
              {option.label}
            </Text>
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
    borderColor: theme.border.strong,
    backgroundColor: theme.surface.raised,
    // The container's own border is the outline; the padding is what keeps the
    // selected fill from sitting on top of it.
    padding: 2,
    gap: 2,
  },
  // Equal halves, and tall enough on their own: this is a form field rather than a
  // control inside a row, so it does not get to lean on `hitSlop` for the 44pt floor.
  option: {
    flex: 1,
    minHeight: theme.layout.minTapTarget - 4,
    borderRadius: theme.radius.control - 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionSelected: {
    backgroundColor: theme.surface.sunken,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.semantic.action,
  },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.4 },
});
