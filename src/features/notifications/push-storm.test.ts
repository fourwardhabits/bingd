import * as Notifications from 'expo-notifications';

import { renderHookWithProviders } from '@/test-utils/render';

import { usePush } from './use-push';

import { resetFlightRecorder, snapshot } from '@/lib/flight-recorder';

import { registerThisDevice, resetInFlightRegistration } from './push-permission';
import {
  deviceTokenRolled,
  forgetToken,
  resetDeliveredDeviceToken,
  resetDispatchedWrites,
} from './push';

/**
 * The register_device_token storm, reproduced against the real modules and then killed.
 *
 * The 2026-08-27 physical reports showed repeat counts of 118 by ten seconds of uptime and
 * bursts of ~28 registrations inside 300ms. The cycle, proven from vendor source:
 * `getExpoPushTokenAsync` re-registers with the OS on every call, the OS re-delivers the
 * (unchanged) device token on every registration, expo-notifications emits its push-token
 * event on **every delivery**, and the token-roll listener called `registerThisDevice`
 * unconditionally — which acquires, which delivers, which fires the listener.
 *
 * The mock here is faithful to that: every acquire echoes the token event, in both real
 * orderings — during the acquire (APNs answers before Expo's endpoint does, the iOS case)
 * and after it settles. The invariant under test is the brief's, verbatim: for one
 * authenticated user, device and token, after a successful registration the client is
 * quiescent — echoes, rerenders and repeated triggers must not produce another RPC.
 */

const mockListeners = new Set<(token: { data: string; type: string }) => void>();
const mockCounts = { acquire: 0, registerRpc: 0, revokeRpc: 0 };
const mockStorm = { deviceToken: 'apns-token-1', echoTiming: 'during' as 'during' | 'after' };

const mockEmitDelivery = () => {
  for (const listener of [...mockListeners])
    listener({ data: mockStorm.deviceToken, type: 'ios' });
};

jest.mock('expo-notifications', () => ({
  __esModule: true,
  addPushTokenListener: jest.fn((listener: (token: { data: string; type: string }) => void) => {
    mockListeners.add(listener);
    return { remove: () => mockListeners.delete(listener) };
  }),
  getExpoPushTokenAsync: jest.fn(async () => {
    mockCounts.acquire += 1;
    // The OS delivers the device token as a side effect of acquiring — this echo is the
    // whole storm. `during` mirrors iOS (APNs answers before Expo's endpoint); `after`
    // covers the ordering where the event lands once the acquire has already settled.
    if (mockStorm.echoTiming === 'during') mockEmitDelivery();
    else setTimeout(mockEmitDelivery, 0);
    return { data: `ExponentPushToken[${mockStorm.deviceToken}]` };
  }),
  getPermissionsAsync: jest.fn(async () => ({ granted: true })),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  useLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
}));

jest.mock('@/features/auth', () => ({
  useAuth: () => ({ status: 'ready', userId: 'user-1' }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('expo-device', () => ({ isDevice: true }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'operation-id' }));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {
      extra: {
        variant: 'preview',
        supabaseUrl: 'https://project.supabase.co',
        supabaseAnonKey: 'anon-key-for-tests',
        eas: { projectId: 'd10f76cc-0000-0000-0000-000000000000' },
      },
    },
  },
}));

jest.mock('@/lib/supabase', () => ({
  startSessionRefresh: () => () => {},
  supabase: {
    rpc: jest.fn(async (fn: string) => {
      if (fn === 'register_device_token') mockCounts.registerRpc += 1;
      if (fn === 'revoke_device_token') mockCounts.revokeRpc += 1;
      return { data: { status: 'ok' }, error: null };
    }),
    functions: { invoke: jest.fn(async () => ({ data: null, error: null })) },
  },
}));

/** The token-roll listener, wired exactly as `usePush` wires it. */
const wireListenerAsUsePushDoes = (userId: string) =>
  Notifications.addPushTokenListener((delivered) => {
    if (!deviceTokenRolled(delivered?.data)) return;
    void registerThisDevice(userId);
  });

/** Lets the echo chain (event → guard → possible re-registration) fully play out. */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

beforeEach(() => {
  mockListeners.clear();
  mockCounts.acquire = 0;
  mockCounts.registerRpc = 0;
  mockCounts.revokeRpc = 0;
  mockStorm.deviceToken = 'apns-token-1';
  mockStorm.echoTiming = 'during';
  forgetToken();
  resetDeliveredDeviceToken();
  resetInFlightRegistration();
  resetDispatchedWrites();
  resetFlightRecorder();
});

