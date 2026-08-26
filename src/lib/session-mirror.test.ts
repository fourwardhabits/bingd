import * as SecureStore from 'expo-secure-store';

import { resetSessionMirror, sessionStorage } from './session-storage';

/**
 * The memory mirror in front of the Keychain, and why a session store needed one.
 *
 * **`getSession` is on the critical path of every authenticated request**, and it holds no
 * session in memory: `@supabase/supabase-js` builds each request through `fetchWithAuth`,
 * which awaits `auth.getSession()`, which calls `storage.getItem` every single time.
 * Through the chunked adapter that is a Keychain read for the count plus one per chunk —
 * per query — serialized against every other request's by the adapter's own per-key queue.
 *
 * Two costs, and the second is the one that made a phone unusable rather than slow:
 *
 *   · a screen mounting a dozen queries paid fifty Keychain round trips before any of them
 *     reached the network, and build 4 did that on five mounted tabs;
 *   · `SecureStore.getItemAsync` is a promise the platform never promised to settle, and
 *     one that does not takes every later request *and sign-out* down with it, because
 *     they all queue behind it on the one key.
 *
 * These tests pin both: the reads stop happening, and a store that stops answering stops
 * being able to hold anything hostage.
 */

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  const hang = { keys: new Set<string>() };
  return {
    __store: store,
    __hang: hang,
    getItemAsync: jest.fn((key: string) => {
      if (hang.keys.has(key)) return new Promise<string | null>(() => {});
      return Promise.resolve(store.get(key) ?? null);
    }),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

const mocked = SecureStore as unknown as {
  __store: Map<string, string>;
  __hang: { keys: Set<string> };
  getItemAsync: jest.Mock;
};

const KEY = 'sb-abheeqyjzekiowkztfxv-auth-token';

beforeEach(() => {
  mocked.__store.clear();
  mocked.__hang.keys.clear();
  resetSessionMirror();
  jest.clearAllMocks();
});

/** A Supabase session is two JWTs and a user object, so it chunks. */
const session = JSON.stringify({
  access_token: 'a'.repeat(900),
  refresh_token: 'r'.repeat(900),
});

/** Lets the queued disk work actually start, which `serialize` defers by a microtask. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('the session mirror', () => {
  it('reads the Keychain once and answers every later request from memory', async () => {
    await sessionStorage.setItem(KEY, session);
    mocked.getItemAsync.mockClear();

    // What a screen with a dozen queries asks for.
    for (let i = 0; i < 12; i += 1) {
      expect(await sessionStorage.getItem(KEY)).toBe(session);
    }

    // Zero, not "fewer": the write it followed already told this process the answer.
    expect(mocked.getItemAsync).not.toHaveBeenCalled();
  });

  it('goes to the Keychain exactly once for a session it did not write', async () => {
    // A cold start: the session is on disk from a previous launch.
    await sessionStorage.setItem(KEY, session);
    resetSessionMirror();
    mocked.getItemAsync.mockClear();

    expect(await sessionStorage.getItem(KEY)).toBe(session);
    const firstRead = mocked.getItemAsync.mock.calls.length;
    expect(firstRead).toBeGreaterThan(0);

    for (let i = 0; i < 10; i += 1) await sessionStorage.getItem(KEY);
    expect(mocked.getItemAsync.mock.calls.length).toBe(firstRead);
  });

  /**
   * **The hang, and the whole reason this is not merely an optimisation.** A Keychain read
   * that never answers used to take every subsequent authenticated request and the sign-out
   * with it. After the first successful read it cannot: nothing goes back to the store.
   */
  it('keeps answering after the Keychain stops answering', async () => {
    await sessionStorage.setItem(KEY, session);

    mocked.__hang.keys.add(`${KEY}.chunks`);

    const settled = await Promise.race([
      sessionStorage.getItem(KEY),
      new Promise((resolve) => setTimeout(() => resolve('never'), 50)),
    ]);
    expect(settled).toBe(session);
  });

  it('remembers a removal, so a signed-out device stays signed out without asking', async () => {
    await sessionStorage.setItem(KEY, session);
    await sessionStorage.removeItem(KEY);
    mocked.getItemAsync.mockClear();

    expect(await sessionStorage.getItem(KEY)).toBeNull();
    expect(mocked.getItemAsync).not.toHaveBeenCalled();
  });

  /**
   * A read taken while a write is in flight sees what is being written. That is also what
   * queueing behind the write would have returned, so the mirror changes the cost of this
   * case rather than its answer.
   */
  it('answers an in-flight write with the value being written', async () => {
    const writing = sessionStorage.setItem(KEY, session);
    expect(await sessionStorage.getItem(KEY)).toBe(session);
    await writing;
  });

  /**
   * And a write the store refused leaves no claim behind. The process does not know what
   * the Keychain holds any more, so the next read goes back to the one that does — rather
   * than reporting a session that may never have landed.
   */
  it('forgets rather than guesses when a write fails', async () => {
    await sessionStorage.setItem(KEY, session);
    (SecureStore.setItemAsync as jest.Mock).mockRejectedValueOnce(new Error('Keychain locked'));

    await expect(sessionStorage.setItem(KEY, 'replacement')).rejects.toThrow('Keychain locked');

    mocked.getItemAsync.mockClear();
    await sessionStorage.getItem(KEY);
    expect(mocked.getItemAsync).toHaveBeenCalled();
  });

  /**
   * **Independent review 49's finding, and it is a sign-out bug rather than a cache nit.**
   * A read that misses goes to the Keychain, and the Keychain is slow enough that a
   * removal can begin and finish while that read is still out. If the read's answer then
   * lands on top of the removal, the session comes back — and a sign-out silently
   * un-happens on a device somebody has already walked away from.
   */
  it('does not let a slow read undo a removal that overtook it', async () => {
    await sessionStorage.setItem(KEY, session);
    resetSessionMirror();

    let releaseRead = () => {};
    mocked.getItemAsync.mockImplementationOnce(
      (key: string) =>
        new Promise((resolve) => {
          releaseRead = () => resolve(mocked.__store.get(key) ?? null);
        }),
    );

    const reading = sessionStorage.getItem(KEY);
    await flush();
    // Not awaited before the read is released: the adapter serializes disk work per key,
    // so the removal cannot reach the Keychain until the read has. What it *does* do
    // immediately is claim the mirror — which is exactly where the race lives.
    const removing = sessionStorage.removeItem(KEY);
    releaseRead();
    await Promise.all([reading, removing]);

    expect(await sessionStorage.getItem(KEY)).toBeNull();
  });

  /** The same hazard the other way round: a slow read must not undo a newer sign-in. */
  it('does not let a slow read undo a write that overtook it', async () => {
    await sessionStorage.setItem(KEY, session);
    resetSessionMirror();

    let releaseRead = () => {};
    mocked.getItemAsync.mockImplementationOnce(
      (key: string) =>
        new Promise((resolve) => {
          releaseRead = () => resolve(mocked.__store.get(key) ?? null);
        }),
    );

    const reading = sessionStorage.getItem(KEY);
    await flush();
    const next = JSON.stringify({ access_token: 'b'.repeat(40), refresh_token: 'n' });
    const writing = sessionStorage.setItem(KEY, next);
    releaseRead();
    await Promise.all([reading, writing]);

    expect(await sessionStorage.getItem(KEY)).toBe(next);
  });

  it('keeps two keys apart', async () => {
    await sessionStorage.setItem(KEY, session);
    await sessionStorage.setItem(`${KEY}-code-verifier`, 'verifier');

    expect(await sessionStorage.getItem(KEY)).toBe(session);
    expect(await sessionStorage.getItem(`${KEY}-code-verifier`)).toBe('verifier');
  });
});
