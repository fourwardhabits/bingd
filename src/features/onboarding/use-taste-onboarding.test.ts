import { act, waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import {
  resetTasteIntent,
  useBeginTasteOnboarding,
  useCompleteTasteOnboarding,
  useTasteOnboarding,
} from './use-taste-onboarding';

const mockPrefs = new Map<string, unknown>();
const mockCounts: Record<string, number | null> = {};
const mockErrors: Record<string, unknown> = {};
/** Preference names whose read never settles, and tables whose select never does. */
const mockReadHangs = new Set<string>();
const mockTableHangs = new Set<string>();
/**
 * Tables whose select resolves only when the test says so.
 *
 * Distinct from `mockTableHangs`: a read that never settles leaves a mounted component
 * that cleanup cannot unwind, and the renderer stays broken for every test after it. A
 * gate lets a test open the window, act inside it, and then let the read finish.
 */
const mockTableGates: Record<string, Promise<void> | undefined> = {};
/** How many PostgREST reads this check issued — the cold-start cost, counted. */
const mockRequests: Record<string, number> = {};

jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) =>
    mockReadHangs.has(name)
      ? new Promise(() => {})
      : Promise.resolve(mockPrefs.get(name) ?? null),
  // Records, rather than resolving into nothing: what the device *keeps* is half of
  // what these tests are about, and a write that goes nowhere cannot show it.
  writePref: (name: string, value: unknown) => {
    mockPrefs.set(name, value);
    return Promise.resolve();
  },
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      mockRequests[table] = (mockRequests[table] ?? 0) + 1;
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        then: (resolve: (value: unknown) => unknown) => {
          if (mockTableHangs.has(table)) return new Promise(() => {});
          const answer = () =>
            resolve({
              data: null,
              error: mockErrors[table] ?? null,
              count: mockCounts[table] ?? 0,
            });
          const gate = mockTableGates[table];
          return gate ? gate.then(answer) : answer();
        },
      });
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

beforeEach(() => {
  mockPrefs.clear();
  for (const key of Object.keys(mockCounts)) delete mockCounts[key];
  for (const key of Object.keys(mockErrors)) delete mockErrors[key];
  mockCounts.rankings = 0;
  mockCounts.user_media = 0;
  mockReadHangs.clear();
  mockTableHangs.clear();
  for (const key of Object.keys(mockTableGates)) delete mockTableGates[key];
  for (const key of Object.keys(mockRequests)) delete mockRequests[key];
  resetTasteIntent();
});

const read = async () => {
  const { result } = await renderHookWithProviders(() => useTasteOnboarding('user-1'));
  await waitFor(() => expect(result.current.isPending).toBe(false));
  return result;
};

/** Arrival, exactly as `app/onboarding/taste.tsx` does it: the flow becomes live. */
const begin = async (userId: string) => {
  const { result } = await renderHookWithProviders(() => useBeginTasteOnboarding(userId));
  await act(async () => {
    await result.current();
  });
};

/** Leaving, the way one of the summary's buttons does. */
const complete = async ({ skipped }: { skipped: boolean }) => {
  const { result } = await renderHookWithProviders(() => useCompleteTasteOnboarding('user-1'));
  await act(async () => {
    await result.current({ skipped });
  });
};

/**
 * Who gets the first-run flow, and — much more importantly — who never does.
 *
 * Dropping an existing user into "build your taste" is the app telling somebody with a
 * collection that it has never met them. That is the failure worth being careful about,
 * so every test here except the first is a way of *not* entering.
 */
