import type { CastSearchResult } from '@/lib/tmdb-adapter';

import type { SearchResult } from './use-title-search';
import { fold, meaningfulMatch, memberQuery, type UserResult } from './use-user-search';

/**
 * What Search shows under **All**: one short section per kind, Movies, TV, Cast and Users,
 * each a preview of its chip (founder, 2026-09-14).
 *
 * **No global score.** A title's place comes from `search_titles` and TMDB's relevance, a
 * performer's from the adapter's Cast ranking (name first, then popularity), an account's
 * from `search_users`. None of the three is calibrated against another, so they are never
 * ranked against each other. Each kind is gated on its own signal, and the page is ordered
 * by kind.
 */

/**
 * How many rows each section shows before its See all.
 *
 * Three, the preview the Cast and Users sections already had: four sections of three rows
 * put the first row of every kind within about two screens, and the See all beside each
 * header is where the whole list is. Titles are previewed like everything else rather than
 * leading at length, because a long title list is exactly what hid the other kinds.
 */
export const SECTION_PREVIEW = 3;

/**
 * The popularity a performer needs to appear under All.
 *
 * TMDB person popularity, measured on staging on 2026-09-13 across 28 queries:
 *
 * - **Performers people search for** are 4 to 16: Tom Hanks 15.8, Zendaya 11.2, Florence
 *   Pugh 8.1, Emma Stone 6.8, Chris Pratt 4.6.
 * - **Namesakes a title search drags in** are 0.2 to 0.9: "Titanic" 0.3 on a search for
 *   the film, "Jason Her" 0.6 on a search for *Her*, five "Dune" surnames under 0.5.
 * - **In between** sit working actors known by one name or an old career: Madonna 2.7,
 *   Cher 1.4, Leo Gordon 1.3.
 *
 * So a query that is somebody's **whole name** needs 1: Cher and Madonna surface, the
 * person literally named "Titanic" does not. A query that only **starts** a name needs
 * 3: "emma" finds Stone, Watson and Myers, and leaves out the ones nobody meant.
 *
 * Popularity is only ever compared with another person's. It is a provider number that
 * moves, so these are floors to revisit, not facts.
 */
export const CAST_MIN_POPULARITY_EXACT = 1;
export const CAST_MIN_POPULARITY_PARTIAL = 3;

/**
 * Words, for matching names: folded, split on spaces and punctuation.
 *
 * An explicit punctuation set rather than a Unicode property class, which not every
 * JavaScript engine this app runs on is guaranteed to support, and which would otherwise
 * be a crash inside a keystroke.
 */
