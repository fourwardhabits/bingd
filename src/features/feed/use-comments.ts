import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { invalidateAwards } from '@/features/awards/invalidate';
import { newOperationId } from '@/features/collection/writes';
import { nudgePushDelivery } from '@/features/notifications/push';
import { diagnose } from '@/lib/diagnose';
import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';
import { classifyWrite, mustReconcile } from '@/lib/write-outcome';

export type Comment = {
  id: string;
  eventId: string;
  /** The top-level comment this answers, or null. Exactly one level — see the server. */
  parentId: string | null;
  authorId: string;
  authorUsername: string;
  authorName: string;
  authorAvatarUri: string | null;
  /**
   * Null for a comment its author has retracted.
   *
   * Not an empty string, and the difference is load-bearing: the row is still here
   * because replies hang off it, and a renderer that treats "no body" as "draw nothing"
   * would collapse the thread. `deleted` is what the surface branches on.
   */
  body: string | null;
  hasSpoilers: boolean;
  createdAt: string;
  editedAt: string | null;
  /** True for a tombstone: the row survives to hold its replies, the text does not. */
  deleted: boolean;
  reactionCount: number;
  reactedByMe: boolean;
};

type CommentRow = {
  id: string;
  parent_id: string | null;
  author_id: string;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  body: string | null;
  has_spoilers: boolean;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  reaction_count: number;
  reacted_by_me: boolean;
};

/**
 * How many comments each event on screen has, for this viewer.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS AN RPC NOW, WITH THE NUMBER THAT MADE IT ONE
 *
 * It used to select `id, feed_event_id` from `comments` and count the rows here. That
 * shape was chosen deliberately and the reasoning was right — a `count` aggregate would
 * have run past `comments_read` and produced a number that included a blocked person's
 * comment while the list did not show it.
 *
 * What nobody had measured is what the policy costs per row. `comments_read` is
 * `can_i_view(author_id) and exists (… can_i_view(e.actor_id))`, and `can_view_profile`
 * is up to four subqueries over `profiles`, `blocks` and `follows`. Against 31 events
 * and 340 comments — one feed page — that is **340 evaluations of the visibility oracle
 * to render 31 numerals**, and `EXPLAIN ANALYZE` put it at 61 ms of pure policy before
 * anybody had opened anything. The same read as the table owner, with the policy
 * bypassed, was 0.80 ms.
 *
 * `activity_comment_counts` states the identical rule and asks it once per event and
 * once per *distinct author* instead of once per row. Measured after: **2.6 ms**. No
 * authorisation was moved to the client and none was rewritten — `comments_read` still
 * governs every direct read of the table, and this function calls the same
 * `can_view_profile` the policy calls.
 *
 * It is still keyed by the account, for the reason it always was: the count genuinely
 * differs between two people looking at the same event, and a key without the account
 * serves one reader another's number after a switch (reviews 6, 10 and 10b).
 */
export function useCommentCounts(eventIds: string[], viewerId: string) {
  const key = [...eventIds].sort().join(',');

  return useQuery({
    queryKey: ['comment-counts', viewerId, key],
    enabled: eventIds.length > 0,
    queryFn: async (): Promise<Map<string, number>> => {
      const { data, error } = await supabase.rpc('activity_comment_counts', {
        p_feed_event_ids: eventIds,
      });
      if (error) throw error;

      const counts = new Map<string, number>();
      for (const row of (data ?? []) as { feed_event_id: string; comment_count: number }[]) {
        counts.set(row.feed_event_id, row.comment_count);
      }
      return counts;
    },
  });
}

/**
 * The comments on one event, oldest first, each root followed by its replies.
 *
 * ---------------------------------------------------------------------------
 * ONE QUERY, WHICH IS THE OTHER HALF OF THE SLOW SHEET
 *
 * This used to be a PostgREST select with a `profiles:author_id(...)` embed, which
 * PostgREST resolves as a second statement — two round trips, each paying the policy
 * again. Measured on a thread of 40 comments by 20 people: **11.35 ms across two
 * requests**, of which the list alone was 20.53 ms cold against 0.80 ms with the policy
 * bypassed. `activity_comments` is **2.22 ms in one request**, and it carries the like
 * counts as well.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SERVER DOES THAT THIS FILE THEREFORE DOES NOT
 *
 * **Dropping an unnameable author.** The function joins authors with an inner join, so
 * a comment whose author this reader may not see is *absent* rather than rendered as
 * "Someone". That was this file's rule (`use-feed.ts`'s, applied here) and it is now the
 * server's, which is the stronger place for it: a blocked person's remark never leaves
 * the database rather than being filtered on arrival.
 *
 * **Ordering.** Roots in time order, each followed by its own replies in time order. A
 * conversation runs downward, and doing the grouping here would mean two surfaces —
 * this sheet and the thread page — each sorting, and eventually disagreeing.
 *
 * ---------------------------------------------------------------------------
 * `staleTime: 0`, AND IT IS A BUG FIX
 *
 * The founder's report: "delete your own comment, it disappears for you, and other
 * users can still see it when they open comments from the Feed."
 *
 * The server was never the cause — `delete_comment` has really deleted the row since
 * `20260817000100`. The cause is `lib/query.ts`'s global one-minute `staleTime`, which
 * this query inherited: a second reader who had opened the thread within the last minute
 * was served their cache and no refetch was made, so they went on reading words their
 * author had retracted. A minute is a perfectly good default for a feed; it is the wrong
 * default for the one surface in this app whose contents somebody can withdraw.
 *
 * `staleTime: 0` alone was **not enough**, and independent review 43 was right to say so.
 * It guarantees a refetch on mount; it does not stop React Query rendering the previous
 * result while that refetch is in flight. So the second reader still saw the retracted
 * words — for a shorter time, from a cache instead of from a stale window, which is the
 * same bug with better timing.
 *
 * `gcTime: 0` is the other half: the entry is discarded when its last observer unmounts,
 * so reopening a thread starts from `isPending` with nothing to draw. Everywhere else in
 * this app the opposite is right — `LogSheet` deliberately shows what it had and corrects
 * itself, because a watch date does not become *unsayable*. **A comment does.** This is
 * the one surface whose contents somebody can withdraw, and a moment of correct-looking
 * stale text is exactly what was reported. A skeleton for one round trip — 2.2ms of
 * server time — is the right price.
 */
