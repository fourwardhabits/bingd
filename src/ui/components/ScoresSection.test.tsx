import { fireEvent, render, screen, within } from '@testing-library/react-native';

import { theme } from '../tokens';
import { ScoresSection } from './ScoresSection';

/**
 * The composition, and the copy rules that have to survive every rearrangement of it.
 *
 * As of the 2026-09-07 founder lock: a SCORES heading, then **three** units in one fixed
 * order — `Your score`, `Following`, `bingd.` — each a circle with its words *beneath*
 * it, on three equal columns of the content width.
 *
 * Three things must not change whatever the layout does next:
 *
 *   - the order, because it is a hierarchy of relevance to one reader (me, then the
 *     people I chose, then the room) and not a leaderboard;
 *   - what the section is willing to claim: below the sample threshold there is a dash
 *     and a sentence, and never a number, a countdown or a faded figure standing in for
 *     one;
 *   - which unit is filled. Exactly one circle on the page is solid Maroon and it is
 *     always the reader's own.
 */

/** A style prop, flattened, whichever form the component passed it in. */
const flatten = (style: unknown) =>
  (Array.isArray(style) ? Object.assign({}, ...style) : (style ?? {})) as Record<string, unknown>;

/** Whether the units share one row, read off the container they sit in. */
const isOneRow = () =>
  flatten(screen.getByTestId('scores-layout').props.style).flexDirection === 'row';

const all = {
  you: { score: null },
  bingd: { score: null, ratingCount: 0 },
  following: { score: null, ratingCount: 0 },
};

describe('the scores row', () => {
  it('puts all three units on one row', async () => {
    await render(<ScoresSection {...all} />);
    expect(screen.getByText('Your score')).toBeTruthy();
    expect(screen.getByText('Following')).toBeTruthy();
    expect(screen.getByText('bingd.')).toBeTruthy();
    expect(isOneRow()).toBe(true);
  });

  it('reads me, then the people I follow, then the room', async () => {
    /**
     * **The founder's order, locked 2026-09-07.** The reader's own score leads because
     * the section is a comparison and they are the first term of it; Following comes
     * before bingd. because a mean over accounts they chose is a signal about their own
     * taste and the app-wide mean is a fact about the app.
     *
     * Asserted on the rendered order rather than on the props, because the props are
     * named and could be passed in any order without changing what anybody sees.
     */
    await render(
      <ScoresSection
        you={{ score: 9.4 }}
        bingd={{ score: 7.4, ratingCount: 128 }}
        following={{ score: 8.2, ratingCount: 4 }}
      />,
    );
    const labels = screen
      .getAllByText(/^(bingd\.|Following|Your score)$/)
      .map((node) => node.props.children);
    expect(labels).toEqual(['Your score', 'Following', 'bingd.']);
  });

  it('stacks each circle above its words rather than beside them', async () => {
    /**
     * **The composition change three units forced** (2026-09-07).
     *
     * Laid out sideways a unit needs about 170pt, so three of them ran off a 358pt
     * content width and the horizontal scroller that used to rescue the two-unit row at
     * large text sizes turned bingd. into something a reader had to discover by swiping.
     * Stacked, a unit is as wide as its column and overflows downward by wrapping its own
     * sub-label — which is what a column is for.
     */
    await render(<ScoresSection {...all} />);
    const units = screen.getAllByTestId(/^scores-unit/);
    expect(units).toHaveLength(3);
    for (const unit of units) {
      // A column, not a row: the default flexDirection is 'column', so what must be
      // true is that nothing has set it to 'row'.
      expect(flatten(unit.props.style).flexDirection).not.toBe('row');
    }
  });

  it('gives the three units equal columns and lets long copy wrap inside one', async () => {
    /**
     * `flex: 1` with `minWidth: 0` on each. Without the minimum, a flex child's floor is
     * its own content, so `None of your friends have ranked this` would push its column
     * wider and steal width from the two beside it rather than wrapping in place.
     */
    await render(<ScoresSection {...all} />);
    for (const unit of screen.getAllByTestId(/^scores-unit/)) {
      const style = flatten(unit.props.style);
      expect(style.flex).toBe(1);
      expect(style.minWidth).toBe(0);
    }
  });

  it('aligns the circles on one line however tall the labels get', async () => {
    // `flex-start`, not `center`. Following's empty sentence sets on three lines in a
    // 114pt column, and a centred row would drag its circle down out of line with the
    // other two.
    await render(<ScoresSection {...all} />);
    expect(flatten(screen.getByTestId('scores-layout').props.style).alignItems).toBe(
      'flex-start',
    );
  });

  it('never clamps a unit’s copy', async () => {
    // A column can grow downward, so clamping here would truncate something that fits.
    await render(<ScoresSection {...all} />);
    for (const line of [
      screen.getByText('Not ranked yet'),
      screen.getByText('No ratings yet'),
      screen.getByText('Not enough ratings'),
    ]) {
      expect(line.props.numberOfLines).toBeUndefined();
    }
  });

  it('keeps every supporting line short enough not to wrap the row', async () => {
    /**
     * **The founder's 2026-09-08 correction, as a measurement.** The first pass wrote
     * sentences here — `1 person you follow`, `None of your friends have ranked this` —
     * and in a third of a 358pt content width those set on two and three lines and made
     * the section read as noise.
     *
     * Four words is the ceiling. It is a proxy for "fits a 114pt column at the default
     * text size", which a unit test cannot measure directly, and it fails on every string
     * that caused the defect.
     */
    await render(<ScoresSection {...all} />);

    for (const line of [
      screen.getByText('Not ranked yet'),
      screen.getByText('No ratings yet'),
      screen.getByText('Not enough ratings'),
    ]) {
      expect(String(line.props.children).split(' ').length).toBeLessThanOrEqual(4);
    }
  });
});

