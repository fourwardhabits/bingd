import { badgeFor, BADGES } from './badges';
import { canonicalGenres, CANONICAL_GENRES } from './genres';
import {
  awardsFor,
  evaluate,
  PINNED,
  sortAwards,
  unavailableCount,
  type AwardProgress,
} from './progress';
import { AWARD_TRACKS, type AwardFacts, type AwardTrack, type WatchedTitle } from './tracks';
import { mutualFollowCount } from './use-awards';

/** No collection, no social life. Every count starts at nothing. */
const NOTHING: AwardFacts = {
  watched: [],
  rankedCount: 0,
  watchlistCount: 0,
  invitedSignups: 0,
  writtenCount: 0,
  recommendationsSent: 0,
  reactionsReceived: 0,
  mutualFollows: 0,
};

const facts = (over: Partial<AwardFacts> = {}): AwardFacts => ({ ...NOTHING, ...over });

let seq = 0;
const title = (over: Partial<WatchedTitle> = {}): WatchedTitle => {
  seq += 1;
  return {
    mediaItemId: `m${seq}`,
    kind: 'movie',
    title: `Title ${seq}`,
    seriesTitle: null,
    seasonNumber: null,
    posterPath: null,
    genres: [],
    language: 'en',
    year: 2020,
    ...over,
  };
};

const many = (n: number, over: Partial<WatchedTitle> = {}) =>
  Array.from({ length: n }, () => title(over));

const track = (key: string): AwardTrack => {
  const found = AWARD_TRACKS.find((t) => t.key === key);
  if (!found) throw new Error(`no track ${key}`);
  return found;
};

const award = (key: string, input: AwardFacts) => evaluate(track(key), input);

describe('the shape of the set', () => {
  it('is exactly twenty tracks', () => {
    expect(AWARD_TRACKS).toHaveLength(20);
  });

  it('says which single fact it counts, so a failed read can be told from a zero', () => {
    const fields = new Set(Object.keys(NOTHING));
    for (const t of AWARD_TRACKS) {
      expect([t.key, fields.has(t.needs)]).toEqual([t.key, true]);
    }
    // Thirteen of the twenty are about the collection, which is the one read that is
    // fatal rather than degradable.
    expect(AWARD_TRACKS.filter((t) => t.needs === 'watched')).toHaveLength(13);
  });

  it('gives every track a unique key and three ascending tiers', () => {
    const keys = AWARD_TRACKS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);

    for (const t of AWARD_TRACKS) {
      expect(t.tiers).toHaveLength(3);
      expect(t.tiers[0].threshold).toBeLessThan(t.tiers[1].threshold);
      expect(t.tiers[1].threshold).toBeLessThan(t.tiers[2].threshold);
      // A tier key is half a badge key, so a duplicate inside one track would make
      // two tiers share one picture.
      expect(new Set(t.tiers.map((tier) => tier.key)).size).toBe(3);
    }
  });

  it('never puts an internal metric key in front of a reader', () => {
    for (const t of AWARD_TRACKS) {
      const copy = [
        t.displayName,
        ...t.tiers.map((tier) => tier.label),
        ...t.tiers.map((tier) => t.next(tier.threshold)),
        ...t.tiers.map((tier) => t.earned(tier.threshold)),
      ].join(' ');
      // Slugs and snake_case are the shapes a leaked key takes. The display strings
      // are sentences and none of them should contain one.
      expect(copy).not.toMatch(/[a-z]+_[a-z]+/);
      expect(copy).not.toMatch(/\b[a-z]+-[a-z]+-[a-z]+\b/);
      // No em dash anywhere in the new copy — founder standing rule.
      expect(copy).not.toContain('—');
    }
  });

  it('agrees with the noun when a threshold is one', () => {
    // No tier is one any more, but the plural rule is what stops a future tier of one
    // reading "1 movies" — the kind of thing that makes a reader distrust every other
    // number on the screen.
    expect(track('movie-muncher').next(1)).toBe('Watch 1 movie');
    expect(track('mutual-mania').next(1)).toBe('Follow 1 person who follows you back');
    expect(track('invite-instigator').next(1)).toBe('Bring 1 person to Bingd');
  });

  it('separates thousands, so a top tier is a number and not a serial', () => {
    expect(track('movie-muncher').earned(1000)).toBe('Watched 1,000 movies');
    expect(award('rating-rascal', facts({ rankedCount: 1500 })).countLabel).toBe('1,500 / 2,000');
  });
});

