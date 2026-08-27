import { badgeFor, BADGES } from './badges';
import { canonicalGenres, CANONICAL_GENRES } from './genres';
import {
  awardsFor,
  breakdownFor,
  evaluate,
  PINNED,
  sortAwards,
  unavailableCount,
  type AwardProgress,
} from './progress';
import {
  AWARD_TRACKS,
  breakdownTotal,
  compactLabel,
  type AwardFacts,
  type AwardTrack,
  type PersonRef,
  type RankedTitle,
  type WatchedTitle,
} from './tracks';
import { mutualFollowCount, mutualsFrom } from './use-awards';

/** No collection, no social life. Every count starts at nothing. */
const NOTHING: AwardFacts = {
  watched: [],
  rankings: [],
  watchlist: [],
  invitedSignups: [],
  written: [],
  recommendationsSent: [],
  reactionsReceived: [],
  mutualFollows: [],
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
    watchedOn: null,
    ...over,
  };
};

const many = (n: number, over: Partial<WatchedTitle> = {}) =>
  Array.from({ length: n }, () => title(over));

const ranked = (n: number, over: Partial<RankedTitle> = {}): RankedTitle[] =>
  Array.from({ length: n }, () => ({ ...title(), score: 8.1, ...over }));

let personSeq = 0;
const person = (over: Partial<PersonRef> = {}): PersonRef => {
  personSeq += 1;
  return {
    id: `p${personSeq}`,
    name: `Person ${personSeq}`,
    username: `person${personSeq}`,
    avatarPath: null,
    ...over,
  };
};

const track = (key: string): AwardTrack => {
  const found = AWARD_TRACKS.find((t) => t.key === key);
  if (!found) throw new Error(`no track ${key}`);
  return found;
};

const award = (key: string, input: AwardFacts) => evaluate(track(key), input);

/** The rows behind a track, for the tier it is currently working toward. */
const rowsFor = (key: string, input: AwardFacts) => {
  const progress = award(key, input);
  const breakdown = breakdownFor(track(key), input, progress);
  return { progress, breakdown, rows: breakdown.sections.flatMap((section) => section.rows) };
};

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
      expect(copy).not.toMatch(/[a-z]+_[a-z]+/);
      expect(copy).not.toMatch(/\b[a-z]+-[a-z]+-[a-z]+\b/);
      // No em dash anywhere in the new copy — founder standing rule.
      expect(copy).not.toContain('—');
    }
  });

  it('agrees with the noun when a threshold is one', () => {
    expect(track('movie-muncher').next(1)).toBe('Watch 1 movie');
    expect(track('mutual-mania').next(1)).toBe('Follow 1 person who follows you back');
    expect(track('invite-instigator').next(1)).toBe('Bring 1 person to bingd.');
  });

  it('separates thousands, so a top tier is a number and not a serial', () => {
    expect(track('movie-muncher').earned(1000)).toBe('Watched 1,000 movies');
    expect(award('rating-rascal', facts({ rankings: ranked(1500) })).countLabel).toBe(
      '1,500 / 2,000',
    );
  });
});

/**
 * **Every threshold in the product, written out.**
 *
 * This table is the assertion because a threshold is a *product* decision. Deriving the
 * expectation from the config would make this test agree with any future typo; written
 * out, a number that moves has to be moved here too, deliberately.
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
    'genre-gremlin': [14, 16, 17],
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

  it('sets the distinct-genre top tier one short of the vocabulary it counts', () => {
    /**
     * Seventeen of eighteen, and the *one* is the whole argument.
     *
     * The measurement is in `scripts/awards/genre-ladder-report.mjs` and quoted in the
     * config's own comment. Over the 1,814 loggable rows Documentary is carried by six and
     * Animation by ten; a reader who may miss one genre can finish on Western, Music or War
     * about half the time, and one who may miss none is sent after the rarest row there is —
     * a median of 126 further logged units against 45, and a 90th percentile of 448.
     *
     * So the assertion is exactly "one short", in both directions: eighteen would be the
     * scavenger hunt the brief rules out, and sixteen was the Gold that took a median of 62
     * units while every other Gold in the file takes 250.
     */
    const top = track('genre-gremlin').tiers[2].threshold;
    expect(CANONICAL_GENRES.length - top).toBe(1);
  });

  /**
   * The founder's Preview note: Dabbler was being earned for watching a handful of
   * ordinary films, because one title carries 2.68 canonical genres on average.
   *
   * The audit is in `tracks.ts`. What is asserted here is the *shape* the audit
   * concluded, so that moving one threshold without the others fails: an entry tier
   * that a handful of titles cannot reach, and a ceiling that does not require the two
   * genres the catalogue barely has.
   */
  it('sets the distinct-genre entry tier above what a handful of titles yields', () => {
    const [bronze, silver, gold] = track('genre-gremlin').tiers.map((tier) => tier.threshold);

    /**
     * The founder's complaint was that the *whole ladder* was compressed, not that one
     * number was off by two — so what is asserted here is the shape the measurement
     * concluded, and moving one threshold without the others fails it.
     *
     * Thirteen is the line: at 2.68 canonical genres per title, twelve distinct genres is
     * a median of fifteen logged units and a tenth of readers get there in nine. That is
     * the "handful of ordinary multi-genre titles" the entry tier must sit past.
     */
    expect(bronze!).toBeGreaterThan(13);
    // Still an entry tier rather than a second Silver: short of five-sixths of the
    // vocabulary, where the thin tail starts deciding the outcome.
    expect(bronze!).toBeLessThan(CANONICAL_GENRES.length * (5 / 6));
    // Monotonic and distinct, so no two tiers can be earned by the same collection.
    expect(bronze!).toBeLessThan(silver!);
    expect(silver).toBeLessThan(gold!);
    /**
     * **The compression test.** Bronze and Silver two genres apart is roughly a doubling
     * of logged units (27 → 62 at the median); one genre apart is 1.5×, which is the
     * "Bronze→Silver only one or two ordinary viewing sessions apart" the brief names.
     * Gold is deliberately allowed to be one step, because genre 17 alone costs more than
     * genres 15 and 16 together.
     */
    expect(silver! - bronze!).toBeGreaterThanOrEqual(2);
  });
});

