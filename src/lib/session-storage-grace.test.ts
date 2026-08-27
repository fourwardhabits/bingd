import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';

import { resetFlightRecorder, snapshot } from './flight-recorder';
import { resetSessionMirror, sessionStorage } from './session-storage';

/**
 * The write grace, and the founder symptom it exists for.
 *
 * Sign-in succeeded server-side and the UI stayed on "Signing in…" until the process was
 * killed — and a relaunch found the account signed in. On the success path there is exactly
 * one await between the server's 200 and the UI unlatching that carried no bound:
 * `@supabase/auth-js` awaits `_saveSession → storage.setItem` — this adapter's chunked
 * Keychain write — before it emits `SIGNED_IN`. A Keychain that answers late held the whole
 * transition hostage, and the session landing on disk *late* is exactly why the relaunch
 * found it.
 *
 * The last test here is the whole symptom, pinned end-to-end against the real auth client:
 * a sign-in whose Keychain write never settles still completes, inside the grace.
 */

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  const hang = { writes: false };
  // Hung operations park a resolver here, so a test can play “the Keychain recovers”
  // and watch the queued work drain — in order, which is the property under test.
  const release: Array<() => void> = [];
  return {
    __store: store,
    __hang: hang,
    __release: release,
    getItemAsync: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    setItemAsync: jest.fn((key: string, value: string) => {
      if (hang.writes)
        return new Promise<void>((resolve) => {
          release.push(() => {
            store.set(key, value);
            resolve();
          });
        });
      store.set(key, value);
      return Promise.resolve();
    }),
    deleteItemAsync: jest.fn((key: string) => {
      if (hang.writes)
        return new Promise<void>((resolve) => {
          release.push(() => {
            store.delete(key);
            resolve();
          });
        });
      store.delete(key);
      return Promise.resolve();
    }),
  };
});

const mocked = SecureStore as unknown as {
  __store: Map<string, string>;
  __hang: { writes: boolean };
  __release: Array<() => void>;
  setItemAsync: jest.Mock;
};

const KEY = 'sb-abheeqyjzekiowkztfxv-auth-token';

beforeEach(() => {
  mocked.__store.clear();
  mocked.__hang.writes = false;
  // Implementation, not just calls: one test swaps in a rejecting store, and `mockClear`
  // would leave that rejection in place for every test after it.
  mocked.__release.length = 0;
  mocked.setItemAsync.mockReset().mockImplementation((key: string, value: string) => {
    if (mocked.__hang.writes)
      return new Promise<void>((resolve) => {
        mocked.__release.push(() => {
          mocked.__store.set(key, value);
          resolve();
        });
      });
    mocked.__store.set(key, value);
    return Promise.resolve();
  });
  resetSessionMirror();
  resetFlightRecorder();
  jest.useFakeTimers();
});

afterEach(() => jest.useRealTimers());

describe('a Keychain write that does not answer', () => {
  it('releases the caller at the grace, and says so in the record', async () => {
    mocked.__hang.writes = true;

    const write = sessionStorage.setItem(KEY, 'session');
    const settled = jest.fn();
    void write.then(settled);

    await jest.advanceTimersByTimeAsync(3999);
    expect(settled).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(2);
    expect(settled).toHaveBeenCalled();

    // The release is evidence, not just an escape: a device doing this shows it.
    const graced = snapshot().events.filter(
      (event) => event.channel === 'store' && event.detail === 'grace',
    );
    expect(graced.length).toBe(1);
  });

  it('still serves the written value from memory after the release', async () => {
    mocked.__hang.writes = true;

    const write = sessionStorage.setItem(KEY, 'session');
    await jest.advanceTimersByTimeAsync(4001);
    await write;

    // The mirror was set optimistically, so the process behaves as signed in — which is
    // what makes releasing the caller safe rather than a lie: every read agrees.
    await expect(sessionStorage.getItem(KEY)).resolves.toBe('session');
  });
});