/**
 * **Every threshold in the product, written out.**
 *
 * The founder's device review of 2026-08-18 found the first set far too easy — a Bronze
 * that arrives in an evening is a participation trophy — and set these in their place:
 * Bronze already earned, Silver a serious enthusiast, Gold rare and possibly multi-year.
 *
 * This table is the assertion because a threshold is a *product* decision. Deriving the
 * expectation from the config would make this test agree with any future typo; written
 * out, a number that moves has to be moved here too, deliberately, by somebody who has
 * read this paragraph.
 */
describe('the thresholds', () => {
  const EXPECTED: Record<string, [number, number, number]> = {
    'movie-muncher': [50, 200, 1000],
    'season-snacker': [15, 60, 250],
    'invite-instigator': [3, 15, 50],
    'queue-dragon': [25, 100, 300],
    'rating-rascal': [100, 500, 2000],
    'comment-gremlin': [20, 100, 500],
    'hype-courier': [25, 100, 500],
    'scream-snack': [25, 100, 300],
    'lol-mode': [25, 100, 300],
    'softie-hours': [25, 100, 300],
    'space-brain': [25, 100, 300],
    'boom-club': [25, 100, 300],
    'toon-bloom': [20, 75, 250],
    'truth-worm': [15, 50, 150],
    'passport-mode': [15, 75, 250],
    'time-hopper': [25, 100, 300],
    'genre-gremlin': [8, 14, 16],
    'two-screen-life': [30, 100, 300],
    'heart-magnet': [50, 250, 1000],
    'mutual-mania': [5, 25, 100],
  };

  it('is exactly what the founder set, track by track', () => {
    const actual = Object.fromEntries(
      AWARD_TRACKS.map((t) => [t.key, t.tiers.map((tier) => tier.threshold)]),
    );
    expect(actual).toEqual(EXPECTED);
  });

  it('covers every track, so a new one cannot arrive unreviewed', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(AWARD_TRACKS.map((t) => t.key).sort());
  });

  it('never lets a first tier be reachable in an evening', () => {
    // The specific failure being guarded: Movie Muncher's Bronze was ten films, which
    // is a weekend. Nothing that counts titles a person has to *watch* starts below
    // fifteen now.
    const watching = ['movie-muncher', 'season-snacker', 'toon-bloom', 'truth-worm'];
    for (const key of watching) {
      expect([key, track(key).tiers[0].threshold >= 15]).toEqual([key, true]);
    }
  });

  /**
   * The audit behind Chaos Collector, restated as an assertion.
   *
   * The founder's instruction was to stop carrying a knowingly unreachable top tier.
   * `genres.ts` knows eighteen; the seeded catalogue carries all eighteen but has two
   * documentaries and eight animated titles, so a threshold above sixteen is a hunt for
   * one specific film rather than a measure of range. Sixteen leaves the reader free to
   * miss any two.
   */
  it('sets the distinct-genre top tier inside the vocabulary it counts', () => {
    const top = track('genre-gremlin').tiers[2].threshold;
    expect(top).toBeLessThanOrEqual(CANONICAL_GENRES.length);
    expect(CANONICAL_GENRES.length - top).toBe(2);
  });
});

/**
 * The boundary, on all three tiers, for one track — and then the same boundary asserted
 * across all twenty, because a rule that holds for Movie Muncher and not for Passport
 * Mode is the failure this catches.
 */
describe('tier boundaries', () => {
  const movieMuncher = (n: number) => award('movie-muncher', facts({ watched: many(n) }));

  it('is locked below the first threshold', () => {
    const result = movieMuncher(49);
    expect(result.earnedTier).toBeNull();
    expect(result.earnedLine).toBeNull();
    expect(result.detailLine).toBe('Next: Watch 50 movies');
    expect(result.countLabel).toBe('49 / 50');
    expect(result.badgeTierLabel).toBe('Bronze');
  });

  it('is earned exactly at the first threshold', () => {
    const result = movieMuncher(50);
    expect(result.earnedTier?.label).toBe('Bronze');
    expect(result.earnedLine).toBe('Bronze earned');
    expect(result.detailLine).toBe('Next: Watch 200 movies');
    expect(result.countLabel).toBe('50 / 200');
  });

  it('stays on the first tier above it and below the second', () => {
    const result = movieMuncher(84);
    expect(result.earnedTier?.label).toBe('Bronze');
    expect(result.detailLine).toBe('Next: Watch 200 movies');
    expect(result.countLabel).toBe('84 / 200');
  });

  it('is earned exactly at the second threshold', () => {
    const result = movieMuncher(200);
    expect(result.earnedTier?.label).toBe('Silver');
    expect(result.earnedLine).toBe('Silver earned');
    expect(result.detailLine).toBe('Next: Watch 1,000 movies');
    expect(result.countLabel).toBe('200 / 1,000');
  });

  it('is earned exactly at the third threshold, and says what earned it', () => {
    const result = movieMuncher(1000);
    expect(result.earnedTier?.label).toBe('Gold');
    expect(result.nextTier).toBeNull();
    // The founder's shape at the top: the tier on one line, what earned it on the next.
    expect(result.earnedLine).toBe('Gold earned');
    expect(result.detailLine).toBe('Watched 1,000 movies');
    // A bare count above the top. There is no denominator left to be a fraction of.
    expect(result.countLabel).toBe('1,000');
  });

  it('keeps counting past the top rather than freezing at the threshold', () => {
    const result = movieMuncher(1164);
    expect(result.countLabel).toBe('1,164');
    expect(result.detailLine).toBe('Watched 1,000 movies');
  });

  it('holds at every threshold of every track, one below and exactly on', () => {
    for (const t of AWARD_TRACKS) {
      for (const [index, tier] of t.tiers.entries()) {
        const below = evaluate(t, forced(t, tier.threshold - 1));
        const at = evaluate(t, forced(t, tier.threshold));
        expect([t.key, tier.key, below.earnedTierIndex]).toEqual([t.key, tier.key, index - 1]);
        expect([t.key, tier.key, at.earnedTierIndex]).toEqual([t.key, tier.key, index]);
      }
    }
  });
});

