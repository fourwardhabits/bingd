import { Ionicons } from '@expo/vector-icons';
import { fireEvent } from '@testing-library/react-native';
import { StyleSheet, Text as RNText } from 'react-native';

import { renderWithProviders as render } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { BrowseControlsRow } from './BrowseControlsRow';
import { FiltersAction } from './ContentToolbar';
import { FilterIconButton } from './FilterIconButton';
import { MEDIUM_SELECTED } from './MediumSelector';
import { ViewModeToggle } from './ViewModeToggle';

/** A Pressable's style, whether it is a value or a function of the pressed state. */
const styleOf = (node: { props: { style?: unknown } }) =>
  StyleSheet.flatten(
    typeof node.props.style === 'function'
      ? (node.props.style as (s: { pressed: boolean }) => unknown)({ pressed: false })
      : node.props.style,
  ) as Record<string, unknown>;

/**
 * The Ionicons glyph under a node, as `{ name, color }`. The jest renderer prints a glyph's
 * code point rather than its name, so the name is found by matching the glyph map.
 */
type Host = { props: Record<string, unknown>; children: (Host | string)[] };
const glyph = (node: Host): { name: string; color: unknown } | undefined => {
  const byChar = new Map(
    Object.entries(Ionicons.glyphMap).map(([name, code]) => [String.fromCodePoint(code as number), name]),
  );
  const walk = (at: Host | string): { name: string; color: unknown } | undefined => {
    if (typeof at === 'string') return undefined;
    const only = at.children.length === 1 ? at.children[0] : null;
    if (typeof only === 'string' && byChar.has(only)) {
      const style = StyleSheet.flatten(at.props.style as never) as { color?: unknown } | undefined;
      return { name: byChar.get(only)!, color: style?.color };
    }
    for (const child of at.children) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  };
  return walk(node);
};