describe('useTasteOnboarding', () => {
  it('is needed by an account with nothing in it', async () => {
    const result = await read();
    expect(result.current.data).toEqual({ ranked: 0, needed: true });
  });

  it('is not needed by an account that has ranked something', async () => {
    mockCounts.rankings = 12;
    mockCounts.user_media = 12;

    const result = await read();
    expect(result.current.data?.needed).toBe(false);
  });

  it('is not needed by an account that logged without ranking', async () => {
    // The test is any collection at all, not zero rankings. Somebody who logged four
    // films and never compared them has been using the app.
    mockCounts.rankings = 0;
    mockCounts.user_media = 4;

    const result = await read();
    expect(result.current.data?.needed).toBe(false);
  });

  it('is not needed by somebody who already said not now', async () => {
    mockPrefs.set('user-1.onboarding.taste.phase', 'skipped');

    const result = await read();
    expect(result.current.data?.needed).toBe(false);
  });

  it('is not needed by somebody who finished it', async () => {
    mockPrefs.set('user-1.onboarding.taste.phase', 'done');
    mockCounts.rankings = 5;
    mockCounts.user_media = 5;

    const result = await read();
    expect(result.current.data?.needed).toBe(false);
  });

  /**
   * The defect independent review found, as two tests.
   *
   * The entry test used to be "this account has nothing in it", and the flow's own first
   * film falsifies that — `set_bucket` writes a `user_media` row. So from film one
   * onward the account no longer looked new: the router saw somebody on the onboarding
   * route who no longer needed it and sent them to the feed at 1 of 5, and closing the
   * app after the first film meant reopening went straight past the rest.
   *
   * The entry decision is now taken once and remembered, and only progress is read live.
   */
  it('stays needed once the flow has started and put a film in the collection', async () => {
    mockPrefs.set('user-1.onboarding.taste.phase', 'active');
    mockCounts.rankings = 1;
    mockCounts.user_media = 1;

    const result = await read();
    expect(result.current.data).toEqual({ ranked: 1, needed: true });
  });

  it('resumes a flow abandoned after one film, on the next launch', async () => {
    // Bucketed one and closed the app before the comparison finished: a `user_media`
    // row exists and no ranking does. Under the old test this account read as
    // established and never saw the flow again.
    mockPrefs.set('user-1.onboarding.taste.phase', 'active');
    mockCounts.rankings = 0;
    mockCounts.user_media = 1;

    const result = await read();
    expect(result.current.data?.needed).toBe(true);
  });

  it('stays needed at five, because leaving is an act and not a count', async () => {
    mockPrefs.set('user-1.onboarding.taste.phase', 'active');
    mockCounts.rankings = 5;
    mockCounts.user_media = 5;

    // Tying this to the count would give the fifth placement two jobs — completing the
    // flow and dismissing it — and the second fires first, so the screen would be sent
    // away at the moment it had a summary to show. Somebody who force-quits on the
    // summary reopens on the summary, which is right: they have not said where they
    // wanted to go.
    expect((await read()).current.data?.needed).toBe(true);
  });

  /**
   * **The founder's 2026-08-26 launch regression, as the state that produced it.**
   *
   * Five films ranked, a full collection, and every launch landing on "That is a start".
   * Given the account's server-side facts — five rankings, five logged titles — `active`
   * is the *only* phase value `readState` can turn into a summary screen, so it is what
   * the device held. `active` is written on arrival and cleared only by one of the
   * screen's own exits; every other departure leaves it set, and on build 4 every other
   * departure was the only one available.
   *
   * The resume itself stays — the test above is unchanged, and a crashed exit still gets
   * a second go at the buttons. What is added is that it *ends*.
   */
  it('settles the phase when it resumes a flow whose work is already done', async () => {
    mockPrefs.set('user-1.onboarding.taste.phase', 'active');
    mockCounts.rankings = 5;
    mockCounts.user_media = 5;

    const result = await read();

    // This launch is unchanged: the summary draws and both its buttons work.
    expect(result.current.data?.needed).toBe(true);
    // And the next one opens the app.
    await waitFor(() => expect(mockPrefs.get('user-1.onboarding.taste.phase')).toBe('done'));
  });

  /**
   * **And the answer holds for the rest of the session, which the repair nearly broke.**
   *
   * The screen refetches this query to move its progress bar. If the settled `done` were
   * only on the disk, the very next read would find it and answer `needed: false` — the
   * summary would unmount and the ranking step would draw in its place, five of five
   * placed under "The first one needs no comparison". That is exactly the defect `exiting`
   * was added to `taste.tsx` to prevent, arrived at from underneath.
   */
  it('keeps answering the same way when the screen refetches after settling', async () => {
    mockPrefs.set('user-1.onboarding.taste.phase', 'active');
    mockCounts.rankings = 5;
    mockCounts.user_media = 5;

    const first = await read();
    expect(first.current.data?.needed).toBe(true);
    await waitFor(() => expect(mockPrefs.get('user-1.onboarding.taste.phase')).toBe('done'));

    // The refetch, with the settled phase now on the device.
    const again = await read();
    expect(again.current.data?.needed).toBe(true);
    expect(again.current.data?.ranked).toBe(5);
  });

  /**
   * **Independent review 50's blocker: the repair must not overwrite a newer answer.**
   *
   * `readState` captures the phase before awaiting two PostgREST counts. In that window
   * somebody can press "Not now" — `complete()` records `skipped` synchronously and
   * dispatches its write — and the stale read would then publish `needed: true` over the
   * completion and dispatch a `done` that lands after the `skipped` and wins. The person's
   * own answer, overwritten by a read that started before they gave it.
   */
  it('does not overwrite a decision taken while its counts were in the air', async () => {
    mockPrefs.set('user-1.onboarding.taste.phase', 'active');
    mockCounts.rankings = 5;
    mockCounts.user_media = 5;

    // Held open before the read starts, so the render below completes with its counts
    // still outstanding. Renders are kept strictly sequential — two overlapping ones
    // leave the test renderer in a state the next test inherits.
    let countsCameBack = () => {};
    mockTableGates.user_media = new Promise<void>((resolve) => {
      countsCameBack = resolve;
    });

    const { result } = await renderHookWithProviders(() => useTasteOnboarding('user-1'));
    expect(result.current.isPending).toBe(true);

    // The person answers while the read is still out.
    await complete({ skipped: true });
    expect(mockPrefs.get('user-1.onboarding.taste.phase')).toBe('skipped');

    // And now the counts come back, into a process that has moved on without them.
    countsCameBack();
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.data?.needed).toBe(false);
    expect(mockPrefs.get('user-1.onboarding.taste.phase')).toBe('skipped');
  });

  /**
   * **Review 50's second finding: the person who resumes part-way and finishes now.**
   *
   * `begin()` refuses to write over a phase that already exists, so it leaves `intent`
   * empty for somebody resuming an unfinished flow — which means their session looks
   * "remembered" rather than live. Ranking the fourth and fifth films then reaches the
   * repair, and the summary must still hold for the rest of the session rather than
   * collapsing back into the ranking step.
   */
  it('holds the summary for somebody who resumed at three and finished now', async () => {
    mockPrefs.set('user-1.onboarding.taste.phase', 'active');
    mockCounts.rankings = 3;
    mockCounts.user_media = 3;

    // Arrival: `begin` sees the stored phase and installs nothing.
    await begin('user-1');
    expect((await read()).current.data?.needed).toBe(true);

    // The fourth and fifth films land, and the screen refetches its progress.
    mockCounts.rankings = 5;
    mockCounts.user_media = 5;
    expect((await read()).current.data?.needed).toBe(true);

    // And every refetch after that, however many.
    expect((await read()).current.data?.needed).toBe(true);
    expect((await read()).current.data?.ranked).toBe(5);
  });

  it('opens the app on the launch after that', async () => {
    mockPrefs.set('user-1.onboarding.taste.phase', 'done');
    mockCounts.rankings = 5;
    mockCounts.user_media = 5;

    expect((await read()).current.data?.needed).toBe(false);
  });

  /**
   * Nothing is settled for somebody still in the middle of it. Four placed is four
   * placed, however many times the app is opened.
   */
  it('leaves an unfinished flow exactly where it was', async () => {
    mockPrefs.set('user-1.onboarding.taste.phase', 'active');
    mockCounts.rankings = 4;
    mockCounts.user_media = 4;

    expect((await read()).current.data?.needed).toBe(true);
    expect(mockPrefs.get('user-1.onboarding.taste.phase')).toBe('active');
  });

  /**
   * **And a flow that is live in this process is not "resumed" at all.**
   *
   * This is the distinction the whole fix turns on. Placing the fifth film must not
   * settle anything: the screen has a summary to show and the person has not left yet.
   * `begin()` puts `active` in memory on arrival, so a live flow is the case where the
   * phase came from *this process* rather than from the device.
   */
  it('settles nothing while the flow is live in this process', async () => {
    // No stored phase: a brand-new account arriving for the first time, which is the
    // only case `begin` will enrol — it refuses to write over a decision that exists.
    mockCounts.rankings = 0;
    mockCounts.user_media = 0;

    // Arrival, exactly as the screen does it.
    await begin('user-1');
    expect(mockPrefs.get('user-1.onboarding.taste.phase')).toBe('active');

    // The fifth film lands and the query is refetched to move the progress bar.
    mockCounts.rankings = 5;
    mockCounts.user_media = 5;

    const result = await read();
    expect(result.current.data?.needed).toBe(true);
    expect(mockPrefs.get('user-1.onboarding.taste.phase')).toBe('active');
  });

  it('reports how many films are already placed, which is the progress', async () => {
    mockCounts.rankings = 3;
    mockCounts.user_media = 3;

    const result = await read();
    expect(result.current.data?.ranked).toBe(3);
  });

  /**
   * **Account B does not inherit account A's onboarding.** The account-escape hotfix
   * makes switching accounts on one device an ordinary act, so the per-account keying
   * of both the memory intent and the disk phase stops being theoretical: A finishing
   * the flow and signing out must leave B's first launch reading as B's, in both
   * directions.
   */
  it('keeps one account’s decision away from the next account on the device', async () => {
    const { result: complete } = await renderHookWithProviders(() =>
      useCompleteTasteOnboarding('user-a'),
    );
    await complete.current({ skipped: false });

    // A is finished, held in memory whatever the disk did.
    const { result: again } = await renderHookWithProviders(() => useTasteOnboarding('user-a'));
    await waitFor(() => expect(again.current.isPending).toBe(false));
    expect(again.current.data?.needed).toBe(false);

    // B, fresh on the same device, is offered the flow — A's `done` is not B's.
    const { result: other } = await renderHookWithProviders(() => useTasteOnboarding('user-b'));
    await waitFor(() => expect(other.current.isPending).toBe(false));
    expect(other.current.data?.needed).toBe(true);
  });

  it('does not put anyone through the flow when it cannot tell', async () => {
    // A failed read is not evidence that somebody is new. The routing treats a missing
    // answer as "not needed" for exactly this reason: the cost of skipping the flow for
    // a genuinely new account is a suggestion they did not get, and the cost of the
    // other mistake is an established user being asked to start again.
    mockErrors.rankings = { message: 'network' };

    const { result } = await renderHookWithProviders(() => useTasteOnboarding('user-1'));
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(result.current.data?.needed).toBeUndefined();
    expect(result.current.isError).toBe(true);
  });
});

