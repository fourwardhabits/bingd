import { forwardRef, useId, useImperativeHandle, useRef } from 'react';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { theme } from '../tokens';
import { useEnsureVisible } from './KeyboardScreen';
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
  { label, hint, error, onFocus, ...rest },
  ref,
) {
  const id = useId();
  const description = error ?? hint;

  /**
   * Kept locally as well as forwarded, so focusing this field can scroll it clear of
   * the keyboard whether or not the caller took a ref of its own.
   *
   * The founder's report was the bio in Edit Profile still being covered. Bottom padding
   * had made it *reachable* and nothing was making it *reached*: Android's own
   * scroll-to-focus is driven by the window resize that edge-to-edge does not perform.
   * Doing it from here rather than from each screen means every form in the app gets it,
   * including the ones nobody has device-tested yet.
   */
  const input = useRef<TextInput>(null);
  useImperativeHandle(ref, () => input.current as TextInput, []);

  // Null outside a `KeyboardScreen` — a field in a sheet, say, which rises with the
  // keyboard instead and has nothing to scroll.
  const ensureVisible = useEnsureVisible();

  // Typed off the prop rather than off an event type imported by name: React Native has
  // renamed the latter more than once and the former cannot drift from what it feeds.
  const handleFocus: NonNullable<TextInputProps['onFocus']> = (event) => {
    ensureVisible?.(input.current);
    onFocus?.(event);
  };

  return (
    <View style={styles.wrapper}>
      <Text variant="caption" tone="secondary" nativeID={`${id}-label`}>
        {label}
      </Text>
      <TextInput
        ref={input}
        accessibilityLabel={error ? `${label}. ${error}` : label}
        accessibilityLabelledBy={`${id}-label`}
        accessibilityHint={description}
        placeholderTextColor={theme.text.tertiary}
        style={[styles.input, Boolean(error) && styles.inputError]}
        onFocus={handleFocus}
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
