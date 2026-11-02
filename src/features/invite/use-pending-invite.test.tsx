/**
 * Security audit 2026-11-01, B-1, as a regression test.
 *
 * The audit's repro held a token the way the invitation screen did, left the screen, and
 * watched `redeem_invite` go out with no tap. This is that sequence on the real modules.
 * Only the storage, the network and the router are stand-ins.
 */
import { renderHook } from '@testing-library/react-native';

import { claimForRedemption, holdInvite, pendingInvite } from './pending';
import { resetRedemptionQueueForTests } from './serialise';
import { useResumePendingInvite } from './use-pending-invite';

const mockStore = new Map<string, unknown>();
const mockRpc = jest.fn(async (_name: string, _args: unknown) => ({
  data: { status: 'already_applied', attributed: true },
  error: null,
}));
const mockPush = jest.fn();
let mockSegments: string[] = ['(tabs)', 'collection'];
let mockAuth: unknown = {
  status: 'ready',
  userId: 'victim',
  profile: { username: 'private_v', visibility: 'private' },
};

jest.mock('expo-router', () => ({
  useSegments: () => mockSegments,
  useRouter: () => ({ push: mockPush }),
}));
jest.mock('@/lib/analytics', () => ({
  __esModule: true,
  track: jest.fn(),
  setAcquisition: jest.fn(),
}));
jest.mock('@/lib/prefs', () => ({
  readPref: async (key: string) => (mockStore.has(key) ? mockStore.get(key) : null),
  writePref: async (key: string, value: unknown) => {
    if (value === null) mockStore.delete(key);
    else mockStore.set(key, value);
  },
}));
jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: (name: string, args: unknown) => mockRpc(name, args) },
}));
jest.mock('@/features/auth', () => ({ useAuth: () => mockAuth }));

const TOKEN = 'a'.repeat(32);
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  mockStore.clear();
  mockRpc.mockClear();
  mockPush.mockClear();
  mockSegments = ['(tabs)', 'collection'];
  resetRedemptionQueueForTests();
});

describe('leaving an invitation without accepting it', () => {
  it('sends nothing to the server, which was the whole attack', async () => {
    mockSegments = ['i', '[token]'];
    await holdInvite(TOKEN);

    const { rerender } = await renderHook(() => useResumePendingInvite());
    await tick();
    expect(mockRpc).not.toHaveBeenCalled();

    // The person leaves. No Accept was ever pressed.
    mockSegments = ['(tabs)', 'collection'];
    await rerender({});
    await tick(120);

    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('sends nothing on the next launch either', async () => {
    await holdInvite(TOKEN);

    await renderHook(() => useResumePendingInvite());
    await tick(120);

    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('brings the person back to the invitation instead, once', async () => {
    await holdInvite(TOKEN);

    const { rerender } = await renderHook(() => useResumePendingInvite());
    await tick(120);
    await rerender({});
    await tick(120);

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/i/[token]', params: { token: TOKEN } });
    expect(await pendingInvite()).toBe(TOKEN);
  });

  it('does nothing while it is already on the invitation screen', async () => {
    mockSegments = ['i', '[token]'];
    await holdInvite(TOKEN);

    await renderHook(() => useResumePendingInvite());
    await tick(120);

    expect(mockPush).not.toHaveBeenCalled();
  });

  it('waits for an account', async () => {
    const ready = mockAuth;
    mockAuth = { status: 'signed-out' };
    await holdInvite(TOKEN);

    await renderHook(() => useResumePendingInvite());
    await tick(120);

    mockAuth = ready;
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('a press of Accept whose answer never arrived', () => {
  it('is replayed, because that is the one thing the person did decide', async () => {
    await claimForRedemption(TOKEN, 'victim', () => 'op-from-the-press');

    await renderHook(() => useResumePendingInvite());
    await tick(120);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('accept_invite', {
      p_operation_id: 'op-from-the-press',
      p_token: TOKEN,
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('is not replayed for a different account that signed in on the same phone', async () => {
    await claimForRedemption(TOKEN, 'whoever-pressed-it', () => 'op-from-the-press');

    await renderHook(() => useResumePendingInvite());
    await tick(120);

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/i/[token]', params: { token: TOKEN } });
  });
});
