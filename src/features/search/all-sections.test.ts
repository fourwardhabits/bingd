import type { CastSearchResult } from '@/lib/tmdb-adapter';

import { allRows, castMatches, SECTION_PREVIEW, type AllRow } from './all-sections';
import type { SearchResult } from './use-title-search';
import type { UserResult } from './use-user-search';

const title = (id: string, name: string): SearchResult => ({
  id,
  kind: 'movie',
  title: name,
  release_date: '2010-01-01',
  poster_path: null,
  provenance: 'tmdb',
  genres: [],
  runtime_minutes: null,
});

const person = (id: number, name: string, popularity: number | null): CastSearchResult => ({
  id,
  name,
  profilePath: null,
  knownFor: [],
  popularity,
});

const user = (id: string, username: string, name: string): UserResult => ({
  id,
  username,
  name,
  avatarUri: null,
  visibility: 'public',
});

/** The page as a compact picture: headers in capitals, rows by name. */
const shape = (rows: AllRow[]) =>
  rows.map((row) =>
    row.type === 'header'
      ? row.section.toUpperCase()
      : row.type === 'title'
        ? `t:${row.result.title}`
        : row.type === 'cast'
          ? `c:${row.person.name}`
          : `u:@${row.user.username}`,
  );

const manyTitles = (count: number, prefix = 'Film') =>
  Array.from({ length: count }, (_, index) => title(`t${index}`, `${prefix} ${index + 1}`));

const leo = person(6193, 'Leonardo DiCaprio', 7.8);

describe('the performer gate', () => {
  it('lets a query that is somebody’s whole name through at a low popularity', () => {
    // Cher and Madonna are known by one name and sit near 1.4 and 2.7.
    expect(castMatches(person(1, 'Cher', 1.4), 'cher')).toBe(true);
    expect(castMatches(person(2, 'Madonna', 2.7), 'Madonna')).toBe(true);
  });

  it('keeps the namesake a title search drags in off the page', () => {
    // Measured: searching the film "Titanic" returns a person named Titanic at 0.3.
    expect(castMatches(person(3, 'Titanic', 0.3), 'titanic')).toBe(false);
    expect(castMatches(person(4, 'Jason Her', 0.6), 'her')).toBe(false);
  });

  it('asks more of a partial name', () => {
    expect(castMatches(person(5, 'Emma Stone', 6.8), 'emma')).toBe(true);
    expect(castMatches(person(6, 'Emma Ho', 1.5), 'emma')).toBe(false);
  });

  it('does not surface a famous surname on a one-word search that is usually a title', () => {
    // "stone", "king", "fox": far more often a title search than a hunt for these people.
    expect(castMatches(person(5, 'Emma Stone', 6.8), 'stone')).toBe(false);
    expect(castMatches(person(7, 'Joey King', 6), 'king')).toBe(false);
    expect(castMatches(person(8, 'Megan Fox', 9), 'fox')).toBe(false);
    expect(castMatches(leo, 'dicaprio')).toBe(false);
  });

  it('matches several words from their start, folded, in any order', () => {
    expect(castMatches(leo, 'leo')).toBe(true);
    expect(castMatches(leo, 'leo dicap')).toBe(true);
    expect(castMatches(leo, 'DICAPRIO leonardo')).toBe(true);
    expect(castMatches(person(9, 'Penélope Cruz', 5), 'penelope')).toBe(true);
    // Not the middle of a word.
    expect(castMatches(leo, 'leo caprio')).toBe(false);
    // Every word typed has to be in the name.
    expect(castMatches(leo, 'leonardo pitt')).toBe(false);
  });

  it('matches a name typed without its punctuation', () => {
    expect(castMatches(person(10, "Lupita Nyong'o", 6), 'lupita nyongo')).toBe(true);
    expect(castMatches(person(11, "Conan O'Brien", 4), 'conan obrien')).toBe(true);
    // And treats that as the whole name, for the lower floor.
    expect(castMatches(person(12, "Lupita Nyong'o", 1.2), 'lupita nyongo')).toBe(true);
  });

  it('treats an unknown popularity as weak, not strong', () => {
    expect(castMatches(person(13, 'Leonardo Nam', null), 'leonardo')).toBe(false);
  });
});

