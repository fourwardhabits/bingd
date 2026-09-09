import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ReportSheet } from '@/features/moderation/ReportSheet';
import type { TitleReview, ReviewSort } from '@/features/title/use-title-reviews';
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
  sort: ReviewSort;
  onChangeSort: (sort: ReviewSort) => void;
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
}: TitleReviewsProps) {
  // Which review's reason sheet is open, by `user_media.id`.
  const [reporting, setReporting] = useState<string | null>(null);

  return (
    <View style={styles.tab}>
      {/* The control first, because somebody who has just ranked something is more
          likely to be here to write than to read. Absent when they have not ranked
          it — a review of something you have not placed in your list is a review with
          no score, and the founder's route in is to rank first. */}
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

      {/* Offered once there is an order to choose. Kept while Following is active even
          when it returns nothing, so the reader can see which filter emptied the list
          rather than meeting a bare empty state with no way back. */}
      {reviews.length > 1 || sort === 'following' ? (
        <View style={styles.sort}>
          <SegmentedTabs
            options={SORT_OPTIONS.map((option) => ({
              id: option.id,
              label: option.labelFor(sort),
              accessibilityLabel: option.spokenFor(sort),
            }))}
            value={axisOf(sort)}
            onChange={(axis) => onChangeSort(nextSort(sort, axis))}
            accessibilityLabel="Sort reviews"
          />
        </View>
      ) : null}

      {loading ? (
        <SkeletonRow count={2} />
      ) : reviews.length === 0 ? (
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
            title="No reviews yet"
            body={`Be the first to leave a review of this ${noun}.`}
          />
        )
      ) : (
        reviews.map((review) => (
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
                  accessibilityHint="Tells whoever runs bingd. about this review"
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
              {review.reactionCount > 0 ? (
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
type SortAxis = 'top' | 'following' | 'recent';

const axisOf = (sort: ReviewSort): SortAxis =>
  sort === 'following' ? 'following' : sort.startsWith('top') ? 'top' : 'recent';

const DOWN = '\u2193';
const UP = '\u2191';

const SORT_OPTIONS: readonly {
  id: SortAxis;
  labelFor: (sort: ReviewSort) => string;
  spokenFor: (sort: ReviewSort) => string;
}[] = [
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
function nextSort(current: ReviewSort, pressed: SortAxis): ReviewSort {
  if (pressed === 'following') return 'following';
  if (pressed === 'top') return current === 'top_desc' ? 'top_asc' : 'top_desc';
  return current === 'recent_desc' ? 'recent_asc' : 'recent_desc';
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
  pressed: { opacity: 0.7 },
});
