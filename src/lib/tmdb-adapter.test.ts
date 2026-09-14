import { ANIME_GENRE } from './media-metadata';
import {
  searchCast,
  searchProvider,
  searchProviderWithPeople,
  type AdapterSearchResult,
} from './tmdb-adapter';

/**
 * The provider search boundary, and the one thing it is allowed to change about a row.
 *
 * ---------------------------------------------------------------------------
 * THE PHOTOGRAPH THIS FILE PINS
 *
 * Founder acceptance, 2026-08-30: the title page for an anime film read **Anime**, and
 * the search row that led to it read **Animation**. Both halves of search were looked at
 * and only one was wrong. The local pass reads `media_items` itself and goes through
 * `productGenres`; the provider pass returns the adapter's own rows, whose `genres` are
 * the catalogue column verbatim — and `useTitleSearch` prefers the remote copy for a
 * title present in both lists, because the adapter has just refreshed it. So the moment
 * a search reached TMDB, every row on the screen reverted to raw provider labels.
 *
 * The fix is at this boundary rather than at the screen, so a future caller of
 * `searchProvider` cannot reintroduce it by forgetting. These tests are about *that*
 * property: what comes out of here is normalised, whatever the function was handed.
 */

const mockInvoke = jest.fn();
const mockIn = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => mockInvoke(...args) },
    from: () => ({
      select: () => ({
        in: (...args: unknown[]) => mockIn(...args),
      }),
    }),
  },
  startSessionRefresh: () => () => {},
}));

const ANIME_ROW = {
  id: 'jjk',
  kind: 'series' as const,
  title: 'JUJUTSU KAISEN',
  release_date: '2020-10-03',
  poster_path: '/p.jpg',
  provenance: 'tmdb' as const,
  genres: ['Animation', 'Action & Adventure', 'Sci-Fi & Fantasy'],
  runtime_minutes: null,
};

beforeEach(() => {
  mockInvoke.mockReset();
  mockIn.mockReset();
});

const provide = (results: unknown[]) =>
  mockInvoke.mockResolvedValue({ data: { results }, error: null });

const catalogue = (rows: unknown[]) => mockIn.mockResolvedValue({ data: rows, error: null });

/**
 * The rows, asserted non-empty first.
 *
 * Indexing straight into the result would type every assertion below as possibly
 * undefined, and a test that reads `row?.genres` passes just as happily when there is no
 * row at all — which is the one outcome none of these tests means to allow.
 */
const expectRows = async (pending: Promise<AdapterSearchResult[]>) => {
  const rows = await pending;
  expect(rows.length).toBeGreaterThan(0);
  return rows as [AdapterSearchResult, ...AdapterSearchResult[]];
};

describe('searchProvider normalises the genres it hands back', () => {
  it('says Anime, first, for a title the title page also calls Anime', async () => {
    provide([ANIME_ROW]);
    catalogue([
      { id: 'jjk', kind: 'series', genres: ANIME_ROW.genres, original_language: 'ja' },
    ]);

    const [row] = await expectRows(searchProvider('jujutsu'));

    expect(row.genres[0]).toBe(ANIME_GENRE);
    expect(row.genres).not.toContain('Animation');
    // Everything else survives, in the order the provider published it.
    expect(row.genres).toEqual([ANIME_GENRE, 'Action & Adventure', 'Sci-Fi & Fantasy']);
  });

  it('leaves a non-anime animated title as Animation', async () => {
    // The row that would be swept in by widening the predicate to all Animation.
    provide([{ ...ANIME_ROW, id: 'up', title: 'Up', genres: ['Animation', 'Family'] }]);
    catalogue([
      { id: 'up', kind: 'movie', genres: ['Animation', 'Family'], original_language: 'en' },
    ]);

    const [row] = await expectRows(searchProvider('up'));

    expect(row.genres).toEqual(['Animation', 'Family']);
  });

  it('leaves Japanese live action alone', async () => {
    provide([{ ...ANIME_ROW, id: 'ran', title: 'Ran', genres: ['Drama', 'History'] }]);
    catalogue([
      { id: 'ran', kind: 'movie', genres: ['Drama', 'History'], original_language: 'ja' },
    ]);

    const [row] = await expectRows(searchProvider('ran'));

    expect(row.genres).toEqual(['Drama', 'History']);
  });

  it('hands the rows back untouched when the catalogue read fails', async () => {
    // A search result missing one label is a worse row; a search that fails because a
    // genre could not be decorated is a worse product.
    provide([ANIME_ROW]);
    mockIn.mockResolvedValue({ data: null, error: { message: 'nope' } });

    const [row] = await expectRows(searchProvider('jujutsu'));

    expect(row.genres).toEqual(ANIME_ROW.genres);
  });

  it('leaves a row the catalogue read did not return alone, and normalises the rest', async () => {
    provide([ANIME_ROW, { ...ANIME_ROW, id: 'other', genres: ['Animation'] }]);
    catalogue([
      { id: 'jjk', kind: 'series', genres: ANIME_ROW.genres, original_language: 'ja' },
    ]);

    const [first, second] = await expectRows(searchProvider('jujutsu'));

    expect(first.genres[0]).toBe(ANIME_GENRE);
    expect(second?.genres).toEqual(['Animation']);
  });

  it('spends no round trip on an empty result set', async () => {
    provide([]);

    expect(await searchProvider('zzzz')).toEqual([]);
    expect(mockIn).not.toHaveBeenCalled();
  });
});

