/**
 * The front page's ranking demo, with no DOM in sight.
 *
 * `router.mjs`'s rule, applied to the one interactive thing on the landing page: every
 * decision lives here, where `node --test` can reach it, and `page.mjs` only paints the
 * answer. Shipped verbatim like the router, so what the tests import is what a phone runs.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE DEMO IS, AND WHAT IT DOES NOT CLAIM TO BE
 * ---------------------------------------------------------------------------
 *
 * Five head-to-head choices between movies, turned into an order. The mechanic is the
 * app's own: a title is placed by a **binary search over the list you already have**
 * (`src/features/ranking/session.ts`), one comparison at a time, and a placement that
 * runs out of comparisons lands at the midpoint of what is still possible — which is
 * what the app does when somebody skips too often.
 *
 * What is deliberately absent is everything that would make the result look more
 * authoritative than five taps can support. No "How was it?" bucket, so no band and **no
 * score**: a 0–10 number here would be invented, and the page would be teaching a
 * stranger that bingd's scores are made up. The result is called a demo ranking and is
 * an order, nothing more.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE MOVIES COME FROM
 * ---------------------------------------------------------------------------
 *
 * Today's `trending.movie.day` list, read the way the app's Trending shelf reads it
 * (`src/features/trending/use-trending.ts`): one select on `provider_list_cache` for the
 * ordered ids, one on `media_items` for the titles. Both tables are `using (true)` —
 * catalogue data with nobody attached — and both are read with the anon key the router
 * pages already carry. Nothing here writes, calls an RPC or touches TMDB's API.
 *
 * Anything short of a usable list — no Supabase config in a local build, offline, an
 * empty or stale cache, a malformed payload — is one answer: `FALLBACK_MOVIES`.
 */

import { posterUrl } from './router.mjs';

/** Five successful choices, then the result. Swaps never count toward it. */
export const DEMO_CHOICES = 5;

/** Fewer usable trending movies than this and the fixed list is the better demo. */
export const MIN_LIVE_MOVIES = 8;

/** The most the demo will draw from one list. TMDB's daily list is twenty long. */
export const MAX_LIVE_MOVIES = 20;

/**
 * How stale a trending list may be and still be called trending.
 *
 * The app's `TRENDING_MAX_AGE_MS`, for the app's reason: a list nobody has refreshed in a
 * week is not "today's trending movies", and the fixed list is more honest than a label
 * the data cannot support.
 */
export const TRENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The deterministic list for a local build, a network failure or an unusable cache.
 *
 * Films most people have an opinion about, across decades, so the first pair is
 * answerable by almost anybody. **No poster paths**, on purpose: the fallback is what
 * renders when the network is the problem, so it must not depend on TMDB's CDN either.
 * The page draws a typographic tile instead.
 */
export const FALLBACK_MOVIES = Object.freeze(
  [
    ['Jurassic Park', 1993],
    ['Titanic', 1997],
    ['The Dark Knight', 2008],
    ['Toy Story', 1995],
    ['Inception', 2010],
    ['Barbie', 2023],
    ['The Matrix', 1999],
    ['Parasite', 2019],
    ['Get Out', 2017],
    ['Back to the Future', 1985],
    ['Spirited Away', 2001],
    ['Oppenheimer', 2023],
    ['Mad Max: Fury Road', 2015],
    ['Pulp Fiction', 1994],
    ['La La Land', 2016],
    ['Everything Everywhere All at Once', 2022],
  ].map(([title, year], index) =>
    Object.freeze({ id: `fallback-${index + 1}`, title, year, poster: null }),
  ),
);

