import { HOLD_CEILING_MS, holdUntilRankingOpens, releaseRankingHold } from './open-first';

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
