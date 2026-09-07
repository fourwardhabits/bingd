import { fireEvent } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { collapse, COLLAPSED_LINES, Synopsis } from './Synopsis';

/**
 * The four-line contract, from both ends.
 *
 * The arithmetic is tested directly, because that is where the decision is made and a
 * table of line widths says more about it than any render can. The component is then
 * driven through the two events it actually depends on — `onLayout` for the column width
 * and `onTextLayout` for the lines — which is the only way to exercise a measured layout
 * in a runner that lays nothing out.
 *
 * There is deliberately no snapshot. The whole point of the component is that the answer
 * depends on the width and the text size of the device it is on, so a fixture of one
 * rendered tree would assert the opposite of the property being claimed.
 */

/** A line as `onTextLayout` reports one: the text on it, and how wide that set. */
const line = (text: string, width: number) => ({ text, width });

describe('the collapse arithmetic', () => {
  it('collapses nothing while the measurement is still missing', () => {
    // Any one of the three absent means there is no honest fourth line to trim, and the
    // component draws the plain clamp instead. This is the state of the first frame.
    expect(collapse({ lines: null, markerWidth: 30, available: 300 })).toBeNull();
    expect(collapse({ lines: [line('a', 10)], markerWidth: null, available: 300 })).toBeNull();
    expect(collapse({ lines: [line('a', 10)], markerWidth: 30, available: null })).toBeNull();
  });

  it('collapses nothing when the whole synopsis already fits', () => {
    const lines = Array.from({ length: COLLAPSED_LINES }, (_, index) =>
      line(`line ${index} `, 280),
    );

    // Exactly four is still a fit. The marker exists to promise more text, and there is
    // none — so it must not be drawn, at four lines or at one.
    expect(collapse({ lines, markerWidth: 30, available: 300 })).toBeNull();
    expect(collapse({ lines: lines.slice(0, 1), markerWidth: 30, available: 300 })).toBeNull();
  });

  it('keeps the whole fourth line when the marker already fits beside it', () => {
    const lines = [
      line('one ', 300),
      line('two ', 300),
      line('three ', 300),
      line('four ', 100),
      line('five', 100),
    ];

    // 100 + 30 is well inside 300, so nothing is given up: the reader gets every word the
    // fourth line held, and the marker sets after it.
    expect(collapse({ lines, markerWidth: 30, available: 300 })?.prose).toBe(
      'one two three four',
    );
  });

  it('trims the fourth line back to a word boundary to make room', () => {
    // Ten characters across 300 points, so each is 30 wide. A 90-point budget buys three
    // characters, and the last space inside those three is where the cut lands.
    const lines = [
      line('a ', 60),
      line('b ', 60),
      line('c ', 60),
      line('xy zzzzzzzz', 330),
      line('tail', 60),
    ];

    const result = collapse({ lines, markerWidth: 210, available: 300 });

    // Never mid-word: `xy` survives whole and `zzzzzzzz` is dropped entirely, rather than
    // leaving `xy zz … more`, which reads as a rendering fault rather than an invitation.
    expect(result?.prose).toBe('a b c xy');
  });

  it('leaves no trailing space for the marker to sit after', () => {
    const lines = [
      line('one ', 100),
      line('two ', 100),
      line('three ', 100),
      line('four   ', 100),
      line('five', 100),
    ];

    // The marker carries its own leading space, so a trailing one here would double the
    // gap in front of it.
    expect(collapse({ lines, markerWidth: 20, available: 300 })?.prose).toBe(
      'one two three four',
    );
  });

  it('keeps at least the head when a single word fills the whole fourth line', () => {
    const lines = [
      line('one ', 100),
      line('two ', 100),
      line('three ', 100),
      line('antidisestablishmentarianism', 300),
      line('more text', 100),
    ];

    // No space to cut at, so the whole word goes. The three lines above it are still
    // three lines of synopsis, and the clamp guarantees the marker cannot spill.
    expect(collapse({ lines, markerWidth: 290, available: 300 })?.prose).toBe('one two three');
  });
});

describe('the rendered synopsis', () => {
  /**
   * Drives the two measurements the component waits for, in the order a device would.
   *
   * `includeHiddenElements` because the measuring layer is deliberately hidden from
   * assistive technology — the synopsis must not be announced three times — and that is
   * exactly what this library excludes from a query by default. Reaching it here is the
   * test standing in for a layout engine, not a caller reaching past a boundary.
   */
  const hidden = { includeHiddenElements: true } as const;
  const measure = async (
    view: Awaited<ReturnType<typeof renderWithProviders>>,
    lines: { text: string; width: number }[],
    { markerWidth = 30, available = 300 }: { markerWidth?: number; available?: number } = {},
  ) => {
    await fireEvent(view.getByTestId('synopsis-measure', hidden), 'textLayout', {
      nativeEvent: { lines },
    });
    await fireEvent(view.getByTestId('synopsis-marker-measure', hidden), 'textLayout', {
      nativeEvent: { lines: [{ text: ' … more', width: markerWidth }] },
    });
    await fireEvent(view.getByTestId('synopsis-column'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: available, height: 80 } },
    });
  };

  it('draws the whole text and no marker while nothing has been measured', async () => {
    const view = await renderWithProviders(<Synopsis text="A short synopsis." />);

    // The honest unmeasured state: the full text under a plain four-line clamp. It is
    // never wrong, only less inviting, and the block is still the press target.
    expect(view.queryByTestId('synopsis-more')).toBeNull();
    expect(view.getAllByText('A short synopsis.').length).toBeGreaterThan(0);
  });

  it('shows no marker for a synopsis that fits inside four lines', async () => {
    const view = await renderWithProviders(<Synopsis text="one two three four" />);

    await measure(view, [
      { text: 'one ', width: 60 },
      { text: 'two ', width: 60 },
      { text: 'three ', width: 60 },
      { text: 'four', width: 60 },
    ]);

    expect(view.queryByTestId('synopsis-more')).toBeNull();
  });

  it('puts the marker inline on the fourth line of a long synopsis', async () => {
    const view = await renderWithProviders(
      <Synopsis text="one two three four five six seven" />,
    );

    await measure(view, [
      { text: 'one ', width: 60 },
      { text: 'two ', width: 60 },
      { text: 'three ', width: 60 },
      { text: 'four ', width: 60 },
      { text: 'five six seven', width: 200 },
    ]);

    // The marker exists, and the prose stops where the measurement said it should — the
    // fifth line's words are not in the collapsed state at all.
    expect(view.getByTestId('synopsis-more')).toBeTruthy();
    expect(view.queryByText(/seven/)).toBeNull();
  });

  it('opens to the whole text, and the marker goes with the clamp', async () => {
    const view = await renderWithProviders(
      <Synopsis text="one two three four five six seven" />,
    );

    await measure(view, [
      { text: 'one ', width: 60 },
      { text: 'two ', width: 60 },
      { text: 'three ', width: 60 },
      { text: 'four ', width: 60 },
      { text: 'five six seven', width: 200 },
    ]);

    await fireEvent.press(view.getByLabelText('Expand description'));

    // No "less": once it is open the whole thing is visible and the control has nothing
    // left to promise. Pressing again still closes it — the affordance is gone, not the
    // behaviour.
    expect(view.queryByTestId('synopsis-more')).toBeNull();
    expect(view.getByLabelText('Collapse description')).toBeTruthy();
  });
});
