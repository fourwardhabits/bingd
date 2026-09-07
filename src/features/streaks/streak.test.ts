import {
  daysLeftInWeek,
  streakAdvanced,
  weeklyStreak,
  weekKey,
  weekStart,
  type WeeklyStreak,
} from './streak';

/**
 * The weekly ranking streak, which is derived and stores nothing.
 *
 * Every case here is expressed in local time on purpose, because the boundary *is* local
 * — "I ranked something on Sunday night" has to count for that week, and under UTC it
 * would not for anybody west of Greenwich. `new Date(y, m, d, h)` is the local
 * constructor; an ISO string with a `Z` would be testing a different rule.
 */

/** Local, so the fixtures read as the wall clock a reader would describe. */
const at = (year: number, month: number, day: number, hour = 12) =>
  new Date(year, month - 1, day, hour);

// 2026-09-06 is a Sunday; the Monday that starts its week is 2026-08-31.
const SUNDAY = at(2026, 9, 6);
const MONDAY = at(2026, 8, 31);

describe('which week a moment belongs to', () => {
  it('starts the week on Monday', () => {
    expect(weekStart(MONDAY).getDay()).toBe(1);
    expect(weekKey(MONDAY)).toBe('2026-08-31');
  });

  it('keeps Sunday in the week that began the Monday before it', () => {
    // The off-by-one this exists to prevent: `getDay()` calls Sunday 0, so a naive
    // subtraction sends it forward into the next week instead of back into its own.
    expect(weekKey(SUNDAY)).toBe('2026-08-31');
  });

  it('puts Monday and the following Sunday in the same week', () => {
    expect(weekKey(MONDAY)).toBe(weekKey(SUNDAY));
  });

  it('puts a Monday and the Sunday before it in different weeks', () => {
    expect(weekKey(at(2026, 8, 30))).not.toBe(weekKey(MONDAY));
  });

  it('ignores the time of day', () => {
    expect(weekKey(at(2026, 9, 6, 0))).toBe(weekKey(at(2026, 9, 6, 23)));
  });

  it('pads the key, so weeks sort as strings', () => {
    // `longestRun` sorts these. An unpadded month would put October before September.
    expect(weekKey(at(2026, 1, 5))).toBe('2026-01-05');
  });
});

describe('a reader who has never ranked anything', () => {
  it('has no streak and no history', () => {
    expect(weeklyStreak([], SUNDAY)).toEqual({
      weeks: 0,
      rankedThisWeek: false,
      best: 0,
      hasHistory: false,
    });
  });
});

describe('this week', () => {
  it('counts as soon as it has one ranking', () => {
    const streak = weeklyStreak([at(2026, 9, 2)], SUNDAY);

    expect(streak.rankedThisWeek).toBe(true);
    expect(streak.weeks).toBe(1);
  });

  it('counts a ranking made today', () => {
    expect(weeklyStreak([SUNDAY], SUNDAY).rankedThisWeek).toBe(true);
  });

  it('counts several rankings in one week once', () => {
    const streak = weeklyStreak([at(2026, 9, 1), at(2026, 9, 2), at(2026, 9, 3)], SUNDAY);

    expect(streak.weeks).toBe(1);
  });
});

describe('an unfinished week is not a broken one', () => {
  /**
   * The grace, and the whole reason the count starts at last week when this week is
   * empty. Zeroing a streak on Monday morning tells somebody they have lost something
   * they still have five days to keep — which is the behaviour that makes streaks feel
   * punitive rather than encouraging.
   */
  it('keeps the streak while this week is still open', () => {
    const weeks = [at(2026, 8, 25), at(2026, 8, 18), at(2026, 8, 11)];
    const streak = weeklyStreak(weeks, SUNDAY);

    expect(streak.rankedThisWeek).toBe(false);
    expect(streak.weeks).toBe(3);
  });

  it('extends rather than restarts when this week finally gets one', () => {
    const history = [at(2026, 8, 25), at(2026, 8, 18), at(2026, 8, 11)];

    expect(weeklyStreak([...history, at(2026, 9, 2)], SUNDAY).weeks).toBe(4);
  });

  it('is over once a whole week passed with nothing in it', () => {
    // Nothing this week and nothing last week: the streak ended, and the run before it
    // is history rather than a current streak.
    const streak = weeklyStreak([at(2026, 8, 18), at(2026, 8, 11)], SUNDAY);

    expect(streak.weeks).toBe(0);
    expect(streak.best).toBe(2);
  });
});

