import { languageName } from '@/lib/language';
import type { SortAxisSpec, SortState } from '@/ui/sort';
import { ANIME_GENRE as PRODUCT_ANIME_GENRE, isAnimeLabels } from '@/lib/media-metadata';

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
  /**
   * When this title entered *this* collection — `user_media.created_at` for a watched
   * row, `watchlist.created_at` for a saved one.
   *
   * **Not the watch date, and the difference is the reason this field exists.** The
   * Recently-added order used to be built on `watchedOn`, which is a *nullable*
   * calendar date the reader may decline to give (`LogSheet`'s "dateless on purpose")
   * and which `watchedItems` could not see for a ranked title at all — so the
   * comparator returned 0 for every pair and the rows kept the score order they
   * arrived in, under a chip that said Recently watched. Membership time is written by
   * the database on every row of both tables and cannot be absent, so the order it
   * expresses is the one the reader is shown.
   */
  addedAt: string | null;
};

export type Decade = '2020s' | '2010s' | '2000s' | '1990s' | 'earlier';

export type CollectionFilters = {
  /**
   * Genre names as the catalogue spells them, plus {@link ANIME_GENRE}.
   *
   * Anime lives in here rather than in a facet of its own since 2026-08-29 — see the
   * constant below for why, and for the one behaviour that changed with it.
   */
  genres: string[];
  languages: string[];
  decades: Decade[];
  buckets: Bucket[];
  /** A TMDB person id. Needs the credits index below to mean anything. */
  personId: string | null;
};

/**
 * Anime, as a genre rather than as a type.
 *
 * ---------------------------------------------------------------------------
 * WHY IT MOVED (founder, 2026-08-29)
 *
 * It was a boolean under a filter-sheet section headed **Type**, which is the word this
 * product uses for the one thing a title *is*: a movie or a TV season. Anime is neither.
 * It is a kind of thing to watch, exactly like Horror or Documentary, and putting it
 * under Type implied a third medium beside Movies and TV that no selector in the app
 * offers and no schema supports — `rankable_category` maps a media kind to `movies` or
 * `tv_seasons` and to nothing else.
 *
 * **Movies and TV remain the only media-type filters.** Anime is a facet *over* them:
 * the medium comes from the tab or the `MediumSelector` outside the sheet, so Movies +
 * Anime is anime films and TV + Anime is anime seasons, with no code here aware of which
 * of the two it is looking at.
 *
 * ---------------------------------------------------------------------------
 * THE ONE BEHAVIOUR THAT CHANGED, AND IT IS THE POINT
 *
 * As a separate facet it was **AND**-ed with the genres — Anime + Comedy meant anime
 * comedies. Inside the Genre facet it is **OR**-ed like every other entry, so Anime +
 * Comedy means anime *or* comedies. One entry in a checkbox group behaving as an
 * intersection while its neighbours behave as a union is a rule nobody can see and
 * nobody would guess. Between-facet AND and within-facet OR is the model the sheet has
 * always documented; this is Anime joining it rather than sitting beside it.
 *
 * **The classification itself is untouched.** {@link isAnime} is the same predicate it
 * was — Japanese original language *and* an animation genre — deliberately not widened
 * to all Animation, which would sweep in every Pixar and Disney film. A synthetic value
 * rather than a real catalogue string, because there is no genre named "Anime" in TMDB's
 * vocabulary (it is "Animation") and inventing one on the rows would be lying to the
 * catalogue rather than filtering it.
 *
 * **Re-exported from `lib/media-metadata` since 2026-08-30**, where the label and the
 * predicate now live so that the title page can agree with this sheet about which
 * titles are anime. The name and the value are unchanged; what changed is that they
 * have one definition instead of one per surface.
 */
export const ANIME_GENRE = PRODUCT_ANIME_GENRE;

