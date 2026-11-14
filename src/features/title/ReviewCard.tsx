import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar, EditAction, ScoreBadge, SpoilerNote, Text } from '@/ui/components';
import { scoreBadgeMetrics } from '@/ui/components/ScoreBadge';
import { theme } from '@/ui/tokens';

/**
 * One review, as every review surface draws it (FU1113-F, 2026-11-14).
 *
 * The fields a card needs and nothing about where it came from: the title page's preview,
 * the See all sheet and the original Reviews tab all read `title_reviews_v2` rows, and all
 * three hand them here, so the three cannot disagree about Helpful, spoilers or who may
 * edit what.
 */
export type ReviewCardReview = {
  /** `user_media.id`: the vote's and the report's subject. */
  id: string;
  /** The name drawn: display name, falling back to the handle. Never the account id. */
  username: string;
  /** Already formatted for reading (`formatReviewDate`); empty when unknown. */
  date: string;
  text: string;
  /** The author's own claim. Shown as a marker; masking is `masked`'s job. */
  spoilers: boolean;
  helpfulCount: number;
  viewerHelpful: boolean;
  /** The reader wrote it: Edit instead of Helpful, and never masked. */
  isOwn: boolean;
};

export type ReviewCardProps = {
  review: ReviewCardReview;
  /** Own review only: opens the one review editor (`openLog('review')`). */
  onEdit?: () => void;
  /** Somebody else's review only: marks it helpful, or takes the mark back. */
  onToggleHelpful?: () => void;
  /** This review's vote is in flight: announced busy, and a second tap is ignored. */
  helpfulPending?: boolean;
  /** Lines before `… more`. Omit for the whole review. */
  collapsedLines?: number;
  testID?: string;

  // Everything below is optional and carries what each surface already showed, so moving
  // a surface onto the card loses nothing.

  /** A face beside the name. */
  avatar?: { uri: string | null; name: string } | null;
  /**
   * The author's live score, yours included (QA1114-REVIEWS §2): null when they wrote
   * without ranking, which draws what `UNRANKED_REVIEW_SCORE` says.
   */
  score?: number | null;
  /** From `shouldMask`. Ignored on your own review, which you have obviously read. */
  masked?: boolean;
  /** Names the title in the spoiler reveal ("movie", "season"). */
  noun?: string;
  /** The handle, for the spoken name. */
  handle?: string;
  /** Name press → the author's profile. */
  onPressAuthor?: () => void;
  /** The report overflow. Never on your own review: the server refuses a self-report. */
  onReport?: () => void;
  /** Press on the text (the preview: opens See all). */
  onPressBody?: () => void;
  bodyAccessibilityLabel?: string;
  bodyAccessibilityHint?: string;
};

/** The words under a review, or nothing at zero. Never names anybody. */
export function helpfulCountCopy(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? '1 person found this helpful' : `${count} people found this helpful`;
}

/**
 * **What a review whose author has not ranked the title shows where the score goes**
 * (D-R2, QA1114-REVIEWS, 2026-11-14; default pending the founder's confirmation).
 *
 * - `'none'` (the default, option a): no circle at all; the action rises to the top of
 *   the same right-hand column, on the same axis it has under a circle.
 * - `'placeholder'` (option b): a "Not ranked" placeholder in the circle's place. Not
 *   drawn yet — choosing it is this one line plus the small component `reviewScoreSlot`'s
 *   `'placeholder'` answer would render.
 *
 * Hiding such reviews altogether (option c) is a visibility change and is not this
 * switch's to make.
 */
export type UnrankedReviewScore = 'none' | 'placeholder';
export const UNRANKED_REVIEW_SCORE: UnrankedReviewScore = 'none';

/** What sits above the action: the author's circle, nothing, or (option b) a placeholder. */
export function reviewScoreSlot(
  score: number | null | undefined,
  unranked: UnrankedReviewScore = UNRANKED_REVIEW_SCORE,
): 'badge' | UnrankedReviewScore {
  return score === null || score === undefined ? unranked : 'badge';
}

