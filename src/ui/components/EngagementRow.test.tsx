import { fireEvent, render, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { theme } from '../tokens';

import {
  actionCount,
  ENGAGEMENT_EDGE,
  EngagementRow,
  LABEL_MIN_SCALE,
  type ActivityReaction,
} from './EngagementRow';
import { estimateTextWidth } from './ReactionSummary';

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
  it('gives every action an equal column, at least 44pt each way, contents centred', async () => {
    const view = await render(
      <EngagementRow
        {...base}
        reaction={reaction()}
        onPressComments={jest.fn()}
        onPressSave={jest.fn()}
        onPressShare={jest.fn()}
      />,
    );
    const columns = ['row-like', 'row-comment', 'row-save', 'row-share'].map((id) =>
      style(view.getByTestId(id)),
    );
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
      // No content-sized padding: the column, not its word, sets the width.
      expect(column.paddingHorizontal ?? 0).toBe(0);
    }
    // Every column is styled identically, so none can claim more of the row than another.
    expect(new Set(columns.map((column) => JSON.stringify(column))).size).toBe(1);
  });

  it('keeps each label on one line, shrinking a little before it would truncate', async () => {
    const view = await render(
      <EngagementRow {...base} reaction={reaction()} onPressComments={jest.fn()} />,
    );
    const label = within(view.getByTestId('row-comment')).getByText('Comment');
    expect(label.props.numberOfLines).toBe(1);
    expect(label.props.adjustsFontSizeToFit).toBe(true);
    expect(label.props.minimumFontScale).toBe(LABEL_MIN_SCALE);
    expect(style(label).flexShrink).toBe(1);
  });

  /**
   * The arithmetic the 320pt and 360pt phones depend on: four columns across the screen,
   * `ENGAGEMENT_EDGE` in from each side, still hold the widest label ("Comment") beside its
   * icon at full size, and are far above the 44pt floor.
   */
  it.each([320, 360])('fits four labelled actions at %ipt without overflowing', (width) => {
    const column = (width - ENGAGEMENT_EDGE * 2) / 4;
    const footnote = theme.typography.footnote.fontSize;
    const widest = Math.max(
      ...['Like', 'Comment', 'Save', 'Saved', 'Share'].map((w) =>
        estimateTextWidth(w, footnote),
      ),
    );
    expect(column).toBeGreaterThanOrEqual(theme.layout.minTapTarget);
    expect(theme.layout.icon.sm + theme.space[1] + widest).toBeLessThanOrEqual(column);
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
    expect(within(like).getByText('Laugh 1')).toBeTruthy();
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
    expect(within(comment).getByText('Comment 3')).toBeTruthy();
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
    expect(within(view.getByTestId('row-like')).getByText('Like 4')).toBeTruthy();
    expect(within(view.getByTestId('row-comment')).getByText('Comment 2')).toBeTruthy();
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

  it('the count is bound to its word and set in tabular figures', async () => {
    const view = await render(
      <EngagementRow {...base} onPressComments={jest.fn()} commentCount={12} />,
    );
    const label = within(view.getByTestId('row-comment')).getByText('Comment 12');
    const count = within(label).getByText('12');
    expect(count.props.children).toBe('\u00A012');
    expect(style(count).fontVariant).toEqual(['tabular-nums']);
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