/**
 * Cast search's boundary: TMDB's snake_case person into the shape the Cast row draws,
 * through the `search-people` action, with nothing read or written on the way.
 */
describe('searchCast', () => {
  it('asks the adapter for performers and hands back the row shape', async () => {
    mockInvoke.mockResolvedValue({
      data: {
        results: [
          {
            id: 6193,
            name: 'Leonardo DiCaprio',
            profile_path: '/leo.jpg',
            known_for: ['Inception'],
            popularity: 7.8,
          },
          { id: 42, name: 'Leonardo Nam', profile_path: null },
        ],
      },
      error: null,
    });

    const people = await searchCast('leonardo');

    expect(mockInvoke).toHaveBeenCalledWith('tmdb-adapter', {
      body: { action: 'search-people', query: 'leonardo', limit: 20 },
    });
    expect(people).toEqual([
      {
        id: 6193,
        name: 'Leonardo DiCaprio',
        profilePath: '/leo.jpg',
        knownFor: ['Inception'],
        popularity: 7.8,
      },
      { id: 42, name: 'Leonardo Nam', profilePath: null, knownFor: [], popularity: null },
    ]);
    expect(mockIn).not.toHaveBeenCalled();
  });

  it('treats a reply with no results as nobody', async () => {
    mockInvoke.mockResolvedValue({ data: {}, error: null });

    expect(await searchCast('zzzz')).toEqual([]);
  });
});

/**
 * The performers a title search's own provider answer named, for the Cast section under
 * All. No second request: they arrive on the same `search` reply.
 */
describe('searchProviderWithPeople', () => {
  it('hands back the titles and the performers from one search', async () => {
    mockInvoke.mockResolvedValue({
      data: {
        results: [ANIME_ROW],
        people: [
          {
            id: 6193,
            name: 'Leonardo DiCaprio',
            profile_path: '/leo.jpg',
            known_for: ['Titanic'],
            popularity: 7.8,
          },
        ],
      },
      error: null,
    });
    catalogue([]);

    const { titles, people } = await searchProviderWithPeople('leonardo', 20);

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('tmdb-adapter', {
      body: { action: 'search', query: 'leonardo', limit: 20 },
    });
    expect(titles.map((row) => row.id)).toEqual([ANIME_ROW.id]);
    expect(people).toEqual([
      {
        id: 6193,
        name: 'Leonardo DiCaprio',
        profilePath: '/leo.jpg',
        knownFor: ['Titanic'],
        popularity: 7.8,
      },
    ]);
  });

  it('reads an adapter that predates people as a search with none', async () => {
    provide([]);

    expect(await searchProviderWithPeople('zzzz')).toEqual({ titles: [], people: [], page: 1, totalPages: 1 });
  });
});
