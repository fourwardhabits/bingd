import { useQuery } from '@tanstack/react-query';

import type { Person } from '@/features/collection/use-companions';
import { avatarUri } from '@/lib/images';
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

/** A viewing's own details (20261014000100): private to the owner, like its date. */
export type WatchDetails = { note: string | null; companions: Person[] };

export type WatchHistory = {
  events: WatchEvent[];
  /** Keyed by viewing id. Empty against a backend that predates the details. */
  details: Map<string, WatchDetails>;
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
  note?: string | null;
  companions?: { companion: ProfileShape | ProfileShape[] | null }[] | null;
};

type ProfileShape = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
};

const BASE_COLUMNS = 'id, watched_on, basis, import_ref, recorded_at';
const DETAIL_COLUMNS =
  `${BASE_COLUMNS}, note, ` +
  'companions:watch_event_companions(companion:companion_id(id, username, display_name, avatar_path))';

/**
 * A backend without 20261014000100 answers the detailed select with an unknown column
 * (42703) or relationship (PGRST200). The history must still load there — the details
 * are an addition, not a precondition — so the read falls back to the columns it always
 * had.
 */
const missingDetails = (error: { code?: string } | null) =>
  error?.code === '42703' || error?.code === 'PGRST200';

const readEvents = (mediaItemId: string, columns: string) =>
  supabase
    .from('watch_events')
    .select(columns)
    .eq('media_item_id', mediaItemId)
    // Ordered here as well as in `inWatchOrder`, so a history longer than a page
    // is paged in the order it will be read rather than in the order the planner
    // happened to produce. The client sort remains the authority.
    .order('watched_on', { ascending: true, nullsFirst: true })
    .order('recorded_at', { ascending: true });

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
      const [detailed, placements] = await Promise.all([
        readEvents(mediaItemId, DETAIL_COLUMNS),
        supabase
          .from('ranking_placements')
          .select(
            'id, kind, outcome, position, category_size, from_position, score, watch_event_id, created_at',
          )
          .eq('media_item_id', mediaItemId)
          .order('created_at', { ascending: false }),
      ]);

      const events = missingDetails(detailed.error)
        ? await readEvents(mediaItemId, BASE_COLUMNS)
        : detailed;
      if (events.error) throw events.error;
      if (placements.error) throw placements.error;

      const rows = (events.data ?? []) as unknown as EventRow[];
      const details = new Map<string, WatchDetails>();
      for (const row of rows) {
        const companions = (row.companions ?? [])
          .map((c) => (Array.isArray(c.companion) ? c.companion[0] : c.companion))
          .filter((p): p is ProfileShape => Boolean(p))
          .map((p) => ({
            id: p.id,
            username: p.username,
            name: p.display_name || p.username,
            avatarUri: avatarUri(p.avatar_path),
          }));
        if (row.note || companions.length) {
          details.set(row.id, { note: row.note ?? null, companions });
        }
      }

      const mapped = rows.map(
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
        details,
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
