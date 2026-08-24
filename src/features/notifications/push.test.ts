/**
 * The push transport: permissions read, tokens acquired, registered, and released.
 *
 * Three of these assertions are about outcomes with no visible symptom, which is why they
 * exist at all:
 *
 *   · **nothing here asks for permission.** The one dialog iOS will present is spent by
 *     whoever calls `requestPermissionsAsync` first, and this file must never be that
 *     caller — PRD §15 says the moment belongs to a first follow or a first invite.
 *   · **sign-out releases the device.** A token left registered delivers the previous
 *     account's follows and recommendations — names and film titles — to the lock screen
 *     of whoever signs in next.
 *   · **no token reaches telemetry.** A push token addresses somebody's phone.
 */

import {
  acquirePushToken,
  canReceivePush,
  configurePushPresentation,
  easProjectId,
  heldToken,
  nudgePushDelivery,
  pushPermission,
  registerPushToken,
  pushSessionEpoch,
  resetDispatchedWrite,
  trackDispatchedWrite,
  releaseDeviceOnSignOut,
  rememberToken,
  resetNudgeThrottle,
  revokePushToken,
} from './push';

const mockRpc = jest.fn();
let mockRpcError: { code?: string } | null = null;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      return Promise.resolve({
        data: mockRpcError ? null : { status: 'ok' },
        error: mockRpcError,
      });
    },
    functions: { invoke: (...args: unknown[]) => mockInvoke(...args) },
  },
}));

type InvokeResult = { data: unknown; error: { message: string } | null };
const mockInvoke = jest.fn((..._args: unknown[]): Promise<InvokeResult> =>
  Promise.resolve({ data: null, error: null }),
);
const mockReportHandled = jest.fn();

jest.mock('@/lib/monitoring', () => ({
  reportHandled: (...args: unknown[]) => mockReportHandled(...args),
}));

/**
 * Built inside the factory rather than referenced from it.
 *
 * `jest.mock` is hoisted above the imports, and the import of `./push` is what first
 * requires this module — so a factory that returns an outer `const` reads that binding
 * before its initialiser has run, and every function on it is undefined.
 */
jest.mock('expo-notifications', () => ({
  __esModule: true,
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(() => Promise.resolve()),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  AndroidImportance: { HIGH: 4 },
}));

let mockIsDevice = true;
jest.mock('expo-device', () => ({
  get isDevice() {
    return mockIsDevice;
  },
}));

jest.mock('expo-crypto', () => {
  let n = 0;
  return {
    randomUUID: () => {
      n += 1;
      return `operation-${n}`;
    },
  };
});

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { eas: { projectId: 'project-abc' } } } },
}));

const mockNotifications = jest.requireMock('expo-notifications') as {
  getPermissionsAsync: jest.Mock;
  requestPermissionsAsync: jest.Mock;
  getExpoPushTokenAsync: jest.Mock;
  setNotificationHandler: jest.Mock;
};

const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

const permissions = (over: Record<string, unknown> = {}) => ({
  granted: false,
  canAskAgain: true,
  status: 'undetermined',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRpcError = null;
  mockIsDevice = true;
  resetNudgeThrottle();
  resetDispatchedWrite();
  mockNotifications.getPermissionsAsync.mockResolvedValue(permissions({ granted: true }));
  mockNotifications.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: TOKEN });
});

// ---------------------------------------------------------------------------

describe('reading the platform', () => {
  it('reads the OS permission without ever prompting', async () => {
    await pushPermission();
    expect(mockNotifications.getPermissionsAsync).toHaveBeenCalled();
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('separates a question nobody has been asked from an answer somebody gave', async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue(permissions({ canAskAgain: true }));
    expect(await pushPermission()).toBe('undetermined');

    mockNotifications.getPermissionsAsync.mockResolvedValue(
      permissions({ canAskAgain: false }),
    );
    expect(await pushPermission()).toBe('blocked');
  });

  /**
   * iOS provisional authorisation delivers quietly without ever having asked, and
   * `granted` is false for it. Reading that as ungranted would prompt somebody who is
   * already receiving notifications.
   */
  it('treats iOS provisional authorisation as granted', async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue(
      permissions({ granted: false, canAskAgain: true, ios: { status: 3 } }),
    );
    expect(await pushPermission()).toBe('granted');
  });

  it('is unavailable on a simulator, rather than an error every developer sees', async () => {
    mockIsDevice = false;
    expect(canReceivePush()).toBe(false);
    expect(await pushPermission()).toBe('unavailable');
    expect(mockNotifications.getPermissionsAsync).not.toHaveBeenCalled();
  });

  it('takes the project id from the resolved config rather than a second copy', () => {
    expect(easProjectId()).toBe('project-abc');
  });
});