export function useComments(eventId: string | null, viewerId: string) {
  return useQuery({
    queryKey: ['comments', viewerId, eventId],
    enabled: Boolean(eventId),
    staleTime: 0,
    gcTime: 0,
    queryFn: async (): Promise<Comment[]> => {
      const { data, error } = await supabase.rpc('activity_comments', {
        p_feed_event_id: eventId as string,
      });
      if (error) throw error;

      return ((data ?? []) as CommentRow[]).map((row) => ({
        id: row.id,
        eventId: eventId as string,
        parentId: row.parent_id,
        authorId: row.author_id,
        authorUsername: row.username,
        authorName: row.display_name || row.username,
        authorAvatarUri: avatarUri(row.avatar_path),
        body: row.body,
        hasSpoilers: row.has_spoilers,
        createdAt: row.created_at,
        editedAt: row.edited_at,
        deleted: row.deleted_at !== null,
        reactionCount: row.reaction_count,
        reactedByMe: row.reacted_by_me,
      }));
    },
  });
}

/**
 * The thread as the surface draws it: each root, with its replies under it.
 *
 * Derived rather than fetched, and derived *here* rather than in the two components that
 * need it, so the sheet and the dedicated page cannot disagree about what a thread is.
 * The server already returns the rows in this order; this only groups them.
 *
 * A reply whose root is missing is dropped. That should be impossible — `parent_id`
 * cascades and a retracted root is tombstoned rather than removed precisely so its
 * replies keep a parent — so it is defensive rather than expected, and dropping is the
 * right direction: a reply rendered at the top level would read as a remark about the
 * activity rather than an answer to somebody.
 */
export type CommentThread = { root: Comment; replies: Comment[] };

export function threadsOf(comments: Comment[] | undefined): CommentThread[] {
  const threads: CommentThread[] = [];
  const byId = new Map<string, CommentThread>();

  for (const comment of comments ?? []) {
    if (comment.parentId === null) {
      const thread = { root: comment, replies: [] };
      byId.set(comment.id, thread);
      threads.push(thread);
    }
  }

  for (const comment of comments ?? []) {
    if (comment.parentId === null) continue;
    byId.get(comment.parentId)?.replies.push(comment);
  }

  return threads;
}

/** How many of these a count should promise. A tombstone is a spacer, not a remark. */
export const readableCount = (comments: Comment[] | undefined) =>
  (comments ?? []).filter((comment) => !comment.deleted).length;

export type CommentWriteResult = { ok: true } | { ok: false; message: string };

/**
 * Posting, editing, deleting and liking.
 *
 * No optimism, for the reason `useSetReaction` gives and one more. A reaction that
 * flickers between two states is a message sent and unsent; a comment that appears, is
 * read, and then vanishes because the write failed is worse — the author believes they
 * said something. So the list refetches and the remark appears once it exists.
 *
 * Both keys are invalidated after every write, and by *prefix* on the viewer rather than
 * on the exact event list: `['comment-counts', viewerId]` matches whatever set of event
 * ids the feed happened to build its key from, which is the drift that made
 * `['community-score', mediaItemId]` match nothing after its key gained an account
 * (review 10b). The count and the list are two views of one fact and must not disagree.
 */
