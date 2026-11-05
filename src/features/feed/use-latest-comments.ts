import { useQueries, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { commentsKey, readThread, type Comment } from './use-comments';

/**
 * The newest comment this reader may see on each Feed card (cinematic Feed, 2026-11-04).
 *
 * ---------------------------------------------------------------------------
 * ONE CACHE, ONE WRITER
 *
 * The preview is not a read of its own. Each card observes **the conversation's own query**
 * — `commentsKey(viewer, event)`, filled by `readThread` — and derives its line from that
 * with `select`. So the card and the conversation are two views of one cache entry, and:
 *
 *   · they cannot disagree: when the conversation reads a thread, the card shows the same
 *     answer, including "nothing";
 *   · ordering is the query library's: a refetch cancels the request it supersedes, and a
 *     cancelled or reset request's answer is never committed — so an old answer cannot land
 *     over a newer one, in any order or in the same turn;
 *   · sign-out clears the client, which cancels everything in flight with it.
 *
 * The first version kept a separate preview cache and reconciled it with the conversation's;
 * three rounds of independent review each found another ordering in which they disagreed.
 * This replaces all of that rather than adding a fourth guard.
 *
 * Every privacy rule is still the thread's own: `activity_comments` drops authors this
 * reader may not see and returns retracted comments as tombstones, and `latestOf` below
 * skips tombstones and replies whose root was withheld, exactly as the sheet's `threadsOf`
 * does. Masking is decided by `shouldMask` at the card.
 *
 * **Only for cards that have comments**, as before: a quiet page reads nothing more.
 * ---------------------------------------------------------------------------
 */
export type LatestComment = {
  id: string;
  authorId: string;
  authorUsername: string;
  authorName: string;
  authorAvatarUri: string | null;
  body: string;
  hasSpoilers: boolean;
  createdAt: string;
};

/**
 * The newest readable comment in a thread, or null.
 *
 * Replies count: "the most recent comment" is the last thing anybody said. A tombstone does
 * not — it has no words. A reply whose root the server withheld (its author is hidden from
 * this reader) is skipped, as the sheet's `threadsOf` drops it; a reply under a returned
 * tombstone is kept, as the sheet keeps it.
 */
export function latestOf(comments: readonly Comment[] | undefined): LatestComment | null {
  const present = new Set((comments ?? []).map((comment) => comment.id));
  let latest: Comment | null = null;
  for (const comment of comments ?? []) {
    if (comment.deleted || !comment.body) continue;
    if (comment.parentId !== null && !present.has(comment.parentId)) continue;
    if (!latest || comment.createdAt > latest.createdAt) latest = comment;
  }
  if (!latest || !latest.body) return null;
  return {
    id: latest.id,
    authorId: latest.authorId,
    authorUsername: latest.authorUsername,
    authorName: latest.authorName,
    authorAvatarUri: latest.authorAvatarUri,
    body: latest.body,
    hasSpoilers: latest.hasSpoilers,
    createdAt: latest.createdAt,
  };
}

/**
 * **Drop every thread at once, after anything that changes whom this reader may see.**
 *
 * Called by follow, unfollow, block and unblock. Reset rather than invalidated: a
 * refetching query keeps its last answer on screen, and a blocked person's words would stay
 * under the card while the refetch ran. Resetting clears the data synchronously, cancels any
 * request in flight (its answer is never committed), and refetches what is on screen — so
 * neither the card nor an open conversation shows anything until a read made after the
 * change has answered.
 */
export function resetCommentPreviews(queryClient: QueryClient, viewerId: string) {
  return queryClient.resetQueries({ queryKey: ['comments', viewerId] });
}

/**
 * `eventIds`: the cards with at least one comment this reader may see. Returns a map holding
 * an entry only for a thread read since this card mounted, that succeeded and has something
 * readable in it; anything else is absent, and the card draws no preview.
 */
export function useLatestComments(eventIds: readonly string[], viewerId: string) {
  const results = useQueries({
    queries: eventIds.map((eventId) => ({
      queryKey: commentsKey(viewerId, eventId),
      // The conversation's own settings: refetch on every mount, and discard the entry the
      // moment nothing observes it, so a card scrolled back into view never starts from
      // words that may since have been withdrawn.
      staleTime: 0,
      gcTime: 0,
      queryFn: () => readThread(eventId),
      // The conversation's setting too: every read is a new array, which is how an open
      // conversation tells an answer read since it opened from one it found in the cache.
      structuralSharing: false,
      select: latestOf,
    })),
  });

  // `useQueries` returns a new array every render, so the map is keyed on what it holds —
  // the body and the flag included, so an edit to the same comment redraws the preview.
  //
  // **Only a successful answer that has not since failed.** The entry is discarded the
  // moment nothing observes it (`gcTime: 0`), so a card that mounts never finds words left
  // over from an earlier visit; the only other observer is the open conversation, which
  // reads the same answer. A failed refetch is not evidence the comment still stands, so
  // the card then draws no preview rather than words that may be withdrawn.
  const verified = results.map((result) =>
    result.isSuccess && !result.isError ? result.data : null,
  );
  const signature = JSON.stringify(
    verified.map((data) => (data ? [data.id, data.body, data.hasSpoilers] : null)),
  );
  return useMemo(() => {
    const map = new Map<string, LatestComment>();
    verified.forEach((data, index) => {
      const eventId = eventIds[index];
      if (eventId && data) map.set(eventId, data);
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, eventIds]);
}