describe('what each unit says when it has nothing', () => {
  it('gives every unit its own words rather than one shared four', async () => {
    /**
     * They all said `Not enough ratings`, which hid a real distinction: the app being
     * short of a sample, nobody the reader follows having rated it, and the reader not
     * having ranked it are three different facts, and only the middle one is something
     * they can act on. The 2026-09-08 pass shortened them; it did not merge them.
     */
    await render(<ScoresSection {...all} />);

    expect(screen.getByText('Not ranked yet')).toBeTruthy();
    expect(screen.getByText('No ratings yet')).toBeTruthy();
    expect(screen.getByText('Not enough ratings')).toBeTruthy();
  });

  it('never counts down', async () => {
    // "2 more needed" invites the reader to watch a number they cannot move, and the
    // shortfall is a property of a config value rather than of the film.
    await render(<ScoresSection {...all} />);
    expect(screen.queryByText(/more needed/)).toBeNull();
    expect(screen.queryByText(/\d+ more/)).toBeNull();
  });

  it('draws a stated absence rather than a blank disc or a faded number', async () => {
    /**
     * The founder's constraint is exact: "no blank cream disc that looks like broken
     * content". An empty circle is indistinguishable from one whose contents failed to
     * load; an em dash is somebody having decided there is nothing here.
     */
    await render(<ScoresSection {...all} />);

    expect(screen.getByLabelText('Your score: Not ranked yet')).toBeTruthy();
    expect(screen.getByLabelText('Following: No ratings yet')).toBeTruthy();
    expect(screen.getByLabelText('bingd.: Not enough ratings')).toBeTruthy();
    expect(screen.getAllByText('—')).toHaveLength(3);
  });

  it('says the number is loading rather than that it is not ranked', async () => {
    // A score is derived from the size of the band it sits in, so the ranking row can
    // land a moment before the band sizes. `Not ranked yet` there would contradict the
    // Ranked control a few points above it.
    await render(<ScoresSection {...all} you={{ score: null, pending: true }} />);

    expect(screen.getByText('Score loading')).toBeTruthy();
    expect(screen.queryByText('Not ranked yet')).toBeNull();
  });
});

