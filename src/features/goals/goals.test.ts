import {
  countWatched,
  goalAchievement,
  goalCategoryOf,
  goalSentence,
  goalStatus,
  watchedInYear,
  yearRange,
  type CountableWatch,
} from './goals';

/**
 * What a yearly goal counts.
 *
 * Every test here is a way the number on the profile could be *higher* than the
 * user's own memory of their year, which is the only failure mode that matters: a
 * goal that overcounts is a goal that congratulates someone for films they did not
 * watch, and once seen it cannot be un-seen.
 */

const watch = (over: Partial<CountableWatch> = {}): CountableWatch => ({
  mediaItemId: 'film-1',
  kind: 'movie',
  watchedOn: '2026-06-01',
  ...over,
});

describe('the year boundary', () => {
  it('counts the first and last day of the year', () => {
    const rows = [
      watch({ mediaItemId: 'a', watchedOn: '2026-01-01' }),
      watch({ mediaItemId: 'b', watchedOn: '2026-12-31' }),
    ];

    expect(countWatched(rows, 2026).movies).toBe(2);
  });

  it('excludes the day either side', () => {
    const rows = [
      watch({ mediaItemId: 'a', watchedOn: '2025-12-31' }),
      watch({ mediaItemId: 'b', watchedOn: '2027-01-01' }),
    ];

    expect(countWatched(rows, 2026).movies).toBe(0);
  });

  it('does not move a date across midnight in any timezone', () => {
    // The bug this guards: `new Date('2026-01-01')` is midnight UTC, which is the
    // 31st of December west of Greenwich. Reading the year off the string has no
    // timezone in it at all, and this assertion holds under TZ=Pacific/Kiritimati
    // and TZ=Pacific/Midway alike.
    expect(watchedInYear('2026-01-01', 2026)).toBe(true);
    expect(watchedInYear('2026-12-31', 2026)).toBe(true);
    expect(watchedInYear('2025-12-31', 2026)).toBe(false);
  });

  it('asks the database for exactly that range', () => {
    expect(yearRange(2026)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
});

describe('an unknown watch date', () => {
  it('counts for nothing', () => {
    // Onboarding logs historical favourites with no watch date on purpose. If a
    // null date counted as "now", ranking five films from the nineties would put
    // five ticks against this year's goal.
    expect(countWatched([watch({ watchedOn: null })], 2026).movies).toBe(0);
  });

  it('counts for nothing when the value is not a date', () => {
    expect(countWatched([watch({ watchedOn: 'sometime' })], 2026).movies).toBe(0);
    expect(watchedInYear('2026', 2026)).toBe(false);
  });
});

describe('a rewatch', () => {
  it('counts once', () => {
    const rows = [
      watch({ mediaItemId: 'dune', watchedOn: '2026-02-01' }),
      watch({ mediaItemId: 'dune', watchedOn: '2026-09-14' }),
    ];

    expect(countWatched(rows, 2026).movies).toBe(1);
  });

  it('counts a season watched twice once', () => {
    const rows = [
      watch({ mediaItemId: 's1', kind: 'season', watchedOn: '2026-02-01' }),
      watch({ mediaItemId: 's1', kind: 'season', watchedOn: '2026-11-01' }),
    ];

    expect(countWatched(rows, 2026).tv_seasons).toBe(1);
  });

  it('still counts two different seasons of one show separately', () => {
    // The other direction of the same rule: distinctness is over the media item,
    // and a season is its own media item.
    const rows = [
      watch({ mediaItemId: 's1', kind: 'season' }),
      watch({ mediaItemId: 's2', kind: 'season' }),
    ];

    expect(countWatched(rows, 2026).tv_seasons).toBe(2);
  });
});

describe('what belongs to which goal', () => {
  it('never counts a series', () => {
    // A nine-season show logged as a series must not be one tick toward a seasons
    // goal, and must not be nine. It is not a rankable unit and it is not a goal
    // unit either — `rankable_category` returns null for exactly this reason.
    const rows = [watch({ mediaItemId: 'show', kind: 'series' })];
    const counts = countWatched(rows, 2026);

    expect(counts.movies).toBe(0);
    expect(counts.tv_seasons).toBe(0);
    expect(goalCategoryOf('series')).toBeNull();
  });

  it('keeps the two media apart', () => {
    const rows = [
      watch({ mediaItemId: 'film', kind: 'movie' }),
      watch({ mediaItemId: 'season', kind: 'season' }),
    ];

    expect(countWatched(rows, 2026)).toEqual({ movies: 1, tv_seasons: 1 });
  });

  it('reports zero for a medium with nothing in it, rather than omitting it', () => {
    // A goal of 52 with nothing watched has to render "0 of 52". An absent key
    // renders nothing at all.
    expect(countWatched([], 2026)).toEqual({ movies: 0, tv_seasons: 0 });
  });
});

describe('progress against a target', () => {
  it('reports what is left', () => {
    const status = goalStatus('movies', 52, 12);

    expect(status.remaining).toBe(40);
    expect(status.complete).toBe(false);
    expect(goalSentence(status)).toBe('12 of 52 movies');
  });

  it('does not report a negative remainder or an overflowing bar', () => {
    const status = goalStatus('movies', 10, 14);

    expect(status.remaining).toBe(0);
    expect(status.fraction).toBe(1);
    expect(status.complete).toBe(true);
    // The count itself is still the truth — 14 of 10, not 10 of 10.
    expect(goalSentence(status)).toBe('14 of 10 movies');
  });

  it('is complete on the nose', () => {
    expect(goalStatus('tv_seasons', 12, 12).complete).toBe(true);
  });

  it('says "season" rather than "seasons" for a goal of one', () => {
    expect(goalSentence(goalStatus('tv_seasons', 1, 0))).toBe('0 of 1 season');
  });
});

/**
 * **The second line of a finished goal** (founder, 2026-08-29).
 *
 * The feed row said `25 movies` and the inbox row said nothing at all — a fragment and a
 * blank, under a sentence that had already said "hit their 2026 Movies goal". The founder's
 * copy is a congratulation, and it is one function so that the two surfaces cannot quote
 * different numbers for one completion.
 */
describe('congratulating a finished goal', () => {
  it('names the medium in the noun, because the row is read out of context', () => {
    expect(goalAchievement('movies', 25)).toBe('Congrats on 25 movies');
    // "TV seasons" and not "seasons": a completion says its own sentence in a feed of
    // unrelated activity, where a bare "25 seasons" does not say seasons of what. And
    // never "tv" — TV keeps its capitals mid-sentence everywhere in this product.
    expect(goalAchievement('tv_seasons', 25)).toBe('Congrats on 25 TV seasons');
  });

  it('agrees with itself at one', () => {
    expect(goalAchievement('movies', 1)).toBe('Congrats on 1 movie');
    expect(goalAchievement('tv_seasons', 1)).toBe('Congrats on 1 TV season');
  });

  it('uses the number it is given rather than a frozen one', () => {
    // The target is the one the goal was *completed against* — `goal_completions` freezes
    // it and the feed event carries that frozen value — so editing a goal afterwards
    // does not rewrite what was celebrated.
    expect(goalAchievement('movies', 3)).toBe('Congrats on 3 movies');
    expect(goalAchievement('movies', 104)).toBe('Congrats on 104 movies');
  });
});
