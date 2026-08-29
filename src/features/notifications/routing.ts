import type { Href } from 'expo-router';

import type { Notification, NotificationKind } from './use-notifications';

/**
 * Where a notification leads, as data rather than as a `router.push` in a handler.
 *
 * One resolver, because before this there was one rule — a recommendation opened the
 * title, everything else opened the actor — and it was written inline in the inbox's
 * `onPress`. That shape has no room for the thing this file exists to get right: a
 * notification is a record of something that happened, and by the time somebody taps
 * it the thing it points at may be gone. A comment is deleted, an account is blocked,
 * a feed event is removed when its ranking is, a title leaves the catalogue.
 *
 * **Every kind therefore resolves to an ordered chain, not a destination.** The first
 * surviving link wins, and the last link always resolves — so a tap can end at a
 * useful parent, but it can never end at a crash, a blank screen, or a screen the
 * reader is not allowed to see.
 *
 * ---
 *
 * WHAT "RESOLVES" MEANS, PRECISELY
 *
 * It means the destination renders a **defined, authorised state**. It does not mean
 * the reader can read everything there, and the difference is the whole design of the
 * profile link. Independent review 23 raised it: this resolver does not consult
 * `can_view_profile`, so an actor who has gone private since the notification was
 * written is still routed to.
 *
 * That is correct, and the alternative is a regression. `20260819000100` separated
 * being *findable* from being *readable* precisely for this case, and
 * `app/u/[username].tsx` has a built-for-purpose surface at the end of it: avatar,
 * name, handle, "This account is private", and a Follow control. Sending a reader
 * there is the point.
 *
 * Refusing to route a non-viewable actor would break the one thing this inbox may not
 * break. A private account requesting to follow another private account fails
 * `can_view_profile` — which is why `my_notifications` is definer at all — so a
 * viewability gate would make exactly the follow requests that most need answering
 * unreachable, and the request would sit pending for ever with both parties waiting.
 *
 * The cases that would genuinely lead nowhere never arrive: a block deletes the
 * notifications in both directions, a suspended actor is dropped by
 * `my_notifications`' own `where`, and a deleted account takes its rows with it by
 * cascade. `can_discover_profile` is false only for those, so any actor still carrying
 * a username here is one this reader may at least be shown the identity of.
 */
export type NotificationTarget =
  | { kind: 'profile'; username: string }
  | { kind: 'title'; mediaItemId: string }
  /**
   * One feed event, and the conversation on it.
   *
   * The destination this file previously said the architecture could not support: "there
   * is no per-event route, and the feed tab is a paginated list of the people this reader
   * *follows* — a notification is about the reader's own activity, which does not appear
   * there at all."
   *
   * Both halves of that were true and only the second was permanent. There is a route
   * now (`app/activity/[id].tsx`) and it reads one event by id through
   * `feed_events_read`, so it does not care whose feed the row would have appeared in.
   * The deferral in `.agent-workflow/continuation.md` is closed.
   */
  | { kind: 'activity'; eventId: string }
  | { kind: 'awards' }
  /** The reader's own profile, where their annual goals live (20260829000200). */
  | { kind: 'goals' }
  /**
   * Stay on the inbox and say why. Reached when every better link is gone.
   *
   * Not silence: a tap that does nothing is indistinguishable from a tap the app
   * missed, and the reader retries it. `reason` is what the screen says out loud.
   */
  | { kind: 'unavailable'; reason: string };

/**
 * Staleness, as this app can actually observe it.
 *
 * `my_notifications` (20260817001300) does the work already, and the resolver reads
 * the holes it leaves rather than asking its own questions:
 *
 *   - a row whose actor is suspended or deleted never arrives — the RPC's own
 *     `where` drops it, so `actorUsername` is null only for an actorless system
 *     notice;
 *   - `mediaItemId` comes through a join on `fe.actor_id = auth.uid()`, so a feed
 *     event that was deleted, or that never belonged to this reader, yields null;
 *   - a title removed from the catalogue yields null the same way.
 *
 * That is the whole point of resolving from the RPC's own output. An independent
 * "does this still exist?" query would be a second authorisation surface, and it
 * would be the one that got it wrong.
 */
