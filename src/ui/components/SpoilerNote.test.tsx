import { fireEvent } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { SpoilerNote } from './SpoilerNote';

/**
 * **The note says there is more to read** (founder, physical iOS 1.0.1 build 8).
 *
 * A long note in the Feed truncated and expanded on a tap, and said neither. What is
 * asserted here is the affordance the title page's synopsis already had, on the
 * component every social surface renders a note through: `… more` on the last visible
 * line, never on a line of its own, never after half a word, and gone once the note is
 * open.
 *
 * The trimming arithmetic itself is `ClampedText`'s and is asserted against a table of
 * measured line widths in `Synopsis.test.tsx` — including the narrow-screen and large
 * text size cases, which in points are the same question asked twice. This file is about
 * what a reader of a note actually gets.
 */

/**
 * Drives the two measurements the block waits for, in the order a device would.
 *
 * `includeHiddenElements` because the measuring layer is deliberately hidden from
 * assistive technology — a note must not be announced three times — and that is exactly
 * what this library excludes from a query by default. Reaching it here is the test
 * standing in for a layout engine.
 */
const hidden = { includeHiddenElements: true } as const;

const measure = async (
  view: Awaited<ReturnType<typeof renderWithProviders>>,
  lines: { text: string; width: number }[],
  { markerWidth = 30, available = 300 }: { markerWidth?: number; available?: number } = {},
) => {
  await fireEvent(view.getByTestId('note-measure', hidden), 'textLayout', {
    nativeEvent: { lines },
  });
  await fireEvent(view.getByTestId('note-marker-measure', hidden), 'textLayout', {
    nativeEvent: { lines: [{ text: ' … more', width: markerWidth }] },
  });
  await fireEvent(view.getByTestId('note-column'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: available, height: 60 } },
  });
};

describe('a clamped note', () => {
  it('draws the whole text and no marker before anything is measured', async () => {
    const view = await renderWithProviders(
      <SpoilerNote text="Short enough." masked={false} numberOfLines={2} />,
    );

    // The honest unmeasured state: React Native's own clamp, no marker, and the block
    // is already the press target.
    expect(view.queryByTestId('note-more')).toBeNull();
    expect(view.getAllByText('Short enough.').length).toBeGreaterThan(0);
  });

  it('offers no marker for a note that already fits its clamp', async () => {
    const view = await renderWithProviders(
      <SpoilerNote text="one two" masked={false} numberOfLines={2} />,
    );

    await measure(view, [
      { text: 'one ', width: 60 },
      { text: 'two', width: 60 },
    ]);

    expect(view.queryByTestId('note-more')).toBeNull();
  });

  it('offers no marker at exactly the clamp, which is still a fit', async () => {
    const view = await renderWithProviders(
      <SpoilerNote text="one two three four five six" masked={false} numberOfLines={3} />,
    );

    await measure(view, [
      { text: 'one two ', width: 200 },
      { text: 'three four ', width: 200 },
      { text: 'five six', width: 200 },
    ]);

    // The marker exists to promise more text, and there is none. Three of three is a
    // whole note, not a truncated one.
    expect(view.queryByTestId('note-more')).toBeNull();
  });

  it('puts the marker inline on the last visible line of a long note', async () => {
    const view = await renderWithProviders(
      <SpoilerNote text="one two three four five" masked={false} numberOfLines={2} />,
    );

    await measure(view, [
      { text: 'one ', width: 60 },
      { text: 'two ', width: 60 },
      { text: 'three four five', width: 200 },
    ]);

    expect(view.getByTestId('note-more')).toBeTruthy();
    // Not a line of its own: the marker is a span inside the clamped text, so the words
    // beyond the clamp are not in the collapsed tree at all.
    expect(view.queryByText(/five/)).toBeNull();
  });

  it('never leaves a dangling ellipsis or half a word in front of the marker', async () => {
    const view = await renderWithProviders(
      <SpoilerNote
        text="alpha beta gamma delta epsilon"
        masked={false}
        numberOfLines={2}
      />,
    );

    // Ten characters over 300 points, so the second line has to give the marker room
    // back and can only do it by dropping a whole word.
    await measure(
      view,
      [
        { text: 'alpha ', width: 60 },
        { text: 'beta gamma', width: 300 },
        { text: 'delta epsilon', width: 200 },
      ],
      { markerWidth: 210 },
    );

    // The second line can only buy the marker its room by giving up `gamma` whole:
    // a three-character budget lands inside that word, and half a word in front of
    // `… more` reads as a rendering fault rather than as an invitation.
    expect(view.getByText('alpha … more')).toBeTruthy();
    expect(view.queryByText(/gam/)).toBeNull();
  });

  it('opens to the whole note, and the marker goes with the clamp', async () => {
    const view = await renderWithProviders(
      <SpoilerNote text="one two three four five" masked={false} numberOfLines={2} />,
    );

    await measure(view, [
      { text: 'one ', width: 60 },
      { text: 'two ', width: 60 },
      { text: 'three four five', width: 200 },
    ]);

    await fireEvent.press(view.getByLabelText('Show the whole review'));

    // The affordance is not duplicated once it has been used, and it does not become a
    // "less" either: an open note in a list must not be able to change height under a
    // thumb reading the row below it.
    expect(view.queryByTestId('note-more')).toBeNull();
    expect(view.queryByLabelText('Show the whole review')).toBeNull();
    expect(view.getByText(/five/)).toBeTruthy();
  });

  it('names the kind of writing it is opening', async () => {
    const view = await renderWithProviders(
      <SpoilerNote text="one two three" masked={false} numberOfLines={1} noun="comment" />,
    );

    expect(view.getByLabelText('Show the whole comment')).toBeTruthy();
  });

  it('leaves an unclamped note alone: whole text, no control', async () => {
    const view = await renderWithProviders(
      <SpoilerNote text="Every word of it." masked={false} />,
    );

    expect(view.getByText('Every word of it.')).toBeTruthy();
    expect(view.queryByTestId('note-more')).toBeNull();
    expect(view.queryByLabelText(/Show the whole/)).toBeNull();
  });

  it('renders nothing of a masked note, marker included', async () => {
    const view = await renderWithProviders(
      <SpoilerNote text="He dies at the end." masked numberOfLines={2} hasSpoilers />,
    );

    // The spoiler rule is untouched by any of this: a masked note is not clipped, it is
    // absent, so there is nothing for a marker to be attached to either.
    expect(view.queryByText(/dies/)).toBeNull();
    expect(view.queryByTestId('note-more')).toBeNull();
    expect(view.getByText('Contains spoilers')).toBeTruthy();
  });
});
