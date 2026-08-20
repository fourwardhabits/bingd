import { render, screen } from '@testing-library/react-native';
import { useWindowDimensions } from 'react-native';

import { ScoresSection } from './ScoresSection';

/**
 * Two columns rather than two rows, and the copy rules that survived the change.
 *
 * The founder's final pass: Following and Bingd were conceptually right and vertically
 * tall — a circle beside two short lines, twice, mostly saying "Not enough ratings".
 * Side by side they read as the comparison they are and cost about half the height.
 *
 * What must not change with the layout is what the section is willing to claim. Below
 * the sample threshold there is a grey circle and four words, and never a number, a
 * countdown or a faded figure standing in for one.
 */

jest.mock('react-native/Libraries/Utilities/useWindowDimensions');

const mockWindow = useWindowDimensions as unknown as jest.Mock;

/** The device the founder is holding, unless a test says otherwise. */
const setViewport = (width: number, fontScale = 1) =>
  mockWindow.mockReturnValue({ width, height: 844, scale: 3, fontScale });

beforeEach(() => setViewport(412));

/** Which layout was drawn, read off the container the two scores share. */
const isSideBySide = () => {
  const style = screen.getByTestId('scores-layout').props.style;
  const flat = Array.isArray(style) ? Object.assign({}, ...style) : (style ?? {});
  return flat.flexDirection === 'row';
};

const both = {
  following: { score: null, ratingCount: 0 },
  bingd: { score: null, ratingCount: 0 },
};

describe('the scores row', () => {
  it('puts Following and Bingd side by side on an ordinary phone', async () => {
    await render(<ScoresSection {...both} />);
    expect(screen.getByText('Following')).toBeTruthy();
    expect(screen.getByText('Bingd')).toBeTruthy();
    expect(isSideBySide()).toBe(true);
  });

  it('falls back to stacked rows on a narrow device rather than cramming', async () => {
    setViewport(320);
    await render(<ScoresSection {...both} />);
    expect(isSideBySide()).toBe(false);
    // Both are still present and still say the same thing. The fallback is a layout
    // change, not a different answer.
    expect(screen.getAllByText('Not enough ratings')).toHaveLength(2);
  });

  it('falls back when the reader has turned type size up', async () => {
    setViewport(412, 1.5);
    await render(<ScoresSection {...both} />);
    expect(isSideBySide()).toBe(false);
  });

  it('says the same four words in both columns when there is nothing to average', async () => {
    await render(<ScoresSection {...both} />);
    expect(screen.getAllByText('Not enough ratings')).toHaveLength(2);
    // Never a countdown: "2 more needed" invites the reader to watch a number they
    // cannot move, and the shortfall is a property of a config value.
    expect(screen.queryByText(/more needed/)).toBeNull();
    expect(screen.queryByText(/\d+ more/)).toBeNull();
  });

  it('lights Following on a single rating and holds Bingd back', async () => {
    // The thresholds this section is built around: one person you follow is that
    // person's opinion; two strangers is not a crowd. Ten is the server's number.
    await render(
      <ScoresSection
        following={{ score: 8.2, ratingCount: 1 }}
        bingd={{ score: null, ratingCount: 9 }}
      />,
    );

    expect(screen.getByText('1 person you follow')).toBeTruthy();
    expect(screen.getByText('Not enough ratings')).toBeTruthy();
    // The count behind a withheld mean is not shown either — that was the countdown in
    // another form.
    expect(screen.queryByText('9 ratings')).toBeNull();
  });

  it('shows the sample behind a number once there is one', async () => {
    await render(
      <ScoresSection
        following={{ score: 8.2, ratingCount: 4 }}
        bingd={{ score: 7.4, ratingCount: 128 }}
      />,
    );

    expect(screen.getByText('4 people you follow')).toBeTruthy();
    expect(screen.getByText('128 ratings')).toBeTruthy();
  });

  it('draws an empty circle rather than a faded number', async () => {
    await render(<ScoresSection {...both} />);
    // The empty badge announces itself; a greyed figure would be a fact the page does
    // not believe.
    expect(screen.getByLabelText('Following: Not enough ratings')).toBeTruthy();
    expect(screen.getByLabelText('Bingd: Not enough ratings')).toBeTruthy();
  });

  it('is absent entirely when there is nothing to put in it', async () => {
    const view = await render(<ScoresSection following={null} bingd={null} />);
    expect(view.toJSON()).toBeNull();
  });
});
