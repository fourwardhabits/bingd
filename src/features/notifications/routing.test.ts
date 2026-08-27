import {
  hintFor,
  hrefFor,
  ROUTED_KINDS,
  targetChainFor,
  targetFor,
  type NotificationTarget,
} from './routing';
import type { Notification, NotificationKind } from './use-notifications';

/**
 * Where a notification leads, and where it leads once the thing it pointed at is gone.
 *
 * The second half is the point. A notification is a record of something that already
 * happened, so by the time anybody taps it the comment may be deleted, the account
 * blocked, the ranking unlogged, the title gone from the catalogue. Every kind is
 * asserted twice — once whole, once with its subject removed — because a routing table
 * that is only tested against live data is tested against the case that never breaks.
 */

/**
 * A complete row, which every test then takes something away from.
 *
 * Built whole rather than per test so that a "gone" case differs from the live one in
 * exactly one field, and the difference is visible in the test that makes it.
 */
const row = (over: Partial<Notification> & { kind: NotificationKind }): Notification => ({
  id: 'n1',
  createdAt: '2026-08-19T00:00:00Z',
  readAt: null,
  actorId: 'actor-1',
  actorUsername: 'suraj',
  actorName: 'Suraj',
  actorAvatarUri: null,
  mediaItemId: 'media-1',
  mediaTitle: 'Inception',
  mediaKind: 'movie',
  seriesTitle: null,
  subjectType: 'feed_event',
  subjectId: 'event-1',
  ...over,
});

describe('the routing matrix', () => {
  /**
   * The founder's table, asserted as a table.
   *
   * A `switch` returning the wrong branch for one kind is invisible in a test that
   * checks three of them, and this list is the artefact a reviewer reads.
   */
  const expected: Record<NotificationKind, NotificationTarget> = {
    follow_request: { kind: 'profile', username: 'suraj' },
    follow: { kind: 'profile', username: 'suraj' },
    follow_approved: { kind: 'profile', username: 'suraj' },
    /**
     * **Changed 2026-08-26, and it is the founder's correction rather than a drift.**
     *
     * Both used to be `{ kind: 'title' }`, and this file argued for it: the title is
     * the nearest surviving parent of an activity. What that reasoning missed is that
     * the title page renders no comments, so a reader told "Ada commented on your
     * activity" arrived where the remark is invisible — reported by a friend as the app
     * freezing, which is what a screen that cannot contain what you came for looks like.
     *
     * The title is still the *second* link (asserted below), because the two ways this
     * goes stale are different: a deleted event leaves the title, and a title that left
     * the catalogue leaves the event.
     */
    comment: { kind: 'activity', eventId: 'event-1' },
    reaction: { kind: 'activity', eventId: 'event-1' },
    watch_tag: { kind: 'title', mediaItemId: 'media-1' },
    recommendation: { kind: 'title', mediaItemId: 'media-1' },
    invite_activated: { kind: 'profile', username: 'suraj' },
    invite_welcome: { kind: 'profile', username: 'suraj' },
    award_earned: { kind: 'awards' },
  };

  for (const kind of ROUTED_KINDS) {
    it(`routes ${kind} to its exact destination`, () => {
      expect(targetFor(row({ kind }))).toEqual(expected[kind]);
    });
  }

  it('covers every kind in the union, so a new one cannot be added unrouted', () => {
    expect(ROUTED_KINDS).toHaveLength(Object.keys(expected).length);
    expect([...ROUTED_KINDS].sort()).toEqual(Object.keys(expected).sort());
  });

  it('never returns an empty chain, whatever the row is missing', () => {
    for (const kind of ROUTED_KINDS) {
      const stripped = row({
        kind,
        actorUsername: null,
        actorId: null,
        mediaItemId: null,
        mediaTitle: null,
        mediaKind: null,
      });
      expect(targetChainFor(stripped).length).toBeGreaterThan(0);
      expect(targetFor(stripped)).toBeDefined();
    }
  });
});

