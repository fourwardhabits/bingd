import { within } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import {
  ReviewCard,
  UNRANKED_REVIEW_SCORE,
  reviewScoreSlot,
  type ReviewCardReview,
} from './ReviewCard';
import { TitleReviews } from './TitleReviews';
import type { TitleReview } from './use-title-reviews';

/**
 * **The review card's hierarchy** (QA1114-REVIEWS §2, 2026-11-14).
 *
 * Every surface draws the same card, so the See all sheet — several reviewers, long names,
 * long and multi-line bodies, an author who never ranked it, and your own ranked review —
 * is where the layout is pinned:
 *
 *   - the header holds who and when on the left, and on the right one column: the score
 *     circle, then the action directly beneath it (Edit on yours, Helpful on theirs);
 *   - the body is the header's sibling *below* it, never inside it, so it reads at the
 *     card's full inner width and the column cannot overlap it;
 *   - a long name is one truncated line;
 *   - an author with no score has no circle, and the action alone tops the same column.
 *
 * The jest renderer has no layout engine, so the 320 and 360 widths below wrap the sheet
 * in a container of that width and pin the *structure and style rules* that make the
 * layout hold at any width (`flex: 1` + `minWidth: 0` on the name side, a non-shrinking
 * fixed-width column). Pixel layout is the founder's visual QA, not this file's.
 */

const VIEWER = 'viewer-1';
const LONG_NAME = 'Maximiliana Bartholomew-Featherstonehaugh the Third of Wessex';
const LONG_BODY = Array.from(
  { length: 40 },
  (_, n) => `Sentence ${n + 1} goes on about the film for rather longer than it needs to.`,
).join(' ');
const MULTI_LINE = 'First line.\nSecond line.\n\nA paragraph after a blank line.\nAnd one more.';

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

const reviewers: TitleReview[] = [
  review({ id: 'a', name: LONG_NAME, text: LONG_BODY, score: 9.1, helpfulCount: 3 }),
  review({ id: 'b', name: `${LONG_NAME} (second)`, text: MULTI_LINE, score: 6.4 }),
  // Wrote without ranking it: a real state the server allows.
  review({ id: 'c', name: `${LONG_NAME} (unranked)`, text: 'No score, still an opinion.', score: null }),
  // The reader's own row, which the editorial sheet draws pinned above and not again.
  review({ id: 'mine', userId: VIEWER, name: 'Sai', text: 'My own words.', score: 7.3 }),
];

/** Test ids under `node`, depth first in tree order, each once. */
type Node = { props: Record<string, unknown>; children: (Node | string)[] };
const idsIn = (root: unknown) => {
  const seen: string[] = [];
  const walk = (node: Node | string) => {
    if (typeof node === 'string') return;
    const id = node.props.testID;
    if (typeof id === 'string' && !seen.includes(id)) seen.push(id);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root as Node);
  return seen;
};

const drawSheet = (width: number) =>
  renderWithProviders(
    <View style={{ width }} testID="frame">
      <TitleReviews
        reviews={reviewers}
        loading={false}
        sort="top_desc"
        onChangeSort={() => {}}
        onToggleHelpful={() => {}}
        maskedFor={() => false}
        onPressAuthor={() => {}}
        viewerRanked
        viewerHasReview
        onWrite={() => {}}
        noun="movie"
        viewerId={VIEWER}
        variant="editorial"
        ownReview={{
          text: 'My own words.',
          hasSpoilers: false,
          updatedAt: '2026-10-02T10:00:00.000Z',
          helpfulCount: 1,
          // The score on the reader's own `title_reviews_v2` row.
          score: 7.3,
        }}
        viewer={{ name: 'Sai', avatarUri: null }}
      />
    </View>,
  );