/**
 * The axes a collection can be put in order by. Directions live in `CollectionSortState`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE WORDS MEAN, AND WHAT THEY DELIBERATELY DO NOT
 *
 *   · **rating** — the reader's own 0–10 score, derived from band and position.
 *     Called *Rating* rather than "Your score" because the badge on every row is a
 *     rating and the question the reader is asking is how they rated it.
 *   · **added** — {@link CollectionItem.addedAt}, the moment the title entered this
 *     collection. Labelled **Recently added** and never "Recently watched": those are
 *     different facts, one of them is nullable, and conflating them is the defect this
 *     model was rebuilt to end. A title logged today and watched in 2011 is a recent
 *     *addition* and an old *watch*, and the chip must not claim the second.
 *   · **year** — the title's own release year. **Release year**, so no reader has to
 *     work out whether "Newest" is about the film or about their library; the old
 *     labels were a bare *Newest* and *Oldest* sitting one row below a recency axis.
 *   · **title** — alphabetical on the name drawn on the row, so a season files under
 *     its series.
 *   · **shuffle** — the one axis with no order to reverse. Pressing it again reseeds.
 *
 * **There is no watch-date axis.** There was one, it was called Recently watched, and
 * it never worked: see {@link CollectionItem.addedAt}. Ordering a collection by watch
 * date is a real thing to want and it is on the deferred roadmap; what it needs first
 * is a date on every row, which is a product decision about the Log sheet rather than
 * a comparator. Shipping the label without the data is what produced the photograph.
 */
export type SortAxis = 'rating' | 'added' | 'year' | 'title' | 'shuffle';

/**
 * A collection's whole sort, as one value.
 *
 * The axis and the direction travel together because everything that reads one reads
 * the other: the comparator, the chip's arrow, the spoken label and the menu's selected
 * row. Two fields that can disagree is exactly what the old flat `SortKey` union was —
 * `'score-desc' | 'score-asc'` spent two names on one axis, and `'recent'` spent none
 * on a direction it silently fixed.
 */
export type CollectionSortState = SortState<SortAxis>;

/**
 * Every axis, with its label and the direction a fresh choice of it starts in.
 *
 * Rule 2 of `ui/sort.ts`: best first, newest first, A–Z. The words beside each
 * direction are what a screen reader says and what the chip's `accessibilityLabel`
 * carries, so they are the axis's vocabulary rather than decoration — "highest first"
 * for a rating, "newest first" for a date, "A–Z" for a name.
 */
export const COLLECTION_SORT_AXES = {
  rating: {
    axis: 'rating',
    label: 'Rating',
    directions: { desc: 'highest first', asc: 'lowest first' },
    defaultDirection: 'desc',
  },
  added: {
    axis: 'added',
    label: 'Recently added',
    directions: { desc: 'newest first', asc: 'oldest first' },
    defaultDirection: 'desc',
  },
  year: {
    axis: 'year',
    label: 'Release year',
    directions: { desc: 'newest first', asc: 'oldest first' },
    defaultDirection: 'desc',
  },
  title: {
    axis: 'title',
    label: 'Title',
    directions: { desc: 'Z–A', asc: 'A–Z' },
    defaultDirection: 'asc',
  },
  // No `directions`, which is how `ui/sort.ts` knows there is nothing to reverse.
  shuffle: { axis: 'shuffle', label: 'Shuffle' },
} as const satisfies Record<SortAxis, SortAxisSpec<SortAxis>>;

export const emptyFilters = (): CollectionFilters => ({
  genres: [],
  languages: [],
  decades: [],
  buckets: [],
  personId: null,
});

export const isFiltered = (filters: CollectionFilters): boolean =>
  filters.genres.length > 0 ||
  filters.languages.length > 0 ||
  filters.decades.length > 0 ||
  filters.buckets.length > 0 ||
  filters.personId !== null;

/** How many distinct conditions are on, for the badge beside the Filter control. */
export const activeFilterCount = (filters: CollectionFilters): number =>
  (filters.genres.length ? 1 : 0) +
  (filters.languages.length ? 1 : 0) +
  (filters.decades.length ? 1 : 0) +
  (filters.buckets.length ? 1 : 0) +
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
 *
 * **The rule itself now lives in `lib/media-metadata`** ({@link isAnimeLabels}) and
 * this is the thin adapter onto a `CollectionItem`. It moved because the same question
 * is asked by the title page's genre pills, the feed's metadata line and the
 * recommendation lists, and a filter-local predicate could answer for none of them —
 * which is how the app came to call one title Anime on one screen and Animation on
 * another. Nothing about *what it decides* changed.
 */