describe('a target that is gone', () => {
  /**
   * `my_notifications` drops a row whose actor is suspended or deleted outright, so a
   * null username reaching the client is the unusual case rather than the ordinary
   * one. It is still routed rather than crashed on — the resolver's contract is that
   * the last link always survives, and a contract with an exception is not one.
   */
  it.each(['follow', 'follow_request', 'follow_approved', 'invite_activated'] as const)(
    'sends %s to a safe stop when the account is no longer there',
    (kind) => {
      const target = targetFor(row({ kind, actorUsername: null, actorId: null }));
      expect(target.kind).toBe('unavailable');
      expect(hrefFor(target)).toBeNull();
    },
  );

  /**
   * A deleted comment, an unlogged ranking, a removed feed event. All three arrive the
   * same way: `my_notifications` resolves the title through a join that requires the
   * event to still exist *and* still belong to this reader, so `mediaItemId` is the
   * field that goes null.
   *
   * **The subject has to go with it**, and that is the part worth stating. Since the
   * chain leads with the activity, a row whose title is gone but whose `subject_id` is
   * still set resolves to the conversation — correctly, and asserted below. This case is
   * the one where the notification points at nothing at all.
   */
  it.each(['comment', 'reaction'] as const)(
    'sends %s to a safe stop when the activity is gone',
    (kind) => {
      const target = targetFor(
        row({ kind, mediaItemId: null, subjectType: null, subjectId: null }),
      );
      expect(target.kind).toBe('unavailable');
    },
  );

  /**
   * The chain doing its job, in the case it was extended for.
   *
   * A title can leave the catalogue while the activity is still there, and the
   * conversation on it is still readable — so this must not degrade to "unavailable"
   * merely because the *other* link is gone.
   */
  it.each(['comment', 'reaction'] as const)(
    'still opens the conversation for %s when only the title has gone',
    (kind) => {
      expect(targetFor(row({ kind, mediaItemId: null }))).toEqual({
        kind: 'activity',
        eventId: 'event-1',
      });
    },
  );

  /**
   * And the other way round: the event deleted, the title still in the catalogue.
   *
   * This is the case the title link was originally the whole answer to, and keeping it
   * as the second link is what stops the new destination being a regression for it.
   */
  it.each(['comment', 'reaction'] as const)(
    'falls %s back to the title when the activity itself is gone',
    (kind) => {
      expect(targetFor(row({ kind, subjectType: null, subjectId: null }))).toEqual({
        kind: 'title',
        mediaItemId: 'media-1',
      });
    },
  );

  it('routes a reply whose recipient is not the activity owner', () => {
    /**
     * The case that would have been silently broken by resolving the conversation from
     * `mediaItemId` instead of from `subject_id`.
     *
     * `my_notifications` resolves the title through `fe.actor_id = auth.uid()` — the
     * reader's *own* activity. A reply notification's recipient is another commenter, so
     * that join yields null for them and the title link is empty. `subject_id` has no
     * such restriction, which is why the chain reads it.
     */
    expect(targetFor(row({ kind: 'comment', mediaItemId: null, mediaTitle: null }))).toEqual({
      kind: 'activity',
      eventId: 'event-1',
    });
  });

  it('does not fall back to the actor for a comment, which would leak nothing but help nobody', () => {
    // The parent of a comment is the activity, not the person who wrote it. Sending a
    // reader to a stranger's profile because their comment was deleted is a non
    // sequitur, and the founder's fallback order says activity, then title, then here.
    const target = targetFor(row({ kind: 'comment', mediaItemId: null }));
    expect(target.kind).not.toBe('profile');
  });

  it('falls a recommendation back to whoever sent it', () => {
    // Unlike a comment, the person *is* a useful parent here: the notification's whole
    // content is "this person thinks you should watch this".
    const target = targetFor(row({ kind: 'recommendation', mediaItemId: null }));
    expect(target).toEqual({ kind: 'profile', username: 'suraj' });
  });

  it('stops a recommendation safely when both the title and the sender are gone', () => {
    const target = targetFor(
      row({ kind: 'recommendation', mediaItemId: null, actorUsername: null }),
    );
    expect(target.kind).toBe('unavailable');
  });

  it('sends a watch tag to a safe stop when the title is gone', () => {
    expect(targetFor(row({ kind: 'watch_tag', mediaItemId: null })).kind).toBe('unavailable');
  });

  /**
   * The Awards sheet is computed from the reader's own collection and cannot 404, so
   * an award notification has no stale case to fall back from — including a stale one
   * for a tier that has since been recomputed away.
   */
  it('keeps an award pointing at the sheet even with everything else stripped', () => {
    const target = targetFor(
      row({ kind: 'award_earned', actorUsername: null, actorId: null, mediaItemId: null }),
    );
    expect(target).toEqual({ kind: 'awards' });
  });

  /**
   * Independent review 23's Major, pinned as the deliberate behaviour it is.
   *
   * The resolver does not consult `can_view_profile`, so an actor who went private
   * after the notification was written is still routed to. `20260819000100` built the
   * destination for exactly that: an identity-only profile with a Follow control.
   *
   * Gating this on viewability would make a private account's follow request
   * unreachable — the one thing this inbox may not do, and the reason
   * `my_notifications` is definer in the first place.
   */
  it('still routes to an actor who is no longer viewable, which is the private case working', () => {
    // Nothing in the row changes when an account goes private: the username is still
    // there, because `my_notifications` drops only suspended and deleted actors.
    for (const kind of ['follow_request', 'follow', 'follow_approved'] as const) {
      expect(targetFor(row({ kind }))).toEqual({ kind: 'profile', username: 'suraj' });
    }
  });

  it('says why, so the screen can tell the reader rather than absorbing the tap', () => {
    const target = targetFor(
      row({ kind: 'comment', mediaItemId: null, subjectType: null, subjectId: null }),
    );
    expect(target.kind === 'unavailable' && target.reason.length).toBeGreaterThan(0);
  });
});