describe('the All page', () => {
  it('groups Movies, TV, Cast and Users, in that order, three rows each', () => {
    const { rows } = allRows({
      query: 'emma',
      titles: [
        ...manyTitles(5, 'Emma'),
        ...manyTitles(4, 'Emma Show').map((row) => ({
          ...row,
          id: `s${row.id}`,
          kind: 'series' as const,
        })),
      ],
      people: [
        person(1, 'Emma Stone', 6.8),
        person(2, 'Emma Watson', 6.4),
        person(3, 'Emma Myers', 6.5),
        person(4, 'Emma Thompson', 4),
      ],
      users: [
        user('a', 'emmaw', 'Emma W'),
        user('b', 'emmab', 'Emma B'),
        user('c', 'emmac', 'Emma C'),
        user('d', 'emmad', 'Emma D'),
      ],
    });

    expect(shape(rows)).toEqual([
      'MOVIES',
      't:Emma 1',
      't:Emma 2',
      't:Emma 3',
      'TV',
      't:Emma Show 1',
      't:Emma Show 2',
      't:Emma Show 3',
      'CAST',
      'c:Emma Stone',
      'c:Emma Watson',
      'c:Emma Myers',
      'USERS',
      'u:@emmaw',
      'u:@emmab',
      'u:@emmac',
    ]);
    // No "More titles" any more: the rest of every kind is behind its See all.
    expect(rows.filter((row) => row.type === 'title')).toHaveLength(2 * SECTION_PREVIEW);
  });

  it('puts a season under TV, beside the series', () => {
    const { rows } = allRows({
      query: 'bear',
      titles: [{ ...title('s1', 'The Bear: Season 1'), kind: 'season' }],
      people: [],
      users: [],
    });
    expect(shape(rows)).toEqual(['TV', 't:The Bear: Season 1']);
  });

  it('draws only the sections that have something in them', () => {
    expect(
      shape(allRows({ query: 'inception', titles: manyTitles(2), people: [], users: [] }).rows),
    ).toEqual(['MOVIES', 't:Film 1', 't:Film 2']);
    expect(
      shape(
        allRows({
          query: 'zendaya',
          titles: [],
          people: [person(1, 'Zendaya', 11.2)],
          users: [],
        }).rows,
      ),
    ).toEqual(['CAST', 'c:Zendaya']);
    expect(allRows({ query: 'zzzz', titles: [], people: [], users: [] }).rows).toEqual([]);
  });

  it('offers See all only when the chip it opens holds more than the preview', () => {
    const seeAll = (rows: AllRow[]) =>
      Object.fromEntries(
        rows.flatMap((row) => (row.type === 'header' ? [[row.section, row.seeAll]] : [])),
      );

    // Exactly a preview's worth of everything, and no further page: nothing more to see.
    expect(
      seeAll(
        allRows({
          query: 'emma',
          titles: manyTitles(3, 'Emma'),
          people: [person(1, 'Emma Stone', 6.8)],
          users: [user('a', 'emmaw', 'Emma W')],
        }).rows,
      ),
    ).toEqual({ movies: false, cast: false, users: false });

    // More films than fit; another provider page for TV; a performer and an account the
    // gates left off the preview but the Cast and Users chips would list.
    expect(
      seeAll(
        allRows({
          query: 'emma',
          titles: [...manyTitles(4, 'Emma'), { ...title('s', 'Emma Show'), kind: 'series' }],
          people: [person(1, 'Emma Stone', 6.8), person(2, 'Emma Ho', 1.5)],
          users: [user('a', 'emmaw', 'Emma W'), user('x', 'deanna', 'Deanna Troi')],
          moreTitles: true,
        }).rows,
      ),
    ).toEqual({ movies: true, tv: true, cast: true, users: true });
  });

  it('draws every header at most once, so no two rows share a key', () => {
    const { rows } = allRows({
      query: 'emma',
      titles: manyTitles(9, 'Emma'),
      people: [person(1, 'Emma Stone', 6.8)],
      users: [user('s', 'emmaw', 'Emma W')],
    });
    const headers = rows.flatMap((row) => (row.type === 'header' ? [row.section] : []));
    expect(new Set(headers).size).toBe(headers.length);
  });

  it('shows at most three performers, a whole-name match first', () => {
    const { cast } = allRows({
      query: 'chris pratt',
      titles: [],
      people: [
        person(1, 'Chris Pratt Jr', 7.2),
        person(2, 'Chris Prattley', 4.6),
        person(3, 'Chris Pratt Sr', 5.5),
        person(4, 'Chris Pratt', 4.6),
      ],
      users: [],
    });

    expect(cast.map((entry) => entry.name)).toEqual([
      'Chris Pratt',
      'Chris Pratt Jr',
      'Chris Prattley',
    ]);
  });

  it('keeps the prominent Leo the adapter ranked first, and no weak or wrong-name performer', () => {
    // The adapter's order for "leo" (see normalize.test.ts): DiCaprio from the popular index,
    // then TMDB's Leos by popularity. The All gate still leaves out the ones nobody meant.
    const { cast } = allRows({
      query: 'leo',
      titles: [],
      people: [
        person(6193, 'Leonardo DiCaprio', 8.2),
        person(13, 'Leo Wu', 3.1),
        person(2, 'Leo Woodall', 2.8),
        person(3, 'Melissa Leo', 2.1),
        person(99, 'Cleo Famous', 40),
      ],
      users: [],
    });

    expect(cast.map((entry) => entry.name)).toEqual(['Leonardo DiCaprio', 'Leo Wu']);
  });

  it('omits a weak people match entirely, heading and all', () => {
    const { rows } = allRows({
      query: 'dune',
      titles: manyTitles(6, 'Dune'),
      people: [person(1, 'Aggy Dune', 0.4), person(2, 'Nea Dune', 0.5)],
      users: [user('x', 'deanna', 'Deanna Troi')],
    });

    expect(
      rows
        .filter((row) => row.type === 'header')
        .map((row) => row.type === 'header' && row.section),
    ).toEqual(['movies']);
  });

  it('keeps the account gate: a match in the middle of a handle stays under the Users chip', () => {
    const { rows } = allRows({
      query: 'ann',
      titles: manyTitles(2),
      people: [],
      users: [user('d', 'deanna', 'Deanna Troi')],
    });

    expect(rows.some((row) => row.type === 'user')).toBe(false);
  });

  it('shows an exact handle or display name as a Users section', () => {
    for (const query of ['Anna Rivers', 'annar', 'ann']) {
      const { rows } = allRows({
        query,
        titles: manyTitles(6),
        people: [],
        users: [user('a', 'annar', 'Anna Rivers')],
      });
      expect(shape(rows).slice(-2)).toEqual(['USERS', 'u:@annar']);
    }
  });

  it('leads with Users for an @ query, keeps its titles below, and asks nothing of Cast', () => {
    const { rows } = allRows({
      query: '@suraj',
      titles: [title('s', 'Suraj')],
      people: [person(1, 'Suraj Sharma', 3.5)],
      users: [user('u1', 'suraj', 'Suraj Kandukuri')],
    });

    expect(shape(rows)).toEqual(['USERS', 'u:@suraj', 'MOVIES', 't:Suraj']);
  });
});

