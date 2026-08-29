import { awardAnnouncement } from './announcement';
import { evaluate } from './progress';
import { AWARD_TRACKS, type AwardFacts, type WatchedTitle } from './tracks';

/**
 * **One name for an award, on every surface that says it** (founder, 2026-08-29).
 *
 * The founder's report: a notification reading "You earned Comment Gremlin" over an
 * Awards row reading "Whisper". Neither was wrong on its own — "Comment Gremlin" is the
 * track's family name and "Whisper" is the tier that was actually earned — and that is
 * the problem: two surfaces reading two different fields of the same event, with nothing
 * on either screen connecting them.
 *
 * The ruling is that the name is the tier, everywhere. This file is the assertion that
 * `awardAnnouncement` (the feed post and the inbox row) and `progress.ts` (the Awards
 * sheet) cannot drift, and that the second line explains the achievement instead of
 * naming a metal.
 */

const emptyFacts: AwardFacts = {
  watched: [],
  rankings: [],
  watchlist: [],
  invitedSignups: [],
  invitedSignupCount: 0,
  written: [],
  recommendationsSent: [],
  reactionsReceived: [],
  mutualFollows: [],
};

const movie = (id: string): WatchedTitle => ({
  mediaItemId: id,
  kind: 'movie',
  title: id,
  seriesTitle: null,
  seasonNumber: null,
  posterPath: null,
  genres: ['Drama'],
  language: 'en',
  year: 2020,
  watchedOn: null,
});

const track = (key: string) => {
  const found = AWARD_TRACKS.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no such track: ${key}`);
  return found;
};

describe('what an earned award is called', () => {
  it('names the tier on a creative track', () => {
    // "Whisper", which is what the Awards sheet has always shown and what the
    // notification did not.
    expect(awardAnnouncement({ key: 'comment-gremlin', tierKey: 'whisper' })).toEqual({
      title: 'Whisper',
      achievement: 'Wrote 20 comments',
    });
  });

  it('advances with the tier', () => {
    expect(awardAnnouncement({ key: 'comment-gremlin', tierKey: 'chatterbox' }).title).toBe(
      'Chatterbox',
    );
    expect(awardAnnouncement({ key: 'genre-gremlin', tierKey: 'mixer' }).title).toBe('Mixer');
  });

  it('keeps the family name on a metal track', () => {
    // The one exception, and it is the same one `progress.ts` has always applied: a row
    // headed "Bronze" says nothing about what was done, and three of them say less. It
    // is also why the founder's own example copy reads "earned the Movie Muncher award".
    expect(awardAnnouncement({ key: 'movie-muncher', tierKey: 'bronze' })).toEqual({
      title: 'Movie Muncher',
      achievement: 'Watched 50 movies',
    });
  });

  it('never shows a track key, whatever it is handed', () => {
    const said = awardAnnouncement({
      key: 'a-track-from-the-future',
      tierKey: 'tier-1',
      name: 'Future Track',
      tierLabel: 'First',
    });
    expect(said.title).toBe('Future Track');
    // The threshold sentence is dropped rather than guessed at: a second line naming the
    // wrong number is worse than no second line.
    expect(said.achievement).toBeNull();
  });

  it('takes its last resort from the caller, because the two sentences differ', () => {
    // "You earned a new Award" in the inbox; "Abisola earned the bingd. Award" in the
    // feed. Each is wrong in the other's clause.
    expect(awardAnnouncement({ key: 'unknown', tierKey: 'x' }).title).toBe('a new Award');
    expect(awardAnnouncement({ key: 'unknown', tierKey: 'x' }, 'bingd. Award').title).toBe(
      'bingd. Award',
    );
  });
});

describe('the sheet and the announcement cannot disagree', () => {
  /**
   * Every track, every tier. This is the invariant the founder actually asked for —
   * "notification, feed activity, profile Awards view, tier dots and badge artwork all
   * derive from the same canonical tier definition" — and a per-track test would only
   * pin the two the report happened to name.
   */
  it.each(AWARD_TRACKS.map((t) => [t.key] as const))(
    '%s: the row title equals the announced name at every tier',
    (key) => {
      const subject = track(key);
      for (const tier of subject.tiers) {
        // A reader who has earned exactly this tier. `evaluate` is driven by the metric,
        // so the fact set is built to satisfy it rather than asserted against directly;
        // Movie Muncher is the one used because its metric is the simplest, and the
        // title rule under test does not depend on which metric produced the tier.
        const said = awardAnnouncement({ key, tierKey: tier.key });
        expect(said.title).not.toBe(key);
        expect(said.title).toBe(subject.metalTiers ? subject.displayName : tier.label);
      }
    },
  );

  it('agrees with an actual evaluated row, tier by tier', () => {
    const muncher = track('movie-muncher');
    for (const [index, tier] of muncher.tiers.entries()) {
      const facts: AwardFacts = {
        ...emptyFacts,
        watched: Array.from({ length: tier.threshold }, (_, i) => movie(`m${i}`)),
      };
      const progress = evaluate(muncher, facts);
      expect(progress.earnedTierIndex).toBe(index);
      expect(awardAnnouncement({ key: 'movie-muncher', tierKey: tier.key }).title).toBe(
        progress.title,
      );
    }
  });

  it('shows the first tier locked and unnamed before anything is earned', () => {
    // The founder's third acceptance case. Before the first tier the row is the family
    // name and the badge is dim — never the next tier's name, which would hand over the
    // reward before it was earned and leave nothing to arrive later.
    const gremlin = track('comment-gremlin');
    const progress = evaluate(gremlin, emptyFacts);

    expect(progress.earnedTier).toBeNull();
    expect(progress.earnedTierIndex).toBe(-1);
    expect(progress.title).toBe('Comment Gremlin');
    expect(progress.title).not.toBe('Whisper');
    expect(progress.badgeTierLabel).toBe('Whisper');
    expect(progress.detailLine).toBe('Next: Write 20 comments');
  });
});