/**
 * **The first-run check is on the critical path of every launch, so it is bounded.**
 *
 * `nextRoute` deliberately moves nobody while this query is pending — `if (tastePending)
 * return null` — which is right, because routing somebody to the feed and then yanking
 * them into a five-step flow is worse than waiting the ~170ms the check costs. What that
 * makes it, though, is the one query in the app that can hold the *navigator* shut, and
 * it awaits two PostgREST counts and a Keychain read with `retry: false` behind them.
 * None of those is a promise the platform guarantees to settle.
 *
 * That is the second half of the founder's ~20 second blank startup on build 4: not a
 * frozen app, an app with nothing to route to and no reason yet to route there. A hang
 * now resolves the way a failure already did — "not needed" — and the read is left to
 * finish on its own if it ever does.
 */
describe('when the first-run check cannot answer in time', () => {
  const hung = async () => {
    const { result } = await renderHookWithProviders(() => useTasteOnboarding('user-1'));
    return result;
  };

  it('gives up on a hung preference read rather than holding the app', async () => {
    jest.useFakeTimers();
    try {
      mockReadHangs.add('user-1.onboarding.taste.phase');
      const result = await hung();
      expect(result.current.isPending).toBe(true);

      await act(async () => {
        jest.advanceTimersByTime(4000);
      });

      await waitFor(() => expect(result.current.isPending).toBe(false));
      // Not knowing is not a reason to put somebody through the flow — the same answer a
      // failure produces, for the same reason.
      expect(result.current.data).toEqual({ ranked: 0, needed: false });
    } finally {
      jest.useRealTimers();
    }
  });

  it('gives up on a count that never comes back', async () => {
    jest.useFakeTimers();
    try {
      mockTableHangs.add('rankings');
      const result = await hung();

      await act(async () => {
        jest.advanceTimersByTime(4000);
      });

      await waitFor(() => expect(result.current.isPending).toBe(false));
      expect(result.current.data?.needed).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('still answers properly when the platform is healthy, and is not merely fast', async () => {
    mockCounts.rankings = 0;
    mockCounts.user_media = 0;
    const result = await hung();

    await waitFor(() => expect(result.current.isPending).toBe(false));
    // An account with nothing in it is still offered the flow — the bound must not have
    // turned every launch into "not needed".
    expect(result.current.data).toEqual({ ranked: 0, needed: true });
  });
});

/**
 * **What a cold start actually spends on this question, counted.**
 *
 * `nextRoute` blocks on this query, so whatever it costs sits between opening the app and
 * seeing any part of it. Bounding that wait made a hang survivable and left the ordinary
 * case untouched — independent review 48 was right that capping an unnecessary wait at
 * four seconds is not the same as not having it.
 *
 * The decision is already on the device for anyone who has finished or declined, which is
 * every account after its first session. So it is read first, and the counts are asked for
 * only when they can still change the answer.
 */
describe('what the check costs a cold start', () => {
  it('asks the server nothing at all once the flow has been finished', async () => {
    mockPrefs.set('user-1.onboarding.taste.phase', 'done');

    const result = await read();

    expect(result.current.data?.needed).toBe(false);
    // The whole point: two PostgREST round trips are no longer in front of the app for
    // an account whose answer the Keychain already held.
    expect(mockRequests.rankings ?? 0).toBe(0);
    expect(mockRequests.user_media ?? 0).toBe(0);
  });

  it('asks the server nothing once the flow has been declined either', async () => {
    mockPrefs.set('user-1.onboarding.taste.phase', 'skipped');

    const result = await read();

    expect(result.current.data?.needed).toBe(false);
    expect(mockRequests.rankings ?? 0).toBe(0);
    expect(mockRequests.user_media ?? 0).toBe(0);
  });

  /**
   * And it still asks where the answer is genuinely unknown — the fix must not have
   * turned "never decided" into "not needed" by skipping the read that decides it.
   */
  it('still asks when nothing has been decided yet', async () => {
    const result = await read();

    expect(result.current.data?.needed).toBe(true);
    expect(mockRequests.rankings ?? 0).toBeGreaterThan(0);
    expect(mockRequests.user_media ?? 0).toBeGreaterThan(0);
  });

  it('still asks mid-flow, because the progress bar is the count', async () => {
    mockPrefs.set('user-1.onboarding.taste.phase', 'active');
    mockCounts.rankings = 3;
    mockCounts.user_media = 3;

    const result = await read();

    expect(result.current.data).toEqual({ ranked: 3, needed: true });
    expect(mockRequests.rankings ?? 0).toBeGreaterThan(0);
  });
});
