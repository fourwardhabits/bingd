import { useQuery } from '@tanstack/react-query';

import type { RankingCategory } from '@/features/collection/use-collection';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';

import type { BucketId } from '@/ui/components';

export { rankBacklogStart } from './session';

/**
 * The unranked backlog (unified Backlog + Refine, `20261019000100` §9).
 *
 * The server owns what is in it and in what order (`ranking_backlog`): incomplete native
 * placements first, then seen-but-unranked titles by watch date. This module reads it,
 * opens one placement (`rank_backlog_start`), and holds the few rules that belong to one
 * sitting — the soft checkpoint and the progress line. Pure where it can be.
 */

/** `skipped`: everything left was skipped in this sitting. `empty`: nothing to rank. */
export type BacklogStatus = 'ready' | 'empty' | 'skipped' | 'disabled';

export type BacklogTarget = {
  mediaItemId: string;
  title: string;
  posterPath: string | null;
  kind: 'movie' | 'season';
  /** The bucket the reader already chose in bingd. Null: ask "How was it?" first. */
  bucket: BucketId | null;
  /** An open first-ranking session that will come back with its answers. */
  resume: boolean;
};

export type Backlog = {
  status: BacklogStatus;
  /** Every rankable, unranked title in the medium — the exact count for Unranked. */
  total: number;
  /** Those not skipped in this sitting. */
  remaining: number;
  targets: BacklogTarget[];
  /** Titles per soft checkpoint (`ranking.backlog_checkpoint`). */
  checkpointEvery: number;
};

const DISABLED: Backlog = {
  status: 'disabled',
  total: 0,
  remaining: 0,
  targets: [],
  checkpointEvery: 10,
};

const BUCKETS: Record<string, BucketId> = {
  loved: 'loved',
  fine: 'fine',
  not_for_me: 'notForMe',
};
const STATUSES = new Set<BacklogStatus>(['ready', 'empty', 'skipped', 'disabled']);

type Row = {
  media_item_id?: unknown;
  title?: unknown;
  poster_path?: string | null;
  kind?: string | null;
  bucket?: string | null;
  resume?: boolean;
};

export function parseBacklog(data: unknown): Backlog {
  const body = (data ?? {}) as {
    status?: string;
    total?: number;
    remaining?: number;
    targets?: Row[];
    checkpoint_every?: number;
  };
  const status = STATUSES.has(body.status as BacklogStatus)
    ? (body.status as BacklogStatus)
    : 'disabled';
  const count = (value: unknown, fallback = 0) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const targets = (Array.isArray(body.targets) ? body.targets : [])
    .filter((row) => typeof row?.media_item_id === 'string' && typeof row.title === 'string')
    .map((row): BacklogTarget => ({
      mediaItemId: row.media_item_id as string,
      title: row.title as string,
      posterPath: row.poster_path ?? null,
      kind: row.kind === 'season' ? 'season' : 'movie',
      bucket: (row.bucket && BUCKETS[row.bucket]) || null,
      resume: Boolean(row.resume),
    }));
  return {
    status: status === 'ready' && targets.length === 0 ? 'empty' : status,
    total: count(body.total),
    remaining: count(body.remaining),
    targets,
    checkpointEvery: Math.max(1, count(body.checkpoint_every, 10)),
  };
}

/**
 * The next titles to rank in one medium, or why there are none. A backend without the
 * function reads as `disabled`, so the client can ship ahead of the migration.
 */
export async function rankingBacklog(
  category: RankingCategory,
  options: { limit?: number; skip?: readonly string[] } = {},
): Promise<Backlog> {
  const { data, error } = await supabase.rpc('ranking_backlog', {
    p_category: category,
    p_limit: options.limit ?? 1,
    p_skip: [...(options.skip ?? [])],
  });
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') return DISABLED;
    throw error;
  }
  return parseBacklog(data);
}

/**
 * The backlog's standing in one medium, for Collection: whether it is on, and the exact
 * count the Unranked tab names. One title is read, not the queue.
 */
export function useRankingBacklog(userId: string, category: RankingCategory) {
  return useQuery({
    queryKey: queryKeys.rankingBacklog(userId, category),
    enabled: Boolean(userId),
    staleTime: 60_000,
    retry: false,
    queryFn: () => rankingBacklog(category, { limit: 1 }),
  });
}

// ---------------------------------------------------------------------------
// The sitting
// ---------------------------------------------------------------------------

/**
 * **A soft checkpoint, not a limit** (founder decision 4, 2026-09-21). After every
 * `every` titles placed the sitting pauses on "10 titles ranked." with Keep going and Done.
 * Keep going carries on through the same backlog; nothing stops a reader ranking all of
 * it, and nothing is lost by stopping — the queue is the server's and resumes.
 */
export const atBacklogCheckpoint = (placed: number, every: number) =>
  placed > 0 && placed % Math.max(1, every) === 0;

/**
 * "7 of 18 ranked" — the total fixed when the sitting began, so the line counts up toward
 * a number that does not move under the reader. Only on Unranked-launched sittings, which
 * is the only way in: the Watched card never names a count (founder decision 3).
 */
export const backlogProgress = (placed: number, total: number) =>
  `${Math.min(placed, total)} of ${total} ranked`;