/** The date as a review prints it: `14 Nov 2026`, in the reader's locale order. */
export function formatReviewDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * **The review card** (FU1113-F).
 *
 * The recommendation-message card's language — a white raised surface, a hairline and the
 * control radius — rather than the Parchment band "Your review" used to sit in: a review
 * is a person's opinion like any other, and yours differs by its control, not its colour.
 *
 *   ┌──────────────────────────────────────────┐
 *   │ (o) Name, truncated…              (8.4)  │   the author's score, yours included
 *   │     14 Nov 2026                  [action] │   action: Edit (yours) or 👍 (theirs)
 *   │ The review text, at the card's full      │
 *   │ inner width, clamped, … more              │
 *   │ 3 people found this helpful           ⋯   │   count omitted at 0; ⋯ = Report
 *   └──────────────────────────────────────────┘
 *
 * **The header** (QA1114-REVIEWS §2, 2026-11-14): who and when on the left, and on the
 * right one fixed-width column — the score circle with the action directly beneath it,
 * both centred on the column's axis. The header simply grows to that column's height;
 * the text is a sibling *below* the header, never beside the column, so a long review
 * always reads at the full width and the column can never overlap it. A long name
 * truncates on one line rather than pushing the column. An author who has not ranked the
 * title has no circle (`UNRANKED_REVIEW_SCORE`), and the action sits alone at the top of
 * the same column.
 *
 * The Helpful *count* stays in the footer, in words, where it has always been; only the
 * icon is in the column.
 *
 * No Helpful on your own (the server refuses a self-vote with 42501), no Edit on anybody
 * else's, and no "Your review" heading: your name and date say whose it is. Identical on
 * Android and iOS: nothing here branches on the platform.
 */
