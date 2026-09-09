import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { TitleReviews } from './TitleReviews';
import type { ReviewSort, TitleReview } from './use-title-reviews';

/**
 * The Reviews tab's controls — 20260911000100.
 *
 * Two things are being pinned here and they pull in opposite directions. The sort row has
 * to obey the sort contract (`ui/sort.ts`): a label names its axis, the arrow says the
 * direction, and pressing the active axis flips it. And **Following has to stay a
 * filter** — the same row, the same shape, and no second tap that means anything, because
 * the server implements no ascending sense for it.
 *
 * The Helpful control is the other half: it must be absent on the reader's own review,
 * because `set_review_helpful` refuses a self-vote and a control whose only outcome is an
 * error is not a control.
 */

const VIEWER = 'viewer-1';

const review = (over: Partial<TitleReview> & { id: string }): TitleReview => ({
  userId: `author-${over.id}`,
  username: `author_${over.id}`,
  name: `Author ${over.id}`,
  avatarUri: null,
  score: 8.4,
  text: 'The last twenty minutes are the whole film.',
  hasSpoilers: false,
  updatedAt: '2026-09-01T10:00:00.000Z',
  reactionCount: 0,
  helpfulCount: 0,
  viewerHelpful: false,
  ...over,
});

const open = (
  over: {
    reviews?: TitleReview[];
    sort?: ReviewSort;
    onChangeSort?: (sort: ReviewSort) => void;
    onToggleHelpful?: (review: TitleReview) => void;
  } = {},
) =>
  renderWithProviders(
    <TitleReviews
      reviews={over.reviews ?? [review({ id: 'a' }), review({ id: 'b' })]}
      loading={false}
      sort={over.sort ?? 'top_desc'}
      onChangeSort={over.onChangeSort ?? (() => {})}
      onToggleHelpful={over.onToggleHelpful ?? (() => {})}
      maskedFor={() => false}
      onPressAuthor={() => {}}
      viewerRanked
      viewerHasReview={false}
      onWrite={() => {}}
      noun="film"
      viewerId={VIEWER}
    />,
  );

describe('the sort row', () => {
  it('opens on Top, descending, and says so where the arrow cannot be seen', async () => {
    const view = await open();

    const top = view.getByRole('tab', { name: 'Top, most helpful first' });
    expect(top.props.accessibilityState.selected).toBe(true);
    // The arrow is the visible half of rule 5; the spoken label above is the other half.
    expect(view.getByText('Top ↓')).toBeTruthy();
  });

  it('flips Top when the active axis is pressed again', async () => {
    const onChangeSort = jest.fn();
    const view = await open({ sort: 'top_desc', onChangeSort });

    fireEvent.press(view.getByRole('tab', { name: 'Top, most helpful first' }));
    expect(onChangeSort).toHaveBeenCalledWith('top_asc');
  });

  it('draws the reversed arrow once it has flipped', async () => {
    const view = await open({ sort: 'top_asc' });

    expect(view.getByText('Top ↑')).toBeTruthy();
    expect(view.getByRole('tab', { name: 'Top, least helpful first' })).toBeTruthy();
  });

  it('enters Recent descending from Top rather than inheriting a direction', async () => {
    const onChangeSort = jest.fn();
    const view = await open({ sort: 'top_asc', onChangeSort });

    fireEvent.press(view.getByRole('tab', { name: 'Recent' }));
    expect(onChangeSort).toHaveBeenCalledWith('recent_desc');
  });

  it('flips Recent when the active axis is pressed again', async () => {
    const onChangeSort = jest.fn();
    const view = await open({ sort: 'recent_desc', onChangeSort });

    fireEvent.press(view.getByRole('tab', { name: 'Recent, newest first' }));
    expect(onChangeSort).toHaveBeenCalledWith('recent_asc');
  });

  /**
   * The rule that separates a filter from a sort, asserted as two entries rather than one.
   *
   * The natural way to write it is one test that presses Following twice and checks the
   * answer never changes. **Do not.** Pressing the same element twice inside one test
   * leaves this file's renderer in a state where every subsequent `render` returns an
   * empty tree, so the nine tests after it fail with "unable to find" rather than with
   * anything that points at the cause. Two tests, one press each, assert exactly the same
   * thing: entering Following, and pressing it while it is already the active control.
   */
  it('enters Following as a filter, from another axis', async () => {
    const onChangeSort = jest.fn();
    const view = await open({ sort: 'top_desc', onChangeSort });

    fireEvent.press(view.getByRole('tab', { name: 'Following' }));
    expect(onChangeSort).toHaveBeenCalledWith('following');
  });

  it('stays Following when the active control is pressed again, with no direction', async () => {
    const onChangeSort = jest.fn();
    const view = await open({ sort: 'following', onChangeSort });

    fireEvent.press(view.getByRole('tab', { name: 'Following' }));

    expect(onChangeSort).toHaveBeenCalledWith('following');
    // And no arrow, in either direction — the visible half of the same rule.
    expect(view.queryByText('Following ↓')).toBeNull();
    expect(view.queryByText('Following ↑')).toBeNull();
  });

  it('stays available under Following even when the filter emptied the list', async () => {
    // Otherwise the only way back from an empty Following is to leave the tab.
    const view = await open({ reviews: [], sort: 'following' });
    expect(view.getByRole('tab', { name: 'Following' })).toBeTruthy();
  });

  it('is absent when there is nothing to order', async () => {
    const view = await open({ reviews: [review({ id: 'only' })] });
    expect(view.queryByRole('tab', { name: 'Top, most helpful first' })).toBeNull();
  });
});