/**
 * A `AwardFacts` whose metric for `track` comes out at exactly `value`.
 *
 * Built per track rather than with one universal fixture, because the twenty metrics
 * read eight different fields and the whole point of the sweep above is that no track
 * is skipped by a fixture that happens not to feed it.
 */
function forced(t: AwardTrack, value: number): AwardFacts {
  const n = Math.max(0, value);
  switch (t.key) {
    case 'movie-muncher':
      return facts({ watched: many(n) });
    case 'season-snacker':
      return facts({ watched: many(n, { kind: 'season' }) });
    case 'invite-instigator':
      return facts({ invitedSignups: n });
    case 'queue-dragon':
      return facts({ watchlistCount: n });
    case 'rating-rascal':
      return facts({ rankedCount: n });
    case 'comment-gremlin':
      return facts({ writtenCount: n });
    case 'hype-courier':
      return facts({ recommendationsSent: n });
    case 'scream-snack':
      return facts({ watched: many(n, { genres: ['Horror'] }) });
    case 'lol-mode':
      return facts({ watched: many(n, { genres: ['Comedy'] }) });
    case 'softie-hours':
      return facts({ watched: many(n, { genres: ['Drama'] }) });
    case 'space-brain':
      return facts({ watched: many(n, { genres: ['Science Fiction'] }) });
    case 'boom-club':
      return facts({ watched: many(n, { genres: ['Action'] }) });
    case 'toon-bloom':
      return facts({ watched: many(n, { genres: ['Animation'] }) });
    case 'truth-worm':
      return facts({ watched: many(n, { genres: ['Documentary'] }) });
    case 'passport-mode':
      return facts({ watched: many(n, { language: 'ja' }) });
    case 'time-hopper':
      return facts({ watched: many(n, { year: 1994 }) });
    case 'genre-gremlin':
      return facts({
        watched: CANONICAL_GENRES.slice(0, n).map((genre) => title({ genres: [genre] })),
      });
    case 'two-screen-life':
      // Split as evenly as the number allows. Both halves stay under every tier's cap
      // at these values, so the capped sum is exactly `n` at the tier being measured.
      return facts({
        watched: [...many(Math.ceil(n / 2)), ...many(Math.floor(n / 2), { kind: 'season' })],
      });
    case 'heart-magnet':
      return facts({ reactionsReceived: n });
    case 'mutual-mania':
      return facts({ mutualFollows: n });
    default:
      throw new Error(`forced() does not know ${t.key}`);
  }
}

