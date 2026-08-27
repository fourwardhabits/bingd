import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

import { env } from './env';
import { recordRequest } from './flight-recorder';
import { reportHandled } from './monitoring';
import { sessionStorage } from './session-storage';

/**
 * How long any one Supabase request may stay in flight.
 *
 * **This is the fix for the TestFlight build-4 stall, and the number is less important
 * than the fact that there is one at all.** Nothing in this app had a deadline: no
 * `AbortController`, no `db.timeout`, no wrapper. A phone's `fetch` is not obliged to
 * ever settle — a reply lost across a Wi-Fi/cellular handover leaves the promise open
 * for the life of the process — and `@supabase/supabase-js` awaits the session on the
 * way into *every* request, so one lost reply is not one broken screen. It is every
 * authenticated screen at once, plus sign-out. See `requestWithDeadline` below.
 *
 * Ten seconds because the measured server side of this app is 50–1100 ms against
 * bingd-nonprod, so ten is roughly an order of magnitude of headroom for a bad cellular
 * link and still short enough that a person watching a skeleton gets an answer rather
 * than a hobby.
 */
export const REQUEST_DEADLINE_MS = 10_000;

/**
 * Uploads get their own, longer budget.
 *
 * An avatar is bytes rather than a row, and ten seconds is a plausible honest duration
 * for one on a weak connection. The point of a deadline is to distinguish "slow" from
 * "never"; using the row budget for a file would call a working upload a failure.
 */
export const UPLOAD_DEADLINE_MS = 60_000;

/**
 * Which of the three things a Supabase URL is, and nothing finer.
 *
 * This is the only part of a request that gets reported when one expires, and the
 * coarseness is deliberate: the path after `/rest/v1/` names a table, and a query string
 * on the search endpoint carries what somebody typed. `lane` answers *what kind of work
 * stopped answering* — which is the question the founder's device actually poses — while
 * carrying nothing about who, or about what they were looking for.
 */
type RequestLane = 'auth' | 'storage' | 'functions' | 'rest';

/**
 * `functions` is its own lane, and it was folded into `rest` until the founder's title
 * search failed. The two are different infrastructure — PostgREST against the database
 * versus a Deno isolate that may be cold and that calls a third party — and an expiry
 * reported as `rest` when the Edge Function was the thing that stopped answering points
 * an investigation at the wrong layer. The deadline they share is unchanged.
 */
const laneOf = (url: string): RequestLane =>
  url.includes('/auth/v1/')
    ? 'auth'
    : url.includes('/storage/v1/')
      ? 'storage'
      : url.includes('/functions/v1/')
        ? 'functions'
        : 'rest';

const deadlineFor = (lane: RequestLane) =>
  lane === 'storage' ? UPLOAD_DEADLINE_MS : REQUEST_DEADLINE_MS;

/**
 * How often one lane may report an expiry.
 *
 * A broken network expires every request the app makes, and a report per request is a
 * quota spent describing one outage in a hundred identical events. One a minute per lane
 * is enough to answer "which layer stopped answering, and when did it start" — which is
 * the whole diagnostic value — without becoming its own load on a phone that is already
 * struggling.
 */
const REPORT_INTERVAL_MS = 60_000;

const lastReported = new Map<RequestLane, number>();

/** Test seam: one test's expiry must not throttle the next one's. */
export function resetExpiryReports() {
  lastReported.clear();
}

/**
 * Says that a lane stopped answering, at most once a minute, and says nothing else.
 *
 * **This is the instrumentation the build-4 investigation had no substitute for.** The
 * stall was invisible from outside: no crash, no error event, nothing in Sentry — because
 * a promise that never settles produces no exception, and the screens that were waiting on
 * it were behaving correctly. An expiry is the first moment there is anything at all to
 * report, and `lane` plus a timestamp is enough to distinguish "the token endpoint stopped
 * answering" from "the database did".
 *
 * No token, no header, no path, no query string, no account. See `RequestLane`.
 */
function reportExpiry(lane: RequestLane, deadlineMs: number) {
  const now = Date.now();
  if (now - (lastReported.get(lane) ?? 0) < REPORT_INTERVAL_MS) return;
  lastReported.set(lane, now);
  reportHandled(new RequestDeadlineError(deadlineMs), { scope: 'request.deadline', lane });
}

/** What an expired request rejects with, so callers can tell it from a server error. */
export class RequestDeadlineError extends Error {
  override readonly name = 'RequestDeadlineError';
  constructor(readonly deadlineMs: number) {
    super(`The request did not answer within ${deadlineMs}ms.`);
  }
}

/**
 * One `fetch`, with a deadline, for everything the Supabase client does.
 *
 * `global.fetch` is the single choke point: PostgREST reads, RPCs, storage and — the one
 * that matters most — the GoTrue `/token` refresh all pass through here. Bounding it here
 * rather than at forty query functions is the whole point, because the failure being
 * bounded is shared rather than per-screen.
 *
 * **An aborted refresh does not sign anybody out.** `@supabase/auth-js` classifies an
 * abort as `AuthRetryableFetchError`, and its `__loadSession` keeps a session whose
 * access token has not actually expired when a *proactive* refresh fails. So the cost of
 * a missed refresh is a retry later, not a session on the floor — which is the property
 * that makes it safe to put a clock on the auth path at all.
 *
 * The caller's own signal is honoured as well as ours, so React Query's cancellation and
 * `PostgrestBuilder.abortSignal` keep working.
 */
