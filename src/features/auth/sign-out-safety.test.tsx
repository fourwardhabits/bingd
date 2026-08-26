/**
 * The sign-out blank screen.
 *
 * The founder's report is "signing out sometimes produces a blank screen, sometimes
 * crashes the app entirely". Both are one defect with two presentations, and the reason
 * no test caught it is visible in every screen suite in this repository: they all mock
 * `@/features/auth`, so **no test had ever rendered a protected screen against the real
 * provider while the session ended underneath it**.
 *
 * The mechanism, asserted in order below:
 *
 *   1. `useCurrentProfile` throws outside a ready session. That is deliberate and it
 *      stays — twenty screens open with it and rely on it to avoid null checks.
 *   2. `supabase.auth.signOut()` emits `SIGNED_OUT` while one of those screens is still
 *      mounted, so the throw happens *during render*, before any router effect runs.
 *   3. With no error boundary anywhere in the app, that unmounts the whole tree and
 *      leaves an empty host view for the rest of the process.
 *
 * `RouteErrorBoundary` fixes (3) and `Stack.Protected` in `app/_layout.tsx` fixes (2).
 * Both are asserted here in the smallest form that still exercises the real provider:
 * `Unguarded` is the app as it was, and `Gate` is what the route guard does. A test
 * against the actual `<Stack>` would be a test of expo-router's navigator rather than of
 * this decision, and it is the decision — mount nothing protected unless `ready` — that
 * has to keep being true.
 */
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text as RNText, View } from 'react-native';

const mockAuth: {
  listener: ((event: string, session: unknown) => void) | null;
  session: unknown;
} = { listener: null, session: { user: { id: 'user-1', email: 'a@b.c' } } };

jest.mock('@/lib/supabase', () => ({
  // `AuthProvider` also listens for the app's own sign-out signal, for the exit that
  // cannot wait for Supabase's. Unused here; present so the provider can subscribe.
  onLocalSignOut: () => () => {},
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: mockAuth.session } }),
      onAuthStateChange: (cb: (event: string, s: unknown) => void) => {
        mockAuth.listener = cb;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: {
                id: 'user-1',
                username: 'sai',
                display_name: 'Sai',
                bio: null,
                avatar_path: null,
                visibility: 'public',
              },
              error: null,
            }),
        }),
      }),
    }),
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('@/lib/analytics', () => ({ identify: jest.fn(), track: jest.fn() }));

// `mock`-prefixed so the factory below may close over it — jest's own escape hatch for
// a spy a test needs to assert against.
const mockReport = jest.fn();
jest.mock('@/lib/monitoring', () => ({
  identifyForMonitoring: jest.fn(),
  reportHandled: (...args: unknown[]) => mockReport(...args),
}));

jest.mock('@/features/onboarding/use-taste-onboarding', () => ({
  useTasteOnboarding: () => ({ data: { needed: false }, isPending: false }),
}));

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { RouteErrorBoundary } from './RouteErrorBoundary';
import { AuthProvider, useAuth, useCurrentProfile } from './session';

/** Stands in for every screen in `app/` that opens with `useCurrentProfile()`. */
function ProtectedScreen() {
  const profile = useCurrentProfile();
  return (
    <View>
      <RNText>{profile.username}</RNText>
    </View>
  );
}

/**
 * The app as it was: every route mounted regardless of auth state, with a boundary
 * added and nothing else. This is what isolates the throw.
 */
