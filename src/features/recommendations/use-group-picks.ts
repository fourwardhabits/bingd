import { useQuery } from '@tanstack/react-query';

import { productGenres } from '@/lib/media-metadata';
import { supabase } from '@/lib/supabase';

import type { GroupPick, GroupPickSource } from './group-picks';
import { asCollectionItem, type Medium } from './use-for-you';

/**
 * The data half of Group Picks: one RPC, one catalogue read, no client scoring.
 *
 * The multi-user arithmetic lives in `group_picks` (`20260907000100`) because it has
 * to — scoring a group means holding other members' signals, which the client must
 * never be handed (`rank.ts`, `docs/architecture/recommendations.md` §0). What comes
 * back is aggregates per title; the only thing this hook adds is the world-readable
 * `media_items` metadata the rows need to draw and to filter.
 */

export type GroupPicksResult = {
  picks: GroupPick[];
  /**
   * How many people the server actually scored over, after re-checking visibility per
   * member. Smaller than the selection when somebody fell out between the picker and
   * the call — a block, a suspension, a flip to private. Who fell out is deliberately
   * not knowable.
   */
  effectiveMemberCount: number;
};

type PickRow = {
  media_item_id: string;
  saved_count: number;
  watched_count: number;
  rewatch: boolean;
  source: GroupPickSource;
  group_score: number;
  community_score: number | null;
};

type MediaRow = {
  id: string;
  title: string;
  release_date: string | null;
  poster_path: string | null;
  kind: 'movie' | 'series' | 'season';
  genres: string[];
  original_language: string | null;
  popularity: number | null;
};

/**
 * Viewer, then the member selection order-blind, then the medium. Filters are
 * deliberately absent: they narrow the returned pool client-side, and a filter that
 * re-ran the multi-user RPC would make the sheet's cheapest control its most
 * expensive one.
 */
export const groupPicksKey = (
  viewerId: string,
  memberIds: readonly string[],
  medium: Medium,
) => ['group-picks', viewerId, [...memberIds].sort().join(','), medium] as const;

export function useGroupPicks(
  viewerId: string,
  memberIds: readonly string[],
  medium: Medium,
  enabled: boolean,
) {
  return useQuery({
    queryKey: groupPicksKey(viewerId, memberIds, medium),
    enabled,
    // Five minutes, the brief's number: a group is assembled for one decision, and the
    // same selection re-opened inside it should not re-run the expensive call. Nothing
    // is persisted; the cache dies with the session like every other query here.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<GroupPicksResult> => {
      const { data, error } = await supabase.rpc('group_picks', {
        p_member_ids: memberIds as string[],
        p_medium: medium,
      });
      if (error) throw error;

      const body = data as { effective_member_count: number; picks: PickRow[] } | null;
      const rows = body?.picks ?? [];
      const effectiveMemberCount = body?.effective_member_count ?? 1;
      if (rows.length === 0) return { picks: [], effectiveMemberCount };

      const { data: media, error: mediaError } = await supabase
        .from('media_items')
        .select(
          'id, title, release_date, poster_path, kind, genres, original_language, popularity',
        )
        .in(
          'id',
          rows.map((row) => row.media_item_id),
        );
      if (mediaError) throw mediaError;

      const byId = new Map(((media ?? []) as unknown as MediaRow[]).map((row) => [row.id, row]));

      // Server order is the total order (score, saves, popularity, id) and is preserved
      // exactly: this walk is the RPC's rows, not the catalogue read's.
      const picks: GroupPick[] = [];
      for (const row of rows) {
        const item = byId.get(row.media_item_id);
        if (!item) continue; // a catalogue row deleted mid-flight is a skipped pick, not a crash
        picks.push({
          item: asCollectionItem({
            mediaItemId: item.id,
            title: item.title,
            year: item.release_date ? Number(item.release_date.slice(0, 4)) : null,
            posterPath: item.poster_path,
            kind: item.kind === 'series' ? 'series' : 'movie',
            // Product genres, same rule as For You: Anime must read as Anime in the
            // rows and in the filter sheet alike (2026-08-30).
            genres: productGenres({
              kind: item.kind,
              genres: item.genres,
              language: item.original_language,
            }),
            language: item.original_language,
            popularity: item.popularity,
          }),
          savedCount: row.saved_count,
          watchedCount: row.watched_count,
          rewatch: row.rewatch,
          source: row.source,
          groupScore: Number(row.group_score),
          communityScore: row.community_score == null ? null : Number(row.community_score),
        });
      }

      return { picks, effectiveMemberCount };
    },
  });
}
