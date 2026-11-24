import { hrefFor, hrefForPush, pushDestination, targetFor } from './routing';
import {
  sentenceFor,
  spokenSentence,
  withCommentShape,
  type CommentShape,
  type Notification,
  type NotificationKind,
} from './use-notifications';

/**
 * Comment notifications: where each one lands, and what each one says (2026-11-22).
 *
 * Four things a comment notification can mean, and the reader must be able to tell them
 * apart: somebody **commented on your activity** (a top-level remark on your post),
 * somebody **replied to your comment**, somebody **mentioned you**, and the post's author
 * **also commented on their** post, in a conversation you are in. A top-level comment is
 * never called a reply.
 *
 * And where: every one of them opens the Comments page *at* its comment when it names one,
 * and opens the activity as before when it does not (an older row, an older push).
 */

const VIEWER = 'viewer-1';

const row = (over: Partial<Notification> & { kind: NotificationKind }): Notification => ({
  id: 'n1',
  createdAt: '2026-11-22T17:29:47Z',
  readAt: null,
  actorId: 'actor-1',
  actorUsername: 'ada',
  actorName: 'Ada',
  actorAvatarUri: null,
  mediaItemId: 'media-1',
  mediaTitle: 'Crazy Rich Asians',
  mediaKind: 'movie',
  seriesTitle: null,
  subjectType: 'feed_event',
  subjectId: 'event-1',
  mutual: null,
  award: null,
  goal: null,
  mentionInReply: false,
  preview: null,
  previewHidden: false,
  viewerRanked: false,
  subjectActivityType: 'title_ranked',
  commentIsReply: false,
  commentIsFollowUp: false,
  commentId: 'comment-9',
  cluster: null,
  opensOn: null,
  availableOn: null,
  seasonNumber: null,
  ...over,
});

const said = (r: Notification, subject: string | null = 'Crazy Rich Asians') =>
  spokenSentence(sentenceFor(r, subject));

describe('where a comment notification lands', () => {
  it('opens an inbox comment, reply or mention at its comment', () => {
    for (const kind of ['comment', 'mention'] as const) {
      expect(hrefFor(targetFor(row({ kind })))).toBe('/activity/event-1?comment=comment-9');
    }
    expect(hrefFor(targetFor(row({ kind: 'comment', commentIsReply: true })))).toBe(
      '/activity/event-1?comment=comment-9',
    );
  });

  it('opens an older row with no comment id at the activity, exactly as before', () => {
    expect(hrefFor(targetFor(row({ kind: 'comment', commentId: null })))).toBe(
      '/activity/event-1',
    );
    expect(hrefFor(targetFor(row({ kind: 'comment', commentId: undefined })))).toBe(
      '/activity/event-1',
    );
  });

  it('never targets a comment from a reaction, which is about the post', () => {
    expect(hrefFor(targetFor(row({ kind: 'reaction' })))).toBe('/activity/event-1');
  });

  it('falls back to the title, then to unavailable, when the activity is gone', () => {
    expect(hrefFor(targetFor(row({ kind: 'comment', subjectId: null })))).toBe(
      '/title/media-1',
    );
    expect(targetFor(row({ kind: 'comment', subjectId: null, mediaItemId: null })).kind).toBe(
      'unavailable',
    );
  });

  it('escapes the id, so a comment id cannot add a parameter to the route', () => {
    expect(hrefFor({ kind: 'activity', eventId: 'e1', commentId: 'a&b=c' })).toBe(
      '/activity/e1?comment=a%26b%3Dc',
    );
  });

  describe('from a push', () => {
    const push = (over: Record<string, unknown> = {}) => ({
      notificationId: '0b5c9a52-4f0e-4d5c-9c51-0a7e2a1f0001',
      kind: 'comment',
      actorUsername: 'ada',
      mediaItemId: 'media-1',
      feedEventId: 'event-1',
      ...over,
    });

    it('names the notification, so the page can find the comment', () => {
      expect(hrefForPush(push())).toBe(
        '/activity/event-1?notification=0b5c9a52-4f0e-4d5c-9c51-0a7e2a1f0001',
      );
      expect(hrefForPush(push({ kind: 'mention' }))).toBe(
        '/activity/event-1?notification=0b5c9a52-4f0e-4d5c-9c51-0a7e2a1f0001',
      );
      // Still the same destination kind for the open record — no id reaches it.
      expect(pushDestination(push()).destination).toBe('activity');
    });

    it('is the activity alone for a reaction, an older push, or an id that is not one', () => {
      expect(hrefForPush(push({ kind: 'reaction' }))).toBe('/activity/event-1');
      expect(hrefForPush(push({ notificationId: undefined }))).toBe('/activity/event-1');
      expect(hrefForPush(push({ notificationId: 'x?y=1' }))).toBe('/activity/event-1');
      expect(hrefForPush(push({ notificationId: 42 }))).toBe('/activity/event-1');
    });

    it('still degrades to the title, then the inbox, when the event is gone', () => {
      expect(hrefForPush(push({ feedEventId: null }))).toBe('/title/media-1');
      expect(hrefForPush(push({ feedEventId: null, mediaItemId: null }))).toBe(
        '/settings/notifications',
      );
    });
  });
});

