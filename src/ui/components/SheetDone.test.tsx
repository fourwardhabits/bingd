import { fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { SheetDone } from './SheetDone';

/**
 * **The way out of a utility sheet** (founder, device QA, 2026-09-25).
 *
 * Two findings produced this component and both are asserted here, because both were
 * invisible to every existing test: Where to watch and bingd Awards put their Done within
 * a thumb's width of the Android system Back control, and the grouped-ranking sheet had no
 * Done at all.
 *
 * The emphasis half matters as much as the spacing half. These sheets are statements, not
 * decisions, and a filled Maroon `Button` made the least consequential control on the
 * screen the loudest thing on it.
 */

it('clears the system navigation, with ordinary spacing on top of the inset', async () => {
  const view = await renderWithProviders(<SheetDone onPress={() => {}} />);

  const foot = StyleSheet.flatten(view.getByLabelText('Done').parent?.props.style);
  // The harness renders a 34pt bottom inset (its `METRICS`), so this is inset + space[3]
  // rather than either alone. An inset by itself leaves the words against the bar on a
  // gesture-navigation device, where it is small.
  expect(foot.paddingBottom).toBe(34 + theme.space[3]);
});

it('is words rather than a filled button', async () => {
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

it('is a full-width target rather than a word with slop around it', async () => {
  // Android clips touches outside a parent's box, so `hitSlop` on a text node is a
  // target that measures generously on iOS and taps at the glyph on Android.
  const view = await renderWithProviders(<SheetDone onPress={() => {}} />);

  const press = StyleSheet.flatten(view.getByLabelText('Done').props.style);
  expect(press.minHeight).toBe(theme.layout.minTapTarget);
  expect(press.alignSelf).toBe('stretch');
});

it('dismisses', async () => {
  const onPress = jest.fn();
  const view = await renderWithProviders(<SheetDone onPress={onPress} />);

  await fireEvent.press(view.getByLabelText('Done'));

  expect(onPress).toHaveBeenCalled();
});