describe('the href', () => {
  it('addresses a profile by handle and a title by id', () => {
    expect(hrefFor({ kind: 'profile', username: 'suraj' })).toBe('/u/suraj');
    expect(hrefFor({ kind: 'title', mediaItemId: 'abc' })).toBe('/title/abc');
    expect(hrefFor({ kind: 'activity', eventId: 'e1' })).toBe('/activity/e1');
  });

  it('opens the awards sheet by parameter, because it is not a route', () => {
    expect(hrefFor({ kind: 'awards' })).toEqual({
      pathname: '/profile',
      params: { awards: '1' },
    });
  });

  it('is null exactly when the target is unavailable', () => {
    expect(hrefFor({ kind: 'unavailable', reason: 'gone' })).toBeNull();
  });
});

describe('what the row promises before it is tapped', () => {
  /**
   * The hint is derived from the same chain the tap uses. What it replaced was a
   * ternary on `kind === 'recommendation'`, which announced "opens their profile" over
   * a comment row that opens a title, and announced it over a dead row too.
   */
  it('matches where the tap will actually go', () => {
    expect(hintFor(row({ kind: 'comment' }))).toBe('Opens the conversation');
    expect(hintFor(row({ kind: 'follow' }))).toBe('Opens their profile');
    expect(hintFor(row({ kind: 'award_earned' }))).toBe('Opens your awards');
  });

  it('does not promise a destination that is gone', () => {
    expect(
      hintFor(row({ kind: 'comment', mediaItemId: null, subjectType: null, subjectId: null })),
    ).toBe('No longer available');
    expect(hintFor(row({ kind: 'follow', actorUsername: null }))).toBe('No longer available');
  });
});
