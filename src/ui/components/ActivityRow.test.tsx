import { fireEvent, render } from '@testing-library/react-native';

import { Text } from 'react-native';

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
  it('names the actor, and names the title exactly once', async () => {
    // The title used to appear in the sentence *and* in the card below it. One of
    // the two was always the redundant one, and dropping it from the sentence is
    // what let the avatar move onto that line and the row lose a whole band.
    const view = await render(<ActivityRow {...props} />);

    expect(view.getByText(/Suraj/)).toBeTruthy();
    expect(view.getAllByText(/Inception/)).toHaveLength(1);
  });

  it('says "a title" rather than nothing when the media row is missing', async () => {
    const view = await render(<ActivityRow {...props} title={null} />);
    expect(view.getAllByText(/a title/).length).toBeGreaterThan(0);
  });

  it('carries the full name of a season, since the feed never shows its series', async () => {
    const view = await render(
      <ActivityRow {...props} title="Parks and Recreation — Season 2" />,
    );
    expect(view.getByText(/Parks and Recreation — Season 2/)).toBeTruthy();
  });

  it('opens the actor’s profile when there is one to open', async () => {
    const onPressActor = jest.fn();
    const view = await render(<ActivityRow {...props} onPressActor={onPressActor} />);

    await fireEvent.press(view.getByLabelText('Suraj’s profile'.replace('’', "'")));
    expect(onPressActor).toHaveBeenCalled();
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

describe('the share action', () => {
  it('is icon-first and carries no large text button', async () => {
    const onPressShare = jest.fn();
    const view = await render(<ActivityRow {...props} onPressShare={onPressShare} />);

    // The label names the title being shared, so a screen reader gets the context
    // the glyph cannot carry. There is deliberately no visible "Share" word.
    expect(view.queryByText('Share')).toBeNull();
    await fireEvent.press(view.getByLabelText('Share Inception'));
    expect(onPressShare).toHaveBeenCalled();
  });

  it('names the exact entity, so sharing a season does not read as sharing the show', async () => {
    const view = await render(
      <ActivityRow {...props} title="Parks and Recreation — Season 2" onPressShare={jest.fn()} />,
    );
    expect(view.getByLabelText('Share Parks and Recreation — Season 2')).toBeTruthy();
  });

  it('is absent when the row has nothing to share', async () => {
    const view = await render(<ActivityRow {...props} />);
    expect(view.queryByLabelText(/^Share /)).toBeNull();
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

  /**
   * The rule the whole spoiler feature rests on: a masked note is a note whose text
   * is not in the tree. Clipping it to zero lines, blurring it or covering it would
   * all leave the string where a screen reader reads it and a selection copies it.
   */
  it('does not render masked text at all, not even clipped', async () => {
    const note = 'He was dead the whole time.';
    const view = await render(
      <ActivityRow {...props} note={note} noteHasSpoilers noteMasked />,
    );

    expect(view.queryByText(note)).toBeNull();
    expect(view.getByText('Contains spoilers')).toBeTruthy();
  });

  it('reveals on a deliberate tap, and only for this reader', async () => {
    const note = 'He was dead the whole time.';
    const view = await render(
      <ActivityRow {...props} note={note} noteHasSpoilers noteMasked />,
    );

    await fireEvent.press(view.getByLabelText('Contains spoilers for Inception. Show the note.'));
    expect(view.getByText(note)).toBeTruthy();
    // The claim survives the reveal — it is part of what the note says about
    // itself, not just the lock.
    expect(view.getByText('Spoilers')).toBeTruthy();
  });

  it('shows a spoiler note unmasked, with its marker, to someone who has seen it', async () => {
    const note = 'He was dead the whole time.';
    const view = await render(
      <ActivityRow {...props} note={note} noteHasSpoilers noteMasked={false} />,
    );

    expect(view.getByText(note)).toBeTruthy();
    expect(view.getByText('Spoilers')).toBeTruthy();
    expect(view.queryByText('Contains spoilers')).toBeNull();
  });
});

describe('the reaction control', () => {
  it('is absent unless the row is given one', async () => {
    const view = await render(<ActivityRow {...props} />);
    expect(view.queryByLabelText(/react/i)).toBeNull();
  });

  it('toggles on a plain tap and opens the picker on a long press', async () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    const view = await render(
      <ActivityRow {...props} reaction={{ count: 0, onPress, onLongPress }} />,
    );

    const control = view.getByLabelText(
      "React to Suraj's activity about Inception. Long press for more reactions.",
    );
    await fireEvent.press(control);
    expect(onPress).toHaveBeenCalled();

    await fireEvent(control, 'longPress');
    expect(onLongPress).toHaveBeenCalled();
  });

  it('shows the reader their own glyph, and offers to remove it', async () => {
    const view = await render(
      <ActivityRow {...props} reaction={{ count: 1, mineGlyph: '😂', onPress: jest.fn() }} />,
    );

    expect(
      view.getByLabelText('You reacted to Inception. Tap to remove, long press to change.'),
    ).toBeTruthy();
    // Hidden from the accessibility tree on purpose — the label carries the
    // meaning, and the glyph would otherwise be announced as raw emoji.
    expect(view.getAllByText('😂', { includeHiddenElements: true }).length).toBeGreaterThan(0);
  });

  /** The compact summary: glyphs and a total, never a per-kind tally in the row. */
  describe('the summary', () => {
    it('shows the glyphs present and the total, and nothing per kind', async () => {
      const view = await render(
        <ActivityRow
          {...props}
          reaction={{ count: 12, glyphs: ['❤️', '😂', '👍'], onPress: jest.fn(), onPressSummary: jest.fn() }}
        />,
      );

      expect(view.getByText('12')).toBeTruthy();
      // A per-kind breakdown in the row would put a scoreboard beside the film.
      expect(view.queryByText('❤️ 5')).toBeNull();
    });

    it('caps the glyph cluster at three', async () => {
      const view = await render(
        <ActivityRow
          {...props}
          reaction={{
            count: 20,
            glyphs: ['❤️', '😂', '👍', '👎', '😮'],
            onPress: jest.fn(),
            onPressSummary: jest.fn(),
          }}
        />,
      );

      expect(view.queryByText('😮')).toBeNull();
    });

    it('opens the detail surface when tapped', async () => {
      const onPressSummary = jest.fn();
      const view = await render(
        <ActivityRow {...props} reaction={{ count: 3, glyphs: ['❤️'], onPress: jest.fn(), onPressSummary }} />,
      );

      await fireEvent.press(view.getByLabelText('3 reactions. See who reacted.'));
      expect(onPressSummary).toHaveBeenCalled();
    });

    it('is absent when nobody has reacted', async () => {
      const view = await render(
        <ActivityRow {...props} reaction={{ count: 0, onPress: jest.fn() }} />,
      );
      expect(view.queryByLabelText(/See who reacted/)).toBeNull();
    });
  });

  it('renders the picker inside the row when it is open', async () => {
    // Inside the row rather than floating over the screen: no measurement, no
    // portal, and nothing to clip on Android.
    const view = await render(
      <ActivityRow
        {...props}
        reaction={{ count: 0, onPress: jest.fn(), picker: <Text>PICKER</Text> }}
      />,
    );
    expect(view.getByText('PICKER')).toBeTruthy();
  });
});
