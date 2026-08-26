import { createClient } from '@supabase/supabase-js';

import { reportHandled } from './monitoring';
import {
  REQUEST_DEADLINE_MS,
  RequestDeadlineError,
  UPLOAD_DEADLINE_MS,
  authStorageKey,
  requestWithDeadline,
  resetExpiryReports,
} from './supabase';

/**
 * The build-4 stall, pinned.
 *
 * **What the founder's device did, and why one fault explains all of it.** Every request
 * `@supabase/supabase-js` makes — a table read, an RPC, a storage upload, and sign-out —
 * is built by `fetchWithAuth`, which awaits `auth.getSession()` on the way in. `getSession`
 * holds no session in memory: it reads storage, and if the access token is inside the
 * 90-second expiry margin it awaits a `/token` refresh. So a refresh that never answers is
 * not one broken screen. It is *every authenticated screen at once, plus the way out* —
 * which is the shape of what was observed: collection skeletons that never resolve, profile
 * counts stuck on the em dash that means "pending", For You unresolved, and "Signing out…"
 * that does not arrive anywhere.
 *
 * The first test reproduces all of that from one injected fault, against the real client
 * library. The rest pin the property the fix buys: nothing waits forever.
 */

// Sentry is a no-op without a DSN, and the test configuration has none — so the real
// `reportHandled` would return before doing anything and the assertions about *what* it
// is handed could not be written at all.
jest.mock('./monitoring', () => ({ reportHandled: jest.fn() }));

const KEY = 'sb-project-auth-token';

/** A session whose access token is valid but inside the 90s margin that triggers a refresh. */
const sessionInsideRefreshMargin = () =>
  JSON.stringify({
    access_token: 'header.payload.signature',
    refresh_token: 'refresh',
    token_type: 'bearer',
    expires_in: 60,
    expires_at: Math.floor(Date.now() / 1000) + 60,
    user: {
      id: '00000000-0000-4000-8000-000000000001',
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-01-01T00:00:00Z',
    },
  });

function memoryStorage(seed?: string) {
  const held = new Map<string, string>();
  if (seed) held.set(KEY, seed);
  return {
    getItem: async (key: string) => held.get(key) ?? null,
    setItem: async (key: string, value: string) => void held.set(key, value),
    removeItem: async (key: string) => void held.delete(key),
  };
}

/** Answers rows instantly and never answers the token endpoint — one lost reply. */
function hungRefreshFetch() {
  const calls = { token: 0, rest: 0 };
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/auth/v1/token')) {
      calls.token += 1;
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
      });
    }
    calls.rest += 1;
    return Promise.resolve(
      new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  }) as typeof fetch;
  return { fetcher, calls };
}

const clientWith = (fetcher: typeof fetch, storage: ReturnType<typeof memoryStorage>) =>
  createClient('https://project.supabase.co', 'anon-key-for-tests', {
    auth: {
      storage,
      storageKey: KEY,
      // The ticker is the app's own concern (`startSessionRefresh`) and would add a
      // second, unrelated refresh to every test here.
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
    global: { fetch: fetcher },
  });

/** Resolves to the sentinel when `work` has not settled within `ms` of fake time. */
const PENDING = Symbol('pending');
async function settleWithin<T>(work: PromiseLike<T>, ms: number): Promise<T | typeof PENDING> {
  const raced = Promise.race<T | typeof PENDING>([
    work,
    new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), ms)),
  ]);
  await jest.advanceTimersByTimeAsync(ms);
  return raced;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.useFakeTimers();
  (reportHandled as jest.Mock).mockClear();
  resetExpiryReports();
});
afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});

