import { Pressable, StyleSheet, View, type PressableProps } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

type Kind = 'primary' | 'secondary' | 'tertiary';

export type ButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  kind?: Kind;
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
        styles[kind],
        pressed && !disabled && styles.pressed,
        disabled && styles.disabled,
      ]}
      {...rest}
    >
      <View pointerEvents="none">
        <Text variant="headline" tone={kind === 'primary' ? 'inverse' : 'primary'}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: theme.layout.buttonMinHeight,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.space[5],
    alignItems: 'center',
    justifyContent: 'center',
  },
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
