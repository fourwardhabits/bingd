import type { CollectionItem } from '@/features/collection/filters';

import { franchiseKey, maxPerGenre } from './rank';

/**
 * The client half of Group Picks: what to show from what the server scored.
 *
 * The RPC returns aggregates for up to a couple of hundred candidates in one
 * deterministic order (`20260907000100`). This module decides which of them make the
 * list — quality floors, the franchise and genre ceilings For You already enforces,
 * and the fallback ladder — and words the one reason each row is allowed to give.
 * Pure functions, so the whole policy is unit-testable without a network.
 */

/** Where a pick came from, in the server's vocabulary. */
export type GroupPickSource = 'saved' | 'group' | 'rewatch' | 'trending';

export type GroupPick = {
  item: CollectionItem;
  savedCount: number;
  watchedCount: number;
  rewatch: boolean;
  source: GroupPickSource;
  /** Internal ranking only. Never displayed — the visible number is the bingd. score. */
  groupScore: number;
  /** The community score, withheld (null) exactly as the title page would withhold it. */
  communityScore: number | null;
};

/** The most rows a list shows, and the point below which fallback starts filling. */
export const GROUP_PICKS_MAX = 20;
export const GROUP_PICKS_MIN = 10;

/**
 * The quality floors, on the server's 0–1 `group_score`.
 *
 * Calibrated against the RPC's arithmetic rather than chosen round: a title saved by
 * one member of a four-person group with everyone else neutral lands a little above
 * 0.3, and an unsaved candidate with decent whole-group fit lands near 0.4 — so 0.32
 * separates "the list is proud of this" from "the list is filling out". 0.2 is where
 * a candidate stops being about this group at all: below it sits the neutral-prior
 * noise floor, and padding with that would be padding with garbage, which the brief
 * rules out by name. Trending is capped at 0.15 server-side, safely under both.
 */
export const STRONG_FLOOR = 0.32;
export const FALLBACK_FLOOR = 0.2;

/**
 * Up to twenty strong picks; fallback and then trending fill only toward ten.
 *
 * Quality beats length: twenty strong rows show as twenty, thirteen as thirteen,
 * seven strong plus three credible fallback as ten, and six credible in total as six.
 * The ladder is the server's ordering walked three times with descending standards,
 * under the same two ceilings For You applies — at most two of a franchise and at
 * most 40% of one leading genre — shared across the passes so a fallback row cannot
 * reintroduce the third Batman the strong pass refused.
 */
export function selectGroupPicks(pool: readonly GroupPick[], limit = GROUP_PICKS_MAX): GroupPick[] {
  const chosen: GroupPick[] = [];
  const taken = new Set<string>();
  const perFranchise = new Map<string, number>();
  const perGenre = new Map<string, number>();
  const genreCeiling = maxPerGenre(limit);

  const admit = (pick: GroupPick): boolean => {
    if (taken.has(pick.item.mediaItemId)) return false;
    const franchise = franchiseKey(pick.item.title);
    if (franchise && (perFranchise.get(franchise) ?? 0) >= 2) return false;
    const genre = pick.item.genres[0];
    if (genre && (perGenre.get(genre) ?? 0) >= genreCeiling) return false;

    chosen.push(pick);
    taken.add(pick.item.mediaItemId);
    if (franchise) perFranchise.set(franchise, (perFranchise.get(franchise) ?? 0) + 1);
    if (genre) perGenre.set(genre, (perGenre.get(genre) ?? 0) + 1);
    return true;
  };

  // Pass one: what the group would be glad to see, to the full twenty.
  for (const pick of pool) {
    if (chosen.length >= limit) break;
    if (pick.source === 'trending' || pick.groupScore < STRONG_FLOOR) continue;
    admit(pick);
  }

  // Pass two: credible group-derived fallback, only toward ten.
  for (const pick of pool) {
    if (chosen.length >= Math.min(GROUP_PICKS_MIN, limit)) break;
    if (pick.source === 'trending' || pick.groupScore >= STRONG_FLOOR) continue;
    if (pick.groupScore < FALLBACK_FLOOR) continue;
    admit(pick);
  }

  // Pass three: trending, last resort, still only toward ten.
  for (const pick of pool) {
    if (chosen.length >= Math.min(GROUP_PICKS_MIN, limit)) break;
    if (pick.source !== 'trending') continue;
    admit(pick);
  }

  return chosen;
}

/**
 * The one reason a row gives, chosen for legibility and honesty in that order.
 *
 * Counts are real counts from the server; everything else claims only what the
 * arithmetic supports. "Match" is deliberately not in this vocabulary — it already
 * means Taste Match elsewhere in the app — and nothing here implies social proof
 * that was not measured.
 */
export function reasonFor(pick: GroupPick): string {
  if (pick.savedCount >= 2) return `${pick.savedCount} people saved this`;
  if (pick.savedCount === 1) return 'Someone here saved this';
  if (pick.rewatch) return 'Worth a rewatch';
  if (pick.source === 'trending') return 'Trending now';
  return 'Fits the group';
}

/**
 * The per-source tally as one analytics-safe string: `saved:4|group:9|rewatch:2|trending:0`.
 * Fixed order, every source named, so the values group cleanly in a chart.
 */
export function sourceMix(picks: readonly GroupPick[]): string {
  const counts: Record<GroupPickSource, number> = { saved: 0, group: 0, rewatch: 0, trending: 0 };
  for (const pick of picks) counts[pick.source] += 1;
  return (Object.keys(counts) as GroupPickSource[])
    .map((source) => `${source}:${counts[source]}`)
    .join('|');
}

/** Whether anything on the list rests on a shared save, for the zero-overlap line. */
export const hasSharedSaves = (picks: readonly GroupPick[]): boolean =>
  picks.some((pick) => pick.savedCount > 0);
