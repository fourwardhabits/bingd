import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { queryKeys } from '@/lib/query';
import { enrichTitle } from '@/lib/tmdb-adapter';

/** The subset of a catalogue row that decides whether the provider is worth asking. */
export type EnrichableTitle = {
  id: string;
  kind: 'movie' | 'series' | 'season';
  tmdb_id: number | null;
  poster_path: string | null;
  overview: string | null;
  runtime_minutes: number | null;
};

/**
 * A row is thin when the screen has visible holes in it.
 *
 * Artwork and an overview are what the title screen is mostly made of, so either
 * being absent is reason enough. Runtime is checked for the two rankable kinds
 * because `TitleMetadata` renders it beside the year and a missing one leaves a
 * stray separator.
 *
 * A season is allowed through without a tmdb id of its own: TMDB reaches a season
 * as /tv/{series}/season/{n}, so what matters is the id on its parent, and the
 * adapter is where that lookup belongs.
 */
function isThin(title: EnrichableTitle) {
  if (title.kind !== 'season' && !title.tmdb_id) return false;
  if (!title.poster_path) return true;
  if (!title.overview) return true;
  if (title.kind !== 'series' && !title.runtime_minutes) return true;
  return false;
}

/**
 * Asks the adapter to fill one row in, at most once per mount.
 *
 * The guard is not optional. Enrichment invalidates the queries that decide whether
 * enrichment is needed, so without it a title TMDB genuinely has no artwork for
 * would ask again on every render — spending the ceiling in api.md §9 on a row that
 * will never change.
 *
 * A failure is deliberately silent. The screen has a title, a year and the user's
 * own ranking already, and an error banner over working content would be a worse
 * screen than one missing a poster.
 */
function useEnrichOnce(id: string | null | undefined, needed: boolean) {
  const queryClient = useQueryClient();
  const [enriching, setEnriching] = useState(false);
  const attempted = useRef(new Set<string>());

  useEffect(() => {
    if (!id || !needed || attempted.current.has(id)) return;
    attempted.current.add(id);

    let cancelled = false;
    setEnriching(true);

    enrichTitle(id)
      .then(async (result) => {
        if (cancelled || !result.enriched) return;
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.title(id) }),
          queryClient.invalidateQueries({ queryKey: ['credits', id] }),
          queryClient.invalidateQueries({ queryKey: queryKeys.seasons(id) }),
        ]);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setEnriching(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id, needed, queryClient]);

  return { enriching };
}

/**
 * Fills a title in from the provider the first time someone opens it.
 *
 * The alpha catalogue is a Wikidata seed with no artwork, no overviews and no
 * credits, so most rows arrive thin and are completed on first view. This is the
 * on-demand half of that; `tmdb-adapter`'s `enrich` action is the bulk half, and a
 * title someone has already visited will have been filled by whichever ran first.
 */
export function useTitleEnrichment(title: EnrichableTitle | null | undefined) {
  return useEnrichOnce(title?.id, title ? isThin(title) : false);
}

/**
 * Fetches a series' seasons the first time someone opens its picker.
 *
 * A series that arrived through search has no season rows at all: TMDB's search
 * response does not carry them, and fetching them for every result would spend a
 * provider request per row to fill a list most of them will never open. So the
 * picker is where they arrive — which is also the first moment they are needed,
 * since a series cannot be logged and picking a season is the only thing to do
 * with one (AD-1, PRD §10).
 *
 * Without this the picker offers "No seasons yet" for every series the local
 * catalogue has never seen, which is a dead end at the exact point the user is
 * trying to log something.
 */
export function useSeasonEnrichment(seriesId: string | null, hasNoSeasons: boolean) {
  return useEnrichOnce(seriesId, hasNoSeasons);
}
