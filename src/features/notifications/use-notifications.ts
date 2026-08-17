import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

/**
 * The kinds of notification this app writes, and the only ones it renders.
 *
 * A closed union rather than a string, because the founder's rule for this surface was
 * to render an event only where its meaning is unambiguous. Anything the database
 * grows later appears here as `null` from `verbFor` and is dropped, which is a
 * deliberate silence rather than a row that says "something happened".
 */
export type NotificationKind =
  | 'follow'
  | 'follow_request'
  | 'follow_approved'
  | 'reaction'
  | 'comment'
  | 'watch_tag';

export type Notification = {
  id: string;
  kind: NotificationKind;
  createdAt: string;
  readAt: string | null;
  actorId: string | null;
  actorUsername: string | null;
  actorName: string | null;
  actorAvatarUri: string | null;
  /** The title the event was about, where there is one. */
  mediaItemId: string | null;
  mediaTitle: string | null;
};

const KINDS = new Set<string>([
  'follow',
  'follow_request',
  'follow_approved',
  'reaction',
  'comment',
  'watch_tag',
]);

/**
 * The caller's own inbox.
 *
 * `my_notifications` is definer and the reason is the whole design of this surface: a
 * private account requesting to follow another private account fails
 * `can_view_profile`, so an invoker query would return the request with no name
 * attached and the one control that resolves it could not be drawn. The request would
 * be permanently unanswerable, which turns the private setting into a trap. It takes
 * no recipient and cannot be asked about anybody else — the same shape as `my_blocks`.
 *
 * Rows whose actor cannot be named are dropped rather than rendered anonymously. That
 * happens for a system notification with no actor at all, which nothing writes yet;
 * when something does, this is where it gets a case rather than a blank avatar.
 */
export function useNotifications(viewerId: string) {
  return useQuery({
    queryKey: ['notifications', viewerId],
    // Short, because the useful thing about an inbox is that it is current, and this
    // is one round trip against an index on (recipient_id, created_at desc).
    staleTime: 30_000,
    queryFn: async (): Promise<Notification[]> => {
      const { data, error } = await supabase.rpc('my_notifications', { p_limit: 100 });
      if (error) throw error;

      return ((data ?? []) as {
        id: string;
        kind: string;
        created_at: string;
        read_at: string | null;
        actor_id: string | null;
        actor_username: string | null;
        actor_display_name: string | null;
        actor_avatar_path: string | null;
        media_item_id: string | null;
        media_title: string | null;
      }[])
        .filter((row) => KINDS.has(row.kind) && Boolean(row.actor_username))
        .map((row) => ({
          id: row.id,
          kind: row.kind as NotificationKind,
          createdAt: row.created_at,
          readAt: row.read_at,
          actorId: row.actor_id,
          actorUsername: row.actor_username,
          actorName: row.actor_display_name || row.actor_username,
          actorAvatarUri: avatarUri(row.actor_avatar_path),
          mediaItemId: row.media_item_id,
          mediaTitle: row.media_title,
        }));
    },
  });
}

/**
 * How many are unanswered.
 *
 * Only follow requests count. A reaction is not a task and a comment is not a task;
 * a request is somebody waiting on the reader, and it is the one thing in this inbox
 * that stays true until they act. A badge over the other kinds would be a number that
 * means "we have news", which nobody can act on.
 */
export function pendingRequestCount(notifications: Notification[] | undefined) {
  return (notifications ?? []).filter((row) => row.kind === 'follow_request').length;
}

export function unreadCount(notifications: Notification[] | undefined) {
  return (notifications ?? []).filter((row) => !row.readAt).length;
}

/**
 * What the row says happened, in the second person.
 *
 * One place, because the wording is the only thing distinguishing three follow states
 * that are otherwise the same row — and `follow_request` versus `follow_approved` is
 * exactly the pair that reads backwards if it is written twice.
 */
export function verbFor(kind: NotificationKind): string {
  switch (kind) {
    case 'follow':
      return 'started following you';
    case 'follow_request':
      return 'wants to follow you';
    case 'follow_approved':
      return 'approved your follow request';
    case 'reaction':
      return 'reacted to your activity';
    case 'comment':
      return 'commented on your activity';
    case 'watch_tag':
      return 'watched something with you';
  }
}

/**
 * Marks the whole inbox read.
 *
 * All at once because there is no per-row surface and the useful meaning of "read" on
 * a list somebody opens is "has seen this screen". `read_at` and the partial index
 * behind it were declared with the notifications table and had no writer until now.
 */
export function useMarkNotificationsRead(viewerId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('mark_notifications_read');
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications', viewerId] }),
  });
}
