import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { TAB_ROUTES } from '@/lib/routes';

import { resetPickFive, resetRankingOutcome } from './pick-five';
import { resetOnboardingStages } from './use-onboarding-stage';
import { resetTasteIntent } from './use-taste-onboarding';

// Not colocated with the route: everything under app/ is bundled by expo-router's
// require.context. See app-directory.test.ts.
import TasteScreen from '../../../app/onboarding/taste';

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
        single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: rows(), error: null, count: mockCounts[table] ?? rows().length }),
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
  // The two screens before the profile form read the account id instead, which is
  // what an `onboarding` session can answer. See `useCurrentUserId`.
  useCurrentUserId: () => 'user-1',
  useAuth: () => ({ status: 'onboarding', userId: 'user-1', email: null }),
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

beforeEach(() => {
  issued = 0;
  mockRpc.mockReset();
  mockReplace.mockReset();
  mockPrefs.clear();
  for (const key of Object.keys(mockTableRows)) delete mockTableRows[key];
  for (const key of Object.keys(mockCounts)) delete mockCounts[key];
  mockRpc.mockImplementation((fn: string) =>
    fn === 'search_titles'
      ? Promise.resolve({ data: [film, series], error: null })
      : Promise.resolve({ data: { status: 'ok' }, error: null }),
  );
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
  // The two stores the two-phase picker added. Both are module-level, like the taste
  // intent map above, so a selection left behind by one test would resume in the next.
  resetPickFive();
  resetRankingOutcome();
  resetOnboardingStages();
});

const callsTo = (fn: string) => mockRpc.mock.calls.filter(([name]) => name === fn);

/**
 * The picker, drawn and ready.
 *
 * The screen waits on two answers before it draws anything — the first-run check and the
 * stored selection — so every test comes through here rather than asserting against a
 * loading frame.
 */
const open = async () => {
  const view = await renderWithProviders(<TasteScreen />);
  await waitFor(() => expect(view.getByText('Get started')).toBeTruthy());
  return view;
};

