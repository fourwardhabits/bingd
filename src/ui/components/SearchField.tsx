import { Ionicons } from '@expo/vector-icons';
import { forwardRef } from 'react';
import { Pressable, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { inputText, theme } from '../tokens';

export type SearchFieldProps = Omit<TextInputProps, 'style'> & {
  onClear?: () => void;
};

/**
 * The field itself is forwarded, because one caller has to be able to put the cursor in
 * it: re-tapping the Search tab returns to an empty field **with the keyboard up**, and
 * that is a `focus()` on the input rather than anything this component can decide for
 * itself. Nothing else uses the ref, and the component is otherwise unchanged.
 */
export const SearchField = forwardRef<TextInput, SearchFieldProps>(function SearchField(
  { value, onClear, ...rest },
  ref,
) {
  const hasValue = Boolean(value && String(value).length);

  return (
    <View style={styles.row}>
      <Ionicons name="search" size={theme.layout.icon.md} color={theme.text.tertiary} />
      <TextInput
        ref={ref}
        value={value}
        placeholderTextColor={theme.text.tertiary}
        style={styles.input}
        {...rest}
      />
      {hasValue ? (
        <Pressable accessibilityRole="button" onPress={onClear} hitSlop={theme.space[2]}>
          <Ionicons name="close-circle" size={theme.layout.icon.md} color={theme.text.tertiary} />
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    minHeight: theme.layout.control.searchFieldHeight,
    borderRadius: theme.radius.control,
    borderColor: theme.border.strong,
    borderWidth: StyleSheet.hairlineWidth * 2,
    backgroundColor: theme.surface.raised,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
    paddingHorizontal: theme.space[3],
  },
  // `inputText`, not `typography.body`: a line-height on a single-line iOS
  // TextInput sinks the text below the field's visual centre.
  input: {
    flex: 1,
    color: theme.text.primary,
    ...inputText,
  },
});
