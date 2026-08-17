import { useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import type { TmdbReview } from '@/features/title/use-title-extras';
import { Avatar, SectionHeader, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

export type TmdbReviewsProps = {
  reviews: TmdbReview[];
};

/**
 * Reviews written by TMDB's own site users.
 *
 * **The heading is the specification.** These are TMDB Reviews and they are never
 * called critic reviews, professional reviews or community reviews, because they are
 * none of those things — TMDB publishes no critics, and the community whose opinion
 * this app aggregates is Bingd's, in the Community score further up the page.
 *
 * Which is also why this section sits *below* Notes rather than above it: the page
 * goes from the reader's own score, to the people they follow, to everybody on Bingd,
 * to what Bingd users have written, and only then to somebody else's website. Each
 * step is further from the reader, and the ordering is what stops the four being
 * mistaken for one another. The line under the heading says whose words these are in
 * as many words, because a heading alone is a thing people skim past.
 *
 * A review is four lines until it is opened, like every other long text in this app.
 * The stored body is a generous excerpt rather than the whole thing — some of these
 * run to thousands of words (`normalize.ts`) — so a truncated one offers the link to
 * TMDB and an untruncated one does not, rather than always offering a link that
 * sometimes leads to exactly what is already on screen.
 */
export function TmdbReviews({ reviews }: TmdbReviewsProps) {
  // Rendered only when there is something to render. An empty section here would be
  // the same defect as an always-empty tab: an invitation that leads nowhere. The
  // caller checks too; this is the guarantee rather than a duplicate of it.
  const [shown, setShown] = useState(INITIAL);
  if (!reviews.length) return null;

  const visible = reviews.slice(0, shown);

  return (
    <View style={styles.section}>
      <SectionHeader title="TMDB Reviews" />
      <View style={styles.caption}>
        <Text variant="caption" tone="tertiary">
          Written by members of themoviedb.org, not by Bingd users.
        </Text>
      </View>

      {visible.map((review) => (
        <Review key={review.id} review={review} />
      ))}

      {reviews.length > visible.length ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show more TMDB reviews"
          onPress={() => setShown((count) => count + INITIAL)}
          hitSlop={theme.space[2]}
          style={styles.more}
        >
          <Text variant="callout" tone="action">
            See more
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** How many open before "See more". Two is a sample; the rest is on request. */
const INITIAL = 2;

function Review({ review }: { review: TmdbReview }) {
  const [expanded, setExpanded] = useState(false);

  const openOnTmdb = () => {
    if (review.url) void Linking.openURL(review.url);
  };

  return (
    <View style={styles.review}>
      <View style={styles.head}>
        <Avatar size="sm" uri={review.avatarUri} name={review.author} />
        <View style={styles.headCopy}>
          <Text variant="callout" numberOfLines={1}>
            {review.author}
          </Text>
          <Text variant="caption" tone="tertiary" numberOfLines={1}>
            {[
              // TMDB's own 0–10, labelled as theirs. It looks exactly like a Bingd
              // score and means something else entirely — one is an opinion the
              // author typed, the other is a position in somebody's ordered list —
              // so it never appears as a bare number.
              review.rating !== null ? `Rated ${formatRating(review.rating)} on TMDB` : null,
              formatDate(review.createdAt),
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          expanded ? `Collapse review by ${review.author}` : `Expand review by ${review.author}`
        }
        onPress={() => setExpanded((open) => !open)}
      >
        <Text variant="body" numberOfLines={expanded ? undefined : 4}>
          {review.body}
          {expanded && review.truncated ? '…' : ''}
        </Text>
        {expanded ? null : (
          <Text variant="callout" tone="action">
            more
          </Text>
        )}
      </Pressable>

      {/* Offered only once the excerpt is open and only when there is genuinely more
          to read there. Sending somebody to a website to see the paragraph already in
          front of them is worse than not offering the link. */}
      {expanded && review.truncated && review.url ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Read the full review by ${review.author} on TMDB`}
          onPress={openOnTmdb}
          hitSlop={theme.space[2]}
        >
          <Text variant="callout" tone="action">
            Read the full review on TMDB
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** "8" rather than "8.0", and "7.5" when the author chose a half. */
function formatRating(rating: number) {
  return Number.isInteger(rating) ? String(rating) : rating.toFixed(1);
}

function formatDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const styles = StyleSheet.create({
  section: { paddingTop: theme.space[6], gap: theme.space[2] },
  caption: { paddingHorizontal: theme.layout.gutter },
  more: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
  review: {
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
    gap: theme.space[2],
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomColor: theme.border.hairline,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  headCopy: { flex: 1, gap: 1 },
});
