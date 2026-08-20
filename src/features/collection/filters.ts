import type { Bucket } from './score';

/**
 * One row of a collection, whichever surface is showing it.
 *
 * Watched, Watchlist, List and Wall all render the same thing with different
 * emphasis, so they filter and sort the same shape. Score and bucket are null on a
 * watchlist row by construction — nothing there has been ranked — which is what lets
 * the filter sheet decide honestly which controls to offer.
 */
export type CollectionItem = {
  mediaItemId: string;
  title: string;
  seriesTitle: string | null;
  /** For a season, so the row can read "The Last of Us, S1" (`lib/titles.ts`). */
  seasonNumber?: number | null;
  kind: 'movie' | 'season' | 'series';
  year: number | null;
  posterPath: string | null;
  genres: string[];
  /** ISO 639-1 from `media_items.original_language`. */
  language: string | null;
  runtimeMinutes: number | null;
  score: number | null;
  bucket: Bucket | null;
  watchedOn: string | null;
};

export type Decade = '2020s' | '2010s' | '2000s' | '1990s' | 'earlier';

export type CollectionFilters = {
  genres: string[];
  languages: string[];
  decades: Decade[];
  buckets: Bucket[];
  /** Anime as a facet over Movies and TV, never a third medium. */
  anime: boolean;
  /** A TMDB person id. Needs the credits index below to mean anything. */
  personId: string | null;
};

export type SortKey =
  | 'score-desc'
  | 'score-asc'
  | 'recent'
  | 'year-desc'
  | 'year-asc'
  | 'az'
  | 'shuffle';

export const emptyFilters = (): CollectionFilters => ({
  genres: [],
  languages: [],
  decades: [],
  buckets: [],
  anime: false,
  personId: null,
});

export const isFiltered = (filters: CollectionFilters): boolean =>
  filters.genres.length > 0 ||
  filters.languages.length > 0 ||
  filters.decades.length > 0 ||
  filters.buckets.length > 0 ||
  filters.anime ||
  filters.personId !== null;

/** How many distinct conditions are on, for the badge beside the Filter control. */
export const activeFilterCount = (filters: CollectionFilters): number =>
  (filters.genres.length ? 1 : 0) +
  (filters.languages.length ? 1 : 0) +
  (filters.decades.length ? 1 : 0) +
  (filters.buckets.length ? 1 : 0) +
  (filters.anime ? 1 : 0) +
  (filters.personId ? 1 : 0);

export function decadeOf(year: number | null): Decade | null {
  if (year == null) return null;
  if (year >= 2020) return '2020s';
  if (year >= 2010) return '2010s';
  if (year >= 2000) return '2000s';
  if (year >= 1990) return '1990s';
  return 'earlier';
}

/**
 * Anime, from the metadata the catalogue actually has.
 *
 * **Japanese original language *and* an animation genre.** That pair is the standard
 * defensible approximation and it is deliberately conservative: each half alone is
 * badly wrong — every Japanese live-action film on one side, every Pixar film on the
 * other — and together they are right about the overwhelming majority of cases.
 *
 * What it gets wrong, stated rather than hidden:
 *
 *   - **misses** anime whose TMDB `original_language` is not `ja` (an international
 *     co-production), and anime TMDB has not tagged with an animation genre;
 *   - **over-includes** Japanese animation that few people would call anime — a
 *     children's short, an animated documentary;
 *   - **says nothing** about the 43-odd Wikidata-seeded rows, whose genre vocabulary
 *     is Wikidata's ("animated film") rather than TMDB's. The `/anim/i` test covers
 *     both spellings, which is why it is a pattern and not an equality check.
 *
 * The robust signal is TMDB's own `anime` keyword (210024), which is definitive and
 * which this app does not cache — `media_cache` holds credits and videos, not
 * keywords. Adding it is a facet fetch and a schema constraint change, which is
 * backend work this pass is not doing. Recorded as the upgrade path rather than
 * approximated harder.
 */
export function isAnime(item: Pick<CollectionItem, 'language' | 'genres'>): boolean {
  if (item.language !== 'ja') return false;
  return item.genres.some((genre) => /anim/i.test(genre));
}

/**
 * A cast index: media item id → the TMDB person ids credited on it.
 *
 * Supplied by the caller rather than fetched here, because the filter model stays
 * pure and because only the person filter needs it — building it costs one query
 * over `media_cache`, and a collection nobody is filtering by actor should not pay
 * for it.
 */
export type CastIndex = ReadonlyMap<string, ReadonlySet<string>>;

export function applyFilters(
  items: readonly CollectionItem[],
  filters: CollectionFilters,
  cast?: CastIndex,
): CollectionItem[] {
  return items.filter((item) => {
    // Within a facet the conditions are OR — picking Comedy and Horror means
    // either — and between facets they are AND. That is what people expect from
    // checkbox groups, and the opposite of both is unusable.
    if (filters.genres.length && !filters.genres.some((genre) => item.genres.includes(genre))) {
      return false;
    }
    if (filters.languages.length && !(item.language && filters.languages.includes(item.language))) {
      return false;
    }
    if (filters.decades.length) {
      const decade = decadeOf(item.year);
      if (!decade || !filters.decades.includes(decade)) return false;
    }
    if (filters.buckets.length && !(item.bucket && filters.buckets.includes(item.bucket))) {
      return false;
    }
    if (filters.anime && !isAnime(item)) return false;
    if (filters.personId) {
      // A title whose credits have never been cached is absent rather than
      // present: claiming an actor is *not* in a film we have never looked up
      // would be inventing an answer.
      const people = cast?.get(item.mediaItemId);
      if (!people || !people.has(filters.personId)) return false;
    }
    return true;
  });
}

