import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { newOperationId } from '@/features/collection/writes';
import { diagnose } from '@/lib/diagnose';
import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

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
  };

  const run = async (fn: () => PromiseLike<{ error: unknown }>): Promise<CommentWriteResult> => {
    const { error } = await fn();
    if (error) {
      const message =
        diagnose(error) ??
        (error instanceof Error ? error.message : 'Something went wrong. Try again.');
      return { ok: false, message };
    }
    await refresh();
    return { ok: true };
  };

  const add = useMutation({
    mutationFn: ({
      eventId,
      body,
      hasSpoilers,
    }: {
      eventId: string;
      body: string;
      hasSpoilers: boolean;
    }) =>
      run(() =>
        supabase.rpc('add_comment', {
          p_operation_id: newOperationId(),
          p_feed_event_id: eventId,
          p_body: body,
          p_has_spoilers: hasSpoilers,
        }),
      ),
  });

  const edit = useMutation({
    mutationFn: ({
      commentId,
      body,
      hasSpoilers,
    }: {
      commentId: string;
      body: string;
      hasSpoilers: boolean;
    }) =>
      run(() =>
        supabase.rpc('edit_comment', {
          p_operation_id: newOperationId(),
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
