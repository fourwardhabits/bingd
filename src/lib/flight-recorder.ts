import { isRelease } from './env';

/**
 * What the app was doing, kept in memory, for a phone nobody can attach a debugger to.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Three tranches in a row have been diagnosed from source, tested green locally, shipped,
 * and contradicted by the founder's iPhone. The gap is not analysis; it is that every
 * probe available from a desktop answers a *different question* from the one the device
 * poses. `npm test` proves what the code does with mocked platform promises. It cannot
 * say whether, on that handset, a query function ever ran, whether a request left the
 * client, or which stage of a sign-out is still pending after twenty seconds.
 *
 * So this records the small number of facts that would have settled each of those
 * arguments, and the Diagnostics sheet renders them as text the founder can copy out of
 * TestFlight and paste back.
 *
 * ---------------------------------------------------------------------------
 * THE ONE DISTINCTION EVERYTHING TURNS ON
 *
 * A screen that will not load is one of four different bugs, and they are indistinguishable
 * from the outside:
 *
 *   1. **never started** — the query function did not run. No `query` event for it, and
 *      React Query's own state (`pending` with `fetchStatus: idle`) agrees.
 *   2. **started, never sent** — the query ran and no request reached the network. A
 *      `query` begin event with **no matching network record**. That is the PR #53 shape:
 *      `getSession()` awaiting a refresh that never answers.
 *   3. **sent, never answered** — the request left and the reply did not come back.
 *      `reachedFetch: true`, no `endedAt`.
 *   4. **answered, then failed in the client** — a status is recorded and the query is in
 *      error anyway.
 *
 * **Mode 2 is found by subtraction, not by a flag here, and that correction matters.**
 * An earlier version of this file claimed `reachedFetch: false` would catch it. It cannot:
 * `fetchWithAuth` awaits the session *before* it calls the app's `fetch`, so a request
 * stalled there never reaches this module and leaves nothing behind at all. The begin
 * events in `flight-queries.ts` are what make the absence visible. `reachedFetch` stays
 * because it is still true and still cheap, but it is a belt rather than the mechanism.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT COSTS, WHICH MATTERS BECAUSE THE PHONE GETS WARM
 *
 * Two fixed-size arrays and a counter map. No timers, no polling, no network of its own,
 * and no writes to disk except one on the way to the background. One subscription exists
 * — `flight-queries.ts` on React Query’s cache — and it fires only on transitions the
 * library is already making. The
 * sheet reads the buffers once when it opens and once per Refresh press — it does not
 * re-render on new events. If this instrumentation shows up in a thermal measurement,
 * something is very wrong with it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT MAY NEVER CONTAIN
 *
 * No token, no header, no request body, no query string, no note, no comment, no email,
 * no OTP, no push token. Operations are named by *what they are* — `rest:rankings`,
 * `rpc:profile_identity`, `auth:token` — which is schema, not anybody's data. See
 * `logicalName`, and `flight-recorder.test.ts`, which asserts it against a URL carrying a
 * handle, a bearer token and a search term.
 */

/** Beta and below. A store build records nothing and offers no way in. */
const ENABLED = !isRelease;

/** How many network operations are kept. The last 30 covers a screen's worth of mounting. */
const NETWORK_LIMIT = 30;

/** And how many of everything else — routing, auth, onboarding, sign-out stages. */
const EVENT_LIMIT = 80;

export type NetworkPhase = 'blocked' | 'pending' | 'answered' | 'failed';

export type NetworkRecord = {
  seq: number;
  /** `rest:<table>`, `rpc:<function>`, `auth:<endpoint>`, `storage:object`. Never a URL. */
  name: string;
  /** Milliseconds since this process started, which is easier to read than a clock. */
  startedAt: number;
  /**
   * Whether the request reached `fetch` at all.
   *
   * Nearly always true by the time a record exists, because this module is only reached
   * *after* `fetchWithAuth` has awaited the session — which is exactly why a stall there is
   * found by the absence of a record rather than by this flag. Kept because it is honest
   * and free, and because the caller-abort path can still make it false.
   */
  reachedFetch: boolean;
  endedAt?: number;
  status?: number;
  /** The error's class name, never its message: a PostgREST message can echo input. */
  errorClass?: string;
  /** How many operations of this name had already started when this one did. */
  repeat: number;
};

