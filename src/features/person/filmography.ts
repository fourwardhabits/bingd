import type { SortAxisSpec, SortState } from '@/ui/sort';

import type { PersonCoverage, PersonCredit, KindCoverage } from './use-person';

/**
 * How a person's filmography can be ordered, and what each order can honestly promise.
 *
 * ---------------------------------------------------------------------------
 * THE AXIS (person page sorting, 2026-11-11; founder QA, 2026-11-12)
 *
 * Under the shared sort contract (`ui/sort.ts`) a label names an axis and the arrow
 * carries the direction, so Newest and Oldest are the two directions of one axis,
 * **Release date**, exactly as the Collection's own date axes are — one row in the menu,
 * pressed again to flip.
 *
 * - **Release date** orders by the catalogue row's release date (a series' first air
 *   date, which is all TMDB's person credits carry). Undated credits — announced,
 *   unscheduled — go last in **both** directions, the founder's rule for every date sort.
 *   It opens newest first.
 *
 * **Popular and Highest rated (TMDB) are gone** (founder QA, 2026-11-12). Neither is a
 * user-facing sort any more, and the page opens on Release date, newest first. The cache's
 * popularity order is still the tie-break, because it is the only stable order the
 * credits arrive in — but it is never offered as a sort of its own. Nothing about what
 * the adapter stores changed.
 *
 * The comparator is total: ties fall back to popularity order and then the catalogue id,
 * so a list never reshuffles between renders.
 */
export type FilmographyAxis = 'released';

export type FilmographySort = SortState<FilmographyAxis>;

const RELEASED: SortAxisSpec<FilmographyAxis> = {
  axis: 'released',
  label: 'Release date',
  directions: { desc: 'newest first', asc: 'oldest first' },
  defaultDirection: 'desc',
};

/** Where the page opens: Release date, newest first (founder QA, 2026-11-12). */
export const INITIAL_FILMOGRAPHY_SORT: FilmographySort = {
  axis: 'released',
  direction: 'desc',
};

/** The axes this list offers: Release date, in both directions, and nothing else. */
export const FILMOGRAPHY_AXES: readonly SortAxisSpec<FilmographyAxis>[] = [RELEASED];

const byPopularity = (a: PersonCredit, b: PersonCredit) =>
  a.order - b.order ||
  (a.mediaItemId < b.mediaItemId ? -1 : a.mediaItemId > b.mediaItemId ? 1 : 0);

/** A new array in the chosen order. Never mutates, never drops a credit. */
export function sortFilmography(
  credits: readonly PersonCredit[],
  sort: FilmographySort,
): PersonCredit[] {
  const sign = sort.direction === 'desc' ? -1 : 1;
  return [...credits].sort((a, b) => {
    // The missing test comes before the direction, so undated is last both ways.
    if (!a.releaseDate || !b.releaseDate) {
      if (a.releaseDate) return -1;
      if (b.releaseDate) return 1;
      return byPopularity(a, b);
    }
    if (a.releaseDate !== b.releaseDate) return a.releaseDate < b.releaseDate ? -sign : sign;
    return byPopularity(a, b);
  });
}

/** Which half of the page a list is, in the cache's coverage vocabulary. */
export type CoverageGroup = keyof PersonCoverage;

/** Movies and TV combined, for the All filter: the most conservative of the two. */
function combine(a: KindCoverage, b: KindCoverage): KindCoverage {
  const later = (x: string | null, y: string | null) =>
    x === null ? y : y === null ? x : x > y ? x : y;
  const earlier = (x: string | null, y: string | null) =>
    x === null ? y : y === null ? x : x < y ? x : y;
  return {
    newest: later(a.newest, b.newest),
    oldest: earlier(a.oldest, b.oldest),
    undated: a.undated || b.undated,
    rated: a.rated === null ? b.rated : b.rated === null ? a.rated : Math.max(a.rated, b.rated),
    unrated: a.unrated || b.unrated,
  };
}

/**
 * What a sorted list can promise.
 *
 * - `complete`: nothing in this scope was left out of the cache, so the order is the
 *   whole of their work.
 * - `partial`: rows before `from` are exactly what a full list would start with; from
 *   `from` on, some credits TMDB lists are not here. `from` can equal the list's length,
 *   when everything kept is vouched for and only the tail is missing. `tailOnly` says the
 *   only credits lost are in the tail the sort puts last — the undated ones — so the page
 *   names that tail rather than "older" or "later" credits.
 * - `unknown`: a row cached before coverage was recorded. The order is right for what is
 *   here and nothing can be said about what is not.
 */
export type SortCoverage =
  | { kind: 'complete' }
  | { kind: 'partial'; from: number; tailOnly: boolean }
  | { kind: 'unknown' };

/**
 * Where a sorted list stops being complete.
 *
 * The adapter records, per half and kind, the newest and oldest date among the credits it
 * **dropped** (`KindCoverage`). A newest-first list is therefore complete for every row
 * dated after the newest dropped credit, and the first row that is not is where the page
 * says so.
 */
export function sortCoverage(
  sorted: readonly PersonCredit[],
  sort: FilmographySort,
  coverage: PersonCoverage | null,
  group: CoverageGroup,
  filter: 'all' | 'movie' | 'series',
): SortCoverage {
  if (!coverage) return { kind: 'unknown' };

  const half = coverage[group];
  const lost = filter === 'all' ? combine(half.movie, half.series) : half[filter];

  const vouched =
    sort.direction === 'desc'
      ? (credit: PersonCredit) =>
          credit.releaseDate
            ? lost.newest === null || credit.releaseDate > lost.newest
            : lost.newest === null && !lost.undated
      : (credit: PersonCredit) =>
          credit.releaseDate
            ? lost.oldest === null || credit.releaseDate < lost.oldest
            : lost.oldest === null && !lost.undated;
  // Each direction decides by its own end, so a record that knew one end and not the
  // other could never make the other direction read as complete.
  const rangeLost = sort.direction === 'desc' ? lost.newest !== null : lost.oldest !== null;
  const missing = rangeLost || lost.undated;

  if (!missing) return { kind: 'complete' };
  const from = sorted.findIndex((credit) => !vouched(credit));
  return { kind: 'partial', from: from === -1 ? sorted.length : from, tailOnly: !rangeLost };
}

/**
 * The index of the first credit in the tail the sort puts last — the undated ones — or
 * null when there is no such tail. The page labels it, so a list that changes kind of
 * order halfway down says so.
 */
export function tailStart(sorted: readonly PersonCredit[]): number | null {
  const index = sorted.findIndex((credit) => !credit.releaseDate);
  // A list that is all tail has nothing above it to set the tail apart from.
  return index > 0 ? index : null;
}
