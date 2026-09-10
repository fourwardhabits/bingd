import { act, fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { TAB_ROUTES } from '@/lib/routes';

import { resetRankingOutcome } from './pick-five';
import { resetOnboardingStages } from './use-onboarding-stage';
import { resetTasteIntent } from './use-taste-onboarding';

// Not colocated with the route: everything under app/ is bundled by expo-router's
// require.context. See app-directory.test.ts.
import TasteScreen from '../../../app/onboarding/taste';

/**
 * Dismissals waiting to be acknowledged, when a test wants to stand inside the gap.
 *
 * iOS takes about 300ms to slide a sheet away and only then calls `onDismiss`. That gap
 * is where the bug lived, so one test below holds it open deliberately.
 */
/** The shared faithful Modal lives in jest.setup.js; this drives its held dismissals. */
const dismissals = () =>
  (globalThis as unknown as { __modalDismissals: { hold: boolean; pending: (() => void)[] } })
    .__modalDismissals;
const releaseDismissals = async () => {
  const waiting = dismissals().pending.splice(0);
  // Inside `act`: each of these calls `setStep`, and driving React state from outside it
  // is what makes the suite print the act warning with a stack pointing here.
  await act(async () => {
    waiting.forEach((done) => done());
  });
};

/**
 * The other end of the same 300ms, and the half the freeze actually came from.
 *
 * A sheet is on screen and takes touches while it is still sliding up, so a placement or
 * a Close can land before iOS has finished presenting it. A dismissal issued in that
 * window is refused outright and its completion never runs. `shows().hold` stands inside
 * the entrance the way `dismissals().hold` stands inside the exit, and `refused` counts
 * the requests UIKit would have thrown away.
 */
const shows = () =>
  (globalThis as unknown as {
    __modalShows: { hold: boolean; pending: (() => void)[]; refused: number };
  }).__modalShows;
const releaseShows = async () => {
  const waiting = shows().pending.splice(0);
  await act(async () => {
    waiting.forEach((arrive) => arrive());
  });
};


/**
 * The first five, as a loop: pick, rank, pick, rank (founder, physical iOS 1.0.1 build 9).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS DEFENDING
 *
 * The founder chose *I liked it* for the first movie, finished the comparisons, met the
 * post-rank completion sheet, closed it, and onboarding stopped. The cause was two React
 * Native modals asked to present at once: the log sheet opened over the run while the
 * bucket sheet's subject — derived from a cursor that had already advanced — became the
 * *second* movie. iOS presents one and refuses the other, and closing the one that exists
 * leaves a screen whose only remaining control is a modal that will never appear.
 *
 * So the assertions here are about the **shape of the state**, not about the symptom:
 *
 *   - exactly one sheet is ever mounted, at every point in the loop;
 *   - no completion sheet appears between titles at all;
 *   - the loop returns to the picker after every placement, five times;
 *   - a dismissal at either sheet returns to the picker rather than to a cursor;
 *   - a relaunch anywhere in the run lands on the picker, at the right number;
 *   - a title that has been ranked is never offered again, so no step can fail to advance.
 *
 * ---------------------------------------------------------------------------
 * WHY EACH TEST PRESSES AT MOST TWO DISTINCT CONTROLS
 *
 * Two `fireEvent.press` calls on the *same element* in one test leave this file's renderer
 * returning empty trees for every test after it, and the failures surface as "unable to
 * find an element" somewhere unrelated. Each case below therefore seeds the state it is
 * about and presses through one step of the loop, rather than driving five iterations in
 * one test.
 */

const mockRpc = jest.fn();
const mockReplace = jest.fn();
const mockPrefs = new Map<string, unknown>();
let mockWriteFails = false;
/** A preference write that never settles — the Keychain lane of review 47's hang. */
let mockWriteHangs = false;
/** Preference names whose *read* rejects — the SecureStore lane of the build-4 pin. */
const mockReadFails = new Set<string>();
/** Preference names whose read never settles — review 47's first blocker, pinned. */
const mockReadHangs = new Set<string>();
const mockTableRows: Record<string, unknown[]> = {};
/** Rows a `count: 'exact', head: true` select should report, keyed by table. */
const mockCounts: Record<string, number> = {};

/**
 * The operating-system half of the notification step, controllable per test.
 *
 * `push-permission.ts` runs real in this suite — it is part of the path under test —
 * and everything it touches of the platform comes through `push.ts`, so this one mock
 * stands in for the phone. `unavailable` is the default so the many tests that are not
 * about notifications skip the step, exactly as a simulator does.
 */
const mockPushEnv = {
  permission: 'unavailable' as string,
  requestResult: 'granted' as string,
  registered: 0,
};

jest.mock('@/features/notifications/push', () => ({
  pushPermission: () => Promise.resolve(mockPushEnv.permission),
  requestPushPermission: () => Promise.resolve(mockPushEnv.requestResult),
  noteFailure: jest.fn(),
  pushPlatform: () => 'ios',
  pushSessionEpoch: () => 0,
  acquirePushToken: () => Promise.resolve('ExponentPushToken[test]'),
  registerPushToken: () => {
    mockPushEnv.registered += 1;
    return Promise.resolve('ok');
  },
  revokePushToken: () => Promise.resolve('ok'),
  rememberToken: jest.fn(),
  forgetToken: jest.fn(),
  trackDispatchedWrite: (write: Promise<unknown>) => write,
}));

jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) => {
    if (mockReadHangs.has(name)) return new Promise(() => {});
    if (mockReadFails.has(name)) return Promise.reject(new Error('secure store unavailable'));
    return Promise.resolve(mockPrefs.get(name) ?? null);
  },
  writePref: (name: string, value: unknown) => {
    if (mockWriteHangs) return new Promise(() => {});
    if (mockWriteFails) return Promise.reject(new Error('secure store unavailable'));
    mockPrefs.set(name, value);
    return Promise.resolve();
  },
}));

