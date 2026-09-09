import { fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { diagnosticsAvailable } from '@/features/diagnostics/availability';
import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import RecommendationsScreen from '../../../app/(tabs)/recommendations';

/**
 * **What For You says to a stranger** (pre-GTM convergence, 2026-09-07).
 *
 * Three findings from the product audit, on one screen:
 *
 *   1. A long press on a poster put `score 0.412`, anchor contributions and the
 *      popularity prior in front of anybody holding a built binary. The sentence
 *      `headlineFor` derives is the whole of what a reader is owed, on the store and on
 *      the community beta alike; the working survives under `__DEV__` only.
 *   2. A wall drawn from the popularity fallback said nothing about being one, so a
 *      screen called For You presented last week's trending page as personalisation.
 *   3. Nothing led an isolated account to People. `PEOPLE_DISCOVERY` is the parameter
 *      the end of onboarding and the empty Feed now arrive on, and this screen has to
 *      honour it on a first visit *and* on a tab that is already mounted.
 */

const mockPush = jest.fn();
const mockSetParams = jest.fn();
const mockRpc = jest.fn();
let mockRpcResults: Record<string, unknown> = {};
/** What `useLocalSearchParams` answers — the URL this arrival came in on. */
let mockParams: Record<string, string> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      return Promise.resolve({ data: mockRpcResults[name] ?? null, error: null });
    },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        gt: () => chain,
        in: () => chain,
        limit: () => chain,
        order: () => chain,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null }),
      };
      return chain;
    },
  },
}));

jest.mock('expo-router', () => ({
  useFocusEffect: () => {},
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({
    push: mockPush,
    replace: () => {},
    back: () => {},
    // Behaves like the router: a consumed parameter is gone from the next read, which
    // is what the already-mounted case below depends on.
    setParams: (next: Record<string, string | undefined>) => {
      mockSetParams(next);
      const merged: Record<string, string> = { ...mockParams };
      for (const [key, value] of Object.entries(next)) {
        if (value === undefined) delete merged[key];
        else merged[key] = value;
      }
      mockParams = merged;
    },
  }),
  Stack: { Screen: () => null },
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => 'operation-id' }));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({
    id: 'user-1',
    username: 'sai',
    display_name: 'Sai',
    avatar_path: null,
    avatarUri: null,
  }),
}));

/**
 * Which build the long press happens on.
 *
 * The gate is `__DEV__` and nothing else (founder decision, 2026-09-07): a dev client
 * attached to Metro keeps the working, and every built binary — community beta included —
 * gets the sentence. Jest runs with `__DEV__` true, so the default here is the built
 * binary and a test opts back into development. The screen reads the global at the
 * moment of the press, which is what makes flipping it between tests honest.
 */
const dev = globalThis as unknown as { __DEV__: boolean };
const ORIGINAL_DEV = dev.__DEV__;

/**
 * One title on the wall, scored on an anchor, so the sentence has something to say and
 * the diagnostics have something to leak.
 */
const item = {
  mediaItemId: 'film-1',
  title: 'Inception',
  year: 2010,
  posterPath: null,
  kind: 'movie',
  genres: ['Science Fiction'],
  language: 'en',
  popularity: 300,
  explanation: {
    total: 0.412,
    anchors: [{ mediaItemId: 'heat', title: 'Heat', position: 1, contribution: 0.4 }],
    genre: null,
    language: null,
    popularity: 0.31,
    lead: 'anchors',
  },
};

const mockSlate = {
  items: [item],
  candidatePool: [],
  anchorsUsed: 1,
  lowData: false,
  popularityOnly: false,
  taste: { genres: new Map(), languages: new Map(), sampleSize: 2 },
};

jest.mock('@/features/recommendations/use-for-you', () => ({
  useForYou: () => ({
    data: mockSlate,
    isPending: false,
    isError: false,
    refetch: () => Promise.resolve(),
  }),
}));

const open = async () => {
  const view = await renderWithProviders(<RecommendationsScreen />);
  await waitFor(() => expect(view.getByLabelText(/^Showing /)).toBeTruthy());
  return view;
};

/** What the category control says it is showing, which is the only place that is stated. */
const showing = (view: Awaited<ReturnType<typeof open>>) =>
  view.getByLabelText(/^Showing /).props.accessibilityLabel;

beforeEach(() => {
  mockPush.mockReset();
  mockSetParams.mockReset();
  mockRpc.mockReset();
  mockParams = {};
  dev.__DEV__ = false;
  mockSlate.lowData = false;
  mockSlate.popularityOnly = false;
  mockSlate.anchorsUsed = 1;
  mockRpcResults = {
    my_notifications: [],
    recommendations_to_me: [],
    recommendation_requests: { total: 0, senders: [] },
    people_mutuals: [],
    people_taste_matches: [],
  };
  jest.restoreAllMocks();
});

afterAll(() => {
  dev.__DEV__ = ORIGINAL_DEV;
});