describe('the shared stall', () => {
  /**
   * **The defect, reproduced.** One unanswered refresh, and four unrelated operations
   * across four screens never settle — and none of them even reaches the network, which
   * is why the backend answering healthy from a desktop proved nothing about the phone.
   */
  it('is one unanswered refresh holding every authenticated operation, with no deadline', async () => {
    const { fetcher, calls } = hungRefreshFetch();
    const supabase = clientWith(fetcher, memoryStorage(sessionInsideRefreshMargin()));

    // What Collection draws skeleton rows for.
    const collection = supabase.from('user_media').select('*').eq('user_id', 'u');
    // One of the four numbers the profile header shows as `—` while pending.
    const followers = supabase
      .from('follows')
      .select('*', { count: 'exact', head: true })
      .eq('followee_id', 'u');
    // For You.
    const recommendations = supabase.rpc('recommendations_for', { p_user: 'u' });
    // And the way out.
    const signOut = supabase.auth.signOut({ scope: 'local' });

    // Two minutes of it, each. The point is not that they are slow.
    await expect(settleWithin(collection, 120_000)).resolves.toBe(PENDING);
    await expect(settleWithin(followers, 120_000)).resolves.toBe(PENDING);
    await expect(settleWithin(recommendations, 120_000)).resolves.toBe(PENDING);
    await expect(settleWithin(signOut, 120_000)).resolves.toBe(PENDING);

    // One refresh, shared: `refreshingDeferred` dedupes concurrent callers onto a single
    // promise, so this is literally one unresolved operation holding the whole app.
    expect(calls.token).toBe(1);
    // And nothing else was ever sent. The stall is upstream of the network.
    expect(calls.rest).toBe(0);
  });

  /**
   * The same fault, through the deadline the app now installs in `global.fetch`.
   *
   * `@supabase/auth-js` retries a refresh on its own exponential backoff and stops when
   * the next backoff would pass its 30-second ceiling, so the worst case for the *first*
   * caller is that ceiling rather than the per-request deadline. What matters is that a
   * worst case exists at all, and that afterwards the operation reports rather than hangs.
   */
  it('ends within a bounded time once every request carries a deadline', async () => {
    const { fetcher, calls } = hungRefreshFetch();
    globalThis.fetch = fetcher;

    const supabase = clientWith(
      requestWithDeadline,
      memoryStorage(sessionInsideRefreshMargin()),
    );

    const collection = await settleWithin(
      supabase.from('user_media').select('*').eq('user_id', 'u'),
      60_000,
    );

    expect(collection).not.toBe(PENDING);
    expect(calls.token).toBeGreaterThan(0);
  });

  /**
   * **And the session survives it**, which is the property that makes putting a clock on
   * the auth path safe at all. `@supabase/auth-js` classifies an abort as a retryable
   * fetch error, and keeps a session whose access token has not actually expired when a
   * *proactive* refresh fails. A deadline that signed people out would be a worse bug
   * than the one it fixes.
   */
  it('does not sign anybody out when the refresh is the thing that timed out', async () => {
    const { fetcher } = hungRefreshFetch();
    globalThis.fetch = fetcher;

    const storage = memoryStorage(sessionInsideRefreshMargin());
    const supabase = clientWith(requestWithDeadline, storage);

    await settleWithin(supabase.from('user_media').select('*').eq('user_id', 'u'), 60_000);

    expect(await storage.getItem(KEY)).not.toBeNull();
  });
});

