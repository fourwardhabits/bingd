import type { CastSearchResult } from '@/lib/tmdb-adapter';

import type { SearchResult } from './use-title-search';
import { fold, meaningfulMatch, memberQuery, type UserResult } from './use-user-search';

/**
 * What Search shows under **All**: titles, and the performers and accounts a query plainly
 * means, as explicit sections (founder, 2026-09-13).
 *
 * **No global score.** A title's place comes from `search_titles` and TMDB's relevance, a
 * performer's from TMDB's person popularity, an account's from `search_users`. None of the
 * three is calibrated against another, so they are never ranked against each other. Each
 * type is gated on its own signal, and the page is ordered by type.
 */

/** How many performers and accounts a section shows before its See all. */
export const SECTION_PREVIEW = 3;

/**
 * How many titles lead the page before the Cast and Users sections.
 *
 * Titles come first and stay dominant, but an ordinary search returns twenty to forty of
 * them, and a section placed after all of those is a section nobody scrolls to, which is
 * the discovery failure the sections exist to fix. Four title rows fill most of a phone
 * screen below the field and chips, so the first section header sits at or near the fold,
 * and the rest of the titles continue under "More titles".
 *
 * **Never above them** (independent review, 2026-09-13). The performers arrive with the
 * provider answer, a second or so after the local titles are drawn, and a section inserted
 * above rows already on screen moves them under a reader's thumb as they reach for `+`. So a
 * section only ever goes in *below* the leading titles, where the rows that move are ones
 * nobody was about to tap. For a whole-name query like "leonardo dicaprio" the titles are
 * few, so the Cast section is still on the first screen.
 */
export const TITLE_LEAD = 4;

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

export type AllSection = 'cast' | 'users';

export type AllRow =
  | { type: 'header'; section: 'titles' | 'more-titles' | AllSection }
  | { type: 'title'; result: SearchResult }
  | { type: 'cast'; person: CastSearchResult }
  | { type: 'user'; user: UserResult };

/**
 * The All list, in the order the page draws it.
 *
 * 1. **An `@` query leads with Users**, under a Users header, with the titles after it
 *    under a Titles header. `@` is somebody naming an account; accounts answer before any
 *    title search does, so this section is drawn first rather than inserted above titles,
 *    and a title beginning with `@` is rare enough that the titles below it are almost
 *    always none.
 * 2. Otherwise **titles first**, unheaded, as they always were.
 * 3. After the first `TITLE_LEAD` titles, **Cast** then **Users**, up to three each, each
 *    under its own header.
 * 4. **More titles**, the rest, under a divider header.
 *
 * With no section, a title search is exactly what it was: one unheaded list.
 */
export function allRows({
  query,
  titles,
  people,
  users,
}: {
  query: string;
  titles: SearchResult[];
  people: CastSearchResult[];
  users: UserResult[];
}): { rows: AllRow[]; cast: CastSearchResult[]; users: UserResult[] } {
  const namesAccount = memberQuery(query).leads;

  // An `@` query names an account. Performers are not what it is asking for, and the Cast
  // chip is one tap away if it was. Otherwise a performer the query names outright comes
  // before the partial matches, whatever TMDB's order, and only then is the preview cut.
  const cast = namesAccount
    ? []
    : people
        .filter((person) => castMatches(person, query))
        .map((person, index) => ({ person, index, exact: namesExactly(person, query) }))
        .sort((a, b) => Number(b.exact) - Number(a.exact) || a.index - b.index)
        .map((entry) => entry.person)
        .slice(0, SECTION_PREVIEW);
  const shownUsers = users
    .filter((user) => meaningfulMatch(user, query))
    .slice(0, SECTION_PREVIEW);

  const castRows: AllRow[] = cast.length
    ? [
        { type: 'header', section: 'cast' },
        ...cast.map((person) => ({ type: 'cast' as const, person })),
      ]
    : [];
  const userRows: AllRow[] = shownUsers.length
    ? [
        { type: 'header', section: 'users' },
        ...shownUsers.map((user) => ({ type: 'user' as const, user })),
      ]
    : [];
  const titleRows: AllRow[] = titles.map((result) => ({ type: 'title' as const, result }));

  if (namesAccount && userRows.length) {
    return {
      rows: [
        ...userRows,
        ...(titleRows.length ? [{ type: 'header' as const, section: 'titles' as const }] : []),
        ...titleRows,
      ],
      cast,
      users: shownUsers,
    };
  }

  const sections = [...castRows, ...userRows];
  if (!sections.length) return { rows: titleRows, cast, users: shownUsers };

  const rest = titleRows.slice(TITLE_LEAD);
  return {
    rows: [
      ...titleRows.slice(0, TITLE_LEAD),
      ...sections,
      ...(rest.length
        ? [{ type: 'header' as const, section: 'more-titles' as const }, ...rest]
        : []),
    ],
    cast,
    users: shownUsers,
  };
}
