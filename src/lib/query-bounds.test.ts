import { QueryObserver } from '@tanstack/react-query';

import { createQueryClient } from './query';
import { RequestDeadlineError } from './supabase';

/**
 * What a request that ran out of time does to the screen waiting on it.
 *
 * **The half of the build-4 stall that lives above the network.** With no deadline, a
 * query whose request never answered stayed `pending` for the life of the process — and
 * `pending` is what the collection skeletons and the profile's em dashes are drawn for.
 * There is no screen state for "this will never arrive", so the screens correctly went on
 * saying "coming". Every "Try again" in this app is behind `isError`, and `isError` was
 * unreachable.
 *
 * These pin the shape of the recovery once a request can fail: the query leaves loading,
 * it stops rather than retrying forever, and a retry is a fresh attempt rather than a
 * replay of the failure.
 */

const deadline = () => new RequestDeadlineError(10_000);

/** Watches one query the way a mounted screen does, and records what it was told. */
function observe(
  client: ReturnType<typeof createQueryClient>,
  key: readonly unknown[],
  queryFn: () => Promise<unknown>,
) {
  const observer = new QueryObserver(client, { queryKey: key, queryFn });
  const seen: { status: string; fetchStatus: string }[] = [];
  const stop = observer.subscribe((result) => {
    seen.push({ status: result.status, fetchStatus: result.fetchStatus });
  });
  return { observer, seen, stop };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('a query whose request ran out of time', () => {
  /**
   * It leaves `pending`. That is the whole difference between a screen that offers
   * "Try again" and a screen that shows a skeleton until the app is killed.
   */
  it('becomes an error the screen can draw', async () => {
    const client = createQueryClient();
    const queryFn = jest.fn().mockRejectedValue(deadline());
    const { observer, stop } = observe(client, ['collection', 'u'], queryFn);

    const settled = observer.refetch();
    await jest.advanceTimersByTimeAsync(60_000);
    await settled;

    expect(observer.getCurrentResult().status).toBe('error');
    expect(observer.getCurrentResult().fetchStatus).toBe('idle');
    expect(observer.getCurrentResult().error).toBeInstanceOf(RequestDeadlineError);
    stop();
  });

  /**
   * **And it stops.** A phone with five mounted tabs and no upper bound on attempts is a
   * request storm and a warm handset; `retry: 2` is three attempts in total and then
   * quiescence, which is the property that matters more than the number.
   */
  it('stops after a bounded number of attempts', async () => {
    const client = createQueryClient();
    const queryFn = jest.fn().mockRejectedValue(deadline());
    const { observer, stop } = observe(client, ['collection', 'u'], queryFn);

    const settled = observer.refetch();
    await jest.advanceTimersByTimeAsync(60_000);
    await settled;

    expect(queryFn).toHaveBeenCalledTimes(3);

    // And nothing wakes it up again on its own.
    await jest.advanceTimersByTimeAsync(300_000);
    expect(queryFn).toHaveBeenCalledTimes(3);
    stop();
  });

  /** "Try again" has to actually ask again, rather than re-serving the failure. */
  it('makes a fresh attempt when the reader retries', async () => {
    const client = createQueryClient();
    const queryFn = jest.fn().mockRejectedValue(deadline());
    const { observer, stop } = observe(client, ['collection', 'u'], queryFn);

    const failed = observer.refetch();
    await jest.advanceTimersByTimeAsync(60_000);
    await failed;
    const afterFirst = queryFn.mock.calls.length;

    queryFn.mockResolvedValue([{ id: 'a' }]);
    const again = observer.refetch();
    await jest.advanceTimersByTimeAsync(60_000);
    await again;

    expect(queryFn.mock.calls.length).toBeGreaterThan(afterFirst);
    expect(observer.getCurrentResult().status).toBe('success');
    stop();
  });

  /**
   * **Five tabs are not five requests.** Every screen that reads the same thing reads it
   * under the same key, and React Query collapses concurrent observers of one key onto one
   * in-flight request — so a broken backend costs one attempt per key, not one per screen.
   * Worth pinning rather than assuming, because the keys are what make it true and the keys
   * are hand-written (`queryKeys`).
   */
  it('is one request however many screens are watching it', async () => {
    const client = createQueryClient();
    const queryFn = jest.fn().mockRejectedValue(deadline());

    const watchers = Array.from({ length: 5 }, () =>
      observe(client, ['collection', 'u'], queryFn),
    );
    const settled = Promise.all(watchers.map((w) => w.observer.refetch()));
    await jest.advanceTimersByTimeAsync(60_000);
    await settled;

    // Three attempts in total, not fifteen.
    expect(queryFn).toHaveBeenCalledTimes(3);
    watchers.forEach((w) => w.stop());
  });
});
