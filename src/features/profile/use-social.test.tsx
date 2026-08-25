import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { useSocialWrites } from './use-social';

/**
 * What a follow makes stale, asserted as a set rather than one key at a time.
 *
 * **The founder's silkyy report is the reason this file exists.** They followed a public
 * account on the device, opened Recommend on a title, and the person was not in the
 * list — no refusal, no message, just an absent row, which reads as the feature not
 * working. `20260826000400` had already made following somebody sufficient to send to
 * them, on the server and in the picker's own query. What nothing had done was tell the
 * picker to stop believing an answer it had assembled before the follow existed: it
 * holds a five-minute `staleTime`, and the only cures were waiting or restarting the
 * app.
 *
 * That is a bug with no visible symptom in any single unit — the query is right, the RPC
 * is right, the button is right — so it is asserted here, at the one place that knows
 * which surfaces a follow moves.
 */

const mockRpcCalls: { name: string; args: Record<string, unknown> }[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpcCalls.push({ name, args });
      return Promise.resolve({ data: { status: 'ok', state: 'approved' }, error: null });
    },
    auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
  },
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => 'operation-id' }));
// The permission primer and the push nudge both fire from a successful follow and
// neither is what this file is about.
jest.mock('@/features/notifications/push', () => ({ nudgePushDelivery: jest.fn() }));
jest.mock('@/features/notifications/push-permission', () => ({
  offerPushPermission: jest.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  mockRpcCalls.length = 0;
});

/** Seeds one entry per key so `isInvalidated` has something to report on. */
const KEYS = [
  ['relationships', 'viewer'],
  ['recommend-recipients', 'viewer'],
  ['recommendation-requests', 'viewer'],
  ['sent-to-you', 'viewer'],
  ['feed', 'viewer'],
];

describe('a follow', () => {
  const followAnna = async () => {
    /**
     * A client of this test's own rather than the shared `renderHookWithProviders`,
     * which sets `gcTime: 0` — under that, a key seeded with no observer is collected
     * before anything can ask whether it was invalidated, and the assertion measures
     * garbage collection instead of the thing it is about.
     */
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    // Awaited: everything in this library is async as of v14, `renderHook` included.
    const { result } = await renderHook(() => useSocialWrites('viewer', 'profile'), { wrapper });
    for (const key of KEYS) client.setQueryData(key, 'seeded');

    // Inside act: the hook flips its own busy flag either side of the RPC, and a state
    // update outside act is a warning that would eventually become a flake.
    await act(async () => {
      await result.current.follow({ userId: 'anna-id', priorState: 'none' });
    });

    return {
      client,
      invalidated: (key: unknown[]) => client.getQueryState(key)?.isInvalidated ?? false,
    };
  };

  it('goes through the follow RPC with an operation id', async () => {
    await followAnna();

    const call = mockRpcCalls.find((c) => c.name === 'follow');
    expect(call?.args).toMatchObject({ p_followee_id: 'anna-id', p_operation_id: 'operation-id' });
  });

  /**
   * The picker. Without this key the founder's silkyy case is exactly reproducible: the
   * follow lands, the server would accept the recommendation, and the sheet keeps
   * offering the list it had before.
   */
  it('makes the recommendation picker stale, so a new follow is sendable at once', async () => {
    const { invalidated } = await followAnna();

    await waitFor(() => expect(invalidated(['recommend-recipients', 'viewer'])).toBe(true));
  });

  /**
   * The held recommendations a follow releases server-side, in the same transaction
   * (`20260826000400`), along with the relationship itself and the feed's population.
   */
  it('makes every surface a follow moves stale', async () => {
    const { invalidated } = await followAnna();

    await waitFor(() => expect(invalidated(['relationships', 'viewer'])).toBe(true));
    for (const key of KEYS) {
      expect(invalidated(key)).toBe(true);
    }
  });

  /**
   * **And leaves the People suggestion lists alone, deliberately.**
   *
   * Following somebody does make the row they came from stale — both lists exclude
   * accounts the caller already follows — so invalidating would be defensible on
   * correctness and is wrong on use: the row would vanish from under the thumb that
   * pressed it and the mutual counts would reshuffle the rest, while the reader is
   * partway down the list.
   *
   * The founder reported that exact failure once already, on the For You wall, where a
   * bookmark invalidated the slate and saving one title discarded the whole thing. The
   * rule that settled it — the list is not a function of the relationship — is the one
   * asserted here, and the control still answers immediately because `relationships` is
   * a different query and *is* invalidated.
   */
  it('leaves the People suggestion lists where they were', async () => {
    const { client, invalidated } = await followAnna();
    for (const key of [['people-mutuals', 'viewer'], ['people-taste-matches', 'viewer']]) {
      client.setQueryData(key, 'seeded');
    }

    await waitFor(() => expect(invalidated(['relationships', 'viewer'])).toBe(true));
    expect(invalidated(['people-mutuals', 'viewer'])).toBe(false);
    expect(invalidated(['people-taste-matches', 'viewer'])).toBe(false);
  });
});
