import { fireEvent, screen } from '@testing-library/react-native';
import { Dimensions, ScrollView, StyleSheet, Text as RNText } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { DismissFooter } from './DismissFooter';
import { Sheet } from './Sheet';

/**
 * The standard Close (founder spec §2B): text-only Maroon, centred, in its own white bar,
 * a 44pt target, safe-area aware, and outside any scroll region.
 */

const bar = () => StyleSheet.flatten(screen.getByTestId('dismiss-footer').props.style);
const press = () => StyleSheet.flatten(screen.getByTestId('dismiss-footer-press').props.style);

describe('DismissFooter', () => {
  it('reads Close in Maroon, centred, with Skip title’s type and spacing', async () => {
    await renderWithProviders(<DismissFooter onPress={() => {}} />);

    const label = StyleSheet.flatten(screen.getByText('Close').props.style);
    expect(label.color).toBe(theme.semantic.action);
    expect(label.fontSize).toBe(theme.typography.footnote.fontSize);
    expect(label.textAlign).toBe('center');
    expect(press().alignItems).toBe('center');
    expect(press().paddingVertical).toBe(theme.space[3]);
  });

  it('has no fill, outline or pill: only the bar it sits in', async () => {
    await renderWithProviders(<DismissFooter onPress={() => {}} />);

    expect(press().backgroundColor).toBeUndefined();
    expect(press().borderWidth).toBeUndefined();
    expect(press().borderRadius).toBeUndefined();
    // Its own white bar, divided from the content scrolling above it.
    expect(bar().backgroundColor).toBe(theme.surface.raised);
    expect(bar().borderTopWidth).toBeGreaterThan(0);
  });

  it('keeps a 44pt target across the bar despite the quiet ink', async () => {
    await renderWithProviders(<DismissFooter onPress={() => {}} />);

    expect(press().minHeight).toBeGreaterThanOrEqual(theme.layout.minTapTarget);
    expect(press().alignSelf).toBeUndefined();
    expect(press().width).toBeUndefined();
  });

  it('is a button that dismisses, and takes another word', async () => {
    const onPress = jest.fn();
    await renderWithProviders(<DismissFooter onPress={onPress} label="Not now" />);

    await fireEvent.press(screen.getByRole('button', { name: 'Not now' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('pays the bottom inset itself at the foot of a screen', async () => {
    await renderWithProviders(<DismissFooter onPress={() => {}} />, { bottomInset: 34 });
    expect(bar().paddingBottom).toBe(34);
  });

  it('pays nothing where the device reports no inset', async () => {
    await renderWithProviders(<DismissFooter onPress={() => {}} />, { bottomInset: 0 });
    expect(bar().paddingBottom).toBeUndefined();
  });

  it('pays nothing inside a sheet, which has already paid it', async () => {
    await renderWithProviders(
      <Sheet visible onClose={() => {}} label="A sheet" footer={<DismissFooter onPress={() => {}} />}>
        <RNText>Body</RNText>
      </Sheet>,
      { bottomInset: 34 },
    );

    expect(bar().paddingBottom).toBeUndefined();
    // The sheet pays it once, under the footer, with no gutter on top of the footer's own.
    const body = StyleSheet.flatten(screen.getByTestId('sheet-body').props.style);
    expect(body.paddingBottom).toBe(34);
  });
});

/**
 * **The last row is reachable** — the defect that started this: a list capped at a fixed
 * height inside a sheet, with a footer that took the room the list needed.
 */
describe('in a sheet, under a long list', () => {
  const LONG = Array.from({ length: 120 }, (_, n) => `Row ${n + 1}`);

  const draw = (density?: 'dense' | 'short') =>
    renderWithProviders(
      <Sheet
        visible
        onClose={() => {}}
        label="A long list"
        density={density}
        footer={<DismissFooter onPress={() => {}} />}
      >
        <ScrollView testID="long-list" style={{ flexShrink: 1 }}>
          {LONG.map((row) => (
            <RNText key={row}>{row}</RNText>
          ))}
        </ScrollView>
      </Sheet>,
    );

  it('renders every row, the last one included, inside the scroll view', async () => {
    await draw();
    const list = screen.getByTestId('long-list');
    expect(screen.getByText('Row 120')).toBeTruthy();
    // The last row's nearest scroll ancestor is the list — it scrolls into view.
    let node = screen.getByText('Row 120').parent;
    while (node && node !== list) node = node.parent;
    expect(node).toBe(list);
  });

  it('keeps the footer outside the scroll view, after the content', async () => {
    await draw();
    const list = screen.getByTestId('long-list');
    const footer = screen.getByTestId('dismiss-footer');

    let node = footer.parent;
    while (node) {
      expect(node).not.toBe(list);
      node = node.parent;
    }
    const body = screen.getByTestId('sheet-body');
    const order = (body.children as { props?: { testID?: string } }[]).map((c) => c.props?.testID);
    expect(order.indexOf('sheet-footer')).toBeGreaterThan(order.indexOf('sheet-content'));
  });

  it('lets the content area shrink to the room left, so nothing finishes under the footer', async () => {
    await draw();
    const content = StyleSheet.flatten(screen.getByTestId('sheet-content').props.style);
    expect(content.flexShrink).toBe(1);
    expect(content.minHeight).toBe(0);
    expect(content.maxHeight).toBeUndefined();
  });

  it('gives a dense list the standard sheet height, and the list all of it', async () => {
    await draw('dense');
    const body = StyleSheet.flatten(screen.getByTestId('sheet-body').props.style);
    const content = StyleSheet.flatten(screen.getByTestId('sheet-content').props.style);
    // `dense` is an alias of `size="standard"` since FU1113-B: 80% of the window below the
    // top inset (47, `renderWithProviders`' iPhone), in points rather than 90%.
    expect(body.height).toBe(Math.round(0.8 * (Dimensions.get('window').height - 47)));
    expect(content.flex).toBe(1);
  });
});
