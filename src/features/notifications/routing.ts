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
  | { kind: 'awards' }
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
    case 'follow_request':
    case 'follow':
    case 'follow_approved':
      return [...profile, unavailable('This account is no longer available.')];

    /**
     * The exact title the activity was about.
     *
     * **Not the feed event, and deliberately.** The brief asks for the event and for
     * the comment to be focused within it, and the architecture does not support
     * either: there is no per-event route, and the feed tab is a paginated list of
     * the people this reader *follows* — a notification is about the reader's own
     * activity, which does not appear there at all. Routing to a screen that cannot
     * contain the subject is worse than routing to its parent.
     *
     * So the title is the nearest surviving parent, and it is a real one: it is
     * where this reader's own ranking, note and companions for that title live.
     * `.agent-workflow/continuation.md` carries the deferral.
     */
    case 'comment':
    case 'reaction':
      return [
        ...title,
        unavailable('That activity is no longer available.'),
      ];

    /** The exact Movie or Season the tag was on, never the parent series. */
    case 'watch_tag':
      return [...title, unavailable('That title is no longer available.')];

    /**
     * The title first, the recommender second. Both are useful and they are useful
     * in that order — the point of the notification is the thing to watch, and the
     * person is the context for it.
     */
    case 'recommendation':
      return [
        ...title,
        ...profile,
        unavailable('That recommendation is no longer available.'),
      ];

    /** The person who joined, filed by `_maybe_activate_invite` at their tenth ranking. */
    case 'invite_activated':
      return [...profile, unavailable('That account is no longer available.')];

    /** Nothing writes this one yet, and the sheet is real regardless. */
    case 'award_earned':
      return [{ kind: 'awards' }];
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
    /**
     * The Awards sheet is a component on the profile tab rather than a route, so it
     * is opened by a parameter the tab reads once. The object form rather than a
     * query string because typed routes check it.
     */
    case 'awards':
      return { pathname: '/profile', params: { awards: '1' } };
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
    case 'awards':
      return 'Opens your awards';
    case 'unavailable':
      return 'No longer available';
  }
}

/** Every kind, for the tests and for anything that needs to enumerate the matrix. */
export const ROUTED_KINDS: readonly NotificationKind[] = [
  'follow_request',
  'follow',
  'follow_approved',
  'comment',
  'reaction',
  'watch_tag',
  'recommendation',
  'invite_activated',
  'award_earned',
];
