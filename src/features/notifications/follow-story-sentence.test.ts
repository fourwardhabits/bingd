import { sentenceFor, spokenSentence, type Notification, type NotificationKind } from './use-notifications';

/**
 * A follow story's notifications (Workstream C, founder 2026-11-19).
 *
 * The story has no title, so the generic sentence would say "reacted to your activity".
 * The founder's copy names what it was: "your follow activity". `subjectActivityType` is
 * only the recipient's own activity's type, so the sentence can never call somebody else's
 * story "yours".
 */
const row = (over: Partial<Notification> & { kind: NotificationKind }): Notification => ({
  id: 'n1',
  createdAt: '2026-11-19T00:00:00Z',
  readAt: null,
  actorId: 'actor-1',
  actorUsername: 'suraj',
  actorName: 'Suraj',
  actorAvatarUri: null,
  mediaItemId: null,
  mediaTitle: null,
  mediaKind: null,
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
  subjectActivityType: 'follow_added',
  commentIsReply: false,
  commentIsFollowUp: false,
  cluster: null,
  opensOn: null,
  availableOn: null,
  seasonNumber: null,
  ...over,
});

describe('a follow story notification', () => {
  it('says "your follow activity" for a reaction and a comment', () => {
    expect(spokenSentence(sentenceFor(row({ kind: 'reaction' }), null))).toBe(
      'reacted to your follow activity',
    );
    expect(spokenSentence(sentenceFor(row({ kind: 'comment' }), null))).toBe(
      'commented on your follow activity',
    );
  });

  it('keeps a reply about the reader’s comment', () => {
    expect(
      spokenSentence(sentenceFor(row({ kind: 'comment', commentIsReply: true }), null)),
    ).toBe('replied to your comment');
  });

  it('leaves a mention as it always was', () => {
    expect(spokenSentence(sentenceFor(row({ kind: 'mention' }), null))).toBe(
      'mentioned you in a comment',
    );
  });

  it('changes nothing for any other activity', () => {
    expect(
      spokenSentence(sentenceFor(row({ kind: 'reaction', subjectActivityType: null }), null)),
    ).toBe('reacted to your activity');
    expect(
      spokenSentence(
        sentenceFor(
          row({ kind: 'comment', subjectActivityType: 'title_ranked', mediaTitle: 'Dune' }),
          'Dune',
        ),
      ),
    ).toBe('commented on your Dune watch');
  });
});
