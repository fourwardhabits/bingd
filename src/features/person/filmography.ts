import { decadeOf, facetOptions, type CollectionItem, type Decade } from '@/features/collection/filters';
import type { SortAxisSpec, SortState } from '@/ui/sort';

import type { PersonCoverage, PersonCredit, KindCoverage } from './use-person';

/**
 * How a person's filmography can be ordered, and what each order can honestly promise.
 *
 * ---------------------------------------------------------------------------
 * THE AXES (person page sorting, 2026-11-11)
 *
 * The founder asked for Popular, Newest, Oldest and Highest rated. Under the shared sort
 * contract (`ui/sort.ts`) a label names an axis and the arrow carries the direction, so
 * Newest and Oldest are the two directions of one axis, **Release date**, exactly as the
 * Collection's own date axes are — one row in the menu, pressed again to flip.
 *
 * - **Popular** is the cache's own order, which is TMDB's popularity ranking as the
 *   adapter stored it. It has no reverse worth offering — "least known first" is not a
 *   question anybody asks a filmography — so it is undirected, like Shuffle.
 * - **Release date** orders by the catalogue row's release date (a series' first air
 *   date, which is all TMDB's person credits carry). Undated credits — announced,
 *   unscheduled — go last in **both** directions, the founder's rule for every date sort.
 * - **Highest rated (TMDB)** orders by TMDB's audience rating, confidence-weighted by the
 *   adapter (`tmdbScore`), with credits under the vote threshold last. It is undirected:
 *   the question is "what is their best-regarded work", and "worst first" over a rating
 *   the reader did not give would be a strange thing to offer. The label says whose
 *   rating it is, because bingd's own scores are the reader's and their friends', and
 *   PRD §22's two-score rule is about those.
 *
 * Every comparator is total: ties fall back to popularity order and then the catalogue
 * id, so a list never reshuffles between renders.
 */
export type FilmographyAxis = 'popular' | 'released' | 'rating';

export type FilmographySort = SortState<FilmographyAxis>;

const POPULAR: SortAxisSpec<FilmographyAxis> = { axis: 'popular', label: 'Popular' };
const RELEASED: SortAxisSpec<FilmographyAxis> = {
  axis: 'released',
  label: 'Release date',
  directions: { desc: 'newest first', asc: 'oldest first' },
  defaultDirection: 'desc',
};
const RATING: SortAxisSpec<FilmographyAxis> = { axis: 'rating', label: 'Highest rated (TMDB)' };

/** Where the page opens: the order the page has always had. */
export const INITIAL_FILMOGRAPHY_SORT: FilmographySort = { axis: 'popular', direction: 'desc' };

/**
 * The axes this list can offer.
 *
 * The rating axis only where at least one credit in view carries a TMDB score. A row
 * cached before scores were stored has none, and a person whose every title is under
 * the vote threshold has none worth ranking — in both cases the order would be Popular
 * under another name, which is a label that lies about the list beneath it.
 */
export function filmographyAxes(
  credits: readonly PersonCredit[],
): SortAxisSpec<FilmographyAxis>[] {
  return credits.some((credit) => credit.score !== null)
    ? [POPULAR, RELEASED, RATING]
    : [POPULAR, RELEASED];
}

const byPopularity = (a: PersonCredit, b: PersonCredit) =>
  a.order - b.order ||
  (a.mediaItemId < b.mediaItemId ? -1 : a.mediaItemId > b.mediaItemId ? 1 : 0);

