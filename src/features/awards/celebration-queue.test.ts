import {
  celebrationParams,
  clearCelebrations,
  enqueueCelebrations,
  hasCelebrations,
  takeCelebrations,
} from './celebration-queue';

/**
 * The queue that made the celebration actually happen.
 *
 * **The defect it exists for.** The celebration shipped attached to one exit — the
 * ranking reveal's Done — and the founder physically ranked something, earned an award,
 * and never saw it. Ranking has three exits, and *Add details* continues into the log
 * sheet: a reader who takes it finishes somewhere `RankingSheet` no longer exists to
 * notice, so the payoff was held by a component that had already unmounted.
 *
 * A module-level queue is what survives that. Detection enqueues; whichever surface the
 * reader actually finishes on drains it.
 */

beforeEach(() => clearCelebrations());

describe('the queue', () => {
  it('is empty until something is earned', () => {
    expect(hasCelebrations()).toBe(false);
    expect(takeCelebrations()).toEqual([]);
  });

  it('holds what a ranking earned until somebody takes it', () => {
    enqueueCelebrations([{ kind: 'award', awardKey: 'lol-mode', tierKey: 'giggle' }]);

    expect(hasCelebrations()).toBe(true);
    expect(takeCelebrations()).toEqual([
      { kind: 'award', awardKey: 'lol-mode', tierKey: 'giggle' },
    ]);
  });

  it('empties on the take, so two exits cannot show the same thing twice', () => {
    // The ranking sheet hands off to the log sheet and both are places a reader can
    // finish. Whichever drains first is the one that shows it.
    enqueueCelebrations([{ kind: 'award', awardKey: 'lol-mode', tierKey: 'giggle' }]);

    expect(takeCelebrations()).toHaveLength(1);
    expect(takeCelebrations()).toEqual([]);
  });

  it('ignores an award already waiting', () => {
    // Two detections of one crossing — a retry, or both halves of a hand-off enqueueing
    // — must not become two pages about the same award.
    enqueueCelebrations([{ kind: 'award', awardKey: 'lol-mode', tierKey: 'giggle' }]);
    enqueueCelebrations([{ kind: 'award', awardKey: 'lol-mode', tierKey: 'giggle' }]);

    expect(takeCelebrations()).toHaveLength(1);
  });

  it('keeps several genuinely different awards', () => {
    // One ranking can cross a Movies threshold and a combined Movies-and-TV threshold in
    // the same breath — `_maybe_award_unlocks` loops over every named track.
    enqueueCelebrations([
      { kind: 'award', awardKey: 'movie-muncher', tierKey: 'bronze' },
      { kind: 'award', awardKey: 'two-screen-life', tierKey: 'tourist' },
    ]);

    expect(takeCelebrations()).toHaveLength(2);
  });

  it('holds at most one streak, because a streak is a state rather than an event', () => {
    enqueueCelebrations([{ kind: 'streak', weeks: 4 }]);
    enqueueCelebrations([{ kind: 'streak', weeks: 4 }]);

    expect(takeCelebrations()).toEqual([{ kind: 'streak', weeks: 4 }]);
  });

  it('keeps awards ahead of the streak', () => {
    // An award is the rarer event; the streak is the week's ordinary confirmation.
    enqueueCelebrations([
      { kind: 'award', awardKey: 'lol-mode', tierKey: 'giggle' },
      { kind: 'streak', weeks: 3 },
    ]);

    expect(takeCelebrations().map((item) => item.kind)).toEqual(['award', 'streak']);
  });
});

describe('the route parameters', () => {
  it('are null for an empty queue, so nothing navigates', () => {
    expect(celebrationParams([])).toBeNull();
  });

  it('send awards in exactly the shape the notification deep link already uses', () => {
    /**
     * `awards=lol-mode:giggle` is what `features/notifications/routing.ts` writes for an
     * `award_earned` row. Changing the shape here would strand every notification
     * already written, which is why the streak arrived as a second parameter rather than
     * being folded into this one.
     */
    expect(
      celebrationParams([
        { kind: 'award', awardKey: 'movie-muncher', tierKey: 'bronze' },
        { kind: 'award', awardKey: 'lol-mode', tierKey: 'giggle' },
      ]),
    ).toEqual({ awards: 'movie-muncher:bronze,lol-mode:giggle' });
  });

  it('send a streak alone when that is all there is', () => {
    expect(celebrationParams([{ kind: 'streak', weeks: 4 }])).toEqual({ streak: '4' });
  });

  it('send both when one ranking did both', () => {
    expect(
      celebrationParams([
        { kind: 'award', awardKey: 'lol-mode', tierKey: 'giggle' },
        { kind: 'streak', weeks: 4 },
      ]),
    ).toEqual({ awards: 'lol-mode:giggle', streak: '4' });
  });
});
