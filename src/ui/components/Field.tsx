import { useId } from 'react';
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

export function Field({ label, hint, error, ...rest }: FieldProps) {
  const id = useId();
  const description = error ?? hint;

  return (
    <View style={styles.wrapper}>
      <Text variant="caption" tone="secondary" nativeID={`${id}-label`}>
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityLabelledBy={`${id}-label`}
        accessibilityHint={description}
        // Announced rather than shown in red only, so the message reaches a user
        // who cannot distinguish the border colour.
        aria-invalid={Boolean(error)}
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
}

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
