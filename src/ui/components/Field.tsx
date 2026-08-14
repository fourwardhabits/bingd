import { forwardRef, useId } from 'react';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type FieldProps = Omit<TextInputProps, 'style' | 'placeholderTextColor'> & {
  label: string;
  /** Shown under the field. Announced to screen readers along with the label. */
  hint?: string;
  /**
   * Replaces the hint and is announced as an error. Colour is never the only
   * signal — the message itself carries the meaning (design-system.md §8).
   */
  error?: string;
};

export const Field = forwardRef<TextInput, FieldProps>(function Field(
  { label, hint, error, ...rest },
  ref,
) {
  const id = useId();
  const description = error ?? hint;

  return (
    <View style={styles.wrapper}>
      <Text variant="caption" tone="secondary" nativeID={`${id}-label`}>
        {label}
      </Text>
      <TextInput
        ref={ref}
        accessibilityLabel={error ? `${label}. ${error}` : label}
        accessibilityLabelledBy={`${id}-label`}
        accessibilityHint={description}
        placeholderTextColor={theme.text.tertiary}
        style={[styles.input, Boolean(error) && styles.inputError]}
        {...rest}
      />
      {description ? (
        <Text variant="caption" tone={error ? 'action' : 'tertiary'}>
          {description}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: { gap: theme.space[1] },
  input: {
    minHeight: theme.layout.buttonMinHeight,
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.strong,
    backgroundColor: theme.surface.raised,
    paddingHorizontal: theme.space[3],
    color: theme.text.primary,
    ...theme.typography.body,
  },
  inputError: { borderColor: theme.semantic.danger },
});