export function targetChainFor(row: Notification): NotificationTarget[] {
  const profile: NotificationTarget[] = row.actorUsername
    ? [{ kind: 'profile', username: row.actorUsername }]
    : [];
  const title: NotificationTarget[] = row.mediaItemId
    ? [{ kind: 'title', mediaItemId: row.mediaItemId }]
    : [];
  /**
   * The conversation, when the row points at one.
   *
   * Read from `subject_type`/`subject_id`, which `my_notifications` returns unchanged
   * from the `notifications` row — **not** from `mediaItemId`. That distinction is the
   * whole reason a reply notification works: `mediaItemId` arrives through a join on
   * `fe.actor_id = auth.uid()`, so it is null for a recipient who is another commenter
   * rather than the activity's owner, and a chain that started from it would send
   * exactly the people being replied to nowhere.
   *
   * No id is invented from display state, and none needs to be: `subject_id` **is** the
   * feed event id, recorded by `add_comment` when the notification was written.
   */
  const activity: NotificationTarget[] =
    row.subjectType === 'feed_event' && row.subjectId
      ? [{ kind: 'activity', eventId: row.subjectId }]
      : [];

  switch (row.kind) {
    /**
     * The requester, because the request is answered *here* — the inbox row carries
     * Approve and Decline, and their profile is the thing somebody wants to look at
     * before pressing either.
     *
     * Routed whether or not the requester is viewable. A private account asking to
     * follow a private account is the ordinary case, not the edge one, and the
     * identity-only profile is exactly what lets the reader decide.
     */
    /**
     * `friendship` (20260827000200) rides with the follow family: it is the accepter's
     * record of a person, and the person is where a tap on it should land.
     */
    case 'follow_request':
    case 'follow':
    case 'follow_approved':
    case 'friendship':
      return [...profile, unavailable('This account is no longer available.')];

    /**
     * The conversation, and then the title.
     *
     * **This is the change the founder asked for, and the reason is what a comment
     * notification is *about*.** It used to resolve to the title page, which this file
     * argued for at length as "the nearest surviving parent". That argument was sound
     * about the parent and wrong about the subject: the title page does not render
     * comments at all, so somebody tapping "Ada commented on your activity" arrived
     * somewhere the remark they were told about is *invisible*. A friend reported it as
     * the app freezing, which is what a screen that cannot contain what you came for
     * looks like from the outside.
     *
     * So the activity comes first. It is a real screen with the post at the top and the
     * conversation under it, and the comment that caused the notification is in it.
     *
     * **The title stays as the second link** rather than being replaced, because the two
     * ways a comment notification goes stale are different. If the event was deleted —
     * its ranking removed — `subject_id` still points at a row that is gone, the page
     * finds nothing, and the reader gets a clean unavailable state. If the *title* left
     * the catalogue, `mediaItemId` is the null one and the event is still there. Keeping
     * both means a chain rather than a single point of failure, which is what this file
     * exists to guarantee.
     *
     * `reaction` follows it for the same reason — a reaction is on the activity, and the
     * activity page shows the activity — and because two kinds that mean "somebody
     * responded to what you posted" arriving at two different screens is the
     * inconsistency the founder named.
     */
    /**
     * `recommendation_ranked` (20260827000600) rides the same chain, and for the same
     * reason the founder gave for comments: the notification is *about* one post —
     * "Suraj ranked The Martian from your recommendation" — and `subject_id` **is**
     * that post, recorded by `_rank_finalize` in the ranking's own transaction. The
     * title page is the surviving parent when the event is gone (the ranking was
     * removed), and the unavailable state is what remains when the title left too.
     */
    /**
     * `mention` (20260830000100) rides the comment chain exactly, and the reason it is
     * not a special case is worth stating: the notification is about one remark in one
     * conversation, `subject_id` **is** that conversation, and the activity page renders
     * it. The one thing it does not do is scroll to the comment — that is a real
     * improvement and it is deliberately not built here, because the founder's minimum
     * was "open the correct thread" and the alternative is anchor plumbing through two
     * surfaces for a thread that is usually a screenful.
     *
     * The stale cases are the comment chain's, and both already degrade: a deleted
     * comment leaves the thread standing (`delete_comment` sweeps the mention row too,
     * so in practice the row is gone), a deleted *event* falls through to the title, and
     * a title out of the catalogue falls through to the unavailable state.
     */
    case 'comment':
    case 'mention':
    case 'reaction':
    case 'recommendation_ranked':
      return [...activity, ...title, unavailable('That activity is no longer available.')];

    /** The exact Movie or Season the tag was on, never the parent series. */
    case 'watch_tag':
      return [...title, unavailable('That title is no longer available.')];

    /**
     * The title first, the recommender second. Both are useful and they are useful
     * in that order — the point of the notification is the thing to watch, and the
     * person is the context for it.
     */
    case 'recommendation':
      return [...title, ...profile, unavailable('That recommendation is no longer available.')];

    /** The person who joined, filed by `_maybe_activate_invite` at their tenth ranking. */
    case 'invite_activated':
      return [...profile, unavailable('That account is no longer available.')];

    /**
     * The same person, at the earlier of the two moments: `redeem_invite` files this
     * the instant the invitation is accepted (`20260831000100`), where
     * `invite_activated` waits for their tenth ranking.
     *
     * Same destination, and that is not an oversight — both rows are about the account
     * that joined, and the useful thing to do with either is look at them. The row's
     * own Follow back is beside the tap, not instead of it.
     */
    case 'invite_joined':
      return [...profile, unavailable('That account is no longer available.')];

    /**
     * The inviter, which is the whole point of the row.
     *
     * A new reader's inbox holds this and nothing else, and the one useful thing to do
     * with it is look at the person who brought them. The identity-only profile at the
     * end of the chain is a real destination even when the inviter is private — see the
     * note at the top of this file — which matters here more than anywhere, because a
     * private inviter is precisely the case where the invitee's follow is still pending
     * and they may want to see who they are waiting on.
     */
    case 'invite_welcome':
      return [...profile, unavailable('That account is no longer available.')];

    /** The earner's own Awards — written by the unlock ledger since 20260828000100. */
    case 'award_earned':
      return [{ kind: 'awards' }];

    /**
     * The earner's own annual goals (20260829000200).
     *
     * Their **profile**, not the feed post the same crossing produced. The founder was
     * explicit: a congratulation is about the reader, and sending them to a social post
     * about themselves is the wrong half of the event. `GoalsSection` sits directly under
     * the identity block, so the profile is the goals within one scroll — which is the
     * practical reading of "the annual goals section where practical".
     *
     * A distinct target rather than reusing `awards`: that one opens the Awards *sheet*,
     * which is a different thing entirely and would leave the reader closing a modal to
     * find what they were congratulated for.
     */
    case 'goal_completed':
      return [{ kind: 'goals' }];
  }
}

