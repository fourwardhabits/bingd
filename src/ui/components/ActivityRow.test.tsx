import { fireEvent, render, within } from '@testing-library/react-native';

import { StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { theme } from '../tokens';

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
      <ActivityRow {...props} title="Parks and Recreation, S2" />,
    );
    expect(view.getByText(/Parks and Recreation, S2/)).toBeTruthy();
  });

  it('opens the actor’s profile when there is one to open', async () => {
    const onPressActor = jest.fn();
    const view = await render(<ActivityRow {...props} onPressActor={onPressActor} />);

    await fireEvent.press(view.getByLabelText('Suraj’s profile'.replace('’', "'")));
    expect(onPressActor).toHaveBeenCalled();
  });
});

/**
 * Founder Feed finalization, 2026-08-20, item 1.
 *
 * The physical Android review found the row setting the actor on one line and the
 * title on the next, unconditionally — which made the film read as a field of the row
 * rather than as the object of the verb. These pin the sentence back together, and
 * they pin the *mechanism*: one text node, no explicit break, the layout free to wrap.
 */
describe('the integrated sentence', () => {
  /**
   * The character between a title and its year.
   *
   * Written out rather than typed inline because it is invisible in a diff and it is
   * the thing under test: a plain space here is a legal wrap point, and the founder's
   * rule is that the year stays with what it dates.
   */
  const NBSP = ' ';
  const withYear = (title: string, year: number) => `${title}${NBSP}(${year})`;

  /**
   * The exact characters a node renders, with no normalisation.
   *
   * The text queries run their matcher over *normalised* text, which folds a
   * non-breaking space into an ordinary one. So a query cannot tell the two apart and
   * cannot be the test for the thing under test here. Walking the tree gives the
   * characters that actually rendered.
   */
  const rawText = (node: unknown): string =>
    typeof node === 'string'
      ? node
      : (((node as { children?: unknown[] })?.children ?? []) as unknown[])
          .map(rawText)
          .join('');

  it('is one sentence — actor, verb and title in a single text node', async () => {
    const view = await render(<ActivityRow {...props} />);

    // Composed across the nested runs. If the title were a sibling block again this
    // query finds nothing, which is exactly the regression.
    expect(view.getByText(`Suraj ranked ${withYear('Inception', 2010)}`)).toBeTruthy();
  });

  it('joins the year to the title with a space that cannot be broken', async () => {
    // Independent review's finding, and the reason this is its own test. Nesting the
    // year inside the title's `Text` shares the styling and the press target but not
    // the line breaking: with an ordinary space, a title ending near the line width
    // leaves "(1982)" stranded on a line by itself.
    const view = await render(<ActivityRow {...props} title="Blade Runner" year={1982} />);

    // The query normalises, so it is only used to find the node. The assertion is on
    // the characters themselves.
    const sentence = view.getByText('Suraj ranked Blade Runner (1982)');
    expect(rawText(sentence)).toBe(`Suraj ranked ${withYear('Blade Runner', 1982)}`);
    expect(rawText(sentence)).toContain(NBSP);
    expect(rawText(sentence)).not.toContain('Blade Runner (1982)');
  });

  it('never breaks the line itself, however long the title is', async () => {
    // The founder's long case. The row must let the text engine wrap it and must not
    // insert a break of its own — an explicit "\n" is what makes a title look like a
    // second field on a short one.
    const view = await render(
      <ActivityRow {...props} title="Keep Your Hands Off Eizouken!, S1" year={2020} />,
    );

    const sentence = view.getByText(
      'Suraj ranked Keep Your Hands Off Eizouken!, S1 (2020)',
    );
    // The whole sentence, in one node, with no break of our own anywhere in it.
    expect(rawText(sentence)).toBe(
      `Suraj ranked ${withYear('Keep Your Hands Off Eizouken!, S1', 2020)}`,
    );
    expect(rawText(sentence)).not.toContain('\n');
    // Wrapping is the layout's job, and it needs room to do it.
    expect(sentence.props.numberOfLines).toBeGreaterThan(1);
  });

  it('puts a watchlist add’s clause after the title, still in one sentence', async () => {
    const view = await render(
      <ActivityRow
        {...props}
        verb="added"
        tail="to their watchlist"
        title="Dune"
        year={2021}
      />,
    );

    expect(
      view.getByText(`Suraj added ${withYear('Dune', 2021)} to their watchlist`),
    ).toBeTruthy();
  });

  it('names watch companions after the title, where they are grammatical', async () => {
    // "Suraj watched with Anna Inception" is what the old ordering became once the
    // title joined the line.
    const view = await render(
      <ActivityRow {...props} verb="watched" companions={['Anna']} />,
    );

    expect(
      view.getByText(`Suraj watched ${withYear('Inception', 2010)} with Anna`),
    ).toBeTruthy();
  });

  it('opens the title page from inside the sentence', async () => {
    const view = await render(<ActivityRow {...props} />);
    await fireEvent.press(view.getByText(withYear('Inception', 2010)));

    expect(props.onPressTitle).toHaveBeenCalled();
  });
});

