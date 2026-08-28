import { hrefForPush, PUSH_FALLBACK_HREF, ROUTED_KINDS } from './routing';

/**
 * Where a tapped push lands.
 *
 * Separated from `routing.test.ts` because the input is different in kind: an inbox row
 * is a fresh read the server produced seconds ago, and a push payload is four fields
 * composed when the notification was *written*, delivered by two operating systems and a
 * third-party service, and possibly tapped days later.
 *
 * So the assertions here are about the two things that distinguishes: **the payload is
 * untrusted**, and **there is no "stay where you are"** — a tap arriving from the
 * notification centre has nowhere to stay, so every chain has to end at a real screen.
 */

const payload = (over: Record<string, unknown> = {}) => ({
  notificationId: 'n1',
  kind: 'follow',
  actorUsername: 'suraj',
  mediaItemId: 'media-1',
  ...over,
});

describe('a live payload', () => {
  it('opens the actor for the three follow kinds and the two invite kinds', () => {
    for (const kind of [
      'follow',
      'follow_request',
      'follow_approved',
      'invite_activated',
      'invite_welcome',
    ]) {
      expect(hrefForPush(payload({ kind }))).toBe('/u/suraj');
    }
  });

  it('opens the title for the kinds that are about one', () => {
    for (const kind of ['comment', 'reaction', 'watch_tag', 'recommendation']) {
      expect(hrefForPush(payload({ kind }))).toBe('/title/media-1');
    }
  });

  /**
   * The same order the inbox uses: the point of a recommendation is the thing to watch,
   * and the person is the context for it.
   */
  it('prefers the title over the recommender, and falls back to them', () => {
    expect(hrefForPush(payload({ kind: 'recommendation' }))).toBe('/title/media-1');
    expect(hrefForPush(payload({ kind: 'recommendation', mediaItemId: null }))).toBe(
      '/u/suraj',
    );
  });

  /**
   * The founder's requirement for 20260827000600, at the lock screen: tapping "Suraj
   * ranked The Martian from your recommendation" opens Suraj's exact ranking post.
   * Without the event — a payload composed before the database migration, or an event
   * since deleted and nulled at claim time — it degrades exactly as a comment does:
   * the title, then the inbox.
   */
  it('opens the exact ranking post for a fulfilled recommendation', () => {
    expect(
      hrefForPush(payload({ kind: 'recommendation_ranked', feedEventId: 'event-1' })),
    ).toBe('/activity/event-1');
    expect(hrefForPush(payload({ kind: 'recommendation_ranked' }))).toBe('/title/media-1');
    expect(hrefForPush(payload({ kind: 'recommendation_ranked', mediaItemId: null }))).toBe(
      PUSH_FALLBACK_HREF,
    );
  });

  it('opens the Awards sheet for an award', () => {
    expect(hrefForPush(payload({ kind: 'award_earned' }))).toEqual({
      pathname: '/profile',
      params: { awards: '1' },
    });
  });
});

describe('a payload whose subject is gone', () => {
  /**
   * Staler than an inbox row by construction — the payload was composed when the
   * notification was written. Every kind has to resolve, and the inbox is the last link:
   * it holds this row, read fresh, with its own explanation for what happened to it.
   */
  it('lands on the inbox rather than nowhere, for every kind', () => {
    for (const kind of ROUTED_KINDS) {
      const href = hrefForPush(payload({ kind, actorUsername: null, mediaItemId: null }));
      // The two actorless kinds route to the reader's *own* profile — Awards behind a
      // parameter, goals plain — so neither has a subject to have gone missing and
      // neither falls back to the inbox. Everything else does.
      const ownProfile = kind === 'award_earned' || kind === 'goal_completed';
      const landed = ownProfile ? typeof href === 'object' : href === PUSH_FALLBACK_HREF;
      expect(landed).toBe(true);
    }
  });
});

describe('a payload this build has never seen', () => {
  /**
   * This runs on a cold start from a tap, which is the launch with the least recovery
   * available to it. A payload composed by a newer build, a truncated one, or a hostile
   * one all have to end somewhere real rather than throwing on the way to the first
   * frame.
   */
  it.each([
    ['nothing at all', null],
    ['an empty object', {}],
    ['a kind from a later build', { kind: 'someone_you_follow_ranked_something' }],
    ['a kind that is not a string', { kind: 42 }],
    [
      'a username that is not a string',
      { kind: 'follow', actorUsername: { toString: (): string => 'x' } },
    ],
    ['an empty username', { kind: 'follow', actorUsername: '' }],
    ['a media id that is not a string', { kind: 'comment', mediaItemId: ['media-1'] }],
  ])('resolves %s to the inbox', (_name, value) => {
    expect(() => hrefForPush(value as Record<string, unknown>)).not.toThrow();
    expect(hrefForPush(value as Record<string, unknown>)).toBe(PUSH_FALLBACK_HREF);
  });

  /**
   * A username is interpolated into a path. Asserting it is *not* routed is the point:
   * the resolver takes the value as a string or not at all, and the router owns the
   * escaping — but a payload arriving from outside should not be the first place anybody
   * discovers which of those is true.
   */
  it('does not route a username-shaped object', () => {
    expect(hrefForPush({ kind: 'follow', actorUsername: { username: 'suraj' } })).toBe(
      PUSH_FALLBACK_HREF,
    );
  });
});