/** The first surviving link. Total: the chain's last entry always survives. */
export function targetFor(row: Notification): NotificationTarget {
  const chain = targetChainFor(row);
  return chain[0] ?? unavailable('This is no longer available.');
}

function unavailable(reason: string): NotificationTarget {
  return { kind: 'unavailable', reason };
}

/**
 * The target as a route.
 *
 * Separate from the resolver so the matrix above can be tested without a router,
 * which is what lets every kind and every stale case be asserted as data.
 */
export function hrefFor(target: NotificationTarget): Href | null {
  switch (target.kind) {
    case 'profile':
      return `/u/${target.username}`;
    case 'title':
      return `/title/${target.mediaItemId}`;
    case 'activity':
      return `/activity/${target.eventId}`;
    /**
     * The Awards sheet is a component on the profile tab rather than a route, so it
     * is opened by a parameter the tab reads once. The object form rather than a
     * query string because typed routes check it.
     */
    case 'awards':
      return { pathname: '/profile', params: { awards: '1' } };
    // No parameter: the goals section is on the profile itself, a scroll under the
    // identity block, rather than behind a sheet the way Awards is.
    case 'goals':
      return { pathname: '/profile' };
    /** Null is "stay here"; the caller says why, from `target.reason`. */
    case 'unavailable':
      return null;
  }
}

/**
 * What the row's accessibility hint says the tap will do.
 *
 * Derived from the same chain the tap uses, so the hint cannot promise a title and
 * then open a profile — which is what a hardcoded `kind === 'recommendation'`
 * ternary did before this file existed.
 */
