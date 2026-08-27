import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';
import { classifyWrite, mustReconcile } from '@/lib/write-outcome';

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
  | 'watch_tag'
  | 'recommendation'
  /**
   * Somebody this reader invited reached activation — ten ranked titles (PRD §28).
   *
   * **The writer arrived on 2026-08-19** (`20260819000500`), and the order it arrived
   * in is the point. The type, its preference category and its route were all built
   * first, deliberately, while `invite_attributions.activated_at` still had no writer:
   * so when `_maybe_activate_invite` filed its first row, that row was already
   * rendered, already silenceable through the `invites` category, and already routed
   * to the person who joined. Nothing here had to change.
   *
   * Written server-side at the activation transition, once — never from a client
   * observing the column, which could not tell a crossing from a state. That is the
   * same distinction `award_earned` below is still waiting on.
   */
  | 'invite_activated'
  /**
   * The invitee's own welcome, filed by `redeem_invite` at the moment an invitation
   * is accepted (`20260823000100`).
   *
   * The only kind in this list whose recipient is the *new* account. Everything else
   * is news about somebody acting on an established reader; this is the first thing
   * a person ever sees in Bingd, and it exists because the invitee was the one party
   * to the exchange being told nothing — the inviter already gets a `follow`, and the
   * follow itself already happens without either of them watching it.
   *
   * Written server-side inside the redemption, so a lost reply or a remount cannot
   * produce a second one, and cannot lose the first.
   */
  | 'invite_welcome'
  /**
   * An award tier was crossed. **Nothing writes this yet, and this run did not
   * build it.**
   *
   * Award tiers are computed on the device from raw table reads
   * (`src/features/awards/progress.ts` over `tracks.ts`), and no server-side row
   * records which tier an account has reached. Notifying only on a *crossing* —
   * 49 to 50 yes, 50 to 51 no — therefore needs a durable record of the previous
   * tier, and the only honest place for it is a server-side unlock ledger. A
   * client-held "last seen tier" is exactly the observed-state assumption Review
   * 21 spent seven rounds proving unsafe: a reinstall, a second device or a lost
   * reply each turn it into either a missed award or a repeated one.
   */
  | 'award_earned';

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
  /** A film or a season, which is what the sentence says out loud. */
  mediaKind: 'movie' | 'series' | 'season' | null;
  /** The show a season belongs to. A season's own title is "Season 2". */
  seriesTitle: string | null;
  /**
   * What the row points at, as the database recorded it.
   *
   * Carried so that routing can tell two silences apart. A `comment` row always has
   * a `feed_event` subject; `mediaItemId` going null therefore means the event was
   * deleted rather than that there was never one — the join in `my_notifications`
   * that resolves the title requires the event to still exist *and* still belong to
   * this reader. `routing.ts` reads exactly that difference.
   */
  subjectType: string | null;
  subjectId: string | null;
};

const KINDS = new Set<string>([
  'follow',
  'follow_request',
  'follow_approved',
  'reaction',
  'comment',
  'watch_tag',
  'recommendation',
  'invite_activated',
  'invite_welcome',
  'award_earned',
]);

/**
 * The kinds that are somebody doing something, rather than something happening.
 *
 * Everything here is drawn with a name and a face, so a row that cannot name its
 * actor is dropped rather than rendered anonymously. `award_earned` is the first
 * kind that is genuinely nobody's action — it has a null `actor_id` by construction —
 * and it is not held to that rule. Before it existed the rule was simply "always",
 * which would have silently swallowed the first actorless notice ever written.
 */
const ACTORLESS_KINDS = new Set<string>(['award_earned']);

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
  const query = useQuery({
    queryKey: ['notifications', viewerId],
    // Short, because the useful thing about an inbox is that it is current, and this
    // is one round trip against an index on (recipient_id, created_at desc).
    staleTime: 30_000,
    /**
     * The one query in the app that opts out of the global `refetchOnWindowFocus:
     * false`, because it is the one whose whole job is to be current about something
     * somebody else did.
     *
     * It does nothing without `startQueryFocusTracking` (`lib/query.ts`), which is
     * what makes "focus" mean "the app came back to the foreground" rather than a
     * browser event that never fires here.
     */
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<Notification[]> => {
      const { data, error } = await supabase.rpc('my_notifications', { p_limit: 100 });
      if (error) throw error;

      return (
        (data ?? []) as {
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
          media_kind: 'movie' | 'series' | 'season' | null;
          series_title: string | null;
          subject_type: string | null;
          subject_id: string | null;
        }[]
      )
        .filter(
          (row) =>
            KINDS.has(row.kind) &&
            (Boolean(row.actor_username) || ACTORLESS_KINDS.has(row.kind)),
        )
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
          mediaKind: row.media_kind,
          seriesTitle: row.series_title,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
        }));
    },
  });

  /**
   * The other half of "current": moving between tabs.
   *
   * Foreground is covered above, but the tab navigator keeps every visited tab
   * mounted, so walking from Collection back to Feed creates no new observer and
   * asks the server nothing. This is the boundary that closes it.
   *
   * **Gated on staleness rather than firing every time.** An ungated `refetch()`
   * ignores `staleTime` by design, which would turn a reader flicking between two
   * tabs into a request per tap. Read through a ref so the callback identity does
   * not change with the flag and re-run the effect on its own.
   */
  const { refetch, isStale } = query;
  const stale = useRef(isStale);
  // Mirrored in an effect rather than assigned during render: a ref written while
  // rendering is torn between two passes under concurrent rendering, and the lint rule
  // that says so is right even where this one would have got away with it.
  useEffect(() => {
    stale.current = isStale;
  }, [isStale]);

  useFocusEffect(
    useCallback(() => {
      if (stale.current) void refetch();
    }, [refetch]),
  );

  return query;
}

