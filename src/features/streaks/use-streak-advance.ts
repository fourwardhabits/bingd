import { useCallback, useEffect, useRef } from 'react';

import { after, readAllByKey } from '@/lib/read-all';
import { supabase } from '@/lib/supabase';

import { streakAdvanced, weeklyStreak, type WeeklyStreak } from './streak';

/** Every instant this reader placed a title, which is all a streak is made of. */
async function readRankedAt(userId: string): Promise<string[]> {
  const { data, error } = await readAllByKey<{ media_item_id: string; created_at: string }>(
    (cursor, limit) =>
      after(
        supabase.from('rankings').select('media_item_id, created_at').eq('user_id', userId),
        'media_item_id',
        cursor,
      )
        .order('media_item_id', { ascending: true })
        .limit(limit),
    (row) => [row.media_item_id],
  );
  if (error) throw error;
  return (data ?? []).map((row) => row.created_at);
}

/**
 * Whether the ranking that just finished advanced the reader's weekly streak.
 *
 * The same before-and-after shape `useNewUnlocks` uses, and for the same reason: the
 * question is not "what is the streak" but "did *this* ranking change it". A snapshot on
 * mount, a read after the placement, and `streakAdvanced` between them — so "the first
 * ranking of a new week" is a fact the two readings state rather than a guess about
 * timing.
 *
 * **Nothing is granted and nothing is written.** A streak is derived from
 * `rankings.created_at` (`streak.ts`), so this only ever reads. Every failure — a
 * snapshot that never landed, a read that errored — resolves to `null`, which means no
 * celebration and a ranking that succeeded regardless.
 *
 * The snapshot is a promise rather than a resolved value, because `rank_start` places a
 * title outright when there is nothing to compare against: on a first-ever ranking the
 * placement can beat the snapshot home, and a ref that had not been filled yet would
 * decide nothing had changed on precisely the ranking most worth noticing.
 */
export function useStreakAdvance(userId: string | null) {
  const before = useRef<Promise<WeeklyStreak | null> | null>(null);

  useEffect(() => {
    if (!userId) {
      before.current = null;
      return;
    }
    before.current = readRankedAt(userId)
      .then((at) => weeklyStreak(at, new Date()))
      // Resolved to null rather than left rejected: `detect` awaits this, and a rejection
      // would be an unhandled one on any render that never calls it.
      .catch(() => null);
    return () => {
      before.current = null;
    };
  }, [userId]);

  return useCallback(async (): Promise<number | null> => {
    if (!userId) return null;
    try {
      const snapshot = await (before.current ?? Promise.resolve(null));
      if (!snapshot) return null;
      const now = weeklyStreak(await readRankedAt(userId), new Date());
      return streakAdvanced(snapshot, now);
    } catch {
      return null;
    }
  }, [userId]);
}
