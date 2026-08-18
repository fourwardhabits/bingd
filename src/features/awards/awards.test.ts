import { badgeFor, BADGES } from './badges';
import { canonicalGenres, CANONICAL_GENRES } from './genres';
import {
  awardsFor,
  earnedSummary,
  evaluate,
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
  invitesCreated: 0,
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
        t.note ?? '',
      ].join(' ');
      // Slugs and snake_case are the shapes a leaked key takes. The display strings
      // are sentences and none of them should contain one.
      expect(copy).not.toMatch(/[a-z]+_[a-z]+/);
      expect(copy).not.toMatch(/\b[a-z]+-[a-z]+-[a-z]+\b/);
      // No em dash anywhere in the new copy — founder standing rule.
      expect(copy).not.toContain('—');
    }
  });

  it('says "1 movie" rather than "1 movies" where a tier is one', () => {
    // Two tracks have a tier of one, and a plural there is the kind of thing that
    // makes a reader distrust every other number on the screen.
    expect(track('mutual-mania').next(1)).toBe('Follow 1 person who follows you back');
    expect(track('invite-instigator').next(1)).toBe('Make your invite link 1 time');
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
    const result = movieMuncher(9);
    expect(result.earnedTier).toBeNull();
    expect(result.earnedLine).toBeNull();
    expect(result.detailLine).toBe('Next: Watch 10 movies');
    expect(result.countLabel).toBe('9 / 10');
    expect(result.badgeTierLabel).toBe('Bronze');
  });

  it('is earned exactly at the first threshold', () => {
    const result = movieMuncher(10);
    expect(result.earnedTier?.label).toBe('Bronze');
    expect(result.earnedLine).toBe('Bronze earned');
    expect(result.detailLine).toBe('Next: Watch 50 movies');
    expect(result.countLabel).toBe('10 / 50');
  });

  it('stays on the first tier above it and below the second', () => {
    const result = movieMuncher(27);
    expect(result.earnedTier?.label).toBe('Bronze');
    expect(result.detailLine).toBe('Next: Watch 50 movies');
    expect(result.countLabel).toBe('27 / 50');
  });

  it('is earned exactly at the second threshold', () => {
    const result = movieMuncher(50);
    expect(result.earnedTier?.label).toBe('Silver');
    expect(result.earnedLine).toBe('Silver earned');
    expect(result.detailLine).toBe('Next: Watch 150 movies');
    expect(result.countLabel).toBe('50 / 150');
  });

  it('is earned exactly at the third threshold, and says so instead of pointing on', () => {
    const result = movieMuncher(150);
    expect(result.earnedTier?.label).toBe('Gold');
    expect(result.nextTier).toBeNull();
    // One line, not two: "Gold earned" above "Gold earned: ..." is the same word twice.
    expect(result.earnedLine).toBeNull();
    expect(result.detailLine).toBe('Gold earned: Watched 150 movies');
    // A bare count above the top. There is no denominator left to be a fraction of.
    expect(result.countLabel).toBe('150');
  });

  it('keeps counting past the top rather than freezing at the threshold', () => {
    const result = movieMuncher(164);
    expect(result.countLabel).toBe('164');
    expect(result.detailLine).toBe('Gold earned: Watched 150 movies');
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
      return facts({ invitesCreated: n });
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
      return facts({ watched: [...many(n), ...many(n, { kind: 'season' })] });
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
      watched: [title({ year: 1975 }), title({ year: 1999 }), title({ year: 2000 }), title({ year: null })],
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

  it('takes the weaker side of the dual requirement', () => {
    const lopsided = facts({ watched: [...many(3), ...many(9, { kind: 'season' })] });
    const both = facts({ watched: [...many(5), ...many(5, { kind: 'season' })] });

    const behind = award('two-screen-life', lopsided);
    expect(behind.value).toBe(3);
    expect(behind.countLabel).toBe('3 / 5');
    expect(behind.earnedTier).toBeNull();
    expect(behind.detailLine).toBe('Next: Watch 5 movies and 5 TV seasons');

    expect(award('two-screen-life', both).earnedTier?.label).toBe('Tourist');
  });

  it('counts invite links made, and says it cannot see what happened to them', () => {
    const input = facts({ invitesCreated: 5 });
    expect(award('invite-instigator', input).earnedTier?.label).toBe('Silver');
    expect(award('invite-instigator', input).note).toBe(
      'Counts links you made. Bingd cannot see whether they were opened.',
    );
    // An opened share sheet is not an invitation sent, and no copy here says it is.
    expect(track('invite-instigator').next(5).toLowerCase()).not.toContain('invited');
    expect(track('invite-instigator').earned(15).toLowerCase()).not.toContain('friends');
  });

  it('counts recommendations sent', () => {
    expect(award('hype-courier', facts({ recommendationsSent: 15 })).earnedTier?.label).toBe(
      'Messenger',
    );
  });

  it('says out loud that the watchlist number is the pile you are holding', () => {
    expect(award('queue-dragon', facts({ watchlistCount: 40 })).earnedTier?.label).toBe('Hoarder');
    expect(award('queue-dragon', facts({ watchlistCount: 1 })).note).toBe(
      'Your watchlist right now, so it goes down when you watch something.',
    );
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

  it('reaches Hello on the very first one, which is the point of a tier of one', () => {
    expect(award('mutual-mania', facts({ mutualFollows: 1 })).earnedTier?.label).toBe('Hello');
    expect(award('mutual-mania', facts({ mutualFollows: 0 })).earnedTier).toBeNull();
  });
});

describe('reactions received', () => {
  it('is the count the query returns, and the query excludes the reader', () => {
    // The exclusion lives in the read — `neq('user_id', userId)` — so what is asserted
    // here is that the track counts what it is given and invents nothing on top.
    expect(award('heart-magnet', facts({ reactionsReceived: 10 })).earnedTier?.label).toBe('Warmup');
    expect(award('heart-magnet', facts({ reactionsReceived: 9 })).earnedTier).toBeNull();
  });
});

describe('sorting', () => {
  const at = (key: string, value: number) => evaluate(track(key), forced(track(key), value));

  it('puts everything earned above everything locked', () => {
    const list = sortAwards([
      at('movie-muncher', 0),
      at('mutual-mania', 1),
      at('season-snacker', 0),
      at('rating-rascal', 25),
    ]);
    const earned = list.filter((a) => a.earnedTier).map((a) => a.trackKey);
    const locked = list.filter((a) => !a.earnedTier).map((a) => a.trackKey);
    expect(list.slice(0, earned.length).map((a) => a.trackKey)).toEqual(earned);
    expect(new Set(locked)).toEqual(new Set(['movie-muncher', 'season-snacker']));
  });

  it('puts a finished track above one that has only its first tier', () => {
    const list = sortAwards([at('movie-muncher', 10), at('mutual-mania', 50)]);
    expect(list.map((a) => a.trackKey)).toEqual(['mutual-mania', 'movie-muncher']);
  });

  it('orders earned tracks by which tier, never by how large the number is', () => {
    // 150 movies is Gold; 25 ranked titles is Scribbler, the first of three. The
    // larger raw number is the lower tier here only by coincidence — what is being
    // asserted is that the *tier* decides.
    const list = sortAwards([at('rating-rascal', 25), at('movie-muncher', 50)]);
    expect(list.map((a) => a.trackKey)).toEqual(['movie-muncher', 'rating-rascal']);
  });

  it('orders locked tracks by how close the next unlock is', () => {
    // 9 of 10 movies, 1 of 3 seasons, nothing at all on the third.
    const list = sortAwards([at('season-snacker', 1), at('heart-magnet', 0), at('movie-muncher', 9)]);
    expect(list.map((a) => a.trackKey)).toEqual([
      'movie-muncher',
      'season-snacker',
      'heart-magnet',
    ]);
  });

  it('breaks ties by name, so a fresh install does not reshuffle on every render', () => {
    const empty = awardsFor(NOTHING);
    const again = awardsFor(NOTHING);
    expect(empty.map((a) => a.trackKey)).toEqual(again.map((a) => a.trackKey));
    // Nothing is earned, everything is at zero, so it is alphabetical throughout.
    const names = empty.map((a) => a.displayName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
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
      watched: many(12),
      unavailable: new Set<keyof AwardFacts>(['mutualFollows']),
    });
    const list = awardsFor(input);
    expect(unavailableCount(list)).toBe(1);
    expect(list.find((a) => a.trackKey === 'movie-muncher')?.earnedTier?.label).toBe('Bronze');
    expect(list.find((a) => a.trackKey === 'mutual-mania')?.unavailable).toBe(true);
  });

  it('takes both tracks down when one field feeds two, and neither when it feeds none', () => {
    expect(unavailableCount(awardsFor(facts({ unavailable: new Set(['watched']) })))).toBe(13);
    expect(unavailableCount(awardsFor(NOTHING))).toBe(0);
  });

  it('sinks to the bottom, below even a track sitting at zero', () => {
    const list = awardsFor(
      facts({ watched: many(12), unavailable: new Set<keyof AwardFacts>(['rankedCount']) }),
    );
    expect(list.at(-1)?.trackKey).toBe('rating-rascal');
  });

  it('is not counted as earned by the summary', () => {
    const list = awardsFor(
      facts({ watched: many(12), unavailable: new Set<keyof AwardFacts>(['mutualFollows']) }),
    );
    expect(earnedSummary(list)).toBe('1 award earned');
  });
});

describe('the summary line', () => {
  it('says nothing at all when nothing is earned', () => {
    expect(earnedSummary(awardsFor(NOTHING))).toBeNull();
  });

  it('counts tracks rather than tiers, so one track is one award', () => {
    // Gold on one track is one award earned, not three.
    expect(earnedSummary(awardsFor(facts({ watched: many(150) })))).toBe('1 award earned');
  });

  it('is plural from two', () => {
    const list: AwardProgress[] = awardsFor(
      facts({ watched: many(150), rankedCount: 25, mutualFollows: 1 }),
    );
    expect(earnedSummary(list)).toBe('3 awards earned');
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