export type EventChannel =
  | 'auth'
  | 'route'
  | 'onboarding'
  | 'signout'
  | 'push'
  | 'app'
  | 'store'
  /** Where a query *began*, which the network log cannot see — see `flight-queries.ts`. */
  | 'query';

export type FlightEvent = {
  seq: number;
  at: number;
  channel: EventChannel;
  label: string;
  /** Short, non-sensitive. A route name, a stage name, an outcome word. */
  detail?: string;
  /** How long the thing took, where the caller knows. */
  ms?: number;
};

const startedAt = Date.now();
const since = () => Date.now() - startedAt;

let seq = 0;
const network: NetworkRecord[] = [];
const events: FlightEvent[] = [];
const counters = new Map<string, number>();
const started = new Map<string, number>();

function push<T>(into: T[], item: T, limit: number) {
  into.push(item);
  if (into.length > limit) into.splice(0, into.length - limit);
}

/**
 * A URL reduced to what kind of operation it is, and nothing else.
 *
 * The query string is dropped before anything else happens, because that is where the
 * search screen puts what somebody typed and where PostgREST puts filter values —
 * `?username=eq.fourward_test` is a person, not a schema. What survives is the table or
 * function name, which is the same for every user of the app.
 *
 * Storage is collapsed rather than split: an avatar path carries an account id.
 */
export function logicalName(url: string): string {
  const path = url.split('?')[0] ?? '';

  if (path.includes('/auth/v1/')) {
    const endpoint = path.split('/auth/v1/')[1]?.split('/')[0] ?? 'unknown';
    return `auth:${endpoint}`;
  }
  if (path.includes('/storage/v1/')) return 'storage:object';
  if (path.includes('/rest/v1/rpc/')) {
    return `rpc:${path.split('/rest/v1/rpc/')[1]?.split('/')[0] ?? 'unknown'}`;
  }
  if (path.includes('/rest/v1/')) {
    return `rest:${path.split('/rest/v1/')[1]?.split('/')[0] ?? 'unknown'}`;
  }
  return 'other';
}

/**
 * Whether the recorder is currently ignoring work.
 *
 * **Review 51's third finding, and it is a subtle one: the sheet was changing the evidence
 * it was reading.** Building the report asks for the session and the two onboarding counts,
 * and those are ordinary Supabase requests — so they entered the same thirty-record ring,
 * bumped the same `repeat` counters, and on a busy session could evict the very records
 * carrying the failure. A report that pushes the failure out of its own buffer is worse
 * than no report.
 *
 * So the reads the sheet makes on its own behalf are excluded. Synchronous flag rather than
 * anything cleverer: the suppressed region is one `await` chain in one component, and a
 * counter keeps nested or overlapping opens honest.
 */
let suppressed = 0;

export async function withoutRecording<T>(work: () => Promise<T>): Promise<T> {
  suppressed += 1;
  try {
    return await work();
  } finally {
    suppressed -= 1;
  }
}
export type RequestHandle = {
  /** Called when the request actually reaches `fetch`. */
  sent: () => void;
  settled: (outcome: { status?: number; error?: unknown }) => void;
};

const inert: RequestHandle = { sent: () => {}, settled: () => {} };

/**
 * Opens a record for one request.
 *
 * Called from `requestWithDeadline`, which `@supabase/supabase-js` reaches only *after* it
 * has awaited the session — so the existence of a record already means the token wait is
 * behind it. That is why an absent record, paired with a `query` begin event, is the
 * signal for a stall upstream of the network. See `flight-queries.ts`.
 */
