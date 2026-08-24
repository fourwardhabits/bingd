import { fireEvent, render, screen } from '@testing-library/react-native';

import { theme } from '../tokens';
import { BucketChoices } from './BucketChip';

/**
 * The control that asks "How was it?", pinned.
 *
 * It is one component because it used to be two. `LogSheet` kept the row in its own
 * stylesheet; the onboarding sheet mapped the three chips into a container that had a
 * gap and no direction, and a chip written with `flex: 1` for a row resolves to zero
 * height in a column of automatic height. The founder's screenshot is what that looks
 * like: circles collapsed onto one another, labels floating over the circle below.
 *
 * So these assertions are about layout, which is unusual in this suite and deliberate.
 * A test that only counts three buttons passes on the broken build.
 */

/** A style prop, flattened, whichever form the component passed it in. */
const flatten = (style: unknown) =>
  (Array.isArray(style) ? Object.assign({}, ...style) : (style ?? {})) as Record<string, unknown>;

const row = () => flatten(screen.getByTestId('choices').props.style);
const chips = () => screen.getAllByRole('radio');

const draw = (props: Partial<React.ComponentProps<typeof BucketChoices>> = {}) =>
  render(<BucketChoices selected={null} onSelect={() => {}} testID="choices" {...props} />);

describe('the three choices', () => {
  it('offers exactly the three buckets, in the words the product uses', async () => {
    await draw();

    // Curly apostrophe: the label comes from `BUCKET_LABEL`, and a straight one here
    // would be a second spelling of the same sentence.
    expect(chips().map((chip) => chip.props.accessibilityLabel)).toEqual([
      'I liked it',
      'It was fine',
      'I didn’t like it',
    ]);
  });

  it('lays them out as a row rather than a stack', async () => {
    // The regression itself. A column here is the founder's screenshot.
    await draw();

    expect(row().flexDirection).toBe('row');
  });

  it('gives each choice an equal column, so a circle sits over its own label', async () => {
    await draw();

    for (const chip of chips()) {
      const style = flatten(chip.props.style);
      expect(style.flex).toBe(1);
      expect(style.alignItems).toBe('center');
      // Nothing is positioned out of flow. An absolute chip is the other way a row
      // becomes a pile.
      expect(style.position).toBeUndefined();
    }
  });

  it('keeps every choice on a tappable target', async () => {
    await draw();

    for (const chip of chips()) {
      expect(flatten(chip.props.style).minHeight).toBe(44);
    }
  });

  it('leaves a usable column at the narrowest width the app supports', async () => {
    // Arithmetic, not geometry: this library has no layout engine, so what is pinned
    // here is the input to the layout rather than its output. 320pt less the two
    // gutters the host sheet adds, less two gaps, over three columns.
    const column = (320 - theme.layout.gutter * 2 - theme.space[3] * 2) / 3;

    // Wide enough for the 44pt circle with room either side. If a future token change
    // takes it below that, the circles start touching before anybody opens a simulator.
    expect(column).toBeGreaterThanOrEqual(theme.layout.minTapTarget + theme.space[3]);
  });

  it('lets a long label wrap rather than clipping or breaking the row', async () => {
    await draw();

    // 88pt is not enough for "I didn't like it" on one line at any text size, so
    // wrapping is the intended answer rather than a failure. Two things have to hold
    // for it: the row must not wrap its own columns onto a second line, and the label
    // must not clamp itself to one.
    expect(row().flexWrap).toBeUndefined();
    for (const chip of chips()) {
      expect(chip.props.children[1].props.numberOfLines).toBeUndefined();
    }
  });

  it('announces itself as one group of radios', async () => {
    await draw();

    expect(screen.getByTestId('choices').props.accessibilityRole).toBe('radiogroup');
    expect(chips()).toHaveLength(3);
  });

  it('marks the chosen one, and only that one', async () => {
    await draw({ selected: 'fine' });

    expect(chips().map((chip) => chip.props.accessibilityState.selected)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('marks nothing when nothing is chosen', async () => {
    await draw();

    expect(chips().map((chip) => chip.props.accessibilityState.selected)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('reports the id the writers store, not the words on screen', async () => {
    const onSelect = jest.fn();
    await draw({ onSelect });

    await fireEvent.press(screen.getByLabelText('I liked it'));
    await fireEvent.press(screen.getByLabelText('It was fine'));
    await fireEvent.press(screen.getByLabelText('I didn’t like it'));

    // `notForMe` is the chip's camelCase; the write maps it to the stored
    // `not_for_me`. Both halves of that are asserted where each happens.
    expect(onSelect.mock.calls.map(([bucket]) => bucket)).toEqual(['loved', 'fine', 'notForMe']);
  });
});