export function ReviewCard({
  review,
  onEdit,
  onToggleHelpful,
  helpfulPending = false,
  collapsedLines,
  testID = 'review-card',
  avatar,
  score = null,
  masked = false,
  noun,
  handle,
  onPressAuthor,
  onReport,
  onPressBody,
  bodyAccessibilityLabel,
  bodyAccessibilityHint,
}: ReviewCardProps) {
  const count = helpfulCountCopy(review.helpfulCount);
  const report = review.isOwn ? undefined : onReport;
  const slot = reviewScoreSlot(score);
  // Wide enough for the 44pt action and for the circle at the largest text size it
  // scales to, so neither is ever squeezed by a long name beside it.
  const stackWidth = Math.max(theme.layout.minTapTarget, scoreBadgeMetrics('sm').diameter);

  const action = review.isOwn ? (
    onEdit ? (
      <EditAction onPress={onEdit} accessibilityLabel="Edit your review" testID="edit-review" />
    ) : null
  ) : onToggleHelpful ? (
    <HelpfulToggle
      selected={review.viewerHelpful}
      pending={helpfulPending}
      author={review.username}
      onToggle={onToggleHelpful}
    />
  ) : null;

  const who = (
    <>
      {avatar ? <Avatar size="sm" uri={avatar.uri} name={avatar.name} /> : null}
      <View style={styles.whoCopy}>
        <Text variant="callout" numberOfLines={1}>
          {review.username}
        </Text>
        {review.date ? (
          <Text variant="caption" tone="tertiary" numberOfLines={1}>
            {review.date}
          </Text>
        ) : null}
      </View>
    </>
  );

  const note = (
    <SpoilerNote
      text={review.text}
      hasSpoilers={review.spoilers}
      // Never masked: it is the reader's own writing. Its spoiler claim still shows.
      masked={review.isOwn ? false : masked}
      numberOfLines={collapsedLines}
      titleForLabel={noun}
    />
  );

  return (
    <View style={styles.card} testID={testID}>
      <View style={styles.head} testID="review-card-head">
        {onPressAuthor ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={handle ? `${review.username}, @${handle}` : review.username}
            accessibilityHint="Opens their profile"
            onPress={onPressAuthor}
            style={({ pressed }) => [styles.who, pressed && styles.pressed]}
          >
            {who}
          </Pressable>
        ) : (
          <View style={styles.who}>{who}</View>
        )}

        {slot === 'badge' || action ? (
          <View style={[styles.stack, { width: stackWidth }]} testID="review-card-stack">
            {/* The circle, or under option (b) the placeholder `reviewScoreSlot` names. */}
            {slot === 'badge' && score !== null ? (
              <View testID="review-card-score">
                <ScoreBadge score={score} size="sm" />
              </View>
            ) : null}
            {action}
          </View>
        ) : null}
      </View>

      {onPressBody ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={bodyAccessibilityLabel}
          accessibilityHint={bodyAccessibilityHint}
          onPress={onPressBody}
          style={({ pressed }) => pressed && styles.pressed}
          testID={`${testID}-body`}
        >
          {note}
        </Pressable>
      ) : (
        note
      )}

      {count || report ? (
        <View style={styles.foot}>
          {count ? (
            <Text
              variant="caption"
              tone="tertiary"
              style={styles.count}
              testID="review-helpful-count"
            >
              {count}
            </Text>
          ) : (
            <View style={styles.count} />
          )}
          {report ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Report ${review.username}'s review`}
              accessibilityHint="Tells whoever runs bingd about this review"
              onPress={report}
              // Slop to the 44pt floor around a 20pt glyph: quiet to look at, not to hit.
              hitSlop={(theme.layout.minTapTarget - theme.layout.icon.sm) / 2}
              style={({ pressed }) => pressed && styles.pressed}
              testID="review-report"
            >
              <Ionicons
                name="ellipsis-horizontal"
                size={theme.layout.icon.sm}
                color={theme.text.tertiary}
              />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The thumbs-up: icon only, a full 44pt target drawn as one (no slop for a card edge to
 * clip), and the selection announced rather than only coloured.
 */
function HelpfulToggle({
  selected,
  pending,
  author,
  onToggle,
}: {
  selected: boolean;
  pending: boolean;
  author: string;
  onToggle: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={selected ? 'Remove helpful' : 'Mark review helpful'}
      accessibilityHint={
        selected ? `Takes back your mark on ${author}'s review` : `Tells ${author} their review helped`
      }
      accessibilityState={{ selected, busy: pending }}
      // A second tap while the first is in flight would snapshot an optimistic state and
      // could roll back to a mark the server never accepted; see `useSetReviewHelpful`.
      onPress={pending ? undefined : onToggle}
      style={({ pressed }) => [styles.helpful, pressed && styles.pressed]}
      testID="review-helpful"
    >
      <Ionicons
        name={selected ? 'thumbs-up' : 'thumbs-up-outline'}
        size={theme.layout.icon.sm}
        color={selected ? theme.semantic.action : theme.text.secondary}
        testID={selected ? 'review-helpful-filled' : 'review-helpful-outline'}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: theme.space[2],
    paddingHorizontal: theme.space[3],
    paddingVertical: theme.space[3],
    borderRadius: theme.radius.control,
    backgroundColor: theme.surface.raised,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    ...theme.elevation.e1,
  },
  // Top-aligned: who and when sit level with the circle, and the header is as tall as
  // the column on the right, so the text below starts under both.
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space[2] },
  // `minWidth: 0` lets a long name truncate inside the row instead of widening it.
  who: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  // 1pt: the name and its date read as one two-line label, as on every person row.
  whoCopy: { flex: 1, minWidth: 0, gap: 1 },
  /**
   * The circle over the action, centred on one axis. The column sits inside the card's
   * padding (the overhang the lone action used to take into it is gone: a circle above
   * it would have been pushed into the padding too), so the 44pt targets stay wholly
   * inside the card and nothing clips them.
   */
  stack: { flexShrink: 0, alignItems: 'center' },
  helpful: {
    minWidth: theme.layout.minTapTarget,
    minHeight: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  foot: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  count: { flex: 1 },
  pressed: { opacity: 0.7 },
});
