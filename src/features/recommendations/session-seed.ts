import { useSyncExternalStore } from 'react';

/**
 * Which arrangement of For You this session is showing, and what it has already shown.
 *
 * ## The first bug this module fixed
 *
 * The founder's report was that the recommendations were essentially the same every
 * visit. They were: the slate is a pure function of the viewer's rankings and the
 * provider cache, so with neither moving there was exactly one answer and the app kept
 * giving it. The audit is in `docs/architecture/recommendations.md` §7. The fix was to
 * separate *which titles are good* — one right answer, cached for half an hour — from
 * *which arrangement of them this session is showing*, which is the seed below.
 *
 * ## The second bug, which is why this file now holds more than a number
 *
 * A seed alone was not enough, and the founder's Preview pass proved it physically: two
 * consecutive Refreshes kept eight of the nine visible posters and changed their order.
 * The reason is that a seed only perturbs a *ranking*. `rank.ts` sampled a fresh order
 * out of the same bounded pool every time, and nothing in that pipeline knew which
 * titles were already on screen, so turnover was a by-product of how far the random
 * draw happened to move a title rather than something the algorithm was trying to
 * achieve. On a pool with any real score gradient, the answer was "not very far".
 *
 * So the arrangement is no longer a number. It is a seed **plus what has already been
 * presented**, and `rank.ts` prefers what this session has not shown yet. That is the
 * whole of the fix; the scoring above it is untouched.
 *
 * ## Why this is a module and not React state
 *
 * **It has to outlive the screen.** For You is a tab: leaving it and coming back
 * unmounts and remounts the screen, and state in `useState` would be a new arrangement
 * each time — a reshuffle on every navigation, which is the first thing the brief rules
 * out. Held here, it survives every remount for as long as the process does.
 *
 * **A new launch is a new arrangement**, because the module is evaluated again. That is
 * the founder's rule F, and it costs nothing to implement: it is what a module-level
 * initialiser already does. Exposure resets with it, which is the deliberate beta
 * limit — persistent cross-session exposure needs a schema and
 * `docs/product/deferred-roadmap.md` carries it.
 *
 * ## What moves it
 *
 * Only {@link refreshRecommendations}, from the Refresh control. Not a bookmark, not a
 * reaction, not a re-render, not a cache invalidation. That is the whole of rule A, and
 * it is enforced by there being no other *notifying* writer.
 *
 * {@link noteSlateOnScreen} is the one other writer and it is **deliberately silent**:
 * it parks what is currently rendered without telling anybody, so the exposure the
 * ranker reads cannot change underneath a screen that nobody has refreshed. That is not
 * a style choice — a notifying version would re-render the wall, which would produce a
 * new wall, which would park again, which is an infinite loop. The value it parks is
 * promoted into {@link Arrangement} only when Refresh is pressed.
 */

/** Never zero: `diversify` reads a seed of 0 as "strict score order, no exploration". */
const nonZero = (value: number) => (value % 0x7fffffff || 1) >>> 0;

/**
 * How many times a title has to have been presented before the penalty stops growing.
 *
 * Three. The tiers are what make repeated Refresh keep working — a title shown twice is
 * preferred over one shown three times — and the cap is what stops the ordering becoming
 * a strict history of the session once the pool is exhausted. Past three presentations
 * everything is equally stale and score decides again.
 */
export const EXPOSURE_TIERS = 3;

export type Arrangement = {
  /** The perturbation seed. Same seed, same pool, same wall. */
  seed: number;
  /**
   * What is on the wall right now. Demoted hardest on the next Refresh, because "show
   * me different recommendations" is first and foremost about these.
   */
  current: ReadonlySet<string>;
  /** How many arrangements this session have contained each title, capped at the tiers. */
  seen: ReadonlyMap<string, number>;
};

const EMPTY: Arrangement = {
  seed: nonZero(Math.floor(Math.random() * 0x7fffffff) + 1),
  current: new Set(),
  seen: new Map(),
};

let arrangement: Arrangement = EMPTY;