describe('consecutive weeks', () => {
  it('counts an unbroken run back from now', () => {
    const weeks = [at(2026, 9, 1), at(2026, 8, 26), at(2026, 8, 19), at(2026, 8, 12)];

    expect(weeklyStreak(weeks, SUNDAY).weeks).toBe(4);
  });

  it('stops at the first gap rather than counting every active week', () => {
    // A streak is consecutive weeks, not a lifetime total. The 2025 rows are real
    // activity and are not part of this run.
    const weeks = [at(2026, 9, 1), at(2026, 8, 26), at(2025, 5, 1), at(2025, 4, 24)];

    expect(weeklyStreak(weeks, SUNDAY).weeks).toBe(2);
  });

  it('counts a run that crosses a year boundary', () => {
    const now = at(2026, 1, 8);
    const weeks = [at(2026, 1, 6), at(2025, 12, 30), at(2025, 12, 23)];

    expect(weeklyStreak(weeks, now).weeks).toBe(3);
  });
});

describe('the best run', () => {
  it('is the longest ever, not the current one', () => {
    const weeks = [
      // A run of one, now.
      at(2026, 9, 1),
      // A run of three, last spring.
      at(2026, 4, 1),
      at(2026, 3, 25),
      at(2026, 3, 18),
    ];
    const streak = weeklyStreak(weeks, SUNDAY);

    expect(streak.weeks).toBe(1);
    expect(streak.best).toBe(3);
  });

  it('is one for a single lonely week', () => {
    expect(weeklyStreak([at(2025, 1, 8)], SUNDAY).best).toBe(1);
  });

  it('equals the current streak when the current one is the longest', () => {
    const weeks = [at(2026, 9, 1), at(2026, 8, 26), at(2026, 8, 19)];
    const streak = weeklyStreak(weeks, SUNDAY);

    expect(streak.best).toBe(streak.weeks);
  });
});

describe('rows that are not usable', () => {
  it('drops a timestamp that will not parse rather than counting it as the epoch', () => {
    // The epoch would anchor a phantom "best run" in 1970 and, worse, a phantom gap.
    const streak = weeklyStreak(['not a date', at(2026, 9, 1)], SUNDAY);

    expect(streak.weeks).toBe(1);
    expect(streak.best).toBe(1);
  });

  it('accepts ISO strings, which is what the database returns', () => {
    const iso = at(2026, 9, 1).toISOString();

    expect(weeklyStreak([iso], SUNDAY).weeks).toBe(1);
  });
});

describe('how long is left', () => {
  it('gives a whole week on Monday and one day on Sunday', () => {
    expect(daysLeftInWeek(MONDAY)).toBe(7);
    expect(daysLeftInWeek(SUNDAY)).toBe(1);
  });

  it('never says zero on a day somebody can still act', () => {
    for (let day = 31; day <= 37; day += 1) {
      expect(daysLeftInWeek(at(2026, 8, day))).toBeGreaterThan(0);
    }
  });
});

describe('when a ranking advances the streak', () => {
  /**
   * **Only the first ranking of a new qualifying week**, and only from week two.
   *
   * A streak advances once per week, so celebrating every ranking would celebrate the
   * same fact five times on a busy Sunday — and it is the advance that is the
   * achievement, not the ranking. A first week is a streak of one, which is somebody
   * having used the app rather than a run; spending the mechanic's one moment on it is
   * how a reward becomes noise.
   */
  const state = (over: Partial<WeeklyStreak> = {}): WeeklyStreak => ({
    weeks: 0,
    rankedThisWeek: false,
    best: 0,
    hasHistory: true,
    ...over,
  });

  it('celebrates the first ranking of the second week', () => {
    const before = state({ weeks: 1, rankedThisWeek: false, best: 1 });
    const after = state({ weeks: 2, rankedThisWeek: true, best: 2 });

    expect(streakAdvanced(before, after)).toBe(2);
  });

  it('says nothing on the very first week, because one week is not a streak', () => {
    const before = state({ weeks: 0, hasHistory: false });
    const after = state({ weeks: 1, rankedThisWeek: true, best: 1 });

    expect(streakAdvanced(before, after)).toBeNull();
  });

  it('says nothing for the second ranking of the same week', () => {
    // The week was already safe, so this ranking advanced nothing.
    const before = state({ weeks: 4, rankedThisWeek: true, best: 4 });
    const after = state({ weeks: 4, rankedThisWeek: true, best: 4 });

    expect(streakAdvanced(before, after)).toBeNull();
  });

  it('says nothing when the ranking did not land in this week at all', () => {
    const before = state({ weeks: 3, rankedThisWeek: false, best: 3 });
    const after = state({ weeks: 3, rankedThisWeek: false, best: 3 });

    expect(streakAdvanced(before, after)).toBeNull();
  });

  it('celebrates a run restarted after a gap once it reaches two', () => {
    const before = state({ weeks: 1, rankedThisWeek: false, best: 6 });
    const after = state({ weeks: 2, rankedThisWeek: true, best: 6 });

    expect(streakAdvanced(before, after)).toBe(2);
  });

  it('reports the run’s length, which is what the card says', () => {
    const before = state({ weeks: 8, rankedThisWeek: false, best: 8 });
    const after = state({ weeks: 9, rankedThisWeek: true, best: 9 });

    expect(streakAdvanced(before, after)).toBe(9);
  });
});