/**
 * How many are unanswered.
 *
 * Only follow requests count. A reaction is not a task and a comment is not a task;
 * a request is somebody waiting on the reader, and it is the one thing in this inbox
 * that stays true until they act — which is why Settings' row says "3 waiting" rather
 * than repeating the bell's number.
 */
export function pendingRequestCount(notifications: Notification[] | undefined) {
  return (notifications ?? []).filter((row) => row.kind === 'follow_request').length;
}

/**
 * How much has not been read, which is what the bell carries.
 *
 * It only became a usable number when read state became the reader's to change: while
 * the inbox marked itself read on open, this was zero every time anybody could have
 * looked at it.
 */
export function unreadCount(notifications: Notification[] | undefined) {
  return (notifications ?? []).filter((row) => !row.readAt).length;
}

/**
 * What the row says happened, in the second person.
 *
 * One place, because the wording is the only thing distinguishing three follow states
 * that are otherwise the same row — and `follow_request` versus `follow_approved` is
 * exactly the pair that reads backwards if it is written twice.
 *
 * A recommendation says which kind of thing it is — "recommended a movie", "recommended
 * a season" — because the title on the next line is often "Season 2", and the kind is
 * what makes that sentence mean anything before the show's name is read.
 */
export function verbFor(kind: NotificationKind, mediaKind?: Notification['mediaKind']): string {
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
    case 'recommendation':
      if (mediaKind === 'season') return 'recommended a season';
      if (mediaKind === 'movie') return 'recommended a movie';
      return 'recommended something';
    case 'invite_activated':
      return 'joined bingd. from your invite';
    /**
     * No emoji here, on purpose. The row draws one; a screen reader would say "party
     * popper" in the middle of the only sentence that tells a new reader who brought
     * them, and the celebration is the part that survives being dropped.
     */
    case 'invite_welcome':
      return 'invited you';
    /**
     * Second person, and no actor. Every other verb completes a sentence that began
     * with somebody's name; this one is the whole sentence, which is why the row
     * that draws it must not expect a face.
     */
    case 'award_earned':
      return 'You earned a new Award';
  }
}

/**
 * Whether this row should offer Follow back.
 *
 * Only on `follow`, and only where the reader does not already have an edge going the
 * other way. Not on `follow_request`: that row has Approve and Decline, and a third
 * control that quietly starts a relationship in the opposite direction beside them is
 * one mis-tap from a follow nobody meant. Not on `follow_approved` either — that row
 * exists because the reader followed *them*, so there is nothing to follow back.
 */
export function canFollowBack(
  row: Notification,
  outgoing: 'approved' | 'pending' | null | undefined,
): boolean {
  return (
    (row.kind === 'follow' || row.kind === 'invite_welcome') &&
    Boolean(row.actorId) &&
    !outgoing
  );
}

/**
 * Marks the whole inbox read.
 *
 * All at once, from one control the reader presses. There is no per-row marking and no
 * mark-on-open: the first would be six taps to clear six rows, and the second is what
 * this replaced — it made `read_at` a column whose value nobody could ever observe as
 * anything but "read".
 */
export function useMarkNotificationsRead(viewerId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('mark_notifications_read');
      if (error) throw error;
    },
    // `onSettled` rather than `onSuccess`: a mark-read that commits and loses its reply
    // leaves the badge showing a count the server no longer agrees with, and the reader
    // has no control that would ask again (`lib/write-outcome.ts`). A refusal this app
    // raises on purpose is the one case with nothing to refetch.
    onSettled: (_data, error) => {
      if (!mustReconcile(classifyWrite(error as { code?: string } | null))) return;
      return queryClient.invalidateQueries({ queryKey: ['notifications', viewerId] });
    },
  });
}
