import { fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

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
 *      popularity prior in front of anybody holding a store build. The sentence
 *      `headlineFor` derives is the whole of what a reader is owed; the working stays
 *      behind the diagnostics gate, for the founder on a beta build.
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
/** The diagnostics gate, as a beta build (true) or a store build (false) would have it. */
let mockDiagnostics = false;

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
    setParams: (...args: unknown[]) => mockSetParams(...args),
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

// A getter, so each test can decide which build it is on. The screen reads the binding
// at the moment of the long press, which is what makes flipping it between tests work.
jest.mock('@/features/diagnostics/availability', () => ({
  get diagnosticsAvailable() {
    return mockDiagnostics;
  },
}));

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
  mockDiagnostics = false;
  mockSlate.lowData = false;
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

  it('keeps the working for a build that can open Diagnostics', async () => {
    mockDiagnostics = true;
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
  const LINE = 'Popular right now while bingd. learns your taste.';

  it('says so, quietly, when the slate had no anchor to work from', async () => {
    mockSlate.lowData = true;
    mockSlate.anchorsUsed = 0;
    const view = await open();

    expect(view.getByText(LINE)).toBeTruthy();
    // The wall itself is untouched: the same tile, drawn the same way.
    expect(view.getByLabelText(/^Inception/)).toBeTruthy();
  });

  it('says nothing once an anchor has resolved', async () => {
    const view = await open();

    expect(view.queryByText(LINE)).toBeNull();
  });
});

describe('arriving to find people', () => {
  it('opens on People when sent here for that, and consumes the parameter', async () => {
    mockParams = { show: 'people' };
    const view = await open();

    await waitFor(() => expect(showing(view)).toBe('Showing People'));
    // Consumed on arrival, so a later choice of Movies is not undone by a value still
    // sitting in the URL — the profile tab's `awards` rule, applied here.
    expect(mockSetParams).toHaveBeenCalledWith({ show: undefined });
    // People is the discovery lists, not the wall.
    expect(view.queryByLabelText(/^Inception/)).toBeNull();
  });

  it('opens on Movies, as it always has, when nobody asked for People', async () => {
    const view = await open();

    expect(showing(view)).toBe('Showing Movies');
    expect(mockSetParams).not.toHaveBeenCalled();
  });
});
