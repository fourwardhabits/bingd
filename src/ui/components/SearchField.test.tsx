import { fireEvent, render } from '@testing-library/react-native';
import { createRef } from 'react';
import { StyleSheet, type TextInput, type TextStyle } from 'react-native';

import { theme } from '../tokens';
import { SearchField } from './SearchField';

/**
 * One property, and it is the one a caller depends on.
 *
 * Re-tapping the Search tab returns to an empty field **with the keyboard up**, and that
 * is a `focus()` on the input rather than anything this component can decide for itself.
 * The screen holds the ref; what this asserts is that the ref reaches the `TextInput`
 * and not the wrapper — which is the way a forwarded ref silently stops working.
 */
it('forwards its ref to the input, so a caller can focus it', async () => {
  const ref = createRef<TextInput>();

  await render(<SearchField ref={ref} accessibilityLabel="Search" value="" />);

  expect(ref.current).toBeTruthy();
  expect(typeof ref.current?.focus).toBe('function');
});

/**
 * **The clear button is named and as large as its row allows** (design-system v3 A.2 #11).
 * It had no label and 8pt of slop all round (40 × 40). Slop only answers inside the row, so
 * it is checked against the row's real gap, padding and height.
 */
it('labels the clear button and gives it the row’s room as slop', async () => {
  const onClear = jest.fn();
  const view = await render(
    <SearchField accessibilityLabel="Search" value="dune" onClear={onClear} />,
  );

  const clear = view.getByRole('button', { name: 'Clear search' });
  const slop = clear.props.hitSlop as {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };

  // The row it sits in (the nearest host View above the button), and the glyph it draws.
  let parent = clear.parent;
  while (parent && parent.type !== 'View') parent = parent.parent;
  const row = StyleSheet.flatten(parent!.props.style);
  // The jest renderer draws the glyph as a Text carrying the icon's size as its fontSize.
  const glyph = clear.children[0] as unknown as { props: { style: TextStyle } };
  const size = StyleSheet.flatten(glyph.props.style).fontSize as number;
  expect(size).toBe(theme.layout.icon.md);

  // Horizontally: the gap to the input and the row's padding, which reach 44.
  expect(slop.left).toBeLessThanOrEqual(row.gap);
  expect(slop.right).toBeLessThanOrEqual(row.paddingHorizontal);
  expect(size + slop.left + slop.right).toBeGreaterThanOrEqual(theme.layout.minTapTarget);
  // Vertically: the whole row, which is 40pt and the ceiling.
  expect(row.minHeight).toBe(40);
  expect(size + slop.top + slop.bottom).toBe(row.minHeight);

  fireEvent.press(clear);
  expect(onClear).toHaveBeenCalled();
});