describe('requestWithDeadline', () => {
  it('rejects a request that never answers', async () => {
    // A platform `fetch` rejects when its signal aborts; this stands in for one.
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason));
      })) as typeof fetch;

    const caught = requestWithDeadline('https://project.supabase.co/rest/v1/profiles').catch(
      (error: unknown) => error,
    );
    await jest.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS + 1);

    // The abort *reason*, not a bare AbortError: a report that says "took too long"
    // rather than "cancelled" is the difference between a diagnosable stall and a shrug.
    await expect(caught).resolves.toBeInstanceOf(RequestDeadlineError);
  });

  it('does not disturb a request that answers inside the budget', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('ok', { status: 200 }))) as typeof fetch;

    const response = await requestWithDeadline('https://project.supabase.co/rest/v1/profiles');
    expect(response.status).toBe(200);
  });

  /**
   * An upload is bytes rather than a row. Spending the row budget on one would call a
   * working avatar upload on a weak connection a failure.
   */
  it('gives storage a longer budget than a row read', async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as typeof fetch;

    void requestWithDeadline(
      'https://project.supabase.co/storage/v1/object/avatars/a.jpg',
    ).catch(() => {});

    await jest.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS + 1_000);
    expect(seen?.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(UPLOAD_DEADLINE_MS);
    expect(seen?.aborted).toBe(true);
  });

  /**
   * React Query cancels a query when its last observer unmounts, and
   * `PostgrestBuilder.abortSignal` is how a caller cancels its own. Neither may be lost
   * because the deadline installed a signal of its own.
   */
  it("honours the caller's own cancellation", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as typeof fetch;

    const caller = new AbortController();
    void requestWithDeadline('https://project.supabase.co/rest/v1/profiles', {
      signal: caller.signal,
    }).catch(() => {});

    await Promise.resolve();
    expect(seen?.aborted).toBe(false);

    caller.abort();
    expect(seen?.aborted).toBe(true);
  });

  /**
   * Or a phone keeps one live timer per request for the length of the budget after the
   * answer already arrived — which on five mounted tabs is a background task nobody asked
   * for, and is the kind of thing that shows up as warmth rather than as a bug report.
   */
  it('clears its timer when the answer arrives', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response('ok'))) as typeof fetch;

    const before = jest.getTimerCount();
    await requestWithDeadline('https://project.supabase.co/rest/v1/profiles');
    expect(jest.getTimerCount()).toBe(before);
  });

  /**
   * And it lets go of the caller's signal too. React Query hands the same signal to every
   * attempt of a query, so a listener left behind holds this request's closure for as long
   * as that query stays mounted. Review 49's nit, and free to close.
   */
  it('detaches from the caller signal when the answer arrives', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response('ok'))) as typeof fetch;

    const caller = new AbortController();
    const removeEventListener = jest.spyOn(caller.signal, 'removeEventListener');

    await requestWithDeadline('https://project.supabase.co/rest/v1/profiles', {
      signal: caller.signal,
    });

    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

describe('what an expiry reports', () => {
  /**
   * **The stall produced no crash, no error event and nothing in Sentry**, because a
   * promise that never settles raises nothing and the screens waiting on it were behaving
   * correctly. An expiry is the first moment there is anything at all to report — and the
   * first moment there is anything to leak, which is why this asserts the shape of the
   * report rather than merely that one happens.
   */
  it('names the lane and carries nothing else', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason));
      })) as typeof fetch;

    void requestWithDeadline(
      'https://project.supabase.co/rest/v1/profiles?select=id&username=eq.fourward_test',
      { headers: { Authorization: 'Bearer header.payload.signature', apikey: 'anon-key' } },
    ).catch(() => {});
    await jest.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS + 1);

    expect(reportHandled).toHaveBeenCalledTimes(1);
    const [error, context] = (reportHandled as jest.Mock).mock.calls[0] as [
      Error,
      Record<string, unknown>,
    ];

    expect(context).toEqual({ scope: 'request.deadline', lane: 'rest' });
    // No table, no handle, no query string, no token, no key. The whole report is a lane
    // and a number of milliseconds.
    const written = `${error.message} ${JSON.stringify(context)}`;
    for (const secret of [
      'fourward_test',
      'header.payload.signature',
      'anon-key',
      'profiles',
    ]) {
      expect(written).not.toContain(secret);
    }
  });

  /**
   * A broken network expires every request the app makes. One report a minute per lane
   * answers "which layer stopped answering, and when"; a report per request would be a
   * second load on a phone that is already struggling.
   */
  it('does not report the same lane again inside the interval', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason));
      })) as typeof fetch;

    for (let i = 0; i < 5; i += 1) {
      void requestWithDeadline('https://project.supabase.co/rest/v1/user_media').catch(
        () => {},
      );
    }
    await jest.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS + 1);

    expect(reportHandled).toHaveBeenCalledTimes(1);
  });
});

describe('RequestDeadlineError', () => {
  it('names itself, so a report can tell a timeout from a refusal', () => {
    const error = new RequestDeadlineError(10_000);
    expect(error.name).toBe('RequestDeadlineError');
    expect(error.deadlineMs).toBe(10_000);
  });
});

describe('authStorageKey', () => {
  /**
   * Sign-out deletes this entry directly, so it has to be the one the client is really
   * using. The library types it `protected`; this is the assertion that notices if a
   * future release renames the field and the cast quietly starts reading `undefined`.
   */
  it('is the key the Supabase client itself uses', () => {
    expect(authStorageKey).toBe('sb-project-auth-token');
  });
});
