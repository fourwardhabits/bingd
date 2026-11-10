import { act, fireEvent, render } from '@testing-library/react-native';
import { useWindowDimensions } from 'react-native';

import { theme } from '../tokens';
import { estimateTextWidth, fitSummaryForm, ReactionSummary } from './ReactionSummary';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions');

/**
 * The reaction line chooses its sentence by the room it is given (founder, 2026-11-10):
 * "Priya Raman and 3 others like this" where it fits, shorter where it does not, and
 * never a second line or text running into whatever sits beside it.
 */

const FORMS = [
  'Priya Raman and 3 others like this',
  'Priya Raman and 3 others',
  'Priya and 3 others like this',
  'Priya and 3 others',
  '4 likes',
];

const setFontScale = (fontScale: number) =>
  (useWindowDimensions as unknown as jest.Mock).mockReturnValue({
    width: 390,
    height: 844,
    scale: 3,
    fontScale,
  });

beforeEach(() => setFontScale(1));

/** Renders the line and gives it `width`, as the first layout pass would. */
const drawAt = async (width: number, forms = FORMS, glyphs = ['❤️']) => {
  const onPress = jest.fn();
  const view = await render(
    <ReactionSummary glyphs={glyphs} forms={forms} onPress={onPress} testID="summary" />,
  );
  await act(async () => {
    fireEvent(view.getByTestId('summary-line'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width, height: 32 } },
    });
  });
  const text = view.getByTestId('summary-text');
  return { view, onPress, text: text.props.children as string, node: text };
};

describe('the sentence it chooses', () => {
  it('says the most it can on a wide line', async () => {
    expect((await drawAt(390)).text).toBe('Priya Raman and 3 others like this');
  });

  it('steps down to a shorter form on a narrow one', async () => {
    const { text } = await drawAt(180);
    expect(FORMS.indexOf(text)).toBeGreaterThan(0);
    expect(text).not.toBe('4 likes');
  });

  it('falls back to the bare count when no name fits', async () => {
    expect((await drawAt(60)).text).toBe('4 likes');
  });

  it('shortens under a large accessibility text size rather than wrapping', async () => {
    const normal = (await drawAt(300)).text;
    setFontScale(2);
    const { text, node } = await drawAt(300);
    expect(FORMS.indexOf(text)).toBeGreaterThan(FORMS.indexOf(normal));
    expect(node.props.numberOfLines).toBe(1);
  });

  it('leaves room for the glyphs whatever the name, the count or the width', async () => {
    const longName = [
      'Maximiliana Wolfeschlegelsteinhausen-Bergerdorff and 1,234 others like this',
      'Maximiliana Wolfeschlegelsteinhausen-Bergerdorff and 1,234 others',
      'Maximiliana and 1,234 others like this',
      'Maximiliana and 1,234 others',
      '1,235 likes',
    ];
    for (const fontScale of [1, 1.35, 2]) {
      setFontScale(fontScale);
      for (const width of [140, 200, 260, 320, 390]) {
        const { text } = await drawAt(width, longName, ['❤️', '😂', '😮']);
        if (text === longName.at(-1)) continue;
        // Three 15pt glyphs with their overlap, and the gap after them.
        const cluster = 3 * 18 - 2 * 3 + theme.space[2];
        expect(estimateTextWidth(text, theme.typography.footnote.fontSize * fontScale) + cluster)
          .toBeLessThanOrEqual(width);
      }
    }
  });

  it('draws the longest form before it has been measured', () => {
    expect(fitSummaryForm(FORMS, null, 13)).toBe(FORMS[0]);
    expect(fitSummaryForm([], 300, 13)).toBe('');
  });
});

describe('the line itself', () => {
  it('opens the reactor list, and says the whole sentence to a screen reader', async () => {
    const { view, onPress } = await drawAt(120);
    const line = view.getByLabelText('Priya Raman and 3 others like this. See who reacted.');
    fireEvent.press(line);
    expect(onPress).toHaveBeenCalled();
  });

  it('keeps a 44pt target without growing the line', async () => {
    const { view } = await drawAt(390);
    const line = view.getByTestId('summary');
    const { hitSlop } = line.props;
    const style = [line.props.style].flat(3).reduce((all, one) => ({ ...all, ...one }), {});
    expect(style.minHeight + hitSlop.top + hitSlop.bottom).toBe(theme.layout.minTapTarget);
  });

  it('is read but not pressable where no list is wired', async () => {
    const view = await render(<ReactionSummary glyphs={[]} forms={['3 likes']} />);
    expect(view.getByLabelText('3 likes')).toBeTruthy();
    expect(view.queryByRole('button')).toBeNull();
  });

  it('draws nothing for nothing', async () => {
    const view = await render(<ReactionSummary glyphs={[]} forms={[]} />);
    expect(view.toJSON()).toBeNull();
  });
});
