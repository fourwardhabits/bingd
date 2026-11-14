import { fireEvent, within } from '@testing-library/react-native';
import { readFileSync } from 'fs';
import { join } from 'path';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import {
  ReviewCard,
  formatReviewDate,
  helpfulCountCopy,
  type ReviewCardProps,
  type ReviewCardReview,
} from './ReviewCard';

/**
 * **The shared review card** (FU1113-F, F1–F3).
 *
 * One component for the title page's preview, the See all sheet and the original tab, so
 * what is pinned here is what every review surface does: who wrote it and when at the top
 * left, the one action at the top right (Edit on yours, the thumbs-up on anybody else's),
 * the text with its spoiler and clamp treatment, and the count in words at the bottom left.
 */

const theirs = (over: Partial<ReviewCardReview> = {}): ReviewCardReview => ({
  id: 'um-1',
  username: 'Reader A',
  date: '14 Nov 2026',
  text: 'The last twenty minutes are the whole film.',
  spoilers: false,
  helpfulCount: 0,
  viewerHelpful: false,
  isOwn: false,
  ...over,
});

const mine = (over: Partial<ReviewCardReview> = {}) =>
  theirs({ id: 'um-mine', username: 'Reader B', isOwn: true, ...over });

const draw = (props: Partial<ReviewCardProps> & { review: ReviewCardReview }) =>
  renderWithProviders(<ReviewCard {...props} />);

