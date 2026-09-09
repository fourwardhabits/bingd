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
