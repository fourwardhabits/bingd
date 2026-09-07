import { fireEvent, render, screen } from '@testing-library/react-native';

import { EpisodeRow } from './EpisodeRow';

const LONG =
  'Walt and Jesse clean up after the incident at the lab, while Skyler grows ' +
  'suspicious of the story she has been told and Hank follows a lead that takes him ' +
  'further from home than he expected.';

const OTHER =
  'Gus makes a decision that surprises everybody around him, and the consequences ' +
  'reach further than the people in the room.';

/** The clamp on the synopsis, or undefined once it is open. */
const clampOf = (text: string) => screen.getByText(text).props.numberOfLines;

/**
 * **An episode synopsis can be read to the end** (founder, physical Android,
 * 2026-09-07).
 *
 * It was clamped to three lines with no affordance past them, so a longer synopsis
 * simply stopped mid-sentence — and the episode a reader most needs the rest of is
 * exactly the one three lines could not identify. The convention borrowed here is the
 * title page's own: a Maroon `more` under clamped text, expanding in place, with no
 * `less` once it is open.
 *
 * The row is still not a control in the ranking sense. Opening a synopsis writes
 * nothing: the rankable unit is the season (PRD §10), and that has not changed.
 */
describe('an episode synopsis', () => {
  it('opens clamped, with a way past the clamp', async () => {
    await render(<EpisodeRow episodeNumber={3} title="Bug" overview={LONG} />);

    expect(clampOf(LONG)).toBe(3);
    expect(screen.getByText('more')).toBeTruthy();
  });

  it('expands in place when the affordance is pressed', async () => {
    await render(<EpisodeRow episodeNumber={3} title="Bug" overview={LONG} />);

    await fireEvent.press(screen.getByLabelText('Expand description'));

    // In place: the same text node, unclamped. Nothing navigated, nothing opened.
    expect(clampOf(LONG)).toBeUndefined();
    expect(screen.getByText(LONG)).toBeTruthy();
  });

  it('drops the affordance once there is nothing left to promise', async () => {
    // The title page's synopsis sets this convention: no `less`.
    await render(<EpisodeRow episodeNumber={3} title="Bug" overview={LONG} />);

    await fireEvent.press(screen.getByLabelText('Expand description'));

    expect(screen.queryByText('more')).toBeNull();
    expect(screen.queryByText('less')).toBeNull();
  });

  it('still closes on a second press, even with the affordance gone', async () => {
    await render(<EpisodeRow episodeNumber={3} title="Bug" overview={LONG} />);

    await fireEvent.press(screen.getByLabelText('Expand description'));
    await fireEvent.press(screen.getByLabelText('Collapse description'));

    expect(clampOf(LONG)).toBe(3);
    expect(screen.getByText('more')).toBeTruthy();
  });

  it('opens one episode without opening another', async () => {
    // Twenty-odd rows on a season page, each its own question. Scannability is kept by
    // the default rather than by a ceiling.
    await render(
      <>
        <EpisodeRow episodeNumber={3} title="Bug" overview={LONG} />
        <EpisodeRow episodeNumber={4} title="Phoenix" overview={OTHER} />
      </>,
    );

    await fireEvent.press(screen.getAllByLabelText('Expand description')[0]!);

    expect(clampOf(LONG)).toBeUndefined();
    expect(clampOf(OTHER)).toBe(3);
  });

  it('says nothing where the provider published no synopsis', async () => {
    // An unaired episode legitimately has none, and a control over absent text would
    // be an affordance that opens nothing.
    await render(<EpisodeRow episodeNumber={9} title="Unaired" overview={null} />);

    expect(screen.queryByText('more')).toBeNull();
    expect(screen.queryByLabelText('Expand description')).toBeNull();
  });

  it('reads the whole row as one thing, synopsis included', async () => {
    await render(
      <EpisodeRow episodeNumber={3} title="Bug" airDate="12 May 2012" overview={LONG} />,
    );

    // The recognition cues in the order the eye takes them, unchanged by the clamp:
    // a screen reader was never subject to it.
    expect(
      screen.getByLabelText(`3 · Bug. 12 May 2012. ${LONG}`, { includeHiddenElements: true }),
    ).toBeTruthy();
  });

  it('keeps its state per row when several are long', async () => {
    await render(
      <>
        <EpisodeRow episodeNumber={1} title="One" overview={LONG} />
        <EpisodeRow episodeNumber={2} title="Two" overview={OTHER} />
      </>,
    );

    for (const control of screen.getAllByLabelText('Expand description')) {
      await fireEvent.press(control);
    }

    expect(clampOf(LONG)).toBeUndefined();
    expect(clampOf(OTHER)).toBeUndefined();
    expect(screen.queryByText('more')).toBeNull();
  });
});