describe('what each metric counts', () => {
  it('counts movies and seasons apart', () => {
    const input = facts({ watched: [...many(12), ...many(4, { kind: 'season' })] });
    expect(award('movie-muncher', input).value).toBe(12);
    expect(award('season-snacker', input).value).toBe(4);
  });

  it('counts a title once however many names one genre has', () => {
    // Wikidata gives this film three labels and two of them are Comedy. One title.
    const input = facts({
      watched: [title({ genres: ['comedy drama', 'romantic comedy film', 'teen film'] })],
    });
    expect(award('lol-mode', input).value).toBe(1);
  });

  it('counts a drama-romance once rather than twice', () => {
    const input = facts({ watched: [title({ genres: ['Drama', 'Romance'] })] });
    expect(award('softie-hours', input).value).toBe(1);
  });

  it('reads Wikidata phrasing and TMDB naming as the same genre', () => {
    const input = facts({
      watched: [title({ genres: ['horror film'] }), title({ genres: ['Horror'] })],
    });
    expect(award('scream-snack', input).value).toBe(2);
  });

  it('counts non-English by original language, and never by absence of one', () => {
    const input = facts({
      watched: [
        title({ language: 'ja' }),
        title({ language: 'ko' }),
        title({ language: 'en' }),
        // No language recorded is not evidence of a foreign one.
        title({ language: null }),
      ],
    });
    expect(award('passport-mode', input).value).toBe(2);
  });

  it('counts titles released before 2000, and 2000 itself is not before it', () => {
    const input = facts({
      watched: [
        title({ year: 1975 }),
        title({ year: 1999 }),
        title({ year: 2000 }),
        title({ year: null }),
      ],
    });
    expect(award('time-hopper', input).value).toBe(2);
  });

  it('counts distinct genres from the canonical vocabulary, not from raw labels', () => {
    const input = facts({
      // One film, three Wikidata labels, and only one of them is a genre this app
      // knows. Counting labels would call that three genres of range.
      watched: [title({ genres: ['drama film', 'huis-clos film', 'trial film'] })],
    });
    expect(award('genre-gremlin', input).value).toBe(1);
  });

  it('counts a genre once across many titles', () => {
    const input = facts({ watched: many(8, { genres: ['Horror'] }) });
    expect(award('genre-gremlin', input).value).toBe(1);
  });

  it('counts recommendations sent', () => {
    expect(award('hype-courier', facts({ recommendationsSent: 100 })).earnedTier?.label).toBe(
      'Messenger',
    );
  });

  it('counts the watchlist being held now, and says so as a goal rather than a caveat', () => {
    expect(award('queue-dragon', facts({ watchlistCount: 100 })).earnedTier?.label).toBe('Hoarder');
    // The old row carried a footnote explaining that the number goes down. The goal
    // line says "Keep", which is the same fact as an instruction rather than an excuse.
    expect(track('queue-dragon').next(25)).toBe('Keep 25 titles on your watchlist');
  });
});

/**
 * **Invite Instigator counts people, not links.**
 *
 * The founder's instruction of 2026-08-18, and the thing most worth a test: the old
 * metric was `invite_link_creations` — rows written when somebody pressed "get my link"
 * — so the award rewarded opening a share sheet. Nothing about opening a share sheet
 * says anybody arrived.
 *
 * The read itself is asserted in `AwardsSheet.test.tsx`, which pins the table.
 */
describe('Invite Instigator', () => {
  it('reads attributed signups and nothing else', () => {
    expect(track('invite-instigator').needs).toBe('invitedSignups');
    // The old field is gone from the fact set entirely, so nothing can quietly read it.
    expect(Object.keys(NOTHING)).not.toContain('invitesCreated');
  });

  it('does not move when links are made, because links are not a fact any more', () => {
    // The strongest form this can take without a database: the whole fact surface is
    // eight fields, and none of them is a count of links.
    expect(Object.keys(NOTHING).filter((key) => /link/i.test(key))).toEqual([]);
    expect(award('invite-instigator', facts()).value).toBe(0);
    expect(award('invite-instigator', facts({ invitedSignups: 3 })).earnedTier?.label).toBe(
      'Bronze',
    );
  });

  it('never describes the number as links, sharing or sending', () => {
    const copy = [
      track('invite-instigator').next(3),
      track('invite-instigator').earned(50),
    ].join(' ');
    expect(copy).toBe('Bring 3 people to Bingd Brought 50 people to Bingd');
    for (const word of ['link', 'share', 'sent', 'invited']) {
      expect(copy.toLowerCase()).not.toContain(word);
    }
  });

  it('carries no caveat line, because there is nothing left to explain', () => {
    // "Counts links you made. Bingd cannot see whether they were opened." was a
    // technical apology under a badge. The metric was fixed instead of footnoted.
    expect('note' in track('invite-instigator')).toBe(false);
  });
});

/**
 * **Two-Screen Life is capped contribution, not the weaker side.**
 *
 * `min(movies, seasons)` gave a reader at four films and nine seasons `4 / 5`, which
 * needed a sentence under it explaining that the number was whichever side they were
 * behind on. Each side now counts up to the tier's cap and the two are added, so the
 * number rises whenever either side does and the goal line states the whole rule.
 */