describe('tier boundaries', () => {
  const movieMuncher = (n: number) => award('movie-muncher', facts({ watched: many(n) }));

  it('is locked below the first threshold', () => {
    const result = movieMuncher(49);
    expect(result.earnedTier).toBeNull();
    expect(result.detailLine).toBe('Next: Watch 50 movies');
    expect(result.countLabel).toBe('49 / 50');
  });

  it('is earned exactly at the first threshold', () => {
    const result = movieMuncher(50);
    expect(result.earnedTier?.label).toBe('Bronze');
    expect(result.detailLine).toBe('Next: Watch 200 movies');
  });

  it('is earned exactly at the third threshold, and says what earned it', () => {
    const result = movieMuncher(1000);
    expect(result.earnedTier?.label).toBe('Gold');
    expect(result.nextTier).toBeNull();
    expect(result.detailLine).toBe('Watched 1,000 movies');
    expect(result.countLabel).toBe('1,000');
  });

  it('keeps counting past the top rather than freezing at the threshold', () => {
    expect(movieMuncher(1164).countLabel).toBe('1,164');
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
 * read eight different fields and the whole point of the sweeps is that no track is
 * skipped by a fixture that happens not to feed it.
 */
function forced(t: AwardTrack, value: number): AwardFacts {
  const n = Math.max(0, value);
  switch (t.key) {
    case 'movie-muncher':
      return facts({ watched: many(n) });
    case 'season-snacker':
      return facts({ watched: many(n, { kind: 'season' }) });
    case 'invite-instigator':
      return facts({
        invitedSignups: Array.from({ length: n }, () => ({
          person: person(),
          activatedAt: '2026-01-01T00:00:00Z',
        })),
      });
    case 'queue-dragon':
      return facts({ watchlist: many(n) });
    case 'rating-rascal':
      return facts({ rankings: ranked(n) });
    case 'comment-gremlin':
      return facts({
        written: Array.from({ length: n }, (_, i) => ({
          key: `c${i}`,
          kind: 'comment' as const,
          title: title(),
          writtenAt: '2026-01-01T00:00:00Z',
        })),
      });
    case 'hype-courier':
      return facts({
        recommendationsSent: Array.from({ length: n }, (_, i) => ({
          key: `r${i}`,
          title: title(),
          recipient: person(),
          sentAt: '2026-01-01T00:00:00Z',
        })),
      });
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
      // One item carrying the whole weight, which is also the case the sum has to
      // survive: a breakdown row is not always worth one.
      return facts({
        reactionsReceived: n > 0 ? [{ key: 'e1', title: title(), reactions: n }] : [],
      });
    case 'mutual-mania':
      return facts({ mutualFollows: Array.from({ length: n }, () => person()) });
    default:
      throw new Error(`forced() does not know ${t.key}`);
  }
}

/**
 * **The invariant this whole pass is built on.**
 *
 * The number on a row and the list behind it come from one call — `contributions` — so
 * they cannot disagree. This asserts it for all twenty tracks at several sizes, which is
 * the test that would fail the moment somebody added a second query "just for the
 * drill-down".
 */
describe('the award number is the breakdown', () => {
  it('holds for every track at every tier boundary', () => {
    for (const t of AWARD_TRACKS) {
      for (const tier of t.tiers) {
        for (const value of [0, tier.threshold - 1, tier.threshold]) {
          if (value < 0) continue;
          const input = forced(t, value);
          const progress = evaluate(t, input);
          const total = breakdownTotal(breakdownFor(t, input, progress));
          expect([t.key, value, total]).toEqual([t.key, value, progress.value]);
        }
      }
    }
  });

  it('holds against a mixed collection rather than a single-purpose fixture', () => {
    const input = facts({
      watched: [
        title({ genres: ['Horror', 'Thriller'], language: 'ja', year: 1985 }),
        title({ genres: ['Comedy'], watchedOn: '2026-02-03' }),
        title({ kind: 'season', genres: ['Drama'], seriesTitle: 'The Last of Us', seasonNumber: 1, year: 2023 }),
        title({ genres: ['Animation', 'Documentary'], language: 'fr' }),
      ],
      rankings: ranked(3),
      watchlist: many(2),
      written: [{ key: 'c1', kind: 'comment', title: title(), writtenAt: null }],
      recommendationsSent: [{ key: 'r1', title: title(), recipient: person(), sentAt: null }],
      reactionsReceived: [
        { key: 'e1', title: title(), reactions: 4 },
        { key: 'e2', title: title(), reactions: 1 },
      ],
      mutualFollows: [person(), person()],
      invitedSignups: [],
    });

    for (const t of AWARD_TRACKS) {
      const progress = evaluate(t, input);
      const total = breakdownTotal(breakdownFor(t, input, progress));
      expect([t.key, total]).toEqual([t.key, progress.value]);
    }
  });

  it('offers a breakdown on all twenty rows, not a chosen few', () => {
    // The founder's principle: a number the reader is shown is a number they can open.
    for (const t of AWARD_TRACKS) {
      expect([t.key, typeof t.contributions]).toEqual([t.key, 'function']);
    }
  });
});

/**
 * Television is part of the app now.
 *
 * Before `lib/media-metadata.ts` a season carried no genres and no language, so nine of
 * the twenty tracks were quietly movie-only: `The Last of Us, S1` counted toward Season
 * Snacker and nothing else. The facts arrive already resolved (`use-awards.ts`), so what
 * is asserted here is that the tracks count a season exactly like a film once it has
 * metadata — and that a series is never in the set to be double-counted.
 */
describe('TV seasons count', () => {
  const lastOfUs = (over: Partial<WatchedTitle> = {}) =>
    title({
      kind: 'season',
      title: 'Season 1',
      seriesTitle: 'The Last of Us',
      seasonNumber: 1,
      year: 2023,
      genres: ['Drama'],
      ...over,
    });

  it('contributes to a genre award through its series genres', () => {
    const input = facts({ watched: [lastOfUs()] });
    expect(award('softie-hours', input).value).toBe(1);
    expect(rowsFor('softie-hours', input).rows[0]?.label).toBe('The Last of Us, S1');
  });

  it('contributes to Passport Mode through its series language', () => {
    const input = facts({ watched: [lastOfUs({ language: 'ko', genres: [] })] });
    expect(award('passport-mode', input).value).toBe(1);
    // The language is named rather than coded: "ko" is a database value, not a label.
    expect(rowsFor('passport-mode', input).rows[0]?.detail).toBe('Korean');
  });

  it('contributes to Genre Gremlin, and a season and a film share one genre once', () => {
    const input = facts({
      watched: [lastOfUs(), title({ genres: ['Drama'] }), title({ genres: ['Horror'] })],
    });
    expect(award('genre-gremlin', input).value).toBe(2);
    const { rows } = rowsFor('genre-gremlin', input);
    expect(rows.map((row) => row.label)).toEqual(['Drama', 'Horror']);
    // Two titles carry Drama — the season and the film — and the row says so.
    expect(rows[0]?.value).toBe('2 titles');
  });

  it('counts the season and never the series, so nothing is doubled', () => {
    // A series cannot be logged at all (`_assert_loggable`), and `WatchedTitle` has no
    // 'series' kind to represent one. The type is the guarantee; this is the statement
    // of it, over a show with three seasons.
    const input = facts({
      watched: [lastOfUs(), lastOfUs({ seasonNumber: 2 }), lastOfUs({ seasonNumber: 3 })],
    });
    expect(award('season-snacker', input).value).toBe(3);
    expect(award('softie-hours', input).value).toBe(3);
    expect(award('movie-muncher', input).value).toBe(0);
    expect(award('genre-gremlin', input).value).toBe(1);
  });

  it('does not count a season whose show carries nothing either', () => {
    const orphan = lastOfUs({ genres: [], language: null });
    const input = facts({ watched: [orphan] });
    expect(award('softie-hours', input).value).toBe(0);
    expect(award('passport-mode', input).value).toBe(0);
    // It is still a season, and Season Snacker is about the watching rather than the
    // metadata.
    expect(award('season-snacker', input).value).toBe(1);
  });

  it('names a season by its show everywhere a breakdown draws one', () => {
    expect(compactLabel(lastOfUs())).toBe('The Last of Us, S1');
    // A season named after its own show must not read "Chernobyl, Chernobyl".
    expect(
      compactLabel(title({ kind: 'season', title: 'Chernobyl', seriesTitle: 'Chernobyl' })),
    ).toBe('Chernobyl');
  });
});

describe('what each metric counts', () => {
  it('counts movies and seasons apart', () => {
    const input = facts({ watched: [...many(12), ...many(4, { kind: 'season' })] });
    expect(award('movie-muncher', input).value).toBe(12);
    expect(award('season-snacker', input).value).toBe(4);
  });

  it('counts a title once however many names one genre has', () => {
    const input = facts({
      watched: [title({ genres: ['comedy drama', 'romantic comedy film', 'teen film'] })],
    });
    expect(award('lol-mode', input).value).toBe(1);
  });

  it('counts a drama-romance once rather than twice', () => {
    const input = facts({ watched: [title({ genres: ['Drama', 'Romance'] })] });
    expect(award('softie-hours', input).value).toBe(1);
    expect(rowsFor('softie-hours', input).rows).toHaveLength(1);
  });

  it('counts non-English by original language, and never by absence of one', () => {
    const input = facts({
      watched: [
        title({ language: 'ja' }),
        title({ language: 'ko' }),
        title({ language: 'en' }),
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
});

/**
 * **The title of a row is the tier reached, and that is the reward.**
 *
 * A creative track used to keep its family name and add a line saying "Dabbler earned",
 * which stated the achievement and celebrated it nowhere. The name now *becomes* the
 * row's heading — and the next one is never shown early, because handing over the name
 * in advance spends the reward before it is earned.
 */
describe('what a row is called', () => {
  const gremlin = (n: number) =>
    award('genre-gremlin', facts({ watched: CANONICAL_GENRES.slice(0, n).map((g) => title({ genres: [g] })) }));

  it('shows the family name before the first tier', () => {
    const locked = gremlin(6);
    expect(locked.title).toBe('Genre Gremlin');
    expect(locked.detailLine).toBe('Next: Watch 14 different genres');
    expect(locked.countLabel).toBe('6 / 14');
  });

  it('becomes the first tier name once it is earned', () => {
    const tier1 = gremlin(14);
    expect(tier1.title).toBe('Dabbler');
    expect(tier1.detailLine).toBe('Next: Watch 16 different genres');
    expect(tier1.countLabel).toBe('14 / 16');
  });

  it('becomes the second tier name at the second threshold', () => {
    const tier2 = gremlin(16);
    expect(tier2.title).toBe('Mixer');
    expect(tier2.detailLine).toBe('Next: Watch 17 different genres');
  });

  it('becomes the third tier name at the top, and states what earned it', () => {
    const tier3 = gremlin(17);
    expect(tier3.title).toBe('Chaos Collector');
    expect(tier3.detailLine).toBe('Watched 17 different genres');
    expect(tier3.countLabel).toBe('17');
  });

  it('never reveals the next tier name before it is earned', () => {
    // The specific leak this guards: a locked row that said "Dabbler" would give away
    // the reward, and a tier-1 row that said "Mixer" would give away the next one.
    for (const [reached, forbidden] of [
      [6, ['Dabbler', 'Mixer', 'Chaos Collector']],
      [14, ['Mixer', 'Chaos Collector']],
      [16, ['Chaos Collector']],
    ] as const) {
      const progress = gremlin(reached);
      const shown = [progress.title, progress.detailLine].join(' ');
      for (const name of forbidden) expect([reached, name, shown.includes(name)]).toEqual([reached, name, false]);
    }
  });

  it('keeps the family name on a generic Bronze/Silver/Gold track', () => {
    // A row headed "Silver" says nothing about what was done, and three of them on one
    // screen say less. The art and the dots carry the metal.
    for (const key of ['movie-muncher', 'season-snacker', 'invite-instigator']) {
      const t = track(key);
      expect([key, t.metalTiers]).toEqual([key, true]);
      for (const value of [0, t.tiers[0].threshold, t.tiers[1].threshold, t.tiers[2].threshold]) {
        expect([key, value, evaluate(t, forced(t, value)).title]).toEqual([
          key,
          value,
          t.displayName,
        ]);
      }
    }
  });

  it('marks exactly the metal tracks as metal', () => {
    expect(AWARD_TRACKS.filter((t) => t.metalTiers).map((t) => t.key)).toEqual([
      'movie-muncher',
      'season-snacker',
      'invite-instigator',
    ]);
    // And no creative track pretends to be one, which would cost it its reward.
    for (const t of AWARD_TRACKS.filter((x) => !x.metalTiers)) {
      expect([t.key, t.tiers.map((tier) => tier.label)]).not.toEqual([
        t.key,
        ['Bronze', 'Silver', 'Gold'],
      ]);
    }
  });

  it('has no separate earned line left to render', () => {
    // The line is gone from the model, not merely hidden: `AwardProgress` has no field
    // for it, so nothing can put it back by accident.
    const progress = gremlin(10) as AwardProgress & { earnedLine?: unknown };
    expect(progress.earnedLine).toBeUndefined();
    expect(Object.keys(progress)).not.toContain('earnedLine');
  });

  it('fills one dot per tier earned', () => {
    // `earnedTierIndex` is what `TierDots` draws: -1 is three empty, 0 is bronze only.
    expect(gremlin(6).earnedTierIndex).toBe(-1);
    expect(gremlin(14).earnedTierIndex).toBe(0);
    expect(gremlin(16).earnedTierIndex).toBe(1);
    expect(gremlin(17).earnedTierIndex).toBe(2);
  });

  /**
   * **Every boundary of the rebalanced ladder, one row each.**
   *
   * The founder's brief asks for exactly this table — threshold−1, the threshold itself,
   * the next threshold−1, and the top — because a ladder change that only moves the
   * numbers in the config is a ladder change nothing has checked. Written as data rather
   * than as four `it`s so the next rebalance edits one table and sees every consequence.
   *
   * Genre Gremlin is the one track where these boundaries are cheap to reach in a fixture
   * (one title per genre) and where the whole tier is one integer apart from the next, so
   * an off-by-one is invisible in every other kind of test.
   */
  it('reads correctly on both sides of each of the three thresholds', () => {
    const boundaries: [number, string | null, string, string][] = [
      // genres,  tier earned,        heading,          detail line
      [13, null, 'Genre Gremlin', 'Next: Watch 14 different genres'],
      [14, 'Dabbler', 'Dabbler', 'Next: Watch 16 different genres'],
      [15, 'Dabbler', 'Dabbler', 'Next: Watch 16 different genres'],
      [16, 'Mixer', 'Mixer', 'Next: Watch 17 different genres'],
      [17, 'Chaos Collector', 'Chaos Collector', 'Watched 17 different genres'],
      // Eighteen is outside the ladder on purpose: the reader who does collect every
      // genre is still Chaos Collector, and the row must not read "18 / 17".
      [18, 'Chaos Collector', 'Chaos Collector', 'Watched 17 different genres'],
    ];

    for (const [genres, tier, heading, detail] of boundaries) {
      const progress = gremlin(genres);
      expect([genres, progress.title]).toEqual([genres, heading]);
      expect([genres, progress.detailLine]).toEqual([genres, detail]);
      expect([genres, progress.earnedTier?.label ?? null]).toEqual([genres, tier]);
    }
  });

  it('states the count against the next threshold, never against the last one', () => {
    // `13 / 14` and not `13 / 12`: the pair a reader reads is where they are against where
    // they are going. At the top there is nowhere to go, so it is the bare number.
    expect(gremlin(13).countLabel).toBe('13 / 14');
    expect(gremlin(15).countLabel).toBe('15 / 16');
    expect(gremlin(16).countLabel).toBe('16 / 17');
    expect(gremlin(17).countLabel).toBe('17');
    expect(gremlin(18).countLabel).toBe('18');
  });
});

describe('Invite Instigator', () => {
  it('reads attributed signups and nothing else', () => {
    expect(track('invite-instigator').needs).toBe('invitedSignups');
    expect(Object.keys(NOTHING)).not.toContain('invitesCreated');
    expect(Object.keys(NOTHING).filter((key) => /link/i.test(key))).toEqual([]);
  });

  it('never describes the number as links, sharing or sending', () => {
    const copy = [track('invite-instigator').next(3), track('invite-instigator').earned(50)].join(' ');
    expect(copy).toBe('Bring 3 people to bingd. Brought 50 people to bingd.');
    for (const word of ['link', 'share', 'sent', 'invited']) {
      expect(copy.toLowerCase()).not.toContain(word);
    }
  });

  it('is tappable and truthfully empty while attribution is deferred', () => {
    const { progress, breakdown, rows } = rowsFor('invite-instigator', NOTHING);
    expect(progress.value).toBe(0);
    expect(rows).toEqual([]);
    expect(breakdown.emptyLabel).toBe('No activated invites yet.');
  });

  it('lists the people once there are any, with when they joined', () => {
    const input = facts({
      invitedSignups: [{ person: person({ name: 'Ada', username: 'ada' }), activatedAt: '2026-03-04T00:00:00Z' }],
    });
    const { rows, progress } = rowsFor('invite-instigator', input);
    expect(progress.value).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('Ada');
    expect(rows[0]?.detail).toContain('Joined');
    expect(rows[0]?.link).toEqual({ kind: 'profile', username: 'ada' });
  });
});

/**
 * The privacy rule every people-shaped breakdown shares.
 *
 * An embed onto `profiles` is filtered by `can_i_view`, so a blocked, suspended or
 * deleted account does not come back. That must not shrink the count — the follow is
 * still a follow — so it becomes a row that discloses nothing and leads nowhere.
 */
describe('a person the reader may not see', () => {
  const hidden = person({ name: 'Someone on bingd.', username: null });

  it('still counts, so the number stays honest', () => {
    const input = facts({ mutualFollows: [person(), hidden] });
    expect(award('mutual-mania', input).value).toBe(2);
    expect(rowsFor('mutual-mania', input).rows).toHaveLength(2);
  });

  it('discloses no handle and offers no route to a profile', () => {
    const { rows } = rowsFor('mutual-mania', facts({ mutualFollows: [hidden] }));
    expect(rows[0]?.label).toBe('Someone on bingd.');
    expect(rows[0]?.detail).toBe('This account is not available to you');
    expect(rows[0]?.link).toBeNull();
  });
});

describe('mutual follows', () => {
  const me = 'me';
  const edge = (follower: string, followee: string) => ({
    follower_id: follower,
    followee_id: followee,
    follower: { id: follower, username: follower, display_name: null, avatar_path: null },
    followee: { id: followee, username: followee, display_name: null, avatar_path: null },
  });

  it('counts only the people the edge runs both ways with', () => {
    const rows = [edge(me, 'a'), edge('a', me), edge(me, 'b'), edge('c', me)];
    expect(mutualFollowCount(rows, me)).toBe(1);
    expect(mutualsFrom(rows, me).map((p) => p.id)).toEqual(['a']);
  });

  it('is nothing on an empty or missing result rather than a crash', () => {
    expect(mutualFollowCount([], me)).toBe(0);
    expect(mutualFollowCount(null, me)).toBe(0);
    expect(mutualFollowCount(undefined, me)).toBe(0);
  });

  it('never counts the reader as their own mutual', () => {
    expect(mutualFollowCount([edge(me, me)], me)).toBe(0);
  });

  it('waits for five, because one person following back is not a social life', () => {
    expect(award('mutual-mania', facts({ mutualFollows: [person(), person(), person(), person(), person()] })).earnedTier?.label).toBe('Hello');
    expect(award('mutual-mania', facts({ mutualFollows: [person()] })).earnedTier).toBeNull();
  });

  it('gives every mutual a row, and the row count is the number', () => {
    const input = facts({ mutualFollows: [person(), person(), person()] });
    const { rows, progress } = rowsFor('mutual-mania', input);
    expect(rows).toHaveLength(3);
    expect(progress.value).toBe(3);
  });
});

describe('Heart Magnet', () => {
  it('sums the reactions on each item rather than counting the items', () => {
    const input = facts({
      reactionsReceived: [
        { key: 'e1', title: title({ title: 'The Wolf of Wall Street' }), reactions: 18 },
        { key: 'e2', title: title({ title: 'Inception' }), reactions: 12 },
      ],
    });
    const { progress, rows } = rowsFor('heart-magnet', input);
    expect(progress.value).toBe(30);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.value).toBe('18 reactions');
    // The sum of the rows is the badge's number, which is the invariant that stops a
    // content-centric breakdown from quietly disagreeing with a reaction count.
    expect(rows.reduce((sum, row) => sum + (row.weight ?? 1), 0)).toBe(progress.value);
  });

  it('excludes the reader’s own reactions, because the read does', () => {
    // `neq('user_id', userId)` is where the rule lives; what the track guarantees is
    // that it counts what it is given and invents nothing on top.
    expect(award('heart-magnet', facts({ reactionsReceived: [] })).value).toBe(0);
    expect(award('heart-magnet', forced(track('heart-magnet'), 50)).earnedTier?.label).toBe(
      'Warmup',
    );
  });

  it('says what was reacted to and never who reacted', () => {
    const { rows } = rowsFor(
      'heart-magnet',
      facts({ reactionsReceived: [{ key: 'e1', title: title({ title: 'Heat' }), reactions: 3 }] }),
    );
    expect(rows[0]?.label).toBe('Heat');
    expect(rows[0]?.avatarPath).toBeUndefined();
  });
});

describe('Comment Gremlin', () => {
  it('counts one canonical contribution once, however many surfaces show it', () => {
    // A public note is one `user_media` row that appears on the activity row and in
    // Bingd Reviews. It is counted where it is stored, so there is one row for it.
    const input = facts({
      written: [
        { key: 'note:m1', kind: 'note', title: title({ title: 'Arrival' }), writtenAt: null },
        { key: 'comment:c1', kind: 'comment', title: title({ title: 'Heat' }), writtenAt: '2026-01-02T00:00:00Z' },
      ],
    });
    const { progress, rows } = rowsFor('comment-gremlin', input);
    expect(progress.value).toBe(2);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });

  it('distinguishes the kind of contribution and where it was', () => {
    const { rows } = rowsFor(
      'comment-gremlin',
      facts({ written: [{ key: 'note:m1', kind: 'note', title: title({ title: 'Arrival' }), writtenAt: null }] }),
    );
    expect(rows[0]?.label).toBe('Arrival');
    expect(rows[0]?.detail).toBe('Review');
  });

  it('never reprints what was written', () => {
    // The award counts that somebody wrote. A note's body belongs where its spoiler
    // masking lives, and the fact type has no field to carry one.
    const contribution = { key: 'k', kind: 'note' as const, title: null, writtenAt: null };
    expect(Object.keys(contribution)).not.toContain('body');
    const { rows } = rowsFor('comment-gremlin', facts({ written: [contribution] }));
    expect(rows[0]?.label).toBe('A bingd. activity');
  });
});

describe('Hype Courier', () => {
  it('counts in-app recommendations and names the recipient', () => {
    const input = facts({
      recommendationsSent: [
        { key: 'r1', title: title({ title: 'Heat' }), recipient: person({ name: 'Ada' }), sentAt: '2026-01-02T00:00:00Z' },
      ],
    });
    const { progress, rows } = rowsFor('hype-courier', input);
    expect(progress.value).toBe(1);
    expect(rows[0]?.label).toBe('Heat');
    expect(rows[0]?.detail).toContain('To Ada');
  });

  it('counts nothing for a share off Bingd, because the metric never sees one', () => {
    // An OS share sheet may be dismissed and nothing here would know — the same rule
    // that keeps Invite Instigator off link creations. There is no field for one.
    expect(Object.keys(NOTHING)).not.toContain('sharesOffPlatform');
    expect(award('hype-courier', NOTHING).value).toBe(0);
  });
});

describe('Rating Rascal and Queue Dragon', () => {
  it('lists the exact ranked titles with the score the reader gave', () => {
    const input = facts({ rankings: [{ ...title({ title: 'Heat' }), score: 9.2 }] });
    const { progress, rows } = rowsFor('rating-rascal', input);
    expect(progress.value).toBe(1);
    expect(rows[0]?.label).toBe('Heat');
    expect(rows[0]?.value).toBe('9.2');
  });

  it('lists the watchlist being held now', () => {
    const input = facts({ watchlist: many(3) });
    const { progress, rows } = rowsFor('queue-dragon', input);
    expect(progress.value).toBe(3);
    expect(rows).toHaveLength(3);
    // The goal line says "Keep", which is the same fact as an instruction rather than
    // as the footnote the row used to carry.
    expect(track('queue-dragon').next(25)).toBe('Keep 25 titles on your watchlist');
  });
});

/**
 * **Two-Screen Life is capped contribution, and its breakdown is the explanation.**
 *
 * Each side counts up to half the tier and the two are added. The sheet shows a Movies
 * section reading `15 / 15` and a TV Seasons section reading `7 / 15`, which makes the
 * arithmetic self-evident without a paragraph about caps.
 */
describe('Two-Screen Life', () => {
  const twoScreen = (movies: number, seasons: number) =>
    facts({ watched: [...many(movies), ...many(seasons, { kind: 'season' })] });

  it('adds both sides rather than taking the smaller', () => {
    const result = award('two-screen-life', twoScreen(15, 7));
    expect(result.value).toBe(22);
    expect(result.countLabel).toBe('22 / 30');
  });

  it('caps each side, so one enormous side cannot earn the tier alone', () => {
    expect(award('two-screen-life', twoScreen(100, 0)).value).toBe(15);
  });

  it('is earned at exactly fifteen and fifteen', () => {
    const result = award('two-screen-life', twoScreen(15, 15));
    expect(result.earnedTier?.label).toBe('Tourist');
    expect(result.detailLine).toBe('Next: Watch 50 movies and 50 TV seasons');
  });

  it('re-measures against the tier being worked toward', () => {
    const result = award('two-screen-life', twoScreen(20, 20));
    expect(result.value).toBe(40);
    expect(result.countLabel).toBe('40 / 100');
  });

  it('breaks down into two capped sections that reproduce the arithmetic', () => {
    const input = twoScreen(20, 7);
    const { breakdown, progress } = rowsFor('two-screen-life', input);
    const [movies, seasons] = breakdown.sections;

    expect(movies?.label).toBe('Movies');
    expect(movies?.value).toBe('15 / 15');
    // Only the fifteen that count are listed, which is what keeps the sum equal to the
    // number — and is why twenty films do not appear under a heading saying fifteen.
    expect(movies?.rows).toHaveLength(15);

    // The heading is the visible category, "TV"; the sentences that *count* — the
    // detailLine above — keep "TV seasons" because seasons are what they count.
    expect(seasons?.label).toBe('TV');
    expect(seasons?.value).toBe('7 / 15');
    expect(seasons?.rows).toHaveLength(7);

    expect(progress.value).toBe(22);
    expect(breakdownTotal(breakdown)).toBe(22);
  });

  it('caps at exactly half of every threshold, so the goal line cannot drift', () => {
    for (const tier of track('two-screen-life').tiers) {
      const cap = tier.threshold / 2;
      expect(Number.isInteger(cap)).toBe(true);
      expect(award('two-screen-life', twoScreen(cap, cap)).value).toBeGreaterThanOrEqual(
        tier.threshold,
      );
      expect(award('two-screen-life', twoScreen(cap, cap - 1)).value).toBe(tier.threshold - 1);
    }
  });
});

describe('sorting', () => {
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
    const loaded = facts({
      rankings: ranked(2000),
      written: forced(track('comment-gremlin'), 500).written,
      mutualFollows: Array.from({ length: 100 }, () => person()),
    });
    expect(keys(awardsFor(loaded)).slice(0, 3)).toEqual([
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
    const list = awardsFor(
      facts({ rankings: ranked(100), watched: many(25, { genres: ['Horror'] }) }),
    );
    const rest = list.slice(3);
    expect(keys(rest).slice(0, 2)).toEqual(['rating-rascal', 'scream-snack']);
  });

  it('keeps the category grouping inside each bucket', () => {
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

  it('does not reorder on closeness to the next tier', () => {
    const list = awardsFor(facts({ written: forced(track('comment-gremlin'), 18).written }));
    expect(keys(list).slice(3)).toEqual(keys(awardsFor(NOTHING)).slice(3));
  });

  it('is stable across renders of the same data', () => {
    const input = facts({ watched: many(60), rankings: ranked(120) });
    expect(keys(awardsFor(input))).toEqual(keys(awardsFor(input)));
    const evaluated = AWARD_TRACKS.map((t) => evaluate(t, input));
    expect(keys(sortAwards(evaluated))).toEqual(keys(sortAwards([...evaluated].reverse())));
  });

  it('returns all twenty however it is ordered', () => {
    expect(awardsFor(NOTHING)).toHaveLength(20);
    expect(awardsFor(facts({ watched: many(200), rankings: ranked(400) }))).toHaveLength(20);
  });
});

describe('a track whose number could not be read', () => {
  const missing = (field: keyof AwardFacts) =>
    facts({ unavailable: new Set<keyof AwardFacts>([field]) });

  it('says so rather than drawing a zero', () => {
    const result = award('mutual-mania', missing('mutualFollows'));
    expect(result.unavailable).toBe(true);
    expect(result.detailLine).toBe('Could not load this one');
    expect(result.countLabel).toBe('—');
    expect(result.fraction).toBe(0);
  });

  it('costs only the tracks that needed that field', () => {
    const input = facts({ watched: many(60), unavailable: new Set<keyof AwardFacts>(['mutualFollows']) });
    const list = awardsFor(input);
    expect(unavailableCount(list)).toBe(1);
    expect(list.find((a) => a.trackKey === 'movie-muncher')?.earnedTier?.label).toBe('Bronze');
  });

  it('takes every track that field feeds, and none when it feeds none', () => {
    expect(unavailableCount(awardsFor(facts({ unavailable: new Set(['watched']) })))).toBe(13);
    expect(unavailableCount(awardsFor(NOTHING))).toBe(0);
  });

  it('sinks to the bottom, below even a track sitting at zero', () => {
    const list = awardsFor(
      facts({ watched: many(60), unavailable: new Set<keyof AwardFacts>(['rankings']) }),
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
    const valid = new Set(AWARD_TRACKS.flatMap((t) => t.tiers.map((tier) => `${t.key}-${tier.key}`)));
    expect(Object.keys(BADGES).filter((key) => !valid.has(key))).toEqual([]);
  });

  it('falls back to a medal rather than to nothing', () => {
    expect(badgeFor('no-such-track', 'no-such-tier')).toEqual({ kind: 'emoji', emoji: '🏅' });
  });

  it('stands ten tracks in with an emoji rather than leaving a hole', () => {
    const placeholders = Object.entries(BADGES).filter(([, badge]) => badge.kind === 'emoji');
    expect(placeholders).toHaveLength(30);
  });
});

describe('the genre vocabulary', () => {
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
    expect([...canonicalGenres(null)]).toEqual([]);
  });

  it('uses the same vocabulary in the award and in its breakdown', () => {
    // Genre Gremlin's sheet must not list a genre the evaluator would not count, or the
    // row count and the numerator part company.
    const input = facts({
      watched: [title({ genres: ['drama film', 'huis-clos film', 'trial film'] })],
    });
    const { rows, progress } = rowsFor('genre-gremlin', input);
    expect(rows.map((row) => row.label)).toEqual(['Drama']);
    expect(progress.value).toBe(1);
  });
});

describe('a track the viewer is not entitled to read', () => {
  const withheld = facts({
    watched: many(60),
    withheld: new Set<keyof AwardFacts>(['recommendationsSent', 'invitedSignups']),
  });

  it('states the boundary rather than a zero or an apology', () => {
    const result = award('hype-courier', withheld);
    expect(result.unavailable).toBe(true);
    expect(result.withheld).toBe(true);
    expect(result.detailLine).toBe('Only they can see this one');
    expect(result.countLabel).toBe('—');
    expect(result.fraction).toBe(0);
  });

  it('is not the failure state: a failed read still apologises', () => {
    const failed = award(
      'hype-courier',
      facts({ unavailable: new Set<keyof AwardFacts>(['recommendationsSent']) }),
    );
    expect(failed.withheld).toBe(false);
    expect(failed.detailLine).toBe('Could not load this one');
  });

  it('costs exactly the two-party tracks and none of the countable ones', () => {
    const list = awardsFor(withheld);
    expect(list.filter((a) => a.withheld).map((a) => a.trackKey).sort()).toEqual([
      'hype-courier',
      'invite-instigator',
    ]);
    expect(list.find((a) => a.trackKey === 'movie-muncher')?.earnedTier?.label).toBe('Bronze');
  });

  it('keeps a withheld pinned track pinned, like an unavailable one', () => {
    const list = awardsFor(withheld);
    expect(list[2]?.trackKey).toBe('invite-instigator');
  });
});
