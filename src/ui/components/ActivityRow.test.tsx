import { fireEvent, render } from '@testing-library/react-native';

import { ActivityRow } from './ActivityRow';

const props = {
  actorName: 'Suraj',
  verb: 'ranked',
  title: 'Inception',
  year: 2010,
  metadata: '148m · Sci-fi',
  timeLabel: '13h ago',
  onPressTitle: jest.fn(),
};

beforeEach(() => props.onPressTitle.mockReset());

describe('the poster placeholder', () => {
  it('initials the film, not the sentence around it', async () => {
    // The SR bug. `ActivityCard` passed its whole sentence in as the poster's
    // title, so with no artwork — which is every seeded row — "Someone ranked a
    // title." initialised to a confident-looking "SR" on every item in the feed.
    //
    // A two-word film is what makes this visible: both the sentence and the
    // title produce two initials, and only one of them is the film.
    const view = await render(
      <ActivityRow {...props} title="Blade Runner" posterUri={null} />,
    );

    expect(view.getByText('BR')).toBeTruthy();
    expect(view.queryByText('SR')).toBeNull();
  });
});

describe('the sentence', () => {
  it('names the actor and the title', async () => {
    const view = await render(<ActivityRow {...props} />);
    expect(view.getByText(/Suraj/)).toBeTruthy();
    expect(view.getAllByText('Inception').length).toBeGreaterThan(0);
  });

  it('says "a title" rather than nothing when the media row is missing', async () => {
    const view = await render(<ActivityRow {...props} title={null} />);
    expect(view.getAllByText('a title').length).toBeGreaterThan(0);
  });
});

describe('the score', () => {
  it('shows the snapshotted score, never a position', async () => {
    const view = await render(<ActivityRow {...props} score={8.7} bucket="loved" />);

    expect(view.getByText('8.7')).toBeTruthy();
    expect(view.queryByText(/#\d/)).toBeNull();
  });

  it('shows nothing at all when the event predates the snapshot', async () => {
    // Not a dashed unranked badge: that badge means "you have not ranked this",
    // and this event is someone else's ranking whose number was never recorded.
    const view = await render(<ActivityRow {...props} score={null} bucket={null} />);
    expect(view.queryByLabelText(/out of 10/)).toBeNull();
  });
});

describe('the title card', () => {
  it('opens the title page', async () => {
    const view = await render(<ActivityRow {...props} />);
    await fireEvent.press(view.getByLabelText('Inception, 2010, 148m · Sci-fi'));

    expect(props.onPressTitle).toHaveBeenCalled();
  });
});

describe('the watchlist action', () => {
  it('is absent when the row cannot offer one', async () => {
    const view = await render(<ActivityRow {...props} />);
    expect(view.queryByLabelText(/watchlist/i)).toBeNull();
  });

  it('says what it will do, and what it did', async () => {
    const onPressWatchlist = jest.fn();
    const view = await render(<ActivityRow {...props} onPressWatchlist={onPressWatchlist} />);

    await fireEvent.press(view.getByLabelText('Add Inception to your watchlist'));
    expect(onPressWatchlist).toHaveBeenCalled();

    const saved = await render(
      <ActivityRow {...props} onPressWatchlist={onPressWatchlist} inWatchlist />,
    );
    expect(saved.getByLabelText('Inception is in your watchlist')).toBeTruthy();
  });
});

describe('the note', () => {
  it('clamps to two lines until asked to expand', async () => {
    const note = 'Third time and it still holds up.';
    const view = await render(<ActivityRow {...props} note={note} />);

    expect(view.getByText(note).props.numberOfLines).toBe(2);
    await fireEvent.press(view.getByLabelText('Show the whole note'));
    expect(view.getByText(note).props.numberOfLines).toBeUndefined();
  });
});