const SUPABASE_URL = /^https:\/\/[a-z0-9.-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The select for today's trending movie ids, or null when there is no Supabase to ask.
 *
 * One key, named literally. The `.day` list for the app's reason (`use-trending.ts`):
 * "trending now" over a seven-day window is a weaker claim.
 */
export function trendingListRequest(supabaseUrl) {
  if (typeof supabaseUrl !== 'string' || !SUPABASE_URL.test(supabaseUrl)) return null;
  return (
    `${supabaseUrl}/rest/v1/provider_list_cache` +
    '?list_key=eq.trending.movie.day&select=payload,fetched_at&limit=1'
  );
}

/**
 * The ordered movie ids from a `provider_list_cache` row, or an empty array.
 *
 * The payload is server data rather than URL data, and it is still validated as if it
 * were neither: every id must be a uuid before it is allowed into the next request's
 * query string, and a row too old to call trending yields nothing.
 */
export function trendingIdsFrom(row, now = Date.now()) {
  if (!row || typeof row !== 'object') return [];

  const fetched = Date.parse(typeof row.fetched_at === 'string' ? row.fetched_at : '');
  if (Number.isNaN(fetched) || now - fetched > TRENDING_MAX_AGE_MS) return [];

  const ids = row.payload && typeof row.payload === 'object' ? row.payload.ids : null;
  if (!Array.isArray(ids)) return [];

  const seen = new Set();
  for (const id of ids) {
    if (typeof id === 'string' && UUID.test(id)) seen.add(id);
    if (seen.size === MAX_LIVE_MOVIES) break;
  }
  return [...seen];
}

/**
 * The select for those ids' titles, or null.
 *
 * Named columns, for `titleContextRequest`'s reason: `media_items` is world readable, so
 * a `select=*` would quietly ship whatever column is added to it next. `kind=eq.movie`
 * is belt to `demoMoviesFrom`'s braces — the list is movies by key, and a stray series
 * id would be dropped either way.
 */
export function trendingMoviesRequest(supabaseUrl, ids) {
  if (typeof supabaseUrl !== 'string' || !SUPABASE_URL.test(supabaseUrl)) return null;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_LIVE_MOVIES) return null;
  if (!ids.every((id) => typeof id === 'string' && UUID.test(id))) return null;
  return (
    `${supabaseUrl}/rest/v1/media_items?id=in.(${ids.join(',')})` +
    '&kind=eq.movie&select=id,kind,title,release_date,poster_path'
  );
}

/**
 * The demo's movies, in trending order, built from named fields and nothing else.
 *
 * Every field is checked on the way in. The title is collapsed and capped because it is
 * drawn into a fixed tile; the poster is `posterUrl`'s or nothing, so no value from the
 * row can become an `img.src` that leaves TMDB's CDN. Rows the ids did not ask for are
 * ignored, and an id whose row did not come back is dropped rather than drawn blank.
 */
export function demoMoviesFrom(ids, rows) {
  if (!Array.isArray(ids) || !Array.isArray(rows)) return [];

  const byId = new Map();
  for (const row of rows) {
    if (row && typeof row === 'object' && typeof row.id === 'string') byId.set(row.id, row);
  }

  const movies = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || row.kind !== 'movie') continue;

    const title = typeof row.title === 'string' ? row.title.replace(/\s+/g, ' ').trim() : '';
    if (!title || title.length > 200) continue;

    const year = /^(\d{4})-\d{2}-\d{2}$/.exec(String(row.release_date ?? ''));
    movies.push({
      id,
      title,
      year: year ? Number(year[1]) : null,
      poster: posterUrl(row.poster_path),
    });
  }
  return movies;
}

/** Live movies if there are enough of them to be a demo, otherwise the fixed list. */
export function demoSource(movies) {
  return Array.isArray(movies) && movies.length >= MIN_LIVE_MOVIES
    ? { live: true, movies }
    : { live: false, movies: FALLBACK_MOVIES };
}

// ---------------------------------------------------------------------------
// The ranking itself
//
// A state is a plain object and every step returns a new one, so a test can walk the
// whole demo without a page and `page.mjs` can repaint from whatever it is handed.
//
//   ranked     best first — the visitor's demo ranking so far
//   candidate  the movie being placed
//   lo, hi     the insertion indices still consistent with every choice made
//   next       where the next candidate is drawn from in `pool`
// ---------------------------------------------------------------------------

/**
 * A fresh demo. `attempt` rotates where in the list it starts, so "Try again" opens on a
 * different pair rather than replaying the last one — and the same attempt always opens
 * on the same pair, so it is deterministic.
 */
