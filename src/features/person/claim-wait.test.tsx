import { act, waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { usePerson } from './use-person';

/**
 * The wait on somebody else's claim, at the level the bound actually lives.
 *
 * Independent review 13b found the defect and 13c found that the screen tests could
 * not tell the broken implementation from the fixed one — both fairly. The property is
 * a property of the hook, and the screen tests were asserting it through two layers of
 * rendering that obscured which bound had fired.
 *
 * The failure being pinned: React Query keeps the last successful `data` when a
 * refetch fails, so a claim observed once goes on reading as claimed for as long as
 * the reads keep failing. Nothing in the data ever changes its mind, which is why the
 * bound cannot come from the data.
 */

const tableRows: Record<string, unknown[]> = {};
let mockFailAfter = Number.POSITIVE_INFINITY;
let mockReads = 0;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: () => {
          mockReads += 1;
          return mockReads > mockFailAfter
            ? Promise.resolve({ data: null, error: { message: 'network down' } })
            : Promise.resolve({ data: tableRows.person_cache?.[0] ?? null, error: null });
        },
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('@/lib/tmdb-adapter', () => ({ cachePerson: () => Promise.resolve({}) }));

const claim = {
  expires_at: new Date(Date.now() + 120_000).toISOString(),
  payload: { claimed_at: new Date().toISOString() },
};

beforeEach(() => {
  mockReads = 0;
  mockFailAfter = Number.POSITIVE_INFINITY;
  tableRows.person_cache = [claim];
});

describe('waiting on somebody else’s claim', () => {
  it('waits while the reads are answering', async () => {
    const { result } = await renderHookWithProviders(() => usePerson('6193'));

    await waitFor(() => expect(result.current.data?.claimed).toBe(true));
    expect(result.current.awaitingClaim).toBe(true);
  });

  it('polls, because nothing invalidates this query on the loser’s behalf', async () => {
    await renderHookWithProviders(() => usePerson('6193'));

    await waitFor(() => expect(mockReads).toBeGreaterThan(1), { timeout: 6000 });
  });

  it('stops waiting once the reads stop answering', async () => {
    // The 13b defect exactly. `data` still says claimed and always will, because the
    // read that would say otherwise is the one that is failing. Three failures end it.
    mockFailAfter = 1;
    const { result } = await renderHookWithProviders(() => usePerson('6193'));

    await waitFor(() => expect(result.current.data?.claimed).toBe(true));
    await waitFor(() => expect(result.current.awaitingClaim).toBe(false), { timeout: 12_000 });

    // And the data still insists it is claimed, which is what makes this a bound the
    // data could never have provided.
    expect(result.current.data?.claimed).toBe(true);
  });

  it('stops polling with it, rather than asking a database that is not answering', async () => {
    mockFailAfter = 1;
    const { result } = await renderHookWithProviders(() => usePerson('6193'));

    await waitFor(() => expect(result.current.awaitingClaim).toBe(false), { timeout: 12_000 });
    // Longer than one poll interval, so a request already scheduled when the wait
    // ended has landed before the measurement starts. What is being asserted is that
    // no *new* ones are scheduled, not that an in-flight one is cancelled.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const settled = mockReads;
    await new Promise((resolve) => setTimeout(resolve, 3200));

    // Two further poll intervals with nothing asked.
    expect(mockReads).toBe(settled);
  });

  it('stops waiting after thirty seconds even while the reads keep answering', async () => {
    // The Review 13c finding, and the one bound the two error tests above cannot
    // reach: every read succeeds, every read returns the same live claim, and the
    // winner simply never writes. Nothing in the data will ever change its mind, so
    // the only thing that can end this is a clock — and it has to be a *local* one,
    // because comparing the database's `expires_at` against `Date.now()` on the
    // device is a comparison a skewed clock gets wrong in the dangerous direction.
    //
    // Fake timers, because the bound is thirty seconds of wall time and the whole
    // assertion is that it arrives. At hook level there is no component tree to fight
    // and the microtask flushes are explicit.
    jest.useFakeTimers();
    try {
      const { result } = await renderHookWithProviders(() => usePerson('6193'));

      // React Query's notify manager batches through `setTimeout(fn, 0)`, so under
      // fake timers the first read does not land until the clock is nudged. A few
      // alternating nudges and microtask drains is what settles it.
      for (let i = 0; i < 6; i += 1) {
        await act(async () => {
          jest.advanceTimersByTime(1);
          await Promise.resolve();
        });
      }

      expect(result.current.data?.claimed).toBe(true);
      expect(result.current.awaitingClaim).toBe(true);

      await act(async () => {
        jest.advanceTimersByTime(31_000);
        await Promise.resolve();
      });

      expect(result.current.awaitingClaim).toBe(false);
      // And the data still insists it is claimed, and no read ever failed — which is
      // what makes this a bound neither the payload nor the error state could give.
      expect(result.current.data?.claimed).toBe(true);
      expect(result.current.isError).toBe(false);

      const settled = mockReads;
      await act(async () => {
        jest.advanceTimersByTime(10_000);
        await Promise.resolve();
      });
      expect(mockReads).toBe(settled);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not wait at all on a claim that has already lapsed', async () => {
    tableRows.person_cache = [{ ...claim, expires_at: new Date(Date.now() - 1000).toISOString() }];
    const { result } = await renderHookWithProviders(() => usePerson('6193'));

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.claimed).toBe(false);
    expect(result.current.awaitingClaim).toBe(false);
  });
});
