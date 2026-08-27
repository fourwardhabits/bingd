import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

/**
 * **The founder's first physical blocker, as arithmetic: a session that succeeds and a UI
 * that does not follow it.**
 *
 *     sign in
 *     → "Signing in…" indefinitely
 *     → force-close
 *     → reopen
 *     → signed in, app opens normally
 *
 * Authentication is therefore working. What was not was the handover between the two
 * independent things that can answer "is there a session": the hydration read taken once at
 * mount, and `onAuthStateChange`, which fires whenever one is created. Nothing ordered them
 * with respect to each other, and the hydration read asks the *older* question — what was on
 * the device before anything happened.
 *
 * So these are the reorderings, each asserted end to end from the provider's state machine
 * through `nextRoute` to a `router.replace`:
 *
 *   1. the ordinary order — hydration says none, the callback delivers a session;
 *   2. **the reorder** — the callback delivers a session and the hydration read answers
 *      `null` afterwards, which used to knock a signed-in person back to `signed-out`;
 *   3. a hydration read that never answers at all, overtaken by the callback;
 *   4. a profile read that lags the session, so `ready` arrives two renders later.
 *
 * None of these is about a slow network. Every one is about the client's own state
 * transitions arriving in an order nobody wrote down.
 */

const mockGetSession = jest.fn();
const mockAuthListener: { current: ((event: string, session: unknown) => void) | null } = {
  current: null,
};
const mockProfile = jest.fn();

jest.mock('@/lib/supabase', () => ({
  startSessionRefresh: () => () => {},
  onLocalSignOut: () => () => {},
  supabase: {
    auth: {
      getSession: () => mockGetSession(),
      onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
        mockAuthListener.current = callback;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => mockProfile() }) }),
    }),
  },
}));

jest.mock('@/lib/analytics', () => ({ identify: jest.fn(), track: jest.fn() }));
jest.mock('@/lib/monitoring', () => ({
  identifyForMonitoring: jest.fn(),
  reportHandled: jest.fn(),
}));

const mockTaste = { needed: false, pending: false };
jest.mock('@/features/onboarding/use-taste-onboarding', () => ({
  useTasteOnboarding: () => ({
    data: mockTaste.pending ? undefined : { needed: mockTaste.needed },
    isPending: mockTaste.pending,
  }),
}));

const mockRouter = { replaced: [] as string[] };
const mockSegments = { current: ['(auth)', 'sign-in'] as readonly string[] };
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: (href: string) => mockRouter.replaced.push(href) }),
  useSegments: () => mockSegments.current,
}));

import { AuthProvider, useAuth, useAuthRouting } from './session';

const PROFILE_ROW = {
  data: {
    id: 'user-1',
    username: 'sai',
    display_name: 'Sai',
    bio: null,
    avatar_path: null,
    visibility: 'public',
  },
  error: null,
};

const SESSION = { user: { id: 'user-1', email: 'a@b.co' } };

function Harness() {
  useAuthRouting();
  const auth = useAuth();
  return <Text>{`status:${auth.status}`}</Text>;
}

const mount = async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <Harness />
      </AuthProvider>
    </QueryClientProvider>,
  );
};

/** What the app does when the credential lands: `onAuthStateChange` fires with a session. */
const signInArrives = async () =>
  act(async () => {
    mockAuthListener.current?.('SIGNED_IN', SESSION);
  });

beforeEach(() => {
  jest.useFakeTimers();
  mockGetSession.mockReset();
  mockProfile.mockReset().mockResolvedValue(PROFILE_ROW);
  mockAuthListener.current = null;
  mockRouter.replaced = [];
  mockSegments.current = ['(auth)', 'sign-in'];
  mockTaste.needed = false;
  mockTaste.pending = false;
});
afterEach(() => jest.useRealTimers());

// ---------------------------------------------------------------------------

describe('a sign-in that succeeds', () => {
  it('reaches the feed without a restart, in the ordinary order', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    await mount();
    await waitFor(() => expect(screen.getByText('status:signed-out')).toBeTruthy());

    await signInArrives();

    // `ready` is the state every route behind the gate needs, and the replace is the
    // transition the founder never saw. Both, or the sign-in has not finished.
    await waitFor(() => expect(screen.getByText('status:ready')).toBeTruthy());
    expect(mockRouter.replaced).toContain('/(tabs)/feed');
  });

  it('survives a profile read that lags the session', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    let releaseProfile: (() => void) | null = null;
    mockProfile.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseProfile = () => resolve(PROFILE_ROW);
        }),
    );

    await mount();
    await signInArrives();

    // The gap the `loading` state exists for: a session with no profile yet is not a
    // signed-out person and must not be routed like one.
    await waitFor(() => expect(screen.getByText('status:loading')).toBeTruthy());
    expect(mockRouter.replaced).not.toContain('/(auth)/sign-in');

    await act(async () => {
      releaseProfile?.();
    });
    await waitFor(() => expect(screen.getByText('status:ready')).toBeTruthy());
    expect(mockRouter.replaced).toContain('/(tabs)/feed');
  });
});

describe('when the two answers arrive out of order', () => {
  /**
   * **The regression this file exists for.**
   *
   * The hydration read asks what was on the device *before* the sign-in. Letting it answer
   * afterwards is letting the past overwrite the present: the state machine went
   * `ready` → `signed-out`, `Stack.Protected` removed the tabs, and routing sent the person
   * back to the screen they had just left — with a real session on the device, which is why
   * force-quitting and reopening put them straight into the app.
   */
  it('keeps the session when the hydration read answers null afterwards', async () => {
    let answerHydration: ((value: unknown) => void) | null = null;
    mockGetSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          answerHydration = resolve;
        }),
    );

    await mount();
    await signInArrives();
    await waitFor(() => expect(screen.getByText('status:ready')).toBeTruthy());

    // The stale answer, arriving late and saying there is no session.
    await act(async () => {
      answerHydration?.({ data: { session: null } });
    });

    expect(screen.getByText('status:ready')).toBeTruthy();
    expect(mockRouter.replaced).not.toContain('/(auth)/sign-in');
  });

  it('keeps the session when the hydration read never answers at all', async () => {
    mockGetSession.mockImplementation(() => new Promise(() => {}));

    await mount();
    await signInArrives();
    await waitFor(() => expect(screen.getByText('status:ready')).toBeTruthy());

    // Past the eight-second hydration grace, which resolves to "unreadable". That is a
    // statement about a read, not about an account, and a live session outranks it.
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });

    expect(screen.getByText('status:ready')).toBeTruthy();
    expect(mockRouter.replaced).not.toContain('/(auth)/sign-in');
  });
});

describe('where a fresh session is sent', () => {
  it('goes to create-profile when there is no profile yet', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    mockProfile.mockResolvedValue({ data: null, error: null });

    await mount();
    await signInArrives();

    await waitFor(() => expect(screen.getByText('status:onboarding')).toBeTruthy());
    expect(mockRouter.replaced).toContain('/(auth)/create-profile');
  });

  it('moves nobody while the first-run check is still pending', async () => {
    mockTaste.pending = true;
    mockGetSession.mockResolvedValue({ data: { session: null } });

    await mount();
    await signInArrives();
    await waitFor(() => expect(screen.getByText('status:ready')).toBeTruthy());

    // Deliberate: mounting the feed and then replacing it with the first-run flow is a
    // flash of the wrong screen. Waiting is right, and it is bounded inside the hook.
    expect(mockRouter.replaced).toEqual([]);
  });
});