describe('acquiring a token', () => {
  it('asks Expo with the project id and returns the token', async () => {
    expect(await acquirePushToken()).toBe(TOKEN);
    expect(mockNotifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: 'project-abc',
    });
  });

  /**
   * This is a network call and it fails offline, which is ordinary. Nothing waits on it
   * and nothing may throw out of it: the caller retries on the next launch.
   */
  it('reports and returns null when Expo cannot be reached', async () => {
    mockNotifications.getExpoPushTokenAsync.mockRejectedValue(new Error('offline'));
    expect(await acquirePushToken()).toBeNull();
    expect(mockReportHandled).toHaveBeenCalled();
  });

  it('does not ask a simulator for a token', async () => {
    mockIsDevice = false;
    expect(await acquirePushToken()).toBeNull();
    expect(mockNotifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });
});

describe('registering', () => {
  it('sends the token and platform, and nothing else', async () => {
    expect(await registerPushToken('user-1', TOKEN, 'ios')).toBe('ok');
    expect(mockRpc).toHaveBeenCalledWith('register_device_token', {
      p_operation_id: expect.any(String),
      p_token: TOKEN,
      p_platform: 'ios',
    });
  });

  /**
   * The id belongs to the intent, so a retry after a lost reply is recognised rather than
   * recorded twice — `lib/operation-intent.ts`'s rule, in its smallest form.
   */
  it('retries a failed registration under the same operation id', async () => {
    mockRpcError = { code: '08006' };
    await registerPushToken('user-1', TOKEN, 'ios');
    const first = mockRpc.mock.calls[0][1] as { p_operation_id: string };

    mockRpcError = null;
    await registerPushToken('user-1', TOKEN, 'ios');
    const second = mockRpc.mock.calls[1][1] as { p_operation_id: string };

    expect(second.p_operation_id).toBe(first.p_operation_id);
  });

  /**
   * A different account on the same phone is a different intent. Sharing the id would
   * have the server answer `already_applied` and leave the device pointed at whoever had
   * it before — which is the account-switch hole the whole lifecycle exists to close.
   */
  it('mints a new operation id for a different account on the same device', async () => {
    await registerPushToken('user-1', TOKEN, 'ios');
    await registerPushToken('user-2', TOKEN, 'ios');

    const first = (mockRpc.mock.calls[0][1] as { p_operation_id: string }).p_operation_id;
    const second = (mockRpc.mock.calls[1][1] as { p_operation_id: string }).p_operation_id;
    expect(second).not.toBe(first);
  });

  it('reports a failure and carries on', async () => {
    mockRpcError = { code: '42501' };
    expect(await registerPushToken('user-1', TOKEN, 'ios')).toBe('failed');
    expect(mockReportHandled).toHaveBeenCalled();
  });

  /**
   * Revoking answers `ok` whether or not a row moved, so there is nothing in the reply to
   * assert. What is asserted is the shape of the call: a token and an operation id, and
   * **no account** — the server takes the owner from `auth.uid()`, which is what stops
   * one account releasing another's device.
   */
  it('revokes by token alone, naming no account', async () => {
    expect(await revokePushToken('user-1', TOKEN)).toBe('ok');
    expect(mockRpc).toHaveBeenCalledWith('revoke_device_token', {
      p_operation_id: expect.any(String),
      p_token: TOKEN,
    });
  });
});

