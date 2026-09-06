import { useCallback, useEffect, useRef } from 'react';

import { supabase } from '@/lib/supabase';

import { unlockKey } from './featured';

/** One tier crossed, as the celebration needs to name it. */
export type NewUnlock = {
  awardKey: string;
  tierKey: string;
  earnedAt: string;
};

/**
 * Read the reader's own award ledger. Owner-only by policy (`award_unlocks_own`).
 *
 * Deliberately not `useAwardUnlocks`: this is called imperatively at two exact moments
 * around a ranking, and a cached query would answer the second call with the first
 * call's data — which is precisely the difference this is trying to measure.
 */
async function readLedger(userId: string): Promise<NewUnlock[]> {
  const { data, error } = await supabase
    .from('award_unlocks')
    .select('award_key, tier_key, earned_at')
    .eq('user_id', userId);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    awardKey: row.award_key as string,
    tierKey: row.tier_key as string,
    earnedAt: row.earned_at as string,
  }));
}

/**
 * What a ranking just unlocked, if anything.
 *
 * ---------------------------------------------------------------------------
 * WHY A BEFORE-AND-AFTER DIFF, AND NOT A TIMESTAMP OR A RETURN VALUE
 *
 * The unlock happens **inside the ranking's own transaction**: `_maybe_award_unlocks`
 * runs from a trigger where the facts change, records every newly-passed tier on
 * `award_unlocks`, and announces the highest one per track. So by the time `rank_answer`
 * has replied `placed`, the ledger rows already exist — there is no race to lose.
 *
 * What the client does not get is *which* rows are new. `rank_answer` returns a
 * placement, not an award, and changing it to say more is a migration.
 *
 * Three ways to find out, and two of them are wrong:
 *
 *   - **`earned_at > now()` measured on the phone.** The unlock's timestamp is the
 *     database's `now()`; the comparison would be against a device clock that can be
 *     minutes out in either direction. Wrong by construction, and wrong *silently*.
 *   - **`announced = false`.** That flag means "no feed post or notification was
 *     written for this row", which is true of the rollout backfill and of every lower
 *     tier skipped past in a single crossing. It is not "new".
 *   - **The set of keys before, and the set after.** Exact, clock-free, and cheap: one
 *     indexed read of a small owner-scoped table, twice.
 *
 * ---------------------------------------------------------------------------
 * IT CANNOT BREAK A RANKING, AND THAT IS THE POINT
 *
 * The snapshot is taken on mount and the diff after the placement, both outside the
 * ranking's own path. Every failure here — the snapshot never landing, either read
 * erroring, the user having no ledger at all — resolves to **no celebration**, never to
 * a failed or repeated ranking. Nothing here writes anything: an award is granted by the
 * database trigger, and this only ever *reads* what the trigger recorded, so a
 * celebration shown twice would be a cosmetic bug rather than a duplicate award.
 *
 * **A missing snapshot means no celebration, deliberately.** If the first read failed,
 * every row in the ledger looks new, and the reader would be congratulated for a year of
 * history because their phone lost signal for a second. Failing quiet is the only safe
 * direction.
 * ---------------------------------------------------------------------------
 */
export function useNewUnlocks(userId: string | null) {
  /**
   * The keys already on the ledger when this ranking began — **as a promise, not a set.**
   *
   * Holding the resolved value was the obvious shape and it is wrong for one case that
   * is not rare at all: a ranking that finishes before the snapshot does. `rank_start`
   * places a title outright when there is nothing to compare it against, which is every
   * reader's first ranking and every rebucket into an empty band — so the placement can
   * land in the same breath as the mount, and a `detect` reading a ref that had not been
   * filled yet would decide there was nothing to celebrate on precisely the ranking
   * most worth celebrating.
   *
   * Awaiting the promise costs nothing when it has already settled and is correct when
   * it has not. Null means "no snapshot was ever started or it failed", which is still
   * the case `detect` refuses to guess from.
   */
  const before = useRef<Promise<Set<string> | null> | null>(null);

  useEffect(() => {
    if (!userId) {
      before.current = null;
      return;
    }
    before.current = readLedger(userId)
      .then((rows) => new Set(rows.map((row) => unlockKey(row.awardKey, row.tierKey))))
      // Resolved to null rather than left rejected: `detect` reads this with `await`,
      // and a rejection there would be an unhandled one on any render that never calls
      // it. Null is the same answer — "not known" — in a shape nothing can throw from.
      .catch(() => null);
    return () => {
      // The snapshot belongs to the session that took it. A remount for a different
      // reader must not diff against the previous one's ledger.
      before.current = null;
    };
  }, [userId]);

  return useCallback(async (): Promise<NewUnlock[]> => {
    if (!userId) return [];
    try {
      const snapshot = await (before.current ?? Promise.resolve(null));
      if (!snapshot) return [];
      const rows = await readLedger(userId);
      return rows.filter((row) => !snapshot.has(unlockKey(row.awardKey, row.tierKey)));
    } catch {
      return [];
    }
  }, [userId]);
}