describe('why this tile is here, on a long press', () => {
  const holdInception = async (view: Awaited<ReturnType<typeof open>>) => {
    await fireEvent(view.getByLabelText(/^Inception/), 'longPress');
  };

  it('gives a store build the sentence and nothing else', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const view = await open();

    await holdInception(view);

    expect(alert).toHaveBeenCalledTimes(1);
    const [title, body] = alert.mock.calls[0] as [string, string];
    expect(title).toBe('Inception');
    expect(body).toBe('Because you loved Heat');
  });

  it('never shows a reader a weight, a score or the engine’s vocabulary', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const view = await open();

    await holdInception(view);

    const body = String(alert.mock.calls[0]?.[1]);
    // The four lines the panel used to print, by the words that made them internal.
    expect(body).not.toMatch(/score/i);
    expect(body).not.toMatch(/anchors?:/i);
    expect(body).not.toMatch(/popularity prior/i);
    expect(body).not.toMatch(/0\.\d{2,3}/);
  });

  it('gives a community beta build the sentence too, whatever Diagnostics allows', async () => {
    // A beta build is a built binary: `__DEV__` false, while the Diagnostics sheet's own
    // gate (`diagnosticsAvailable`, beta and below) is still open. The long press must
    // not follow that wider gate — the founder's ruling is that a beta tester holding a
    // poster is a stranger for this purpose.
    expect(diagnosticsAvailable).toBe(true);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const view = await open();

    await holdInception(view);

    const body = String(alert.mock.calls[0]?.[1]);
    expect(body).toBe('Because you loved Heat');
    expect(body).not.toMatch(/score|anchors?:|popularity prior/i);
  });

  it('keeps the working in local development only', async () => {
    dev.__DEV__ = true;
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const view = await open();

    await holdInception(view);

    const body = String(alert.mock.calls[0]?.[1]);
    // The sentence still leads — the founder reads the same thing a reader would,
    // and then the arithmetic under it.
    expect(body.startsWith('Because you loved Heat')).toBe(true);
    expect(body).toMatch(/score 0\.412/);
    expect(body).toMatch(/popularity prior/);
  });
});

describe('a wall that is not yet the reader’s', () => {
  const POPULAR = 'Popular right now while bingd. learns your taste.';
  const LEARNING = 'bingd. is still learning your taste.';

  it('calls the wall popular only when it genuinely came from the popularity fallback', async () => {
    // No anchor, and nothing social on the wall: the hook's `popularityOnly`.
    mockSlate.lowData = true;
    mockSlate.popularityOnly = true;
    mockSlate.anchorsUsed = 0;
    const view = await open();

    expect(view.getByText(POPULAR)).toBeTruthy();
    expect(view.queryByText(LEARNING)).toBeNull();
    // The wall itself is untouched: the same tile, drawn the same way.
    expect(view.getByLabelText(/^Inception/)).toBeTruthy();
  });

  it('does not call a wall popular when a followed reader’s title is on it', async () => {
    // Codex review of #122: no anchor resolved, but `social_candidates` contributed a
    // title that is on screen. Still a thin taste, so still worth a word — but not
    // "popular", which would name a source the wall does not have.
    mockSlate.lowData = true;
    mockSlate.popularityOnly = false;
    mockSlate.anchorsUsed = 0;
    const view = await open();

    expect(view.getByText(LEARNING)).toBeTruthy();
    expect(view.queryByText(POPULAR)).toBeNull();
    expect(view.getByLabelText(/^Inception/)).toBeTruthy();
  });

  it('says nothing once an anchor has resolved', async () => {
    const view = await open();

    expect(view.queryByText(POPULAR)).toBeNull();
    expect(view.queryByText(LEARNING)).toBeNull();
  });
});

/**
 * **This screen no longer answers for People** (founder §A16, 2026-09-08).
 *
 * Two tests used to live here: For You opening on People when `show=people` arrived, and
 * the same thing on an already-mounted tab. Both moved to `FeedMode.test.tsx` with the
 * surface, because `peopleDiscovery` now points at the Feed route.
 *
 * What is left is the half that still belongs to this screen and is easy to get wrong in a
 * move: a stale link, a queued navigation or a restored deep link can still deliver
 * `show=people` here, and the answer has to be that nothing happens. A screen that read a
 * parameter it can no longer act on would be a screen that swallowed it.
 */
describe('a stale request for People', () => {
  it('opens on Movies and leaves the parameter alone', async () => {
    mockParams = { show: 'people' };
    const view = await open();

    expect(showing(view)).toBe('Showing Movies');
    expect(view.getByLabelText(/^Inception/)).toBeTruthy();
    // Not consumed: this screen has no claim on it, and clearing a parameter it does not
    // act on would swallow a navigation somebody else may still be resolving.
    expect(mockSetParams).not.toHaveBeenCalled();
  });

  it('opens on Movies when nobody asked for anything, as it always has', async () => {
    const view = await open();

    expect(showing(view)).toBe('Showing Movies');
    expect(mockSetParams).not.toHaveBeenCalled();
  });
});
