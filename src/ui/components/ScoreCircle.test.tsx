import { fireEvent, within } from '@testing-library/react-native';
import { PixelRatio, StyleSheet } from 'react-native';

import { renderWithProviders as render } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { ScoreCircle } from './ScoreCircle';

/** The drawn circle: `ScoreBadge` carries the spoken value on the circle's own view. */
const circleOf = (view: Awaited<ReturnType<typeof render>>, value: string) =>
  StyleSheet.flatten(view.getByLabelText(`${value} out of 10`).props.style);

afterEach(() => jest.restoreAllMocks());

describe('ScoreCircle (FU1113-B)', () => {
  it('filled: a Maroon disc with light numerals', async () => {
    const view = await render(<ScoreCircle score={9.2} variant="filled" label="Your score" />);
    const circle = circleOf(view, '9.2');
    expect(circle.backgroundColor).toBe(theme.semantic.score);
    expect(StyleSheet.flatten(view.getByText('9.2').props.style).color).toBe(theme.semantic.scoreInk);
    expect(view.getByText('Your score')).toBeTruthy();
  });

  it('outlined: a 2pt Maroon ring with Maroon numerals and no fill', async () => {
    const view = await render(<ScoreCircle score={8.7} variant="outlined" label="Season Average" />);
    const circle = circleOf(view, '8.7');
    expect(circle.backgroundColor).toBeUndefined();
    expect(circle.borderWidth).toBe(2);
    expect(circle.borderColor).toBe(theme.semantic.score);
    expect(StyleSheet.flatten(view.getByText('8.7').props.style).color).toBe(theme.semantic.score);
  });

  it('puts nothing but the number in the circle', async () => {
    const view = await render(<ScoreCircle score={8.7} variant="outlined" label="Season Average" />);
    const circle = within(view.getByLabelText('8.7 out of 10'));
    expect(circle.getByText('8.7')).toBeTruthy();
    expect(circle.queryByText(/AVG|Season/)).toBeNull();
  });

  it.each([1, 2])('stays a circle (width == height) at font scale %i, in either layout', async (scale) => {
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(scale);
    for (const layout of ['column', 'row'] as const) {
      const view = await render(
        <ScoreCircle score={10} variant="filled" label="Your score" layout={layout} testID="unit" />,
      );
      const circle = circleOf(view, '10.0');
      expect(circle.width).toBe(circle.height);
      expect(circle.borderRadius).toBe(theme.radius.full);
      // The slot is the circle's size and may not shrink, so no row can squeeze it oval.
      const slot = StyleSheet.flatten(view.getByTestId('unit-circle-slot').props.style);
      expect(slot.width).toBe(circle.width);
      expect(slot.height).toBe(circle.height);
      expect(slot.flexShrink).toBe(0);
      await view.unmount();
    }
  });

  it('one diameter for every variant', async () => {
    const view = await render(
      <>
        <ScoreCircle score={9} variant="filled" label="A" />
        <ScoreCircle score={8} variant="outlined" label="B" />
      </>,
    );
    expect(circleOf(view, '9.0').width).toBe(circleOf(view, '8.0').width);
  });

  it('draws the existing placeholder, a dash, for null — never an empty circle', async () => {
    const view = await render(<ScoreCircle score={null} variant="outlined" label="bingd" count={0} />);
    expect(view.getByText('—')).toBeTruthy();
    expect(view.queryByLabelText(/out of 10/)).toBeNull();
    expect(view.getByLabelText('bingd. No score yet')).toBeTruthy();
  });

  it('says it is loading when it is', async () => {
    const view = await render(<ScoreCircle score={null} variant="filled" label="Your score" loading />);
    expect(view.getByLabelText('Your score. Score loading')).toBeTruthy();
  });

  it('prints a count after its label, and an optional caption', async () => {
    const view = await render(
      <ScoreCircle score={8} variant="outlined" label="bingd" count={4} caption="Quiet" testID="u" />,
    );
    expect(view.getByText(' (4)')).toBeTruthy();
    expect(view.getByTestId('u-caption')).toHaveTextContent('Quiet');
  });

  it('is a button when pressable, with the given name', async () => {
    const onPress = jest.fn();
    const view = await render(
      <ScoreCircle
        score={9}
        variant="filled"
        label="Your score"
        onPress={onPress}
        accessibilityLabel="Your score. 9.0 out of 10"
      />,
    );
    await fireEvent.press(view.getByRole('button', { name: 'Your score. 9.0 out of 10' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
