import { useSyncExternalStore } from 'react';

/**
 * Which arrangement of For You this session is showing.
 *
 * The founder's report was that the recommendations were essentially the same every
 * visit. They were: the slate is a pure function of the viewer's rankings and the
 * provider cache, so with neither moving there was exactly one answer and the app kept
 * giving it. The audit is in `docs/architecture/recommendations.md` §7.
 *
 * The fix is not to reorder more often. It is to separate *which titles are good* — which
 * has one right answer and is cached for half an hour — from *which arrangement of them
 * this session is showing*, which is this number. `rank.ts` samples an order from it
 * (`explore`), so the same seed always draws the same wall.
 *
 * ## Why this is a module and not React state
 *
 * **It has to outlive the screen.** For You is a tab: leaving it and coming back
 * unmounts and remounts the screen, and a seed in `useState` would be a new seed each
 * time — a reshuffle on every navigation, which is the first thing the brief rules out.
 * Held here, the arrangement survives every remount for as long as the process does.
 *
 * **A new launch is a new seed**, because the module is evaluated again. That is the
 * founder's rule D, and it costs nothing to implement: it is what a module-level
 * initialiser already does. A *seed*, not an arrangement — the same qualification
 * {@link refreshRecommendations} carries applies here for the same reasons, and review
 * 29b was right that stating it only there implied launch was the stronger case.
 *
 * ## What moves it
 *
 * Only {@link refreshRecommendations}, from the Refresh control. Not a bookmark, not a
 * reaction, not a re-render, not a cache invalidation. That is the whole of rule A, and
 * it is enforced by there being no other writer.
 *
 * ## What it is not
 *
 * Not persisted, and not a record of what the reader has already seen. A durable "seen"
 * history is a backend feature with a schema behind it, and the brief says not to build
 * one for the beta. A fresh seed per launch gets most of the benefit for none of that —
 * and `docs/product/deferred-roadmap.md` carries the rest.
 */

/** Never zero: `diversify` reads a seed of 0 as "strict score order, no exploration". */
const nonZero = (value: number) => (value % 0x7fffffff || 1) >>> 0;

let seed = nonZero(Math.floor(Math.random() * 0x7fffffff) + 1);

const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The current arrangement. Stable until somebody presses Refresh. */
export const recommendationSeed = () => seed;

/**
 * A different seed, and so — almost always — a different arrangement.
 *
 * Advanced rather than re-randomised: the sequence does not return to a seed it has
 * just left, so two presses cannot restore the seed the reader started from. Measured
 * over 200,000 starting points there is no fixed point and no two-cycle, and the walk
 * runs past five million steps without repeating.
 *
 * **That is a promise about the seed, not about the wall, and independent review 29 was
 * right that the two had been conflated here.** A new seed can still leave the wall
 * looking identical:
 *
 *   - when the pool's scores are all equal, `explore` returns strict order for *every*
 *     seed, so Refresh is honestly a no-op (a popularity-only wall where nothing is
 *     distinctly popular — there is no near-tie to break because it is all one tie);
 *   - two different seeds can survive `diversify`'s ceilings to the same twenty in
 *     the same order, which gets likelier as the pool shrinks toward the wall's size.
 *
 * Neither is worth engineering around. Both are cases where there is genuinely only one
 * good answer, and manufacturing a different one out of the hash would be the shuffle
 * the brief rules out.
 */
export function refreshRecommendations() {
  seed = nonZero(Math.imul(seed, 1103515245) + 12345);
  for (const listener of listeners) listener();
}

/** Test seam. Nothing in the app calls this. */
export function setRecommendationSeed(next: number) {
  seed = nonZero(next);
  for (const listener of listeners) listener();
}

/** The seed, as something a component re-renders on. */
export function useRecommendationSeed(): number {
  return useSyncExternalStore(subscribe, recommendationSeed, recommendationSeed);
}