describe('FilterIconButton (B4)', () => {
  it('is icon only, with the options glyph, in a 44pt target', async () => {
    const view = await render(
      <FilterIconButton activeCount={0} onPress={() => {}} accessibilityLabel="Filters and sort" testID="f" />,
    );
    const button = view.getByRole('button', { name: 'Filters and sort' });
    expect(view.queryByText(/Filters/)).toBeNull();
    expect(glyph(button as never)?.name).toBe('options-outline');
    expect(glyph(button as never)?.color).toBe(theme.text.secondary);
    const size = styleOf(button);
    expect(size.width).toBeGreaterThanOrEqual(theme.layout.minTapTarget);
    expect(size.height).toBeGreaterThanOrEqual(theme.layout.minTapTarget);
    expect(button.props.accessibilityState).toMatchObject({ selected: false, disabled: false });
  });

  it('shows and speaks the active count', async () => {
    const view = await render(
      <FilterIconButton activeCount={2} onPress={() => {}} accessibilityLabel="Filters and sort" testID="f" />,
    );
    const button = view.getByRole('button', { name: 'Filters and sort, 2 on' });
    expect(button.props.accessibilityState).toMatchObject({ selected: true });
    expect(glyph(button as never)?.color).toBe(theme.semantic.action);
    expect(view.getByText('2', { includeHiddenElements: true })).toBeTruthy();
  });

  it('has a disabled state that does not fire', async () => {
    const onPress = jest.fn();
    const view = await render(
      <FilterIconButton activeCount={1} onPress={onPress} accessibilityLabel="Filters" disabled />,
    );
    const button = view.getByRole('button', { name: 'Filters' });
    expect(button.props.accessibilityState).toMatchObject({ disabled: true, selected: false });
    expect(glyph(button as never)?.color).toBe(theme.text.tertiary);
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('FiltersAction, now icon only', () => {
  it('keeps its props; its label is spoken, never printed', async () => {
    const onPress = jest.fn();
    const view = await render(
      <FiltersAction label="Filters & Sort" activeCount={2} onPress={onPress} testID="fa" />,
    );
    expect(view.queryByText(/Filters/)).toBeNull();
    await fireEvent.press(view.getByRole('button', { name: 'Filters and sort, 2 on' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('defaults to "Filters", and passes a caller’s full sentence through unchanged', async () => {
    const view = await render(
      <>
        <FiltersAction activeCount={0} onPress={() => {}} />
        <FiltersAction activeCount={3} onPress={() => {}} accessibilityLabel="Filter and sort. 3 filters on" />
      </>,
    );
    expect(view.getByRole('button', { name: 'Filters' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Filter and sort. 3 filters on' })).toBeTruthy();
  });
});

describe('ViewModeToggle (B5)', () => {
  it('is one radio group of two icon segments, grid then list', async () => {
    const view = await render(<ViewModeToggle value="poster" onChange={() => {}} />);
    expect(view.getByLabelText('View').props.accessibilityRole).toBe('radiogroup');
    const radios = view.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radios.map((r) => r.props.accessibilityLabel)).toEqual(['Poster view', 'List view']);
    expect(radios.map((r) => glyph(r as never)?.name)).toEqual(['grid', 'list']);
    expect(radios[0]!.props.accessibilityState).toMatchObject({ selected: true });
    expect(radios[1]!.props.accessibilityState).toMatchObject({ selected: false });
  });

  it("selects with MediumSelector's own treatment", async () => {
    const view = await render(<ViewModeToggle value="list" onChange={() => {}} />);
    const [poster, list] = view.getAllByRole('radio') as [ReturnType<typeof view.getByRole>, ReturnType<typeof view.getByRole>];
    // The ground is the segment's, the pill drawn inside each 44pt target.
    expect(styleOf(view.getByTestId('view-mode-list-segment')).backgroundColor).toBe(MEDIUM_SELECTED.background);
    expect(MEDIUM_SELECTED.background).toBe(theme.surface.sunken);
    expect(glyph(list as never)?.color).toBe(MEDIUM_SELECTED.ink);
    expect(styleOf(view.getByTestId('view-mode-poster-segment')).backgroundColor).toBeUndefined();
    expect(glyph(poster as never)?.color).toBe(theme.text.secondary);
  });

  it('fires onChange with the other mode, and not for the one in force', async () => {
    const onChange = jest.fn();
    const view = await render(<ViewModeToggle value="poster" onChange={onChange} />);
    await fireEvent.press(view.getByRole('radio', { name: 'List view' }));
    await fireEvent.press(view.getByRole('radio', { name: 'Poster view' }));
    expect(onChange.mock.calls).toEqual([['list']]);
  });

  /**
   * **Codex review, #288.** The cells were 36pt with 4pt of vertical `hitSlop`, which React
   * Native does not honour past the parent, and the parent was the 36pt pill: the 44 was
   * arithmetic, not a target. Asserted on the real boxes: each `Pressable` and the group
   * itself are 44 tall, with no slop, and the pill is still drawn 36pt inside them.
   */
  it('gives each segment a real 44pt target, with the pill drawn inside it', async () => {
    const view = await render(<ViewModeToggle value="poster" onChange={() => {}} />);
    const group = styleOf(view.getByLabelText('View'));
    expect(group.height).toBe(theme.layout.minTapTarget);
    expect(group.overflow).toBeUndefined();
    for (const radio of view.getAllByRole('radio')) {
      const style = styleOf(radio);
      expect(style.width).toBe(theme.layout.minTapTarget);
      expect(style.height).toBe(theme.layout.minTapTarget);
      expect(radio.props.hitSlop).toBeUndefined();
      // The segment fills the cell inside its vertical inset: 36pt, as it was drawn.
      expect(theme.layout.minTapTarget - 2 * (style.paddingVertical as number)).toBe(36);
    }
    // The outline sits behind the cells, inset to the same 36pt (plus its own border).
    const frame = view.getByTestId('view-mode-frame');
    expect(frame.props.pointerEvents).toBe('none');
    const border = StyleSheet.hairlineWidth * 2;
    expect(styleOf(frame)).toMatchObject({
      position: 'absolute',
      top: theme.space[1] - border,
      bottom: theme.space[1] - border,
      borderWidth: border,
    });
  });
});

describe('BrowseControlsRow (B6)', () => {
  const draw = () =>
    render(
      <BrowseControlsRow
        testID="row"
        leading={<RNText numberOfLines={1}>A very long heading that must give way first</RNText>}
        trailing={
          <>
            <ViewModeToggle value="poster" onChange={() => {}} />
            <FilterIconButton activeCount={0} onPress={() => {}} accessibilityLabel="Filters" />
          </>
        }
      />,
    );

  it('never wraps: one row, the trailing group fixed, the leading side shrinking to nothing', async () => {
    const view = await draw();
    const row = StyleSheet.flatten(view.getByTestId('row').props.style);
    expect(row).toMatchObject({ flexDirection: 'row', flexWrap: 'nowrap' });
    expect(row.minHeight).toBe(theme.layout.minTapTarget);

    const leading = StyleSheet.flatten(view.getByTestId('row-leading').props.style);
    expect(leading).toMatchObject({ flexShrink: 1, minWidth: 0 });

    const trailing = StyleSheet.flatten(view.getByTestId('row-trailing').props.style);
    expect(trailing).toMatchObject({ flexShrink: 0, flexWrap: 'nowrap', flexDirection: 'row' });
  });

  it('fits its trailing controls at 320pt whatever the font scale', () => {
    // The trailing group is two 44pt segments, a gap and one 44pt icon: none of it scales
    // with text, so at fontScale 2 it is exactly as wide as at 1. What is left of a 320pt
    // row between the gutters is the leading side's, and it truncates inside it.
    const trailing = 2 * theme.layout.minTapTarget + theme.space[1] + theme.layout.minTapTarget;
    const inner = 320 - 2 * theme.layout.gutter;
    expect(inner - trailing - theme.space[2]).toBeGreaterThanOrEqual(theme.layout.minTapTarget * 2);
  });
});
