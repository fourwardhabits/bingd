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
 * Three picks between two movies, turned into a rough order of four. It exists to show
 * the interaction — pick the one you liked more, see an order appear — in a few seconds,
 * and then get out of the way of the store buttons beside it.
 *
 * So each newcomer gets **one comparison**, not the app's full binary search
 * (`src/features/ranking/session.ts`): it is shown against the middle of the order so
 * far and placed directly above or below that movie, on the side the visitor chose.
 * That is the least the one answer can claim, and it never contradicts any pick made:
 * the movies already placed keep their order, and the newcomer's only relation is the
 * one the visitor just stated. Three picks therefore always place four movies.
 *
 * Which unseen movie comes next prefers a **different genre family** from the one it
 * will face: "a comedy or an action movie?" is an easier, more telling pick than two
 * superhero films. Families come from the list, are never shown, and are never asked
 * about; first match in list order keeps every pair deterministic.
 *
 * What is deliberately absent is everything that would make the result look more
 * authoritative than three taps can support. No "How was it?" bucket, so no band and
 * **no score**: a 0–10 number here would be invented, and the page would be teaching a
 * stranger that bingd's scores are made up. The result is called a demo ranking and is
 * an order, nothing more.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE MOVIES COME FROM
 * ---------------------------------------------------------------------------
 *
 * `demo-movies.mjs`, a committed list. Nothing here reads Supabase or TMDB's API; the
 * only network the demo causes is the poster images, from TMDB's CDN, through
 * `posterUrl`. The list is still validated on the way in, because it is meant to be
 * replaced by a generated one (see that file) and a generator can be wrong.
 */

import { DEMO_LIST } from './demo-movies.mjs';
import { posterUrl } from './router.mjs';

/** Three successful picks, then the result. Swaps never count toward it. */
export const DEMO_CHOICES = 3;

/** One opening movie, plus one newcomer per pick. */
export const DEMO_RESULT_SIZE = DEMO_CHOICES + 1;

/** The genre families a list may tag a movie with. Used to choose pairs, never shown. */
export const DEMO_FAMILIES = Object.freeze(['action', 'comedy', 'drama', 'thriller', 'scifi', 'animation', 'romance']);

/**
 * The demo's movies from a list in `demo-movies.mjs`'s shape, built from named fields.
 *
 * An entry with no positive integer TMDB id, a repeated id, or no usable title is
 * dropped. The title is collapsed and capped because it is drawn into a fixed card; the
 * poster is `posterUrl`'s or nothing, so no value in the list can become an `img.src`
 * that leaves TMDB's CDN.
 */
export function demoMovies(list) {
  const entries = list && typeof list === 'object' && Array.isArray(list.movies) ? list.movies : [];

  const seen = new Set();
  const movies = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;

    const { tmdbId } = entry;
    if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0 || seen.has(tmdbId)) continue;

    const title = typeof entry.title === 'string' ? entry.title.replace(/\s+/g, ' ').trim() : '';
    if (!title || title.length > 200) continue;

    seen.add(tmdbId);
    movies.push(
      Object.freeze({
        id: `tmdb-${tmdbId}`,
        title,
        year: Number.isInteger(entry.year) && entry.year >= 1870 && entry.year <= 2100 ? entry.year : null,
        poster: posterUrl(entry.posterPath),
        family: DEMO_FAMILIES.includes(entry.family) ? entry.family : null,
      }),
    );
  }
  return Object.freeze(movies);
}

/** The committed list, validated once. */
export const DEMO_MOVIES = demoMovies(DEMO_LIST);

// ---------------------------------------------------------------------------
// The ranking itself
//
// A state is a plain object and every step returns a new one, so a test can walk the
// whole demo without a page and `page.mjs` can repaint from whatever it is handed.
//
//   ranked     best first — the visitor's demo ranking so far
//   candidate  the movie being placed
//   remaining  the movies not yet shown, in list order
// ---------------------------------------------------------------------------

/**
 * Which of `remaining` to show against a movie of `family`: the first one from a
 * different genre family, or simply the first if there is none (or nothing to compare).
 *
 * "A comedy or an action movie?" is an easier, more telling pick than two superhero
 * films. Families are never shown and the visitor never chooses them; this only decides
 * which unseen movie comes next. First-match keeps it deterministic.
 */
