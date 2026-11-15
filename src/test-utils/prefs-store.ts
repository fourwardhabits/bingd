/**
 * An in-memory stand-in for `@/lib/prefs`, for screen suites that remember a selection.
 *
 * For You remembers where the reader was (2026-11-12). Under the unit runner the real
 * `readPref` goes through `sessionStorage`, whose memory mirror is module state: a test
 * that ends on Top Rated would hand Top Rated to the next test in the same file, and the
 * order of a suite would decide what it asserts. Each suite that renders For You mocks
 * prefs with this and clears it in `beforeEach`:
 *
 *     jest.mock('@/lib/prefs', () => jest.requireActual('@/test-utils/prefs-store').prefsModule);
 *     beforeEach(() => prefStore.reset());
 *
 * `holdReads` is what makes the races expressible: a held read answers with what the store
 * held **when the read started**, which is the stale answer a slow store gives, rather than
 * whatever a tap wrote in the meantime.
 */

type Deferred = { snapshot: unknown; resolve: (value: unknown) => void; reject: (e: Error) => void };

const values = new Map<string, unknown>();
const writes: { name: string; value: unknown }[] = [];
const reads: string[] = [];
const failing = new Set<string>();
const held = new Map<string, Deferred[]>();

export const prefStore = {
  /** What a key holds now, or undefined when nothing was ever written. */
  get: (name: string) => values.get(name),
  /** Seeds a key, as a previous launch would have left it. Not recorded as a write. */
  set: (name: string, value: unknown) => {
    values.set(name, value);
  },
  /** Every `writePref`, in order. */
  writes,
  /** Every `readPref` key, in order. */
  reads,
  /** Reads of these keys reject, as a store that refuses does. */
  failing,
  /** Reads of `name` from now on wait until `releaseReads(name)`. */
  holdReads: (name: string) => {
    if (!held.has(name)) held.set(name, []);
  },
  /** Whether a read of `name` is waiting. */
  pendingReads: (name: string) => held.get(name)?.length ?? 0,
  /** Answers every waiting read of `name` with its snapshot, and stops holding it. */
  releaseReads: (name: string, outcome: 'resolve' | 'reject' = 'resolve') => {
    const waiting = held.get(name) ?? [];
    held.delete(name);
    for (const read of waiting) {
      if (outcome === 'reject') read.reject(new Error('store unavailable'));
      else read.resolve(read.snapshot);
    }
  },
  reset: () => {
    values.clear();
    writes.length = 0;
    reads.length = 0;
    failing.clear();
    held.clear();
  },
};

export const prefsModule = {
  readPref: (name: string): Promise<unknown> => {
    reads.push(name);
    if (failing.has(name)) return Promise.reject(new Error('store unavailable'));
    const snapshot = values.has(name) ? values.get(name) : null;
    const waiting = held.get(name);
    if (waiting) {
      return new Promise((resolve, reject) => waiting.push({ snapshot, resolve, reject }));
    }
    return Promise.resolve(snapshot);
  },
  writePref: (name: string, value: unknown): Promise<void> => {
    writes.push({ name, value });
    values.set(name, value);
    return Promise.resolve();
  },
};
