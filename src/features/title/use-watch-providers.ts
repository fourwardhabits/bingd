import { useQuery } from '@tanstack/react-query';

import { watchRegion } from '@/lib/region';
import {
  fetchWatchProviders,
  type WatchAvailability,
  type WatchOffer,
  type WatchProvider,
} from '@/lib/tmdb-adapter';

export type { WatchAvailability, WatchOffer, WatchProvider };

/**
 * How long availability stays fresh.
 *
 * Twelve hours. Licensing windows move on the first of the month, not while somebody
 * is reading a title page, so this is the longest window in the app — longer than the
 * hour `useTitleVideos` and `useSeasonEpisodes` use, because those describe something
 * that has already been broadcast and this describes a contract that has not changed
 * since breakfast either way.
 *
 * The number that matters is not freshness but **quiet**: this query is not gated
 * behind a tab, so it mounts with the title page. A short window would mean a
 * provider request every time somebody reopened a film they were deciding about.
 */
const PROVIDERS_STALE_MS = 12 * 60 * 60_000;

export const watchProvidersKey = (mediaItemId: string, region: string) =>
  ['watch-providers', mediaItemId, region] as const;

/**
 * Where this title can be watched, for the block under the scores.
 *
 * **One request per title per region per twelve hours, and none from a tab.** The
 * block sits above the segmented tabs rather than inside one, so this is not
 * `enabled`-gated the way `useSeasonEpisodes` is — which is exactly why the staleness
 * window is long and `retry` is off. Switching tabs re-renders the screen and asks
 * this query for its cached answer; nothing about it re-fetches.
 *
 * **`retry: false`, against the app's default of two.** Every attempt is a fresh
 * adapter invocation and a fresh TMDB request charged to this reader's hourly
 * ceiling, and this block is the one thing on the page that is allowed to be absent.
 * Spending three requests to fail three times, on a title page that renders perfectly
 * well without it, is the wrong trade in both directions.
 *
 * **Keyed by title and region, not by account.** Availability is a fact about a
 * market rather than about a viewer — unlike the two score hooks beside it, which are
 * keyed by account because their answers really do differ per person — so two
 * accounts on one device share this entry and a sign-out need not discard it.
 *
 * The region is resolved once per call from the device rather than passed in, because
 * nothing above this hook has an opinion about it and a parameter would invite one.
 */
export function useWatchProviders(mediaItemId: string | null) {
  const region = watchRegion();

  return useQuery({
    queryKey: watchProvidersKey(mediaItemId ?? '', region),
    enabled: Boolean(mediaItemId),
    staleTime: PROVIDERS_STALE_MS,
    retry: false,
    queryFn: (): Promise<WatchAvailability> => fetchWatchProviders(mediaItemId!, region),
  });
}