/**
 * Tables whose read is parked rather than answered, keyed to the callbacks waiting on it.
 *
 * Two cases below are about what the screen does *while* a read is in flight, and every
 * read here otherwise answers in the same microtask as the call — which is why neither
 * had a test.
 */
const mockHeld = new Map<string, (() => void)[]>();
const holdReadsOf = (table: string) => mockHeld.set(table, []);
const releaseReadsOf = (table: string) => {
  const waiting = mockHeld.get(table) ?? [];
  mockHeld.delete(table);
  for (const answer of waiting) answer();
};
/** Answers now, or when the table is released. */
const held = <T,>(table: string, answer: () => T): Promise<T> => {
  const waiting = mockHeld.get(table);
  if (!waiting) return Promise.resolve(answer());
  return new Promise<T>((resolve) => waiting.push(() => resolve(answer())));
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const rows = () => mockTableRows[table] ?? [];
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        filter: () => chain,
        limit: () => chain,
        // Chainable, not terminal: `useRankedCollection` reads
        // `.order(...).limit(...)` and takes its rows from the awaited builder, so an
        // `order` that resolved here would leave `limit` undefined on a promise.
        order: () => chain,
        // The keyset cursor `read-all.ts` applies between pages.
        gt: () => chain,
        single: () => held(table, () => ({ data: rows()[0] ?? null, error: null })),
        maybeSingle: () => held(table, () => ({ data: rows()[0] ?? null, error: null })),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => void) => {
          void held(table, () => ({
            data: rows(),
            error: null,
            count: mockCounts[table] ?? rows().length,
          })).then(resolve, reject);
        },
      });
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
  useCurrentUserId: () => 'user-1',
  useAuth: () => ({ status: 'ready', userId: 'user-1' }),
  // A visible stand-in rather than null, so this suite can assert the escape route is
  // offered without dragging the real sign-out stack into a screen test — the
  // behaviour behind the label is `account-escape.test.tsx`'s job.
  UseDifferentAccountButton: () => {
    const React = jest.requireActual('react');
    const { Text } = jest.requireActual('react-native');
    return React.createElement(Text, null, 'Use a different account');
  },
}));

let issued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `operation-${(issued += 1)}` }));

const film = {
  id: 'film-1',
  kind: 'movie',
  title: 'Inception',
  release_date: '2010-07-16',
  poster_path: null,
  provenance: 'wikidata',
};

const series = {
  id: 'series-1',
  kind: 'series',
  title: 'Inception: The Series',
  release_date: '2015-01-01',
  poster_path: null,
  provenance: 'wikidata',
};

/** One row of `rankings`, as `useRankedCollection` reads them. */
const rankedRow = (id: string, title: string, position: number) => ({
  media_item_id: id,
  bucket: 'loved',
  position,
  category: 'movies',
  created_at: '2026-09-09T00:00:00Z',
  media_items: {
    title,
    season_number: null,
    release_date: '2010-01-01',
    poster_path: null,
    genres: [],
    runtime_minutes: 100,
    kind: 'movie',
    original_language: 'en',
    parent_id: null,
    parent: null,
  },
});

/** `n` movies already ranked by this account, which is the whole of the run's progress. */
const alreadyRanked = (n: number) => {
  mockTableRows.rankings = Array.from({ length: n }, (_, index) =>
    rankedRow(`done-${index + 1}`, `Ranked ${index + 1}`, index + 1),
  );
};