describe('a page that is still arriving', () => {
  const anna = user('a', 'annar', 'Anna Rivers');

  it('draws no Cast or Users section before the local titles have answered', () => {
    const { rows, users, cast } = allRows({
      query: 'anna',
      titles: [],
      people: [person(1, 'Anna Kendrick', 5)],
      users: [anna],
      ready: false,
    });

    expect(rows).toEqual([]);
    expect(users).toEqual([]);
    expect(cast).toEqual([]);
  });

  it('adds Cast and Users below the titles once they have answered, never above', () => {
    const titles = manyTitles(2, 'Anna');
    const before = allRows({ query: 'anna', titles, people: [], users: [anna], ready: false });
    const after = allRows({
      query: 'anna',
      titles,
      people: [person(1, 'Anna Kendrick', 5)],
      users: [anna],
    });

    expect(after.rows.slice(0, before.rows.length)).toEqual(before.rows);
    expect(shape(after.rows)).toEqual([
      'MOVIES',
      't:Anna 1',
      't:Anna 2',
      'CAST',
      'c:Anna Kendrick',
      'USERS',
      'u:@annar',
    ]);
  });
});

describe('an exact title and later pages on the All page', () => {
  it('leads the Movies preview with the exact title', () => {
    // useTitleSearch puts an exact "Don" first; the preview keeps that order.
    const { rows } = allRows({
      query: 'don',
      titles: [
        title('don-2006', 'Don'),
        title('darko', 'Donnie Darko'),
        title('lookup', "Don't Look Up"),
        title('don-juan', 'Don Juan'),
      ],
      people: [],
      users: [],
      moreTitles: true,
    });

    expect(shape(rows)).toEqual(['MOVIES', 't:Don', 't:Donnie Darko', "t:Don't Look Up"]);
  });

  it('leaves the page unchanged as later pages are appended: they only feed See all', () => {
    const donna = user('d', 'donna', 'Donna Noble');
    const first = manyTitles(6, 'Don');
    const before = allRows({
      query: 'don',
      titles: first,
      people: [],
      users: [donna],
      moreTitles: true,
    });
    const after = allRows({
      query: 'don',
      titles: [...first, ...manyTitles(20, 'Later')],
      people: [],
      users: [donna],
      moreTitles: true,
    });

    expect(after.rows).toEqual(before.rows);
  });
});
