import { useCallback, useSyncExternalStore } from 'react';

import { note } from '@/lib/flight-recorder';
import { withGrace } from '@/lib/grace';
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
 * lived only on disk would let a failed write send somebody back to the step they had just
 * finished. A decision recorded here is authoritative for the life of the process, and the
 * write is how it outlives the process. Keyed by account, so two accounts on one device
 * cannot read each other's.
 *
 * ---------------------------------------------------------------------------
 * AND IT HOLDS THREE STATES RATHER THAN TWO.
 *
 * | value | meaning |
 * |---|---|
 * | absent from the map | **not read yet, or could not be read** |
 * | `null` | read, and this account has no stage |
 * | a stage | read, and this is where the flow got to |
 *
 * **The third state is the fix for a real stranding**, found by independent review and
 * worth stating in full because collapsing it back is easy and silent.
 *
 * This map used to hold stages only, and a read that rejected or never settled left the
 * entry missing — which routing could not tell apart from "this account has no stage". It
 * then fell through to the taste rule, and for an account resting on the People step that
 * rule answers `needed: true` with five rankings already placed. The result was step 3
 * again on that launch; and because `readState`'s repair branch settles such an account to
 * `done`, the launch after that fell through to the app with People and the notification
 * question **silently skipped**. One unreadable preference, and somebody never sees the
 * social half of onboarding.
 *
 * So the unknown state is now representable, `nextRoute` holds on it rather than guessing,
 * and the read below is bounded so the hold cannot outlive one Keychain call.
 */
const stages = new Map<string, OnboardingStage | null>();

/** Subscribers to `stages`, so a screen advancing the stage re-renders the router. */
const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

/** Exported for tests, which must not inherit a stage from the previous one. */
export function resetOnboardingStages() {
  stages.clear();
  queuedStage.clear();
  stageWrites.clear();
  publish();
}

/**
 * The last stage handed to the disk for an account, and the chain its writes queue on.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MEMORY GUARD WAS NOT ENOUGH
 *
 * `advanceStage` refuses to go backwards, and that refusal is checked against the map
 * above — which is correct, and which independent review pointed out says nothing at all
 * about what reaches storage. The disk write was dispatched and never awaited by its
 * caller, so two advances could be in flight at once, and **SecureStore does not promise
 * that two writes to one key land in the order they were issued.**
 *
 * The failure is quiet and it is a resume failure, which is the expensive kind here. A
 * slow `answers` write completing after a fast `taste` write leaves `answers` on disk. The
 * session itself is perfect — memory is the authority while the process lives — so nobody
 * sees anything wrong until the next launch, which reopens on a step already finished.
 *
 * Two properties, and the pair is what makes it safe:
 *
 *   **Ordered.** Every write for one account queues behind the previous one, so the
 *   platform is never asked to interleave two writes to the same key.
 *
 *   **Coalesced.** A write that has been superseded while it waited does not run. The
 *   later value is already queued behind it and is the answer; writing the older one
 *   first would be correct but pointless, and skipping it keeps a six-step flow to as
 *   few Keychain round trips as it actually needs.
 *
 * Per account rather than one global chain: two accounts on one device write different
 * keys, and making B's Continue wait on A's stalled Keychain would be a new way to lose
 * the thing this is protecting.
 */
const queuedStage = new Map<string, OnboardingStage>();
const stageWrites = new Map<string, Promise<void>>();

function persistStage(userId: string, next: OnboardingStage): Promise<void> {
  queuedStage.set(userId, next);

  const queued = (stageWrites.get(userId) ?? Promise.resolve()).then(async () => {
    // Superseded while this sat in the queue. The newer value is behind it in the same
    // chain and will be written; this one would only be an older value reaching the disk
    // later, which is the reordering being removed.
    if (queuedStage.get(userId) !== next) return;
    await writePref<OnboardingStage>(stageKey(userId), next).catch(() => {});
  });

  stageWrites.set(userId, queued);
  return queued;
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
export function stageInMemory(userId: string): OnboardingStage | null | undefined {
  return stages.get(userId);
}

/**
 * How long the stage read may hold routing before it is answered for.
 *
 * Four seconds, matching `FIRST_RUN_GRACE_MS` and `WELCOME_GRACE_MS`, and for the reason
 * both of those give: this is one Keychain lookup, so anything past it is not slow, it is
 * stuck. `nextRoute` waits on the unknown state, so this bound is what stops that wait
 * becoming the build-4 hang in a new place.
 */
const STAGE_GRACE_MS = 4000;

/**
 * Reads the stored stage into memory once, and answers from memory forever after.
 *
 * **A failure resolves to `null` — "this account has no stage" — and not to unknown.**
 * That is a deliberate, lossy choice and it is the safe direction: unknown is a state
 * routing *waits* on, so resolving a dead read to unknown would hold the app for ever,
 * which is the failure this codebase has already shipped once. `null` lets routing fall
 * through to the taste rule, and the `people` fallback in `nextRoute` is what keeps that
 * fall-through from skipping the social half.
 */
export async function hydrateStage(userId: string): Promise<OnboardingStage | null> {
  const remembered = stages.get(userId);
  if (remembered !== undefined) return remembered;

  const stored = await withGrace(
    readPref<OnboardingStage>(stageKey(userId)),
    STAGE_GRACE_MS,
    null,
  ).catch(() => null);

  note('onboarding', 'stage.read', stored ?? 'absent');

  // A value written by a build that knew a stage this one does not is not a reason to
  // strand somebody on a route that no longer exists.
  const settled = stored && STAGE_ORDER.includes(stored) ? stored : null;

  stages.set(userId, settled);
  publish();
  return settled;
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
 *
 * **And the disk agrees with memory, which it used to only usually do.** The refusal
 * above is a fact about the map; the write goes to a platform that does not order two
 * calls to one key. `persistStage` is what makes the durable copy follow the same rule —
 * see its note for the resume this was losing.
 */
export async function advanceStage(userId: string, next: OnboardingStage): Promise<void> {
  const current = stages.get(userId);
  // `null` and `undefined` both mean "nothing to go backwards from". Only a real stage
  // can refuse.
  if (current && STAGE_ORDER.indexOf(current) >= STAGE_ORDER.indexOf(next)) return;

  stages.set(userId, next);
  publish();
  note('onboarding', 'stage.advance', next);
  await persistStage(userId, next);
}

/**
 * The stage as a subscription, for the router.
 *
 * `useSyncExternalStore` rather than state in a provider, because the writers are
 * ordinary functions called from six different screens and a context would make every one
 * of them need the provider in its test. The snapshot is a plain map read, so it is
 * already stable between publishes.
 */
export function useOnboardingStage(
  userId: string | null,
): OnboardingStage | null | undefined {
  return useSyncExternalStore(
    useCallback((onChange: () => void) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    }, []),
    // `null` for a signed-out reader rather than `undefined`: there is no account, so
    // there is nothing still to find out, and routing must not wait on it.
    () => (userId ? stages.get(userId) : null),
    () => null,
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
