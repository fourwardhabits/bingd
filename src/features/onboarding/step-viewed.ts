import { useEffect } from 'react';

import { track, type OnboardingStep } from '@/lib/analytics';

/**
 * `onboarding_step_viewed`, once per step per run (Onboarding 2.0, OB-1, 2026-11-14).
 *
 * ---------------------------------------------------------------------------
 * WHY THE GUARD IS PROCESS MEMORY AND NOT A REF
 *
 * The brief is "once per step per run": not on a re-render, not on a remount, not on a
 * sheet opening over the step, and not on a resume of the same step in the same app
 * session. A ref answers the first and fails the second — `router.replace` and the
 * session gate both remount a step's screen, and the taste screen swaps whole subtrees
 * between the picker and the payoff — so the guard lives here, beside the event, keyed by
 * the account and the step.
 *
 * **It is deliberately not persisted.** A relaunch that resumes a step sends it again,
 * which is acceptable and documented (`docs/product/analytics.md`): drop-off is read as
 * viewed − completed *per person*, so a second view from the same person changes nothing,
 * whereas a persisted guard that missed a view would manufacture a drop-off nobody had.
 *
 * Keyed by the account as well as the step so that a sign-out and a different account
 * onboarding on the same phone is a new run. The key never leaves this module: the event
 * carries `step` and nothing else.
 */
const seen = new Set<string>();

export function trackStepViewed(accountId: string, step: OnboardingStep): void {
  const key = `${accountId}:${step}`;
  if (seen.has(key)) return;
  seen.add(key);
  track({ name: 'onboarding_step_viewed', props: { step } });
}

/**
 * Sends the step's view once its real content is on screen.
 *
 * `ready` is the screen's own answer to "is this the step, or still a loading frame?" —
 * the People step passes it only once its branch is decided, so a skeleton is not a view.
 */
export function useStepViewed(accountId: string, step: OnboardingStep, ready = true): void {
  useEffect(() => {
    if (ready) trackStepViewed(accountId, step);
  }, [accountId, step, ready]);
}

/** For tests: a fresh process, as far as this guard is concerned. */
export function resetStepViewedForTests(): void {
  seen.clear();
}
