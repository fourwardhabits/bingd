import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { formatScore } from '@/features/collection/score';
import { ReportSheet } from '@/features/moderation/ReportSheet';
import {
  REVIEW_LIMIT,
  type ReviewOrder,
  type ReviewSort,
  type TitleReview,
} from '@/features/title/use-title-reviews';
import {
  Avatar,
  Button,
  EmptyState,
  ScoreBadge,
  SegmentedTabs,
  SkeletonRow,
  SpoilerNote,
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
   * Your published review leads, in a light "Your review" section with a small
   * *Edit review* beneath it, and the full-width compose button goes. No score circle on
   * it — yours is already the emphasis in the title module. Everyone else's follow,
   * unchanged, with yours left out of the list so it is never shown twice. Without a
   * published review, a compact *Write a review*. Absent, the tab is the original page's.
   */
  variant?: 'editorial';
  /**
   * The viewer's own **published** review — their note with public visibility, from their
   * own row, never a private note. Read by the editorial variant only.
   */
  ownReview?: {
    text: string;
    hasSpoilers: boolean;
    updatedAt: string | null;
    helpfulCount: number;
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
          {ownReview && viewerRanked ? (
            <View style={styles.own} testID="your-review">
              <Text variant="caption" tone="tertiary">
                {['Your review', formatDate(ownReview.updatedAt)].filter(Boolean).join(' \u00b7 ')}
              </Text>
              {/* Never masked: it is the reader's own writing. Its spoiler claim still
                  shows, as the marker every review carries. */}
              <SpoilerNote
                text={ownReview.text}
                hasSpoilers={ownReview.hasSpoilers}
                masked={false}
                numberOfLines={6}
                titleForLabel={noun}
              />
              <View style={styles.ownFoot}>
                {ownReview.helpfulCount > 0 ? (
                  <Text variant="caption" tone="tertiary" style={styles.ownHelpful}>
                    {helpfulWords(ownReview.helpfulCount)}
                  </Text>
                ) : (
                  <View style={styles.ownHelpful} />
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Edit your review"
                  onPress={onWrite}
                  hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                  style={({ pressed }) => [styles.inlineAction, pressed && styles.pressed]}
                  testID="edit-review"
                >
                  <Ionicons name="create-outline" size={theme.layout.icon.sm} color={theme.semantic.action} />
                  <Text variant="callout" tone="action">
                    Edit review
                  </Text>
                </Pressable>
              </View>
            </View>
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
          rather than meeting a bare empty state with no way back. */}
      {limit === undefined && (listed.length > 1 || sort === 'following') ? (
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
        (limit === undefined ? listed : listed.slice(0, limit)).map((review) => (
          <View key={`${review.userId}-${review.updatedAt}`} style={styles.review}>
            <View style={styles.head}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${review.name}, @${review.username}`}
                accessibilityHint="Opens their profile"
                onPress={() => onPressAuthor(review.username)}
                style={styles.person}
              >
                <Avatar size="sm" uri={review.avatarUri} name={review.name} />
                <View style={styles.personCopy}>
                  <Text variant="callout" numberOfLines={1}>
                    {review.name}
                  </Text>
                  <Text variant="caption" tone="tertiary" numberOfLines={1}>
                    {[formatDate(review.updatedAt)].filter(Boolean).join(' · ') || `@${review.username}`}
                  </Text>
                </View>
              </Pressable>

              {/* The author's own number, in the app's one chromatic element. Absent
                  rather than zero when they wrote without ranking, which is a real
                  state and not a verdict of nought. */}
              {review.score !== null ? (
                <ScoreBadge score={review.score} size="sm" />
              ) : null}

              {/* The overflow, and the only thing behind it is Report.

                  An ellipsis rather than the word, because a review is a paragraph
                  somebody wrote and a permanent labelled Report beside every one of
                  them reads as an accusation waiting to be made. It is absent on your
                  own review: the server refuses a self-report, so the control would
                  only ever produce an error. */}
              {review.userId !== viewerId ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Report ${review.name}'s review`}
                  accessibilityHint="Tells whoever runs bingd about this review"
                  onPress={() => setReporting(review.id)}
                  // Slop to the 44pt floor (`layout.minTapTarget`) around a 20pt
                  // glyph: the ellipsis stays visually quiet and the target does not.
                  hitSlop={(theme.layout.minTapTarget - theme.layout.icon.sm) / 2}
                  style={({ pressed }) => pressed && styles.pressed}
                >
                  <Ionicons
                    name="ellipsis-horizontal"
                    size={theme.layout.icon.sm}
                    color={theme.text.tertiary}
                  />
                </Pressable>
              ) : null}
            </View>

            <SpoilerNote
              text={review.text}
              hasSpoilers={review.hasSpoilers}
              masked={maskedFor(review)}
              numberOfLines={6}
              titleForLabel={noun}
            />

            <View style={styles.foot}>
              {/* Absent on your own review, because the server refuses a self-vote and a
                  control whose only outcome is an error is not a control. The count is
                  still shown there: an author should be able to see that it landed. */}
              {review.userId === viewerId ? (
                review.helpfulCount > 0 ? (
                  <Text variant="caption" tone="tertiary">
                    {helpfulWords(review.helpfulCount)}
                  </Text>
                ) : null
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: review.viewerHelpful }}
                  accessibilityLabel={
                    review.viewerHelpful
                      ? `Helpful, marked by you. ${helpfulWords(review.helpfulCount)}`
                      : `Mark ${review.name}'s review helpful. ${helpfulWords(review.helpfulCount)}`
                  }
                  accessibilityHint={
                    review.viewerHelpful ? 'Takes your mark back' : 'Tells them it helped'
                  }
                  onPress={() => onToggleHelpful(review)}
                  hitSlop={theme.space[2]}
                  style={({ pressed }) => [styles.helpful, pressed && styles.pressed]}
                >
                  <Ionicons
                    name={review.viewerHelpful ? 'thumbs-up' : 'thumbs-up-outline'}
                    size={theme.layout.icon.sm}
                    color={review.viewerHelpful ? theme.semantic.action : theme.text.tertiary}
                  />
                  <Text variant="caption" tone={review.viewerHelpful ? 'primary' : 'tertiary'}>
                    {review.helpfulCount > 0 ? `Helpful \u00b7 ${review.helpfulCount}` : 'Helpful'}
                  </Text>
                </Pressable>
              )}

              {/* Reactions on the ranking this note belongs to. Kept, and kept
                  subordinate: it is a signal about the score rather than about the
                  writing, which is the confusion Helpful exists to end. */}
              {/* Not in the editorial sheet, where the thumbs-up is the one reaction a
                  review shows (post-QA sprint 2): a heart beside it read as a second
                  way to like the writing. */}
              {!editorial && review.reactionCount > 0 ? (
                <View style={styles.reactions}>
                  <Ionicons
                    name="heart"
                    size={theme.layout.icon.sm}
                    color={theme.semantic.action}
                  />
                  <Text variant="caption" tone="tertiary">
                    {review.reactionCount}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
        ))
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
  maskedFor: (review: TitleReview) => boolean;
  viewerId: string;
  viewerRanked: boolean;
  /** The reader's own published review, from their own row; never a private note. */
  ownReview: TitleReviewsProps['ownReview'];
  onWrite: () => void;
  /** Opens the full Reviews sheet, which is also where a clamped review reads in full. */
  onSeeAll: () => void;
  noun: string;
};

/** How many reviews the title page shows before See all, the reader's own included. */
export const REVIEWS_PREVIEW_COUNT = 2;

/**
 * **Reviews, after Cast** (post-QA sprint 2, 2026-11-05): one or two reviews on the
 * title page itself, because what other people thought is a core part of bingd.
 *
 * Your published review first, in the same quiet "Your review" treatment as the sheet,
 * with its small Edit; then the most helpful of everybody else's, three lines each. A
 * whole review, the order controls, Helpful, Report and the rest are one tap away in the
 * sheet — this is a view of the same server list, not a second one, so it cannot show a
 * review the sheet would not, and a private note is never in it.
 */
export function ReviewsPreview({
  reviews,
  loading,
  maskedFor,
  viewerId,
  viewerRanked,
  ownReview = null,
  onWrite,
  onSeeAll,
  noun,
}: ReviewsPreviewProps) {
  const showOwn = Boolean(ownReview && viewerRanked);
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
        <View style={styles.own} testID="your-review">
          <Text variant="caption" tone="tertiary">
            {['Your review', formatDate(ownReview.updatedAt)].filter(Boolean).join(' · ')}
          </Text>
          <SpoilerNote
            text={ownReview.text}
            hasSpoilers={ownReview.hasSpoilers}
            masked={false}
            numberOfLines={3}
            titleForLabel={noun}
          />
          <View style={styles.ownFoot}>
            {ownReview.helpfulCount > 0 ? (
              <Text variant="caption" tone="tertiary" style={styles.ownHelpful}>
                {helpfulWords(ownReview.helpfulCount)}
              </Text>
            ) : (
              <View style={styles.ownHelpful} />
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit your review"
              onPress={onWrite}
              hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
              style={({ pressed }) => [styles.inlineAction, pressed && styles.pressed]}
              testID="edit-review"
            >
              <Ionicons name="create-outline" size={theme.layout.icon.sm} color={theme.semantic.action} />
              <Text variant="callout" tone="action">
                Edit review
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {others.map((review) => (
        <Pressable
          key={review.id}
          accessibilityRole="button"
          // One spoken summary for the row. A masked review says so and never its words;
          // its Show control is the sheet's, where each review is its own element.
          accessibilityLabel={[
            review.name,
            review.score !== null ? `${formatScore(review.score)} out of 10` : null,
            maskedFor(review) ? 'Contains spoilers' : review.text,
          ]
            .filter(Boolean)
            .join('. ')}
          accessibilityHint="Opens all reviews"
          onPress={onSeeAll}
          style={({ pressed }) => [styles.previewRow, pressed && styles.pressed]}
          testID="review-preview"
        >
          <View style={styles.previewHead}>
            <Avatar size="xs" uri={review.avatarUri} name={review.name} />
            <Text variant="callout" numberOfLines={1} style={styles.previewName}>
              {review.name}
            </Text>
            {review.score !== null ? <ScoreBadge score={review.score} size="sm" /> : null}
          </View>
          <SpoilerNote
            text={review.text}
            hasSpoilers={review.hasSpoilers}
            masked={maskedFor(review)}
            numberOfLines={3}
            titleForLabel={noun}
          />
        </Pressable>
      ))}

      {!showOwn && others.length === 0 ? (
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

      {showOwn && others.length === 0 ? (
        <Text variant="footnote" tone="tertiary" testID="reviews-preview-only-yours">
          {`No other reviews of this ${noun} yet.`}
        </Text>
      ) : null}
    </View>
  );
}

function formatDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}


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

/** The spoken count, which is where the number gets its noun. */
const helpfulWords = (count: number) =>
  count === 0
    ? 'Nobody has marked it yet'
    : count === 1
      ? '1 person found this helpful'
      : `${count} people found this helpful`;

const styles = StyleSheet.create({
  tab: { gap: theme.space[2] },
  compose: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  sort: { paddingBottom: theme.space[1] },
  review: {
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
    gap: theme.space[2],
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomColor: theme.border.hairline,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  person: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  personCopy: { flex: 1, gap: 1 },
  foot: { flexDirection: 'row', alignItems: 'center', gap: theme.space[4] },
  helpful: { flexDirection: 'row', alignItems: 'center', gap: theme.space[1] },
  reactions: { flexDirection: 'row', alignItems: 'center', gap: theme.space[1] },
  /**
   * Your review in the editorial tab: a light Parchment surface and no border — set apart
   * from everybody else's by tone, not by a frame.
   */
  own: {
    backgroundColor: theme.surface.sunken,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.space[3],
    paddingTop: theme.space[3],
    paddingBottom: theme.space[1],
    gap: theme.space[2],
  },
  ownFoot: { flexDirection: 'row', alignItems: 'center' },
  ownHelpful: { flex: 1 },
  inlineAction: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: theme.space[1],
    minHeight: theme.layout.minTapTarget - 12,
  },
  truncated: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
  pressed: { opacity: 0.7 },
  preview: { gap: theme.space[3], paddingHorizontal: theme.layout.gutter },
  previewRow: { gap: theme.space[1] },
  previewHead: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  previewName: { flex: 1 },
  previewEmpty: { gap: theme.space[1] },
});