/** A new array in the chosen order. Never mutates, never drops a credit. */
export function sortFilmography(
  credits: readonly PersonCredit[],
  sort: FilmographySort,
): PersonCredit[] {
  const list = [...credits];
  if (sort.axis === 'released') {
    const sign = sort.direction === 'desc' ? -1 : 1;
    return list.sort((a, b) => {
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
  if (sort.axis === 'rating') {
    return list.sort((a, b) => {
      if (a.score === null || b.score === null) {
        if (a.score !== null) return -1;
        if (b.score !== null) return 1;
        return byPopularity(a, b);
      }
      return b.score - a.score || byPopularity(a, b);
    });
  }
  return list.sort(byPopularity);
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
 *   only credits lost are in the tail the sort puts last — undated, or too few votes — so
 *   the page names that tail rather than "older" or "lower-rated" credits.
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
 * The adapter records, per half and kind, the newest and oldest date and the best score
 * among the credits it **dropped** (`KindCoverage`). A newest-first list is therefore
 * complete for every row dated after the newest dropped credit, and the first row that
 * is not is where the page says so. Popular is the stored order and its limit is the
 * count the page already states ("Showing 60 of 310"), so it is always `complete` here.
 */
export function sortCoverage(
  sorted: readonly PersonCredit[],
  sort: FilmographySort,
  coverage: PersonCoverage | null,
  group: CoverageGroup,
  filter: 'all' | 'movie' | 'series',
): SortCoverage {
  if (sort.axis === 'popular') return { kind: 'complete' };
  if (!coverage) return { kind: 'unknown' };

  const half = coverage[group];
  const lost = filter === 'all' ? combine(half.movie, half.series) : half[filter];

  let vouched: (credit: PersonCredit) => boolean;
  let missing: boolean;
  let rangeLost: boolean;
  if (sort.axis === 'released') {
    if (sort.direction === 'desc') {
      vouched = (credit) =>
        credit.releaseDate
          ? lost.newest === null || credit.releaseDate > lost.newest
          : lost.newest === null && !lost.undated;
    } else {
      vouched = (credit) =>
        credit.releaseDate
          ? lost.oldest === null || credit.releaseDate < lost.oldest
          : lost.oldest === null && !lost.undated;
    }
    // Each direction decides by its own end, so a record that knew one end and not the
    // other could never make the other direction read as complete.
    rangeLost = sort.direction === 'desc' ? lost.newest !== null : lost.oldest !== null;
    missing = rangeLost || lost.undated;
  } else {
    vouched = (credit) =>
      credit.score !== null
        ? lost.rated === null || credit.score > lost.rated
        : lost.rated === null && !lost.unrated;
    rangeLost = lost.rated !== null;
    missing = rangeLost || lost.unrated;
  }

  if (!missing) return { kind: 'complete' };
  const from = sorted.findIndex((credit) => !vouched(credit));
  return { kind: 'partial', from: from === -1 ? sorted.length : from, tailOnly: !rangeLost };
}

/**
 * The index of the first credit in the tail a sort puts last — undated under Release
 * date, too few votes under the rating — or null when there is no such tail. The page
 * labels it, so a list that changes kind of order halfway down says so.
 */
export function tailStart(
  sorted: readonly PersonCredit[],
  sort: FilmographySort,
): number | null {
  if (sort.axis === 'popular') return null;
  const index = sorted.findIndex((credit) =>
    sort.axis === 'released' ? !credit.releaseDate : credit.score === null,
  );
  // A list that is all tail has nothing above it to set the tail apart from.
  return index > 0 ? index : null;
}

/**
 * **The filters a filmography can honestly offer** (FU1113-C): Decade, and only Decade.
 *
 * A credit carries a year and a release date, so the Collection's decade facet applies as
 * it is. It carries no genres and no language — the adapter stores neither on a credit —
 * so Genre and Language are not offered rather than offered empty, and there is no Rating
 * facet because these are not the reader's rankings.
 *
 * The options are the Collection's own (`facetOptions`): chronological, oldest first, each
 * with its count, and only decades this list has something in.
 */
export function filmographyDecades(
  credits: readonly PersonCredit[],
): { value: Decade; count: number }[] {
  return facetOptions(credits.map(asFacetItem)).decades;
}

/** The credits in any of `decades`; every credit when none is chosen. Order is kept. */
export function filterByDecades(
  credits: readonly PersonCredit[],
  decades: readonly Decade[],
): PersonCredit[] {
  if (!decades.length) return [...credits];
  return credits.filter((credit) => {
    const decade = decadeOf(credit.year);
    return decade !== null && decades.includes(decade);
  });
}

/** A credit in the Collection's item shape, carrying only the facts a credit has. */
const asFacetItem = (credit: PersonCredit): CollectionItem => ({
  mediaItemId: credit.mediaItemId,
  title: credit.title,
  seriesTitle: null,
  kind: credit.kind,
  year: credit.year,
  posterPath: credit.posterPath,
  genres: [],
  language: null,
  runtimeMinutes: null,
  score: null,
  bucket: null,
  watchedOn: null,
  addedAt: null,
});
