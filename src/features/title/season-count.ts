import type { SeasonRow } from '@/features/search/use-title-search';

/**
 * **A whole show's length is its count of seasons** (visual refine, 2026-11-12): `1 season`,
 * `3 seasons`. It fills the length slot of the series page's metadata line, where a film
 * says `145 min` and a season `9 episodes`, so the page reads `2019 · TV-MA · 1 season`.
 *
 * Read from the series page's own `useSeasons` query and nothing else: no request, hook or
 * provider call is added for it. **Only an answered list counts.** While the list is
 * loading, after it has failed, or when it is empty, this is `null` and the segment is
 * simply absent (the line is built with `.filter(Boolean)`, so no separator is left
 * behind). `0 seasons` would read as a fact about the show when it is only data nobody has
 * yet, which is the same rule `lengthOf` applies to a season TMDB reports with no episodes.
 *
 * Specials (Season 0) are not a season of the show and are not counted, so a list of only
 * specials says nothing either.
 */
export function seasonCountLabel(seasons: {
  isSuccess: boolean;
  data?: readonly Pick<SeasonRow, 'season_number'>[] | null;
}): string | null {
  if (!seasons.isSuccess || !seasons.data) return null;
  const count = seasons.data.filter(
    (season) => typeof season.season_number === 'number' && season.season_number > 0,
  ).length;
  if (count === 0) return null;
  return `${count} ${count === 1 ? 'season' : 'seasons'}`;
}