export function recordRequest(url: string): RequestHandle {
  if (!ENABLED || suppressed > 0) return inert;

  const name = logicalName(url);
  const repeat = started.get(name) ?? 0;
  started.set(name, repeat + 1);

  const record: NetworkRecord = {
    seq: (seq += 1),
    name,
    startedAt: since(),
    reachedFetch: false,
    repeat,
  };
  push(network, record, NETWORK_LIMIT);

  return {
    sent: () => {
      record.reachedFetch = true;
    },
    settled: ({ status, error }) => {
      record.endedAt = since();
      if (status !== undefined) record.status = status;
      if (error !== undefined) record.errorClass = classOf(error);
    },
  };
}

/** The class name only. A PostgREST message can echo the value that failed. */
function classOf(error: unknown): string {
  if (error && typeof error === 'object') {
    const named = error as { name?: unknown; constructor?: { name?: string } };
    if (typeof named.name === 'string' && named.name) return named.name;
    if (named.constructor?.name) return named.constructor.name;
  }
  return typeof error;
}

/**
 * The last route the router settled on, remembered so that the backgrounding write can
 * name it without the persistence layer needing a hook into navigation.
 */
let lastRoute: string | undefined;

export function rememberRoute(route: string) {
  if (ENABLED) lastRoute = route;
}

export function lastRouteSeen(): string | undefined {
  return lastRoute;
}
/** Records one thing that happened. `detail` must be a name or an outcome, never content. */
export function note(channel: EventChannel, label: string, detail?: string, ms?: number) {
  if (!ENABLED || suppressed > 0) return;
  push(events, { seq: (seq += 1), at: since(), channel, label, detail, ms }, EVENT_LIMIT);
}

/** Counts something that is worth a total rather than a timeline — refreshes, mounts, retries. */
export function tally(key: string, by = 1) {
  if (!ENABLED || suppressed > 0) return;
  counters.set(key, (counters.get(key) ?? 0) + by);
}

/** Times `work` and records it, whatever it does. Returns exactly what `work` returns. */
export async function timed<T>(
  channel: EventChannel,
  label: string,
  work: Promise<T>,
): Promise<T> {
  if (!ENABLED) return work;
  const began = Date.now();
  try {
    const value = await work;
    note(channel, label, 'ok', Date.now() - began);
    return value;
  } catch (error) {
    note(channel, label, classOf(error), Date.now() - began);
    throw error;
  }
}

export type FlightSnapshot = {
  enabled: boolean;
  uptimeMs: number;
  network: readonly NetworkRecord[];
  events: readonly FlightEvent[];
  counters: Readonly<Record<string, number>>;
};

/** Read once when the sheet opens. Copies, so the caller cannot hold live arrays. */
export function snapshot(): FlightSnapshot {
  return {
    enabled: ENABLED,
    uptimeMs: since(),
    network: network.map((record) => ({ ...record })),
    events: events.map((event) => ({ ...event })),
    counters: Object.fromEntries(counters),
  };
}

/**
 * The tail of this session, small enough to hand to the Keychain once.
 *
 * Written on the way to the background and read on the next launch, so that a process
 * which does not come back still says what it was doing. It is **not** a crash reporter
 * and must not be described as one: a JavaScript exception in the foreground kills the
 * process without passing through here, and nothing in this payload distinguishes a crash
 * from the operating system reclaiming memory from a backgrounded app. What it answers is
 * narrower and still worth having — *what was the last thing running*.
 */
export type LastSession = {
  endedAtIso: string;
  uptimeMs: number;
  route?: string;
  events: FlightEvent[];
  pending: string[];
};

export function tailForPersistence(route: string | undefined): LastSession {
  return {
    endedAtIso: new Date().toISOString(),
    uptimeMs: since(),
    route,
    events: events.slice(-12),
    pending: network
      .filter((record) => record.endedAt === undefined)
      .map((record) => record.name),
  };
}

/** Test seam: one test's flight must not appear in the next one's report. */
export function resetFlightRecorder() {
  seq = 0;
  network.length = 0;
  events.length = 0;
  counters.clear();
  started.clear();
  lastRoute = undefined;
  suppressed = 0;
}