describe.each([320, 360])('the See all sheet at %ipt', (width) => {
  it('draws every card with the circle over the action inside the header', async () => {
    const view = await drawSheet(width);
    const others = view.getAllByTestId('review-card');
    // Yours is pinned above, so it is not listed again.
    expect(others).toHaveLength(3);

    for (const card of [view.getByTestId('your-review'), ...others]) {
      const head = within(card).getByTestId('review-card-head');
      const stack = within(head).getByTestId('review-card-stack');
      const order = idsIn(stack);
      const action = order.find((id) => id === 'edit-review' || id === 'review-helpful');
      expect(action).toBeDefined();
      if (order.includes('review-card-score')) {
        // Score first, the action beneath it.
        expect(order.indexOf('review-card-score')).toBeLessThan(order.indexOf(action!));
      }
      // The column does not shrink for a long name, and its width fits the 44pt target.
      const style = StyleSheet.flatten(stack.props.style) as Record<string, number>;
      expect(style.flexShrink).toBe(0);
      expect(style.width).toBeGreaterThanOrEqual(44);
      expect(style.alignItems).toBe('center');
    }
  });

  it('puts the body below the header, never inside it, at the card’s full width', async () => {
    const view = await drawSheet(width);
    const [first, second] = view.getAllByTestId('review-card');
    for (const [card, text] of [
      [first!, 'Sentence 1 goes on'],
      [second!, 'First line.'],
    ] as const) {
      const head = within(card).getByTestId('review-card-head');
      expect(within(head).queryByText(new RegExp(text))).toBeNull();
      expect(within(card).getAllByText(new RegExp(text)).length).toBeGreaterThan(0);
      // The header and the body are siblings in the card's column.
      const cardChildren = (card.children as { props: { testID?: string } }[]).map(
        (child) => child.props.testID,
      );
      expect(cardChildren[0]).toBe('review-card-head');
      expect(cardChildren.length).toBeGreaterThan(1);
    }
  });

  it('truncates a long name to one line, so it never pushes the column', async () => {
    const view = await drawSheet(width);
    const name = view.getByText(LONG_NAME);
    expect(name.props.numberOfLines).toBe(1);
    // The name side is the one that gives: it flexes and may shrink below its content.
    let node: typeof name | null = name.parent;
    const flexed: Record<string, unknown>[] = [];
    while (node && node.props.testID !== 'review-card-head') {
      flexed.push(
        StyleSheet.flatten(
          typeof node.props.style === 'function'
            ? node.props.style({ pressed: false })
            : node.props.style,
        ) ?? {},
      );
      node = node.parent;
    }
    expect(flexed.some((style) => style.flex === 1 && style.minWidth === 0)).toBe(true);
  });

  it('draws no circle for an author who did not rank it, and keeps Helpful in the column', async () => {
    const view = await drawSheet(width);
    const unranked = view
      .getAllByTestId('review-card')
      .find((card) => within(card).queryByText('No score, still an opinion.'))!;
    const stack = within(unranked).getByTestId('review-card-stack');
    expect(within(stack).queryByTestId('review-card-score')).toBeNull();
    expect(within(unranked).queryAllByLabelText(/out of 10/)).toHaveLength(0);
    expect(within(stack).getByTestId('review-helpful')).toBeTruthy();
  });

  it('draws your own score, with Edit directly beneath it and no Helpful', async () => {
    const view = await drawSheet(width);
    const mine = view.getByTestId('your-review');
    const stack = within(mine).getByTestId('review-card-stack');
    expect(within(stack).getByLabelText('7.3 out of 10')).toBeTruthy();
    expect(idsIn(stack).filter((id) => id === 'review-card-score' || id === 'edit-review')).toEqual(
      ['review-card-score', 'edit-review'],
    );
    expect(within(mine).queryByTestId('review-helpful')).toBeNull();
  });

  it('draws everybody else’s score with Helpful directly beneath it', async () => {
    const view = await drawSheet(width);
    const ranked = view
      .getAllByTestId('review-card')
      .filter((card) => within(card).queryByTestId('review-card-score'));
    expect(ranked).toHaveLength(2);
    for (const card of ranked) {
      const stack = within(card).getByTestId('review-card-stack');
      expect(
        idsIn(stack).filter((id) => id === 'review-card-score' || id === 'review-helpful'),
      ).toEqual(['review-card-score', 'review-helpful']);
      expect(within(card).queryByTestId('edit-review')).toBeNull();
    }
    expect(view.getByLabelText('9.1 out of 10')).toBeTruthy();
    expect(view.getByLabelText('6.4 out of 10')).toBeTruthy();
  });

  it('keeps the Helpful count in the footer, in words, outside the column', async () => {
    const view = await drawSheet(width);
    const [first] = view.getAllByTestId('review-card');
    const count = within(first!).getByTestId('review-helpful-count');
    expect(count.props.children).toBe('3 people found this helpful');
    expect(
      within(within(first!).getByTestId('review-card-head')).queryByTestId('review-helpful-count'),
    ).toBeNull();
  });
});

