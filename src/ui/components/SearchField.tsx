import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { theme } from '../tokens';

export type SearchFieldProps = Omit<TextInputProps, 'style'> & {
  onClear?: () => void;
};

export function SearchField({ value, onClear, ...rest }: SearchFieldProps) {
  const hasValue = Boolean(value && String(value).length);

  return (
    <View style={styles.row}>
      <Ionicons name="search" size={theme.layout.icon.md} color={theme.text.tertiary} />
      <TextInput
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
}

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
  input: {
    flex: 1,
    color: theme.text.primary,
    ...theme.typography.body,
  },
});
