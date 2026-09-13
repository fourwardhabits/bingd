import { useQuery } from '@tanstack/react-query';

import { readPage, type TopRatedItem } from '@/features/recommendations/use-top-rated';
import type { Medium } from '@/features/recommendations/use-for-you';

/**
 * How many titles the Top Titles board draws.
 *
 * Fifty, which is what the people board asks `leaderboard` for and is also the ceiling
 * `top_rated_titles` clamps any request to — so one request is the whole board and there is
 * no second page to fetch. On today's production data that is every eligible title: 29
 * movies and 1 TV season clear the support floor.
 */
export const TOP_TITLES_LIMIT = 50;

export type TopTitle = TopRatedItem & {
  /**
   * The position the board prints, **shared by a genuine tie**.
   *
   * The server's order is total — score, then how many people rated it, then the id — and
   * the id is only there so a cursor cannot skip a row. It says nothing about which of two
   * titles is better, so two titles with the same score *and* the same support print the
   * same number, and the one after them skips, which is how the people board's `rank()`
   * already reads. A title with the same score and more ratings is genuinely ahead: support
   * is the second term of the ordering on purpose.
   */
  rank: number;
};

export const topTitlesKey = (userId: string, medium: Medium) =>
  ['top-titles', userId, medium] as const;

/** Competition ranking over (score, support), in the order the server returned. */
export function rankTopTitles(items: readonly TopRatedItem[]): TopTitle[] {
  const ranked: TopTitle[] = [];
  items.forEach((item, index) => {
    const previous = ranked[index - 1];
    const tied =
      previous !== undefined &&
      previous.communityScore === item.communityScore &&
      previous.ratingCount === item.ratingCount;
    ranked.push({ ...item, rank: tied ? previous.rank : index + 1 });
  });
  return ranked;
}

/**
 * The best-supported titles on bingd., in community-score order.
 *
 * **There is no ranking here of its own.** This is `top_rated_titles` — the For You wall's
 * Top Rated read, through the same `readPage` — asked for one longer page. Eligibility is
 * the server's `community_support_floor` (20260916000200), which filters for supported
 * titles first and sorts the survivors by score, then by how many people rated them. The
 * client neither re-sorts nor re-filters; it numbers.
 *
 * Its own key rather than `topRatedKey`: that one holds an infinite query's pages and this
 * holds one page, and two shapes under one key is a race over which screen ran first.
 * Keyed by the viewer as well, because the population excludes accounts they have blocked.
 *
 * Five minutes, the number `useTopRated` and `useCommunityScore` use for the same
 * aggregate: it moves when other people rank, not when this reader does something.
 */
export function useTopTitles(userId: string, medium: Medium, enabled: boolean) {
  return useQuery({
    queryKey: topTitlesKey(userId, medium),
    enabled: enabled && Boolean(userId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<TopTitle[]> => {
      const page = await readPage(medium, null, TOP_TITLES_LIMIT);
      return rankTopTitles(page.items);
    },
  });
}