describe('what a comment notification says', () => {
  it('a top-level comment on my post', () => {
    expect(said(row({ kind: 'comment' }))).toBe('commented on your Crazy Rich Asians watch');
  });

  it('a reply to my comment', () => {
    expect(said(row({ kind: 'comment', commentIsReply: true }))).toBe(
      'replied to your comment on Crazy Rich Asians',
    );
  });

  it('the post author following up in a conversation I am in, which is not a reply', () => {
    expect(said(row({ kind: 'comment', commentIsFollowUp: true }))).toBe(
      'also commented on their Crazy Rich Asians watch',
    );
  });

  it('a mention, in a comment or in a reply', () => {
    expect(said(row({ kind: 'mention' }))).toBe(
      'mentioned you in a comment on Crazy Rich Asians',
    );
    expect(said(row({ kind: 'mention', mentionInReply: true }))).toBe(
      'mentioned you in a reply on Crazy Rich Asians',
    );
  });

  /**
   * The reply and follow-up rows go to somebody who does not own the post, and
   * `my_notifications` resolves the title only for the owner — so these are the rows that
   * most often have no subject. They used to fall back to "commented on your activity",
   * which told the person who asked a question that the post's author had commented on the
   * asker's own activity.
   */
  it('keeps the four apart when the title cannot be resolved', () => {
    expect(said(row({ kind: 'comment' }), null)).toBe('commented on your activity');
    expect(said(row({ kind: 'comment', commentIsReply: true }), null)).toBe(
      'replied to your comment',
    );
    expect(said(row({ kind: 'comment', commentIsFollowUp: true }), null)).toBe(
      'also commented on their activity',
    );
    expect(said(row({ kind: 'mention', mentionInReply: true }), null)).toBe(
      'mentioned you in a reply',
    );
  });
});

/**
 * The owner of a post answered under their own comment gets the generic row, `{comment_id}`
 * — `add_comment` files `reply_to` only for a parent author who is not the owner. That is
 * the reported thread's last notification. The stored comment says what it was.
 */
describe('a generic row whose comment turns out to be a reply', () => {
  const shapes = (shape: CommentShape) => new Map([['comment-9', shape]]);

  // The stored parent is the thread's ROOT (`_add_comment` re-points every reply), so it
  // names whose thread this is, not which comment was answered. Neither sentence claims
  // "replied to your comment" for that reason (Codex review, PR #365).
  it('says it replied under my comment when the thread is mine', () => {
    const shaped = withCommentShape(
      row({ kind: 'comment' }),
      shapes({ isReply: true, rootAuthorId: VIEWER }),
      VIEWER,
    );
    expect(said(shaped)).toBe('replied under your comment on Crazy Rich Asians');
    expect(said(shaped, null)).toBe('replied under your comment');
    expect(said(shaped)).not.toMatch(/replied to your comment/);
  });

  it('says it replied to a comment on my post when the thread is somebody else’s', () => {
    const shaped = withCommentShape(
      row({ kind: 'comment' }),
      shapes({ isReply: true, rootAuthorId: 'someone-else' }),
      VIEWER,
    );
    expect(said(shaped)).toBe('replied to a comment on your Crazy Rich Asians watch');
    expect(said(shaped, null)).toBe('replied to a comment on your activity');
  });

  it('never calls a top-level comment a reply', () => {
    const shaped = withCommentShape(
      row({ kind: 'comment' }),
      shapes({ isReply: false, rootAuthorId: null }),
      VIEWER,
    );
    expect(said(shaped)).toBe('commented on your Crazy Rich Asians watch');
  });

  it('keeps the generic sentence when the comment is gone or not visible', () => {
    expect(said(withCommentShape(row({ kind: 'comment' }), new Map(), VIEWER))).toBe(
      'commented on your Crazy Rich Asians watch',
    );
    expect(said(withCommentShape(row({ kind: 'comment' }), undefined, VIEWER))).toBe(
      'commented on your Crazy Rich Asians watch',
    );
  });

  it('leaves a follow-up, a mention and a row the payload already describes alone', () => {
    const reply = shapes({ isReply: true, rootAuthorId: VIEWER });
    const followUp = row({ kind: 'comment', commentIsFollowUp: true });
    expect(withCommentShape(followUp, reply, VIEWER)).toBe(followUp);
    const mention = row({ kind: 'mention' });
    expect(withCommentShape(mention, reply, VIEWER)).toBe(mention);
  });
});