export function useCommentWrites(viewerId: string) {
  const queryClient = useQueryClient();

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['comments', viewerId] }),
      queryClient.invalidateQueries({ queryKey: ['comment-counts', viewerId] }),
    ]);
    // Comment Gremlin counts what this reader has written, so the twentieth comment
    // moves a badge. It went unnoticed for the same reason every version of this bug
    // has: the award reads a table this file writes, and the two never met
    // (`awards/invalidate.ts`). Independent review 21b.
    invalidateAwards(queryClient, viewerId);
  };

  const run = async (fn: () => PromiseLike<{ error: unknown }>): Promise<CommentWriteResult> => {
    const { error } = await fn();

    /**
     * **Reconciled on an unknown outcome as well as on a commit.**
     *
     * A comment that is written and cannot say so leaves the thread short of it and the
     * count disagreeing with the list — the two views this module exists to keep in
     * step. `lib/write-outcome.ts` is what separates a refusal this app raises on
     * purpose — which proves nothing was written — from a dropped socket, a timeout, or
     * an `08007` out of the pooler, any of which can carry a committed transaction. This
     * helper used to return on any error and refresh only afterwards, which is the defect
     * independent review 21e found in four screens; it is the same defect here.
     */
    if (mustReconcile(classifyWrite(error as { code?: string }))) await refresh();

    if (error) {
      const message =
        diagnose(error) ??
        (error instanceof Error ? error.message : 'Something went wrong. Try again.');
      return { ok: false, message };
    }
    // Only `add` writes a notification, and this helper is shared by all the writers —
    // which is right rather than sloppy: a drain is global and debounced, so an edit that
    // happens to send somebody else's queued push is the mechanism working as intended.
    nudgePushDelivery();
    return { ok: true };
  };

  /**
   * **The operation id comes from the caller, and this is the only writer in the app
   * where that is load-bearing rather than tidy.**
   *
   * `_claim_operation` deduplicates a replayed intent, but only if the replay carries
   * the *same* id — `collection/writes.ts`'s module header says so, and this module was
   * minting a fresh one inside the writer. Every other RPC behind it is idempotent by
   * shape (a follow, a reaction, a tag set, a profile save all assign; `recommend_title`
   * is keyed on sender/recipient/title), so nothing accumulated and nobody noticed.
   * **`add_comment` inserts.** So: the reply is lost, the person is told it failed, they
   * press Post again, and there are two identical comments — no exception anywhere, and
   * the second one looks exactly as legitimate as the first. The composer holds an id
   * per attempt-at-an-intent and passes it in.
   *
   * `parentId` is whichever comment the reader tapped Reply on, including a reply. The
   * server re-points it at that thread's root, so this file never has to work out what a
   * thread is — see `add_comment`.
   */
  const add = useMutation({
    mutationFn: ({
      operationId,
      eventId,
      body,
      hasSpoilers,
      parentId = null,
    }: {
      operationId: string;
      eventId: string;
      body: string;
      hasSpoilers: boolean;
      parentId?: string | null;
    }) =>
      run(() =>
        supabase.rpc('add_comment', {
          p_operation_id: operationId,
          p_feed_event_id: eventId,
          p_body: body,
          p_has_spoilers: hasSpoilers,
          p_parent_id: parentId,
        }),
      ),
  });

  // An edit assigns rather than accumulates, so a replayed one is harmless whatever id
  // it carries — but it takes the caller's for the same reason: an intent has one id,
  // and a rule that holds only where it happens to matter is a rule nobody can apply.
  const edit = useMutation({
    mutationFn: ({
      operationId,
      commentId,
      body,
      hasSpoilers,
    }: {
      operationId: string;
      commentId: string;
      body: string;
      hasSpoilers: boolean;
    }) =>
      run(() =>
        supabase.rpc('edit_comment', {
          p_operation_id: operationId,
          p_comment_id: commentId,
          p_body: body,
          p_has_spoilers: hasSpoilers,
        }),
      ),
  });

  const remove = useMutation({
    mutationFn: ({ commentId }: { commentId: string }) =>
      run(() =>
        supabase.rpc('delete_comment', {
          p_operation_id: newOperationId(),
          p_comment_id: commentId,
        }),
      ),
  });

  /**
   * The like, which takes **the state wanted** rather than "toggle".
   *
   * A toggle is unsafe under exactly the condition this app assumes everywhere else: a
   * reply that never arrives. The reader sees the old state, taps again, and a flip
   * would undo the write that did land. Sending `on` means the retry converges on what
   * they asked for. The server's primary key makes the row idempotent and the operation
   * ledger stops a replay spending a second rate slot; neither of those helps if the
   * *intent* is relative, which is why all three exist.
   *
   * The id is minted per call rather than held across retries, and that is the one place
   * this differs from `add`: a like is not lost work. If the reply is lost the list is
   * reconciled below and the next tap is a fresh intent against a state the reader can
   * now see.
   */
  const react = useMutation({
    mutationFn: ({ commentId, on }: { commentId: string; on: boolean }) =>
      run(() =>
        supabase.rpc('set_comment_reaction', {
          p_operation_id: newOperationId(),
          p_comment_id: commentId,
          p_on: on,
        }),
      ),
  });

  return {
    add: add.mutateAsync,
    edit: edit.mutateAsync,
    remove: remove.mutateAsync,
    react: react.mutateAsync,
    busy: add.isPending || edit.isPending || remove.isPending,
    // Deliberately outside `busy`. A like is a tap on one row and must not disable the
    // composer or the Post button while it is in flight.
    reacting: react.isPending,
  };
}

/** The database's bound, so the composer can stop the user before the round trip. */
export const COMMENT_MAX_LENGTH = 1000;
