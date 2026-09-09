import { useCallback, useSyncExternalStore } from 'react';

import { note } from '@/lib/flight-recorder';
import { readPref, writePref } from '@/lib/prefs';

/**
 * How far through the first-run flow this device believes the account is.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS BESIDE `onboarding.taste.phase` RATHER THAN INSIDE IT
 *
 * The taste phase answers one question and answers it well: **does this account belong
 * in the first-run flow at all.** It is derived from the collection once, remembered, and
 * defended by a great deal of hard-won logic — a resume that shows the summary exactly
 * once, an `intent` map that outranks a failed disk write, and a re-read after its own
 * awaits so a decision taken during them is not overwritten. None of that is touched
 * here, and it must not be.
 *
 * What it cannot answer is **where in a ten-step flow somebody is**, because until now
 * there was nowhere to be: the flow was one screen. Overloading the phase with the answer
 * would mean editing the one piece of state four separate defects were fixed inside, to
 * carry information it was never about.
 *
 * So the two are stacked rather than merged:
 *
 * | question | owner |
 * |---|---|
 * | is this account in the flow | `onboarding.taste.phase` (unchanged) |
 * | which step is it on | `onboarding.stage` (here) |
 *
 * ---------------------------------------------------------------------------
 * AND WHY THE STAGE IS CONSULTED FIRST BY ROUTING
 *
 * This is the ordering that makes a resume work, and getting it the other way round
 * would strand people in a way the old flow could not.
 *
 * `readState` has a repair branch: an account marked `active` that already has five
 * rankings is settled to `done`, so a summary cannot repeat for ever. That was correct
 * when five rankings meant the flow was over. **It no longer does** — the ranking run is
 * step 7 of ten, and People and notifications come after it. An account that closed the
 * app on the People step has five rankings, so the taste query now answers "not needed"
 * on the next launch, and routing that trusted it alone would drop somebody into the Feed
 * with the last two steps silently skipped.
 *
 * The stage is the durable answer to that, and it is why `nextRoute` asks this *before*
 * it asks whether taste is needed. The repair branch keeps doing its job for the ranking
 * sub-flow and can no longer end the whole thing.
 *
 * ---------------------------------------------------------------------------
 * DEVICE-LOCAL, WITH THE SAME TRADE RECORDED NEXT DOOR
 *
 * A column would be the durable answer and would cost a migration, an RLS write path and
 * a review, for a pointer whose only job is to stop six screens reappearing. The cost of
 * being wrong on this side is small and recoverable: an account halfway through on a
 * second device is read as established and is not offered the rest. That is the trade
 * `useCompleteTasteOnboarding` already documents, taken again for the same reasons.
 */
const STAGE_PREF = 'onboarding.stage';

/**
 * The steps that have a screen of their own, in the order they are walked.
 *
 * `sign_in` and the profile form are absent because neither is reached through this
 * pointer: they are gated by the auth state itself, which is a stronger rule than a
 * preference and one that a cleared device cannot lose. The opening is absent because it
 * runs before there is an account to key a stage to.
 */
export const STAGE_ORDER = [
  'motivations',
  'answers',
  'taste',
  'people',
  'notifications',
  'done',
] as const;

export type OnboardingStage = (typeof STAGE_ORDER)[number];

/** Where each stage is drawn. `done` has no route: the flow ends by opening the app. */
export const STAGE_ROUTES: Record<Exclude<OnboardingStage, 'done'>, string> = {
  motivations: '/onboarding/motivations',
  answers: '/onboarding/answers',
  taste: '/onboarding/taste',
  people: '/onboarding/people',
  notifications: '/onboarding/notifications',
};

const stageKey = (userId: string) => `${userId}.${STAGE_PREF}`;

/**
 * What this process has decided, whatever storage managed to record.
 *
 * The same module-level map, for the same reason, as `intent` in
 * `use-taste-onboarding.ts`: `writePref` is SecureStore and can fail, and a stage that
 * lived only on disk would let a failed write send somebody back to the step they had
 * just finished. A decision recorded here is authoritative for the life of the process
 * and the write is how it outlives the process.
 *
 * Keyed by account, so two accounts on one device cannot read each other's.
 */
