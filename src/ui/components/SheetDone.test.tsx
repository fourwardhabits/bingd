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

it('adds no bottom inset of its own, because the sheet already paid it', async () => {
  /**
   * The regression this replaces (founder, device QA, 2026-09-25): this footer used to
   * add `inset + space[3]` on top of the inset `Sheet` applies to the sheet body, so on
   * a phone reporting a 48pt navigation bar the band under one word measured about
   * 108pt. `Sheet` owns a sheet's bottom clearance; this owns none.
   */
  const view = await renderWithProviders(<SheetDone onPress={() => {}} />);

  const foot = StyleSheet.flatten(view.getByTestId('sheet-done').props.style);
  expect(foot.paddingBottom).toBeUndefined();
  // And it follows the content rather than being held apart from it: no spacer, no
  // `marginTop: 'auto'`, no reserved region.
  expect(foot.paddingTop).toBe(theme.space[2]);
  expect(foot.flex).toBeUndefined();
  expect(foot.marginTop).toBeUndefined();
});

it('sits against the right edge, where a way out belongs', async () => {
  const view = await renderWithProviders(<SheetDone onPress={() => {}} />);

  const foot = StyleSheet.flatten(view.getByTestId('sheet-done').props.style);
  expect(foot.alignItems).toBe('flex-end');
  expect(foot.paddingHorizontal).toBe(theme.layout.gutter);
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

it('is a real target rather than a word with slop around it', async () => {
  // Android clips touches outside a parent's box, so `hitSlop` on a text node is a
  // target that measures generously on iOS and taps at the glyph on Android.
  const view = await renderWithProviders(<SheetDone onPress={() => {}} />);

  const press = StyleSheet.flatten(view.getByLabelText('Done').props.style);
  expect(press.minHeight).toBe(theme.layout.minTapTarget);
  expect(press.minWidth).toBe(theme.layout.minTapTarget);
  // Not stretched: a right-aligned control whose target spans the sheet would swallow
  // taps meant for the content beside it.
  expect(press.alignSelf).toBeUndefined();
});

it('dismisses', async () => {
  const onPress = jest.fn();
  const view = await renderWithProviders(<SheetDone onPress={onPress} />);

  await fireEvent.press(view.getByLabelText('Done'));

  expect(onPress).toHaveBeenCalled();
});
