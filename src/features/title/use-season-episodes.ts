import { useQuery } from '@tanstack/react-query';

import { fetchSeasonEpisodes, type TitleEpisode } from '@/lib/tmdb-adapter';

export type { TitleEpisode };

/**
 * How long an episode list stays fresh.
 *
 * An hour, the same window `useTitleVideos` uses, and for the same reason: this is
 * provider reference data about something that has already been broadcast. An
 * episode's name, date and synopsis do not change while somebody is reading them,
 * and the one field that does move — an unaired episode acquiring a runtime and a
 * still — is not worth a request on a screen the reader is looking at right now.
 */
const EPISODES_STALE_MS = 60 * 60_000;

/** The key `use-enrichment` seeds and this hook reads. */
export const episodesKey = (mediaItemId: string) => ['episodes', mediaItemId] as const;

/**
 * One season's episodes, for the Episodes tab.
 *
 * **Usually this makes no request at all.** A season page enriches on mount, the
 * adapter returns the episodes on that same response, and `use-enrichment` writes
 * them straight into this query's cache with `setQueryData`. By the time the tab
 * renders, the data is normally already here and React Query serves it without
 * going anywhere.
 *
 * The `queryFn` is the fallback for when that did not happen: an enrichment that
 * failed silently — which it is designed to do, so a missing poster never becomes an
 * error banner — or a row complete enough that `detail` was never called. One
 * request, charged to the reader's own provider ceiling like every other screen-
 * triggered fetch.
 *
 * `enabled` is the lazy half. The caller passes false until the Episodes tab is the
 * active one, so a reader who opens a season page and goes straight to Reviews
 * spends nothing here. A seeded cache still shows instantly when they do open it,
 * because seeding writes the data rather than triggering a fetch.
 *
 * Never called for a film or a series grouping. Episodes belong to a season, and the
 * adapter refuses the other two rather than answering with an empty list.
 */
export function useSeasonEpisodes(mediaItemId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: episodesKey(mediaItemId ?? ''),
    enabled: Boolean(mediaItemId) && enabled,
    staleTime: EPISODES_STALE_MS,
    queryFn: (): Promise<TitleEpisode[]> => fetchSeasonEpisodes(mediaItemId!),
  });
}