export function isAnime(item: Pick<CollectionItem, 'language' | 'genres'>): boolean {
  return isAnimeLabels(item.language, item.genres);
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
    // Anime is the one entry in this facet that is a predicate rather than a string —
    // the catalogue has no genre by that name, and `isAnime` is what decides it. Every
    // other entry is an ordinary membership test, and the OR between them is unchanged.
    if (filters.genres.length && !filters.genres.some((genre) => matchesGenre(item, genre))) {
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
 * present. Counts come with them so the reader can see how much is behind each option —
 * they no longer decide the order, which is alphabetical for genres and languages and
 * chronological for decades. See `byLabel` below.
 */
/** One genre entry's test: {@link ANIME_GENRE} is derived, everything else is stored. */
const matchesGenre = (item: Pick<CollectionItem, 'language' | 'genres'>, genre: string): boolean =>
  genre === ANIME_GENRE ? isAnime(item) : item.genres.includes(genre);

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

  /**
   * Anime joins the genres it is now one of, counted by `isAnime` and by nothing else.
   *
   * Set rather than added: a catalogue row carrying a literal "Anime" label would
   * otherwise contribute a count the filter's own predicate does not agree with, and an
   * option whose number does not match what selecting it returns is worse than an option
   * that is missing. TMDB's vocabulary has no such label — it is "Animation" — so this
   * is a guard rather than a case anybody has seen.
   */
  if (anime > 0) genres.set(ANIME_GENRE, anime);
  else genres.delete(ANIME_GENRE);

  /**
   * **Alphabetical by the label the reader sees** (founder, 2026-08-30).
   *
   * It was by count, descending. That is a defensible order for a list somebody is
   * *browsing* and the wrong one for a list somebody is *looking something up in*: the
   * position of Horror moved every time another horror film was logged, so the reader
   * had to re-scan the whole section on every visit to find an option they already knew
   * was there. A stable alphabet is findable, and the count is still printed beside
   * each entry for whoever wanted the popularity signal.
   *
   * Languages sort by `languageName` rather than by the ISO code, because `ja` under
   * J and Japanese under J happen to agree while `el` under E and Greek under G do
   * not, and the reader is looking at the word.
   *
   * Anime takes part like any other entry — it is a genre now — which puts it between
   * Animation and Comedy on a mixed collection.
   */
  const byLabel = <T>(entries: Map<T, number>, label: (value: T) => string) =>
    [...entries]
      .map(([value, count]) => ({ value, count, key: label(value).toLowerCase() }))
      .sort((a, b) => compareLabels(a.key, b.key) || compareLabels(String(a.value), String(b.value)))
      .map(({ value, count }) => ({ value, count }));

  return {
    genres: byLabel(genres, (genre) => genre),
    // `?? code` is the sheet's own fallback for a code the table has no word for, and
    // it is repeated here so the order is over exactly the string that gets drawn — a
    // sort key and a label that can disagree is a list that looks unsorted.
    languages: byLabel(languages, (code) => languageName(code) ?? code),
    // Chronological, oldest first, and always in calendar order rather than by count: a
    // decade list that reorders itself as the collection grows is unreadable. Ascending
    // since 2026-08-30 — the founder reads a decade list as a timeline, and a timeline
    // starts at the beginning.
    decades: DECADE_ORDER.filter((decade) => decades.has(decade)).map((decade) => ({
      value: decade,
      count: decades.get(decade) ?? 0,
    })),
  };
}

/**
 * Ordinary code-point comparison on a lower-cased label, and **not** `localeCompare`.
 *
 * `localeCompare` asks the platform's collator, and this app has three of them: Hermes
 * on the phone, Node's full ICU under Jest, and whatever a browser brings. The same
 * defect `lib/language.ts` was written to close — a rule that passes on Node and
 * behaves differently on the device — applies to an ordering the founder is going to
 * check by eye. Every label in both facets is ASCII English, so the two orders agree
 * anyway; what this buys is that they cannot stop agreeing on somebody's phone.
 *
 * The tie-break on the raw value keeps the sort **total**, so two languages that
 * resolve to the same English name (or an unknown code that resolves to itself) hold a
 * fixed order across renders rather than one the engine's sort stability decides.
 */
const compareLabels = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Oldest to newest. `earlier` is everything before 1990, so it leads. */
const DECADE_ORDER: Decade[] = ['earlier', '1990s', '2000s', '2010s', '2020s'];

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
  sort: CollectionSortState,
  seed = 0,
): CollectionItem[] {
  if (sort.axis === 'shuffle') return shuffle([...items], seed);
  return [...items].sort(compareItems(sort));
}