/**
 * Which options are worth offering, derived from the rows in hand.
 *
 * A filter sheet listing every genre TMDB knows about, most of them matching nothing
 * in this collection, is a worse control than one listing the eleven genres actually
 * present. Counts come with them so the most useful options can sort first.
 */
export function facetOptions(items: readonly CollectionItem[]) {
  const genres = new Map<string, number>();
  const languages = new Map<string, number>();
  const decades = new Map<Decade, number>();
  let anime = 0;

  for (const item of items) {
    for (const genre of item.genres) genres.set(genre, (genres.get(genre) ?? 0) + 1);
    if (item.language) languages.set(item.language, (languages.get(item.language) ?? 0) + 1);
    const decade = decadeOf(item.year);
    if (decade) decades.set(decade, (decades.get(decade) ?? 0) + 1);
    if (isAnime(item)) anime += 1;
  }

  const byCount = <T>(entries: Map<T, number>) =>
    [...entries].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));

  return {
    genres: byCount(genres),
    languages: byCount(languages),
    // Newest first, and always in calendar order rather than by count: a decade
    // list that reorders itself as the collection grows is unreadable.
    decades: DECADE_ORDER.filter((decade) => decades.has(decade)).map((decade) => ({
      value: decade,
      count: decades.get(decade) ?? 0,
    })),
    anime,
  };
}

const DECADE_ORDER: Decade[] = ['2020s', '2010s', '2000s', '1990s', 'earlier'];

/**
 * Sort, with shuffle as one of the orders rather than a separate mode.
 *
 * `seed` makes the shuffle *stable*: the same seed over the same titles gives the
 * same order, so scrolling, refetching and re-rendering do not reshuffle the wall
 * under the reader's thumb. Pressing Shuffle changes the seed, which is the only
 * thing that reorders it. Nothing is stored — the seed is a number in component
 * state, and a shuffled order is not worth a table.
 */
export function sortItems(
  items: readonly CollectionItem[],
  sort: SortKey,
  seed = 0,
): CollectionItem[] {
  const rows = [...items];

  switch (sort) {
    case 'score-desc':
      return rows.sort(byScore(-1));
    case 'score-asc':
      return rows.sort(byScore(1));
    case 'recent':
      // Undated rows last: a watch date is what this order is about, and a title
      // without one has no place in it.
      return rows.sort((a, b) => (b.watchedOn ?? '').localeCompare(a.watchedOn ?? ''));
    case 'year-desc':
      return rows.sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity));
    case 'year-asc':
      return rows.sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity));
    case 'az':
      return rows.sort((a, b) => displayName(a).localeCompare(displayName(b)));
    case 'shuffle':
      return shuffle(rows, seed);
  }
}

/** Unranked titles sink in both score orders — they have no score to compare. */
const byScore =
  (direction: 1 | -1) =>
  (a: CollectionItem, b: CollectionItem) => {
    if (a.score == null && b.score == null) return 0;
    if (a.score == null) return 1;
    if (b.score == null) return -1;
    return (a.score - b.score) * direction;
  };

/** A–Z on what the reader sees, so a season sorts under its show. */
const displayName = (item: CollectionItem) =>
  item.seriesTitle ? `${item.seriesTitle} ${item.title}` : item.title;

/**
 * Fisher–Yates over a seeded generator.
 *
 * `Math.random` would reshuffle on every render, which is the defect the brief names
 * outright. Mulberry32 is four lines, has no dependency, and is deterministic in the
 * seed — which is the whole requirement.
 */
export function shuffle<T>(rows: readonly T[], seed: number): T[] {
  const out = [...rows];
  const random = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Which sorts make sense for the rows on screen.
 *
 * A watchlist holds nothing the user has ranked or watched, so "Your score" and
 * "Recently watched" would order it by fields that are null on every row. Unranked
 * has watch dates but no scores, so it keeps one and loses the other. Offering a
 * control that cannot do anything is worse than not offering it.
 */
export type CollectionSegment = 'watched' | 'watchlist' | 'unranked';

export function sortOptionsFor(segment: CollectionSegment): { key: SortKey; label: string }[] {
  const shared: { key: SortKey; label: string }[] = [
    { key: 'year-desc', label: 'Newest' },
    { key: 'year-asc', label: 'Oldest' },
    { key: 'az', label: 'A–Z' },
    { key: 'shuffle', label: 'Shuffle' },
  ];

  // Nothing on a watchlist has been watched or ranked; nothing in Unranked has a
  // score. Both would be ordering by a column that is null on every row.
  if (segment === 'watchlist') return shared;
  if (segment === 'unranked') return [{ key: 'recent', label: 'Recently watched' }, ...shared];

  return [
    { key: 'score-desc', label: 'Your score: high' },
    { key: 'score-asc', label: 'Your score: low' },
    { key: 'recent', label: 'Recently watched' },
    ...shared,
  ];
}