/**
 * What is rendered right now, per wall, awaiting promotion by the next Refresh.
 *
 * Keyed rather than a single array because the Movies and TV walls are separate slates
 * sharing one arrangement: parking them in one slot would let switching medium erase
 * what the other wall had shown, and the erased titles would come straight back on the
 * next Refresh. Only walls that have actually rendered are in here, so a medium the
 * reader never opened is never marked as seen.
 */
const onScreen = new Map<string, readonly string[]>();

/** Enough to hold both media across a few filter combinations; older keys fall off. */
const ON_SCREEN_KEYS = 8;

const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The current arrangement. Stable until somebody presses Refresh. */
export const recommendationArrangement = (): Arrangement => arrangement;

/** The seed alone, for the callers that only ever wanted a number. */
export const recommendationSeed = () => arrangement.seed;

/**
 * Park what a wall is showing. Silent by design — see the note at the top of the file.
 *
 * Called from `useForYou` rather than from the screen, so that any consumer of the hook
 * contributes its exposure without every caller having to remember to.
 */
export function noteSlateOnScreen(key: string, mediaItemIds: readonly string[]) {
  // Re-inserted so the eviction below is least-recently-*rendered* rather than
  // least-recently-created; a wall the reader keeps returning to should not fall out.
  onScreen.delete(key);
  onScreen.set(key, [...mediaItemIds]);
  while (onScreen.size > ON_SCREEN_KEYS) {
    const oldest = onScreen.keys().next();
    if (oldest.done) break;
    onScreen.delete(oldest.value);
  }
}

/**
 * A different arrangement: a new seed, and everything just shown marked as shown.
 *
 * The seed is advanced rather than re-randomised, so the sequence does not return to a
 * seed it has just left and two presses cannot restore the seed the reader started from.
 * Measured over 200,000 starting points there is no fixed point and no two-cycle, and
 * the walk runs past five million steps without repeating.
 *
 * **That was never a promise about the wall**, and before exposure existed it could not
 * be: a new seed can leave a wall identical when the pool's scores are all equal, or when
 * two seeds survive `diversify`'s ceilings to the same twenty. Exposure is what turns the
 * promise into one about titles — `current` and `seen` are what `rank.ts` demotes, and
 * they do not depend on the draw going a particular way.
 *
 * `current` is replaced rather than merged: it means "on screen when Refresh was pressed",
 * and a title that has since left the wall belongs in `seen`, where it still counts but no
 * longer counts hardest. `seen` accumulates and is capped at {@link EXPOSURE_TIERS}, which
 * is what makes the penalty relax progressively rather than lock the session's history in.
 */
export function refreshRecommendations() {
  const presented = [...onScreen.values()].flat();
  const seen = new Map(arrangement.seen);
  for (const id of presented) {
    seen.set(id, Math.min(EXPOSURE_TIERS, (seen.get(id) ?? 0) + 1));
  }

  arrangement = {
    seed: nonZero(Math.imul(arrangement.seed, 1103515245) + 12345),
    current: new Set(presented),
    seen,
  };
  for (const listener of listeners) listener();
}

/** Test seam. Nothing in the app calls this. */
export function setRecommendationSeed(next: number) {
  arrangement = { ...arrangement, seed: nonZero(next) };
  for (const listener of listeners) listener();
}

/**
 * Back to a fresh process, without one. Test seam; nothing in the app calls it.
 *
 * Exists because exposure is module state and Jest keeps modules between tests in a file:
 * a suite asserting "the first Refresh rotates" would otherwise inherit whatever the
 * previous test had presented.
 */
export function resetRecommendationSession(seed?: number) {
  onScreen.clear();
  arrangement = {
    seed: nonZero(seed ?? Math.floor(Math.random() * 0x7fffffff) + 1),
    current: new Set(),
    seen: new Map(),
  };
  for (const listener of listeners) listener();
}

/** The arrangement, as something a component re-renders on. */
export function useRecommendationArrangement(): Arrangement {
  return useSyncExternalStore(
    subscribe,
    recommendationArrangement,
    recommendationArrangement,
  );
}

/** The seed, as something a component re-renders on. */
export function useRecommendationSeed(): number {
  return useSyncExternalStore(subscribe, recommendationSeed, recommendationSeed);
}
