import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';

export type SearchResult = {
  id: string;
  kind: 'movie' | 'series' | 'season';
  title: string;
  release_date: string | null;
  poster_path: string | null;
  provenance: 'tmdb' | 'wikidata' | 'manual';
};

/**
 * Long enough that a fast typist makes one request rather than eight, short enough that
 * the list still moves while they type. `screens.md` §11 asks for something that feels
 * like filtering, and anything past ~250ms starts to feel like a request being sent.
 */
const DEBOUNCE_MS = 180;

/** Below this every query matches half the catalogue and none of it is useful. */
const MIN_QUERY_LENGTH = 2;

export function useDebounced<T>(value: T, delay = DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return settled;
}

/**
 * Title search against `search_titles` (20260814040000).
 *
 * `keepPreviousData` is the reason this feels like filtering: without it every keystroke
 * empties the list for the length of a round trip, and a list that blinks between states
 * reads as slower than one that lags slightly behind. The previous results stay on screen,
 * marked stale, until the new ones arrive.
 */
export function useTitleSearch(input: string) {
  const query = useDebounced(input.trim());
  const enabled = query.length >= MIN_QUERY_LENGTH;

  const result = useQuery({
    queryKey: queryKeys.search(query),
    enabled,
    placeholderData: keepPreviousData,
    // The catalogue is a table on the server; the same query a minute later has the same
    // answer. Refetching it costs a round trip and changes nothing.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<SearchResult[]> => {
      const { data, error } = await supabase.rpc('search_titles', {
        p_query: query,
        p_limit: 25,
      });
      if (error) throw error;
      return (data ?? []) as SearchResult[];
    },
  });

  return {
    ...result,
    /** True while the user has typed too little to search, which is not an empty result. */
    idle: !enabled,
    results: result.data ?? [],
  };
}

/** Seasons for a series, which is how a season is reached — search returns only films
 *  and series (PRD §26.2 AC 1, AC 2). `media_items` is world-readable, so this is a plain
 *  read rather than an RPC. */
export function useSeasons(seriesId: string | null) {
  return useQuery({
    queryKey: queryKeys.seasons(seriesId ?? ''),
    enabled: Boolean(seriesId),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('media_items')
        .select('id, season_number, title, release_date, poster_path')
        .eq('parent_id', seriesId)
        .eq('kind', 'season')
        .order('season_number');
      if (error) throw error;
      return (data ?? []) as {
        id: string;
        season_number: number;
        title: string;
        release_date: string | null;
        poster_path: string | null;
      }[];
    },
  });
}

/** The year, which is all a result row shows of a date. */
export const yearOf = (releaseDate: string | null) =>
  releaseDate ? Number(releaseDate.slice(0, 4)) : null;