describe('a Keychain write that answers normally', () => {
  it('propagates success immediately and leaves no timer running', async () => {
    const before = jest.getTimerCount();
    await sessionStorage.setItem(KEY, 'session');
    expect(jest.getTimerCount()).toBe(before);
    expect(mocked.__store.size).toBeGreaterThan(0);
  });

  /**
   * A failure *inside* the grace still rejects — the caller can show an error and the
   * person can retry, exactly as before. The grace changes who waits, never who is told.
   */
  it('still rejects a write the store refuses in time', async () => {
    mocked.setItemAsync.mockRejectedValue(new Error('Keychain locked'));
    await expect(sessionStorage.setItem(KEY, 'session')).rejects.toThrow('Keychain locked');
  });
});

describe('sign-in with a hung Keychain, against the real auth client', () => {
  /**
   * **The founder's screen, as a test.** The server answers, the Keychain does not, and
   * sign-in must complete anyway — inside the grace, with `SIGNED_IN` delivered — because
   * everything after the button waits on exactly this promise.
   */
  it('resolves and emits SIGNED_IN inside the grace', async () => {
    mocked.__hang.writes = true;

    const session = {
      access_token: 'header.payload.signature',
      refresh_token: 'refresh',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: {
        id: '00000000-0000-4000-8000-000000000001',
        aud: 'authenticated',
        app_metadata: {},
        user_metadata: {},
        created_at: '2026-01-01T00:00:00Z',
      },
    };

    const fetcher = (async (input: RequestInfo | URL) =>
      String(input).includes('/auth/v1/token')
        ? new Response(JSON.stringify(session), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response('[]', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })) as typeof fetch;

    const supabase = createClient('https://project.supabase.co', 'anon-key-for-tests', {
      auth: {
        storage: sessionStorage,
        storageKey: KEY,
        autoRefreshToken: false,
        persistSession: true,
        detectSessionInUrl: false,
        flowType: 'pkce',
      },
      global: { fetch: fetcher },
    });

    const events: string[] = [];
    supabase.auth.onAuthStateChange((event) => {
      events.push(event);
    });

    const signIn = supabase.auth.signInWithPassword({
      email: 'reviewer@example.com',
      password: 'password',
    });

    const outcome = await Promise.race([
      signIn.then(({ error }) => (error ? `error:${error.message}` : 'signed-in')),
      (async () => {
        await jest.advanceTimersByTimeAsync(6000);
        return 'still-latched';
      })(),
    ]);

    expect(outcome).toBe('signed-in');
    expect(events).toContain('SIGNED_IN');
  });
});

describe('what the grace note names', () => {
  /**
   * Review 58's evidence point: a release is two different findings. `grace` means the
   * Keychain was touched and did not answer; `grace-queued` means the operation never
   * reached the Keychain at all, jammed behind an older one. A report that conflated them
   * would send the next investigation to the wrong layer.
   */
  it('says grace-queued for a write that never reached the store', async () => {
    mocked.__hang.writes = true;

    // First write occupies the key's queue at the Keychain boundary…
    void sessionStorage.setItem(KEY, 'first');
    await Promise.resolve();
    // …so the second is submitted but its disk task never starts.
    const second = sessionStorage.setItem(KEY, 'second');

    await jest.advanceTimersByTimeAsync(4001);
    await second;

    const details = snapshot()
      .events.filter((event) => event.channel === 'store')
      .map((event) => event.detail);
    expect(details).toContain('grace');
    expect(details).toContain('grace-queued');
  });

  /**
   * The half of review 58's blocker that is real and answerable: once the store recovers,
   * queued operations run in submission order, so a released write is never overtaken by
   * an older one — a sign-out followed by a new sign-in lands as the new account.
   */
  it('settles the disk in submission order once the store recovers', async () => {
    mocked.__hang.writes = true;
    const removal = sessionStorage.removeItem(KEY);
    const write = sessionStorage.setItem(KEY, 'account-b');
    await jest.advanceTimersByTimeAsync(4001);
    await removal;
    await write;

    // The store recovers: everything queued drains, in order.
    mocked.__hang.writes = false;
    mocked.__release.splice(0).forEach((release) => release());
    await jest.advanceTimersByTimeAsync(1);

    // A fresh process (mirror gone) reads the disk and finds the newest claim.
    resetSessionMirror();
    await expect(sessionStorage.getItem(KEY)).resolves.toBe('account-b');
  });
});