describe('Two-Screen Life', () => {
  const twoScreen = (movies: number, seasons: number) =>
    award(
      'two-screen-life',
      facts({ watched: [...many(movies), ...many(seasons, { kind: 'season' })] }),
    );

  it('adds both sides rather than taking the smaller', () => {
    // The founder's example. Fifteen films and seven seasons is 22, not 7.
    const result = twoScreen(15, 7);
    expect(result.value).toBe(22);
    expect(result.countLabel).toBe('22 / 30');
    expect(result.earnedTier).toBeNull();
  });

  it('caps each side, so one enormous side cannot earn the tier alone', () => {
    // A hundred films and no television is fifteen, not thirty. That is the whole
    // point of the award.
    const lopsided = twoScreen(100, 0);
    expect(lopsided.value).toBe(15);
    expect(lopsided.countLabel).toBe('15 / 30');
    expect(lopsided.earnedTier).toBeNull();
  });

  it('is earned at exactly fifteen and fifteen', () => {
    const result = twoScreen(15, 15);
    expect(result.value).toBe(30);
    expect(result.earnedTier?.label).toBe('Tourist');
    // The next line states the next tier's caps, not its total.
    expect(result.detailLine).toBe('Next: Watch 50 movies and 50 TV seasons');
  });

  it('re-measures against the tier being worked toward', () => {
    // Twenty films and twenty seasons: Bronze is capped at fifteen a side and long
    // earned, and Silver's caps are fifty, so the number the row shows is forty.
    const result = twoScreen(20, 20);
    expect(result.earnedTier?.label).toBe('Tourist');
    expect(result.value).toBe(40);
    expect(result.countLabel).toBe('40 / 100');
  });

  it('finishes at a hundred and fifty a side', () => {
    const result = twoScreen(150, 150);
    expect(result.earnedTier?.label).toBe('Mayor');
    expect(result.nextTier).toBeNull();
    expect(result.earnedLine).toBe('Mayor earned');
    expect(result.detailLine).toBe('Watched 150 movies and 150 TV seasons');
    expect(result.countLabel).toBe('300');
  });

  it('caps at exactly half of every threshold, so the goal line cannot drift', () => {
    // The cap is derived from the threshold rather than configured beside it. This is
    // the identity that makes "Watch 15 movies and 15 TV seasons" true for Bronze
    // without anybody maintaining the fifteen in two places.
    for (const tier of track('two-screen-life').tiers) {
      const cap = tier.threshold / 2;
      expect(Number.isInteger(cap)).toBe(true);
      expect(twoScreen(cap, cap).value).toBeGreaterThanOrEqual(tier.threshold);
      expect(twoScreen(cap, cap - 1).value).toBe(tier.threshold - 1);
    }
  });

  it('carries no explanation of its own arithmetic', () => {
    expect('note' in track('two-screen-life')).toBe(false);
  });
});

/**
 * The titles behind a number, which is the drill-down the founder asked for — the same
 * argument as the goals bars: a count of your own collection that you cannot enumerate
 * is a claim you have to take on faith.
 */
describe('contributors', () => {
  const WITH_CONTRIBUTORS = [
    'movie-muncher',
    'season-snacker',
    'scream-snack',
    'lol-mode',
    'softie-hours',
    'space-brain',
    'boom-club',
    'toon-bloom',
    'truth-worm',
    'passport-mode',
    'time-hopper',
    'two-screen-life',
  ];

  it('is on exactly the tracks whose number is a set of titles', () => {
    const actual = AWARD_TRACKS.filter((t) => t.contributors).map((t) => t.key);
    expect(actual.sort()).toEqual([...WITH_CONTRIBUTORS].sort());
  });

  it('is absent wherever there is no privacy-safe list to show', () => {
    // Invites, reactions and mutual follows are other people, and Bingd has no surface
    // that lists them. Rankings, writing and the watchlist are titles but arrive as
    // counts, not rows. Genre Gremlin counts genres, so a list of titles would have a
    // length that disagrees with the number above it.
    for (const key of [
      'invite-instigator',
      'heart-magnet',
      'mutual-mania',
      'hype-courier',
      'rating-rascal',
      'comment-gremlin',
      'queue-dragon',
      'genre-gremlin',
    ]) {
      expect([key, Boolean(track(key).contributors)]).toEqual([key, false]);
      expect([key, award(key, facts()).hasContributors]).toEqual([key, false]);
    }
  });

  it('lists exactly as many titles as the number claims', () => {
    // The invariant that keeps a drill-down from being a second opinion: for every
    // track but the capped one, the count *is* the length of this list.
    const input = facts({
      watched: [
        title({ genres: ['Horror'], language: 'ja', year: 1985 }),
        title({ genres: ['Comedy'] }),
        title({ kind: 'season', genres: ['Drama'], year: 1998 }),
        title({ genres: ['Animation', 'Documentary'] }),
      ],
    });

    for (const key of WITH_CONTRIBUTORS) {
      if (key === 'two-screen-life') continue;
      const t = track(key);
      expect([key, t.contributors?.(input).length]).toEqual([key, award(key, input).value]);
    }
  });

  it('names the right titles, not merely the right number of them', () => {
    const horror = title({ genres: ['horror film'] });
    const comedy = title({ genres: ['Comedy'] });
    const foreign = title({ language: 'ko' });
    const old = title({ year: 1971 });
    const input = facts({ watched: [horror, comedy, foreign, old] });

    const ids = (key: string) => track(key).contributors?.(input).map((t) => t.mediaItemId);
    expect(ids('scream-snack')).toEqual([horror.mediaItemId]);
    expect(ids('lol-mode')).toEqual([comedy.mediaItemId]);
    expect(ids('passport-mode')).toEqual([foreign.mediaItemId]);
    expect(ids('time-hopper')).toEqual([old.mediaItemId]);
  });

  it('gives Two-Screen Life both halves, movies first', () => {
    const movies = many(2);
    const seasons = many(3, { kind: 'season' });
    const input = facts({ watched: [...seasons, ...movies] });
    expect(track('two-screen-life').contributors?.(input).map((t) => t.kind)).toEqual([
      'movie',
      'movie',
      'season',
      'season',
      'season',
    ]);
  });

  it('is never offered on a row whose number could not be read', () => {
    // A drill-down into a dash would be a list claiming to explain a count nobody has.
    const missing = facts({ unavailable: new Set<keyof AwardFacts>(['watched']) });
    expect(award('movie-muncher', missing).hasContributors).toBe(false);
  });
});