export const requestWithDeadline: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const lane = laneOf(url);
  const deadlineMs = deadlineFor(lane);

  /**
   * Opened **before** the token wait rather than after it, which is the whole reason the
   * recorder can answer the question three tranches have argued about.
   *
   * `fetchWithAuth` awaits `auth.getSession()` before it calls this function's `fetch`
   * below — so a request stalled on a session refresh never reaches the network and, without
   * a record opened here, would leave no trace at all. It would look identical to a query
   * that was never made. With one, the report shows it as `BLOCKED`: started, never sent.
   */
  const record = recordRequest(url);

  const controller = new AbortController();
  const timer = setTimeout(() => {
    reportExpiry(lane, deadlineMs);
    controller.abort(new RequestDeadlineError(deadlineMs));
  }, deadlineMs);

  const caller = init?.signal;
  // Detached on settle as well as the timer: React Query hands the same signal to every
  // attempt of a query, so a listener left behind holds this request's closure for as
  // long as that query is mounted. Review 49's nit, and free to close.
  let detach = () => {};
  if (caller) {
    if (caller.aborted) controller.abort(caller.reason);
    else {
      const relay = () => controller.abort(caller.reason);
      caller.addEventListener('abort', relay, { once: true });
      detach = () => caller.removeEventListener('abort', relay);
    }
  }

  // Only when a request is genuinely about to go out. An already-aborted caller signal
  // aborts the controller above and `fetch` rejects without dispatching anything — review
  // 51's finding, and reporting that as `reachedFetch` would put a lie in the one column
  // the whole report is read for.
  if (!controller.signal.aborted) record.sent();

  // Cleared on settle, or a device keeps a timer alive per request for the length of the
  // budget after the answer already arrived.
  return fetch(input, { ...init, signal: controller.signal })
    .then(
      (response) => {
        record.settled({ status: response.status });
        return response;
      },
      (error: unknown) => {
        record.settled({ error });
        throw error;
      },
    )
    .finally(() => {
      clearTimeout(timer);
      detach();
    });
};

/**
 * Every write goes through an RPC so RLS and the ranking invariants are enforced
 * in one place — see docs/architecture/api.md. Direct table writes from the
 * client are a bug even where RLS would permit them.
 */
export const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    // Keychain and Keystore, chunked. auth.md §5 forbids AsyncStorage.
    storage: sessionStorage,
    autoRefreshToken: true,
    persistSession: true,
    // React Native has no URL bar to read a callback from; deep links are
    // handled explicitly by the router instead (client.md §7).
    detectSessionInUrl: false,
    // The OAuth code is exchanged by the app rather than arriving as a token in a
    // redirect URL, so the token never passes through a URL that a browser, a log,
    // or another app registered for the scheme could observe.
    flowType: 'pkce',
  },
  global: { fetch: requestWithDeadline },
});

/**
 * Where this device's session actually lives.
 *
 * Sign-out needs it: ending a session locally means deleting this Keychain entry, and
 * doing that directly is what makes the exit independent of a reply from the network
 * (`features/auth/methods.ts`). `@supabase/auth-js` owns the value and computes it from
 * the project ref, but types it `protected` — so it is read through a cast here, once,
 * with the derivation as the fallback rather than as the primary. Reading what the
 * client is really using is the version that cannot drift; the fallback only covers a
 * future release that renames the field, and `supabase.test.ts` fails if the two
 * disagree.
 */
const derivedStorageKey = `sb-${new URL(env.supabaseUrl).hostname.split('.')[0]}-auth-token`;

export const authStorageKey: string =
  (supabase.auth as unknown as { storageKey?: string }).storageKey || derivedStorageKey;

/**
 * "This device has signed out", said by the app when Supabase cannot say it itself.
 *
 * **Independent review 49's first blocker, and the reason a local exit needs more than a
 * deleted Keychain entry.** `AuthProvider` learns that a session has ended from
 * `onAuthStateChange`, and `@supabase/auth-js` emits `SIGNED_OUT` from `_removeSession` —
 * *after* it has awaited three storage operations, one of which reads a key the mirror has
 * never seen. On the device this hotfix is about, those are exactly the calls that were not
 * answering. So the event that tells the app it is signed out was itself behind the thing
 * that was stuck, and `useAuthRouting`, still seeing a `ready` session, correctly sent the
 * escaping user straight back to the screen they were leaving.
 *
 * This is the app's own answer to the same question, on the path where the library's cannot
 * arrive. `signOut` announces it once the credential is gone from this device; the provider
 * treats it exactly as it treats a null session, which is what it already does for a real
 * `SIGNED_OUT`. It is deliberately not a general event bus: one signal, one meaning, one
 * emitter.
 */
type LocalSignOutListener = () => void;

const localSignOutListeners = new Set<LocalSignOutListener>();

/** Returns its own unsubscribe, so an effect can hand it back directly. */
export function onLocalSignOut(listener: LocalSignOutListener): () => void {
  localSignOutListeners.add(listener);
  return () => {
    localSignOutListeners.delete(listener);
  };
}

/**
 * Says the credential on this device is gone. Called by `signOut` and by nothing else.
 *
 * A copy of the set, because a listener that unsubscribes itself while being notified
 * would otherwise mutate the collection being iterated.
 */
export function announceLocalSignOut(): void {
  for (const listener of [...localSignOutListeners]) listener();
}

/**
 * Supabase refreshes on a timer, and a timer does not run while the app is
 * suspended. Without this, a session that expired in the background stays expired
 * until something happens to trigger a refresh — so the first query after
 * reopening fails, and the retry succeeds, which reads as a flaky network.
 */
export function startSessionRefresh() {
  const apply = (state: string) => {
    if (state === 'active') void supabase.auth.startAutoRefresh();
    else void supabase.auth.stopAutoRefresh();
  };

  apply(AppState.currentState);
  const subscription = AppState.addEventListener('change', apply);
  return () => subscription.remove();
}
