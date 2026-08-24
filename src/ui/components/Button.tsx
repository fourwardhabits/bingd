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

/**
 * How loudly the label reads, where the default is wrong.
 *
 * Every kind has a tone that follows from it — a primary button is inverse on Maroon,
 * everything else is full ink — and that is right for a control which is the point of
 * its screen. It is wrong for one that deliberately is not: the ranking sheet's Undo
 * and Skip sit under two posters, and full-ink at `headline` weight made them read as
 * the question rather than as the way out of it.
 *
 * Optional, and the default is exactly what every existing caller already gets. A
 * button asks for a quieter tone; it cannot be given a louder one than its kind
 * implies, because that is what `kind` is for.
 */
type Tone = 'default' | 'secondary';

export type ButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  kind?: Kind;
  size?: Size;
  tone?: Tone;
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
  tone = 'default',
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
          tone={
            kind === 'primary' ? 'inverse' : tone === 'secondary' ? 'secondary' : 'primary'
          }
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
