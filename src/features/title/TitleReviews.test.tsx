import { Ionicons } from '@expo/vector-icons';
import { fireEvent, waitFor, within } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';
import { EDIT_ICON_NAME } from '@/ui/components';

import { REVIEWS_PREVIEW_COUNT, ReviewsPreview, TitleReviews } from './TitleReviews';
import type { ReviewOrder, TitleReview } from './use-title-reviews';

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
    sort?: ReviewOrder;
    onChangeSort?: (sort: ReviewOrder) => void;
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
  it('offers the mark as a thumbs-up, with the count in words beneath (FU1113-F)', async () => {
    const view = await open({
      reviews: [review({ id: 'a', helpfulCount: 4, viewerHelpful: false })],
    });

    const control = view.getByRole('button', { name: 'Mark review helpful' });
    expect(control.props.accessibilityState).toMatchObject({ selected: false });
    expect(view.getByHintText("Tells Author a their review helped")).toBeTruthy();
    expect(view.getByText('4 people found this helpful')).toBeTruthy();
  });

  it('reads as unmarked, with no count at all, before anybody has said so', async () => {
    const view = await open({ reviews: [review({ id: 'a' })] });

    expect(view.getByRole('button', { name: 'Mark review helpful' })).toBeTruthy();
    expect(view.queryByText(/found this helpful/)).toBeNull();
  });

  it('shows the viewer’s own mark as selected, offering to take it back', async () => {
    const view = await open({
      reviews: [review({ id: 'a', helpfulCount: 1, viewerHelpful: true })],
    });

    const control = view.getByRole('button', { name: 'Remove helpful' });
    expect(control.props.accessibilityState.selected).toBe(true);
    expect(view.getByText('1 person found this helpful')).toBeTruthy();
  });

  it('asks to toggle, carrying the review it belongs to', async () => {
    const onToggleHelpful = jest.fn();
    const one = review({ id: 'a', helpfulCount: 2, viewerHelpful: false });
    const view = await open({ reviews: [one], onToggleHelpful });

    fireEvent.press(view.getByRole('button', { name: 'Mark review helpful' }));
    expect(onToggleHelpful).toHaveBeenCalledWith(one);
  });

  it('is absent on the viewer’s own review, which the server refuses anyway', async () => {
    const mine = review({ id: 'mine', userId: VIEWER, helpfulCount: 3 });
    const view = await open({ reviews: [mine, review({ id: 'theirs' })] });

    const mineCard = within(view.getAllByTestId('review-card')[0]!);
    expect(mineCard.queryByTestId('review-helpful')).toBeNull();
    // Edit instead, top right: the one composer.
    expect(within(mineCard.getByTestId('review-card-head')).getByTestId('edit-review')).toBeTruthy();
    // The count is still shown to them: an author may see that their writing landed.
    expect(view.getByText('3 people found this helpful')).toBeTruthy();
  });

  it('says nothing at all on the viewer’s own unmarked review', async () => {
    const mine = review({ id: 'mine', userId: VIEWER, helpfulCount: 0 });
    const view = await open({ reviews: [mine] });

    expect(view.queryByText(/found this helpful/)).toBeNull();
    expect(view.queryByTestId('review-helpful')).toBeNull();
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

/**
 * The Cinematic Editorial sheet's controls (post-QA sprint 2, 2026-11-05): Most Helpful,
 * Newest, Rating and the Following filter, each reversing on a second tap where that
 * means something — and the original page's three, untouched.
 */
describe('the editorial sheet', () => {
  const sheet = (sort: ReviewOrder, onChangeSort = jest.fn(), ratingAvailable = true) =>
    renderWithProviders(
      <TitleReviews
        reviews={[review({ id: 'a' }), review({ id: 'b', userId: 'other-2' })]}
        loading={false}
        sort={sort}
        onChangeSort={onChangeSort}
        onToggleHelpful={() => {}}
        maskedFor={() => false}
        onPressAuthor={() => {}}
        viewerRanked
        viewerHasReview={false}
        onWrite={() => {}}
        noun="movie"
        viewerId={VIEWER}
        variant="editorial"
        ratingAvailable={ratingAvailable}
      />,
    );

  it('offers Helpful, Newest, Rating and Following, Most Helpful selected by default', async () => {
    const view = await sheet('top_desc');
    expect(view.getByRole('tab', { name: 'Most helpful first' })).toBeSelected();
    expect(view.getByRole('tab', { name: 'Newest' })).toBeTruthy();
    expect(view.getByRole('tab', { name: 'Rating' })).toBeTruthy();
    expect(view.getByRole('tab', { name: 'Only people you follow' })).toBeTruthy();
  });

  it('reverses the active order on a second tap, and enters another at its default', async () => {
    const onChangeSort = jest.fn();
    const helpful = await sheet('top_desc', onChangeSort);
    await fireEvent.press(helpful.getByRole('tab', { name: 'Most helpful first' }));
    await fireEvent.press(helpful.getByRole('tab', { name: 'Newest' }));
    await fireEvent.press(helpful.getByRole('tab', { name: 'Rating' }));
    expect(onChangeSort.mock.calls.map(([next]) => next)).toEqual([
      'top_asc',
      'recent_desc',
      'rating_desc',
    ]);

    const newest = jest.fn();
    const recent = await sheet('recent_desc', newest);
    await fireEvent.press(recent.getByRole('tab', { name: 'Newest first' }));
    expect(newest).toHaveBeenCalledWith('recent_asc');

    const oldest = await sheet('recent_asc');
    expect(oldest.getByRole('tab', { name: 'Oldest first' })).toBeSelected();
    expect(oldest.getByText('Oldest')).toBeTruthy();

    const rating = jest.fn();
    const rated = await sheet('rating_desc', rating);
    await fireEvent.press(rated.getByRole('tab', { name: 'Highest rated first' }));
    expect(rating).toHaveBeenCalledWith('rating_asc');
  });

  it('leaves Rating out when the list it would re-order is not complete', async () => {
    const view = await sheet('top_desc', jest.fn(), false);
    expect(view.queryByRole('tab', { name: 'Rating' })).toBeNull();
  });

  it('shows the thumbs-up Helpful as the one reaction, no heart beside it', async () => {
    const view = await renderWithProviders(
      <TitleReviews
        reviews={[review({ id: 'a', userId: 'other-1', reactionCount: 4 })]}
        loading={false}
        sort="top_desc"
        onChangeSort={() => {}}
        onToggleHelpful={() => {}}
        maskedFor={() => false}
        onPressAuthor={() => {}}
        viewerRanked
        viewerHasReview={false}
        onWrite={() => {}}
        noun="movie"
        viewerId={VIEWER}
        variant="editorial"
      />,
    );
    expect(view.getByRole('button', { name: 'Mark review helpful' })).toBeTruthy();
    expect(view.queryByText('4')).toBeNull();
  });

  it('keeps the original page on Top, Following and Recent', async () => {
    const view = await open();
    expect(view.getByRole('tab', { name: 'Top, most helpful first' })).toBeTruthy();
    expect(view.getByRole('tab', { name: 'Following' })).toBeTruthy();
    expect(view.getByRole('tab', { name: 'Recent' })).toBeTruthy();
    expect(view.queryByRole('tab', { name: 'Rating' })).toBeNull();
  });
});

describe('the reviews preview', () => {
  const base = {
    loading: false,
    maskedFor: () => false,
    viewerId: VIEWER,
    viewerRanked: true,
    ownReview: null,
    onWrite: () => {},
    onSeeAll: () => {},
    noun: 'movie',
  };
  const others = [
    review({ id: 'a', userId: 'other-1', text: 'First.' }),
    review({ id: 'b', userId: 'other-2', text: 'Second.' }),
    review({ id: 'c', userId: 'other-3', text: 'Third.' }),
  ];

  it('shows at most two, three lines each, and opens the sheet from a review', async () => {
    const onSeeAll = jest.fn();
    const view = await renderWithProviders(
      <ReviewsPreview {...base} reviews={others} onSeeAll={onSeeAll} />,
    );
    expect(REVIEWS_PREVIEW_COUNT).toBe(2);
    expect(view.getAllByTestId('review-preview')).toHaveLength(2);
    expect(view.queryByText('Third.')).toBeNull();
    const [first] = view.getAllByTestId('review-preview-body');
    if (!first) throw new Error('no preview row');
    await fireEvent.press(first);
    expect(onSeeAll).toHaveBeenCalled();
  });

  it('puts your review first and leaves yours out of the others', async () => {
    const view = await renderWithProviders(
      <ReviewsPreview
        {...base}
        reviews={[review({ id: 'mine', userId: VIEWER, text: 'Mine, from the list.' }), ...others]}
        ownReview={{ text: 'Mine.', hasSpoilers: false, updatedAt: null, helpfulCount: 2 }}
      />,
    );
    expect(view.getByTestId('your-review')).toBeTruthy();
    expect(view.getByText('2 people found this helpful')).toBeTruthy();
    expect(view.queryByText('Mine, from the list.')).toBeNull();
    expect(view.getAllByTestId('review-preview')).toHaveLength(1);
  });

  /**
   * **A person's opinion, not a block of text** (UI cohesion pass, 2026-11-06): who wrote
   * it, when, their score, and the thumbs-up as its own control.
   */
  it('names the author with a face, the date and their score', async () => {
    const view = await renderWithProviders(<ReviewsPreview {...base} reviews={others.slice(0, 1)} />);
    const head = within(view.getByTestId('review-preview')).getByTestId('review-card-head');
    expect(within(head).getByText('Author a')).toBeTruthy();
    expect(within(head).getByText(/2026/)).toBeTruthy();
    expect(within(head).getByLabelText('8.4 out of 10')).toBeTruthy();
  });

  it('marks a review helpful from the preview, without opening the sheet', async () => {
    const onSeeAll = jest.fn();
    const onToggleHelpful = jest.fn();
    const view = await renderWithProviders(
      <ReviewsPreview
        {...base}
        reviews={[review({ id: 'a', userId: 'other-1', helpfulCount: 3 })]}
        onSeeAll={onSeeAll}
        onToggleHelpful={onToggleHelpful}
      />,
    );
    const helpful = view.getByRole('button', { name: 'Mark review helpful' });
    expect(view.getByText('3 people found this helpful')).toBeTruthy();
    // Its own control, top right, not inside the press that opens the sheet.
    expect(
      within(view.getByTestId('review-preview-body')).queryByTestId('review-helpful'),
    ).toBeNull();
    expect(
      within(view.getByTestId('review-card-head')).getByTestId('review-helpful'),
    ).toBeTruthy();
    await fireEvent.press(helpful);
    expect(onToggleHelpful).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    expect(onSeeAll).not.toHaveBeenCalled();
  });

  it('shows the marked state on a review the reader already found helpful', async () => {
    const view = await renderWithProviders(
      <ReviewsPreview
        {...base}
        reviews={[review({ id: 'a', userId: 'other-1', helpfulCount: 1, viewerHelpful: true })]}
        onToggleHelpful={() => {}}
      />,
    );
    const helpful = view.getByTestId('review-helpful');
    expect(helpful.props.accessibilityState).toMatchObject({ selected: true });
  });

  it('says whose your review is by name and date alone, with Edit, no Helpful and no score', async () => {
    const view = await renderWithProviders(
      <ReviewsPreview
        {...base}
        reviews={[]}
        onToggleHelpful={() => {}}
        viewer={{ name: 'Sai', avatarUri: null }}
        ownReview={{
          text: 'Mine.',
          hasSpoilers: true,
          updatedAt: '2026-10-02T10:00:00.000Z',
          helpfulCount: 0,
        }}
      />,
    );
    const mine = within(view.getByTestId('your-review'));
    // No "Your review" heading on top of the name and date (FU1113-F).
    expect(mine.queryByText(/Your review/)).toBeNull();
    expect(mine.getByText('Sai')).toBeTruthy();
    expect(mine.getByText(/2026/)).toBeTruthy();
    expect(mine.queryAllByLabelText(/out of 10/)).toHaveLength(0);
    expect(mine.queryByTestId('review-helpful')).toBeNull();
    expect(mine.getByTestId('edit-review')).toBeTruthy();
  });

  it('says only yours exists when nobody else has written one', async () => {
    const view = await renderWithProviders(
      <ReviewsPreview
        {...base}
        reviews={[]}
        ownReview={{ text: 'Mine.', hasSpoilers: false, updatedAt: null, helpfulCount: 0 }}
      />,
    );
    expect(view.getByTestId('reviews-preview-only-yours')).toBeTruthy();
    expect(view.queryByTestId('reviews-preview-empty')).toBeNull();
  });

  it('says the reviews could not load, with Try again, rather than "No reviews yet"', async () => {
    const onRetry = jest.fn();
    const view = await renderWithProviders(
      <ReviewsPreview {...base} reviews={[]} failed onRetry={onRetry} />,
    );
    expect(view.getByText('Reviews couldn’t load.')).toBeTruthy();
    expect(view.queryByTestId('reviews-preview-empty')).toBeNull();
    expect(view.queryByText('No reviews yet')).toBeNull();
    await fireEvent.press(view.getByRole('button', { name: 'Try loading reviews again' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('masks a spoiler, and says so to a screen reader without the words', async () => {
    const view = await renderWithProviders(
      <ReviewsPreview
        {...base}
        reviews={[
          review({ id: 'a', userId: 'other-1', text: 'He was dead all along.', hasSpoilers: true }),
        ]}
        maskedFor={() => true}
      />,
    );
    expect(view.queryByText(/dead all along/)).toBeNull();
    expect(view.getByTestId('review-preview-body').props.accessibilityLabel).toMatch(
      /Contains spoilers$/,
    );
  });
});

/**
 * **The write-review action's glyph follows what it says** (design-system v3 A.2 #6).
 * _Write a review_ takes the shared Edit glyph; _Rank to leave a review_ is the first Rank and
 * takes Rank's `star-outline`, never the edit glyph (rule 4). Both places it is drawn: the
 * editorial sheet's compose slot and the preview's empty state.
 */
describe('the write-review glyph', () => {
  const glyph = (name: keyof typeof Ionicons.glyphMap) =>
    String.fromCodePoint(Ionicons.glyphMap[name] as number);

  const editorial = (viewerRanked: boolean) =>
    renderWithProviders(
      <TitleReviews
        reviews={[]}
        loading={false}
        sort="top_desc"
        onChangeSort={() => {}}
        onToggleHelpful={() => {}}
        maskedFor={() => false}
        onPressAuthor={() => {}}
        viewerRanked={viewerRanked}
        viewerHasReview={false}
        onWrite={() => {}}
        noun="film"
        viewerId={VIEWER}
        variant="editorial"
      />,
    );

  const preview = (viewerRanked: boolean) =>
    renderWithProviders(
      <ReviewsPreview
        reviews={[]}
        loading={false}
        maskedFor={() => false}
        viewerId={VIEWER}
        viewerRanked={viewerRanked}
        ownReview={null}
        onWrite={() => {}}
        onSeeAll={() => {}}
        noun="movie"
      />,
    );

  it.each([
    ['the editorial sheet', editorial],
    ['the preview', preview],
  ])('is the Edit glyph on Write a review in %s', async (_, render) => {
    const view = await render(true);
    const action = view.getByTestId('write-review');

    expect(within(action).getByText('Write a review')).toBeTruthy();
    expect(within(action).getByText(glyph(EDIT_ICON_NAME))).toBeTruthy();
    expect(within(action).queryByText(glyph('star-outline'))).toBeNull();
  });

  it.each([
    ['the editorial sheet', editorial],
    ['the preview', preview],
  ])('is the Rank star, never the Edit glyph, on Rank to leave a review in %s', async (_, render) => {
    const view = await render(false);
    const action = view.getByTestId('write-review');

    expect(within(action).getByText('Rank to leave a review')).toBeTruthy();
    expect(within(action).getByText(glyph('star-outline'))).toBeTruthy();
    expect(within(action).queryByText(glyph(EDIT_ICON_NAME))).toBeNull();
  });
});
