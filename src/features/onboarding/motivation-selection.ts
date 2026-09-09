import { useCallback, useSyncExternalStore } from 'react';

import { readPref, writePref } from '@/lib/prefs';

import { MOTIVATIONS, type MotivationId } from './motivations';

/**
 * What the reader picked on step 3, held for step 4 and then let go.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO COLUMN
 *
 * The founder's decision for v1 (`05-dependencies-and-reconciliation.md` N2): the
 * motivations are **reported once and discarded**. `onboarding_motivations` carries the
 * set to analytics the moment the account exists, and after step 4 nothing in the product
 * reads them again.
 *
 * That is worth stating plainly because the opposite is so tempting. A column would let
 * For You weight itself by what somebody said they wanted, and every version of that idea
 * ends with a stranger's first recommendations being shaped by a tap they made before
 * they had ranked a single film. The product already has a better answer to "what do you
 * want" and it is the five movies on the next screen.
 *
 * If a column is ever added, the analytics event is what justifies it. Until then this
 * store is the whole of the persistence, and it is device-local on purpose.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS WRITTEN TO A PREFERENCE AND NOT ONLY HELD IN MEMORY
 *
 * Step 4 is a separate screen, and the flow can be closed between the two. A selection
 * that lived only in this process would leave a resumed `answers` step with nothing to
 * draw and no honest option but to send the reader back to a question they had already
 * answered.
 *
 * So it is written, on the same terms as every other preference in the flow: memory
 * first, disk dispatched, a failed write costing one re-answered question and nothing
 * else.
 */
const SELECTION_PREF = 'onboarding.motivations';

const selectionKey = (userId: string) => `${userId}.${SELECTION_PREF}`;

/** Whether a stored slug is still one of the six, so a stale build cannot draw a ghost. */
const known = (id: string): id is MotivationId =>
  MOTIVATIONS.some((motivation) => motivation.id === id);

const selections = new Map<string, ReadonlySet<MotivationId>>();
const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

/** Exported for tests, which must not inherit a selection from the previous one. */
export function resetMotivationSelection() {
  selections.clear();
  publish();
}

/** Reads the stored selection into memory once. An unreadable one is simply empty. */
export async function hydrateMotivations(userId: string): Promise<ReadonlySet<MotivationId>> {
  const remembered = selections.get(userId);
  if (remembered) return remembered;

  const stored = await readPref<string[]>(selectionKey(userId)).catch(() => null);
  const set: ReadonlySet<MotivationId> = new Set(
    Array.isArray(stored) ? stored.filter(known) : [],
  );
  selections.set(userId, set);
  publish();
  return set;
}

/**
 * Records the selection, in memory first and then on disk.
 *
 * Stored as an array because that is what JSON has; it is read back through `known` and
 * rebuilt as a set, so nothing downstream can be handed a duplicate or a slug this build
 * does not recognise.
 */
export async function setMotivations(
  userId: string,
  picked: ReadonlySet<MotivationId>,
): Promise<void> {
  selections.set(userId, new Set(picked));
  publish();
  await writePref<string[]>(selectionKey(userId), [...picked]).catch(() => {});
}

const EMPTY: ReadonlySet<MotivationId> = new Set();

/**
 * The selection as a subscription.
 *
 * The empty set is a module constant rather than a fresh `new Set()` per call, because
 * `useSyncExternalStore` compares snapshots by identity and a new object every read is an
 * infinite render loop. This is the single most likely way to get this hook wrong.
 */
export function useMotivations(userId: string | null): ReadonlySet<MotivationId> {
  return useSyncExternalStore(
    useCallback((onChange: () => void) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    }, []),
    () => (userId ? (selections.get(userId) ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
}