describe('the storm', () => {
  it('one registration, however loudly the OS echoes during it', async () => {
    wireListenerAsUsePushDoes('user-1');

    await expect(registerThisDevice('user-1')).resolves.toBe('registered');
    await settle();

    expect(mockCounts.acquire).toBe(1);
    expect(mockCounts.registerRpc).toBe(1);
  });

  it('one registration when the echo lands after the acquire settles', async () => {
    jest.useFakeTimers();
    try {
      mockStorm.echoTiming = 'after';
      wireListenerAsUsePushDoes('user-1');

      await registerThisDevice('user-1');
      // The delayed echo arrives into a finished registration — the exact ordering where
      // single-flight cannot help and only the delivered-token guard stands.
      await jest.advanceTimersByTimeAsync(10);
      await jest.advanceTimersByTimeAsync(10);

      expect(mockCounts.registerRpc).toBe(1);
      expect(mockCounts.acquire).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('concurrent triggers share one in-flight registration', async () => {
    wireListenerAsUsePushDoes('user-1');

    const outcomes = await Promise.all([
      registerThisDevice('user-1'),
      registerThisDevice('user-1'),
      registerThisDevice('user-1'),
    ]);
    await settle();

    expect(outcomes).toEqual(['registered', 'registered', 'registered']);
    expect(mockCounts.acquire).toBe(1);
    expect(mockCounts.registerRpc).toBe(1);
  });

  it('a repeat trigger for an unchanged token skips the network entirely', async () => {
    wireListenerAsUsePushDoes('user-1');
    await registerThisDevice('user-1');
    await settle();

    await expect(registerThisDevice('user-1')).resolves.toBe('registered');

    expect(mockCounts.registerRpc).toBe(1);
    expect(snapshot().counters['push.register.skipped']).toBe(1);
    expect(snapshot().counters['push.register.rpc']).toBe(1);
  });
});

describe('what must still register', () => {
  it('a genuine token roll re-registers exactly once, echoes and all', async () => {
    wireListenerAsUsePushDoes('user-1');
    await registerThisDevice('user-1');
    await settle();
    expect(mockCounts.registerRpc).toBe(1);

    // The OS rolls the token: a delivery with genuinely different data.
    mockStorm.deviceToken = 'apns-token-2';
    mockEmitDelivery();
    await settle();

    expect(mockCounts.registerRpc).toBe(2);
    // And the roll is a line in the report, where the echoes are not.
    expect(
      snapshot().events.filter(
        (event) => event.channel === 'push' && event.label === 'token-rolled',
      ),
    ).toHaveLength(1);
  });

  it('an account switch registers under the new owner', async () => {
    wireListenerAsUsePushDoes('user-1');
    await registerThisDevice('user-1');
    await settle();

    // Sign-out clears the account-scoped token memory; the device token is unchanged.
    forgetToken();
    resetInFlightRegistration();

    await expect(registerThisDevice('user-2')).resolves.toBe('registered');
    await settle();

    expect(mockCounts.registerRpc).toBe(2);
  });
});

describe('the hook itself, mounted', () => {
  /**
   * The wiring under test is the real one, not a copy — so a regression in `usePush`
   * (say, the guard quietly removed in a refactor) fails here and nowhere else. The echo
   * is delayed past the acquire, which is the ordering where single-flight cannot absorb
   * it and only the delivered-token guard stands between one registration and the storm.
   */
  it('registers once through mounting, fifteen rerenders and five echoes', async () => {
    jest.useFakeTimers();
    try {
      mockStorm.echoTiming = 'after';

      const view = await renderHookWithProviders(() => usePush());
      await jest.advanceTimersByTimeAsync(20);

      for (let i = 0; i < 15; i += 1) await view.rerender(undefined as never);
      for (let i = 0; i < 5; i += 1) mockEmitDelivery();
      await jest.advanceTimersByTimeAsync(20);

      expect(mockCounts.registerRpc).toBe(1);
      expect(mockCounts.acquire).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('review 59 regressions', () => {
  /**
   * **The major:** sign out of the account while its registration is still acquiring, sign
   * straight back into the same account — the new session must not be handed the stale
   * flight, whose only honest outcome is `abandoned`. The epoch key is what distinguishes
   * "same user, same session" (reuse) from "same user, new session" (register).
   */
  it('re-registers the same account after a mid-flight sign-out', async () => {
    // Hold the first acquire open so the sign-out lands mid-flight.
    let releaseAcquire = () => {};
    (Notifications.getExpoPushTokenAsync as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseAcquire = () => {
            mockCounts.acquire += 1;
            resolve({ data: `ExponentPushToken[${mockStorm.deviceToken}]` });
          };
        }),
    );

    const stale = registerThisDevice('user-1');

    // Sign-out: the epoch moves, the held token clears — exactly what the real path does.
    const { releaseDeviceOnSignOut } = jest.requireActual('./push') as {
      releaseDeviceOnSignOut: () => Promise<void>;
    };
    await releaseDeviceOnSignOut();

    // Back into the same account, immediately.
    const fresh = registerThisDevice('user-1');
    releaseAcquire();

    await expect(stale).resolves.toBe('abandoned');
    await expect(fresh).resolves.toBe('registered');
    await settle();
    expect(mockCounts.registerRpc).toBe(1);
  });

  /**
   * **The minor:** a failed RPC must not be remembered as a registration. The held token
   * is written only on `ok`, so the next trigger performs the RPC again rather than being
   * short-circuited into a permanently unregistered device.
   */
  it('retries after a failed registration instead of short-circuiting it', async () => {
    const rpc = (jest.requireMock('@/lib/supabase') as { supabase: { rpc: jest.Mock } })
      .supabase.rpc;
    rpc.mockImplementationOnce(async (fn: string) => {
      if (fn === 'register_device_token') mockCounts.registerRpc += 1;
      return { data: null, error: { code: '500' } };
    });

    await expect(registerThisDevice('user-1')).resolves.toBe('failed');
    resetInFlightRegistration();
    await expect(registerThisDevice('user-1')).resolves.toBe('registered');

    expect(mockCounts.registerRpc).toBe(2);
    expect(snapshot().counters['push.register.skipped']).toBeUndefined();
  });
});