describe('the own review on a title you have not ranked (editorial sheet)', () => {
  it('is shown, score-less, with Edit — not replaced by Rank to leave a review', async () => {
    const view = await renderWithProviders(
      <TitleReviews
        reviews={[review({ id: 'x' })]}
        loading={false}
        sort="top_desc"
        onChangeSort={() => {}}
        onToggleHelpful={() => {}}
        maskedFor={() => false}
        onPressAuthor={() => {}}
        viewerRanked={false}
        viewerHasReview
        onWrite={() => {}}
        noun="movie"
        viewerId={VIEWER}
        variant="editorial"
        ownReview={{
          text: 'Public, never ranked.',
          hasSpoilers: false,
          updatedAt: null,
          helpfulCount: 0,
          score: null,
        }}
      />,
    );
    const mine = within(view.getByTestId('your-review'));
    expect(mine.getByText('Public, never ranked.')).toBeTruthy();
    expect(mine.queryByTestId('review-card-score')).toBeNull();
    expect(mine.getByTestId('edit-review')).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Rank to leave a review' })).toBeNull();
  });
});

describe('the unranked-score switch (D-R2)', () => {
  const card = (over: Partial<ReviewCardReview> = {}): ReviewCardReview => ({
    id: 'um-1',
    username: 'Reader A',
    date: '14 Nov 2026',
    text: 'Words.',
    spoilers: false,
    helpfulCount: 0,
    viewerHelpful: false,
    isOwn: false,
    ...over,
  });

  it('defaults to no circle, and the action alone tops the column', async () => {
    expect(UNRANKED_REVIEW_SCORE).toBe('none');
    expect(reviewScoreSlot(null)).toBe('none');
    expect(reviewScoreSlot(undefined)).toBe('none');
    expect(reviewScoreSlot(0)).toBe('badge');
    expect(reviewScoreSlot(8.4)).toBe('badge');
    // The alternative is the rule's other answer, so choosing it is one line.
    expect(reviewScoreSlot(null, 'placeholder')).toBe('placeholder');

    const view = await renderWithProviders(
      <ReviewCard review={card()} score={null} onToggleHelpful={() => {}} />,
    );
    const stack = within(view.getByTestId('review-card-stack'));
    expect(stack.queryByTestId('review-card-score')).toBeNull();
    // Never the "Rank" empty badge, which is the reader's own invitation, not an author's.
    expect(view.queryByText('Rank')).toBeNull();
    expect(stack.getByTestId('review-helpful')).toBeTruthy();
  });

  it('draws a zero as a score, not as an absence', async () => {
    const view = await renderWithProviders(
      <ReviewCard review={card()} score={0} onToggleHelpful={() => {}} />,
    );
    expect(within(view.getByTestId('review-card-stack')).getByTestId('review-card-score')).toBeTruthy();
  });

  it('draws no column at all when there is neither a score nor an action', async () => {
    const view = await renderWithProviders(<ReviewCard review={card()} score={null} />);
    expect(view.queryByTestId('review-card-stack')).toBeNull();
  });
});
