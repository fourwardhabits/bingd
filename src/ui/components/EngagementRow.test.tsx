import { fireEvent, render, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { theme } from '../tokens';

import {
  actionCount,
  ENGAGEMENT_EDGE,
  EngagementRow,
  wordsWidth,
  type ActivityReaction,
} from './EngagementRow';

/**
 * **One engagement row for every Feed post** (founder, 2026-11-19): labelled Like, Comment,
 * Save and Share in equal 44pt columns, each drawn only where its caller wired it.
 */

const reaction = (extra: Partial<ActivityReaction> = {}): ActivityReaction => ({
  count: 0,
  onPress: jest.fn(),
  onLongPress: jest.fn(),
  onPressSummary: jest.fn(),
  ...extra,
});

const base = { actorName: 'Ada', subject: 'Oppenheimer', testID: 'row' };

const style = (node: { props: { style?: unknown } }) =>
  StyleSheet.flatten(node.props.style as never) as Record<string, unknown>;

describe('which actions appear', () => {
  it('an individual title: Like, Comment, Save and Share, each labelled', async () => {
    const view = await render(
      <EngagementRow
        {...base}
        reaction={reaction()}
        onPressComments={jest.fn()}
        onPressSave={jest.fn()}
        onPressShare={jest.fn()}
      />,
    );
    expect(within(view.getByTestId('row-like')).getByText('Like')).toBeTruthy();
    expect(within(view.getByTestId('row-comment')).getByText('Comment')).toBeTruthy();
    expect(within(view.getByTestId('row-save')).getByText('Save')).toBeTruthy();
    expect(within(view.getByTestId('row-share')).getByText('Share')).toBeTruthy();
  });

  it('an award or a group: Like and Comment, and no Save or Share invented', async () => {
    const view = await render(
      <EngagementRow
        {...base}
        subject="Tourist"
        reaction={reaction()}
        onPressComments={jest.fn()}
      />,
    );
    expect(view.getByTestId('row-like')).toBeTruthy();
    expect(view.getByTestId('row-comment')).toBeTruthy();
    expect(view.queryByTestId('row-save')).toBeNull();
    expect(view.queryByTestId('row-share')).toBeNull();
    expect(view.queryByText('Save')).toBeNull();
    expect(view.queryByText('Share')).toBeNull();
  });

  it('no Like where the reader cannot react, and nothing at all with nothing wired', async () => {
    const view = await render(
      <EngagementRow
        {...base}
        reaction={reaction({ canReact: false })}
        onPressComments={jest.fn()}
      />,
    );
    expect(view.queryByTestId('row-like')).toBeNull();
    expect(view.getByTestId('row-comment')).toBeTruthy();

    const empty = await render(<EngagementRow {...base} reaction={null} />);
    expect(empty.queryByTestId('row-actions')).toBeNull();
  });
});

describe('the layout', () => {
  it('gives a pair of actions equal columns, at least 44pt each way, contents centred', async () => {
    const view = await render(
      <EngagementRow {...base} reaction={reaction()} onPressComments={jest.fn()} />,
    );
    const columns = ['row-like', 'row-comment'].map((id) => style(view.getByTestId(id)));
    for (const column of columns) {
      expect(column).toMatchObject({
        flexGrow: 1,
        flexBasis: 0,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space[1],
      });
      expect(column.minHeight).toBeGreaterThanOrEqual(44);
      expect(column.minWidth).toBeGreaterThanOrEqual(44);
    }
    expect(new Set(columns.map((column) => JSON.stringify(column))).size).toBe(1);
    expect(style(view.getByTestId('row-actions')).justifyContent).toBeUndefined();
  });

  /**
   * Three or more (founder, 2026-11-23): sized to their words and spread across the host's
   * inset, so "Comment (3)" is never squeezed into a third of the row and cut off.
   */
  it('spreads three actions by their own width across the host inset, 44pt each', async () => {
    const view = await render(
      <EngagementRow
        {...base}
        reaction={reaction({ count: 2 })}
        onPressComments={jest.fn()}
        commentCount={3}
        onPressShare={jest.fn()}
        spreadInset={12}
      />,
    );
    expect(style(view.getByTestId('row-actions'))).toMatchObject({
      justifyContent: 'space-between',
      paddingHorizontal: 12,
    });
    for (const id of ['row-like', 'row-comment', 'row-share']) {
      const box = style(view.getByTestId(id));
      expect(box.flexGrow).toBe(0);
      expect(box.flexBasis).toBeUndefined();
      expect(box.minHeight).toBeGreaterThanOrEqual(44);
      expect(box.minWidth).toBeGreaterThanOrEqual(44);
    }
    // Only an action with a count may give up width (its count then wraps below the word);
    // a bare word never shrinks, so it can never break.
    expect(style(view.getByTestId('row-like')).flexShrink).toBe(1);
    expect(style(view.getByTestId('row-comment')).flexShrink).toBe(1);
    expect(style(view.getByTestId('row-share')).flexShrink).toBe(0);
  });

  it('spreads on ENGAGEMENT_EDGE when the host names no inset', async () => {
    const view = await render(
      <EngagementRow
        {...base}
        reaction={reaction()}
        onPressComments={jest.fn()}
        onPressShare={jest.fn()}
      />,
    );
    expect(style(view.getByTestId('row-actions')).paddingHorizontal).toBe(ENGAGEMENT_EDGE);
  });

  it('never caps, ellipsizes or shrinks a label', async () => {
    const view = await render(
      <EngagementRow
        {...base}
        reaction={reaction({ count: 2 })}
        onPressComments={jest.fn()}
        commentCount={3}
        onPressShare={jest.fn()}
      />,
    );
    for (const [id, word] of [
      ['row-like', 'Like (2)'],
      ['row-comment', 'Comment (3)'],
      ['row-share', 'Share'],
    ]) {
      const label = within(view.getByTestId(id!)).getByText(word!);
      expect(label.props.numberOfLines).toBeUndefined();
      expect(label.props.ellipsizeMode).toBeUndefined();
      expect(label.props.adjustsFontSizeToFit).toBeFalsy();
      expect(label.props.minimumFontScale).toBeUndefined();
    }
  });

  /**
   * The arithmetic the narrowest phone at large text depends on. At 320pt and 130% text,
   * with counts of (12K) and (1.2K), the words alone (each beside its 20pt icon) fit the
   * spread row inside the card's inset, so at worst the counts drop below their words and
   * nothing is cut.
   */
  it('fits the three words at 320pt and 1.3x text, counts free to drop below', () => {
    const row = 320 - 16 * 2 - 2 - 12 * 2;
    const font = theme.typography.footnote.fontSize * 1.3;
    expect(wordsWidth(['Liked', 'Comment', 'Share'], font)).toBeLessThanOrEqual(row);
    // And the bound is honest: past it, the words genuinely do not fit.
    expect(wordsWidth(['Liked', 'Comment', 'Share'], font * 1.1)).toBeGreaterThan(row);
  });

  /**
   * The last resort (Codex review): with no counts to drop and text large enough that
   * the bare words overflow the row, the row wraps onto a second line rather than pushing
   * Share out of the card, where the card would clip it.
   */
  it('wraps the row when even the bare words cannot fit it, and only then', async () => {
    const view = await render(
      <EngagementRow
        {...base}
        reaction={reaction()}
        onPressComments={jest.fn()}
        onPressShare={jest.fn()}
        spreadInset={12}
      />,
    );
    const row = () => view.getByTestId('row-actions');
    expect(style(row()).flexWrap).toBeUndefined();
    const font = theme.typography.footnote.fontSize * 2;
    const needed = wordsWidth(['Like', 'Comment', 'Share'], font);
    // A 320pt card's row at 200% text: too narrow for the words, so it wraps.
    await fireEvent(row(), 'layout', {
      nativeEvent: { layout: { width: 262 + 24, height: 44 } },
    });
    expect(262).toBeLessThan(needed);
    expect(style(row()).flexWrap).toBe('wrap');
    for (const id of ['row-like', 'row-comment', 'row-share']) {
      expect(style(view.getByTestId(id)).flexShrink).toBe(0);
      expect(style(view.getByTestId(id)).minHeight).toBeGreaterThanOrEqual(44);
    }
    // Wide enough again (a tablet): one line.
    await fireEvent(row(), 'layout', { nativeEvent: { layout: { width: 900, height: 44 } } });
    expect(style(row()).flexWrap).toBeUndefined();
  });

  it('wraps a pair too, rather than break a word, at extreme sizes', async () => {
    const view = await render(
      <EngagementRow {...base} reaction={reaction()} onPressComments={jest.fn()} />,
    );
    const row = () => view.getByTestId('row-actions');
    await fireEvent(row(), 'layout', { nativeEvent: { layout: { width: 120, height: 44 } } });
    expect(style(row()).flexWrap).toBe('wrap');
    expect(style(view.getByTestId('row-comment')).flexGrow).toBe(0);
  });

  it('draws every label in full at 320pt and 1.3x text with (12K) and (1.2K)', async () => {
    const view = await render(
      <EngagementRow
        {...base}
        reaction={reaction({ count: 12_345, mineGlyph: '❤️', mineLabel: 'Liked' })}
        onPressComments={jest.fn()}
        commentCount={1234}
        onPressShare={jest.fn()}
        spreadInset={12}
      />,
    );
    expect(within(view.getByTestId('row-like')).getByText('Liked (12K)')).toBeTruthy();
    expect(within(view.getByTestId('row-comment')).getByText('Comment (1.2K)')).toBeTruthy();
    expect(within(view.getByTestId('row-share')).getByText('Share')).toBeTruthy();
    // The word and its count are joined by an ordinary space: the count may wrap, whole.
    const comment = within(view.getByTestId('row-comment')).getByText('Comment (1.2K)');
    expect(comment.props.children).toEqual(['Comment', ' ', expect.anything()]);
  });
});

describe('the Like', () => {
  it('toggles on a tap and opens the picker on a long press', async () => {
    const like = reaction();
    const view = await render(<EngagementRow {...base} reaction={like} />);
    await fireEvent.press(view.getByTestId('row-like'));
    expect(like.onPress).toHaveBeenCalledTimes(1);
    await fireEvent(view.getByTestId('row-like'), 'longPress');
    expect(like.onLongPress).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('row-like').props.accessibilityHint).toBe(
      'Long press to choose a different reaction',
    );
  });

  it('is the reader’s own reaction once set, named, in the same fixed slot', async () => {
    const view = await render(
      <EngagementRow
        {...base}
        reaction={reaction({ count: 1, mineGlyph: '😂', mineLabel: 'Laugh' })}
      />,
    );
    const like = view.getByTestId('row-like');
    expect(like.props.accessibilityState).toMatchObject({ selected: true });
    expect(within(like).getByText('Laugh (1)')).toBeTruthy();
    expect(within(like).getByTestId('reaction-slot')).toBeTruthy();
    expect(like.props.accessibilityLabel).toBe(
      'Laugh. You reacted to Oppenheimer. 1 reaction. Tap to remove, long press to change.',
    );
  });

  it('names the post it acts on for a screen reader', async () => {
    const view = await render(
      <EngagementRow {...base} subject="Tourist" reaction={reaction()} />,
    );
    expect(view.getByTestId('row-like').props.accessibilityLabel).toBe(
      "React to Ada's activity about Tourist. Long press for more reactions.",
    );
  });
});

