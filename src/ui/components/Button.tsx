import { Pressable, StyleSheet, View, type PressableProps } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

type Kind = 'primary' | 'secondary' | 'tertiary';

/**
 * `md` is the screen's own action. `sm` is one that belongs to a row.
 *
 * A notification offering Follow back was using `md`, which is the same physical
 * control a screen uses for its primary act — 48pt tall with 20pt of padding either
 * side, sitting under a 56pt row and very nearly doubling its height. `sm` is 36pt
 * and still clears the 44pt target with the `hitSlop` its caller passes, because slop
 * is the right tool for a control inside a list and a taller box is not.
 */
type Size = 'md' | 'sm';

export type ButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  kind?: Kind;
  size?: Size;
  /**
   * Required when disabled. An unexplained dead button is the most common
   * accessibility failure in this pattern (design-system.md §8), so the reason
   * is announced to screen readers rather than left to be inferred.
   */
  disabledReason?: string;
};

export function Button({
  label,
  kind = 'primary',
  size = 'md',
  disabled,
  disabledReason,
  ...rest
}: ButtonProps) {
  if (disabled && !disabledReason && __DEV__) {
    console.warn(`Button "${label}" is disabled without a disabledReason.`);
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      accessibilityHint={disabled ? disabledReason : undefined}
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        styles[size],
        styles[kind],
        pressed && !disabled && styles.pressed,
        disabled && styles.disabled,
      ]}
      {...rest}
    >
      <View pointerEvents="none">
        <Text
          variant={size === 'sm' ? 'callout' : 'headline'}
          tone={kind === 'primary' ? 'inverse' : 'primary'}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: theme.radius.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  md: { minHeight: theme.layout.buttonMinHeight, paddingHorizontal: theme.space[5] },
  sm: { minHeight: 36, paddingHorizontal: theme.space[4] },
  primary: { backgroundColor: theme.semantic.action },
  secondary: {
    backgroundColor: theme.surface.raised,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.strong,
  },
  tertiary: { backgroundColor: 'transparent', paddingHorizontal: theme.space[2] },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.4 },
});