/**
 * One axis's comparator, **total in every case**, and the totality is the point.
 *
 * A comparator that returns 0 for a pair leaves `Array.prototype.sort` to keep the
 * incoming order, and the incoming order of a watched collection is *score order* —
 * which is how a list under a recency label came to be ordered by rating. Every branch
 * below therefore ends at `byId`, so an order is what its label says it is even when
 * every value it compares is identical or missing.
 *
 * **Missing values sink, in both directions.** An unranked title has no rating and an
 * undated one has no year; putting either at the top of a list claiming to show the
 * highest or the newest would be answering a question with a blank. So the null test
 * comes *before* the direction rather than inside it, which is the rule
 * `RankedTitlesSheet.compareBySort` already states for undated rows.
 */
export function compareItems(sort: CollectionSortState) {
  const flip = sort.direction === 'desc' ? -1 : 1;

  return (a: CollectionItem, b: CollectionItem): number => {
    const byId = a.mediaItemId.localeCompare(b.mediaItemId);

    switch (sort.axis) {
      case 'rating': {
        if (a.score == null && b.score == null) return byId;
        if (a.score == null) return 1;
        if (b.score == null) return -1;
        return (a.score - b.score) * flip || byId;
      }
      case 'added': {
        if (!a.addedAt && !b.addedAt) return byId;
        if (!a.addedAt) return 1;
        if (!b.addedAt) return -1;
        return compareLabels(a.addedAt, b.addedAt) * flip || byId;
      }
      case 'year': {
        if (a.year == null && b.year == null) return byId;
        if (a.year == null) return 1;
        if (b.year == null) return -1;
        return (a.year - b.year) * flip || byId;
      }
      case 'title':
        // Ascending is A–Z, and a forward code-point compare already reads A before Z —
        // so `flip` applies unchanged here exactly as it does to the numeric axes.
        return (
          compareLabels(displayName(a).toLowerCase(), displayName(b).toLowerCase()) * flip ||
          byId
        );
      case 'shuffle':
        return byId;
    }
  };
}

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
 * Which axes make sense for the rows on screen.
 *
 * **Rating is Watched's alone.** Nothing on a watchlist has been ranked and nothing in
 * Unranked has a position, so on either of them a rating order would be sorting by a
 * column that is null on every row — and `compareItems` sinks nulls, so the whole list
 * would sink together and hold whatever order it arrived in. Offering a control that
 * cannot do anything is worse than not offering it; it is also, precisely, how a label
 * comes to disagree with an order.
 *
 * **Recently added is offered everywhere**, because all three lists are backed by a
 * table that stamps `created_at` on insert. That is the difference from the axis it
 * replaced: Recently watched was offered on two of the three and worked on neither.
 *
 * The first entry is also the fallback `coerceSortState` lands on when a reader carries
 * Rating from Watched into their watchlist — Recently added there, Rating on Watched.
 */
export type CollectionSegment = 'watched' | 'watchlist' | 'unranked';

export function sortAxesFor(segment: CollectionSegment): SortAxisSpec<SortAxis>[] {
  const shared: SortAxisSpec<SortAxis>[] = [
    COLLECTION_SORT_AXES.added,
    COLLECTION_SORT_AXES.year,
    COLLECTION_SORT_AXES.title,
    COLLECTION_SORT_AXES.shuffle,
  ];

  if (segment === 'watched') return [COLLECTION_SORT_AXES.rating, ...shared];
  return shared;
}
