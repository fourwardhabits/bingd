import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

/**
 * The one stall the request deadline cannot reach: reading the session off the device.
 *
 * **Independent review 49's second major finding.** Hydration is `storage.getItem` and
 * nothing else — no fetch has started, so no network budget applies — and
 * `SecureStore.getItemAsync` is a promise iOS does not promise to settle. One that does not
 * used to leave `sessionLoaded` false for the life of the process: the navigator never
 * mounts, the loading overlay never leaves, and every later storage operation on that key
 * queues behind the same unresolved read. A blank app, with a perfectly healthy backend.
 *
 * The answer is deliberately **not** "assume signed out". That is a claim about somebody's
 * account, and acting on it would send a person with a working session to the sign-in
 * screen. It is `error` — *we could not find out* — which is a state this provider already
 * had, and which `AuthStatusOverlay` already draws with a retry.
 */

const mockGetSession = jest.fn();
const mockAuthListener: { current: ((event: string, session: unknown) => void) | null } = {
  current: null,
};

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
}));

jest.mock('@/lib/analytics', () => ({ identify: jest.fn(), track: jest.fn() }));
jest.mock('@/lib/monitoring', () => ({
  identifyForMonitoring: jest.fn(),
  reportHandled: jest.fn(),
}));
jest.mock('@/features/onboarding/use-taste-onboarding', () => ({
  useTasteOnboarding: () => ({ data: { needed: false }, isPending: false }),
}));

import { AuthProvider, useAuth } from './session';

function Status() {
  const auth = useAuth();
  return <Text>{`status:${auth.status}`}</Text>;
}

const mount = async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <Status />
      </AuthProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  jest.useFakeTimers();
  mockGetSession.mockReset();
  mockAuthListener.current = null;
});
afterEach(() => jest.useRealTimers());

describe('reading the session off the device', () => {
  it('resolves to a session when the store answers', async () => {
    mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' } } } });

    await mount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    await waitFor(() => expect(screen.getByText('status:ready')).toBeTruthy());
  });

  /**
   * **The hang.** A Keychain read that never answers used to mean an app that never drew
   * anything. It now becomes the state that has a retry attached to it.
   */
  it('becomes an error rather than a permanent loading screen', async () => {
    mockGetSession.mockReturnValue(new Promise(() => {}));

    await mount();
    expect(screen.getByText('status:loading')).toBeTruthy();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(9_000);
    });

    expect(screen.getByText('status:error')).toBeTruthy();
  });

  /**
   * A rejection is the same class of answer as silence — the store could not be read — and
   * it used to be worse, because the `.then` chain simply never ran and nothing caught it.
   */
  it('treats a store that rejects the same way', async () => {
    mockGetSession.mockRejectedValue(new Error('User interaction is not allowed.'));

    await mount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText('status:error')).toBeTruthy();
  });

  /**
   * **And it is not "signed out".** Assuming that would take a person with a working
   * session to the sign-in screen, where they would be told the handle they already own is
   * taken — the exact confusion `AuthState`'s `error` case was introduced to prevent.
   */
  it('never reports a store it could not read as an absent session', async () => {
    mockGetSession.mockReturnValue(new Promise(() => {}));

    await mount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(9_000);
    });

    expect(screen.queryByText('status:signed-out')).toBeNull();
  });

  /**
   * A slow store that eventually answers arrives here as `INITIAL_SESSION`, so a launch
   * that gave up recovers on its own. The retry button is the floor, not the only way out.
   */
  it('recovers when the slow answer finally arrives', async () => {
    mockGetSession.mockReturnValue(new Promise(() => {}));

    await mount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(9_000);
    });
    expect(screen.getByText('status:error')).toBeTruthy();

    await act(async () => {
      mockAuthListener.current?.('INITIAL_SESSION', null);
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText('status:signed-out')).toBeTruthy();
  });
});