const flat = (node: { props: { style?: unknown } }) =>
  StyleSheet.flatten(
    typeof node.props.style === 'function'
      ? (node.props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
      : node.props.style,
  ) as Record<string, unknown>;

describe('the own review (F2)', () => {
  it('shows name, date and text, with Edit at the top right opening the editor', async () => {
    const onEdit = jest.fn();
    const view = await draw({ review: mine(), onEdit, onToggleHelpful: jest.fn() });

    const head = within(view.getByTestId('review-card-head'));
    expect(head.getByText('Reader B')).toBeTruthy();
    expect(head.getByText('14 Nov 2026')).toBeTruthy();
    expect(view.getByText('The last twenty minutes are the whole film.')).toBeTruthy();

    const edit = head.getByRole('button', { name: 'Edit your review' });
    await fireEvent.press(edit);
    expect(onEdit).toHaveBeenCalledTimes(1);
    // The Edit glyph is B's shared one, not a local copy.
    expect(head.getByTestId('edit-review')).toBeTruthy();
  });

  it('has no "Your review" label and no Helpful control, even when one is offered', async () => {
    const view = await draw({ review: mine(), onEdit: jest.fn(), onToggleHelpful: jest.fn() });

    expect(view.queryByText(/Your review/)).toBeNull();
    expect(view.queryByTestId('review-helpful')).toBeNull();
    expect(view.queryByRole('button', { name: /helpful/i })).toBeNull();
  });

  it('shows its count when somebody found it helpful, and nothing at zero', async () => {
    const some = await draw({ review: mine({ helpfulCount: 2 }), onEdit: jest.fn() });
    expect(some.getByText('2 people found this helpful')).toBeTruthy();

    const none = await draw({ review: mine({ helpfulCount: 0 }), onEdit: jest.fn() });
    expect(none.queryByTestId('review-helpful-count')).toBeNull();
  });

  it('never masks your own spoiler review, and still says it carries spoilers', async () => {
    const view = await draw({
      review: mine({ spoilers: true, text: 'He was dead all along.' }),
      masked: true,
      onEdit: jest.fn(),
    });
    expect(view.getByText('He was dead all along.')).toBeTruthy();
    expect(view.getByText('Contains spoilers')).toBeTruthy();
  });

  it('never offers Report on your own', async () => {
    const view = await draw({ review: mine(), onEdit: jest.fn(), onReport: jest.fn() });
    expect(view.queryByTestId('review-report')).toBeNull();
  });
});

describe('somebody else’s review (F3)', () => {
  it('offers an outline thumbs-up at the top right, unselected', async () => {
    const view = await draw({ review: theirs(), onToggleHelpful: jest.fn() });

    const head = within(view.getByTestId('review-card-head'));
    const control = head.getByRole('button', { name: 'Mark review helpful' });
    expect(control.props.accessibilityState).toMatchObject({ selected: false, busy: false });
    expect(head.queryByTestId('edit-review')).toBeNull();
    expect(view.getByTestId('review-helpful-outline', { includeHiddenElements: true })).toBeTruthy();
    expect(view.queryByTestId('review-helpful-filled', { includeHiddenElements: true })).toBeNull();
  });

  it('is a full 44pt target', async () => {
    const view = await draw({ review: theirs(), onToggleHelpful: jest.fn() });
    const style = flat(view.getByTestId('review-helpful'));
    expect(style.minWidth).toBe(theme.layout.minTapTarget);
    expect(style.minHeight).toBe(theme.layout.minTapTarget);
  });

  it('shows the viewer’s vote filled and selected, and offers to remove it', async () => {
    const view = await draw({
      review: theirs({ helpfulCount: 1, viewerHelpful: true }),
      onToggleHelpful: jest.fn(),
    });

    const control = view.getByRole('button', { name: 'Remove helpful' });
    expect(control.props.accessibilityState).toMatchObject({ selected: true });
    expect(view.getByTestId('review-helpful-filled', { includeHiddenElements: true })).toBeTruthy();
    expect(view.getByText('1 person found this helpful')).toBeTruthy();
  });

  it('asks to toggle on a tap', async () => {
    const onToggleHelpful = jest.fn();
    const view = await draw({ review: theirs(), onToggleHelpful });
    await fireEvent.press(view.getByTestId('review-helpful'));
    expect(onToggleHelpful).toHaveBeenCalledTimes(1);
  });

  it('is announced busy and ignores a second tap while its vote is in flight', async () => {
    const onToggleHelpful = jest.fn();
    const view = await draw({
      review: theirs({ viewerHelpful: true, helpfulCount: 1 }),
      onToggleHelpful,
      helpfulPending: true,
    });
    const control = view.getByTestId('review-helpful');
    expect(control.props.accessibilityState).toMatchObject({ busy: true, selected: true });
    await fireEvent.press(control);
    expect(onToggleHelpful).not.toHaveBeenCalled();
  });

  it('masks a spoiler for a reader who has not seen it, with no words in the tree', async () => {
    const view = await draw({
      review: theirs({ spoilers: true, text: 'He was dead all along.' }),
      masked: true,
      noun: 'movie',
      onToggleHelpful: jest.fn(),
    });
    expect(view.queryByText(/dead all along/)).toBeNull();
    expect(
      view.getByRole('button', { name: 'Contains spoilers for movie. Show the review.' }),
    ).toBeTruthy();
    // The vote stays available on a masked review.
    expect(view.getByRole('button', { name: 'Mark review helpful' })).toBeTruthy();
  });

  it('keeps the author’s score and Report beside the review', async () => {
    const onReport = jest.fn();
    const view = await draw({
      review: theirs(),
      score: 8.4,
      onToggleHelpful: jest.fn(),
      onReport,
    });
    expect(view.getByLabelText('8.4 out of 10')).toBeTruthy();
    await fireEvent.press(view.getByRole('button', { name: "Report Reader A's review" }));
    expect(onReport).toHaveBeenCalled();
  });

  it('opens the author from their name when asked to', async () => {
    const onPressAuthor = jest.fn();
    const view = await draw({ review: theirs(), handle: 'reader_a', onPressAuthor });
    await fireEvent.press(view.getByRole('button', { name: 'Reader A, @reader_a' }));
    expect(onPressAuthor).toHaveBeenCalled();
  });
});

describe('long text', () => {
  it('clamps to the lines asked for, with the shared `… more` treatment', async () => {
    const text = 'one two three four five six seven eight nine ten';
    const view = await draw({ review: theirs({ text }), collapsedLines: 2 });
    // The visible block is ClampedText's: its column and measuring layer are present.
    expect(view.getByTestId('note-column')).toBeTruthy();
    expect(view.getByTestId('note-measure', { includeHiddenElements: true })).toBeTruthy();
  });

  it('draws the whole text when no clamp is asked for', async () => {
    const view = await draw({ review: theirs() });
    expect(view.queryByTestId('note-column')).toBeNull();
    expect(view.getByText('The last twenty minutes are the whole film.')).toBeTruthy();
  });
});

describe('the count copy (F3)', () => {
  it('says exactly 1 person / N people, omits zero, and never names anybody', async () => {
    expect(helpfulCountCopy(0)).toBeNull();
    expect(helpfulCountCopy(1)).toBe('1 person found this helpful');
    expect(helpfulCountCopy(3)).toBe('3 people found this helpful');

    const zero = await draw({ review: theirs({ helpfulCount: 0 }), onToggleHelpful: jest.fn() });
    expect(zero.queryByText(/found this helpful/)).toBeNull();
    const one = await draw({ review: theirs({ helpfulCount: 1 }), onToggleHelpful: jest.fn() });
    expect(one.getByTestId('review-helpful-count').props.children).toBe(
      '1 person found this helpful',
    );
    const many = await draw({ review: theirs({ helpfulCount: 3 }), onToggleHelpful: jest.fn() });
    expect(many.getByTestId('review-helpful-count').props.children).toBe(
      '3 people found this helpful',
    );
  });
});

describe('the surface (F1)', () => {
  it('is the recommendation card’s neutral raised surface with a hairline, never Parchment', async () => {
    const view = await draw({ review: theirs(), testID: 'card' });
    const style = flat(view.getByTestId('card'));
    expect(style.backgroundColor).toBe(theme.surface.raised);
    expect(style.borderColor).toBe(theme.border.hairline);
    expect(style.borderRadius).toBe(theme.radius.control);
    expect(style.backgroundColor).not.toBe(theme.surface.sunken);
  });

  it('leaves no beige (Parchment) styling in any review surface', () => {
    for (const file of ['ReviewCard.tsx', 'TitleReviews.tsx']) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      expect(source).not.toMatch(/surface\.sunken|brand\.parchment/);
    }
  });

  it('formats the date for reading, and leaves an unknown one empty', () => {
    expect(formatReviewDate(null)).toBe('');
    expect(formatReviewDate('not a date')).toBe('');
    expect(formatReviewDate('2026-11-14T10:00:00.000Z')).toMatch(/2026/);
  });
});
