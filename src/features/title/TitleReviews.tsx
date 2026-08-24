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

      {reviews.length > 1 ? (
        <View style={styles.sort}>
          <SegmentedTabs
            options={[
              { id: 'top' as const, label: 'Top' },
              { id: 'recent' as const, label: 'Recent' },
            ]}
            value={sort}
            onChange={onChangeSort}
          />
        </View>
      ) : null}

      {loading ? (
        <SkeletonRow count={2} />
      ) : reviews.length === 0 ? (
        <EmptyState
          kind="nothingYet"
          compact
          title="No reviews yet"
          body={`Be the first to leave a review of this ${noun}.`}
        />
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
                  hitSlop={theme.space[2]}
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

            {/* Only when somebody has. A zero beside every review is a scoreboard
                nobody is playing on. */}
            {review.reactionCount > 0 ? (
              <View style={styles.reactions}>
                <Ionicons
                  name="heart"
                  size={theme.layout.icon.sm}
                  color={theme.semantic.action}
                />
                <Text variant="caption" tone="secondary">
                  {review.reactionCount === 1
                    ? '1 reaction'
                    : `${review.reactionCount} reactions`}
                </Text>
              </View>
            ) : null}
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
  reactions: { flexDirection: 'row', alignItems: 'center', gap: theme.space[1] },
  pressed: { opacity: 0.7 },
});