/**
 * Founder Feed refinement, 2026-08-20.
 *
 * Two reports — "the row looks busy with a poster *and* a face" and "the subheading is
 * shifted relative to the sentence" — that were one defect. The sentence lived in a row
 * behind the avatar; the metadata lived in the column that row sat in. No amount of
 * styling makes two lines share a left edge while an avatar stands in front of one.
 *
 * These test the *structure* rather than pixels, because the structure is what the fix
 * is. A padding-based alignment would pass a screenshot and fail these, which is the
 * right way round: the pad is the version that drifts the moment the avatar resizes.
 */
describe('the row composition', () => {
  /** The sentence's own column, found via the sentence rather than by a test ID. */
  const copyColumn = (view: Awaited<ReturnType<typeof render>>) =>
    view.getByText(/Suraj ranked/).parent!;

  it('sets the sentence and the metadata as siblings, on one left edge', async () => {
    const view = await render(<ActivityRow {...props} onPressActor={jest.fn()} />);

    // The same parent *node*, not merely an ancestor in common: siblings in one column
    // share a left edge by construction, and there is then no offset to keep in step
    // with the leading cluster by hand. Nesting either line one level deeper — which
    // is exactly what the avatar's row did — breaks this and only this.
    const sentence = view.getByText(/Suraj ranked/);
    const metadata = view.getByText('148m · Sci-fi');
    expect(metadata.parent).toBe(sentence.parent);
  });

  it('keeps the avatar out of the sentence column entirely', async () => {
    // The regression this guards: putting the face back in front of the sentence
    // re-indents that line and only that line, which is what the founder saw.
    const view = await render(<ActivityRow {...props} onPressActor={jest.fn()} />);

    expect(within(copyColumn(view)).queryByLabelText("Suraj's profile")).toBeNull();
  });

  it('composes the actor onto the poster as one leading object', async () => {
    const view = await render(<ActivityRow {...props} onPressActor={jest.fn()} />);

    // The poster's press target and the actor chip share a container: that container
    // is the artwork's own box, which is what lets the chip sit in its corner — and
    // what keeps the chip's touches inside a parent Android will deliver them from.
    const lead = view.getByLabelText('Inception, 2010, 148m · Sci-fi').parent!;
    expect(within(lead).getByLabelText("Suraj's profile")).toBeTruthy();
  });

  it('still opens the profile from the chip, not only from the name', async () => {
    const onPressActor = jest.fn();
    const view = await render(<ActivityRow {...props} onPressActor={onPressActor} />);

    const lead = view.getByLabelText('Inception, 2010, 148m · Sci-fi').parent!;
    await fireEvent.press(within(lead).getByLabelText("Suraj's profile"));
    expect(onPressActor).toHaveBeenCalled();
  });

  it('holds the alignment when the sentence wraps and the metadata does not', async () => {
    // The founder's long case. A wrapped sentence must not move the line under it.
    const view = await render(
      <ActivityRow
        {...props}
        title="Keep Your Hands Off Eizouken!, S1"
        year={2020}
        verb="added"
        tail="to their watchlist"
        companions={['Anna']}
        metadata="TV-14 · 12 episodes · Animation · Comedy"
      />,
    );

    const sentence = view.getByText(/Suraj added/);
    const metadata = view.getByText('TV-14 · 12 episodes · Animation · Comedy');
    expect(metadata.parent).toBe(sentence.parent);
  });

  /**
   * Read off the render rather than restated from the stylesheet, so the numbers here
   * cannot agree with a copy of themselves while the component has moved on.
   */
  const styleOf = (node: unknown) =>
    (StyleSheet.flatten((node as { props: { style?: StyleProp<ViewStyle> } }).props.style) ??
      {}) as ViewStyle;

  it('keeps the chip and its whole touch box inside the poster', async () => {
    // The Android rule this exists for: touches outside a parent's bounds are not
    // delivered. A chip that overhangs the corner — or one grown past the artwork by
    // a later bump to `avatar.xxs` — is a profile link that works in review on iOS and
    // silently does not on the device. Containment is the fix and this is its guard.
    const view = await render(<ActivityRow {...props} onPressActor={jest.fn()} />);

    const chip = view.getByLabelText("Suraj's profile");
    const chipStyle = styleOf(chip);
    const ringStyle = styleOf(chip.children[0]);
    const poster = styleOf(
      view.getByLabelText('Inception, 2010, 148m · Sci-fi').children[0],
    );

    // Anchored to the corner rather than floated somewhere near it.
    expect(chipStyle.position).toBe('absolute');
    expect(chipStyle.right).toBe(0);
    expect(chipStyle.bottom).toBe(0);

    // The face, the Paper ring around it, and the padding that makes the corner
    // tappable — all of it has to fit the artwork in both axes.
    const ring = theme.layout.avatar.xxs + 2 * Number(ringStyle.padding);
    const width = ring + Number(chipStyle.paddingLeft) + Number(chipStyle.paddingRight);
    const height = ring + Number(chipStyle.paddingTop) + Number(chipStyle.paddingBottom);

    expect(width).toBeLessThanOrEqual(Number(poster.width));
    expect(height).toBeLessThanOrEqual(Number(poster.height));

    // And it is not smaller than the target this control had before the overlay: a
    // 24pt avatar with 4pt of hitSlop all round. 44 cannot be reached inside a 40pt
    // poster, but going backwards from what shipped is a regression rather than a
    // constraint — which is what independent review caught at 28.
    const wasBefore = theme.layout.avatar.xs + 2 * theme.space[1];
    expect(width).toBeGreaterThanOrEqual(wasBefore);
    expect(height).toBeGreaterThanOrEqual(wasBefore);
  });

  it('lets the poster take its own touches when the actor has no profile to open', async () => {
    /**
     * The defect independent review found, and it was not a corner case: neither
     * profile screen passes `onPressActor` at all, and the feed omits it on the
     * viewer's own rows.
     *
     * A `Pressable` with `disabled` is not inert. It declines the responder, and
     * React Native then negotiates *up* the ancestor chain — never sideways to the
     * sibling painted underneath, which is what the poster is. So a disabled chip
     * swallows the touches over its corner instead of passing them down, and a third
     * of the artwork quietly stops opening the title.
     */
    const onPressTitle = jest.fn();
    const view = await render(
      <ActivityRow {...props} onPressTitle={onPressTitle} onPressActor={undefined} />,
    );

    const lead = view.getByLabelText('Inception, 2010, 148m · Sci-fi').parent!;
    // One child is the poster's own Pressable; the chip is the other, and with no
    // profile to open it must be decoration that touches pass straight through.
    const chip = (lead.children as unknown[]).find(
      (child) => styleOf(child).position === 'absolute',
    );

    expect(chip).toBeTruthy();
    expect((chip as { props: { pointerEvents?: string } }).props.pointerEvents).toBe('none');
    // And it is not a control at all, so there is nothing for a screen reader to
    // announce twice — the actor is named in the sentence beside it.
    expect(within(lead).queryByLabelText(/profile/)).toBeNull();
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

/**
 * American Pie showed in the Feed with no runtime while other films had one.
 *
 * The cause is upstream and not a mapping bug: the row came from TMDB *search*, which
 * returns no runtime, and detail enrichment only runs when someone opens the title
 * page — which nobody had. `runtime_minutes` is genuinely null for 55 of 440 films.
 *
 * What the row owes is that one absent optional field costs exactly that field, and
 * never a stray separator or a collapsed line.
 */
describe('incomplete metadata', () => {
  it('shows the genre alone when the runtime is missing, with no dangling separator', async () => {
    const view = await render(<ActivityRow {...props} metadata="Comedy" />);

    expect(view.getByText('Comedy')).toBeTruthy();
    expect(view.queryByText(/·\s*$/)).toBeNull();
    expect(view.queryByText(/^\s*·/)).toBeNull();
  });

  it('renders the row at all when there is no metadata line whatsoever', async () => {
    const view = await render(<ActivityRow {...props} metadata={null} />);

    expect(view.getByText(/Inception/)).toBeTruthy();
    expect(view.getByText(/Suraj/)).toBeTruthy();
  });

  it('keeps the year when the metadata line is empty', async () => {
    const view = await render(<ActivityRow {...props} metadata={null} year={1999} />);
    expect(view.getByText(/1999/)).toBeTruthy();
  });
});

/**
 * Recommend, which took the slot Share used to have.
 *
 * Sharing is not gone: it is the last row of the sheet this opens. What changed is
 * that the row carries one control where it carried two, which is what stopped it
 * running past the edge of a narrow screen.
 */
describe('the recommend action', () => {
  it('is icon-first and carries no large text button', async () => {
    const onPressRecommend = jest.fn();
    const view = await render(<ActivityRow {...props} onPressRecommend={onPressRecommend} />);

    // The label names the title, so a screen reader gets the context the glyph
    // cannot carry. There is deliberately no visible word beside it.
    expect(view.queryByText('Recommend')).toBeNull();
    await fireEvent.press(view.getByLabelText('Recommend Inception to a friend'));
    expect(onPressRecommend).toHaveBeenCalled();
  });

  it('names the exact entity, so a season does not read as the whole show', async () => {
    const view = await render(
      <ActivityRow
        {...props}
        title="Parks and Recreation, S2"
        onPressRecommend={jest.fn()}
      />,
    );
    expect(
      view.getByLabelText('Recommend Parks and Recreation, S2 to a friend'),
    ).toBeTruthy();
  });

  it('is absent when the surface has not wired it up', async () => {
    const view = await render(<ActivityRow {...props} />);
    expect(view.queryByLabelText(/^Recommend /)).toBeNull();
    // And the control it replaced is gone rather than hidden.
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
    expect(view.getAllByText('Contains spoilers')[0]).toBeTruthy();
  });

  it('shows a spoiler note unmasked, with its marker, to someone who has seen it', async () => {
    const note = 'He was dead the whole time.';
    const view = await render(
      <ActivityRow {...props} note={note} noteHasSpoilers noteMasked={false} />,
    );

    expect(view.getByText(note)).toBeTruthy();
    // The founder's "subtle spoiler indicator": somebody who has seen the film reads
    // the words rather than tapping through to them, and the claim the author made is
    // still part of what the note says about itself. The three words are the same ones
    // the mask, the ranking sheet, the note control and the comment composer use.
    expect(view.getByText('Contains spoilers')).toBeTruthy();
    // And no "Show", because there is nothing hidden to reveal.
    expect(view.queryByText('Show')).toBeNull();
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

  it('marks the control as mine without repeating the glyph beside the summary', async () => {
    // The same emoji appeared twice — once counted in the cluster, once on the
    // control — and read as a duplicate rather than as two different statements.
    // The control says whether I acted; the cluster says what everyone chose.
    const view = await render(
      <ActivityRow
        {...props}
        reaction={{ count: 1, mineGlyph: '😂', glyphs: ['😂'], onPress: jest.fn(), onPressSummary: jest.fn() }}
      />,
    );

    expect(
      view.getByLabelText('You reacted to Inception. Tap to remove, long press to change.'),
    ).toBeTruthy();
    expect(view.queryByText('You')).toBeNull();
    // Exactly once on the row: in the summary cluster.
    expect(view.getAllByText('😂', { includeHiddenElements: true })).toHaveLength(1);
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

describe('the comment control', () => {
  it('is absent unless the surface has wired it up', async () => {
    // The rule that kept a placeholder off this row while comments were deferred.
    // An icon that does nothing is worse than no icon.
    const view = await render(<ActivityRow {...props} />);
    expect(view.queryByLabelText(/[Cc]omment/)).toBeNull();
  });

  it('shows the count and never a preview of what was said', async () => {
    // The founder's rule: no text preview may leak masked spoiler content. The row
    // is not given a body to leak — it takes a number, and the bodies are fetched
    // when the sheet opens. This asserts the prop shape as much as the render.
    const view = await render(
      <ActivityRow {...props} onPressComments={jest.fn()} commentCount={2} />,
    );

    expect(view.getByText('2')).toBeTruthy();
    expect(
      view.getByLabelText("2 comments on Suraj's activity about Inception. Open them."),
    ).toBeTruthy();
  });

  it('invites the first comment rather than showing a zero', async () => {
    const onPressComments = jest.fn();
    const view = await render(
      <ActivityRow {...props} onPressComments={onPressComments} commentCount={0} />,
    );

    expect(view.queryByText('0')).toBeNull();
    await fireEvent.press(
      view.getByLabelText("Comment on Suraj's activity about Inception"),
    );
    expect(onPressComments).toHaveBeenCalled();
  });
});