function Unguarded({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  return <RouteErrorBoundary resetKey={auth.status}>{children}</RouteErrorBoundary>;
}

/**
 * What `app/_layout.tsx` does with `Stack.Protected`, in the smallest form a test can
 * hold: the protected subtree is not rendered at all once the status leaves `ready`.
 */
function Gate({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  return (
    <RouteErrorBoundary resetKey={auth.status}>
      {auth.status === 'ready' ? children : <RNText>signed out</RNText>}
    </RouteErrorBoundary>
  );
}

/**
 * Mounts and waits for a *ready* session.
 *
 * The wait is the point rather than boilerplate: reaching `ready` takes two resolutions
 * — `getSession`, then the profile query — and a test that asserted straight after
 * `render` would be asserting against `loading`, where `useCurrentProfile` throws for a
 * reason that has nothing to do with signing out. Every test below has to start from a
 * screen that is genuinely showing somebody's account, or it proves nothing.
 */
const mount = async (ui: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <AuthProvider>{ui}</AuthProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByText('sai')).toBeTruthy());
  return view;
};

/** What `supabase.auth.signOut()` does: emits SIGNED_OUT with a null session. */
const signOutHappens = async () => {
  mockAuth.session = null;
  await act(async () => {
    mockAuth.listener?.('SIGNED_OUT', null);
  });
};

beforeEach(() => {
  mockAuth.session = { user: { id: 'user-1', email: 'a@b.c' } };
  mockAuth.listener = null;
  mockReport.mockClear();
});

describe('the throw itself, which is a contract and stays', () => {
  it('raises when a protected screen renders outside a ready session', async () => {
    await mount(
      <Unguarded>
        <ProtectedScreen />
      </Unguarded>,
    );
    await signOutHappens();

    /**
     * The defect, caught. Without a boundary this exception has nowhere to go: React
     * unmounts the tree and the app shows an empty root — the founder's blank screen.
     * Here the boundary holds it, which is what proves both that the throw is real and
     * that it is now survivable.
     */
    expect(screen.queryByText('sai')).toBeNull();
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    // And it is reported, so a tester saying "it broke" is a session somebody can find.
    expect(mockReport).toHaveBeenCalledWith(expect.any(Error), { stage: 'route_render' });
  });
});

describe('the gate, which is why the boundary should never be reached', () => {
  it('stops rendering the protected screen in the same commit the session ends', async () => {
    await mount(
      <Gate>
        <ProtectedScreen />
      </Gate>,
    );
    await signOutHappens();

    expect(screen.getByText('signed out')).toBeTruthy();
    // Nothing threw, so nothing was caught and nothing was reported.
    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('shows no trace of the previous account once the session is gone', async () => {
    await mount(
      <Gate>
        <ProtectedScreen />
      </Gate>,
    );
    await signOutHappens();

    // H3.8: a protected route must never render with null auth, and the name of the
    // person who just left must not survive on screen for the next one.
    expect(screen.queryByText('sai')).toBeNull();
  });
});

describe('the boundary recovering on its own', () => {
  it('drops a caught error when the auth status changes underneath it', async () => {
    /**
     * The recovery that makes this a fix rather than a nicer error screen.
     *
     * `useAuthRouting` lives *above* the boundary in `app/_layout.tsx` — which is
     * precisely why the boundary is not an `ErrorBoundary` export from that layout —
     * so it keeps running while the apology is on screen and replaces to
     * `/(auth)/sign-in`. `resetKey` is the auth status, so the boundary clears itself
     * the moment that state moves. Nobody has to tap anything.
     */
    function Flaky({ boom }: { boom: boolean }) {
      if (boom) throw new Error('render failed');
      return <RNText>recovered</RNText>;
    }

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await render(
      <QueryClientProvider client={client}>
        <RouteErrorBoundary resetKey="ready">
          <Flaky boom />
        </RouteErrorBoundary>
      </QueryClientProvider>,
    );

    // `view` rather than the `screen` singleton: this test renders its own tree without
    // the provider, and the singleton belongs to whichever render ran last.
    expect(view.getByText('Something went wrong')).toBeTruthy();

    await act(async () => {
      view.rerender(
        <QueryClientProvider client={client}>
          <RouteErrorBoundary resetKey="signed-out">
            <Flaky boom={false} />
          </RouteErrorBoundary>
        </QueryClientProvider>,
      );
    });

    expect(view.getByText('recovered')).toBeTruthy();
  });
});