const SEPARATORS = /[\s.,:;!?'"‘’“”()[\]{}\-–—_&/\\|+*#~`^<>=]+/;

const words = (value: string) => fold(value).split(SEPARATORS).filter(Boolean);

/**
 * A title reduced to its words: folded, lowercase, punctuation dropped, words kept apart.
 *
 * The client half of the adapter's `titleKey`, and deliberately no fuzzier: "Don't" is
 * `don t`, not `don`, and "Don 2" is not "Don".
 */
export const titleKey = (value: string) => words(value).join(' ');

/** Letters and digits only: "Nyong'o" and "nyongo", "O'Brien" and "obrien", agree. */
const squashed = (value: string) => words(value).join('');

/** A performer the query names outright, not merely begins. */
function namesExactly(person: CastSearchResult, query: string) {
  const q = squashed(query);
  return q.length > 0 && squashed(person.name) === q;
}

/**
 * Whether a performer is a meaningful match for the query, on the performer's own terms.
 *
 * The query has to be a way of *starting* their name:
 *
 * - **One word** must begin the first word of the name. "leo" and "emma" find Leonardo
 *   DiCaprio and Emma Stone; "stone", "king" and "fox" do not surface Emma Stone, Joey King
 *   or Megan Fox on what is far more often a title search (independent review). A surname
 *   on its own is what the Cast chip is for.
 * - **Several words** must each begin a word of the name, in any order: "leo dicaprio",
 *   "dicaprio leonardo".
 * - **Punctuation typed or not**: the squashed query beginning the squashed name also
 *   counts, so "lupita nyongo" finds Lupita Nyong'o and "conan obrien" finds Conan O'Brien.
 *
 * And the person must clear the popularity floor for how completely the query named them.
 * TMDB's own search matched the rest; this decides whether that match is strong enough to
 * put a stranger's face between a reader and their film.
 */
export function castMatches(person: CastSearchResult, query: string): boolean {
  const typed = words(query);
  if (!typed.length) return false;
  const name = words(person.name);
  if (!name.length) return false;

  const prefixed =
    typed.length === 1
      ? name[0]!.startsWith(typed[0]!)
      : typed.every((word) => name.some((part) => part.startsWith(word)));
  if (!prefixed && !squashed(person.name).startsWith(squashed(query))) return false;

  const popularity = person.popularity ?? 0;
  return namesExactly(person, query)
    ? popularity >= CAST_MIN_POPULARITY_EXACT
    : popularity >= CAST_MIN_POPULARITY_PARTIAL;
}

/** A section under All, named for the chip its See all selects. */
export type AllSection = 'movies' | 'tv' | 'cast' | 'users';

export type AllRow =
  | {
      type: 'header';
      section: AllSection;
      /** The chip holds more than this preview, so the header offers See all. */
      seeAll: boolean;
    }
  | { type: 'title'; result: SearchResult }
  | { type: 'cast'; person: CastSearchResult }
  | { type: 'user'; user: UserResult };

/**
 * The All list, in the order the page draws it.
 *
 * **Movies, TV, Cast, Users**, each under its own header, each cut to `SECTION_PREVIEW`, and
 * a section with nothing in it is not drawn at all. A header offers See all only when its
 * chip would show more than the preview: more rows of that kind than fit, or (for titles)
 * another provider page to read.
 *
 * **An `@` query leads with Users** and has no Cast: `@` is somebody naming an account,
 * and a performer is not what it asks for.
 *
 * **Nothing is inserted above rows already drawn** where that can be avoided (independent
 * review, 2026-09-13). Accounts answer before the local title pass, so until it has
 * answered (`ready`) only title sections are drawn; Cast and Users then arrive below them.
 * A provider title landing later can still lengthen a title preview by up to two rows,
 * which is bounded by the preview itself.
 */
export function allRows({
  query,
  titles,
  people,
  users,
  moreTitles = false,
  ready = true,
}: {
  query: string;
  titles: SearchResult[];
  people: CastSearchResult[];
  users: UserResult[];
  /** The provider has another page of titles, so a title chip holds more than it shows. */
  moreTitles?: boolean;
  /**
   * False until the local title pass has answered. Accounts answer first, and a Users
   * section drawn before the titles would be pushed down when they arrive.
   */
  ready?: boolean;
}): { rows: AllRow[]; cast: CastSearchResult[]; users: UserResult[] } {
  const namesAccount = memberQuery(query).leads;

  const movies = titles.filter((result) => result.kind === 'movie');
  // TV is every title that is not a film: a series, or a season found by name.
  const shows = titles.filter((result) => result.kind !== 'movie');

  // A performer the query names outright comes before the partial matches, whatever order
  // they arrived in, and only then is the preview cut. The adapter already ranks this way;
  // doing it again here keeps an older adapter's answer in the same order.
  const matched = namesAccount
    ? []
    : people
        .filter((person) => castMatches(person, query))
        .map((person, index) => ({ person, index, exact: namesExactly(person, query) }))
        .sort((a, b) => Number(b.exact) - Number(a.exact) || a.index - b.index)
        .map((entry) => entry.person);
  const matchedUsers = users.filter((user) => meaningfulMatch(user, query));

  const cast = ready ? matched.slice(0, SECTION_PREVIEW) : [];
  const shownUsers = ready ? matchedUsers.slice(0, SECTION_PREVIEW) : [];

  const section = <T>(
    name: AllSection,
    shown: T[],
    seeAll: boolean,
    row: (item: T) => AllRow,
  ): AllRow[] =>
    shown.length ? [{ type: 'header', section: name, seeAll }, ...shown.map(row)] : [];

  const movieRows = section(
    'movies',
    movies.slice(0, SECTION_PREVIEW),
    movies.length > SECTION_PREVIEW || moreTitles,
    (result) => ({ type: 'title', result }),
  );
  const tvRows = section(
    'tv',
    shows.slice(0, SECTION_PREVIEW),
    shows.length > SECTION_PREVIEW || moreTitles,
    (result) => ({ type: 'title', result }),
  );
  // The Cast and Users chips list every answer, ungated, so either holds more than its
  // preview whenever the answer had anybody the preview left out.
  const castRows = section('cast', cast, people.length > cast.length, (person) => ({
    type: 'cast',
    person,
  }));
  const userRows = section('users', shownUsers, users.length > shownUsers.length, (user) => ({
    type: 'user',
    user,
  }));

  return {
    rows: namesAccount
      ? [...userRows, ...movieRows, ...tvRows]
      : [...movieRows, ...tvRows, ...castRows, ...userRows],
    cast,
    users: shownUsers,
  };
}
