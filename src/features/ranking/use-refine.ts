import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import type { RankingCategory } from '@/features/collection/use-collection';
import { queryKeys } from '@/lib/query';
import { readPref, writePref } from '@/lib/prefs';

import { refineCandidates, type RefineCandidates } from './refine';

/**
 * Refine's standing in one category, for Collection's card (unified design §5).
 *
 * **The server's answer is the gate.** `refine_candidates` answers `disabled` while
 * `ranking.refine_enabled` is false, and a backend that predates the migration reads as
 * `disabled` too (`refineCandidates`), so this can ship in an OTA with nothing drawn. Its
 * `cta` block says whether the batch is strong enough to invite anybody — candidate
 * exists is not the same as show the card.
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
    queryFn: (): Promise<RefineCandidates> => refineCandidates(category, { limit: 1 }),
  });
}

/**
 * **Not now, and Done after a sitting** (unified design §6).
 *
 * Both store the medium's placement total at that moment, per account and per category on
 * the device, like the unranked card's dismissal: a habit, not an account setting. The card
 * returns only when the reader has made `resurfaceAfter` new placements since (new rankings,
 * backlog placements, reranks — never a backfill or a refine, which the server leaves out
 * of the total) AND the server says the batch is strong again. There is no time-based
 * return, so a reader who never ranks again is never asked again.
 */
export type RefineNotNow = { dismissedAt: string; placementsAtDismissal: number };

const notNowKey = (userId: string, category: RankingCategory) =>
  `${userId}.collection.refine-not-now.${category}`;

export const markRefineNotNow = (
  userId: string,
  category: RankingCategory,
  placementsTotal: number,
) =>
  writePref<RefineNotNow>(notNowKey(userId, category), {
    dismissedAt: new Date().toISOString(),
    placementsAtDismissal: placementsTotal,
  }).catch(() => {});

/** Whether a stored Not now still holds, given the medium's placements now. */
export function isSnoozed(
  pref: RefineNotNow | null,
  placementsTotal: number,
  resurfaceAfter: number,
): boolean {
  if (!pref || typeof pref.placementsAtDismissal !== 'number') return false;
  return placementsTotal - pref.placementsAtDismissal < Math.max(1, resurfaceAfter);
}

/**
 * The Refine card for one category: whether to draw it, the number it may name, and the
 * Not now that hides it. `show` is false until both the server and the stored preference
 * have answered — a card that appears and then vanishes is worse than one a frame late.
 */
export function useRefineCard(userId: string, category: RankingCategory) {
  const availability = useRefineAvailability(userId, category);
  const key = notNowKey(userId, category);
  const [pref, setPref] = useState<{ key: string; value: RefineNotNow | null } | null>(null);

  useEffect(() => {
    let live = true;
    readPref<RefineNotNow>(key)
      .then((value) => live && setPref({ key, value: value ?? null }))
      .catch(() => live && setPref({ key, value: null }));
    return () => {
      live = false;
    };
  }, [key]);

  const data = availability.data;
  const loaded = pref !== null && pref.key === key;
  const show =
    loaded &&
    data?.status === 'ready' &&
    data.cta.show &&
    !isSnoozed(pref.value, data.placementsTotal, data.cta.resurfaceAfter);

  const notNow = useCallback(() => {
    const placements = data?.placementsTotal ?? 0;
    setPref({
      key,
      value: { dismissedAt: new Date().toISOString(), placementsAtDismissal: placements },
    });
    void markRefineNotNow(userId, category, placements);
  }, [category, data?.placementsTotal, key, userId]);

  return {
    show: Boolean(show),
    count: data?.cta.count ?? 0,
    strong: data?.cta.strong ?? 0,
    qualifying: data?.cta.qualifying ?? 0,
    notNow,
  };
}
