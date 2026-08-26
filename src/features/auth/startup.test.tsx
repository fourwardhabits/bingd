import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { useEffect, type ReactNode } from 'react';

/**
 * **What the app is doing during the founder's ~20 second blank startup on build 4.**
 *
 * The report was a screen of blank paper for about twenty seconds on opening the app,
 * and the tempting reading — one slow await, or a render loop — is wrong in both
 * directions. There is no loop: the measurements below hold the tree still and count, and
 * the auth core settles in a handful of renders and one navigation and then does nothing
 * at all. And the slow thing was never *drawn*.
 *
 * Two facts compose into the blank:
 *
 *   1. `nextRoute` deliberately moves nobody until the first-run check answers, so on
 *      every cold start the navigator's only route for a while is `/`.
 *   2. `app/index.tsx` returned `null` there, on the reasoning that `AuthStatusOverlay`
 *      covers the wait. The overlay covers `loading` and `error` — and this window is
 *      *after* both, once the session is `ready` and routing is still deciding.
 *
 * So the app was not frozen, it was unrendered: nothing on screen, by construction, for
 * however long the check took. `use-taste-onboarding.ts` bounds how long that can be;
 * these assert the other half — that the window has something in it, and that the guard
 * which owns it becomes quiescent rather than working while it waits.
 */

const mockReplace = jest.fn();
const mockReads = { profile: 0, rankings: 0, userMedia: 0 };
const mockAuthCb: { current: ((event: string, session: unknown) => void) | null } = {
  current: null,
};
const mockSession = { user: { id: 'user-1', email: 'someone@example.com' } };
/** Tables whose read never settles — the shape of an unreachable backend on a phone. */
const mockHangs = new Set<string>();

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn(), back: jest.fn() }),
  useSegments: () => [],
}));

jest.mock('@/lib/supabase', () => ({
  // `AuthProvider` also listens for the app's own sign-out signal, for the exit that
  // cannot wait for Supabase's. Unused here; present so the provider can subscribe.
  onLocalSignOut: () => () => {},
  startSessionRefresh: () => () => {},
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: mockSession } }),
      onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
        mockAuthCb.current = callback;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
    from: (table: string) => {
      const run = () => {
        if (mockHangs.has(table)) return new Promise(() => {});
        if (table === 'profiles') {
          mockReads.profile += 1;
          return Promise.resolve({
            data: {
              id: 'user-1',
              username: 'sai',
              display_name: 'Sai',
              bio: null,
              avatar_path: null,
              visibility: 'public',
            },
            error: null,
          });
        }
        if (table === 'rankings') mockReads.rankings += 1;
        if (table === 'user_media') mockReads.userMedia += 1;
        return Promise.resolve({ count: 0, data: [], error: null });
      };
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'order', 'limit']) {
        chain[method] = () => chain;
      }
      chain.maybeSingle = run;
      chain.then = (
        resolve: (value: unknown) => unknown,
        reject?: (error: unknown) => unknown,
      ) => run().then(resolve, reject);
      return chain;
    },
  },
}));

jest.mock('@/lib/prefs', () => ({
  readPref: () => Promise.resolve(null),
  writePref: () => Promise.resolve(),
}));
jest.mock('@/lib/analytics', () => ({ identify: jest.fn(), track: jest.fn() }));
jest.mock('@/lib/monitoring', () => ({ identifyForMonitoring: jest.fn() }));

// eslint-disable-next-line import/first
import { AuthProvider, useAuth, useAuthRouting } from './session';
// Not colocated with the route: everything under app/ is bundled by expo-router's
// require.context. See app-directory.test.ts.
// eslint-disable-next-line import/first
import Index from '../../../app/index';

const renders = { count: 0 };

function Guard() {
  const auth = useAuth();
  useAuthRouting();
  // Counted from an effect with no dependency array, which runs after every committed
  // render — the same number, arrived at without writing to module state mid-render.
  useEffect(() => {
    renders.count += 1;
  });
  return <Text>{auth.status}</Text>;
}

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
};

const idle = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

beforeEach(() => {
  mockReplace.mockReset();
  mockHangs.clear();
  renders.count = 0;
  mockReads.profile = 0;
  mockReads.rankings = 0;
  mockReads.userMedia = 0;
});

describe('the route the app launches on', () => {
  /**
   * The blank itself, as the one assertion that would have caught it.
   *
   * `/` is the only route the navigator has between the session resolving and routing
   * deciding, and it is reached on *every* cold start — so whatever it draws is the app's
   * first impression of itself. It drew nothing.
   */
  it('shows the wait rather than an empty screen', async () => {
    const view = await render(<Index />);

    expect(view.getByLabelText('Loading')).toBeTruthy();
  });
});

/**
 * **Does the guard above every screen settle, or does it keep working?**
 *
 * The founder's phone became noticeably hot during ordinary use, and a route guard that
 * re-runs is one of the few things mounted above every tab that could do that. It is also
 * the one that would explain slow navigation and repeated queries at the same time, so it
 * is worth measuring rather than reasoning about — these count renders and navigations
 * across an idle window instead of asserting a single outcome.
 */
describe('what the route guard does after it has decided', () => {
  it('routes once and then stops', async () => {
    render(<Guard />, { wrapper });
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    await idle(300);

    const settledRenders = renders.count;
    const settledReplaces = mockReplace.mock.calls.length;

    await idle(1000);

    // Quiescent: an idle second costs nothing at all.
    expect(renders.count).toBe(settledRenders);
    expect(mockReplace.mock.calls.length).toBe(settledReplaces);
    // And it took one decision to get there, not a sequence of them.
    expect(settledReplaces).toBe(1);
    expect(mockReads.profile).toBe(1);
  });

  /**
   * A token refresh is the most frequent event in a long session — `startSessionRefresh`
   * arms it on every foreground — so an auth callback that re-routed or re-read the
   * profile would be a cost paid over and over on a screen nobody was touching.
   */
  it('does not re-route or re-read the profile when the session token rolls', async () => {
    render(<Guard />, { wrapper });
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    await idle(300);

    const before = { renders: renders.count, replaces: mockReplace.mock.calls.length };

    await act(async () => {
      mockAuthCb.current?.('TOKEN_REFRESHED', mockSession);
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    expect(mockReplace.mock.calls.length).toBe(before.replaces);
    expect(renders.count).toBe(before.renders);
    expect(mockReads.profile).toBe(1);
  });

  /**
   * The invariant the whole startup tranche exists for: **the shell may not wait on
   * optional work.** A first-run check that never comes back used to mean a navigator
   * with nowhere to go, for the life of the process. It is bounded now, so the guard
   * still reaches a decision — and the decision is the one a failure already produced.
   */
  it('still reaches a destination when the first-run check never comes back', async () => {
    jest.useFakeTimers();
    try {
      mockHangs.add('rankings');
      render(<Guard />, { wrapper });

      await act(async () => {
        await Promise.resolve();
      });
      expect(mockReplace).not.toHaveBeenCalled();

      await act(async () => {
        jest.advanceTimersByTime(4000);
      });
      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/feed'));
    } finally {
      jest.useRealTimers();
    }
  });
});