/**
 * Two counts the query does rather than the config, and both have a rule that is easy
 * to state and easy to leave out.
 */
describe('mutual follows', () => {
  const me = 'me';

  it('counts only the people the edge runs both ways with', () => {
    const rows = [
      { follower_id: me, followee_id: 'a' },
      { follower_id: 'a', followee_id: me },
      // One direction only, twice over.
      { follower_id: me, followee_id: 'b' },
      { follower_id: 'c', followee_id: me },
    ];
    expect(mutualFollowCount(rows, me)).toBe(1);
  });

  it('is nothing on an empty or missing result rather than a crash', () => {
    expect(mutualFollowCount([], me)).toBe(0);
    expect(mutualFollowCount(null, me)).toBe(0);
    expect(mutualFollowCount(undefined, me)).toBe(0);
  });

  it('never counts the reader as their own mutual', () => {
    expect(mutualFollowCount([{ follower_id: me, followee_id: me }], me)).toBe(0);
  });

  it('waits for five, because one person following back is not a social life', () => {
    expect(award('mutual-mania', facts({ mutualFollows: 5 })).earnedTier?.label).toBe('Hello');
    expect(award('mutual-mania', facts({ mutualFollows: 4 })).earnedTier).toBeNull();
  });
});

describe('reactions received', () => {
  it('is the count the query returns, and the query excludes the reader', () => {
    // The exclusion lives in the read — `neq('user_id', userId)` — so what is asserted
    // here is that the track counts what it is given and invents nothing on top.
    expect(award('heart-magnet', facts({ reactionsReceived: 50 })).earnedTier?.label).toBe(
      'Warmup',
    );
    expect(award('heart-magnet', facts({ reactionsReceived: 49 })).earnedTier).toBeNull();
  });
});

/**
 * **The order, which is most of the reward.**
 *
 * The founder's rule: three tracks pinned to the top for good, then earned above
 * locked, and inside each of those a fixed category grouping rather than a race by
 * percentage. The old comparator sorted the whole list by closeness to the next tier,
 * which meant the sheet rearranged itself every time somebody logged a film.
 */
