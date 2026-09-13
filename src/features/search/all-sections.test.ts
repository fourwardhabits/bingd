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

  it('matches words from their start, folded, in any order', () => {
    expect(castMatches(leo, 'leo dicap')).toBe(true);
    expect(castMatches(leo, 'DICAPRIO leonardo')).toBe(true);
    expect(castMatches(person(7, 'Penélope Cruz', 5), 'penelope')).toBe(true);
    // Not the middle of a word.
    expect(castMatches(leo, 'caprio')).toBe(false);
    // Every word typed has to be in the name.
    expect(castMatches(leo, 'leonardo pitt')).toBe(false);
  });

  it('treats an unknown popularity as weak, not strong', () => {
    expect(castMatches(person(8, 'Leonardo Nam', null), 'leonardo')).toBe(false);
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

  it('leads with Cast when the query is a performer’s whole name', () => {
    const { rows } = allRows({
      query: 'leonardo dicaprio',
      titles: [title('d', 'Leonardo DiCaprio: Most Wanted!')],
      people: [leo],
      users: [],
    });

    expect(shape(rows)).toEqual([
      'CAST',
      'c:Leonardo DiCaprio',
      'TITLES',
      't:Leonardo DiCaprio: Most Wanted!',
    ]);
  });

  it('puts a partial actor match after the leading titles, not above them', () => {
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
      'TITLES',
      't:Emma 1',
      't:Emma 2',
      't:Emma 3',
      't:Emma 4',
      'CAST',
      'c:Emma Stone',
      'c:Emma Watson',
    ]);
    expect(shape(rows)[TITLE_LEAD + 4]).toBe('MORE-TITLES');
    expect(rows.filter((row) => row.type === 'title')).toHaveLength(10);
  });

  it('shows at most three performers', () => {
    const { cast } = allRows({
      query: 'chris',
      titles: [],
      people: [
        person(1, 'Chris Hemsworth', 7.2),
        person(2, 'Chris Pratt', 4.6),
        person(3, 'Chris Evans', 5.5),
        person(4, 'Chris Webster', 3.9),
      ],
      users: [],
    });

    expect(cast.map((entry) => entry.name)).toEqual([
      'Chris Hemsworth',
      'Chris Pratt',
      'Chris Evans',
    ]);
  });

  it('keeps the title first when a title and a performer share the exact name', () => {
    // "Madonna" the film and Madonna the performer: the title rule wins, the section follows.
    const { rows } = allRows({
      query: 'madonna',
      titles: [title('m', 'Madonna'), title('b', 'Becoming Madonna')],
      people: [person(1, 'Madonna', 2.7)],
      users: [],
    });

    expect(shape(rows)).toEqual([
      'TITLES',
      't:Madonna',
      't:Becoming Madonna',
      'CAST',
      'c:Madonna',
    ]);
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

  it('leads with Users for an @ query, keeps its titles, and asks nothing of Cast', () => {
    // `@` names an account: Users leads, titles keep their place below (existing rule:
    // the sigil changes order, never presence), and performers are not what was asked.
    const { rows } = allRows({
      query: '@suraj',
      titles: [title('s', 'Suraj')],
      people: [person(1, 'Suraj Sharma', 3.5)],
      users: [user('u1', 'suraj', 'Suraj Kandukuri')],
    });

    expect(shape(rows)).toEqual(['USERS', 'u:@suraj', 'TITLES', 't:Suraj']);
  });

  it('leads with Users when the query is exactly a display name or a handle', () => {
    for (const query of ['Anna Rivers', 'annar']) {
      const { rows } = allRows({
        query,
        titles: manyTitles(6),
        people: [],
        users: [user('a', 'annar', 'Anna Rivers')],
      });
      expect(shape(rows)[0]).toBe('USERS');
    }
  });

  it('shows a partial account match as a section after the leading titles', () => {
    const { rows } = allRows({
      query: 'ann',
      titles: manyTitles(6),
      people: [],
      users: [user('a', 'annar', 'Anna Rivers')],
    });

    expect(shape(rows).slice(TITLE_LEAD + 1, TITLE_LEAD + 3)).toEqual(['USERS', 'u:@annar']);
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
      query: 'stone',
      titles: manyTitles(5, 'Stone'),
      people: [person(1, 'Emma Stone', 6.8)],
      users: [user('s', 'stoner', 'Stone Cold')],
    });

    expect(shape(rows)).toEqual([
      'TITLES',
      't:Stone 1',
      't:Stone 2',
      't:Stone 3',
      't:Stone 4',
      'CAST',
      'c:Emma Stone',
      'USERS',
      'u:@stoner',
      'MORE-TITLES',
      't:Stone 5',
    ]);
  });

  it('needs no Titles heading when nothing but people matched', () => {
    const { rows } = allRows({
      query: 'zendaya',
      titles: [],
      people: [person(1, 'Zendaya', 11.2)],
      users: [],
    });

    expect(shape(rows)).toEqual(['CAST', 'c:Zendaya']);
  });
});