describe('Comment, Save and Share', () => {
  it('Comment keeps its word and adds its count once there is one, and opens the sheet', async () => {
    const open = jest.fn();
    const view = await render(
      <EngagementRow {...base} onPressComments={open} commentCount={3} />,
    );
    const comment = view.getByTestId('row-comment');
    expect(within(comment).getByText('Comment (3)')).toBeTruthy();
    expect(comment.props.accessibilityLabel).toBe(
      "3 comments on Ada's activity about Oppenheimer. Open them.",
    );
    await fireEvent.press(comment);
    expect(open).toHaveBeenCalledTimes(1);

    const one = await render(
      <EngagementRow {...base} onPressComments={open} commentCount={1} />,
    );
    expect(one.getByTestId('row-comment').props.accessibilityLabel).toMatch(/^1 comment on /);
  });

  it('Save says what it will do and what it did; Share names the title', async () => {
    const save = jest.fn();
    const share = jest.fn();
    const view = await render(
      <EngagementRow {...base} onPressSave={save} onPressShare={share} />,
    );
    expect(view.getByLabelText('Add Oppenheimer to your watchlist')).toBeTruthy();
    await fireEvent.press(view.getByTestId('row-save'));
    expect(save).toHaveBeenCalledTimes(1);
    await fireEvent.press(view.getByLabelText('Share Oppenheimer with a friend'));
    expect(share).toHaveBeenCalledTimes(1);

    const saved = await render(<EngagementRow {...base} onPressSave={save} saved />);
    expect(within(saved.getByTestId('row-save')).getByText('Saved')).toBeTruthy();
    expect(saved.getByTestId('row-save').props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(saved.getByLabelText('Oppenheimer is in your watchlist')).toBeTruthy();
  });
});

/**
 * **One count convention on every post** (refined card feed, 2026-11-22): the word, then
 * the count once there is activity; never a `0`.
 */
describe('counts', () => {
  const words = (node: { props: { children?: unknown } }): string => {
    const walk = (value: unknown): string =>
      typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : Array.isArray(value)
          ? value.map(walk).join('')
          : value && typeof value === 'object' && 'props' in value
            ? walk((value as { props: { children?: unknown } }).props.children)
            : '';
    return walk(node.props.children).replace(/\u00A0/g, ' ');
  };

  it('Like and Comment read the same way: the word, then the count', async () => {
    const view = await render(
      <EngagementRow
        {...base}
        reaction={reaction({ count: 4 })}
        onPressComments={jest.fn()}
        commentCount={2}
        onPressShare={jest.fn()}
      />,
    );
    expect(within(view.getByTestId('row-like')).getByText('Like (4)')).toBeTruthy();
    expect(within(view.getByTestId('row-comment')).getByText('Comment (2)')).toBeTruthy();
    // Share has no count to show.
    expect(within(view.getByTestId('row-share')).getByText('Share')).toBeTruthy();
    expect(view.getByTestId('row-like').props.accessibilityLabel).toBe(
      "React to Ada's activity about Oppenheimer. 4 reactions. Long press for more reactions.",
    );
  });

  it('draws no zero: with no activity each action is its word alone', async () => {
    const view = await render(
      <EngagementRow
        {...base}
        reaction={reaction({ count: 0 })}
        onPressComments={jest.fn()}
        commentCount={0}
      />,
    );
    const like = within(view.getByTestId('row-like')).getByText(/Like/);
    const comment = within(view.getByTestId('row-comment')).getByText(/Comment/);
    expect(words(like)).toBe('Like');
    expect(words(comment)).toBe('Comment');
    expect(view.queryByText(/\b0\b/)).toBeNull();
  });

  it('the count is "(N)", bound to its word, and only it takes the Maroon accent', async () => {
    const view = await render(
      <EngagementRow
        {...base}
        reaction={reaction({ count: 2 })}
        onPressComments={jest.fn()}
        commentCount={12}
      />,
    );
    const label = within(view.getByTestId('row-comment')).getByText('Comment (12)');
    const count = within(label).getByText('(12)');
    expect(count.props.children).toBe('(12)');
    // The word and its space are the label's own, in the action's colour.
    expect(label.props.children).toEqual(['Comment', ' ', expect.anything()]);
    expect(style(label).color).toBe(theme.text.secondary);
    expect(style(count).color).toBe(theme.semantic.action);
    expect(style(count).fontVariant).toEqual(['tabular-nums']);
    // Like reads the same way, in the same type.
    const like = within(view.getByTestId('row-like')).getByText('Like (2)');
    expect(style(within(like).getByText('(2)')).color).toBe(theme.semantic.action);
    expect(style(like).fontSize).toBe(style(label).fontSize);
  });

  it('a large count keeps the K rule inside its parentheses', async () => {
    const view = await render(
      <EngagementRow {...base} onPressComments={jest.fn()} commentCount={1234} />,
    );
    expect(within(view.getByTestId('row-comment')).getByText('Comment (1.2K)')).toBeTruthy();
    expect(view.getByTestId('row-comment').props.accessibilityLabel).toMatch(
      /^1234 comments on /,
    );
  });

  it('Liked keeps its word and adds "(N)" in the same style', async () => {
    const view = await render(
      <EngagementRow
        {...base}
        reaction={reaction({ count: 3, mineGlyph: '❤️', mineLabel: 'Liked' })}
      />,
    );
    const like = within(view.getByTestId('row-like')).getByText('Liked (3)');
    expect(style(within(like).getByText('(3)')).color).toBe(theme.semantic.action);
    expect(view.getByTestId('row-like').props.accessibilityLabel).toMatch(/3 reactions\./);
  });

  it('compacts a large count', () => {
    expect(actionCount(0)).toBeNull();
    expect(actionCount(-3)).toBeNull();
    expect(actionCount(Number.NaN)).toBeNull();
    expect(actionCount(1)).toBe('1');
    expect(actionCount(999)).toBe('999');
    expect(actionCount(1000)).toBe('1K');
    expect(actionCount(1234)).toBe('1.2K');
    expect(actionCount(9999)).toBe('9.9K');
    expect(actionCount(12_345)).toBe('12K');
  });
});