describe('the Helpful control', () => {
  it('offers the mark, and reports the count in words to a screen reader', async () => {
    const view = await open({
      reviews: [review({ id: 'a', helpfulCount: 4, viewerHelpful: false })],
    });

    expect(view.getByText('Helpful · 4')).toBeTruthy();
    expect(
      view.getByLabelText(/Mark Author a's review helpful\. 4 people found this helpful/),
    ).toBeTruthy();
  });

  it('reads as unmarked and countless before anybody has said so', async () => {
    const view = await open({ reviews: [review({ id: 'a' })] });

    expect(view.getByText('Helpful')).toBeTruthy();
    expect(view.getByLabelText(/Nobody has marked it yet/)).toBeTruthy();
  });

  it('shows the viewer’s own mark as selected', async () => {
    const view = await open({
      reviews: [review({ id: 'a', helpfulCount: 1, viewerHelpful: true })],
    });

    const control = view.getByLabelText(/Helpful, marked by you/);
    expect(control.props.accessibilityState.selected).toBe(true);
  });

  it('asks to toggle, carrying the review it belongs to', async () => {
    const onToggleHelpful = jest.fn();
    const one = review({ id: 'a', helpfulCount: 2, viewerHelpful: false });
    const view = await open({ reviews: [one], onToggleHelpful });

    fireEvent.press(view.getByLabelText(/Mark Author a's review helpful/));
    expect(onToggleHelpful).toHaveBeenCalledWith(one);
  });

  it('is absent on the viewer’s own review, which the server refuses anyway', async () => {
    const mine = review({ id: 'mine', userId: VIEWER, helpfulCount: 3 });
    const view = await open({ reviews: [mine, review({ id: 'theirs' })] });

    expect(view.queryByLabelText(/Mark Author mine's review helpful/)).toBeNull();
    // The count is still shown to them: an author may see that their writing landed.
    expect(view.getByText('3 people found this helpful')).toBeTruthy();
  });

  it('says nothing at all on the viewer’s own unmarked review', async () => {
    const mine = review({ id: 'mine', userId: VIEWER, helpfulCount: 0 });
    const view = await open({ reviews: [mine] });

    expect(view.queryByText(/found this helpful/)).toBeNull();
    expect(view.queryByText('Helpful')).toBeNull();
  });
});

describe('the empty states', () => {
  it('invites the first review when there are none', async () => {
    const view = await open({ reviews: [], sort: 'top_desc' });

    await waitFor(() => expect(view.getByText('No reviews yet')).toBeTruthy());
    expect(view.getByText('Be the first to leave a review of this film.')).toBeTruthy();
  });

  it('says which filter emptied it under Following', async () => {
    const view = await open({ reviews: [], sort: 'following' });

    await waitFor(() =>
      expect(view.getByText('No reviews from people you follow yet')).toBeTruthy(),
    );
    // Not the generic one: a reader who filtered to Following and met "Be the first"
    // would think nobody had written anything at all.
    expect(view.queryByText('No reviews yet')).toBeNull();
  });
});
