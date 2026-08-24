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
  authorId: string;
  authorUsername: string;
  authorName: string;
  authorAvatarUri: string | null;
  body: string;
  hasSpoilers: boolean;
  createdAt: string;
  editedAt: string | null;
};

type Embedded<T> = T | T[] | null;

type ProfileShape = {
  username: string;
  display_name: string | null;
  avatar_path: string | null;
};

type CommentRow = {
  id: string;
  feed_event_id: string;
  author_id: string;
  body: string;
  has_spoilers: boolean;
  created_at: string;
  edited_at: string | null;
  profiles: Embedded<ProfileShape>;
};

/**
 * PostgREST returns a to-one embed as an object and a to-many as an array, and its
 * generated types say array for both — the mistake that made the feed read "Someone
 * ranked a title" on every row (`use-feed.ts`).
 */
const one = <T>(value: Embedded<T>): T | null =>
  (Array.isArray(value) ? value[0] : value) ?? null;

/**
 * How many comments each event on screen has, for this viewer.
 *
 * Three things about the shape of this query are deliberate.
 *
 * **It selects ids and not bodies.** A feed is thirty events and the count is a
 * numeral on a row; downloading every comment on all of them to render thirty
 * numerals would be the same mistake as downloading a followee's collection to put
 * one score on a title. Bodies arrive when the sheet opens and not before.
 *
 * **It counts rows rather than asking the database for a total.** `comments_read`
 * requires visibility of both the author and the event's actor, so the rows that
 * arrive are already the authorised ones — a blocked person's comment is *absent*
 * rather than counted anonymously. A `count` aggregate would have run past the policy
 * in exactly the way that makes a number tell you something the list does not, and
 * this is the same reasoning `useReactions` records.
 *
 * **It is keyed by the account**, like every other viewer-relative key here. The count
 * genuinely differs between two people looking at the same event, so a key without the
 * account would serve one reader another's number after a switch. Reviews 6, 10 and
 * 10b were each this defect in a different place.
 */
export function useCommentCounts(eventIds: string[], viewerId: string) {
  const key = [...eventIds].sort().join(',');

  return useQuery({
    queryKey: ['comment-counts', viewerId, key],
    enabled: eventIds.length > 0,
    queryFn: async (): Promise<Map<string, number>> => {
      const { data, error } = await supabase
        .from('comments')
        .select('id, feed_event_id')
        .in('feed_event_id', eventIds);
      if (error) throw error;

      const counts = new Map<string, number>();
      for (const row of data ?? []) {
        const id = row.feed_event_id as string;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return counts;
    },
  });
}

/**
 * The comments on one event, oldest first.
 *
 * Oldest first because a flat comment list is a conversation and a conversation runs
 * downward — the newest remark is the one you scroll to, not the one that displaces
 * everything you were reading.
 *
 * An author whose profile embed did not resolve is **dropped**, not rendered as
 * "Someone". The row was readable and the profile was not, which means something is
 * inconsistent, and a comment attributed to nobody is worse than one fewer comment.
 * That is `use-feed.ts`'s rule, applied here for the same reason it was needed there.
 */
export function useComments(eventId: string | null, viewerId: string) {
  return useQuery({
    queryKey: ['comments', viewerId, eventId],
    enabled: Boolean(eventId),
    queryFn: async (): Promise<Comment[]> => {
      const { data, error } = await supabase
        .from('comments')
        .select(
          'id, feed_event_id, author_id, body, has_spoilers, created_at, edited_at, ' +
            'profiles:author_id(username, display_name, avatar_path)',
        )
        .eq('feed_event_id', eventId as string)
        .order('created_at', { ascending: true });
      if (error) throw error;

      const comments: Comment[] = [];
      for (const row of (data ?? []) as unknown as CommentRow[]) {
        const profile = one(row.profiles);
        const name = profile?.display_name || profile?.username;
        if (!profile || !name) continue;

        comments.push({
          id: row.id,
          eventId: row.feed_event_id,
          authorId: row.author_id,
          authorUsername: profile.username,
          authorName: name,
          authorAvatarUri: avatarUri(profile.avatar_path),
          body: row.body,
          hasSpoilers: row.has_spoilers,
          createdAt: row.created_at,
          editedAt: row.edited_at,
        });
      }
      return comments;
    },
  });
}

export type CommentWriteResult = { ok: true } | { ok: false; message: string };

/**
 * Posting, editing and deleting.
 *
 * No optimism, for the reason `useSetReaction` gives and one more. A reaction that
 * flickers between two states is a message sent and unsent; a comment that appears,
 * is read, and then vanishes because the write failed is worse — the author believes
 * they said something. So the list refetches and the remark appears once it exists.
 *
 * Both keys are invalidated after every write, and by *prefix* on the viewer rather
 * than on the exact event list: `['comment-counts', viewerId]` matches whatever set of
 * event ids the feed happened to build its key from, which is the drift that made
 * `['community-score', mediaItemId]` match nothing after its key gained an account
 * (review 10b). The count and the list are two views of one fact and must not
 * disagree.
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
     * count disagreeing with the list — the two views this module exists to keep in step. `lib/write-outcome.ts` is what separates a refusal this app raises on
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
    // Only `add` writes a notification, and this helper is shared by all three writers —
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
   * the second one looks exactly as legitimate as the first. `CommentSheet` now holds an
   * id per attempt-at-an-intent and passes it in.
   */
  const add = useMutation({
    mutationFn: ({
      operationId,
      eventId,
      body,
      hasSpoilers,
    }: {
      operationId: string;
      eventId: string;
      body: string;
      hasSpoilers: boolean;
    }) =>
      run(() =>
        supabase.rpc('add_comment', {
          p_operation_id: operationId,
          p_feed_event_id: eventId,
          p_body: body,
          p_has_spoilers: hasSpoilers,
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

  return {
    add: add.mutateAsync,
    edit: edit.mutateAsync,
    remove: remove.mutateAsync,
    busy: add.isPending || edit.isPending || remove.isPending,
  };
}

/** The database's bound, so the composer can stop the user before the round trip. */
export const COMMENT_MAX_LENGTH = 1000;