const search = async (view: Awaited<ReturnType<typeof open>>, term: string) => {
  await fireEvent.changeText(view.getByLabelText('Search for a movie'), term);
  await waitFor(() => expect(view.getByLabelText(/Inception, 2010/)).toBeTruthy());
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

/**
 * The first `n` of the five chosen, placed.
 *
 * The run's cursor is **membership**, not a count: it asks which of *these* movies have
 * been ranked. So a fixture has to say which ones, and cannot get away with a number.
 */
const placed = (n: number) => {
  mockTableRows.rankings = Array.from({ length: n }, (_, index) =>
    rankedRow(`pick-${index + 1}`, `Movie ${index + 1}`, index + 1),
  );
};

/** Five already chosen, restored as a resumed selection rather than five searches. */
const fiveChosen = () =>
  mockPrefs.set(
    'user-1.onboarding.pickFive',
    Array.from({ length: 5 }, (_, n) => ({
      // Deliberately not `film-1`: that is the search fixture's id, and a collision would
      // make a sixth tap a *deselection* of one of the five rather than the ignored tap
      // the test is about.
      id: `pick-${n + 1}`,
      title: `Movie ${n + 1}`,
      year: 2010 + n,
      posterUri: null,
    })),
  );

describe('choosing five, before anything is ranked', () => {
  it('asks for five movies, in the words the founder settled on', async () => {
    const view = await open();

    expect(view.getByText("Pick five movies you've seen.")).toBeTruthy();
    // `film` was the app's own word and `movie` is the founder's. Having one directly
    // above the other on a single screen is what settled it.
    expect(view.queryByText(/five films/i)).toBeNull();
  });

  it('starts at zero of five', async () => {
    const view = await open();
    expect(view.getByLabelText('0 of 5 movies chosen')).toBeTruthy();
  });

  it('offers movies and never a series, because a series cannot be ranked', async () => {
    const view = await open();
    await search(view, 'inception');

    expect(view.queryByText('Inception: The Series')).toBeNull();
  });

  /**
   * **The whole point of the two-phase design**, asserted as an absence.
   *
   * The old screen opened the bucket sheet on every pick. Choosing is its own act now, so
   * nothing is ranked and nothing is even asked until the run is started.
   */
  it('ranks nothing while the reader is still choosing', async () => {
    const view = await open();
    await search(view, 'inception');
    await fireEvent.press(view.getByLabelText(/Inception, 2010/));

    await waitFor(() => expect(view.getByLabelText('1 of 5 movies chosen')).toBeTruthy());
    expect(view.queryByText('How was it?')).toBeNull();
    expect(callsTo('set_bucket')).toHaveLength(0);
    expect(callsTo('rank_start')).toHaveLength(0);
  });

  it('holds the run until the reader asks for it', async () => {
    fiveChosen();
    const view = await open();

    // Five are chosen, so the primary is live. Nothing has started.
    await waitFor(() => expect(view.getByLabelText('5 of 5 movies chosen')).toBeTruthy());
    expect(view.queryByText('How was it?')).toBeNull();

    await fireEvent.press(view.getByRole('button', { name: 'Rank these 5' }));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
  });

  /**
   * A selected poster carries a check and never a number.
   *
   * A badge reading 1 to 5 while somebody is choosing would state an order they have not
   * chosen: selection order is not the ranking, and the ranking is what the next step
   * exists to work out.
   */
  it('marks a chosen movie as selected rather than numbering it', async () => {
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
    const tile = await waitFor(() => view.getByLabelText('Inception'));

    expect(tile.props.accessibilityState.checked).toBe(false);
    await fireEvent.press(tile);

    await waitFor(() =>
      expect(view.getByLabelText('Inception').props.accessibilityState.checked).toBe(true),
    );
    expect(view.queryByText('#1')).toBeNull();
  });

  it('lets a chosen movie be unchosen', async () => {
    const view = await open();
    await search(view, 'inception');
    await fireEvent.press(view.getByLabelText(/Inception, 2010/));
    await waitFor(() => expect(view.getByLabelText('1 of 5 movies chosen')).toBeTruthy());

    await fireEvent.press(view.getByLabelText(/Inception, 2010/));
    await waitFor(() => expect(view.getByLabelText('0 of 5 movies chosen')).toBeTruthy());
  });

  /**
   * A sixth tap is not a replacement and not an error.
   *
   * The remaining cells have gone quiet and the primary is live, so there is nothing
   * honest another tap could mean. Silently swapping one of the five out would change a
   * decision the reader never revisited.
   */
  it('ignores a sixth choice rather than replacing one of the five', async () => {
    fiveChosen();
    const view = await open();
    await waitFor(() => expect(view.getByLabelText('5 of 5 movies chosen')).toBeTruthy());

    await search(view, 'inception');
    await fireEvent.press(view.getByLabelText(/Inception, 2010/));

    expect(view.getByLabelText('5 of 5 movies chosen')).toBeTruthy();
  });
});


describe('a selection that was lost while rankings survived', () => {
  /**
   * **The cursor is membership, not a count**, and this is the sequence that proved it had
   * to be. Independent review found it in the first draft.
   *
   * If the selection write fails after some movies have been ranked, the picker comes back
   * empty and the reader chooses five *different* movies. A cursor of `chosen[ranked]`
   * would then point at index 2 of the new five and silently skip the first two of them —
   * and with five previously ranked, any new selection satisfied the payoff immediately
   * and none of it was ever ranked at all.
   *
   * Asking which of *these* movies have been placed cannot drift like that.
   */
  it('starts at the first of a new selection, even when other movies are already ranked', async () => {
    // Two rankings exist, and they are not among the five about to be chosen: exactly the
    // state a lost `pickFive` write leaves behind.
    mockTableRows.rankings = [
      rankedRow('lost-1', 'Something Else', 1),
      rankedRow('lost-2', 'Another Thing', 2),
    ];
    fiveChosen();

    const view = await open();
    await waitFor(() => expect(view.getByLabelText('5 of 5 movies chosen')).toBeTruthy());
    // Not already running: none of the chosen five has been placed.
    expect(view.queryByText('How was it?')).toBeNull();

    await fireEvent.press(view.getByRole('button', { name: 'Rank these 5' }));

    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    // The first of the five, not the third.
    expect(view.getByText('Movie 1')).toBeTruthy();
  });

  it('does not treat unrelated rankings as progress through the five', async () => {
    mockTableRows.rankings = Array.from({ length: 5 }, (_, index) =>
      rankedRow(`lost-${index + 1}`, `Old ${index + 1}`, index + 1),
    );
    fiveChosen();

    const view = await open();

    // Five unrelated rankings must not satisfy the payoff for a selection none of them
    // belong to.
    await waitFor(() => expect(view.getByLabelText('5 of 5 movies chosen')).toBeTruthy());
    expect(view.queryByText('Your First Five')).toBeNull();
  });
});

describe('the run, which is the real ranking engine', () => {
  const startRun = async () => {
    fiveChosen();
    const view = await open();
    await waitFor(() => expect(view.getByLabelText('5 of 5 movies chosen')).toBeTruthy());
    await fireEvent.press(view.getByRole('button', { name: 'Rank these 5' }));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    return view;
  };

  /**
   * The founder decision this flow exists to honour.
   *
   * The first five may be movies somebody saw fifteen years ago. `LogSheet` follows a
   * bucket save with `log_watched` for today, because the sheet it belongs to displays a
   * date, and that would put five historical movies into this year's Goals. This flow goes
   * straight to `set_bucket`, which writes no date, and `goals.ts` refuses to count a null
   * one.
   */
  it('records no watch date, so an old movie does not land in this year of goals', async () => {
    const view = await startRun();
    await fireEvent.press(view.getByLabelText('I liked it'));

    await waitFor(() => expect(callsTo('set_bucket')).toHaveLength(1));
    expect(callsTo('log_watched')).toHaveLength(0);
  });

  it('drives the real comparison session rather than a copy of it', async () => {
    const view = await startRun();
    await fireEvent.press(view.getByLabelText('I liked it'));

    // `rank_start` is the same session opener the Log tab drives. Nothing about the
    // ranking algorithm is reimplemented by onboarding.
    await waitFor(() => expect(callsTo('rank_start')).toHaveLength(1));
    expect(callsTo('rank_start')[0][1]).toMatchObject({
      p_media_item_id: 'pick-1',
      p_bucket: 'loved',
    });
  });

  it('says how far along the run is, which the sheets cannot', async () => {
    fiveChosen();
    placed(2);
    const view = await renderWithProviders(<TasteScreen />);

    /**
     * `includeHiddenElements`, because the backdrop is behind an open sheet.
     *
     * The run opens the bucket question immediately, and RNTL treats everything behind a
     * modal as hidden from accessibility — correctly, since that is exactly what it is to
     * a screen reader. The backdrop is still the thing under test: it is what tells the
     * reader they are on the third of five while the sheet asks about one movie.
     */
    await waitFor(() =>
      expect(view.getByText('Ranking your 5', { includeHiddenElements: true })).toBeTruthy(),
    );
    expect(
      view.getByLabelText('2 of 5 movies chosen', { includeHiddenElements: true }),
    ).toBeTruthy();
  });
});

describe('resuming', () => {
  /**
   * The selection is the one thing in this flow the database has no record of until each
   * title is ranked, so it is the one thing written down. Somebody who closed the app
   * after ranking two of five must not be asked to choose five again.
   */
  it('comes back to the run rather than to an empty grid', async () => {
    fiveChosen();
    placed(3);
    const view = await renderWithProviders(<TasteScreen />);

    await waitFor(() =>
      expect(view.getByText('Ranking your 5', { includeHiddenElements: true })).toBeTruthy(),
    );
    expect(view.queryByText('Get started')).toBeNull();
  });

  /**
   * **The cursor is the count.** There is no stored index, so a placement that failed
   * leaves the number where it was and brings the same title back rather than skipping it.
   */
  it('takes the next movie from the ranked count rather than a stored cursor', async () => {
    fiveChosen();
    placed(3);
    const view = await renderWithProviders(<TasteScreen />);

    await waitFor(() =>
      expect(view.getByText('Movie 4', { includeHiddenElements: true })).toBeTruthy(),
    );
  });

  it('reads progress from the data rather than from a local counter', async () => {
    fiveChosen();
    placed(5);
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
    fiveChosen();
    /**
     * All five of *the chosen* placed, and deliberately returned out of order.
     *
     * The ids have to be the chosen ones: the payoff is reached by every chosen movie
     * having been placed, which is membership rather than a count. The disordered response
     * is what makes the assertion below about the screen's own sorting.
     */
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

    // Waited on rather than asserted immediately: the heading renders as soon as the five
    // are known to be placed, and the rows follow when the ranked list resolves. CI found
    // the difference on a slower machine; the local run had been hiding it.
    await waitFor(() => expect(view.getByText('First')).toBeTruthy());
    expect(view.getByText('Second')).toBeTruthy();

    // The ordinal belongs to the placement, not to the response.
    const rows = view.getAllByText(/^(First|Second|Third|Fourth|Fifth)$/).map((n) => n.props.children);
    expect(rows).toEqual(['First', 'Second', 'Third', 'Fourth', 'Fifth']);
  });

  it('says what the five bought without explaining the algorithm again', async () => {
    const view = await arrive();

    expect(view.getByText(/This is just the start/)).toBeTruthy();
    // The score is explained once, under the first reveal. A second explanation here would
    // turn a reward into a lesson.
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
   * watched it happen, at each of the two exits past the ranking half.
   */
  it('records that the ranking half was completed', async () => {
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
   * Five is a hard requirement to reach the next control, so the picker is the only screen
   * in the flow that could hold somebody indefinitely. The old screen carried this button
   * with a comment that has not stopped being true: somebody who cannot think of five
   * movies they have seen must not be held here forever.
   */
  it('lets somebody leave who cannot think of five', async () => {
    const view = await open();
    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));

    // Into the social step, not out of onboarding: declining the ranking is not declining
    // the flow, and the People step still has something to offer.
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/people');
  });


  it('records that the ranking half was left, so the completion says so', async () => {
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