/** What `starter_movies` and the catalogue read behind it answer with. */
const starterGrid = (ids: string[]) => {
  mockStarterIds = ids;
  mockTableRows.media_items = ids.map((id, index) => ({
    id,
    title: id === 'film-1' ? 'Inception' : `Starter ${index + 1}`,
    release_date: '2010-07-16',
    poster_path: null,
  }));
};

let mockStarterIds: string[] = [];

beforeEach(() => {
  // Dismissals acknowledge themselves unless a test says otherwise, which is what a
  // device does. Reset both halves so a held one cannot leak into the next case.
  issued = 0;
  mockRpc.mockReset();
  mockReplace.mockReset();
  mockPrefs.clear();
  for (const key of Object.keys(mockTableRows)) delete mockTableRows[key];
  for (const key of Object.keys(mockCounts)) delete mockCounts[key];
  mockStarterIds = [];
  mockHeld.clear();
  /**
   * The server, as far as this screen is concerned.
   *
   * `rank_start` answers `done` — the empty-band case, where the first title needs no
   * comparison — **and appends the row to `rankings`**, because the placement is the
   * progress: `apply` invalidates that key, the screen refetches it, and the count it
   * reads back is what moves the flow on. A mock that returned a placement without
   * writing one would let every assertion about the loop pass over a run that never
   * advanced.
   */
  mockRpc.mockImplementation((fn: string, args: Record<string, unknown> = {}) => {
    if (fn === 'search_titles') return Promise.resolve({ data: [film, series], error: null });
    if (fn === 'starter_movies') {
      return Promise.resolve({
        data: mockStarterIds.map((id) => ({
          media_item_id: id,
          score: 9.1,
          rating_count: 12,
          min_ratings: 3,
          source: 'community',
        })),
        error: null,
      });
    }
    if (fn === 'rank_start') {
      const id = args.p_media_item_id as string;
      const position = (mockTableRows.rankings ?? []).length + 1;
      mockTableRows.rankings = [
        ...(mockTableRows.rankings ?? []),
        rankedRow(id, `Placed ${position}`, position),
      ];
      return Promise.resolve({
        data: { done: true, position, category: 'movies', bucket: 'loved', score: 9 },
        error: null,
      });
    }
    return Promise.resolve({ data: { status: 'ok' }, error: null });
  });
  mockTableRows.media_items = [];
  mockTableRows.rankings = [];
  mockTableRows.user_media = [];
  mockCounts.rankings = 0;
  mockCounts.user_media = 0;
  // In the flow. The screen enrols only an account the state says is new, and sends
  // anyone else to the feed — so a test that wants the screen has to say which it is.
  mockPrefs.set('user-1.onboarding.taste.phase', 'active');
  mockWriteFails = false;
  mockWriteHangs = false;
  mockReadFails.clear();
  mockReadHangs.clear();
  mockPushEnv.permission = 'unavailable';
  mockPushEnv.requestResult = 'granted';
  mockPushEnv.registered = 0;
  resetTasteIntent();
  resetRankingOutcome();
  resetOnboardingStages();
});

const callsTo = (fn: string) => mockRpc.mock.calls.filter(([name]) => name === fn);

/** The picker, drawn and ready. */
const open = async () => {
  const view = await renderWithProviders(<TasteScreen />);
  await waitFor(() => expect(view.getByLabelText(/of 5 movies ranked/)).toBeTruthy());
  return view;
};

const search = async (view: Awaited<ReturnType<typeof open>>, term: string) => {
  await fireEvent.changeText(view.getByLabelText('Search for a movie'), term);
  await waitFor(() => expect(view.getByLabelText(/Inception, 2010/)).toBeTruthy());
};

/**
 * Answer *How was it?* and then finish the dismissal the way iOS would.
 *
 * ---------------------------------------------------------------------------
 * **The second half is the test playing UIKit's part, and it is not a workaround.**
 *
 * Since the 2026-09-10 freeze fix the run does not go straight from the bucket sheet to
 * the comparison sheet. It waits in `handoff` until the bucket sheet's presentation is
 * actually gone, because UIKit refuses to present a view controller over one that is
 * still dismissing and the transparent window left behind eats every touch. On iOS the
 * signal is `<Modal onDismiss>`; jest has no UIKit and never fires it, so the run
 * correctly waits forever here unless the test supplies it.
 *
 * `onDismiss` is only passed by the bucket sheet, so the modal carrying one is the modal
 * being dismissed — no other sheet has to be told apart from it.
 *
 * **What this cannot prove**: that iOS really serialises the two presentations. Only a
 * device can. What it does prove is the contract this side of the boundary — that the
 * comparison sheet is not asked for until the dismissal is acknowledged, and that the run
 * completes when it is.
 */
