import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';

import { track } from '@/lib/analytics';
import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

/**
 * The five orders the tab offers, as the server names them.
 *
 * Two axes with a direction and one filter, which is why this is a flat union rather than
 * a `SortState`: `following` has no ascending sense to express. The client's control is
 * still the sort contract's state machine (`ui/sort.ts`) — this union is what that machine
 * resolves *to* before it crosses the wire, and it is also exactly the analytics value.
 */
export type ReviewSort = 'top_desc' | 'top_asc' | 'following' | 'recent_desc' | 'recent_asc';

export const DEFAULT_REVIEW_SORT: ReviewSort = 'top_desc';

export type TitleReview = {
  /**
   * The `user_media` row this review is written on, which is also its report subject and
   * now the thing a Helpful vote is keyed on.
   *
   * A review is a public note on a row keyed by `(user_id, media_item_id)`, and
   * `reports.subject_id` is one uuid — so 20260825000100 gave the row a surrogate name
   * rather than let two people's reviews of the same film collide on the
   * one-open-report index and silently drop the second complaint.
   */
  id: string;
  userId: string;
  username: string;
  name: string;
  avatarUri: string | null;
  /** The author's own Bingd score, or null if they wrote without ranking. */
  score: number | null;
  text: string;
  hasSpoilers: boolean;
  updatedAt: string | null;
  /** Reactions on the activity this note belongs to. */
  reactionCount: number;
  /** How many readers said this review helped them. */
  helpfulCount: number;
  /** Whether this viewer is one of them. */
  viewerHelpful: boolean;
};

const reviewsKey = (mediaItemId: string | null, sort: ReviewSort) =>
  ['title-reviews', mediaItemId, sort] as const;

/**
 * Reviews on a title, which are Bingd's own public Notes.
 *
 * **There is no second content model, and that is the whole design.** A review is a
 * public Note on this exact canonical movie or season — the same text the Feed shows,
 * governed by the same `note_visibility`, carrying the same spoiler flag, reportable
 * the same way. One source of truth, which is what the founder asked for in as many
 * words. Writing one is `save_note` through the log sheet; there is no separate
 * composer and there is nothing to keep in step.
 *
 * `title_reviews_v2` is definer and reuses `public_notes`' visibility predicate verbatim,
 * so a private author, a block in either direction and a suspended account are all
 * handled in the one place this schema expresses that rule.
 *
 * **Why v2 and not `title_reviews`.** A public App Store build (1.0.0 (7)) is calling the
 * old function today and its return shape cannot grow columns without a drop-and-create
 * that would break it. `20260911000100`'s header sets out all three options and why this
 * is the only safe one; the old function is untouched and still granted.
 */
export function useTitleReviews(mediaItemId: string | null, sort: ReviewSort) {
  return useQuery({
    queryKey: reviewsKey(mediaItemId, sort),
    enabled: Boolean(mediaItemId),
    queryFn: async (): Promise<TitleReview[]> => {
      const { data, error } = await supabase.rpc('title_reviews_v2', {
        p_media_item_id: mediaItemId,
        p_sort: sort,
        p_limit: 50,
      });
      if (error) throw error;

      return ((data ?? []) as {
        id: string;
        user_id: string;
        username: string;
        display_name: string | null;
        avatar_path: string | null;
        note: string;
        has_spoilers: boolean;
        updated_at: string | null;
        score: string | number | null;
        reaction_count: number | null;
        helpful_count: number | null;
        viewer_helpful: boolean | null;
      }[]).map((row) => ({
        id: row.id,
        userId: row.user_id,
        username: row.username,
        name: row.display_name || row.username,
        avatarUri: avatarUri(row.avatar_path),
        // `numeric` crosses the wire as a string. Converted once, here, rather than at
        // every place a score is formatted.
        score: row.score === null ? null : Number(row.score),
        text: row.note,
        hasSpoilers: row.has_spoilers,
        updatedAt: row.updated_at,
        reactionCount: row.reaction_count ?? 0,
        helpfulCount: row.helpful_count ?? 0,
        viewerHelpful: row.viewer_helpful ?? false,
      }));
    },
  });
}

/**
 * How many public reviews this title has, for the tab label.
 *
 * Its own read rather than the length of the list above, because the label has to be
 * right *before* the tab is opened — deriving it from the list would mean fetching fifty
 * reviews on every title page to render one digit. Same predicate on the server, so the
 * number and the rows can never disagree.
 */
export function useTitleReviewCount(mediaItemId: string | null) {
  return useQuery({
    queryKey: ['title-review-count', mediaItemId],
    enabled: Boolean(mediaItemId),
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase.rpc('title_review_count', {
        p_media_item_id: mediaItemId,
      });
      if (error) throw error;
      return typeof data === 'number' ? data : 0;
    },
  });
}

