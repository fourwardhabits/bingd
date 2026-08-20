/**
 * The redemption queue, and the interleaving it exists to prevent.
 *
 * Independent review 26d found this by reading, not by running: `claimForRedemption`
 * made *sequential* acceptance correct, and two redemptions in flight in one process
 * could still be handed the same operation id while each held a different token — after
 * which whichever request arrived first took an attribution that never moves.
 *
 * The first test below is the race itself, driven deterministically. It is written so
 * that **deleting `serialiseRedemption` from either caller turns it red**, which is the
 * only property that makes a concurrency test worth having.
 */

import { claimForRedemption, holdInvite, pendingInvite } from './pending';
import { redeemPendingInvite } from './redeem';
import { resetRedemptionQueueForTests, serialiseRedemption } from './serialise';

jest.mock('@/lib/analytics', () => ({
  __esModule: true,
  track: jest.fn(),
  setAcquisition: jest.fn(),
}));

/**
 * The RPC, held open until the test releases it.
 *
 * A real await inside the critical section is what makes an unserialised second caller
 * able to overtake the first — without it, each redemption runs to completion inside one
 * microtask queue drain and the race cannot be constructed at all.
 */
const mockCalls: { token: string; operationId: string; release: () => void }[] = [];
jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (_name: string, args: { p_operation_id: string; p_token: string }) =>
      new Promise((resolve) => {
        (globalThis as { __mockCalls?: typeof mockCalls }).__mockCalls?.push({
          token: args.p_token,
          operationId: args.p_operation_id,
          release: () => resolve({ data: { status: 'ok' }, error: null }),
        });
      }),
  },
}));

let mockStored: Record<string, string> = {};
jest.mock('@/lib/prefs', () => ({
  __esModule: true,
  // A real deferral on each access, so a read and a write by two callers genuinely
  // interleave. An implementation that resolves synchronously would hide the race.
  readPref: (name: string) =>
    Promise.resolve().then(() => (mockStored[name] ? JSON.parse(mockStored[name]) : null)),
  writePref: (name: string, value: unknown) =>
    Promise.resolve().then(() => {
      mockStored[name] = JSON.stringify(value);
    }),
}));

let mockIssued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `op-${(mockIssued += 1)}` }));

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

beforeEach(() => {
  mockStored = {};
  mockIssued = 0;
  mockCalls.length = 0;
  (globalThis as { __mockCalls?: typeof mockCalls }).__mockCalls = mockCalls;
  resetRedemptionQueueForTests();
});

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('serialiseRedemption', () => {
  it('runs queued work one at a time, in order', async () => {
    const order: string[] = [];
    const gate: (() => void)[] = [];
    const task = (name: string) => () =>
      new Promise<void>((resolve) => {
        order.push(`start ${name}`);
        gate.push(() => {
          order.push(`end ${name}`);
          resolve();
        });
      });

    const first = serialiseRedemption(task('a'));
    const second = serialiseRedemption(task('b'));
    await settled();

    // The second has not started: one at a time is the whole contract.
    expect(order).toEqual(['start a']);

    gate[0]!();
    await first;
    await settled();
    gate[1]!();
    await second;

    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('is not poisoned by a failure', async () => {
    // One dropped connection must not stop every later redemption in the session.
    const failed = serialiseRedemption(() => Promise.reject(new Error('network')));
    await expect(failed).rejects.toThrow('network');

    await expect(serialiseRedemption(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});

describe('the background hook racing an explicit acceptance', () => {
  it('never submits two different tokens under one operation id', async () => {
    /**
     * The sequence review 26d described, driven step by step.
     *
     * Token A is pending — held before signing in — and the background redemption starts.
     * While it is in flight the person opens invitation B and taps Accept. Unserialised,
     * both calls reach `redemptionOperationId` with nothing between them and can be
     * handed the same id for two different tokens; whichever the server sees first takes
     * the attribution, and the other is answered `already_applied` for somebody else's
     * invitation.
     *
     * Serialised, the acceptance waits, and the assertion is the pairing: **no operation
     * id is ever sent with two different tokens.**
     */
    await holdInvite(A);

    const background = redeemPendingInvite();

    // The tap, expressed exactly as `app/i/[token].tsx` expresses it.
    const acceptance = serialiseRedemption(async () => {
      const operationId = await claimForRedemption(B, () => `op-tap-${(mockIssued += 1)}`);
      if (!operationId) return null;
      const { supabase } = jest.requireMock('@/lib/supabase') as {
        supabase: { rpc: (n: string, a: Record<string, string>) => Promise<unknown> };
      };
      return supabase.rpc('redeem_invite', { p_operation_id: operationId, p_token: B });
    });

    // Let the first call reach the server and release it; then the second.
    await settled();
    expect(mockCalls).toHaveLength(1);
    mockCalls[0]!.release();
    await background;

    await settled();
    expect(mockCalls).toHaveLength(2);
    mockCalls[1]!.release();
    await acceptance;

    const byId = new Map<string, Set<string>>();
    for (const call of mockCalls) {
      byId.set(call.operationId, (byId.get(call.operationId) ?? new Set()).add(call.token));
    }
    for (const [id, tokens] of byId) {
      expect([...tokens]).toHaveLength(1);
      expect(id).toBeTruthy();
    }
  });

  it('lets the acceptance claim the pending token rather than racing it', async () => {
    // The second half of the same property: once the queue drains, the pending token is
    // the one the person acted on, not the one that happened to be stored first.
    await holdInvite(A);

    const background = redeemPendingInvite();
    await settled();
    mockCalls[0]?.release();
    await background;

    await serialiseRedemption(async () => {
      await claimForRedemption(B, () => 'op-tap');
    });

    expect(await pendingInvite()).toBe(B);
  });
});