describe('signing out', () => {
  it('revokes the device it is holding', async () => {
    rememberToken('user-1', TOKEN);
    await releaseDeviceOnSignOut();

    expect(mockRpc).toHaveBeenCalledWith('revoke_device_token', {
      p_operation_id: expect.any(String),
      p_token: TOKEN,
    });
    expect(heldToken()).toBeNull();
  });

  /**
   * The epoch is what an in-flight registration compares against, and it has to move
   * **before** the revoke round trip — a registration that completes at any point during
   * sign-out must see a stale value and undo itself. Asserted here rather than only in
   * `push-permission.test.ts`, because that suite mocks this module out.
   */
  it('advances the session epoch before anything else, so an in-flight register can tell', async () => {
    const before = pushSessionEpoch();
    rememberToken('user-1', TOKEN);
    await releaseDeviceOnSignOut();

    expect(pushSessionEpoch()).not.toBe(before);
  });

  it('advances the epoch even when there was no token to revoke', async () => {
    const before = pushSessionEpoch();
    await releaseDeviceOnSignOut();

    expect(pushSessionEpoch()).not.toBe(before);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it('does nothing when this process never registered one', async () => {
    await releaseDeviceOnSignOut();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  /**
   * The sharpest failure in this file. A rejection here propagates into `signOut` and
   * leaves somebody signed in — which is worse than a stale token, and a stale token is
   * not the last line of defence anyway: `register_device_token` moves the device to
   * whoever registers it next.
   */
  it('never throws, however badly the revoke goes', async () => {
    rememberToken('user-1', TOKEN);
    mockRpcError = { code: '08006' };
    await expect(releaseDeviceOnSignOut()).resolves.toBeUndefined();
    expect(heldToken()).toBeNull();
  });

  it('forgets the token even when the revoke fails, so it cannot be reused', async () => {
    rememberToken('user-1', TOKEN);
    mockRpcError = { code: '08006' };
    await releaseDeviceOnSignOut();

    mockRpc.mockClear();
    await releaseDeviceOnSignOut();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('nudging the sender', () => {
  it('invokes the function with a body that chooses nothing', () => {
    nudgePushDelivery();
    expect(mockInvoke).toHaveBeenCalledWith('push-sender', { body: {} });
  });

  /**
   * A drain is global rather than per caller, so several writers in a burst are one
   * nudge. Without this, tagging four companions would be four invocations of a function
   * whose first call already claimed the work.
   */
  it('collapses a burst into one call', () => {
    nudgePushDelivery();
    nudgePushDelivery();
    nudgePushDelivery();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('does not reject when the function is unreachable', async () => {
    mockInvoke.mockResolvedValueOnce({ data: null, error: { message: 'unreachable' } });
    expect(() => nudgePushDelivery()).not.toThrow();
    await Promise.resolve();
  });
});

describe('what reaches telemetry', () => {
  /**
   * A push token addresses a person's phone, and `reportHandled` sends what it is given
   * to Sentry. Asserted over every reported call rather than over one, because the
   * failure this prevents is a *new* report added later with the token in scope.
   */
  it('never carries a token, in any failure on any path', async () => {
    mockRpcError = { code: '42501' };
    await registerPushToken('user-1', TOKEN, 'ios');
    rememberToken('user-1', TOKEN);
    await releaseDeviceOnSignOut();
    mockNotifications.getExpoPushTokenAsync.mockRejectedValue(new Error(`bad token ${TOKEN}`));
    await acquirePushToken();

    expect(mockReportHandled).toHaveBeenCalled();
    for (const [error, context] of mockReportHandled.mock.calls) {
      const serialised = JSON.stringify({
        message: (error as Error)?.message,
        context,
      });
      expect(serialised).not.toContain('ExponentPushToken');
    }
  });

  it('reports a stage and a platform, so a failure is searchable', async () => {
    mockRpcError = { code: '42501' };
    await registerPushToken('user-1', TOKEN, 'ios');

    const [, context] = mockReportHandled.mock.calls[0];
    expect(context).toMatchObject({ push_stage: 'token_registration' });
  });
});

describe('foreground presentation', () => {
  /**
   * No banner, deliberately. The inbox row is the notification and the push is transport
   * for it; a banner over an app already showing the bell is the same fact told twice.
   */
  it('shows nothing while the app is open, and sets no badge', () => {
    configurePushPresentation();

    const handler = mockNotifications.setNotificationHandler.mock.calls[0][0];
    return expect(handler.handleNotification()).resolves.toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });

  it('asks for no permission while configuring', () => {
    configurePushPresentation();
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockNotifications.getPermissionsAsync).not.toHaveBeenCalled();
  });
});

describe('sign-out waits for a write that is already in flight', () => {
  /**
   * The half the epoch cannot do on its own, and the re-review was right to insist on it.
   *
   * A registration whose RPC has already gone out will land, see the stale epoch and try
   * to revoke what it wrote — but that revoke needs a session, and `signOut` is one line
   * away from ending it. So sign-out lets the write finish first.
   */
  it('does not return until a dispatched write settles', async () => {
    let land: () => void = () => {};
    const write = new Promise<void>((resolve) => {
      land = resolve;
    });
    trackDispatchedWrite(write);

    let released = false;
    const signOut = releaseDeviceOnSignOut().then(() => {
      released = true;
    });

    // Several microtask turns, which is more than enough for a `then` chain that was
    // going to resolve immediately.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(released).toBe(false);

    land();
    await signOut;
    expect(released).toBe(true);
  });

  /**
   * The epoch moves before the wait, not after. A write that lands during the wait has to
   * see a stale value, or it would remember a token for an account that is leaving.
   */
  it('advances the epoch before it starts waiting', async () => {
    const before = pushSessionEpoch();
    let epochDuringWrite = before;

    let land: () => void = () => {};
    const write = new Promise<void>((resolve) => {
      land = resolve;
    }).then(() => {
      epochDuringWrite = pushSessionEpoch();
    });
    trackDispatchedWrite(write);

    const signOut = releaseDeviceOnSignOut();
    land();
    await signOut;

    expect(epochDuringWrite).not.toBe(before);
  });

  it('is not delayed at all when nothing is in flight', async () => {
    let released = false;
    const signOut = releaseDeviceOnSignOut().then(() => {
      released = true;
    });

    await signOut;
    expect(released).toBe(true);
  });

  /** A write that fails must not take the sign-out down with it. */
  it('survives a dispatched write that rejects', async () => {
    trackDispatchedWrite(Promise.reject(new Error('offline')).catch(() => undefined));
    await expect(releaseDeviceOnSignOut()).resolves.toBeUndefined();
  });

  /**
   * The grace period is a ceiling, not a delay — but a wedged write must not hold a
   * sign-out open for ever. Asserted with fake timers so the suite does not wait for it.
   */
  it('gives up on a wedged write rather than holding sign-out open', async () => {
    jest.useFakeTimers();
    try {
      // Never settles.
      trackDispatchedWrite(new Promise<void>(() => {}));

      let released = false;
      const signOut = releaseDeviceOnSignOut().then(() => {
        released = true;
      });

      await Promise.resolve();
      expect(released).toBe(false);

      jest.advanceTimersByTime(3000);
      await signOut;
      expect(released).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
