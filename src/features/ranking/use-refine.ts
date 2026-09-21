import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type { RankingCategory } from '@/features/collection/use-collection';
import { queryKeys } from '@/lib/query';
import { readPref, writePref } from '@/lib/prefs';

import { refineCandidates, type RefineStatus } from './refine';

/**
 * Whether Collection draws `Refine rankings ›` for one category (T5).
 *
 * **The server's status is the gate, and the only one.** `refine_candidates` answers
 * `disabled` while `ranking.refine_enabled` is false, and a backend that predates the
 * migration reads as `disabled` too (`refineCandidates`). So this code can ship in an OTA
 * with nothing drawn, and switching the feature on is one `app_config` row.
 *
 * One cheap read per category, cached for ten minutes: it runs on the Collection tab and
 * must not turn every visit into a query over the reader's whole comparison history.
 */
export function useRefineAvailability(userId: string, category: RankingCategory) {
  return useQuery({
    queryKey: queryKeys.refineAvailability(userId, category),
    enabled: Boolean(userId),
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: async (): Promise<RefineStatus> =>
      (await refineCandidates(category, { limit: 1 })).status,
  });
}

/**
 * **A finished sitting quiets the entry for a week** (§H.1.2 "never a permanent call to
 * action"). Per account and per category, on the device, like the unranked nudge's
 * dismissal: it is a habit, not an account setting.
 *
 * The server's own rests (a refined title, the daily ceiling) still apply underneath;
 * this only stops Collection re-offering Refine the moment somebody has just done it.
 */
export const REFINE_QUIET_DAYS = 7;

const quietKey = (userId: string, category: RankingCategory) =>
  `${userId}.collection.refine-finished.${category}`;

export const markRefineFinished = (userId: string, category: RankingCategory) =>
  writePref(quietKey(userId, category), new Date().toISOString()).catch(() => {});

export function isQuiet(finishedAt: string | null, now = Date.now()): boolean {
  if (!finishedAt) return false;
  const at = new Date(finishedAt).getTime();
  if (Number.isNaN(at)) return false;
  return now - at < REFINE_QUIET_DAYS * 24 * 60 * 60 * 1000;
}

/** Whether the entry is resting after a finished sitting. Null until the store answers. */
export function useRefineQuiet(userId: string, category: RankingCategory): boolean | null {
  const [state, setState] = useState<{ key: string; quiet: boolean } | null>(null);
  const key = quietKey(userId, category);

  useEffect(() => {
    let live = true;
    readPref<string>(key)
      .then((value) => live && setState({ key, quiet: isQuiet(value ?? null) }))
      .catch(() => live && setState({ key, quiet: false }));
    return () => {
      live = false;
    };
  }, [key]);

  return state && state.key === key ? state.quiet : null;
}
