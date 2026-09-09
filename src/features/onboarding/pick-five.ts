import { useCallback, useSyncExternalStore } from 'react';

import { readPref, writePref } from '@/lib/prefs';

/**
 * The five movies chosen on step 6, held across the ranking run that follows.
 *
 * ---------------------------------------------------------------------------
 * WHY SELECTION IS NOW A SEPARATE ACT FROM RANKING
 *
 * The old picker ranked each film **the moment it was chosen**, and the argument for that
 * was a good one: the second film is placed against the first while it is still in mind.
 * The founder's flow separates them, and the reasons are about the screen rather than the
 * mechanic (`01-screen-map.md` §6):
 *
 * - Interleaving is what made the old screen need a paragraph explaining itself. A title,
 *   one instruction and a grid need no explanation.
 * - The reader never saw the shape of what they were committing to. "Pick five" is a task
 *   somebody can picture the end of; "rank films until the app stops asking" is not.
 *
 * What is emphatically *not* changed is the ranking itself. The run that follows is the
 * real `TasteBucketSheet` and the real `RankingSheet` driving the real
 * `rank_start`/`rank_answer` session, one title at a time, in the order they were chosen.
 * Nothing here re-implements a comparison.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CHOICE IS WRITTEN DOWN
 *
 * Because the ranking run can be interrupted, and the five are no longer recoverable from
 * anywhere else. Under the old flow, progress was entirely a fact about `rankings` — a
 * closed app reopened on film three because film three was what the database said. That
 * is still how *progress* is read (see `app/onboarding/taste.tsx`), but the **selection**
 * is a decision the reader made that the database has no record of until each title is
 * ranked. Losing it would mean somebody who closed the app after ranking two of five came
 * back to an empty grid and had to choose five again, two of which they had already done.
 *
 * So the list is written on the way into the run, and read back on the way in again. Same
 * terms as every other preference in the flow: memory first, disk dispatched, a failed
 * write costing a re-selection and nothing worse.
 */
const PICK_PREF = 'onboarding.pickFive';

export const PICK_TARGET = 5;

/** Everything the run needs about one chosen movie, and nothing else. */
export type PickedTitle = {
  /** A `media_items` id. The same id `set_bucket` and the ranking session take. */
  id: string;
  title: string;
  year: number | null;
  posterUri: string | null;
};

const picks = new Map<string, readonly PickedTitle[]>();
const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

/** Exported for tests, which must not inherit a selection from the previous one. */
export function resetPickFive() {
  picks.clear();
  publish();
}

const pickKey = (userId: string) => `${userId}.${PICK_PREF}`;

/** A stored row that is missing an id cannot be ranked, so it is not restored. */
const usable = (row: unknown): row is PickedTitle =>
  typeof row === 'object' &&
  row !== null &&
  typeof (row as PickedTitle).id === 'string' &&
  typeof (row as PickedTitle).title === 'string';

/**
 * Reads the stored selection into memory once. An unreadable one is simply empty, which
 * puts the reader back on the grid rather than into a run with nothing to run.
 */
export async function hydratePicks(userId: string): Promise<readonly PickedTitle[]> {
  const remembered = picks.get(userId);
  if (remembered) return remembered;

  const stored = await readPref<unknown[]>(pickKey(userId)).catch(() => null);
  const restored = Array.isArray(stored) ? stored.filter(usable).slice(0, PICK_TARGET) : [];
  picks.set(userId, restored);
  publish();
  return restored;
}

/** Records the selection, in memory first and then on disk. */
export async function setPicks(
  userId: string,
  chosen: readonly PickedTitle[],
): Promise<void> {
  const capped = chosen.slice(0, PICK_TARGET);
  picks.set(userId, capped);
  publish();
  await writePref<readonly PickedTitle[]>(pickKey(userId), capped).catch(() => {});
}

const EMPTY: readonly PickedTitle[] = [];

/**
 * The selection as a subscription.
 *
 * The empty value is a module constant, not a fresh array per read: `useSyncExternalStore`
 * compares snapshots by identity, and returning a new `[]` every time is an infinite
 * render loop rather than an empty list.
 */
export function usePicks(userId: string | null): readonly PickedTitle[] {
  return useSyncExternalStore(
    useCallback((onChange: () => void) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    }, []),
    () => (userId ? (picks.get(userId) ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
}

/**
 * Whether the reader finished the ranking half or left it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS RECORDED RATHER THAN DERIVED AT THE END
 *
 * `onboarding_completed.skipped` used to be computed on the notification step, from the
 * taste query's ranked count: `(state.data?.ranked ?? 0) < FIRST_FIVE`. CI caught what
 * that costs, and it is a reporting defect rather than a test one.
 *
 * The count is a *query*, and step 10 can mount before it has answered — on a relaunch
 * straight onto the notification step it always does. An unanswered query is `undefined`,
 * `?? 0` turns that into zero, and zero is below five, so **an account that ranked all
 * five reports itself as a skip**. The direction matters: the flow's most important
 * success metric would have been systematically under-counted, and the failure is silent
 * because the event still fires and still looks well formed.
 *
 * So the outcome is written where it is actually known — by the screen that watched it
 * happen, at the two exits that are the only ways past the ranking half — and read back as
 * a fact. Memory-first like every other preference here, so within one session the write
 * and the read are the same process and there is no race at all.
 *
 * **Unknown resolves to `completed`.** A relaunch onto step 10 with an unreadable
 * preference is far more likely to be somebody who finished than somebody who declined,
 * and reporting a completion as a skip is the error that was just removed.
 */
const OUTCOME_PREF = 'onboarding.rankingOutcome';

export type RankingOutcome = 'completed' | 'skipped';

const outcomeKey = (userId: string) => `${userId}.${OUTCOME_PREF}`;

const outcomes = new Map<string, RankingOutcome>();

/** Exported for tests, which must not inherit an outcome from the previous one. */
export function resetRankingOutcome() {
  outcomes.clear();
}

/** Records how the ranking half ended, in memory first and then on disk. */
export async function setRankingOutcome(
  userId: string,
  outcome: RankingOutcome,
): Promise<void> {
  outcomes.set(userId, outcome);
  await writePref<RankingOutcome>(outcomeKey(userId), outcome).catch(() => {});
}

/** How the ranking half ended. See the header for why an unknown answer is a completion. */
export async function rankingOutcome(userId: string): Promise<RankingOutcome> {
  const remembered = outcomes.get(userId);
  if (remembered) return remembered;

  const stored = await readPref<RankingOutcome>(outcomeKey(userId)).catch(() => null);
  return stored === 'skipped' ? 'skipped' : 'completed';
}