/**
 * Saying a review helped, and taking it back.
 *
 * **Optimistic, and reconciled from the server's own numbers.** The tap has to feel
 * immediate — it is one glyph and a digit — so the cache moves first. What comes back is
 * not discarded: `set_review_helpful` returns the count and the caller's state as they
 * are *after* the write, and those replace the guess. That matters because the guess can
 * be wrong in a way a client cannot detect — somebody else voted between the render and
 * the tap, and the true count is two ahead rather than one.
 *
 * On failure the previous cache is put back verbatim. There is no error surface here by
 * design: a Helpful that did not take is not worth a modal, and the count returning to
 * what it was is the honest report. The refusals that can actually occur — your own
 * review, a review you may not see — are already impossible to reach from the UI, which
 * hides the control on your own review and never renders one you cannot see.
 *
 * Every sort's cache is updated, not just the visible one, because the same review is in
 * several of them and switching tabs must not show a stale number.
 */
export function useSetReviewHelpful(mediaItemId: string | null) {
  const client = useQueryClient();

  return useMutation({
    /**
     * One at a time, per title.
     *
     * Independent review found this: every tap started an independent request, so a quick
     * Helpful-then-undo could reach the database in the order it was sent and complete in
     * the other. The removal runs first and deletes nothing; the insert lands after it;
     * the row is left marked when the reader's last intent was to clear it — and because
     * the client then reconciles against the server, it faithfully displays the wrong
     * answer.
     *
     * A scope makes TanStack run mutations sharing it in series, so the second request is
     * not sent until the first has settled and **the last tap is the last write**. Keyed
     * on the title rather than the review because that is the granularity a reader can
     * actually tap at speed, and serialising two different reviews on one page costs
     * nothing at this rate.
     */
    scope: { id: `review-helpful-${mediaItemId ?? 'none'}` },

    /**
     * The scope orders the writes; `isPending` is what stops them queueing.
     *
     * Serialising alone was not enough, and the second review round found why: TanStack
     * pauses a queued mutation's `mutationFn`, but it runs every queued mutation's
     * `onMutate` **immediately**. Two fast taps therefore take two snapshots, the second
     * of which is a snapshot of the first one's optimistic state — and if both requests
     * then fail, the second rollback restores that optimistic state and the cache keeps a
     * mark the server never accepted. A refetch repairs it; offline, nothing does.
     *
     * So the caller refuses to start a second write for a review while one is in flight
     * (see `app/title/[id].tsx`). One optimistic change exists at a time, which is the
     * condition under which snapshot-and-restore is exactly right. The scope is kept
     * anyway: it still orders writes across two different reviews on one page.
     */

    mutationFn: async ({ reviewId, helpful }: { reviewId: string; helpful: boolean }) => {
      const { data, error } = await supabase.rpc('set_review_helpful', {
        p_operation_id: Crypto.randomUUID(),
        p_review_id: reviewId,
        p_helpful: helpful,
      });
      if (error) throw error;
      return data as { helpful_count: number; viewer_helpful: boolean };
    },

    onMutate: async ({ reviewId, helpful }) => {
      const keys = SORTS.map((sort) => reviewsKey(mediaItemId, sort));
      await Promise.all(keys.map((key) => client.cancelQueries({ queryKey: key })));

      const previous = keys.map((key) => [key, client.getQueryData<TitleReview[]>(key)] as const);
      for (const [key] of previous) {
        client.setQueryData<TitleReview[]>(key, (rows) =>
          rows?.map((row) =>
            row.id === reviewId
              ? {
                  ...row,
                  viewerHelpful: helpful,
                  // Clamped at zero: an un-vote on a cache that has already been
                  // corrected downwards must not print -1 for the moment before the
                  // server answers.
                  helpfulCount: Math.max(0, row.helpfulCount + (helpful ? 1 : -1)),
                }
              : row,
          ),
        );
      }
      return { previous };
    },

    onError: (_error, _variables, context) => {
      for (const [key, rows] of context?.previous ?? []) client.setQueryData(key, rows);
    },

    onSuccess: (result, { reviewId, helpful }) => {
      for (const sort of SORTS) {
        client.setQueryData<TitleReview[]>(reviewsKey(mediaItemId, sort), (rows) =>
          rows?.map((row) =>
            row.id === reviewId
              ? {
                  ...row,
                  helpfulCount: result?.helpful_count ?? row.helpfulCount,
                  viewerHelpful: result?.viewer_helpful ?? row.viewerHelpful,
                }
              : row,
          ),
        );
      }
      track({ name: helpful ? 'review_helpful_added' : 'review_helpful_removed' });
    },

    /**
     * The order only settles on a refetch, deliberately.
     *
     * Re-sorting the list under the reader's thumb the instant they tap would move the
     * review they are looking at somewhere else on the screen, which is the one thing a
     * vote must not do. The count updates in place; the position updates the next time
     * the tab is opened or the query refetches.
     */
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['title-reviews', mediaItemId] });
    },
  });
}

/** Every sort whose cache holds the same review, so a vote reaches all of them. */
const SORTS: ReviewSort[] = ['top_desc', 'top_asc', 'following', 'recent_desc', 'recent_asc'];
