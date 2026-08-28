import { fireEvent, render, screen } from '@testing-library/react-native';
import { useWindowDimensions } from 'react-native';

import { ScoresSection } from './ScoresSection';

/**
 * The composition the founder asked for after the Android Preview, and the copy rules
 * that have to survive it.
 *
 * Three things changed: Bingd leads, each unit is a circle with its words beside it
 * rather than above them, and an inset rule separates the block from the actions over
 * it. What must *not* change is what the section is willing to claim. Below the sample
 * threshold there is a grey circle and four words, and never a number, a countdown or a
 * faded figure standing in for one.
 */

jest.mock('react-native/Libraries/Utilities/useWindowDimensions');

const mockWindow = useWindowDimensions as unknown as jest.Mock;

/** The device the founder is holding, unless a test says otherwise. */
const setViewport = (width: number, fontScale = 1) =>
  mockWindow.mockReturnValue({ width, height: 844, scale: 3, fontScale });

beforeEach(() => setViewport(412));

/** A style prop, flattened, whichever form the component passed it in. */
const flatten = (style: unknown) =>
  (Array.isArray(style) ? Object.assign({}, ...style) : (style ?? {})) as Record<string, unknown>;

/** Which layout was drawn, read off the container the two scores share. */
const isSideBySide = () => flatten(screen.getByTestId('scores-layout').props.style).flexDirection === 'row';

const both = {
  bingd: { score: null, ratingCount: 0 },
  following: { score: null, ratingCount: 0 },
};

describe('the scores row', () => {
  it('puts Bingd and Following side by side on an ordinary phone', async () => {
    await render(<ScoresSection {...both} />);
    expect(screen.getByText('bingd.')).toBeTruthy();
    expect(screen.getByText('Following')).toBeTruthy();
    expect(isSideBySide()).toBe(true);
  });

  it('leads with bingd., then Following', async () => {
    // The founder's ordering, and the one a screen reader walks in. Asserted on the
    // rendered order rather than on the props, because the props are named and could be
    // passed either way round without changing what anybody sees.
    await render(
      <ScoresSection
        bingd={{ score: 7.4, ratingCount: 128 }}
        following={{ score: 8.2, ratingCount: 4 }}
      />,
    );
    const labels = screen
      .getAllByText(/^(bingd.|Following)$/)
      .map((node) => node.props.children);
    expect(labels).toEqual(['bingd.', 'Following']);
  });

  it('draws each circle beside its words rather than above them', async () => {
    // The compositional half of the founder's note, and the part a label assertion
    // cannot see: both units read left-to-right, and so does the container holding
    // them, which is what makes the pair one line.
    await render(<ScoresSection {...both} />);
    const units = screen.getAllByTestId('scores-unit');
    expect(units).toHaveLength(2);
    for (const unit of units) {
      expect(flatten(unit.props.style).flexDirection).toBe('row');
    }
    expect(isSideBySide()).toBe(true);
  });

  it('keeps the circle beside the words in the narrow fallback too', async () => {
    // The fallback is a wider line, not a different design. This is the assertion that
    // stops it drifting back to a stack the next time the breakpoint moves.
    setViewport(320);
    await render(<ScoresSection {...both} />);
    for (const unit of screen.getAllByTestId('scores-unit')) {
      expect(flatten(unit.props.style).flexDirection).toBe('row');
    }
  });

  it('separates the block with an inset rule rather than a full-width one', async () => {
    await render(<ScoresSection {...both} />);
    const divider = flatten(screen.getByTestId('scores-divider').props.style);
    // Inset: it stops short of both screen edges by the page gutter.
    expect(divider.marginHorizontal).toBe(16);
    // Light: a hairline, and a top border rather than a filled bar.
    expect(divider.borderTopWidth).toBeLessThanOrEqual(1);
    expect(divider.borderTopColor).toBeTruthy();
    expect(divider.height).toBeUndefined();
    expect(divider.backgroundColor).toBeUndefined();
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

  it('keeps the order and the circle-first composition in the fallback', async () => {
    setViewport(320);
    await render(
      <ScoresSection
        bingd={{ score: 7.4, ratingCount: 128 }}
        following={{ score: 8.2, ratingCount: 4 }}
      />,
    );
    const labels = screen.getAllByText(/^(bingd.|Following)$/).map((n) => n.props.children);
    expect(labels).toEqual(['bingd.', 'Following']);
  });

  it('says the same four words in both units when there is nothing to average', async () => {
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
        bingd={{ score: null, ratingCount: 9 }}
        following={{ score: 8.2, ratingCount: 1 }}
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
        bingd={{ score: 7.4, ratingCount: 128 }}
        following={{ score: 8.2, ratingCount: 4 }}
      />,
    );

    expect(screen.getByText('128 ratings')).toBeTruthy();
    expect(screen.getByText('4 people you follow')).toBeTruthy();
  });

  it('draws an empty circle rather than a faded number', async () => {
    await render(<ScoresSection {...both} />);
    // The empty badge announces itself; a greyed figure would be a fact the page does
    // not believe.
    expect(screen.getByLabelText('bingd.: Not enough ratings')).toBeTruthy();
    expect(screen.getByLabelText('Following: Not enough ratings')).toBeTruthy();
  });

  it('is absent entirely when there is nothing to put in it', async () => {
    const view = await render(<ScoresSection following={null} bingd={null} />);
    expect(view.toJSON()).toBeNull();
  });
});

describe('the people behind the Following number (founder, 2026-08-27 §13)', () => {
  it('makes the Following unit a button once it has members', async () => {
    const onPressFollowing = jest.fn();
    await render(
      <ScoresSection
        bingd={{ score: 7.4, ratingCount: 128 }}
        following={{ score: 8.2, ratingCount: 3 }}
        onPressFollowing={onPressFollowing}
      />,
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Following. 3 people you follow' }));
    expect(onPressFollowing).toHaveBeenCalled();
  });

  it('refuses to be a button into an empty list', async () => {
    // Zero members means a sheet with nothing to say; the unit stays a statement.
    await render(
      <ScoresSection
        bingd={{ score: 7.4, ratingCount: 128 }}
        following={{ score: null, ratingCount: 0 }}
        onPressFollowing={jest.fn()}
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('never turns the bingd. unit into a control', async () => {
    // The app-wide mean is a crowd, not a list. Only Following opens.
    await render(
      <ScoresSection
        bingd={{ score: 7.4, ratingCount: 128 }}
        following={{ score: 8.2, ratingCount: 3 }}
        onPressFollowing={jest.fn()}
      />,
    );

    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
