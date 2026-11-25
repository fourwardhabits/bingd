import {
  HOLD_CEILING_MS,
  holdUntilRankingOpens,
  keepRankingHoldThroughSession,
  releaseRankingHold,
  supersedeRankingHold,
} from './open-first';

/**
 * The post-log refresh waits for the ranking session's first answer (perf, 2026-11-24).
 * What matters is that it always runs, exactly once, and never before it is released or
 * the ceiling passes.
 */
describe('holdUntilRankingOpens', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    releaseRankingHold();
    jest.useRealTimers();
  });

  it('holds the task until the session answers', () => {
    const task = jest.fn();
    holdUntilRankingOpens(task);
    expect(task).not.toHaveBeenCalled();

    releaseRankingHold();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('runs it once, however many times the hold is released', () => {
    const task = jest.fn();
    holdUntilRankingOpens(task);
    releaseRankingHold();
    releaseRankingHold();
    jest.advanceTimersByTime(HOLD_CEILING_MS * 2);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('never drops it: with no sheet to release it, the ceiling does', () => {
    const task = jest.fn();
    holdUntilRankingOpens(task);
    jest.advanceTimersByTime(HOLD_CEILING_MS - 1);
    expect(task).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('keeps running the rest when one task throws', () => {
    const after = jest.fn();
    holdUntilRankingOpens(() => {
      throw new Error('refresh failed');
    });
    holdUntilRankingOpens(after);
    expect(() => releaseRankingHold()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });
});

/**
 * Perf P4 (2026-11-25): a hold that names its title is kept through that title's session,
 * superseded by its placement, and otherwise run in full — exactly once either way.
 */
describe('a hold kept through its session', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    releaseRankingHold();
    jest.useRealTimers();
  });

  const session = {};
  const owned = (mediaItemId = 'film-a') => {
    const task = jest.fn();
    const remainder = jest.fn();
    holdUntilRankingOpens(task, { mediaItemId, supersededBy: remainder });
    return { task, remainder };
  };

  it('outlives the ceiling once its session has taken it', () => {
    const { task } = owned();
    keepRankingHoldThroughSession('film-a', session);
    jest.advanceTimersByTime(HOLD_CEILING_MS * 10);
    expect(task).not.toHaveBeenCalled();

    releaseRankingHold();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('still has the ceiling before any session takes it', () => {
    const { task, remainder } = owned();
    jest.advanceTimersByTime(HOLD_CEILING_MS);
    expect(task).toHaveBeenCalledTimes(1);

    // A session that turns up late finds nothing to keep or supersede.
    keepRankingHoldThroughSession('film-a', session);
    supersedeRankingHold('film-a', 'movies');
    releaseRankingHold();
    expect(task).toHaveBeenCalledTimes(1);
    expect(remainder).not.toHaveBeenCalled();
  });

  it('is replaced by its remainder when its title places, and never runs after', () => {
    const { task, remainder } = owned();
    keepRankingHoldThroughSession('film-a', session);
    supersedeRankingHold('film-a', 'tv_seasons');
    expect(remainder).toHaveBeenCalledTimes(1);
    expect(remainder).toHaveBeenCalledWith('tv_seasons');

    supersedeRankingHold('film-a', 'tv_seasons');
    releaseRankingHold();
    jest.advanceTimersByTime(HOLD_CEILING_MS * 2);
    expect(task).not.toHaveBeenCalled();
    expect(remainder).toHaveBeenCalledTimes(1);
  });

  it('is superseded by a placement that came before the session was kept (an empty band)', () => {
    const { task, remainder } = owned();
    supersedeRankingHold('film-a', 'movies');
    jest.advanceTimersByTime(HOLD_CEILING_MS * 2);
    releaseRankingHold();
    expect(task).not.toHaveBeenCalled();
    expect(remainder).toHaveBeenCalledTimes(1);
  });

  it('is not kept or superseded by another title’s session, which lets it go as before', () => {
    const mine = owned('film-a');
    const unowned = jest.fn();
    holdUntilRankingOpens(unowned);

    keepRankingHoldThroughSession('film-z', session);
    expect(mine.task).toHaveBeenCalledTimes(1);
    expect(unowned).toHaveBeenCalledTimes(1);

    supersedeRankingHold('film-z', 'movies');
    expect(mine.remainder).not.toHaveBeenCalled();
  });

  it('keeps only its own title when several are held', () => {
    const mine = owned('film-a');
    const other = owned('film-b');
    keepRankingHoldThroughSession('film-a', session);
    expect(other.task).toHaveBeenCalledTimes(1);
    expect(mine.task).not.toHaveBeenCalled();

    supersedeRankingHold('film-a', 'movies');
    expect(mine.remainder).toHaveBeenCalledTimes(1);
    expect(other.remainder).not.toHaveBeenCalled();
  });

  it('is let go only by the session that kept it (Codex review, PR 387)', () => {
    const abandoned = {};
    const newer = {};
    const mine = owned('film-a');
    keepRankingHoldThroughSession('film-a', newer);

    // An opening abandoned earlier, whose answer lands now, lets go of nothing it did not take.
    releaseRankingHold(abandoned);
    expect(mine.task).not.toHaveBeenCalled();
    // Nor does it take a hold another session already has.
    keepRankingHoldThroughSession('film-a', abandoned);
    releaseRankingHold(abandoned);
    expect(mine.task).not.toHaveBeenCalled();

    releaseRankingHold(newer);
    expect(mine.task).toHaveBeenCalledTimes(1);
  });

  it('lets a session go of holds nobody has taken, as before', () => {
    const unowned = jest.fn();
    holdUntilRankingOpens(unowned);
    releaseRankingHold(session);
    expect(unowned).toHaveBeenCalledTimes(1);
  });

  it('keeps going when a remainder throws', () => {
    holdUntilRankingOpens(jest.fn(), {
      mediaItemId: 'film-a',
      supersededBy: () => {
        throw new Error('refresh failed');
      },
    });
    const after = owned('film-a');
    expect(() => supersedeRankingHold('film-a', 'movies')).not.toThrow();
    expect(after.remainder).toHaveBeenCalledTimes(1);
  });
});
