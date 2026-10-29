/**
 * The push lifecycle as the app actually mounts it.
 *
 * One assertion here is worth more than the rest of the file, and it is the negative one:
 * **this hook runs on every launch of every session and must never ask for permission.**
 * PRD §15 forbids a launch-time prompt, iOS presents its dialog once ever, and a
 * regression would be invisible in review — a single `requestPermissionsAsync` added to
 * the registration path would look like tidying.
 */

import { act, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { renderHookWithProviders } from '@/test-utils/render';
import { usePush } from './use-push';

let mockAuth: { status: string; userId?: string } = { status: 'signed-out' };
const mockRouterPush = jest.fn();

jest.mock('expo-notifications', () => ({
  __esModule: true,
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  useLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
}));

jest.mock('./push', () => ({
  __esModule: true,
  canReceivePush: jest.fn(() => true),
  // Every event in this suite is treated as a genuine roll — the echo-vs-roll distinction
  // has its own suite (push-storm.test.ts), with the real module.
  deviceTokenRolled: jest.fn(() => true),
  forgetToken: jest.fn(),
  nudgePushDelivery: jest.fn(),
  pushPermission: jest.fn(),
  pushPlatform: jest.fn(() => 'ios'),
  registerPushToken: jest.fn(),
  rememberToken: jest.fn(),
}));

jest.mock('./push-permission', () => ({
  __esModule: true,
  registerThisDevice: jest.fn(() => Promise.resolve('registered')),
}));

jest.mock('@/features/auth', () => ({
  useAuth: () => mockAuth,
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

const notifications = jest.requireMock('expo-notifications') as {
  requestPermissionsAsync: jest.Mock;
  getPermissionsAsync: jest.Mock;
  useLastNotificationResponse: jest.Mock;
  clearLastNotificationResponse: jest.Mock;
  addPushTokenListener: jest.Mock;
};

const push = jest.requireMock('./push') as {
  pushPermission: jest.Mock;
  forgetToken: jest.Mock;
  nudgePushDelivery: jest.Mock;
  canReceivePush: jest.Mock;
};

const permission = jest.requireMock('./push-permission') as { registerThisDevice: jest.Mock };

const signedIn = (userId = 'user-1') => {
  mockAuth = { status: 'ready', userId };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = { status: 'signed-out' };
  push.pushPermission.mockResolvedValue('granted');
  push.canReceivePush.mockReturnValue(true);
  permission.registerThisDevice.mockResolvedValue('registered');
  notifications.useLastNotificationResponse.mockReturnValue(null);
});

// ---------------------------------------------------------------------------

describe('what it does not do', () => {
  it('never asks for permission, signed in or out', async () => {
    await renderHookWithProviders(() => usePush());
    signedIn();
    await renderHookWithProviders(() => usePush());

    await waitFor(() => expect(permission.registerThisDevice).toHaveBeenCalled());
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('does nothing at all without a ready session', async () => {
    mockAuth = { status: 'loading' };
    await renderHookWithProviders(() => usePush());

    expect(push.pushPermission).not.toHaveBeenCalled();
    expect(permission.registerThisDevice).not.toHaveBeenCalled();
    expect(push.nudgePushDelivery).not.toHaveBeenCalled();
  });

  it('does not register a device that has not been given permission', async () => {
    push.pushPermission.mockResolvedValue('undetermined');
    signedIn();
    await renderHookWithProviders(() => usePush());

    await waitFor(() => expect(push.pushPermission).toHaveBeenCalled());
    expect(permission.registerThisDevice).not.toHaveBeenCalled();
  });

  it('asks the platform nothing on a simulator', async () => {
    push.canReceivePush.mockReturnValue(false);
    signedIn();
    await renderHookWithProviders(() => usePush());

    expect(push.pushPermission).not.toHaveBeenCalled();
    expect(notifications.addPushTokenListener).not.toHaveBeenCalled();
  });
});

describe('what it does', () => {
  it('registers a device that already has permission', async () => {
    signedIn('user-7');
    await renderHookWithProviders(() => usePush());

    await waitFor(() => expect(permission.registerThisDevice).toHaveBeenCalledWith('user-7'));
  });

  /**
   * Latched per account, because the effect re-runs on every identity change of the auth
   * object — which is every profile refetch. Without the latch, each one is a round trip
   * to Expo and another to Postgres.
   */
  it('registers once per account, not once per render', async () => {
    signedIn();
    const { rerender } = await renderHookWithProviders(() => usePush());

    await waitFor(() => expect(permission.registerThisDevice).toHaveBeenCalledTimes(1));
    // Awaited, like everything else in this library since v14 (`jest.setup.js`). An
    // un-awaited rerender leaves an open act scope, and the symptom is every *later* test
    // in the file timing out rather than this one failing.
    await rerender(undefined);
    await rerender(undefined);
    expect(permission.registerThisDevice).toHaveBeenCalledTimes(1);
  });

  it('follows a token that rolls underneath it', async () => {
    signedIn();
    await renderHookWithProviders(() => usePush());

    await waitFor(() => expect(notifications.addPushTokenListener).toHaveBeenCalled());
    const listener = notifications.addPushTokenListener.mock.calls[0][0];

    permission.registerThisDevice.mockClear();
    listener({ type: 'ios', data: 'raw-device-token' });
    expect(permission.registerThisDevice).toHaveBeenCalledWith('user-1');
  });

  it('nudges the sender when a session becomes ready', async () => {
    signedIn();
    await renderHookWithProviders(() => usePush());
    expect(push.nudgePushDelivery).toHaveBeenCalled();
  });

  /**
   * The in-memory token belonged to whoever just left. The server-side revoke is
   * `signOut`'s — it needs a session — and this is the half that stops the next account
   * on this device inheriting the previous one's registration state.
   */
  it('forgets the held token when the session ends', async () => {
    await renderHookWithProviders(() => usePush());
    expect(push.forgetToken).toHaveBeenCalled();
  });

});

describe('a tap', () => {
  const response = (data: Record<string, unknown>) => ({
    notification: { request: { content: { data } } },
  });

  it('routes to the destination the payload resolves to', async () => {
    notifications.useLastNotificationResponse.mockReturnValue(
      response({ kind: 'follow', actorUsername: 'suraj' }),
    );
    signedIn();
    await renderHookWithProviders(() => usePush());

    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith('/u/suraj'));
  });

  /**
   * Cleared once acted on, or the same tap is re-navigated on every remount for the rest
   * of the process — and a remount is what a sign-in, a rotation or a fast refresh is.
   */
  it('clears the response so it is not acted on twice', async () => {
    notifications.useLastNotificationResponse.mockReturnValue(
      response({ kind: 'follow', actorUsername: 'suraj' }),
    );
    signedIn();
    await renderHookWithProviders(() => usePush());

    await waitFor(() => expect(notifications.clearLastNotificationResponse).toHaveBeenCalled());
  });

  /**
   * A cold start from a tap mounts this before the profile query has answered, while
   * `useAuthRouting` is deciding where the person belongs. Navigating first would be
   * replaced by the feed a moment later; the response is retained until cleared, so
   * waiting costs nothing.
   */
  it('waits for a ready session rather than navigating out of a loading one', async () => {
    notifications.useLastNotificationResponse.mockReturnValue(
      response({ kind: 'follow', actorUsername: 'suraj' }),
    );
    mockAuth = { status: 'loading' };
    await renderHookWithProviders(() => usePush());

    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(notifications.clearLastNotificationResponse).not.toHaveBeenCalled();
  });

  it('lands on the inbox when the payload means nothing to this build', async () => {
    notifications.useLastNotificationResponse.mockReturnValue(
      response({ kind: 'from_the_future' }),
    );
    signedIn();
    await renderHookWithProviders(() => usePush());

    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith('/settings/notifications'));
  });
});

describe('coming back from Settings', () => {
  /**
   * Codex review, 2026-10-28. The reader had denied notifications, opened bingd's page in
   * the OS Settings from the permission card, turned them on, and came back. Registration
   * has to happen on that foreground, not at the next cold start, and still without the
   * app ever asking.
   */
  it('registers when the app comes back from Settings with permission newly granted', async () => {
    const handlers: ((state: string) => void)[] = [];
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      handlers.push(handler as (state: string) => void);
      return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
    try {
      push.pushPermission.mockResolvedValue('blocked');
      signedIn('user-9');
      const view = await renderHookWithProviders(() => usePush());
      await waitFor(() => expect(push.pushPermission).toHaveBeenCalled());
      expect(permission.registerThisDevice).not.toHaveBeenCalled();

      // Still blocked on a foreground: nothing.
      handlers.forEach((h) => h('active'));
      await waitFor(() => expect(push.pushPermission).toHaveBeenCalledTimes(2));
      expect(permission.registerThisDevice).not.toHaveBeenCalled();

      // Granted in Settings, then back to the app: registered, once.
      push.pushPermission.mockResolvedValue('granted');
      handlers.forEach((h) => h('active'));
      await waitFor(() => expect(permission.registerThisDevice).toHaveBeenCalledWith('user-9'));

      // Later foregrounds do not register again, and nothing ever asked.
      handlers.forEach((h) => h('active'));
      handlers.forEach((h) => h('active'));
      await waitFor(() => expect(permission.registerThisDevice).toHaveBeenCalledTimes(1));
      expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
      await view.unmount();
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * Codex re-review, 2026-10-28, MAJOR. The latch used to be set before the registration
   * returned, so a first attempt that failed (offline on the way back from Settings) left
   * every later foreground stopped at the latch, with push dead until a restart while the
   * settings card said it was on. It is the one device registration, so reactive pushes
   * were lost too.
   */
  it('retries a failed registration on a later foreground, then stops once it succeeds', async () => {
    const handlers: ((state: string) => void)[] = [];
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      handlers.push(handler as (state: string) => void);
      return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
    // Each foreground, then everything it started allowed to finish, so the next one finds
    // the attempt over rather than still running.
    const foreground = async () => {
      handlers.forEach((h) => h('active'));
      await act(async () => {});
    };
    try {
      // A: blocked at launch; Settings; granted; back to the app; the registration fails.
      push.pushPermission.mockResolvedValue('blocked');
      signedIn('user-11');
      const view = await renderHookWithProviders(() => usePush());
      await waitFor(() => expect(push.pushPermission).toHaveBeenCalled());
      expect(permission.registerThisDevice).not.toHaveBeenCalled();

      push.pushPermission.mockResolvedValue('granted');
      permission.registerThisDevice.mockResolvedValueOnce('failed');
      await foreground();
      await waitFor(() => expect(permission.registerThisDevice).toHaveBeenCalledTimes(1));

      // B: a later foreground tries again, and so does one after a thrown error.
      permission.registerThisDevice.mockRejectedValueOnce(new Error('network'));
      await foreground();
      await waitFor(() => expect(permission.registerThisDevice).toHaveBeenCalledTimes(2));

      // An abandoned one (a sign-out raced it) is not a success either.
      permission.registerThisDevice.mockResolvedValueOnce('abandoned');
      await foreground();
      await waitFor(() => expect(permission.registerThisDevice).toHaveBeenCalledTimes(3));

      // C: this one succeeds.
      await foreground();
      await waitFor(() => expect(permission.registerThisDevice).toHaveBeenCalledTimes(4));
      expect(permission.registerThisDevice).toHaveBeenLastCalledWith('user-11');

      // D: and after that, foregrounds register nothing more.
      await foreground();
      await foreground();
      await waitFor(() => expect(push.pushPermission).toHaveBeenCalledTimes(5));
      expect(permission.registerThisDevice).toHaveBeenCalledTimes(4);
      expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
      await view.unmount();
    } finally {
      spy.mockRestore();
    }
  });

  it('a burst of foregrounds while one attempt is running starts no second one', async () => {
    const handlers: ((state: string) => void)[] = [];
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      handlers.push(handler as (state: string) => void);
      return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
    try {
      let finish: (outcome: string) => void = () => {};
      permission.registerThisDevice.mockImplementationOnce(
        () => new Promise((resolve) => (finish = resolve)),
      );
      signedIn('user-12');
      const view = await renderHookWithProviders(() => usePush());
      await waitFor(() => expect(permission.registerThisDevice).toHaveBeenCalledTimes(1));

      handlers.forEach((h) => h('active'));
      handlers.forEach((h) => h('active'));
      expect(permission.registerThisDevice).toHaveBeenCalledTimes(1);

      await act(async () => finish('registered'));
      handlers.forEach((h) => h('active'));
      await act(async () => {});
      await waitFor(() => expect(push.pushPermission).toHaveBeenCalledTimes(1));
      expect(permission.registerThisDevice).toHaveBeenCalledTimes(1);
      await view.unmount();
    } finally {
      spy.mockRestore();
    }
  });
});
