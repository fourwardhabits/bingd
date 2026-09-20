import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';

import { inWatchOrder, type WatchEvent } from './watch-history';

/**
 * One title's watch history, and the placements that are not tied to a viewing.
 *
 * Two plain `select`s under owner-only RLS, not an RPC. `watch_events` and
 * `ranking_placements` both carry `using (user_id = auth.uid())` and no write policy, so
 * the policy is the authorisation — a definer read would be a second door to check, and
 * watch dates are private at every profile visibility (PRD §22).
 */

export type Placement = {
  id: string;
  kind: string;
  outcome: string;
  position: number;
  categorySize: number;
  fromPosition: number | null;
  score: number;
  watchEventId: string | null;
  createdAt: string;
};

export type WatchHistory = {
  events: WatchEvent[];
  placements: Placement[];
  /** `events.length`, named because §J.2's entry line and header both read it. */
  count: number;
};

type EventRow = {
  id: string;
  watched_on: string | null;
  basis: WatchEvent['basis'];
  import_ref: string | null;
  recorded_at: string;
};

type PlacementRow = {
  id: string;
  kind: string;
  outcome: string;
  position: number;
  category_size: number;
  from_position: number | null;
  score: number | string;
  watch_event_id: string | null;
  created_at: string;
};

export function useWatchHistory(userId: string, mediaItemId: string) {
  return useQuery({
    queryKey: queryKeys.watchHistory(userId, mediaItemId),
    enabled: Boolean(userId && mediaItemId),
    queryFn: async (): Promise<WatchHistory> => {
      const [events, placements] = await Promise.all([
        supabase
          .from('watch_events')
          .select('id, watched_on, basis, import_ref, recorded_at')
          .eq('media_item_id', mediaItemId)
          // Ordered here as well as in `inWatchOrder`, so a history longer than a page
          // is paged in the order it will be read rather than in the order the planner
          // happened to produce. The client sort remains the authority.
          .order('watched_on', { ascending: true, nullsFirst: true })
          .order('recorded_at', { ascending: true }),
        supabase
          .from('ranking_placements')
          .select(
            'id, kind, outcome, position, category_size, from_position, score, watch_event_id, created_at',
          )
          .eq('media_item_id', mediaItemId)
          .order('created_at', { ascending: false }),
      ]);

      if (events.error) throw events.error;
      if (placements.error) throw placements.error;

      const mapped = ((events.data ?? []) as EventRow[]).map(
        (row): WatchEvent => ({
          id: row.id,
          watchedOn: row.watched_on,
          basis: row.basis,
          importRef: row.import_ref,
          recordedAt: row.recorded_at,
        }),
      );

      return {
        events: inWatchOrder(mapped),
        placements: ((placements.data ?? []) as PlacementRow[]).map((row) => ({
          id: row.id,
          kind: row.kind,
          outcome: row.outcome,
          position: row.position,
          categorySize: row.category_size,
          fromPosition: row.from_position,
          // `numeric(3,1)` arrives as a string through PostgREST on some paths and a
          // number on others. Coerced once, here, rather than at four call sites.
          score: Number(row.score),
          watchEventId: row.watch_event_id,
          createdAt: row.created_at,
        })),
        count: mapped.length,
      };
    },
  });
}

/**
 * Just the count, for the title page's personal-context line.
 *
 * A separate, much cheaper query than the full history: the line renders on every title
 * page visit and needs one integer, and reading the whole history to produce it would
 * put a reader's twenty-row diary on the wire to draw four words.
 *
 * `head: true` with `count: 'exact'` sends no rows at all.
 */
export function useWatchCount(userId: string, mediaItemId: string) {
  return useQuery({
    queryKey: queryKeys.watchCount(userId, mediaItemId),
    enabled: Boolean(userId && mediaItemId),
    queryFn: async (): Promise<number> => {
      const { count, error } = await supabase
        .from('watch_events')
        .select('id', { count: 'exact', head: true })
        .eq('media_item_id', mediaItemId);

      if (error) throw error;
      return count ?? 0;
    },
  });
}
