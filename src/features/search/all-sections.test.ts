import type { CastSearchResult } from '@/lib/tmdb-adapter';

import { allRows, castMatches, TITLE_LEAD, type AllRow } from './all-sections';
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
  it('leaves a title-only search exactly as it was: one list, no headers', () => {
    const { rows } = allRows({
      query: 'inception',
      titles: manyTitles(8),
      people: [],
      users: [],
    });

    expect(rows.every((row) => row.type === 'title')).toBe(true);
    expect(rows).toHaveLength(8);
  });

  it('never puts a section above the leading titles: an exact actor follows the first titles', () => {
    const { rows } = allRows({
      query: 'leonardo dicaprio',
      titles: [title('d', 'Leonardo DiCaprio: Most Wanted!')],
      people: [leo],
      users: [],
    });

    expect(shape(rows)).toEqual([
      't:Leonardo DiCaprio: Most Wanted!',
      'CAST',
      'c:Leonardo DiCaprio',
    ]);
  });

  it('shows an exact actor at the top when there are no titles at all', () => {
    const { rows } = allRows({
      query: 'zendaya',
      titles: [],
      people: [person(1, 'Zendaya', 11.2)],
      users: [],
    });

    expect(shape(rows)).toEqual(['CAST', 'c:Zendaya']);
  });

  it('puts a partial actor match after the leading titles, and the rest under More titles', () => {
    const { rows } = allRows({
      query: 'emma',
      titles: manyTitles(10, 'Emma'),
      people: [
        person(1, 'Emma Elle Paterson', 1.7),
        person(2, 'Emma Stone', 6.8),
        person(3, 'Emma Watson', 6.4),
      ],
      users: [],
    });

    expect(shape(rows).slice(0, TITLE_LEAD + 4)).toEqual([
      't:Emma 1',
      't:Emma 2',
      't:Emma 3',
      't:Emma 4',
      'CAST',
      'c:Emma Stone',
      'c:Emma Watson',
      'MORE-TITLES',
    ]);
    expect(rows.filter((row) => row.type === 'title')).toHaveLength(10);
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

  it('keeps a title and a performer that share a name in their usual places', () => {
    const { rows } = allRows({
      query: 'madonna',
      titles: [title('m', 'Madonna'), title('b', 'Becoming Madonna')],
      people: [person(1, 'Madonna', 2.7)],
      users: [],
    });

    expect(shape(rows)).toEqual(['t:Madonna', 't:Becoming Madonna', 'CAST', 'c:Madonna']);
  });

  it('omits a weak people match entirely, heading and all', () => {
    const { rows } = allRows({
      query: 'dune',
      titles: manyTitles(6, 'Dune'),
      people: [person(1, 'Aggy Dune', 0.4), person(2, 'Nea Dune', 0.5)],
      users: [user('x', 'deanna', 'Deanna Troi')],
    });

    expect(rows.some((row) => row.type === 'header')).toBe(false);
  });

  it('leads with Users for an @ query, keeps its titles below, and asks nothing of Cast', () => {
    // `@` names an account: Users leads, titles keep their place below it (existing rule:
    // the sigil changes order, never presence), and performers are not what was asked.
    const { rows } = allRows({
      query: '@suraj',
      titles: [title('s', 'Suraj')],
      people: [person(1, 'Suraj Sharma', 3.5)],
      users: [user('u1', 'suraj', 'Suraj Kandukuri')],
    });

    expect(shape(rows)).toEqual(['USERS', 'u:@suraj', 'TITLES', 't:Suraj']);
  });

  it('shows an exact handle or display name as a Users section after the leading titles', () => {
    for (const query of ['Anna Rivers', 'annar', 'ann']) {
      const { rows } = allRows({
        query,
        titles: manyTitles(6),
        people: [],
        users: [user('a', 'annar', 'Anna Rivers')],
      });
      expect(shape(rows).slice(TITLE_LEAD, TITLE_LEAD + 2)).toEqual(['USERS', 'u:@annar']);
    }
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

  it('draws Cast before Users when both match, after the titles', () => {
    const { rows } = allRows({
      query: 'emma',
      titles: manyTitles(5, 'Emma'),
      people: [person(1, 'Emma Stone', 6.8)],
      users: [user('s', 'emmaw', 'Emma W')],
    });

    expect(shape(rows)).toEqual([
      't:Emma 1',
      't:Emma 2',
      't:Emma 3',
      't:Emma 4',
      'CAST',
      'c:Emma Stone',
      'USERS',
      'u:@emmaw',
      'MORE-TITLES',
      't:Emma 5',
    ]);
  });

  it('draws every header at most once, so no two rows share a key', () => {
    const { rows } = allRows({
      query: 'emma',
      titles: manyTitles(9, 'Emma'),
      people: [person(1, 'Emma Stone', 6.8)],
      users: [user('s', 'emmaw', 'Emma W')],
    });
    const headers = rows
      .filter((row) => row.type === 'header')
      .map((row) => (row.type === 'header' ? row.section : ''));

    expect(new Set(headers).size).toBe(headers.length);
  });
});

describe('a page that is still arriving', () => {
  const anna = user('a', 'annar', 'Anna Rivers');

  it('keeps a drawn Users section where it is when provider titles arrive after it', () => {
    // Two local titles, the Users section beneath them; then TMDB adds four more.
    const local = manyTitles(2, 'Local');
    const before = allRows({
      query: 'anna r',
      titles: local,
      people: [],
      users: [anna],
      leadCount: 2,
    });
    const after = allRows({
      query: 'anna r',
      titles: [...local, ...manyTitles(4, 'Remote')],
      people: [],
      users: [anna],
      leadCount: 2,
    });

    const usersHeader = (rows: AllRow[]) =>
      rows.findIndex((row) => row.type === 'header' && row.section === 'users');
    expect(usersHeader(after.rows)).toBe(usersHeader(before.rows));
    expect(shape(after.rows)).toEqual([
      't:Local 1',
      't:Local 2',
      'USERS',
      'u:@annar',
      'MORE-TITLES',
      't:Remote 1',
      't:Remote 2',
      't:Remote 3',
      't:Remote 4',
    ]);
  });

  it('heads the provider titles Titles, not More titles, when no local title led', () => {
    const { rows } = allRows({
      query: 'anna r',
      titles: manyTitles(2, 'Remote'),
      people: [],
      users: [anna],
      leadCount: 0,
    });

    expect(shape(rows)).toEqual(['USERS', 'u:@annar', 'TITLES', 't:Remote 1', 't:Remote 2']);
  });

  it('draws no section before the local titles have answered', () => {
    const { rows, users } = allRows({
      query: 'anna',
      titles: [],
      people: [],
      users: [anna],
      ready: false,
    });

    expect(rows).toEqual([]);
    expect(users).toEqual([]);
  });
});

describe('an exact title and later pages on the All page', () => {
  // Matches "don" by handle, so the Users section really is on the page.
  const donna = user('d', 'donna', 'Donna Noble');
  const usersHeader = (rows: AllRow[]) =>
    rows.findIndex((row) => row.type === 'header' && row.section === 'users');

  it('keeps the sections where they were when an exact provider title takes the top of the lead', () => {
    // Two local prefix titles lead; then the provider's exact "Don" is put first. The lead
    // is still two rows, so the Users section does not move; a local title moves below it.
    const local = [title('darko', 'Donnie Darko'), title('lookup', "Don't Look Up")];
    const before = allRows({
      query: 'don',
      titles: local,
      people: [],
      users: [donna],
      leadCount: 2,
    });
    const after = allRows({
      query: 'don',
      titles: [title('don-2006', 'Don'), ...local, title('don-juan', 'Don Juan')],
      people: [],
      users: [donna],
      leadCount: 2,
    });

    expect(usersHeader(after.rows)).toBe(usersHeader(before.rows));
    expect(shape(after.rows)).toEqual([
      't:Don',
      't:Donnie Darko',
      'USERS',
      'u:@donna',
      'MORE-TITLES',
      "t:Don't Look Up",
      't:Don Juan',
    ]);
  });

  it('keeps the sections where they were as later pages are appended', () => {
    const first = manyTitles(6, 'Don');
    const before = allRows({
      query: 'don',
      titles: first,
      people: [],
      users: [donna],
      leadCount: 3,
    });
    const after = allRows({
      query: 'don',
      titles: [...first, ...manyTitles(20, 'Later')],
      people: [],
      users: [donna],
      leadCount: 3,
    });

    expect(usersHeader(after.rows)).toBe(usersHeader(before.rows));
    expect(after.rows.slice(0, before.rows.length)).toEqual(before.rows);
  });
});
