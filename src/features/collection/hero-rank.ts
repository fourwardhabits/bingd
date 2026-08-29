import { genreRanksFor, MIN_GENRE_SIZE, type RankedRow } from './genre-rank';
import type { RankingCategory } from './use-collection';

/**
 * The hero consults the overall ranking and the genre ranking, and nothing else.
 *
 * It used to carry `language` as well. See `heroRankFor` — the founder's 2026-08-28
 * device finding was a hero reading "#17 in English", and language is gone from this
 * label entirely rather than merely deprioritised.
 */
export type HeroRankRow = RankedRow;

export type HeroRank = {
  /** `#3 in Movies`, `#2 in Sci-Fi`. */
  label: string;
  /** Which kind of context won, for tests and for reasoning about the choice. */
  basis: 'overall' | 'genre';
};

/** How the two ranked lists are named in a sentence. "TV" is the visible category
 *  everywhere; the ranked objects behind `#2 in TV` are still individual seasons. */
const CATEGORY_LABEL: Record<RankingCategory, string> = {
  movies: 'Movies',
  tv_seasons: 'TV',
};

/**
 * Above this, a placement stops being a statement about the title.
 *
 * "#3 in Movies" says something about the film; "#47 in Movies" says something about
 * how much the reader has ranked. Ten is where one stops being the other, and it is
 * the founder's number rather than a derived one. It now governs the genre line too.
 */
const TOP_N = 10;

/**
 * The one rank line the hero shows, or none at all.
 *
 * ---------------------------------------------------------------------------
 * What this replaced, and why
 * ---------------------------------------------------------------------------
 *
 * The founder's device showed **`#17 in English`**, and it was two mistakes in one
 * line. Language was competing as a facet — "where does this sit among the titles that
 * share the attribute" — which is a true sentence and a useless one: the reader's own
 * language is the attribute almost every title they rank will share, so the line was a
 * restatement of the overall ranking wearing a different noun. And the old third rule
 * printed the overall position *anyway* when nothing else qualified, on the reasoning
 * that hiding a real number was worse than showing it. That is what put a 17 on a
 * hero. Seventeenth out of everything is not an accolade, and a page that reports it
 * beside the score is reporting how much the reader has used the app.
 *
 * ---------------------------------------------------------------------------
 * The rule now (founder, 2026-08-28)
 * ---------------------------------------------------------------------------
 *
 * **At most one label, and only for a top-ten placement.**
 *
 *   1. **Top ten overall** — `#4 in Movies`, `#2 in TV`. Movies and TV are separate
 *      rankings and stay separate; the category is the caller's, from the ranking the
 *      title actually sits in.
 *   2. Otherwise the **best top-ten genre** — `#3 in Drama`.
 *   3. Otherwise **nothing**, and `PersonalState` draws no row for a null ordinal, so
 *      there is no reserved gap either.
 *
 * **Overall always beats genre, even when the genre number is better.** `#4 in Movies`
 * wins over `#1 in Drama`, because the two are not comparable claims: one is about the
 * whole collection and the other is about a slice the reader did not choose. A rule
 * that picked the smaller number would show the narrower fact exactly when the broader
 * one was strongest.
 *
 * **Between genres the plain ordinal decides**, not the proportional strength
 * `genreRanksFor` sorts by. Once the field is "top ten in this genre", #2 is simply
 * better than #3, and the denominator is not on the page for the reader to weigh.
 * `MIN_GENRE_SIZE` still applies underneath, so `#1 of 2 Westerns` never reaches here.
 *
 * Ties break on the genre name, ascending. That is the order `CANONICAL_GENRES`
 * (`features/awards/genres.ts`) is already written in, and it is compared here rather
 * than imported so that a label outside that list — the catalogue holds raw TMDB names
 * — orders by the same rule as one inside it. What matters is that the answer cannot
 * change between two renders of the same data, which is what the founder asked for and
 * what an unspecified tie would not give.
 *
 * Everything here derives from `rankings` rows the client already holds. Nothing is
 * stored, nothing is fetched, and no rank is fabricated.
 */
export function heroRankFor(
  mediaItemId: string,
  rows: readonly HeroRankRow[],
  category: RankingCategory,
): HeroRank | null {
  const subject = rows.find((row) => row.mediaItemId === mediaItemId);
  if (!subject) return null;

  if (subject.position <= TOP_N) {
    return { label: `#${subject.position} in ${CATEGORY_LABEL[category]}`, basis: 'overall' };
  }

  // Every genre this title places in, not the two the reveal shows: the best of them is
  // being chosen here by a different measure, so the shortlist has to be complete before
  // it is sorted. `genreRanksFor` still applies the minimum-size floor.
  const qualifying = genreRanksFor(mediaItemId, rows, Number.MAX_SAFE_INTEGER).filter(
    (entry) => entry.rank <= TOP_N,
  );
  if (!qualifying.length) return null;

  const best = [...qualifying].sort((a, b) => a.rank - b.rank || a.genre.localeCompare(b.genre))[0];
  // Unreachable — `qualifying` was just checked non-empty — and stated rather than
  // asserted away, because the alternative is a non-null assertion on a list whose
  // emptiness is the one thing this function is deciding.
  if (!best) return null;

  return { label: `#${best.rank} in ${best.genre}`, basis: 'genre' };
}

export { MIN_GENRE_SIZE };
