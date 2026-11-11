import { useQuery } from '@tanstack/react-query';

import type { LoggableTitle } from '@/features/collection/LogSheet';
import { yearOf } from '@/features/search/use-title-search';
import { posterUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';

type TitleRow = {
  id: string;
  kind: string;
  title: string;
  season_number: number | null;
  release_date: string | null;
  poster_path: string | null;
  parent: { title: string } | { title: string }[] | null;
};

/**
 * This title as the rating sheet wants it, for Watch History's **Edit ranking** (UI
 * consistency sprint, 2026-11-10).
 *
 * The same six fields the title page assembles into its `loggable` before it opens
 * *Edit ranking*, read here because this screen can be opened without the title
 * page's query in the cache (a deep link, or a cold start). A read and nothing else.
 *
 * **Its own key, under the title's.** The title page's `queryKeys.title(id)` holds a wider
 * row from a different select; sharing that key with a narrower function would let either
 * screen overwrite the other's cache with the wrong shape. Nested under it, so anything
 * that invalidates the title refreshes this too.
 *
 * A film, a season, or a whole show (rankable in its own pool since 2026-11-14).
 */
export function useHistoryTitle(mediaItemId: string) {
  return useQuery({
    queryKey: [...queryKeys.title(mediaItemId), 'loggable'] as const,
    enabled: Boolean(mediaItemId),
    queryFn: async (): Promise<LoggableTitle | null> => {
      const { data, error } = await supabase
        .from('media_items')
        .select('id, kind, title, season_number, release_date, poster_path, parent:parent_id(title)')
        .eq('id', mediaItemId)
        .single();
      if (error) throw error;
      const row = data as unknown as TitleRow;
      if (row.kind !== 'movie' && row.kind !== 'season' && row.kind !== 'series') return null;
      const parent = Array.isArray(row.parent) ? row.parent[0] : row.parent;
      return {
        id: row.id,
        title: row.title,
        year: yearOf(row.release_date),
        posterUri: posterUri(row.poster_path, 'card'),
        kind: row.kind,
        seriesTitle: parent?.title ?? null,
        seasonNumber: row.season_number ?? null,
      };
    },
  });
}