describe('sorting', () => {
  const at = (key: string, value: number) => evaluate(track(key), forced(track(key), value));
  const keys = (list: AwardProgress[]) => list.map((a) => a.trackKey);

  it('pins the three core tracks to the top, in the founder’s order', () => {
    expect(keys(awardsFor(NOTHING)).slice(0, 3)).toEqual([
      'movie-muncher',
      'season-snacker',
      'invite-instigator',
    ]);
    expect(PINNED).toEqual(['movie-muncher', 'season-snacker', 'invite-instigator']);
  });

  it('keeps them there whether they are earned or not', () => {
    // Everything else earned to the top tier, the core three at nothing. The three
    // still lead, which is what "never move based on earned status" means.
    const loaded = facts({
      rankedCount: 2000,
      writtenCount: 500,
      recommendationsSent: 500,
      reactionsReceived: 1000,
      mutualFollows: 100,
      watchlistCount: 300,
    });
    expect(keys(awardsFor(loaded)).slice(0, 3)).toEqual([
      'movie-muncher',
      'season-snacker',
      'invite-instigator',
    ]);

    // And the mirror: the core three finished, everything else at zero.
    const core = facts({
      watched: [...many(1000), ...many(250, { kind: 'season' })],
      invitedSignups: 50,
    });
    expect(keys(awardsFor(core)).slice(0, 3)).toEqual([
      'movie-muncher',
      'season-snacker',
      'invite-instigator',
    ]);
  });

  it('keeps a pinned track pinned even when its number could not be read', () => {
    const list = awardsFor(facts({ unavailable: new Set<keyof AwardFacts>(['invitedSignups']) }));
    expect(keys(list)[2]).toBe('invite-instigator');
    expect(list[2]?.unavailable).toBe(true);
  });

  it('puts everything earned above everything locked, after the pinned three', () => {
    const list = awardsFor(facts({ rankedCount: 100, watched: many(25, { genres: ['Horror'] }) }));
    const rest = list.slice(3);
    const earned = rest.filter((a) => a.earnedTier).map((a) => a.trackKey);
    expect(earned).toEqual(['rating-rascal', 'scream-snack']);
    expect(keys(rest).slice(0, 2)).toEqual(earned);
  });

  it('keeps the category grouping inside each bucket', () => {
    // Nothing earned, so the whole tail is one bucket in group order: activity, then
    // genres, then exploration.
    expect(keys(awardsFor(NOTHING))).toEqual([
      'movie-muncher',
      'season-snacker',
      'invite-instigator',
      'rating-rascal',
      'comment-gremlin',
      'hype-courier',
      'heart-magnet',
      'mutual-mania',
      'queue-dragon',
      'scream-snack',
      'lol-mode',
      'softie-hours',
      'space-brain',
      'boom-club',
      'toon-bloom',
      'truth-worm',
      'passport-mode',
      'time-hopper',
      'genre-gremlin',
      'two-screen-life',
    ]);
  });

  it('lets an earned track rise past the locked ones without leaving its area', () => {
    // Time Hopper earned, from the exploration group: it rises above every locked
    // track — including the activity ones it normally sits below — and the rest of the
    // list keeps its order underneath.
    const list = awardsFor(facts({ watched: many(25, { year: 1994 }) }));
    expect(keys(list)[3]).toBe('time-hopper');
    expect(keys(list).slice(4, 7)).toEqual(['rating-rascal', 'comment-gremlin', 'hype-courier']);
  });

  it('does not reorder on closeness to the next tier', () => {
    // Nine tenths of the way to Whisper against nothing at all on Hype Courier. The old
    // comparator would promote Comment Gremlin; the order is fixed and it does not.
    const list = awardsFor(facts({ writtenCount: 18 }));
    expect(keys(list).slice(3)).toEqual(keys(awardsFor(NOTHING)).slice(3));
  });

  it('is stable across renders of the same data', () => {
    const input = facts({ watched: many(60), rankedCount: 120, mutualFollows: 7 });
    expect(keys(awardsFor(input))).toEqual(keys(awardsFor(input)));
    // And the comparator itself does not depend on the order it is handed.
    const evaluated = AWARD_TRACKS.map((t) => evaluate(t, input));
    expect(keys(sortAwards(evaluated))).toEqual(keys(sortAwards([...evaluated].reverse())));
  });

  it('orders earned tracks by their group, never by how large the number is', () => {
    // 2,000 ranked titles is Rank Beast; 25 horror films is Spooky Sip. Rating Rascal
    // leads because activity comes before genres, not because the number is bigger —
    // and the same order holds when the sizes are reversed.
    const list = sortAwards([at('rating-rascal', 2000), at('scream-snack', 25)]);
    expect(keys(list)).toEqual(['rating-rascal', 'scream-snack']);
    const flipped = sortAwards([at('scream-snack', 300), at('rating-rascal', 100)]);
    expect(keys(flipped)).toEqual(['rating-rascal', 'scream-snack']);
  });

  it('returns all twenty however it is ordered', () => {
    expect(awardsFor(NOTHING)).toHaveLength(20);
    expect(awardsFor(facts({ watched: many(200), rankedCount: 400 }))).toHaveLength(20);
  });
});

/**
 * A read that failed is not a count of zero, and the difference matters more here than
 * almost anywhere in the app. Zero is a statement about the reader — you have sent no
 * recommendations — and making it because a request timed out is the app being wrong
 * about somebody in a way they cannot argue with. Independent review 20 found the
 * swallowed error; the founder's Phase 7 asked for this state; they are one instruction.
 */