export function hintFor(row: Notification): string {
  const target = targetFor(row);
  switch (target.kind) {
    case 'profile':
      return 'Opens their profile';
    case 'title':
      return 'Opens the title';
    case 'activity':
      return 'Opens the conversation';
    case 'awards':
      return 'Opens your awards';
    case 'goals':
      return 'Opens your goals';
    case 'unavailable':
      return 'No longer available';
  }
}

/**
 * The same resolver, entered from a push payload instead of from an inbox row.
 *
 * `push-sender` sends four fields (`supabase/functions/push-sender/copy.ts`), and three
 * of them are here because those are precisely the three `targetChainFor` reads. That is
 * not a coincidence to be relied on quietly — it is the reason the payload has the shape
 * it has, and it is what makes a tap on a push land where a tap on the row would.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STALE CASE IS *MORE* LIKELY HERE, NOT LESS
 *
 * An inbox row is resolved from a fresh read: `my_notifications` ran seconds ago, so a
 * null media id means the server has just confirmed the subject is gone. A push payload
 * was composed when the notification was **written** and may be tapped days later, after
 * the title left the catalogue, the event was deleted, or the actor was blocked.
 *
 * So the chain matters more here, and the last link cannot be the inbox's "stay where you
 * are and say why" — a tap arriving from the notification centre has nowhere to stay.
 * This ends at the inbox itself, which is the one screen that is always right: it holds
 * the row this push was about, resolved fresh, with its own fallback behaviour and its own
 * explanation.
 */
export type PushTapPayload = {
  kind?: unknown;
  actorUsername?: unknown;
  mediaItemId?: unknown;
  /**
   * The conversation, added with the thread page (`20260826000600` §6).
   *
   * **A tapped push must land where a tapped inbox row lands**, and before this field
   * existed it could not: the payload carried the title and not the event, so a comment
   * push would have gone on opening the title page while the same notification in the
   * inbox opened the thread. Two destinations for one event is the inconsistency this
   * pass is closing, and it would have been the invisible half of it — the inbox is what
   * anybody testing looks at.
   *
   * Optional, because it arrives from outside the app: a notification composed by the
   * sender that shipped before this field is a payload without it, and that must resolve
   * to the title rather than to nothing.
   */
  feedEventId?: unknown;
};

/** The inbox. Reached when nothing better survived, and a real destination either way. */
export const PUSH_FALLBACK_HREF = '/settings/notifications' as Href;

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * Where a tapped push leads. Always somewhere.
 *
 * The payload is read defensively rather than trusted. It arrives from outside the app,
 * through two operating systems and a delivery service, and a notification composed by an
 * older build is a shape this one has never seen. An unrecognised kind resolves to the
 * inbox rather than throwing, because the path this runs on is a cold start from a tap —
 * the launch with the least recovery available to it.
 */
export function hrefForPush(payload: PushTapPayload | null | undefined): Href {
  if (!payload) return PUSH_FALLBACK_HREF;

  const kind = readString(payload.kind);
  if (!kind || !ROUTED_KINDS.includes(kind as NotificationKind)) return PUSH_FALLBACK_HREF;

  /**
   * The event id is reconstituted into the shape `targetChainFor` reads.
   *
   * `subjectType` is *derived* rather than sent, and that is deliberate: the sender has
   * one way of naming this — a `feed_event_id` key that is present or absent — and
   * transmitting a second field whose only legal value is `'feed_event'` would be a
   * field that can disagree with the first. The resolver's contract stays "subject_type
   * says what subject_id is"; this is where a push is translated into it.
   */
  const eventId = readString(payload.feedEventId);

  const target = targetFor({
    kind: kind as NotificationKind,
    actorUsername: readString(payload.actorUsername),
    mediaItemId: readString(payload.mediaItemId),
    subjectType: eventId ? 'feed_event' : null,
    subjectId: eventId,
  } as Notification);

  return hrefFor(target) ?? PUSH_FALLBACK_HREF;
}

/** Every kind, for the tests and for anything that needs to enumerate the matrix. */
export const ROUTED_KINDS: readonly NotificationKind[] = [
  'follow_request',
  'follow',
  'follow_approved',
  'friendship',
  'comment',
  'mention',
  'reaction',
  'watch_tag',
  'recommendation',
  'recommendation_ranked',
  'invite_activated',
  'invite_joined',
  'invite_welcome',
  'award_earned',
  'goal_completed',
];
