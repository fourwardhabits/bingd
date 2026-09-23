import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

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

/**
 * The stored Not now, read through the query cache.
 *
 * **Why this is a query and not a `useState` + effect** (founder QA, 2026-09-22): the
 * value is written on a *different screen* from the one that reads it. A Refine sitting
 * ends on the ranking screen and the card lives on Collection, which is mounted
 * underneath it and never unmounts — so a per-mount read answered with the value from
 * before the sitting, the card stayed, and only a cold start put it right. One cache
 * entry, written by {@link applyRefineNotNow} the moment the sitting ends, is the same
 * value both screens see, and it is the value a restart would have read anyway.
 */
export function useRefineNotNow(userId: string, category: RankingCategory) {
  return useQuery({
    queryKey: queryKeys.refineNotNow(userId, category),
    enabled: Boolean(userId),
    // Nothing but this app writes it, and every writer updates the cache itself.
    staleTime: Infinity,
    retry: false,
    queryFn: async (): Promise<RefineNotNow | null> => {
      try {
        return (await readPref<RefineNotNow>(notNowKey(userId, category))) ?? null;
      } catch {
        // A device that cannot read its preferences is not a device that has dismissed
        // anything; the server still gates the card.
        return null;
      }
    },
  });
}

/**
 * Record a Not now — the button, or the Done that ends a sitting — and make every
 * mounted card agree with it on the next frame.
 *
 * The cache is written first and awaited second, deliberately: the storage write can be
 * slow or fail outright, and neither is a reason for the card to linger.
 */
export function applyRefineNotNow(
  queryClient: QueryClient,
  userId: string,
  category: RankingCategory,
  placementsTotal: number,
): Promise<void> {
  const value: RefineNotNow = {
    dismissedAt: new Date().toISOString(),
    placementsAtDismissal: placementsTotal,
  };
  queryClient.setQueryData(queryKeys.refineNotNow(userId, category), value);
  return writePref<RefineNotNow>(notNowKey(userId, category), value).catch(() => {});
}

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
  const queryClient = useQueryClient();
  const availability = useRefineAvailability(userId, category);
  const stored = useRefineNotNow(userId, category);

  const data = availability.data;
  // `isSuccess` rather than "not undefined": null IS an answer here (nothing stored).
  const loaded = stored.isSuccess;
  const show =
    loaded &&
    data?.status === 'ready' &&
    data.cta.show &&
    !isSnoozed(stored.data ?? null, data.placementsTotal, data.cta.resurfaceAfter);

  const notNow = useCallback(() => {
    void applyRefineNotNow(queryClient, userId, category, data?.placementsTotal ?? 0);
  }, [category, data?.placementsTotal, queryClient, userId]);

  return {
    show: Boolean(show),
    count: data?.cta.count ?? 0,
    strong: data?.cta.strong ?? 0,
    qualifying: data?.cta.qualifying ?? 0,
    notNow,
  };
}