describe('a track whose number could not be read', () => {
  const missing = (field: keyof AwardFacts) =>
    facts({ unavailable: new Set<keyof AwardFacts>([field]) });

  it('says so rather than drawing a zero', () => {
    const result = award('mutual-mania', missing('mutualFollows'));
    expect(result.unavailable).toBe(true);
    expect(result.detailLine).toBe('Could not load this one');
    expect(result.countLabel).toBe('—');
    expect(result.earnedTier).toBeNull();
    // Never a fraction: the app does not know one.
    expect(result.fraction).toBe(0);
  });

  it('costs only the tracks that needed that field', () => {
    const input = facts({
      watched: many(60),
      unavailable: new Set<keyof AwardFacts>(['mutualFollows']),
    });
    const list = awardsFor(input);
    expect(unavailableCount(list)).toBe(1);
    expect(list.find((a) => a.trackKey === 'movie-muncher')?.earnedTier?.label).toBe('Bronze');
    expect(list.find((a) => a.trackKey === 'mutual-mania')?.unavailable).toBe(true);
  });

  it('takes every track that field feeds, and none when it feeds none', () => {
    expect(unavailableCount(awardsFor(facts({ unavailable: new Set(['watched']) })))).toBe(13);
    expect(unavailableCount(awardsFor(NOTHING))).toBe(0);
  });

  it('sinks to the bottom, below even a track sitting at zero', () => {
    const list = awardsFor(
      facts({ watched: many(60), unavailable: new Set<keyof AwardFacts>(['rankedCount']) }),
    );
    expect(list.at(-1)?.trackKey).toBe('rating-rascal');
  });
});

describe('the badge manifest', () => {
  it('has an entry for every tier of every track', () => {
    const missing: string[] = [];
    for (const t of AWARD_TRACKS) {
      for (const tier of t.tiers) {
        if (!BADGES[`${t.key}-${tier.key}`]) missing.push(`${t.key}-${tier.key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('has sixty entries and not one more, so nothing is mapped to a tier that is gone', () => {
    expect(Object.keys(BADGES)).toHaveLength(60);
    const valid = new Set(
      AWARD_TRACKS.flatMap((t) => t.tiers.map((tier) => `${t.key}-${tier.key}`)),
    );
    expect(Object.keys(BADGES).filter((key) => !valid.has(key))).toEqual([]);
  });

  it('falls back to a medal rather than to nothing', () => {
    // A missing entry must not be able to crash the sheet or render an empty box.
    expect(badgeFor('no-such-track', 'no-such-tier')).toEqual({ kind: 'emoji', emoji: '🏅' });
  });

  it('carries artwork for the ten tracks that were drawn', () => {
    const drawn = [
      'movie-muncher',
      'season-snacker',
      'invite-instigator',
      'queue-dragon',
      'rating-rascal',
      'comment-gremlin',
      'hype-courier',
      'scream-snack',
      'lol-mode',
      'softie-hours',
    ];
    for (const key of drawn) {
      for (const tier of track(key).tiers) {
        expect([key, tier.key, badgeFor(key, tier.key).kind]).toEqual([key, tier.key, 'art']);
      }
    }
  });

  it('stands the other ten in with an emoji rather than leaving a hole', () => {
    const placeholders = Object.entries(BADGES).filter(([, badge]) => badge.kind === 'emoji');
    // Thirty tiers across ten tracks. If this number moves, the report of what is a
    // placeholder has moved with it and the handoff has to say so.
    expect(placeholders).toHaveLength(30);
    for (const [, badge] of placeholders) {
      expect(badge.kind === 'emoji' && badge.emoji.length).toBeGreaterThan(0);
    }
  });
});

describe('the genre vocabulary', () => {
  // The test that found the `musical?` bug: the pattern for Music matched "musica"
  // and "musical" and not the word "Music", which is exactly how TMDB spells it. A
  // genre that cannot recognise its own name is one Genre Gremlin can never count.
  it('recognises every one of its own names', () => {
    for (const genre of CANONICAL_GENRES) {
      expect([genre, [...canonicalGenres([genre])]]).toEqual([genre, [genre]]);
    }
  });

  it('reads both spellings of the same genre', () => {
    expect([...canonicalGenres(['Science Fiction'])]).toEqual(['Science Fiction']);
    expect([...canonicalGenres(['dystopian film'])]).toEqual(['Science Fiction']);
  });

  it('returns nothing for a label it does not recognise, rather than inventing one', () => {
    expect([...canonicalGenres(['huis-clos film'])]).toEqual([]);
    expect([...canonicalGenres([])]).toEqual([]);
    expect([...canonicalGenres(null)]).toEqual([]);
  });

  it('does not let a substring inside a longer word count', () => {
    expect([...canonicalGenres(['warm drama'])]).toEqual(['Drama']);
  });
});
