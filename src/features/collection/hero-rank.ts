import { genreRanksFor, MIN_GENRE_SIZE, type RankedRow } from './genre-rank';
import type { RankingCategory } from './use-collection';

export type HeroRankRow = RankedRow & {
  /** ISO 639-1, from `media_items.original_language`. Null for most seeded rows. */
  language?: string | null;
};

export type HeroRank = {
  /** `#3 in Movies`, `#2 in Sci-Fi`, `#1 in Telugu`. */
  label: string;
  /** Which kind of context won, for tests and for reasoning about the choice. */
  basis: 'overall' | 'genre' | 'language';
};

/** How the two ranked lists are named in a sentence. */
const CATEGORY_LABEL: Record<RankingCategory, string> = {
  movies: 'Movies',
  tv_seasons: 'TV seasons',
};

/**
 * Above this, an overall placement is the most interesting thing about the title.
 *
 * "#3 in Movies" is a statement about the whole collection; "#47 in Movies" is a
 * statement about how much the user has ranked. Ten is where one stops being the
 * other, and is the founder's rule rather than a derived number.
 */
const TOP_N = 10;

/**
 * The one rank line the hero shows.
 *
 * A title can be placed several ways at once — overall, within a genre, within a
 * language — and the founder's instruction is that the hero picks exactly one. Three
 * lines of ordinal beside a poster is a statistics readout, not a title page.
 *
 * The order is theirs:
 *
 *   1. **Top ten overall** wins outright. Being third out of everything you have
 *      ranked is the strongest thing that can be said, and it needs no qualifier.
 *   2. Otherwise the **strongest category placement** — the one where the title sits
 *      highest relative to how many titles it is competing with, so #2 of 40 beats
 *      #1 of 6. That comparison is `genreRanksFor`'s own sort, reused here rather
 *      than reimplemented.
 *   3. Otherwise the overall rank anyway. Not a fourth rule so much as the absence of
 *      one: if no genre or language has enough titles to say anything, the overall
 *      position is the only true thing left, and printing nothing would be hiding
 *      real data rather than declining to invent any.
 *
 * Everything here derives from `rankings` rows the client already holds. Nothing is
 * stored, nothing is fetched, and no rank is fabricated — a genre with fewer than
 * `MIN_GENRE_SIZE` titles simply does not compete.
 */
export function heroRankFor(
  mediaItemId: string,
  rows: readonly HeroRankRow[],
  category: RankingCategory,
  languageName: (code: string) => string | null = (code) => code,
): HeroRank | null {
  const subject = rows.find((row) => row.mediaItemId === mediaItemId);
  if (!subject) return null;

  const overall = `#${subject.position} in ${CATEGORY_LABEL[category]}`;
  if (subject.position <= TOP_N) return { label: overall, basis: 'overall' };

  const best = strongestFacet(mediaItemId, rows, languageName);
  if (best) return best;

  return { label: overall, basis: 'overall' };
}

/**
 * The best genre or language placement, whichever is proportionally higher.
 *
 * Language is treated as one more facet rather than as a special case: it is the same
 * question — where does this sit among the titles that share the attribute — and
 * `genreRanksFor` already answers it correctly, including the minimum-size floor that
 * stops "#1 of 2" from being printed.
 */
function strongestFacet(
  mediaItemId: string,
  rows: readonly HeroRankRow[],
  languageName: (code: string) => string | null,
): HeroRank | null {
  const [genre] = genreRanksFor(mediaItemId, rows, 1);

  // The language facet, expressed as a one-genre problem so the existing function
  // does the counting and the minimum-size rule.
  const subject = rows.find((row) => row.mediaItemId === mediaItemId);
  const code = subject?.language ?? null;
  const asLanguage: RankedRow[] = code
    ? rows.map((row) => ({
        mediaItemId: row.mediaItemId,
        position: row.position,
        genres: row.language === code ? [code] : [],
      }))
    : [];
  const [language] = code ? genreRanksFor(mediaItemId, asLanguage, 1) : [];

  const candidates: HeroRank[] = [];
  if (genre) {
    candidates.push({ label: `#${genre.rank} in ${genre.genre}`, basis: 'genre' });
  }
  if (language) {
    const named = languageName(code as string);
    // A code nobody can read — "te" rather than "Telugu" — is worse than no line at
    // all, so an unresolvable language drops out rather than being printed raw.
    if (named && named !== code) {
      candidates.push({ label: `#${language.rank} in ${named}`, basis: 'language' });
    }
  }
  if (!candidates.length) return null;

  // Both were selected as the strongest of their own kind; between them, the higher
  // proportional placement wins, which is the same comparison one level up.
  const strength = (entry: HeroRank) =>
    entry.basis === 'genre' ? genre!.rank / genre!.total : language!.rank / language!.total;

  return candidates.sort((a, b) => strength(a) - strength(b))[0] ?? null;
}

export { MIN_GENRE_SIZE };
