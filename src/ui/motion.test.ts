import { act, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { useReducedMotionState } from './motion';

/**
 * **Who gets to answer, in what order, and what happens when nobody does.**
 *
 * `useReducedMotionState` exists because "not asked yet" and "no" are the same value, and
 * a one-shot animation that starts on mount cannot tell them apart. Every defect this
 * hook has had was an ordering defect between its three sources — the asynchronous initial
 * read, the system event, and the timeout that exists so an unanswered platform still
 * shows something — and each one was found by an independent reviewer rather than by a
 * test, which is why they are all pinned here now.
 *
 * The stakes are concrete: this gates the ranking reveal's entrance. Getting it wrong in
 * one direction shows motion to somebody who asked for stillness; getting it wrong in the
 * other leaves the score panel at opacity 0 for ever, which is a blank reveal at the end
 * of the ritual the whole product is built on.
 */

/** Resolves when the test says so, so an interleaving can be built deliberately. */
const deferred = () => {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

let notify: ((reduced: boolean) => void) | undefined;

/**
 * Watches for the hook's own fallback timer and whether it was cancelled.
 *
 * Keyed on the 250ms delay, which is the only timer this hook arms. `jest.getTimerCount()`
 * cannot answer this: under fake timers it also counts React Query's and `waitFor`'s, so
 * it is never zero in a rendered test.
 */
const trackTimers = () => {
  const armed: unknown[] = [];
  const cleared: unknown[] = [];
  const realSetTimeout = globalThis.setTimeout;

  jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: TimerHandler,
    delay?: number,
    ...rest: unknown[]
  ) => {
    const handle = (realSetTimeout as never as (...a: unknown[]) => unknown)(
      handler,
      delay,
      ...rest,
    );
    if (delay === 250) armed.push(handle);
    return handle;
  }) as never);

  jest.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: unknown) => {
    cleared.push(handle);
  }) as never);

  return {
    fallbackCleared: () =>
      armed.length > 0 && armed.every((handle) => cleared.includes(handle)),
  };
};

beforeEach(() => {
  jest.useFakeTimers();
  notify = undefined;
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation((_event, handler) => {
    notify = handler as unknown as (reduced: boolean) => void;
    return { remove: jest.fn() } as never;
  });
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('who answers first', () => {
  it('reports nothing known until somebody has answered', async () => {
    // The whole point of the hook. A caller that treats the initial `false` as an answer
    // is the defect this shape exists to make impossible.
    const pending = deferred();
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(pending.promise);

    const { result } = await renderHookWithProviders(() => useReducedMotionState());

    expect(result.current).toEqual({ reduced: false, known: false });
  });

  it('takes the initial read when it arrives', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);

    const { result } = await renderHookWithProviders(() => useReducedMotionState());

    await waitFor(() => expect(result.current).toEqual({ reduced: true, known: true }));
  });

  it('treats a platform that cannot answer as having no preference', async () => {
    // A rejection is not an error state to sit in: it means there is nothing to honour.
    jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockRejectedValue(new Error('unsupported'));

    const { result } = await renderHookWithProviders(() => useReducedMotionState());

    await waitFor(() => expect(result.current).toEqual({ reduced: false, known: true }));
  });

  it('lets a system event overrule an initial read that has not landed', async () => {
    /**
     * **Independent review 78b's P1, in both halves.** The event is the fresher answer, so
     * it must both take effect *and* mark the preference known — the first version set
     * only the value, leaving a screen that mounted mid-read gated for ever. And the older
     * read must not then overwrite it: an event saying `true` followed by a read resolving
     * `false` turned Reduce Motion back off and let the entrance run.
     */
    const pending = deferred();
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(pending.promise);

    const { result } = await renderHookWithProviders(() => useReducedMotionState());

    await act(async () => {
      notify?.(true);
    });
    expect(result.current).toEqual({ reduced: true, known: true });

    // The stale read lands afterwards and is ignored.
    await act(async () => {
      pending.resolve(false);
      await Promise.resolve();
    });
    expect(result.current).toEqual({ reduced: true, known: true });
  });

  it('follows the setting when it changes later', async () => {
    // The reason this is subscribed to at all: somebody turning Reduce Motion on
    // mid-session is very likely doing so because of something they are looking at.
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);

    const { result } = await renderHookWithProviders(() => useReducedMotionState());
    await waitFor(() => expect(result.current.known).toBe(true));

    await act(async () => {
      notify?.(true);
    });

    expect(result.current.reduced).toBe(true);
  });
});

describe('when nobody answers at all', () => {
  it('releases the gate rather than leaving a one-shot invisible for ever', async () => {
    /**
     * A promise that never settles would leave the ranking reveal at opacity 0
     * permanently. After the fallback the preference is *known* — so the entrance can
     * play — while the value stays at its safe default.
     */
    const pending = deferred();
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(pending.promise);

    const { result } = await renderHookWithProviders(() => useReducedMotionState());
    expect(result.current.known).toBe(false);

    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    expect(result.current).toEqual({ reduced: false, known: true });
  });

  it('still accepts the real answer when it finally arrives', async () => {
    /**
     * **Independent review 78c's P1.** The fallback used to answer through the same path a
     * real read takes, which marked the read settled — so a genuine `true` arriving a
     * moment later was discarded, and a reader with Reduce Motion on stayed permanently
     * marked as not having it. The fallback now releases the gate and nothing else.
     *
     * On a slow platform that reader may see a fraction of an entrance before it snaps to
     * rest. That is the deliberate trade: worse than perfect, and much better than either
     * a blank panel for ever or a preference silently stuck at the wrong value.
     */
    const pending = deferred();
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(pending.promise);

    const { result } = await renderHookWithProviders(() => useReducedMotionState());

    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(result.current).toEqual({ reduced: false, known: true });

    await act(async () => {
      pending.resolve(true);
      await Promise.resolve();
    });

    expect(result.current).toEqual({ reduced: true, known: true });
  });

  it('cancels the fallback when the initial read answers', async () => {
    /**
     * One timer per hook instance, and this hook is used by every chip, tile and card on
     * screen — so a settled read must not leave a timer queued to do nothing.
     *
     * Asserted on the **specific handle** rather than on `clearTimeout` merely having
     * been called, which is independent review 78d's P2: the weaker version passed if
     * production cleared no handle or the wrong one. `jest.getTimerCount()` is not the
     * measure either — under fake timers it counts React Query's and `waitFor`'s own
     * timers, so it is never zero in a rendered test.
     */
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const timers = trackTimers();

    const { result } = await renderHookWithProviders(() => useReducedMotionState());
    await waitFor(() => expect(result.current.known).toBe(true));

    expect(timers.fallbackCleared()).toBe(true);
  });

  it('cancels the fallback when the event arrives synchronously from subscribing', async () => {
    /**
     * **The ordering half of review 78d's P2.** A platform that delivers the first event
     * synchronously from `addEventListener` answers before the timer would have been
     * created — so the timer must be armed *first*, or it is created after the answer and
     * sits for the full 250ms. The weaker version of this test could not see that,
     * because it only exercised the initial read.
     */
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(deferred().promise);
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation((_event, handler) => {
      (handler as unknown as (reduced: boolean) => void)(true);
      return { remove: jest.fn() } as never;
    });
    const timers = trackTimers();

    const { result } = await renderHookWithProviders(() => useReducedMotionState());

    await waitFor(() => expect(result.current).toEqual({ reduced: true, known: true }));
    expect(timers.fallbackCleared()).toBe(true);
  });
});
