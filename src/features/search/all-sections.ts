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
const words = (value: string) =>
  fold(value)
    .split(/[\s.,:;!?'"‘’“”()[\]{}\-–—_&/\\|+*#~`^<>=]+/)
    .filter(Boolean);

const phrase = (value: string) => words(value).join(' ');

/** A performer the query names outright, not merely begins. */
function namesExactly(person: CastSearchResult, query: string) {
  const q = phrase(query);
  return q.length > 0 && phrase(person.name) === q;
}

/**
 * Whether a performer is a meaningful match for the query, on the performer's own terms.
 *
 * Every word typed must begin a word of the name ("dicap" is not a word of "Leonardo
 * DiCaprio", but "leo dicaprio" is two), and the person must clear the popularity floor for
 * how completely the query named them. TMDB's own search matched the rest; this decides
 * whether that match is strong enough to put a stranger's face between a reader and their
 * film.
 */
export function castMatches(person: CastSearchResult, query: string): boolean {
  const typed = words(query);
  if (!typed.length) return false;
  const name = words(person.name);
  if (!typed.every((word) => name.some((part) => part.startsWith(word)))) return false;

  const popularity = person.popularity ?? 0;
  return namesExactly(person, query)
    ? popularity >= CAST_MIN_POPULARITY_EXACT
    : popularity >= CAST_MIN_POPULARITY_PARTIAL;
}

/** An account the query names outright: `@handle`, the handle, or the display name. */
function userNamedExactly(user: UserResult, query: string) {
  const { text, leads } = memberQuery(query);
  const q = fold(text).trim();
  if (!q) return false;
  return (
    (leads && fold(user.username) === q) || fold(user.username) === q || fold(user.name) === q
  );
}

/** A title whose name is exactly what was typed. The existing product rule favours it. */
function titleNamedExactly(titles: SearchResult[], query: string) {
  const q = phrase(query);
  return q.length > 0 && titles.some((title) => phrase(title.title) === q);
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
 * 1. **A section the query explicitly asks for leads**: an `@` query leads with Users, and
 *    a query that is exactly a performer's or an account's name leads with that section,
 *    unless a title is also named exactly, in which case the title wins, as it always has.
 * 2. **Titles**, the first `TITLE_LEAD` of them.
 * 3. **Cast**, then **Users**, whichever did not lead, up to three each.
 * 4. **More titles**, the rest.
 *
 * With neither section, a title search is exactly what it was: one unheaded list.
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
  // An `@` query names an account. Performers are not what it is asking for, and the Cast
  // chip is one tap away if it was.
  const cast = memberQuery(query).leads
    ? []
    : people.filter((person) => castMatches(person, query)).slice(0, SECTION_PREVIEW);
  const shownUsers = users
    .filter((user) => meaningfulMatch(user, query))
    .slice(0, SECTION_PREVIEW);

  const titleWins = titleNamedExactly(titles, query);
  const leads = new Set<AllSection>();
  if (cast.length && !titleWins && cast.some((person) => namesExactly(person, query))) {
    leads.add('cast');
  }
  if (
    shownUsers.length &&
    (memberQuery(query).leads ||
      (!titleWins && shownUsers.some((user) => userNamedExactly(user, query))))
  ) {
    leads.add('users');
  }

  const sectionRows = (section: AllSection): AllRow[] => {
    if (section === 'cast') {
      return cast.length
        ? [
            { type: 'header', section },
            ...cast.map((person) => ({ type: 'cast' as const, person })),
          ]
        : [];
    }
    return shownUsers.length
      ? [
          { type: 'header', section },
          ...shownUsers.map((user) => ({ type: 'user' as const, user })),
        ]
      : [];
  };

  // `@` names an account, so Users leads Cast; otherwise Cast, then Users.
  const order: AllSection[] = memberQuery(query).leads ? ['users', 'cast'] : ['cast', 'users'];
  const leading = order.filter((section) => leads.has(section)).flatMap(sectionRows);
  const trailing = order.filter((section) => !leads.has(section)).flatMap(sectionRows);

  const titleRows = titles.map((result) => ({ type: 'title' as const, result }));

  if (!leading.length && !trailing.length) {
    return { rows: titleRows, cast, users: shownUsers };
  }

  const titlesHeader: AllRow[] = titleRows.length
    ? [{ type: 'header', section: 'titles' }]
    : [];
  if (!trailing.length) {
    return { rows: [...leading, ...titlesHeader, ...titleRows], cast, users: shownUsers };
  }

  const lead = titleRows.slice(0, TITLE_LEAD);
  const rest = titleRows.slice(TITLE_LEAD);
  return {
    rows: [
      ...leading,
      ...titlesHeader,
      ...lead,
      ...trailing,
      ...(rest.length
        ? [{ type: 'header' as const, section: 'more-titles' as const }, ...rest]
        : []),
    ],
    cast,
    users: shownUsers,
  };
}