const chooseBucket = async (view: Awaited<ReturnType<typeof open>>, label = 'I liked it') => {
  await fireEvent.press(view.getByLabelText(label));
  // The bucket sheet closes, the mocked modal reports its dismissal, and the run leaves
  // `handoff` for the comparison. Waiting on the question being *gone* is the observable
  // half of that; the comparison arriving is what each caller then asserts.
  await waitFor(() => expect(view.queryByText('How was it?')).toBeNull());
};

describe('the picker', () => {
  it('asks for one movie at a time, in the founder’s words', async () => {
    const view = await open();

    expect(view.getByText('Pick a movie you have seen')).toBeTruthy();
    // `film` was the app's own word and `movie` is the founder's.
    expect(view.queryByText(/five films/i)).toBeNull();
    // The old flow's instruction, which asked for all five up front.
    expect(view.queryByText(/Pick five movies/i)).toBeNull();
  });

  it('starts at zero of five, counting rankings rather than choices', async () => {
    const view = await open();
    expect(view.getByLabelText('0 of 5 movies ranked')).toBeTruthy();
  });

  it('offers movies and never a series, because a series cannot be ranked', async () => {
    const view = await open();
    await search(view, 'inception');

    expect(view.queryByText('Inception: The Series')).toBeNull();
  });

  /**
   * The starter grid is `starter_movies`, not the Trending shelf.
   *
   * The founder ran the old twelve-row trending grid out after four picks, and half of
   * those twelve were series the screen then dropped. The replacement is asked for by
   * name here so a silent revert to `provider_list_cache` cannot pass.
   */
  it('fills the grid from the community starter list', async () => {
    starterGrid(['starter-a', 'starter-b', 'starter-c']);
    const view = await open();

    await waitFor(() => expect(view.getByLabelText('Starter 1')).toBeTruthy());
    expect(callsTo('starter_movies')).toHaveLength(1);
    expect(view.getByLabelText('Starter 3')).toBeTruthy();
  });

  /**
   * **A ready starter list is not held behind the shelf that stands in for it**
   * (independent review, P1).
   *
   * The loading branch was `starters.isPending || trending.isPending`, so a slow Trending
   * request drew skeletons over a grid that was ready — the first screen of the product,
   * with movies in hand and nothing on it.
   */
  it('draws the grid as soon as the starter list answers, without waiting for the shelf', async () => {
    starterGrid(['starter-a', 'starter-b']);
    // The fallback's read, parked. `starters` answers; `trending` does not.
    holdReadsOf('provider_list_cache');

    const view = await open();

    await waitFor(() => expect(view.getByLabelText('Starter 1')).toBeTruthy());
    expect(view.getByLabelText('Starter 2')).toBeTruthy();

    releaseReadsOf('provider_list_cache');
  });

  /**
   * **The grid is never empty on a backend that has not caught up.**
   *
   * `starter_movies` ships in `20260915000100`, and the beta lane points at the production
   * project (`config/backends.cjs`) — so a build can reach a backend where the function
   * does not exist and PostgREST answers 404. The consequence would be exactly the screen
   * this whole tranche is about: nothing to pick from on the first screen of the product.
   * The old trending shelf stays as the floor under it.
   */
  it('falls back to the trending shelf when the starter list answers with nothing', async () => {
    mockStarterIds = [];
    mockTableRows.provider_list_cache = [
      {
        list_key: 'trending.movie.day',
        payload: { ids: ['film-1'] },
        fetched_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ];
    mockTableRows.media_items = [
      {
        id: 'film-1',
        title: 'Inception',
        release_date: '2010-07-16',
        poster_path: null,
        popularity: 9,
        kind: 'movie',
      },
    ];

    const view = await open();

    await waitFor(() => expect(view.getByLabelText('Inception')).toBeTruthy());
  });

  /**
   * **A step that cannot advance is a dead end with extra steps.**
   *
   * `starter_movies` excludes the caller's own rankings server-side; this is the client
   * half, which matters for the search field, where the rows come from the catalogue
   * rather than from that function. Picking a movie that is already ranked would leave
   * the count where it was for as long as somebody kept picking it, on a screen whose
   * only other exit is *Not now*.
   */
  it('never offers a movie this account has already ranked', async () => {
    mockTableRows.rankings = [rankedRow('film-1', 'Inception', 1)];
    const view = await open();
    await fireEvent.changeText(view.getByLabelText('Search for a movie'), 'inception');

    await waitFor(() => expect(view.getByLabelText('1 of 5 movies ranked')).toBeTruthy());
    expect(view.queryByLabelText(/Inception, 2010/)).toBeNull();
  });
});

describe('one turn of the loop', () => {
  it('opens the bucket question on the movie that was picked', async () => {
    const view = await open();
    await search(view, 'inception');
    await fireEvent.press(view.getByLabelText(/Inception, 2010/));

    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    // Nothing is written by picking. The bucket is.
    expect(callsTo('set_bucket')).toHaveLength(0);
  });

  /**
   * The founder decision this flow exists to honour.
   *
   * The first five may be movies somebody saw fifteen years ago. `LogSheet` follows a
   * bucket save with `log_watched` for today, because the sheet it belongs to displays a
   * date, and that would put five historical movies into this year's Goals. This flow
   * goes straight to `set_bucket`, which writes no date, and `goals.ts` refuses to count
   * a null one.
   */
  it('records no watch date, so an old movie does not land in this year of goals', async () => {
    const view = await open();
    await search(view, 'inception');
    await fireEvent.press(view.getByLabelText(/Inception, 2010/));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());

    await chooseBucket(view);

    await waitFor(() => expect(callsTo('set_bucket')).toHaveLength(1));
    expect(callsTo('log_watched')).toHaveLength(0);
  });

  it('drives the real comparison session rather than a copy of it', async () => {
    const view = await open();
    await search(view, 'inception');
    await fireEvent.press(view.getByLabelText(/Inception, 2010/));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());

    await chooseBucket(view);

    // `rank_start` is the same session opener the Log tab drives. Nothing about the
    // ranking algorithm is reimplemented by onboarding.
    await waitFor(() => expect(callsTo('rank_start')).toHaveLength(1));
    expect(callsTo('rank_start')[0][1]).toMatchObject({
      p_media_item_id: 'film-1',
      p_bucket: 'loved',
    });
  });

  /**
   * **The blocker, as an assertion.** A placement goes straight back to the picker: no
   * reveal, no *Done / Add details*, and nothing else on screen that has to be dismissed
   * before the flow can continue.
   */
  it('returns to the picker with no completion sheet in between', async () => {
    const view = await open();
    await search(view, 'inception');
    await fireEvent.press(view.getByLabelText(/Inception, 2010/));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());

    await chooseBucket(view);

    await waitFor(() => expect(view.getByLabelText('1 of 5 movies ranked')).toBeTruthy());
    expect(view.getByText('Pick another one')).toBeTruthy();
    // The three things that used to be here, each of which the founder had to close.
    expect(view.queryByText('How was it?')).toBeNull();
    expect(view.queryByRole('button', { name: 'Add details' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Done' })).toBeNull();
  });

  /**
   * **At most one sheet, at every point in the loop.**
   *
   * This is the invariant whose absence was the dead end: the bucket sheet's subject used
   * to be derived from a cursor that advanced the instant the placement landed, so it
   * became visible underneath the log sheet that had just opened. Two modals, one
   * presented, and closing the one that existed left nothing.
   */
  /**
   * **The 2026-09-10 freeze, pinned at the only place a test can reach it.**
   *
   * The founder ranked the first movie on a clean account and the app died: the picker
   * drew correctly at *1 of 5*, posters and all, and the screen took no touches. Force
   * quitting recovered it every time, and the server showed the ranking had completed —
   * no leftover session, no orphan row — so nothing was wrong with the data.
   *
   * The cause is two `<Modal>`s swapped in one commit. Choosing a bucket unmounted the
   * bucket sheet and mounted the comparison sheet in the same render, and UIKit will not
   * present a view controller over one that is still dismissing: the presentation is
   * refused, React believes it succeeded, and the transparent window that survives eats
   * every touch. It is the **first** movie because `rank_start` "places it outright when
   * its band is empty" — film one has no comparisons, so the comparison sheet presents
   * and is dismissed again inside the 300ms the bucket sheet is still sliding away. Films
   * two to five are held open by a person answering, so the dismissal has long finished.
   *
   * So the invariant is not "one sheet mounted", which was already true and was not
   * enough. It is **the next presentation is not requested until the last dismissal is
   * acknowledged**, and this test stands inside that gap and looks.
   */
  it('asks for no second sheet until the bucket sheet has actually gone', async () => {
    dismissals().hold = true;
    const view = await open();
    await search(view, 'inception');
    await fireEvent.press(view.getByLabelText(/Inception, 2010/));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('I liked it'));

    /**
     * Mid-dismissal. The question is **still on screen** — iOS keeps a dismissing modal's
     * children mounted and the mock is faithful about that — but nothing has been asked
     * to present over it. Before the fix the comparison sheet was already mounted at this
     * moment, which is exactly where iOS refused it.
     */
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('set_bucket', expect.anything()));
    expect(mockRpc).not.toHaveBeenCalledWith('rank_start', expect.anything());

    // And the controls still rendered in that window answer nothing, so a second tap
    // cannot write a second bucket over the one already on its way.
    await fireEvent.press(view.getByLabelText('It was fine'));
    expect(mockRpc.mock.calls.filter(([name]) => name === 'set_bucket')).toHaveLength(1);

    await releaseDismissals();

    // And once iOS says the presentation is gone, the run carries on exactly as before.
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('rank_start', expect.anything()),
    );
  });

  /**
   * **The return leg: the comparison sheet is never unmounted while it is presented.**
   *
   * The audit that followed the freeze asked whether the same hazard existed pointing the
   * other way. It does not reach the user the way the outward leg does — a dismissing
   * sheet's window still covers the screen, so no poster is tappable until it is gone,
   * which RNTL models through accessibilityViewIsModal and this test relies on. What
   * is worth pinning is the invariant itself: the sheet stays mounted through its own
   * dismissal, on the placement path and on a dismissal mid-comparison alike, so nothing
   * ever asks UIKit to tear down a controller it is still animating.
   */
  it('keeps the comparison sheet mounted until its dismissal is acknowledged', async () => {
    starterGrid(['film-1', 'film-2']);
    dismissals().hold = true;
    const view = await open();

    await waitFor(() => expect(view.getByLabelText('Inception')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Inception'));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('I liked it'));

    // Through the bucket handoff and the placement, leaving the comparison sheet's own
    // dismissal outstanding.
    await releaseDismissals();
    await waitFor(() =>
      expect(mockRpc.mock.calls.some(([name]) => name === 'rank_start')).toBe(true),
    );

    // Still mounted, and still covering the screen: the picker exists but is not
    // reachable, which is what a sheet that has not finished dismissing looks like.
    expect(view.queryByLabelText('Rank Inception')).toBeTruthy();
    expect(view.queryByLabelText('Starter 2')).toBeNull();

    await releaseDismissals();

    // Gone, and the picker is live again at the number the placement moved it to.
    await waitFor(() => expect(view.getByLabelText('1 of 5 movies ranked')).toBeTruthy());
    expect(view.getByLabelText('Starter 2')).toBeTruthy();
  });

  /**
   * **A bucket answered while the question is still sliding up.**
   *
   * The sheet is on screen and live for the whole ~300ms presentation, so nothing stops a
   * person answering inside it — and on the first title of a fresh account the answer is
   * the fastest one there is, because the chip is under the thumb that just opened it.
   * A dismissal asked for in that window is not deferred by UIKit, it is **refused**: the
   * request is dropped, the completion never runs, and the run waits for an `onDismiss`
   * that will never come. That is the freeze from the side the first fix did not cover.
   *
   * The rule lives in `Sheet` rather than here, so this asserts it through the flow:
   * nothing is asked to close mid-entrance, and the turn finishes once the sheet arrives.
   */
  it('does not ask a sheet to close while it is still sliding up', async () => {
    shows().hold = true;
    dismissals().hold = true;
    const view = await open();
    await search(view, 'inception');
    await fireEvent.press(view.getByLabelText(/Inception, 2010/));

    // Mid-presentation: rendered, and answerable, which is the whole problem.
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('I liked it'));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('set_bucket', expect.anything()));

    // The bucket is written and the question has been asked to go — but nothing has been
    // asked of UIKit, because there is a presentation in flight to wait for first.
    expect(shows().refused).toBe(0);
    expect(dismissals().pending).toHaveLength(0);
    expect(mockRpc).not.toHaveBeenCalledWith('rank_start', expect.anything());

    // The presentation lands. Only now is the dismissal issued, and acknowledged.
    await releaseShows();
    await releaseDismissals();

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('rank_start', expect.anything()));
    expect(shows().refused).toBe(0);
  });

  /**
   * **The first title places before its comparison sheet has finished arriving.**
   *
   * `rank_start` on an empty band places outright — no comparison to make — so the sheet
   * that just opened is finished with before iOS has finished opening it. Every later
   * title has a person answering a question inside it and is long since presented, which
   * is why this was only ever reachable on the first one.
   */
  it('does not leave the comparison sheet before it has finished arriving', async () => {
    starterGrid(['film-1', 'film-2']);
    dismissals().hold = true;
    const view = await open();

    await waitFor(() => expect(view.getByLabelText('Inception')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Inception'));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());

    // From here the comparison sheet's entrance is the one being held.
    shows().hold = true;
    await fireEvent.press(view.getByLabelText('I liked it'));
    await releaseDismissals();
    await waitFor(() =>
      expect(mockRpc.mock.calls.some(([name]) => name === 'rank_start')).toBe(true),
    );

    // Placed, and still arriving. The run stays where it is: the picker is behind a sheet
    // that is still on its way up, and nothing has asked to take it away.
    expect(shows().refused).toBe(0);
    expect(dismissals().pending).toHaveLength(0);
    expect(view.queryByLabelText('1 of 5 movies ranked')).toBeNull();

    await releaseShows();
    await releaseDismissals();

    await waitFor(() => expect(view.getByLabelText('1 of 5 movies ranked')).toBeTruthy());
    expect(view.getByLabelText('Starter 2')).toBeTruthy();
    expect(shows().refused).toBe(0);
  });

  it('never has the bucket question open at the same time as anything else', async () => {
    const view = await open();
    await search(view, 'inception');
    await fireEvent.press(view.getByLabelText(/Inception, 2010/));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());

    await chooseBucket(view);

    await waitFor(() => expect(view.getByLabelText('1 of 5 movies ranked')).toBeTruthy());
    expect(view.queryAllByText('How was it?')).toHaveLength(0);
  });

  /** Titles two through four are the same turn, from a run already part way through. */
  it.each([1, 2, 3])('advances from %s ranked to the next', async (already) => {
    alreadyRanked(already);
    const view = await open();
    await search(view, 'inception');
    await fireEvent.press(view.getByLabelText(/Inception, 2010/));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());

    await chooseBucket(view);

    await waitFor(() =>
      expect(view.getByLabelText(`${already + 1} of 5 movies ranked`)).toBeTruthy(),
    );
    expect(view.queryByText('Your First Five')).toBeNull();
  });

  it('shows Your First Five when the fifth is placed, and not before', async () => {
    alreadyRanked(4);
    const view = await open();
    await search(view, 'inception');
    await fireEvent.press(view.getByLabelText(/Inception, 2010/));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());

    await chooseBucket(view);

    await waitFor(() => expect(view.getByText('Your First Five')).toBeTruthy());
  });

  /**
   * **Exactly five, even while the refetch that proves the fifth is still in flight**
   * (independent review, P1).
   *
   * A placement invalidates the ranked collection; it does not synchronously put the row
   * in the cache. So there is a window — one round trip — in which the picker is back and
   * the count behind it is one short, and a quick reader could pick a sixth movie in it.
   * The screen remembers the placement it was told about directly, so the window is closed
   * on both halves at once: the count is right, and the payoff is what is on screen rather
   * than another picker.
   *
   * The read is parked here to hold that window open for as long as the test needs.
   */
  it('reaches the payoff on the fifth even before the collection refetch lands', async () => {
    alreadyRanked(4);
    const view = await open();
    await search(view, 'inception');
    await fireEvent.press(view.getByLabelText(/Inception, 2010/));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());

    // Every read of the ranked collection from here on is parked, so the cache can never
    // learn about the fifth placement on its own.
    holdReadsOf('rankings');

    await chooseBucket(view);

    // Five placed, and the flow says so from what it watched happen rather than from a
    // query that has not answered. No sixth picker, so no sixth ranking.
    await waitFor(() => expect(view.getByText('Your First Five')).toBeTruthy());
    expect(view.queryByLabelText('Search for a movie')).toBeNull();

    releaseReadsOf('rankings');
  });

  /** Five rankings, and exactly five: one `rank_start` per movie and no repeats. */
  it('writes one ranking per movie', async () => {
    alreadyRanked(4);
    const view = await open();
    await search(view, 'inception');
    await fireEvent.press(view.getByLabelText(/Inception, 2010/));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());

    await chooseBucket(view);

    await waitFor(() => expect(view.getByText('Your First Five')).toBeTruthy());
    expect(callsTo('rank_start')).toHaveLength(1);
    expect(callsTo('set_bucket')).toHaveLength(1);
    expect(mockTableRows.rankings).toHaveLength(5);
  });
});

