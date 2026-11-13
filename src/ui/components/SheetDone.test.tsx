import { fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { SheetDone } from './SheetDone';

/**
 * **The way out of a utility sheet**, which is the standard `DismissFooter` since the
 * founder's 2026-11-13 spec (§2B): text-only Maroon `Close`, centred, in its own white
 * bar, a 44pt target — and still no bottom inset of its own inside a sheet, because the
 * doubled inset is what once held a 108pt band open under one word.
 */

it('reads Close by default: these sheets are dismiss-only', async () => {
  const view = await renderWithProviders(<SheetDone onPress={() => {}} />);
  expect(view.getByRole('button', { name: 'Close' })).toBeTruthy();
});

it('is quiet Maroon words, not a filled primary action or a pill', async () => {
  const view = await renderWithProviders(<SheetDone onPress={() => {}} />);

  type Node = { props?: Record<string, unknown>; children?: unknown[] } | string | null;
  const styles: Record<string, unknown>[] = [];
  const walk = (node: Node) => {
    if (!node || typeof node === 'string') return;
    styles.push((StyleSheet.flatten(node.props?.style) ?? {}) as Record<string, unknown>);
    for (const child of node.children ?? []) walk(child as Node);
  };
  walk(view.toJSON() as Node);

  expect(styles.some((s) => s.backgroundColor === theme.semantic.action)).toBe(false);
  expect(styles.some((s) => s.borderRadius === theme.radius.control)).toBe(false);
  expect(StyleSheet.flatten(view.getByText('Close').props.style).color).toBe(
    theme.semantic.action,
  );
});

it('meets the accessible tap height on the control itself', async () => {
  const view = await renderWithProviders(<SheetDone onPress={() => {}} />);

  const press = StyleSheet.flatten(view.getByRole('button', { name: 'Close' }).props.style);
  expect(press.minHeight).toBe(theme.layout.minTapTarget);
});

it('keeps an overridden word', async () => {
  const view = await renderWithProviders(<SheetDone onPress={() => {}} label="Done" />);
  expect(view.getByRole('button', { name: 'Done' })).toBeTruthy();
});

it('dismisses', async () => {
  const onPress = jest.fn();
  const view = await renderWithProviders(<SheetDone onPress={onPress} />);

  await fireEvent.press(view.getByRole('button', { name: 'Close' }));

  expect(onPress).toHaveBeenCalled();
});