describe('how much authority each circle claims', () => {
  /** The fill and ring the badge actually drew, off the labelled circle itself. */
  const treatmentOf = (name: string) => flatten(screen.getByLabelText(name).props.style);

  it('fills the reader’s own and outlines everybody else’s', async () => {
    /**
     * **The founder-approved departure from the one-Maroon-fill rule** (`semantic.score`).
     * Three identical filled circles say the three claims are interchangeable, which is
     * the opposite of what this section exists to say.
     */
    await render(
      <ScoresSection
        you={{ score: 9.4 }}
        following={{ score: 8.7, ratingCount: 6 }}
        bingd={{ score: 8.1, ratingCount: 1284 }}
      />,
    );

    const you = treatmentOf('9.4 out of 10');
    expect(you.backgroundColor).toBeDefined();
    expect(you.borderWidth).toBeUndefined();

    for (const other of [treatmentOf('8.7 out of 10'), treatmentOf('8.1 out of 10')]) {
      expect(other.backgroundColor).toBeUndefined();
      expect(other.borderWidth).toBeGreaterThan(0);
    }
  });

  it('quiets bingd. when one person is the whole sample', async () => {
    /**
     * The founder's sentence, as a measurement: "do not make one person's score look
     * statistically authoritative". The number is still shown — withholding it would be
     * a different lie — but the ring and the ink go neutral.
     */
    await render(
      <ScoresSection
        you={{ score: null }}
        following={{ score: null, ratingCount: 0 }}
        bingd={{ score: 9.1, ratingCount: 1 }}
      />,
    );

    expect(screen.getByText('1 rating')).toBeTruthy();
    const quiet = treatmentOf('9.1 out of 10');
    expect(quiet.backgroundColor).toBeUndefined();
    expect(quiet.borderWidth).toBeGreaterThan(0);

    // And it is a different ring from the outlined one: the whole point is that the two
    // are distinguishable at a glance.
    await render(
      <ScoresSection
        you={{ score: null }}
        following={{ score: null, ratingCount: 0 }}
        bingd={{ score: 9.1, ratingCount: 2 }}
      />,
    );
    expect(treatmentOf('9.1 out of 10').borderColor).not.toBe(quiet.borderColor);
  });

  it('leaves Following outlined at a single rating', async () => {
    // Not the same claim as bingd.'s: Following's sample is people the reader chose, which
    // is the most useful signal on this page and never a thin statistic about strangers.
    await render(
      <ScoresSection
        you={{ score: null }}
        following={{ score: 8.2, ratingCount: 1 }}
        bingd={{ score: null, ratingCount: 0 }}
      />,
    );

    expect(screen.getByText('1 rating')).toBeTruthy();
    const ring = treatmentOf('8.2 out of 10');
    expect(ring.backgroundColor).toBeUndefined();
    expect(ring.borderWidth).toBeGreaterThan(0);
    // Maroon, not the neutral hairline bingd. gets at the same count.
    expect(ring.borderColor).toBe(theme.semantic.score);
  });
});

describe('what the aggregates report', () => {
  it('lights Following on a single rating and holds bingd. back', async () => {
    await render(
      <ScoresSection
        you={{ score: null }}
        bingd={{ score: null, ratingCount: 9 }}
        following={{ score: 8.2, ratingCount: 1 }}
      />,
    );

    expect(screen.getByText('1 rating')).toBeTruthy();
    expect(screen.getByText('Not enough ratings')).toBeTruthy();
    // The count behind a withheld mean is not shown either — that was the countdown in
    // another form.
    expect(screen.queryByText('9 ratings')).toBeNull();
  });

  it('shows the sample behind a number once there is one, and counts ratings not people', async () => {
    await render(
      <ScoresSection
        you={{ score: null }}
        bingd={{ score: 7.4, ratingCount: 128 }}
        following={{ score: 8.2, ratingCount: 4 }}
      />,
    );

    expect(screen.getByText('128 ratings')).toBeTruthy();
    expect(screen.getByText('4 ratings')).toBeTruthy();
    // Following counted people until 2026-09-08. The label above it already says whose
    // ratings these are, so the words were restating it at the cost of two extra lines.
    expect(screen.queryByText(/people you follow/)).toBeNull();
  });

  it('says one rating in the singular, in both aggregates', async () => {
    await render(
      <ScoresSection
        you={{ score: null }}
        bingd={{ score: 7.4, ratingCount: 1 }}
        following={{ score: 8.2, ratingCount: 1 }}
      />,
    );

    expect(screen.getAllByText('1 rating')).toHaveLength(2);
    expect(screen.queryByText('1 ratings')).toBeNull();
  });

  it('is absent entirely when there is nothing to put in it', async () => {
    const view = await render(<ScoresSection you={null} following={null} bingd={null} />);
    expect(view.toJSON()).toBeNull();
  });

  it('drops the personal unit for a title that cannot be ranked', async () => {
    // A series has no personal score to have, which is a different thing from not having
    // one yet — so it gets no unit rather than a permanent "Not ranked yet".
    await render(
      <ScoresSection
        you={null}
        bingd={{ score: 7.4, ratingCount: 128 }}
        following={{ score: 8.2, ratingCount: 4 }}
      />,
    );

    expect(screen.queryByText('Your score')).toBeNull();
    expect(screen.getAllByTestId(/^scores-unit/)).toHaveLength(2);
  });
});