describe('a dismissal', () => {
  /**
   * Backing out of the bucket question returns to the picker.
   *
   * The old run held the title as a cursor, so the same sheet came straight back and the
   * only way past it was to rate a movie the reader had opened by mistake. Nothing has
   * been written at this point, so there is nothing to undo.
   */
  it('at the bucket question, goes back to the picker', async () => {
    const view = await open();
    await search(view, 'inception');
    await fireEvent.press(view.getByLabelText(/Inception, 2010/));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Close'));

    await waitFor(() => expect(view.queryByText('How was it?')).toBeNull());
    expect(view.getByLabelText('0 of 5 movies ranked')).toBeTruthy();
  });
});

describe('resuming', () => {
  /**
   * **Always the picker**, whatever the run was doing when the process ended.
   *
   * Progress is `rankings`, which survives anything; a movie that was mid-comparison is
   * simply not ranked, so it comes back as a movie to pick. Reopening into a sheet would
   * restore the reader to the exact state the app died in — which on the founder's device
   * was the state that killed it.
   */
  it('comes back to the picker at the number actually reached', async () => {
    alreadyRanked(3);
    const view = await renderWithProviders(<TasteScreen />);

    await waitFor(() => expect(view.getByLabelText('3 of 5 movies ranked')).toBeTruthy());
    expect(view.getByText('Pick another one')).toBeTruthy();
    expect(view.queryByText('How was it?')).toBeNull();
  });

  it('reads progress from the data rather than from a local counter', async () => {
    alreadyRanked(5);
    const view = await renderWithProviders(<TasteScreen />);

    await waitFor(() => expect(view.getByText('Your First Five')).toBeTruthy());
  });

  it('sends an established account to the feed instead of enrolling it', async () => {
    mockPrefs.clear();
    mockCounts.rankings = 12;
    mockCounts.user_media = 40;
    await renderWithProviders(<TasteScreen />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(TAB_ROUTES.feed));
  });
});

