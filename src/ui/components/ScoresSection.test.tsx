import { fireEvent, render, screen } from '@testing-library/react-native';

import { ScoresSection } from './ScoresSection';

/**
 * The composition, and the copy rules that have to survive every rearrangement of it.
 *
 * As of the 2026-09-07 redesign: a SCORES heading, Following before bingd., each unit a
 * circle with its words beside it, sized to its own content on a row that scrolls
 * sideways rather than reflowing, and no rule and no wash at all.
 *
 * What must *not* change is what the section is willing to claim. Below the sample
 * threshold there is a grey circle and four words, and never a number, a countdown or a
 * faded figure standing in for one.
 */

/** A style prop, flattened, whichever form the component passed it in. */
const flatten = (style: unknown) =>
  (Array.isArray(style) ? Object.assign({}, ...style) : (style ?? {})) as Record<string, unknown>;

/** Whether the two units share one row, read off the container they sit in. */
const isOneRow = () =>
  flatten(screen.getByTestId('scores-layout').props.style).flexDirection === 'row';

const both = {
  bingd: { score: null, ratingCount: 0 },
  following: { score: null, ratingCount: 0 },
};

describe('the scores row', () => {
  it('puts both units on one row', async () => {
    await render(<ScoresSection {...both} />);
    expect(screen.getByText('bingd.')).toBeTruthy();
    expect(screen.getByText('Following')).toBeTruthy();
    expect(isOneRow()).toBe(true);
  });

  it('leads with Following, then bingd.', async () => {
    /**
     * **The founder's order as of 2026-09-07**, reversing the Preview pass. Which number
     * is worth more to the person holding the phone decides: a mean over accounts they
     * chose to follow is a signal about their own taste, and the app-wide mean is a fact
     * about the app. The narrower, more personal reading leads.
     *
     * Asserted on the rendered order rather than on the props, because the props are
     * named and could be passed either way round without changing what anybody sees.
     */
    await render(
      <ScoresSection
        bingd={{ score: 7.4, ratingCount: 128 }}
        following={{ score: 8.2, ratingCount: 4 }}
      />,
    );
    const labels = screen
      .getAllByText(/^(bingd.|Following)$/)
      .map((node) => node.props.children);
    expect(labels).toEqual(['Following', 'bingd.']);
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
    expect(isOneRow()).toBe(true);
  });

  it('sizes each unit to its own content rather than to half the screen', async () => {
    /**
     * **This is what replaced the responsive fallback** (2026-09-07), and it is the
     * property that made the fallback unnecessary.
     *
     * The units were two flex halves, which meant "Not enough ratings" had about ninety
     * points to set in and broke mid-word — so the component grew a minimum width, a
     * font-scale ceiling and a second stacked layout to avoid it. Sized to their content
     * inside a scroller they cannot be cramped at any width or any text size, and a
     * third unit can be added without re-deciding a breakpoint.
     */
    await render(<ScoresSection {...both} />);
    for (const unit of screen.getAllByTestId('scores-unit')) {
      expect(flatten(unit.props.style).flex).toBeUndefined();
    }
  });

  it('lets the empty line set on one line rather than clamping it', async () => {
    // The clamp existed because a half-width unit could not fit the words. With the
    // width free, a numberOfLines here would be truncating something that fits.
    await render(<ScoresSection {...both} />);
    for (const line of screen.getAllByText('Not enough ratings')) {
      expect(line.props.numberOfLines).toBeUndefined();
    }
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

/**
 * **A heading, and no rule at all** (founder, 2026-09-07).
 *
 * The SCORES label was removed on 2026-09-06 on the argument that the units name
 * themselves. That is true of each unit and not of the pair: two circles with words
 * beside them, arriving under a synopsis with no heading, read as a continuation of the
 * synopsis — and no arrangement of two units gives a screen reader a landmark.
 *
 * The rule went the other way. It moved twice — beneath the row, then above it — and is
 * now gone: with a Maroon heading opening the section and a section's worth of air above
 * it, a hairline as well is what left the whole page reading as a stack of bordered
 * bands. The one rule on the title page is above the tab row.
 */
describe('the section’s own shape', () => {
  it('opens with the app’s section heading, then the row', async () => {
    await render(<ScoresSection {...both} />);

    const heading = screen.getByText('SCORES');
    // Casing is applied as a style rather than typed, so a screen reader does not spell
    // the word out.
    expect(flatten(heading.props.style).textTransform).toBe('uppercase');

    // And it opens the section: the heading comes before the row in document order, which
    // is what "opens" means to a reader and to a screen reader alike.
    const nodes = screen.root!.queryAll(() => true);
    const at = (match: (node: { props: Record<string, unknown> }) => boolean) =>
      nodes.findIndex(match as never);
    expect(at((node) => node.props.testID === 'scores-section')).toBeLessThan(
      at((node) => node.props.children === 'SCORES'),
    );
    expect(at((node) => node.props.children === 'SCORES')).toBeLessThan(
      at((node) => node.props.testID === 'scores-layout'),
    );
  });

  it('draws no rule and no wash', async () => {
    await render(<ScoresSection {...both} />);

    expect(screen.queryByTestId('scores-divider')).toBeNull();
    const section = flatten(screen.getByTestId('scores-section').props.style);
    expect(section.backgroundColor).toBeUndefined();
    expect(section.borderTopWidth).toBeUndefined();
    expect(section.borderWidth).toBeUndefined();
    expect(section.borderRadius).toBeUndefined();
  });
});
