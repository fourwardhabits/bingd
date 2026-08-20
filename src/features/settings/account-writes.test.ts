import { act } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { useAccountWrites } from './use-account';

/**
 * **The account writers, against the one question review 21 spent five rounds on:** can
 * this client tell "the server refused" from "it committed and the reply was lost"?
 *
 * It cannot, in general — so the rule (`lib/write-outcome.ts`) is that only a SQLSTATE
 * this app raises on purpose proves a refusal, and everything else is reconciled. These
 * two writers are the sharpest case in the app for getting that wrong. `save_profile`
 * writes the handle every screen renders through `useCurrentProfile`, and a save that
 * landed without saying so leaves the whole app showing the old one *and* the person
 * retrying into a `23505` raised by their own stored name.
 */

const mockRpc = jest.fn();

// A fresh id every call, so a held one is visibly held rather than two undefineds
// comparing equal. `expo-crypto` has no native module under jest.
let issued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id-${(issued += 1)}` }));

jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  startSessionRefresh: () => () => {},
}));

beforeEach(() => {
  issued = 0;
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ data: null, error: null });
});

/** The operation ids sent to one RPC, in order. */
const idsSentTo = (fn: string) =>
  mockRpc.mock.calls
    .filter(([name]) => name === fn)
    .map(([, args]) => (args as { p_operation_id: string }).p_operation_id);

/**
 * Seeded so there is something to mark stale. A key that was never in the cache reports
 * `isInvalidated: false` whatever happens to it, which would make every assertion below
 * pass for the wrong reason.
 */
const KEYS = [['my-profile', 'user-1'], ['profile'], ['relationships'], ['feed']];

const mount = async () => {
  const { result, client } = await renderHookWithProviders(() => useAccountWrites());

  for (const key of KEYS) {
    /**
     * Kept out of the collector's reach before it is seeded.
     *
     * The shared test client sets `gcTime: 0`, and these keys have no observer — nothing
     * renders them — so React Query schedules their collection on a timer that fires the
     * moment anything flushes one. Nothing used to, which is the only reason this worked.
     * `act` flushes timers by design, so the seeded rows were collected before the writer
     * ran and `getQueryState` returned `undefined`.
     *
     * That is the same ambiguity the seeding below exists to remove, arriving from the
     * other side: a collected key and a never-invalidated one both read as "not
     * invalidated", and every assertion here would have passed for the wrong reason.
     */
    client.setQueryDefaults(key, { gcTime: Infinity });
    client.setQueryData(key, 'seeded');
  }

  /**
   * The writers, each wrapped so React sees the state changes it makes.
   *
   * `useAccountWrites` flips `busy` either side of its await — that is the guard that
   * refuses a second write while the first is in flight. A writer called straight from
   * a test performs both of those updates outside React's knowledge, which is what
   * printed pages of *"An update to HookContainer inside a test was not wrapped in
   * act(...)"* into every CI log.
   *
   * **It was not only noise.** An unflushed update leaves `result.current` holding the
   * closure from the previous render, so the second of two calls was reading a `busy`
   * React had already moved past — and the paired-call tests below are precisely about
   * what the second call sees. They were passing against a stale closure rather than
   * against the state the screen would actually have.
   *
   * Wrapped at the mount rather than at each of the seventeen call sites, so a writer
   * cannot be called un-acted by a test added later.
   */
  const writes = {
    get current(): ReturnType<typeof useAccountWrites> {
      const api = result.current;
      return new Proxy(api, {
        get: (target, key) => {
          const value = target[key as keyof typeof target];
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) =>
            act(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
        },
      });
    },
  };

  return {
    writes,
    /**
     * Reads the flag, and refuses to answer for a key that is not there.
     *
     * The old `?? false` is what let the collected-cache failure above look like an
     * ordinary assertion failure. A missing key is not evidence of anything and saying so
     * is the difference between a test that failed and a test that was never asking.
     */
    invalidated: (key: unknown[]) => {
      const state = client.getQueryState(key);
      if (!state) throw new Error(`${JSON.stringify(key)} is not in the cache to be invalidated`);
      return state.isInvalidated;
    },
  };
};

describe('saving a profile', () => {
  it('refreshes the signed-in account’s own row on success', async () => {
    // `['profile']` does not reach it. That key is `['profile', username]` and this one
    // is `['my-profile', userId]` (`lib/query.ts`), so the prefix match everybody
    // assumed was happening was not.
    const { writes, invalidated } = await mount();

    await writes.current.saveProfile({ username: 'rosalind' });

    expect(invalidated(['my-profile', 'user-1'])).toBe(true);
  });

  it.each([
    ['a request that was never answered', { code: '', message: 'TypeError: fail' }],
    ['a transaction whose resolution is unknown', { code: '08007', message: 'unknown' }],
  ])('refreshes it after %s, because the handle may already be stored', async (_n, error) => {
    mockRpc.mockResolvedValue({ data: null, error });
    const { writes, invalidated } = await mount();

    const result = await writes.current.saveProfile({ username: 'rosalind' });

    // The person is still told it failed — that part is unchanged and correct.
    expect(result.ok).toBe(false);
    // And the caches are reconciled anyway, which is the whole of the fix.
    expect(invalidated(['my-profile', 'user-1'])).toBe(true);
    expect(invalidated(['feed'])).toBe(true);
  });

  it('leaves everything alone when the handle was genuinely taken', async () => {
    // 23505 is a unique violation on somebody else's name: the server answered, and it
    // answered no. Nothing was written and there is nothing to re-read.
    mockRpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'taken' } });
    const { writes, invalidated } = await mount();

    await writes.current.saveProfile({ username: 'rosalind' });

    expect(invalidated(['my-profile', 'user-1'])).toBe(false);
    expect(invalidated(['feed'])).toBe(false);
  });
});

/**
 * **The one writer whose ambiguity cannot be reconciled here**, because what it changes
 * is whether the account exists rather than what a cache holds. So it carries the flag
 * instead, and `app/settings/account.tsx` resolves it by asking the server again —
 * `delete_account` answers `already_applied` once the profile is gone
 * (`20260817000700`). Independent review 21f.
 */
/**
 * **The sequence independent review 21j named**, and the one it named first.
 *
 * `save_profile` commits along with its claim and one `profile.max_edits_per_day` slot;
 * the reply is lost; the form stays up with an error; Save is tapped again. The row
 * converges — it assigns — but a fresh id spends a second slot for one intent, and doing
 * that a few times brings the ceiling forward: a rate-limit refusal shown to somebody
 * whose true count would still have allowed the save. Nothing raises and nothing looks
 * wrong (`lib/operation-intent.ts`).
 */
describe('one operation id per intent', () => {
  it('replays an unanswered save under the id the first attempt used', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '', message: 'TypeError: Network request failed' },
    });
    const { writes } = await mount();

    await writes.current.saveProfile({ username: 'rosalind' });
    await writes.current.saveProfile({ username: 'rosalind' });

    const [first, second] = idsSentTo('save_profile');
    expect(typeof first).toBe('string');
    expect(second).toBe(first);
  });

  it('takes a fresh id once the server has answered', async () => {
    const { writes } = await mount();

    await writes.current.saveProfile({ username: 'rosalind' });
    await writes.current.saveProfile({ username: 'rosalind' });

    const [first, second] = idsSentTo('save_profile');
    expect(second).not.toBe(first);
  });

  it('takes a fresh id when the values change, because that is a different intent', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '', message: 'lost' } });
    const { writes } = await mount();

    await writes.current.saveProfile({ username: 'rosalind' });
    await writes.current.saveProfile({ username: 'ada' });

    const [first, second] = idsSentTo('save_profile');
    expect(second).not.toBe(first);
  });

  it('holds the visibility switch the same way', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '08007', message: 'unknown' } });
    const { writes } = await mount();

    await writes.current.setVisibility('private');
    await writes.current.setVisibility('private');

    const [first, second] = idsSentTo('set_profile_visibility');
    expect(second).toBe(first);
  });
});

describe('deleting an account', () => {
  it.each([
    ['a request that was never answered', { code: '', message: 'TypeError: fail' }],
    ['a transaction whose resolution is unknown', { code: '08007', message: 'unknown' }],
    ['the database shutting down mid-request', { code: '57P01', message: 'terminating' }],
  ])('says the account may be gone after %s', async (_n, error) => {
    mockRpc.mockResolvedValue({ data: null, error });
    const { writes } = await mount();

    expect(await writes.current.deleteAccount('sai')).toMatchObject({
      ok: false,
      changed: true,
    });
  });

  it.each([
    ['a wrong confirmation', { code: '22023', message: 'type your username to confirm' }],
    ['no session', { code: '28000', message: 'unauthenticated' }],
    ['a delete the database blocked', { code: 'P0001', message: 'account deletion failed' }],
  ])('says nothing happened after %s', async (_n, error) => {
    // Every one of these is a SQLSTATE `delete_account` raises on purpose, and a
    // `raise exception` aborts its own transaction. Repeating a destructive call on the
    // strength of one of these would be inventing an intent nobody expressed.
    mockRpc.mockResolvedValue({ data: null, error });
    const { writes } = await mount();

    const result = await writes.current.deleteAccount('sai');

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('changed', true);
  });

  it('reports what the server says is still in storage on the way out', async () => {
    // Unchanged, and asserted here because the ambiguity work runs through the same
    // `run` helper and must not have disturbed it.
    mockRpc.mockResolvedValue({ data: { status: 'ok', avatars_remaining: 3 }, error: null });
    const { writes } = await mount();

    expect(await writes.current.deleteAccount('sai')).toEqual({ ok: true, avatarsRemaining: 3 });
  });
});

describe('changing visibility', () => {
  it('refreshes the switch’s own row as well as the relationships it moves', async () => {
    const { writes, invalidated } = await mount();

    await writes.current.setVisibility('private');

    expect(invalidated(['my-profile', 'user-1'])).toBe(true);
    expect(invalidated(['relationships'])).toBe(true);
  });

  it('refreshes them when the switch may have flipped anyway', async () => {
    // Going public approves everybody waiting, so a lost reply here can leave a person
    // believing their account is private while the server has already opened it and
    // let a queue of followers in. That is the one on this screen worth a refetch even
    // if none of the others were.
    mockRpc.mockResolvedValue({ data: null, error: { code: '08006', message: 'connection' } });
    const { writes, invalidated } = await mount();

    await writes.current.setVisibility('public');

    expect(invalidated(['my-profile', 'user-1'])).toBe(true);
    expect(invalidated(['relationships'])).toBe(true);
  });

  it('leaves them alone when the account cannot make changes', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'suspended' } });
    const { writes, invalidated } = await mount();

    await writes.current.setVisibility('public');

    expect(invalidated(['my-profile', 'user-1'])).toBe(false);
  });
});
