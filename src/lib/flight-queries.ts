import type { QueryClient } from '@tanstack/react-query';

import { note, tally } from './flight-recorder';

/**
 * Where a query *began*, which the network log cannot see and which is the whole point.
 *
 * ---------------------------------------------------------------------------
 * THE MISTAKE THIS EXISTS TO CORRECT
 *
 * The first version of this instrumentation opened its record inside
 * `requestWithDeadline` — the app's `global.fetch` — on the reasoning that it would then
 * see a request that started and never reached the network. It would not, and reading
 * `@supabase/supabase-js` says why in one line:
 *
 *     return async (input, init) => {
 *       const realToken = await getAccessToken();   // the session wait
 *       ...
 *       return fetch$1(input, { ...init, headers }); // our fetch, only now
 *     }
 *
 * `fetchWithAuth` awaits the session **before** it calls the custom fetch. So a request
 * stalled on `getSession()` — which is precisely the PR #53 failure and the most likely
 * remaining suspect — never reaches the recorder at all and leaves no trace. It would have
 * been indistinguishable from a query that was never made, which is the exact confusion
 * this whole surface is meant to end.
 *
 * ---------------------------------------------------------------------------
 * SO THE START IS RECORDED ONE LAYER UP
 *
 * React Query announces every fetch it begins. Pairing that against the network log gives
 * the answer directly, and by subtraction:
 *
 *   · a `fetch` here **and** a matching network record → the request left the client;
 *   · a `fetch` here and **no** network record → it never got past the session wait. That
 *     is the finding, and it is only visible because these two logs exist side by side;
 *   · **no** `fetch` here at all, for a query the screen is waiting on → the query function
 *     never ran, which is a routing or an `enabled` problem rather than a network one.
 *
 * A subscription rather than a poll: React Query calls this on transitions it is already
 * making, so the cost is one callback per query state change and nothing at all when the
 * app is idle. It is registered once, at the root, and never torn down for the life of the
 * process.
 */

/** React Query's cache event, narrowed to the two fields this needs. */
type CacheEvent = {
  type: string;
  query: { queryKey: readonly unknown[] };
  action?: { type?: string };
};

/** The first element of a query key, which is the name; the rest are ids and are dropped. */
const nameOf = (key: readonly unknown[]) => (typeof key[0] === 'string' ? key[0] : 'unnamed');

/**
 * Starts watching. Returns its own teardown so the root effect can hand it straight back,
 * even though in practice nothing unsubscribes before the process ends.
 */
export function watchQueries(client: QueryClient): () => void {
  return client.getQueryCache().subscribe((event) => {
    const { type, query, action } = event as unknown as CacheEvent;
    if (type !== 'updated' || !action?.type) return;

    if (action.type === 'fetch') {
      tally('query.fetches');
      note('query', nameOf(query.queryKey), 'begin');
      return;
    }
    if (action.type === 'success' || action.type === 'error') {
      note('query', nameOf(query.queryKey), action.type);
    }
  });
}
