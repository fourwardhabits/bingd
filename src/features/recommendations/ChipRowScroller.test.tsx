import { fireEvent, render } from '@testing-library/react-native';
import { Text } from 'react-native';

import { ChipRowScroller } from './ChipRowScroller';

/** The cue is hidden from screen readers, so queries must be told to look at it anyway. */
const HIDDEN = { includeHiddenElements: true };

/**
 * The cue that For You's chip row has more past the right edge (Visual 2.1 check,
 * 2026-11-03): at 130% on a 320pt phone, Filters sat wholly off-screen with nothing to say
 * it was there.
 */
const renderRow = () =>
  render(
    <ChipRowScroller testID="row">
      <Text>Sent to You</Text>
      <Text>Group Picks</Text>
      <Text>Filters</Text>
    </ChipRowScroller>,
  );

const measure = async (view: Awaited<ReturnType<typeof renderRow>>, viewport: number, content: number) => {
  const row = view.getByTestId('row');
  await fireEvent(row, 'layout', { nativeEvent: { layout: { width: viewport, height: 60, x: 0, y: 0 } } });
  await fireEvent(row, 'contentSizeChange', content, 60);
};

const scrollTo = async (view: Awaited<ReturnType<typeof renderRow>>, x: number) => {
  await fireEvent.scroll(view.getByTestId('row'), { nativeEvent: { contentOffset: { x, y: 0 } } });
};

describe('the more-to-the-right cue', () => {
  it('is drawn while anything lies past the edge', async () => {
    const view = await renderRow();
    await measure(view, 320, 420);

    const cue = view.getByTestId('row-more', HIDDEN);
    // Decoration only: it takes no touches and is not read out.
    expect(cue.props.pointerEvents).toBe('none');
    expect(cue.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(cue.props.accessibilityElementsHidden).toBe(true);
  });

  it('goes once the row is scrolled to its end, and comes back on the way back', async () => {
    const view = await renderRow();
    await measure(view, 320, 420);

    await scrollTo(view, 100);
    expect(view.queryByTestId('row-more', HIDDEN)).toBeNull();

    await scrollTo(view, 40);
    expect(view.getByTestId('row-more', HIDDEN)).toBeTruthy();
  });

  it('is never drawn when the chips fit, or before the row has been measured', async () => {
    const unmeasured = await renderRow();
    expect(unmeasured.queryByTestId('row-more', HIDDEN)).toBeNull();

    const fitting = await renderRow();
    await measure(fitting, 390, 330);
    expect(fitting.queryByTestId('row-more', HIDDEN)).toBeNull();
  });

  it('keeps every chip in the row, on screen or not', async () => {
    const view = await renderRow();
    await measure(view, 320, 420);

    for (const chip of ['Sent to You', 'Group Picks', 'Filters']) {
      expect(view.getByText(chip)).toBeTruthy();
    }
  });
});
