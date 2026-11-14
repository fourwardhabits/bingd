import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { formatScore } from '@/features/collection/score';
import { ReportSheet } from '@/features/moderation/ReportSheet';
import { ReviewCard, formatReviewDate, type ReviewCardReview } from '@/features/title/ReviewCard';
import {
  REVIEW_LIMIT,
  type ReviewOrder,
  type ReviewSort,
  type TitleReview,
} from '@/features/title/use-title-reviews';
import {
  Button,
  EmptyState,
  SegmentedTabs,
  SkeletonRow,
  Text,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

export type TitleReviewsProps = {
  reviews: TitleReview[];
  loading: boolean;
  /** The original page only ever passes a server order; the editorial sheet may pass Rating. */
  sort: ReviewOrder;
  onChangeSort: (sort: ReviewOrder) => void;
  /** Marks one review helpful, or takes it back. */
  onToggleHelpful: (review: TitleReview) => void;
  /** True when this viewer's spoiler masking should apply to a given note. */
  maskedFor: (review: TitleReview) => boolean;
  onPressAuthor: (username: string) => void;
  /** Whether the viewer has ranked this exact title, which is what a review needs. */
  viewerRanked: boolean;
  /** Whether the viewer already wrote one, which changes Add to Edit. */
  viewerHasReview: boolean;
  /** Opens the log sheet, where a note is written. */
  onWrite: () => void;
  /** Movie or season, for the copy. Never "title". */
  noun: string;
  /**
   * Who is reading, so that the reporting control is absent from their own review.
   * `report()` refuses your own content with a 22023, so offering it there would be a
   * button whose only outcome is an error.
   */
  viewerId: string;
  /**
   * Show only this many reviews, without the sort control: the immersive title page's
   * preview (2026-11-04), which expands into the full list in place. Absent, everything
   * shows, as on the original page.
   */
  limit?: number;
  /**
   * The immersive page's Reviews tab (Cinematic Editorial, founder phone QA 2026-11-04).
   *
   * Your published review leads, as a `ReviewCard` with your name, date, your score
   * circle and the Edit icon beneath it top right (FU1113-F; score added QA1114-REVIEWS
   * §2), and the full-width compose button goes. Everyone else's follow, unchanged, with
   * yours left out of the list so it is never shown twice. Without a published review, a
   * compact *Write a review*. Absent, the tab is the original page's.
   */
  variant?: 'editorial';
  /**
   * The viewer's own **published** review — their note with public visibility, from their
   * own row, never a private note. Read by the editorial variant only.
   *
   * Shown whenever it exists, ranked or not (QA1114-REVIEWS §2): the server allows a
   * review without a ranking, and everybody else can already read one, so hiding it from
   * its own author left them no way to see or edit it here.
   */
  ownReview?: {
    text: string;
    hasSpoilers: boolean;
    updatedAt: string | null;
    helpfulCount: number;
    /**
     * Your score as everybody else sees it: the `score` on your own `title_reviews_v2`
     * row (the server's live `score_for`). Null when you have not ranked it — no circle.
     */
    score: number | null;
  } | null;
  /**
   * Editorial only: whether Rating can be offered — true only when the Most Helpful list
   * it re-orders is complete. See `ReviewOrder`.
   */
  ratingAvailable?: boolean;
  /**
   * The server stopped at its ceiling, so there may be more reviews than are listed. Said
   * once at the foot rather than implied by silence.
   */
  truncated?: boolean;
  /** Whose your review is: the reader's own name and picture, from their profile. */
  viewer?: { name: string; avatarUri: string | null };
  /** The review whose Helpful vote is in flight, announced busy on its card. */
  helpfulPendingId?: string | null;
};

/**
 * Reviews on a title — Bingd's, not TMDB's.
 *
 * A review is a public Note, and this tab is a view of them. Nothing here writes: the
 * control at the top opens the log sheet, which is where a note has always been
 * written, so there is one composer and one place the spoiler flag and the visibility
 * are chosen. Adding a second would be a second content model wearing a different
 * button.
 *
 * **Top is a real ordering, not a reputation.** It sorts by reactions on the activity
 * the note belongs to, with recency breaking ties — an interaction signal the app
 * already collects, on an object that already exists. The founder ruled out reviewer
 * reputation and it would have been unfalsifiable anyway: there is no way to check
 * whether a number that claims somebody is a good reviewer is right.
 *
 * The score sits beside the author because a review without it is half the opinion —
 * "I could not stop thinking about it" reads differently at 9.4 and at 4.1. It is the
 * author's *live* score rather than the one snapshotted when they ranked, so a reviewer
 * who has since re-ordered their list is quoted at what they think now.
 */
export function TitleReviews({
  reviews,
  loading,
  sort,
  onChangeSort,
  onToggleHelpful,
  maskedFor,
  onPressAuthor,
  viewerRanked,
  viewerHasReview,
  onWrite,
  noun,
  viewerId,
  limit,
  variant,
  ownReview = null,
  ratingAvailable = false,
  truncated = false,
  viewer,
  helpfulPendingId = null,
}: TitleReviewsProps) {
  // Which review's reason sheet is open, by `user_media.id`.
  const [reporting, setReporting] = useState<string | null>(null);
  const editorial = variant === 'editorial';
  // In the editorial tab your own review is drawn above, so it is not listed again.
  const listed = editorial ? reviews.filter((review) => review.userId !== viewerId) : reviews;
  // The editorial sheet's four orders; the original page keeps its three, unchanged.
  const options = editorial
    ? EDITORIAL_SORT_OPTIONS.filter((option) => option.id !== 'rating' || ratingAvailable)
    : SORT_OPTIONS;
  const choose = editorial ? nextEditorialOrder : nextSort;

  return (
    <View style={styles.tab}>
      {editorial ? (
        <View style={styles.compose}>
          {ownReview ? (
            <ReviewCard
              testID="your-review"
              review={{
                id: 'own',
                username: viewer?.name ?? 'You',
                date: formatReviewDate(ownReview.updatedAt),
                text: ownReview.text,
                spoilers: ownReview.hasSpoilers,
                helpfulCount: ownReview.helpfulCount,
                viewerHelpful: false,
                isOwn: true,
              }}
              avatar={viewer ? { uri: viewer.avatarUri, name: viewer.name } : null}
              score={ownReview.score}
              onEdit={onWrite}
              collapsedLines={6}
              noun={noun}
            />
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={viewerRanked ? 'Write a review' : 'Rank to leave a review'}
              onPress={onWrite}
              hitSlop={{ top: 12, bottom: 12 }}
              style={({ pressed }) => [styles.inlineAction, pressed && styles.pressed]}
              testID="write-review"
            >
              <Ionicons name="create-outline" size={theme.layout.icon.sm} color={theme.semantic.action} />
              <Text variant="callout" tone="action">
                {viewerRanked ? 'Write a review' : 'Rank to leave a review'}
              </Text>
            </Pressable>
          )}
        </View>
      ) : null}
      {/* The control first, because somebody who has just ranked something is more
          likely to be here to write than to read. Absent when they have not ranked
          it — a review of something you have not placed in your list is a review with
          no score, and the founder's route in is to rank first. */}
      {editorial ? null : (
      <View style={styles.compose}>
        {viewerRanked ? (
          <Button
            label={viewerHasReview ? 'Edit your review' : 'Write a review'}
            kind="secondary"
            onPress={onWrite}
          />
        ) : (
          <Button
            label={`Rank to leave a review`}
            kind="secondary"
            onPress={onWrite}
          />
        )}
      </View>
      )}

      {/* Offered once there is an order to choose. Kept while Following is active even
          when it returns nothing, so the reader can see which filter emptied the list
          rather than meeting a bare empty state with no way back. In the editorial
          sheet it also stays while a new order loads, and while any order but the
          default is chosen: a control that vanishes mid-switch is a control the reader
          cannot take back (post-QA sprint 2). */}
      {limit === undefined &&
      (listed.length > 1 ||
        sort === 'following' ||
        (editorial && (loading || sort !== 'top_desc'))) ? (
        <View style={styles.sort}>
          <SegmentedTabs
            options={options.map((option) => ({
              id: option.id,
              label: option.labelFor(sort),
              accessibilityLabel: option.spokenFor(sort),
            }))}
            value={axisOf(sort)}
            onChange={(axis) => onChangeSort(choose(sort, axis))}
            accessibilityLabel="Sort reviews"
          />
        </View>
      ) : null}

      {loading ? (
        <SkeletonRow count={2} />
      ) : listed.length === 0 ? (
        sort === 'following' ? (
          <EmptyState
            kind="nothingYet"
            compact
            title="No reviews from people you follow yet"
            body={`Nobody you follow has written about this ${noun}.`}
          />
        ) : (
          <EmptyState
            kind="nothingYet"
            compact
            title={editorial && ownReview ? 'No other reviews yet' : 'No reviews yet'}
            body={
              editorial && ownReview
                ? `Yours is the only review of this ${noun} so far.`
                : `Be the first to leave a review of this ${noun}.`
            }
          />
        )
      ) : (
        <View style={styles.cards}>
          {(limit === undefined ? listed : listed.slice(0, limit)).map((review) => {
            const own = review.userId === viewerId;
            return (
              <ReviewCard
                key={`${review.userId}-${review.updatedAt}`}
                review={toCard(review, viewerId)}
                avatar={{ uri: review.avatarUri, name: review.name }}
                handle={review.username}
                // The author's live number: a review without it is half the opinion. Absent
                // rather than zero when they wrote without ranking.
                score={review.score}
                masked={maskedFor(review)}
                noun={noun}
                collapsedLines={6}
                onPressAuthor={() => onPressAuthor(review.username)}
                onEdit={own ? onWrite : undefined}
                onToggleHelpful={own ? undefined : () => onToggleHelpful(review)}
                helpfulPending={helpfulPendingId === review.id}
                onReport={own ? undefined : () => setReporting(review.id)}
              />
            );
          })}
        </View>
      )}

      {truncated && !loading && listed.length > 0 ? (
        <Text
          variant="caption"
          tone="tertiary"
          style={styles.truncated}
          testID="reviews-truncated"
        >
          {`Showing the first ${REVIEW_LIMIT} reviews in this order.`}
        </Text>
      ) : null}

      <ReportSheet
        visible={reporting !== null}
        onClose={() => setReporting(null)}
        subject="review"
        subjectId={reporting ?? ''}
        noun="review"
      />
    </View>
  );
}

export type ReviewsPreviewProps = {
  /** The Most Helpful list, as the server ordered it. */
  reviews: TitleReview[];
  loading: boolean;
  /** The read failed and nothing is cached: say so, rather than "No reviews yet". */
  failed?: boolean;
  onRetry?: () => void;
  maskedFor: (review: TitleReview) => boolean;
  viewerId: string;
  viewerRanked: boolean;
  /** The reader's own published review, from their own row; never a private note. */
  ownReview: TitleReviewsProps['ownReview'];
  onWrite: () => void;
  /** Opens the full Reviews sheet, which is also where a clamped review reads in full. */
  onSeeAll: () => void;
  noun: string;
  /** The thumbs-up on somebody else's review: the same write the sheet makes. */
  onToggleHelpful?: (review: TitleReview) => void;
  /** Whose your review is: the reader's own name and picture, from their profile. */
  viewer?: { name: string; avatarUri: string | null };
  /** The review whose Helpful vote is in flight, announced busy on its card. */
  helpfulPendingId?: string | null;
};

/** How many reviews the title page shows before See all, the reader's own included. */
export const REVIEWS_PREVIEW_COUNT = 2;

/**
 * **Reviews, after Cast** (post-QA sprint 2, 2026-11-05): one or two reviews on the
 * title page itself, because what other people thought is a core part of bingd.
 *
 * Your published review first, as the same `ReviewCard` the sheet draws, with your score
 * and its Edit;
 * then the most helpful of everybody else's, three lines each, each with its thumbs-up. A
 * whole review, the order controls, Report and the rest are one tap away in the
 * sheet — this is a view of the same server list, not a second one, so it cannot show a
 * review the sheet would not, and a private note is never in it.
 */
export function ReviewsPreview({
  reviews,
  loading,
  failed = false,
  onRetry,
  maskedFor,
  viewerId,
  viewerRanked,
  ownReview = null,
  onWrite,
  onSeeAll,
  noun,
  onToggleHelpful,
  viewer,
  helpfulPendingId = null,
}: ReviewsPreviewProps) {
  // Your published review shows whether or not you ranked it (QA1114-REVIEWS §2).
  const showOwn = Boolean(ownReview);
  const others = reviews
    .filter((review) => review.userId !== viewerId)
    .slice(0, REVIEWS_PREVIEW_COUNT - (showOwn ? 1 : 0));

  if (loading && !showOwn) {
    return (
      <View style={styles.preview} testID="reviews-preview">
        <SkeletonRow count={1} />
      </View>
    );
  }

  return (
    <View style={styles.preview} testID="reviews-preview">
      {showOwn && ownReview ? (
        <ReviewCard
          testID="your-review"
          review={{
            id: 'own',
            username: viewer?.name ?? 'You',
            date: formatReviewDate(ownReview.updatedAt),
            text: ownReview.text,
            spoilers: ownReview.hasSpoilers,
            helpfulCount: ownReview.helpfulCount,
            viewerHelpful: false,
            isOwn: true,
          }}
          avatar={viewer ? { uri: viewer.avatarUri, name: viewer.name } : null}
          score={ownReview.score}
          onEdit={onWrite}
          collapsedLines={3}
          noun={noun}
        />
      ) : null}

      {others.map((review) => (
        <ReviewCard
          key={review.id}
          testID="review-preview"
          review={toCard(review, viewerId)}
          avatar={{ uri: review.avatarUri, name: review.name }}
          score={review.score}
          masked={maskedFor(review)}
          noun={noun}
          collapsedLines={3}
          // The text opens the sheet, where a clamped review reads in full. One spoken
          // summary for the opinion; a masked review says so and never its words.
          onPressBody={onSeeAll}
          bodyAccessibilityLabel={[
            review.name,
            review.score !== null ? `${formatScore(review.score)} out of 10` : null,
            maskedFor(review) ? 'Contains spoilers' : review.text,
          ]
            .filter(Boolean)
            .join('. ')}
          bodyAccessibilityHint="Opens all reviews"
          // Its own control, outside the text's press, so a tap marks the review rather
          // than opening the sheet.
          onToggleHelpful={onToggleHelpful ? () => onToggleHelpful(review) : undefined}
          helpfulPending={helpfulPendingId === review.id}
        />
      ))}

      {failed && others.length === 0 ? (
        <View style={styles.previewEmpty} testID="reviews-preview-failed">
          <Text variant="footnote" tone="secondary">
            Reviews couldn’t load.
          </Text>
          {onRetry ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Try loading reviews again"
              onPress={onRetry}
              hitSlop={{ top: 12, bottom: 12 }}
              style={({ pressed }) => [styles.inlineAction, pressed && styles.pressed]}
            >
              <Ionicons name="refresh" size={theme.layout.icon.sm} color={theme.semantic.action} />
              <Text variant="callout" tone="action">
                Try again
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {!failed && !showOwn && others.length === 0 ? (
        <View style={styles.previewEmpty} testID="reviews-preview-empty">
          <Text variant="footnote" tone="secondary">
            No reviews yet
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={viewerRanked ? 'Write a review' : 'Rank to leave a review'}
            onPress={onWrite}
            hitSlop={{ top: 12, bottom: 12 }}
            style={({ pressed }) => [styles.inlineAction, pressed && styles.pressed]}
            testID="write-review"
          >
            <Ionicons name="create-outline" size={theme.layout.icon.sm} color={theme.semantic.action} />
            <Text variant="callout" tone="action">
              {viewerRanked ? 'Write a review' : 'Rank to leave a review'}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {!failed && showOwn && others.length === 0 ? (
        <Text variant="footnote" tone="tertiary" testID="reviews-preview-only-yours">
          {`No other reviews of this ${noun} yet.`}
        </Text>
      ) : null}
    </View>
  );
}

/** A `title_reviews_v2` row as the card reads it. */
const toCard = (review: TitleReview, viewerId: string): ReviewCardReview => ({
  id: review.id,
  username: review.name,
  date: formatReviewDate(review.updatedAt),
  text: review.text,
  spoilers: review.hasSpoilers,
  helpfulCount: review.helpfulCount,
  viewerHelpful: review.viewerHelpful,
  isOwn: review.userId === viewerId,
});

/**
 * The three controls, and the two of them that carry a direction.
 *
 * This is the sort contract in `ui/sort.ts` applied to one row: a label names its axis
 * and never a direction, pressing the axis already in use flips it, pressing another
 * moves to that axis's own default, and the arrow — not the word — says which way it
 * points. The arrow is appended to the label because `SegmentedTabs` draws one string per
 * tab; `accessibilityLabel` carries the words for a reader who cannot see the glyph,
 * which is rule 5 and the reason that prop exists at all.
 *
 * **Following has no arrow, because it is a filter.** It answers "who wrote this", not
 * "in what order", so giving it a second tap would invent a meaning the server does not
 * implement. Inside it the order is Top's: most helpful, then newest.
 */
type SortAxis = 'top' | 'following' | 'recent' | 'rating';

const axisOf = (sort: ReviewOrder): SortAxis =>
  sort === 'following'
    ? 'following'
    : sort.startsWith('top')
      ? 'top'
      : sort.startsWith('rating')
        ? 'rating'
        : 'recent';

const DOWN = '\u2193';
const UP = '\u2191';

type SortOption = {
  id: SortAxis;
  labelFor: (sort: ReviewOrder) => string;
  spokenFor: (sort: ReviewOrder) => string;
};

const SORT_OPTIONS: readonly SortOption[] = [
  {
    id: 'top',
    labelFor: (sort) =>
      sort === 'top_desc' ? `Top ${DOWN}` : sort === 'top_asc' ? `Top ${UP}` : 'Top',
    spokenFor: (sort) =>
      sort === 'top_desc'
        ? 'Top, most helpful first'
        : sort === 'top_asc'
          ? 'Top, least helpful first'
          : 'Top',
  },
  { id: 'following', labelFor: () => 'Following', spokenFor: () => 'Following' },
  {
    id: 'recent',
    labelFor: (sort) =>
      sort === 'recent_desc'
        ? `Recent ${DOWN}`
        : sort === 'recent_asc'
          ? `Recent ${UP}`
          : 'Recent',
    spokenFor: (sort) =>
      sort === 'recent_desc'
        ? 'Recent, newest first'
        : sort === 'recent_asc'
          ? 'Recent, oldest first'
          : 'Recent',
  },
];

/** Rules 2 and 3: press the active axis to flip it, press another to enter its default. */
function nextSort(current: ReviewOrder, pressed: SortAxis): ReviewSort {
  if (pressed === 'following') return 'following';
  if (pressed === 'top') return current === 'top_desc' ? 'top_asc' : 'top_desc';
  return current === 'recent_desc' ? 'recent_asc' : 'recent_desc';
}

/**
 * **The editorial sheet's orders** (post-QA sprint 2, 2026-11-05), in the founder's
 * words: Most Helpful (the default), Newest, Rating — and Following kept as the filter it
 * always was. The same contract as above: pressing the active one reverses it where a
 * reversal means something. Newest reverses to *Oldest* in words, because "Newest ↑" is a
 * contradiction a reader has to decode; Helpful and Rating keep the arrow.
 */
const EDITORIAL_SORT_OPTIONS: readonly SortOption[] = [
  {
    id: 'top',
    labelFor: (sort) =>
      sort === 'top_desc' ? `Helpful ${DOWN}` : sort === 'top_asc' ? `Helpful ${UP}` : 'Helpful',
    spokenFor: (sort) =>
      sort === 'top_desc'
        ? 'Most helpful first'
        : sort === 'top_asc'
          ? 'Least helpful first'
          : 'Most helpful',
  },
  {
    id: 'recent',
    labelFor: (sort) => (sort === 'recent_asc' ? 'Oldest' : 'Newest'),
    spokenFor: (sort) =>
      sort === 'recent_desc'
        ? 'Newest first'
        : sort === 'recent_asc'
          ? 'Oldest first'
          : 'Newest',
  },
  {
    id: 'rating',
    labelFor: (sort) =>
      sort === 'rating_desc' ? `Rating ${DOWN}` : sort === 'rating_asc' ? `Rating ${UP}` : 'Rating',
    spokenFor: (sort) =>
      sort === 'rating_desc'
        ? 'Highest rated first'
        : sort === 'rating_asc'
          ? 'Lowest rated first'
          : 'Rating',
  },
  { id: 'following', labelFor: () => 'Following', spokenFor: () => 'Only people you follow' },
];

function nextEditorialOrder(current: ReviewOrder, pressed: SortAxis): ReviewOrder {
  if (pressed === 'rating') return current === 'rating_desc' ? 'rating_asc' : 'rating_desc';
  return nextSort(current, pressed);
}

const styles = StyleSheet.create({
  tab: { gap: theme.space[2] },
  compose: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  sort: { paddingBottom: theme.space[1] },
  /** Cards in a column, inset to the page's gutter: the recommendation card's rhythm. */
  cards: { gap: theme.space[3], paddingHorizontal: theme.layout.gutter },
  inlineAction: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: theme.space[1],
    // Unchanged from before FU1113-F: a 32pt line with vertical slop to the 44pt floor.
    minHeight: theme.layout.minTapTarget - 12,
  },
  truncated: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
  pressed: { opacity: 0.7 },
  preview: { gap: theme.space[3], paddingHorizontal: theme.layout.gutter },
  previewEmpty: { gap: theme.space[1] },
});
