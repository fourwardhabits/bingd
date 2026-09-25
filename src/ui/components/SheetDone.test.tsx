import { fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { SheetDone } from './SheetDone';

/**
 * **The way out of a utility sheet**, and the three founder verdicts it has survived.
 *
 *   1. A filled Maroon `Button` made the least consequential control on the screen the
 *      loudest thing on it. Where to watch and bingd Awards also put theirs within a
 *      thumb's width of the Android Back control, and the grouped-ranking sheet had none.
 *   2. Bare maroon words fixed the emphasis and read as **detached** — no container, no
 *      edge, nothing to say how much of it may be pressed.
 *   3. So: `MiniButton`, centred, and no inset of its own.
 *
 * The spacing half is asserted here because it was invisible to every other test: this
 * footer used to add `inset + space[3]` on top of the inset `Sheet` already applies, and on
 * a 48pt navigation bar the band under one word measured about 108pt.
 */

it('adds no bottom inset of its own, because the sheet already paid it', async () => {
  const view = await renderWithProviders(<SheetDone onPress={() => {}} />);

  const foot = StyleSheet.flatten(view.getByTestId('sheet-done').props.style);
  expect(foot.paddingBottom).toBeUndefined();
  // And it follows the content rather than being held apart from it: no spacer, no
  // `marginTop: 'auto'`, no reserved region.
  expect(foot.paddingTop).toBe(theme.space[3]);
  expect(foot.flex).toBeUndefined();
  expect(foot.marginTop).toBeUndefined();
  expect(foot.paddingHorizontal).toBe(theme.layout.gutter);
});

it('is a small button with an edge, not bare words', async () => {
  // The founder's verdict on version 2: maroon text with no container looked detached.
  const view = await renderWithProviders(<SheetDone onPress={() => {}} />);

  const press = StyleSheet.flatten(view.getByLabelText('Done').props.style);
  expect(press.borderWidth).toBeGreaterThan(0);
  expect(press.borderRadius).toBe(theme.radius.control);
  expect(press.backgroundColor).toBe(theme.surface.raised);
});

it('is not a filled primary action', async () => {
  const view = await renderWithProviders(<SheetDone onPress={() => {}} />);

  type Node = { props?: Record<string, unknown>; children?: unknown[] } | string | null;
  const styles: Record<string, unknown>[] = [];
  const walk = (node: Node) => {
    if (!node || typeof node === 'string') return;
    styles.push((StyleSheet.flatten(node.props?.style) ?? {}) as Record<string, unknown>);
    for (const child of node.children ?? []) walk(child as Node);
  };
  walk(view.toJSON() as Node);

  // No Maroon fill anywhere in it: the emphasis is the ink, which is what makes it
  // comparable to "New list" rather than to a primary action.
  expect(styles.some((s) => s.backgroundColor === theme.semantic.action)).toBe(false);
});

it('shrinks to its label and sits centred', async () => {
  const view = await renderWithProviders(<SheetDone onPress={() => {}} />);

  const press = StyleSheet.flatten(view.getByLabelText('Done').props.style);
  // A `stretch`, a width or a flex here is a full-width control, which this is not.
  expect(press.alignSelf).toBeUndefined();
  expect(press.width).toBeUndefined();
  expect(press.flex).toBeUndefined();
  expect(press.paddingHorizontal).toBe(theme.space[5]);

  // `alignItems` on the row, so the row shrink-wraps the button rather than stretching it.
  const row = StyleSheet.flatten(view.getByLabelText('Done').parent?.props.style);
  expect(row.alignItems).toBe('center');
});

it('meets the accessible tap height on the control itself', async () => {
  // Android clips touches outside a parent's box, so a padded parent is not a target.
  const view = await renderWithProviders(<SheetDone onPress={() => {}} />);

  const press = StyleSheet.flatten(view.getByLabelText('Done').props.style);
  expect(press.minHeight).toBe(theme.layout.minTapTarget);
});

it('dismisses', async () => {
  const onPress = jest.fn();
  const view = await renderWithProviders(<SheetDone onPress={onPress} />);

  await fireEvent.press(view.getByLabelText('Done'));

  expect(onPress).toHaveBeenCalled();
});