/**
 * **The founder's physical-QA defect, and the shape of it** (2026-09-08).
 *
 * The device showed `7.0`, `Your score` and `Not ranked yet` stacked in one unit. The badge
 * and the sub-label were chosen by two different expressions — the caller passed the unit's
 * *empty* copy as its `detail`, and `detail` is what a unit with a number prints — so a
 * ranked title stated its score and denied it in the same breath.
 *
 * These pin the fix at the level it was made: one `score == null` decides the badge, the
 * copy and the spoken label together.
 */
describe('a numeric personal score and the words under it', () => {
  it('never says Not ranked yet when there is a number', async () => {
    await render(
      <ScoresSection
        you={{ score: 7 }}
        following={{ score: null, ratingCount: 0 }}
        bingd={{ score: null, ratingCount: 0 }}
      />,
    );

    expect(screen.getByLabelText('7.0 out of 10')).toBeTruthy();
    expect(screen.getByText('Your score')).toBeTruthy();
    expect(screen.queryByText('Not ranked yet')).toBeNull();
    expect(screen.queryByText('Score loading')).toBeNull();
  });

  it('holds at a score of zero, which is what a truthiness check would drop', async () => {
    /**
     * `0.0` is a real score — the bottom of the *Not for me* band — and it is falsy. A
     * guard written `score ? … : …` rather than `score != null` passes every other test
     * here and then tells the one reader who hated a film hardest that they never ranked
     * it.
     */
    await render(
      <ScoresSection
        you={{ score: 0 }}
        following={{ score: null, ratingCount: 0 }}
        bingd={{ score: null, ratingCount: 0 }}
      />,
    );

    expect(screen.getByLabelText('0.0 out of 10')).toBeTruthy();
    expect(
      within(screen.getByTestId('scores-unit-you')).queryByText('Not ranked yet'),
    ).toBeNull();
  });

  it('draws no second line at all under a ranked score', async () => {
    /**
     * Every candidate for that line has been cut in turn: the bucket word, the rank, the
     * watch date, and finally `Ranked` itself — a filled Maroon circle with a number in it
     * has already said so.
     */
    await render(
      <ScoresSection
        you={{ score: 9.4 }}
        following={{ score: 8.7, ratingCount: 6 }}
        bingd={{ score: null, ratingCount: 0 }}
      />,
    );

    const unit = screen.getByTestId('scores-unit-you');
    // The label, and nothing beneath it.
    expect(within(unit).getByText('Your score')).toBeTruthy();
    expect(within(unit).queryByText('Ranked')).toBeNull();
    expect(within(unit).queryByText(/rating/)).toBeNull();
    expect(within(unit).queryByText('Not ranked yet')).toBeNull();
  });

  it('says Not ranked yet only when there is genuinely no number', async () => {
    await render(
      <ScoresSection
        you={{ score: null }}
        following={{ score: null, ratingCount: 0 }}
        bingd={{ score: null, ratingCount: 0 }}
      />,
    );

    const unit = screen.getByTestId('scores-unit-you');
    expect(within(unit).getByText('Not ranked yet')).toBeTruthy();
    expect(within(unit).getByText('—')).toBeTruthy();
    expect(within(unit).queryByText(/\d\.\d/)).toBeNull();
  });
});