export function startDemo(movies, attempt = 0) {
  const source = Array.isArray(movies) ? movies.filter(Boolean) : [];
  const shift = source.length ? (attempt * DEMO_CHOICES) % source.length : 0;
  const pool = [...source.slice(shift), ...source.slice(0, shift)];

  if (pool.length < 2) {
    return { pool, ranked: pool.slice(0, 1), candidate: null, lo: 0, hi: 0, next: pool.length, selections: 0, done: true };
  }
  return { pool, ranked: [pool[0]], candidate: pool[1], lo: 0, hi: 1, next: 2, selections: 0, done: false };
}

/** The movie the candidate is measured against: the middle of what is still possible. */
const pivotIndex = (state) => Math.floor((state.lo + state.hi) / 2);

/**
 * The two movies on screen, or null once the demo is over.
 *
 * Sides alternate with each choice so the newcomer is not always on the same side,
 * which would make "the right one is the new one" a pattern somebody could learn.
 */
export function currentPair(state) {
  if (!state || state.done || !state.candidate) return null;
  const pivot = state.ranked[pivotIndex(state)];
  return state.selections % 2 === 0
    ? { left: pivot, right: state.candidate }
    : { left: state.candidate, right: pivot };
}

/** Puts the candidate at `index` and draws the next one, or ends when there is none. */
function place(state, index) {
  const ranked = [...state.ranked.slice(0, index), state.candidate, ...state.ranked.slice(index)];
  return draw({ ...state, ranked });
}

function draw(state) {
  if (state.next >= state.pool.length) {
    return { ...state, candidate: null, lo: 0, hi: 0, done: true };
  }
  return {
    ...state,
    candidate: state.pool[state.next],
    lo: 0,
    hi: state.ranked.length,
    next: state.next + 1,
  };
}

/**
 * One choice. `id` is the movie the visitor preferred; anything not on screen is ignored.
 *
 * The fifth choice ends the demo. A placement it leaves unfinished lands at the midpoint
 * of the positions every choice still allows — the app's own answer to a search that
 * ran out — so the result never contradicts anything the visitor actually picked.
 */
export function choose(state, id) {
  const pair = currentPair(state);
  if (!pair || (id !== pair.left.id && id !== pair.right.id)) return state;

  const mid = pivotIndex(state);
  const preferred = id === state.candidate.id;
  const narrowed = {
    ...state,
    selections: state.selections + 1,
    lo: preferred ? state.lo : mid + 1,
    hi: preferred ? mid : state.hi,
  };

  const settled = narrowed.lo === narrowed.hi;

  if (narrowed.selections >= DEMO_CHOICES) {
    const index = settled ? narrowed.lo : Math.floor((narrowed.lo + narrowed.hi) / 2);
    const ranked = [
      ...narrowed.ranked.slice(0, index),
      narrowed.candidate,
      ...narrowed.ranked.slice(index),
    ];
    return { ...narrowed, ranked, candidate: null, lo: 0, hi: 0, done: true };
  }

  return settled ? place(narrowed, narrowed.lo) : narrowed;
}

/** Whether there is anything left to swap in. */
export function canSwap(state) {
  if (!state || state.done || !state.candidate) return false;
  const needed = state.ranked.length === 1 ? 2 : 1;
  return state.pool.length - state.next >= needed;
}

/**
 * "Haven't seen both? Swap pair." Never counts as a choice.
 *
 * The newcomer is set aside and a fresh one drawn, with its search started over. If the
 * list is still the one movie the demo opened with, that one has never been chosen
 * either, so it is replaced too: both films on screen were unseen candidates.
 *
 * A movie already in the list stays, because the visitor put it there by picking it.
 */
export function swap(state) {
  if (!canSwap(state)) return state;

  if (state.ranked.length === 1) {
    const ranked = [state.pool[state.next]];
    return {
      ...state,
      ranked,
      candidate: state.pool[state.next + 1],
      lo: 0,
      hi: 1,
      next: state.next + 2,
    };
  }

  return {
    ...state,
    candidate: state.pool[state.next],
    lo: 0,
    hi: state.ranked.length,
    next: state.next + 1,
  };
}

/** The ordered result, best first. Positions only: the demo has no scores to give. */
export function demoResult(state) {
  if (!state || !state.done) return [];
  return state.ranked.map((movie, index) => ({ position: index + 1, ...movie }));
}
