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
    <View style={styles.hit}>
      <View style={styles.row}>
        <Ionicons name="search" size={theme.layout.icon.md} color={theme.text.tertiary} />
        <TextInput
          ref={ref}
          value={value}
          placeholderTextColor={theme.text.tertiary}
          style={styles.input}
          {...rest}
        />
        {/* The glyph's room in the row, so the input is exactly as wide as it was. */}
        {hasValue ? <View style={styles.clearRoom} /> : null}
      </View>
      {hasValue ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={onClear}
          style={styles.clear}
        >
          <Ionicons
            name="close-circle"
            size={theme.layout.icon.md}
            color={theme.text.tertiary}
          />
        </Pressable>
      ) : null}
    </View>
  );
});

/** The field's border, which the clear glyph sits inside. */
const BORDER = StyleSheet.hairlineWidth * 2;

/**
 * **A 44pt box around the 40pt field, and the clear button fills its end** (A11Y-44,
 * design-system v3 A.2 #11).
 *
 * The clear button was a 24pt glyph in the 40pt row with slop to the row's edges. RN
 * delivers no touch outside a parent's bounds, so the row's height was the ceiling: 44
 * wide by 40 tall, and no slop could make it taller without drawing the field taller.
 *
 * So the field is drawn exactly as before (`row`, `searchFieldHeight`, unchanged), inside
 * an outer box 2pt taller above and below that draws nothing (`hit`), and the clear button
 * is a child of that box rather than of the row: 44pt tall, and as wide as the gap to the
 * input, the glyph and the row's padding (8 + 24 + 12, and the border). It has no slop, because there is
 * nothing for slop to reach that the button does not already cover. Its glyph sits where
 * it did (12pt and the border in from the right, centred on the row), and an empty view of
 * the glyph's width keeps the input exactly as wide as it was.
 *
 * The field now takes 44pt in its parent rather than 40. Every caller gives the 4pt back
 * from space that was already around the field, so nothing on screen moves.
 */
const HIT_INSET = (theme.layout.minTapTarget - theme.layout.control.searchFieldHeight) / 2;

const styles = StyleSheet.create({
  hit: { paddingVertical: HIT_INSET },
  row: {
    minHeight: theme.layout.control.searchFieldHeight,
    borderRadius: theme.radius.control,
    borderColor: theme.border.strong,
    borderWidth: BORDER,
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
  clearRoom: { width: theme.layout.icon.md },
  clear: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: theme.space[2] + theme.layout.icon.md + theme.space[3] + BORDER,
    paddingLeft: theme.space[2],
    paddingRight: theme.space[3] + BORDER,
    justifyContent: 'center',
  },
});