describe('what the section refuses to say about the reader', () => {
  it('puts no bucket word under the personal score', async () => {
    /**
     * `Loved` under a 9.4 was in the design draft and the founder cut it: it restates the
     * number in vocabulary this screen has never used. The sub-label is the unit's
     * provenance, and for the reader's own score there is nothing to add.
     */
    await render(
      <ScoresSection
        you={{ score: 9.4 }}
        following={{ score: null, ratingCount: 0 }}
        bingd={{ score: null, ratingCount: 0 }}
      />,
    );

    for (const word of ['Loved', 'Fine', 'Not for me']) {
      expect(screen.queryByText(word)).toBeNull();
    }
  });

  it('carries no rank and no watched date', async () => {
    // Both stay in the identity block: they are the reader's history with the title, not
    // a qualification of an aggregate, and they do not fit a circle and two short lines.
    await render(
      <ScoresSection
        you={{ score: 9.4 }}
        following={{ score: null, ratingCount: 0 }}
        bingd={{ score: null, ratingCount: 0 }}
      />,
    );

    expect(screen.queryByText(/^#\d+ in /)).toBeNull();
    expect(screen.queryByText(/Watched /)).toBeNull();
  });
});

describe('the people behind the Following number (founder, 2026-08-27 §13)', () => {
  it('makes the Following unit a button once it has members', async () => {
    const onPressFollowing = jest.fn();
    await render(
      <ScoresSection
        you={{ score: null }}
        bingd={{ score: 7.4, ratingCount: 128 }}
        following={{ score: 8.2, ratingCount: 3 }}
        onPressFollowing={onPressFollowing}
      />,
    );

    // The spoken label names the number before the sample. A Pressable with its own label
    // absorbs its children's, so without that a screen reader pressing this unit heard the
    // count and never the 8.2 the row exists to state.
    await fireEvent.press(
      screen.getByRole('button', { name: 'Following. 8.2 out of 10. 3 ratings' }),
    );
    expect(onPressFollowing).toHaveBeenCalled();
  });

  it('refuses to be a button into an empty list', async () => {
    // Zero members means a sheet with nothing to say; the unit stays a statement.
    await render(
      <ScoresSection
        you={null}
        bingd={{ score: 7.4, ratingCount: 128 }}
        following={{ score: null, ratingCount: 0 }}
        onPressFollowing={jest.fn()}
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('never turns the bingd. unit into a control', async () => {
    // The app-wide mean is a crowd, not a list. Only Following and the reader's own open.
    await render(
      <ScoresSection
        you={null}
        bingd={{ score: 7.4, ratingCount: 128 }}
        following={{ score: 8.2, ratingCount: 3 }}
        onPressFollowing={jest.fn()}
      />,
    );

    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});

describe('the reader’s own unit as a control', () => {
  it('opens the rating options from the score itself', async () => {
    // The score has been a place to press to change a rating since 2026-09-06, and moving
    // it off the poster does not take that away.
    const onPress = jest.fn();
    await render(
      <ScoresSection
        you={{ score: 9.4, onPress }}
        following={{ score: null, ratingCount: 0 }}
        bingd={{ score: null, ratingCount: 0 }}
      />,
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Your score. 9.4 out of 10' }));
    expect(onPress).toHaveBeenCalled();
  });

  it('is a plain statement when the screen offers no action', async () => {
    await render(
      <ScoresSection
        you={{ score: 9.4 }}
        following={{ score: null, ratingCount: 0 }}
        bingd={{ score: null, ratingCount: 0 }}
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
  });
});

/**
 * **A heading, and no rule at all** (founder, 2026-09-07).
 *
 * The SCORES label was removed on 2026-09-06 on the argument that the units name
 * themselves. That is true of each unit and not of the row: circles with words under
 * them, arriving after a synopsis with no heading, read as a continuation of the
 * synopsis — and no arrangement of units gives a screen reader a landmark.
 *
 * The rule went the other way. It moved twice — beneath the row, then above it — and is
 * now gone: with a Maroon heading opening the section and a section's worth of air above
 * it, a hairline as well is what left the whole page reading as a stack of bordered
 * bands. The one rule on the title page is above the tab row.
 */
describe('the section’s own shape', () => {
  it('opens with the app’s section heading, then the row', async () => {
    await render(<ScoresSection {...all} />);

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
    await render(<ScoresSection {...all} />);

    expect(screen.queryByTestId('scores-divider')).toBeNull();
    const section = flatten(screen.getByTestId('scores-section').props.style);
    expect(section.backgroundColor).toBeUndefined();
    expect(section.borderTopWidth).toBeUndefined();
    expect(section.borderWidth).toBeUndefined();
    expect(section.borderRadius).toBeUndefined();
  });
});