function pickIndex(remaining, family) {
  if (!family) return 0;
  const index = remaining.findIndex((movie) => movie.family !== family);
  return index === -1 ? 0 : index;
}

/** `remaining` without the movie at `index`. */
const without = (remaining, index) => [...remaining.slice(0, index), ...remaining.slice(index + 1)];

/**
 * A fresh demo. `attempt` rotates where in the list it starts, so "Try again" opens on
 * movies the last round did not use — and the same attempt always opens on the same
 * pair, so it is deterministic.
 */
export function startDemo(movies, attempt = 0) {
  const source = Array.isArray(movies) ? movies.filter(Boolean) : [];
  const shift = source.length ? (attempt * DEMO_RESULT_SIZE) % source.length : 0;
  const pool = [...source.slice(shift), ...source.slice(0, shift)];

  if (pool.length < 2) {
    return { ranked: pool.slice(0, 1), candidate: null, remaining: [], selections: 0, done: true };
  }
  return opening(pool, { selections: 0, done: false });
}

/** The opening pair from `pool`: its first movie, and the best newcomer to set against it. */
function opening(pool, rest) {
  const [seed, ...others] = pool;
  const index = pickIndex(others, seed.family);
  return { ...rest, ranked: [seed], candidate: others[index], remaining: without(others, index) };
}

/** The movie the candidate is measured against: the middle of the order so far. */
const pivotIndex = (state) => Math.floor(state.ranked.length / 2);

/**
 * The two movies on screen, or null once the demo is over.
 *
 * Sides alternate with each pick so the newcomer is not always on the same side, which
 * would make "the right one is the new one" a pattern somebody could learn.
 */
export function currentPair(state) {
  if (!state || state.done || !state.candidate) return null;
  const pivot = state.ranked[pivotIndex(state)];
  return state.selections % 2 === 0
    ? { left: pivot, right: state.candidate }
    : { left: state.candidate, right: pivot };
}

/** Draws the next candidate for the current pivot, or ends when the list has none. */
function draw(state) {
  if (state.remaining.length === 0) return { ...state, candidate: null, done: true };
  const index = pickIndex(state.remaining, state.ranked[pivotIndex(state)].family);
  return { ...state, candidate: state.remaining[index], remaining: without(state.remaining, index) };
}

/**
 * One pick. `id` is the movie the visitor preferred; anything not on screen is ignored.
 *
 * The candidate lands directly above the pivot if it was preferred and directly below it
 * if not. The third pick ends the demo.
 */
export function choose(state, id) {
  const pair = currentPair(state);
  if (!pair || (id !== pair.left.id && id !== pair.right.id)) return state;

  const pivot = pivotIndex(state);
  const preferred = id === state.candidate.id;
  const index = preferred ? pivot : pivot + 1;
  const placed = {
    ...state,
    ranked: [...state.ranked.slice(0, index), state.candidate, ...state.ranked.slice(index)],
    selections: state.selections + 1,
  };

  if (placed.selections >= DEMO_CHOICES) return { ...placed, candidate: null, done: true };
  return draw(placed);
}

/**
 * Whether there is anything left to swap in, **without starving the picks still to
 * come**: a swap may only spend a movie that the remaining picks will not need, so no
 * number of swaps can leave the result short of four.
 */
export function canSwap(state) {
  if (!state || state.done || !state.candidate) return false;
  const replaced = state.ranked.length === 1 ? 2 : 1;
  const stillToDraw = DEMO_CHOICES - state.selections - 1;
  return state.remaining.length >= replaced + stillToDraw;
}

/**
 * "Haven't seen both? Swap pair." Never counts as a pick.
 *
 * The newcomer is set aside and a fresh one drawn. If the list is still the one movie
 * the demo opened with, that one has never been chosen either, so it is replaced too:
 * both films on screen were unseen candidates.
 *
 * A movie already in the list stays, because the visitor put it there by picking it.
 */
export function swap(state) {
  if (!canSwap(state)) return state;
  if (state.ranked.length === 1) return opening(state.remaining, state);
  return draw(state);
}

/** The ordered result, best first. Positions only: the demo has no scores to give. */
export function demoResult(state) {
  if (!state || !state.done) return [];
  return state.ranked.map((movie, index) => ({ position: index + 1, ...movie }));
}