describe('Your First Five', () => {
  const arrive = async () => {
    /** Five placed, deliberately returned out of order, so the sorting is the screen's. */
    mockTableRows.rankings = [
      rankedRow('pick-2', 'Second', 2),
      rankedRow('pick-1', 'First', 1),
      rankedRow('pick-3', 'Third', 3),
      rankedRow('pick-4', 'Fourth', 4),
      rankedRow('pick-5', 'Fifth', 5),
    ];
    const view = await renderWithProviders(<TasteScreen />);
    await waitFor(() => expect(view.getByText('Your First Five')).toBeTruthy());
    return view;
  };

  /** **Order is the payoff**, and it belongs to the placement rather than to the response. */
  it('draws the rows in ranked order rather than in the order they arrived', async () => {
    const view = await arrive();

    await waitFor(() => expect(view.getByText('First')).toBeTruthy());
    expect(view.getByText('Second')).toBeTruthy();

    const rows = view
      .getAllByText(/^(First|Second|Third|Fourth|Fifth)$/)
      .map((n) => n.props.children);
    expect(rows).toEqual(['First', 'Second', 'Third', 'Fourth', 'Fifth']);
  });

  it('says what the five bought without explaining the algorithm again', async () => {
    const view = await arrive();

    expect(view.getByText(/This is just the start/)).toBeTruthy();
    expect(view.queryByText(/comes from where this lands/)).toBeNull();
  });

  /**
   * One primary action. A fork at the payoff — Explore For You beside Find people — is
   * what made the social half of onboarding optional in the first place.
   */
  it('offers one way on, and does not fork into the app', async () => {
    const view = await arrive();

    expect(view.getByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Explore For You' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Find people' })).toBeNull();
  });

  /**
   * The write side of the reporting fix: the outcome is recorded by the screen that
   * watched it happen, at each of the two exits past the ranking run.
   */
  it('records that the ranking run was completed', async () => {
    const view = await arrive();
    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(mockPrefs.get('user-1.onboarding.rankingOutcome')).toBe('completed'),
    );
  });

  it('continues into the People step rather than into the app', async () => {
    const view = await arrive();
    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));

    expect(mockReplace).toHaveBeenCalledWith('/onboarding/people');
  });
});

describe('the way out', () => {
  /**
   * **The stranding this codebase has already paid for once.**
   *
   * Five rankings is a hard requirement to reach the next control, so the picker is the
   * only screen in the flow that could hold somebody indefinitely: somebody who cannot
   * think of five movies they have seen must not be held here forever.
   */
  it('lets somebody leave who cannot think of five', async () => {
    const view = await open();
    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));

    // Into the social step, not out of onboarding: declining the ranking is not declining
    // the flow, and the People step still has something to offer.
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/people');
  });

  it('records that the ranking run was left, so the completion says so', async () => {
    const view = await open();
    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));

    await waitFor(() =>
      expect(mockPrefs.get('user-1.onboarding.rankingOutcome')).toBe('skipped'),
    );
  });

  it('offers a way out of the account itself, which routing makes unreachable otherwise', async () => {
    const view = await open();
    expect(view.getByText('Use a different account')).toBeTruthy();
  });
});