const stages = new Map<string, OnboardingStage>();

/** Subscribers to `stages`, so a screen advancing the stage re-renders the router. */
const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

/** Exported for tests, which must not inherit a stage from the previous one. */
export function resetOnboardingStages() {
  stages.clear();
  publish();
}

/**
 * The stage this process holds for an account, or undefined if it has not been read.
 *
 * Deliberately **not** a query. This is consulted by `useAuthRouting` on every segment
 * change, and a React Query entry there would put a promise between a cold start and the
 * first screen for a value that is a single Keychain read — which is the cost
 * `readState` was restructured to stop paying. The disk read happens once per account
 * per process, in `hydrateStage`, and everything after it is synchronous.
 */
export function stageInMemory(userId: string): OnboardingStage | undefined {
  return stages.get(userId);
}

/**
 * Reads the stored stage into memory once, and answers from memory forever after.
 *
 * Returns the stage so a caller can act on it directly. A rejection resolves to
 * `undefined` rather than throwing: an unreadable preference is not a reason to hold the
 * app, and an account whose stage cannot be read falls through to the taste rule, which
 * is where it would have been before this file existed.
 */
export async function hydrateStage(userId: string): Promise<OnboardingStage | undefined> {
  const remembered = stages.get(userId);
  if (remembered) return remembered;

  const stored = await readPref<OnboardingStage>(stageKey(userId)).catch(() => null);
  note('onboarding', 'stage.read', stored ?? 'absent');
  if (!stored) return undefined;

  // A value written by a build that knew a stage this one does not is not a reason to
  // strand somebody on a route that no longer exists.
  if (!STAGE_ORDER.includes(stored)) return undefined;

  stages.set(userId, stored);
  publish();
  return stored;
}

/**
 * Moves the account to a stage, in memory first and then on disk.
 *
 * The ordering is the build-4 hotfix's rule, applied here: state the router depends on is
 * recorded before anything that can fail, and the disk write is dispatched rather than
 * awaited so a screen never watches the Keychain happen while somebody waits on a button.
 *
 * **It refuses to go backwards.** Two of these can be in flight at once — a screen's own
 * Continue and a resume that is still hydrating — and the flow only ever moves forward,
 * so the later of the two is the answer whatever order they arrive in. Without this, a
 * hydrate that resolves after a Continue would put the reader back on the step they just
 * left.
 */
export async function advanceStage(userId: string, next: OnboardingStage): Promise<void> {
  const current = stages.get(userId);
  if (current && STAGE_ORDER.indexOf(current) >= STAGE_ORDER.indexOf(next)) return;

  stages.set(userId, next);
  publish();
  note('onboarding', 'stage.advance', next);
  await writePref<OnboardingStage>(stageKey(userId), next).catch(() => {});
}

/**
 * The stage as a subscription, for the router.
 *
 * `useSyncExternalStore` rather than state in a provider, because the writers are
 * ordinary functions called from six different screens and a context would make every one
 * of them need the provider in its test. The snapshot is a plain map read, so it is
 * already stable between publishes.
 */
export function useOnboardingStage(userId: string | null): OnboardingStage | undefined {
  return useSyncExternalStore(
    useCallback((onChange: () => void) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    }, []),
    () => (userId ? stages.get(userId) : undefined),
    () => undefined,
  );
}

/**
 * Advance, bound to one account, for the screens.
 *
 * A hook rather than a bare import so the account cannot be forgotten at a call site:
 * every stage this flow writes is about the person currently signed in, and a helper that
 * took a user id would eventually be called with the wrong one.
 */
export function useAdvanceStage(userId: string) {
  return useCallback(
    (next: OnboardingStage) => {
      void advanceStage(userId, next);
    },
    [userId],
  );
}
