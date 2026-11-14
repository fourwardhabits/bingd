import { fireEvent, render } from '@testing-library/react-native';
import { createRef } from 'react';
import { StyleSheet, View, type TextInput } from 'react-native';

import { hitRect, measure, parentView, type Host } from '@/test-utils/hit-rect';

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
 * **The clear button answers 44 × 44, and the field is drawn exactly as it was** (A11Y-44,
 * design-system v3 A.2 #11).
 *
 * It had no label and 8pt of slop (40 × 40), then slop to the row's edges (#299): 44 wide
 * but 40 tall, because RN delivers no touch outside the 40pt row and the row was the
 * parent. The button is now a child of a 44pt box around the row, with no slop at all.
 * Measured, not added up: laid out from the rendered styles, with the button's rect clipped
 * by every box it sits in (`hit-rect.ts`).
 */
describe('the clear button', () => {
  const WIDTH = 360;
  const setup = async (onClear = jest.fn()) => {
    const view = await render(
      <View testID="root">
        <SearchField accessibilityLabel="Search" value="dune" onClear={onClear} />
      </View>,
    );
    const root = view.getByTestId('root') as unknown as Host;
    const clear = view.getByRole('button', { name: 'Clear search' }) as unknown as Host;
    const input = view.getByLabelText('Search') as unknown as Host;
    return { view, root, clear, input, onClear };
  };

  it('answers 44 × 44 inside the field’s own box, with no slop', async () => {
    const { root, clear } = await setup();
    const hit = hitRect(root, clear, WIDTH);

    expect(clear.props.hitSlop).toBeUndefined();
    expect(hit.height).toBeGreaterThanOrEqual(theme.layout.minTapTarget);
    expect(hit.width).toBeGreaterThanOrEqual(theme.layout.minTapTarget);
    // Its parent is the field's 44pt box, and the button fills its height.
    const field = parentView(clear);
    expect(hit.boxes.get(field)!.height).toBe(theme.layout.minTapTarget);
    expect(hit.box.height).toBe(hit.boxes.get(field)!.height);
  });

  it('draws the field at 40pt, with the glyph and the input where they were', async () => {
    const { root, clear, input } = await setup();
    const { boxes } = hitRect(root, clear, WIDTH);
    const row = parentView(input);
    const rowBox = boxes.get(row)!;
    const rowStyle = StyleSheet.flatten(row.props.style) as {
      minHeight: number;
      borderWidth: number;
      paddingHorizontal: number;
      gap: number;
    };

    // The token, and the chrome drawn from it, are unchanged.
    expect(theme.layout.control.searchFieldHeight).toBe(40);
    expect(rowStyle.minHeight).toBe(40);
    expect(rowBox.height).toBe(40);
    // 2pt of the field's box above and below the drawn field, which draws nothing.
    const field = parentView(row);
    expect(rowBox.top - boxes.get(field)!.top).toBe(2);
    expect(StyleSheet.flatten(field.props.style)).toEqual({ paddingVertical: 2 });

    // The glyph: 24pt, centred on the drawn field, and the row's padding and border in from
    // its right edge, as it was when it sat in the row.
    const glyph = clear.children[0] as unknown as Host;
    const glyphBox = boxes.get(glyph)!;
    expect(StyleSheet.flatten(glyph.props.style as never)).toMatchObject({
      fontSize: theme.layout.icon.md,
    });
    expect(glyphBox.top + glyphBox.height / 2).toBe(rowBox.top + rowBox.height / 2);
    expect(rowBox.left + rowBox.width - (glyphBox.left + glyphBox.width)).toBeCloseTo(
      rowStyle.paddingHorizontal + rowStyle.borderWidth,
    );
    // The input stops one gap short of the glyph, as it did: an empty view holds the
    // glyph's room in the row.
    const inputBox = boxes.get(input)!;
    expect(glyphBox.left - (inputBox.left + inputBox.width)).toBeCloseTo(rowStyle.gap);
  });

  it('is labelled, and clears on press', async () => {
    const { view, onClear } = await setup();
    await fireEvent.press(view.getByRole('button', { name: 'Clear search' }));
    expect(onClear).toHaveBeenCalled();
  });

  it('takes the same 44pt with or without a value, so typing moves nothing', async () => {
    const view = await render(
      <View testID="root">
        <SearchField accessibilityLabel="Search" value="" />
      </View>,
    );
    expect(view.queryByRole('button', { name: 'Clear search' })).toBeNull();
    const root = view.getByTestId('root') as unknown as Host;
    const input = view.getByLabelText('Search') as unknown as Host;
    const boxes = measure(root, WIDTH);
    expect(boxes.get(parentView(parentView(input)))!.height).toBe(theme.layout.minTapTarget);
  });
});
