import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { applyFilters, emptyFilters, facetOptions } from './filters';

import {
  BAND_ORDER,
  useLoggedCollection,
  useRankedCollection,
  useWatchlist,
} from './use-collection';

type Read = {
  table: string;
  columns: string;
  filters: Record<string, unknown>;
  order: { column: string; options?: unknown }[];
};

const reads: Read[] = [];
const rows: Record<string, unknown[]> = {};

/**
 * A recorder standing in for PostgREST. It answers with rows per table and keeps what was
 * asked for, because most of what can go wrong in these hooks is a filter that is missing
 * rather than data that is wrong — an unscoped read looks perfect until there are two
 * accounts.
 */
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const read: Read = { table, columns: '', filters: {}, order: [] };

      const chain = {
        select: (columns: string) => {
          read.columns = columns;
          reads.push(read);
          return chain;
        },
        eq: (column: string, value: unknown) => {
          read.filters[column] = value;
          return chain;
        },
        order: (column: string, options?: unknown) => {
          read.order.push({ column, options });
          return Promise.resolve({ data: rows[table] ?? [], error: null });
        },
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: rows[table] ?? [], error: null }),
      };

      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

const item = (title: string, year: string) => ({
  title,
  release_date: `${year}-01-01`,
  poster_path: `/${title}.jpg`,
  genres: ['Drama'],
  runtime_minutes: 120,
  kind: 'movie',
});

beforeEach(() => {
  reads.length = 0;
  for (const key of Object.keys(rows)) delete rows[key];
});

const readOf = (table: string) => reads.find((read) => read.table === table)!;

describe('the ranked list', () => {
  beforeEach(() => {
    rows.rankings = [
      { media_item_id: 'a', bucket: 'loved', position: 1, category: 'movies', media_items: item('Heat', '1995') },
      { media_item_id: 'b', bucket: 'fine', position: 2, category: 'movies', media_items: item('Drive', '2011') },
    ];
  });

  it('asks only for one account and one category, in position order', async () => {
    const { result } = await renderHookWithProviders(() =>
      useRankedCollection('user-1', 'tv_seasons'),
    );

    await waitFor(() => expect(result.current.data).toHaveLength(2));

    const read = readOf('rankings');
    expect(read.filters).toEqual({ user_id: 'user-1', category: 'tv_seasons' });
    expect(read.order).toEqual([{ column: 'position', options: undefined }]);
  });

  it('keeps the position and the poster the server sent', async () => {
    const { result } = await renderHookWithProviders(() => useRankedCollection('user-1', 'movies'));

    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(result.current.data?.[0]).toEqual({
      mediaItemId: 'a',
      title: 'Heat',
      year: 1995,
      posterPath: '/Heat.jpg',
      genres: ['Drama'],
      runtimeMinutes: 120,
      kind: 'movie',
      // Null for a film, and the parent show's name for a season — a ranked TV
      // list is otherwise a column of rows called "Season 2".
      seriesTitle: null,
      // The show's id, for a season. For You anchors on it, because TMDB publishes
      // recommendations for a series and none for a season.
      seasonNumber: null,
      seriesId: null,
      language: null,
      bucket: 'loved',
      position: 1,
      category: 'movies',
    });
  });

  it('carries the show’s name on a ranked season', async () => {
    rows.rankings = [
      {
        media_item_id: 's2',
        bucket: 'loved',
        position: 1,
        category: 'tv_seasons',
        media_items: {
          title: 'Season 2',
          release_date: '2010-01-01',
          poster_path: null,
          genres: ['Comedy'],
          runtime_minutes: 22,
          kind: 'season',
          parent_id: 'show-1',
          parent: { title: 'Parks and Recreation' },
        },
      },
    ];

    const { result } = await renderHookWithProviders(() =>
      useRankedCollection('user-1', 'tv_seasons'),
    );
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    expect(result.current.data?.[0]?.seriesTitle).toBe('Parks and Recreation');
    // And its id, which is what For You anchors a TV slate on: TMDB publishes
    // recommendations for a series and none for a season.
    expect(result.current.data?.[0]?.seriesId).toBe('show-1');
  });
});

describe('the logged list', () => {
  beforeEach(() => {
    rows.user_media = [
      { media_item_id: 'a', bucket: 'loved', watched_on: null, media_items: item('Heat', '1995') },
      { media_item_id: 'b', bucket: 'fine', watched_on: null, media_items: item('Drive', '2011') },
      { media_item_id: 'c', bucket: null, watched_on: null, media_items: item('Alien', '1979') },
    ];
    rows.rankings = [{ media_item_id: 'a' }];
  });

  it('lists what has no position and counts what has', async () => {
    // The two numbers are the Logged tab's whole header. Swapped, they tell someone with
    // three logged films that they have ranked three of one.
    const { result } = await renderHookWithProviders(() => useLoggedCollection('user-1'));

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.unranked.map((entry) => entry.mediaItemId)).toEqual(['b', 'c']);
    expect(result.current.data?.rankedCount).toBe(1);
    expect(result.current.data?.loggedCount).toBe(3);
  });

  it('scopes both of its reads to the account', async () => {
    const { result } = await renderHookWithProviders(() => useLoggedCollection('user-1'));

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(readOf('user_media').filters).toEqual({ user_id: 'user-1' });
    expect(readOf('rankings').filters).toEqual({ user_id: 'user-1' });
  });

  it('does not ask PostgREST to embed rankings, which it cannot', async () => {
    // There is no foreign key between user_media and rankings, so an embed fails outright.
    const { result } = await renderHookWithProviders(() => useLoggedCollection('user-1'));

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(readOf('user_media').columns).not.toMatch(/rankings/);
  });
});

describe('the watchlist', () => {
  it('reads one account, newest first', async () => {
    rows.watchlist = [{ media_item_id: 'z', media_items: item('Sicario', '2015') }];

    const { result } = await renderHookWithProviders(() => useWatchlist('user-1'));

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(readOf('watchlist').filters).toEqual({ user_id: 'user-1' });
    expect(readOf('watchlist').order).toEqual([
      { column: 'created_at', options: { ascending: false } },
    ]);
    expect(result.current.data?.[0]).toMatchObject({ title: 'Sicario', bucket: null });
  });
});

describe('the bands', () => {
  it('runs from loved to not for me, which is the order the scale is always shown in', () => {
    // Reversed, the collection reads as a ranking of what the user disliked most.
    expect(BAND_ORDER).toEqual(['loved', 'fine', 'not_for_me']);
  });
});

/**
 * **A season is part of its show, and the read is where that becomes true.**
 *
 * `tmdb_upsert_seasons` writes neither `genres` nor `original_language`, and the seeded
 * catalogue has neither on any of its 1,432 seasons — TMDB publishes both on the series.
 * So a season arrived here describing nothing, and every surface downstream that filters
 * or counts by genre was quietly movie-only: the Collection genre filter emptied the TV
 * tab, For You lost its TV anchors the moment a genre was picked, and nine of the twenty
 * awards could not see television at all.
 *
 * The fix is one resolver applied at every mapper in this file (`lib/media-metadata.ts`),
 * so the entries these hooks return already carry the show's metadata. Everything above
 * them — filters, awards, the hero's rank line — inherited the fix without changing.
 */
describe('a season inherits its series metadata', () => {
  const showSeason = (over: Record<string, unknown> = {}) => ({
    title: 'Season 1',
    season_number: 1,
    release_date: '2023-01-15',
    poster_path: '/tlou.jpg',
    // What the catalogue actually stores on a season: nothing descriptive.
    genres: null,
    original_language: null,
    runtime_minutes: null,
    kind: 'season',
    parent_id: 'series-1',
    parent: { title: 'The Last of Us', genres: ['Drama', 'Thriller'], original_language: 'ja' },
    ...over,
  });

  it('asks the parent for the two columns it inherits', async () => {
    rows.rankings = [];
    await renderHookWithProviders(() => useRankedCollection('user-1', 'tv_seasons'));

    // The embed was already being fetched for the show's name; this is two more columns
    // on it rather than another query.
    expect(readOf('rankings').columns).toContain(
      'parent:parent_id(title, genres, original_language)',
    );
  });

  it('gives a ranked season the show’s genres and language', async () => {
    rows.rankings = [
      {
        media_item_id: 's1',
        bucket: 'loved',
        position: 1,
        category: 'tv_seasons',
        media_items: showSeason(),
      },
    ];

    const { result } = await renderHookWithProviders(() =>
      useRankedCollection('user-1', 'tv_seasons'),
    );

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data?.[0]).toMatchObject({
      seriesTitle: 'The Last of Us',
      genres: ['Drama', 'Thriller'],
      language: 'ja',
    });
  });

  it('gives a logged season the same', async () => {
    rows.user_media = [
      { media_item_id: 's1', bucket: null, watched_on: null, media_items: showSeason() },
    ];
    rows.rankings = [];

    const { result } = await renderHookWithProviders(() => useLoggedCollection('user-1'));

    await waitFor(() => expect(result.current.data?.entries).toHaveLength(1));
    expect(result.current.data?.entries[0]).toMatchObject({
      genres: ['Drama', 'Thriller'],
      language: 'ja',
    });
  });

  it('gives a watchlisted season the same', async () => {
    rows.watchlist = [{ media_item_id: 's1', media_items: showSeason() }];

    const { result } = await renderHookWithProviders(() => useWatchlist('user-1'));

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data?.[0]).toMatchObject({
      genres: ['Drama', 'Thriller'],
      language: 'ja',
    });
  });

  it('prefers a season’s own metadata where it genuinely has some', async () => {
    // An anthology season enriched separately is the more specific truth about that
    // season, so own-first rather than parent-first.
    rows.watchlist = [
      {
        media_item_id: 's1',
        media_items: showSeason({ genres: ['Comedy'], original_language: 'fr' }),
      },
    ];

    const { result } = await renderHookWithProviders(() => useWatchlist('user-1'));

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data?.[0]).toMatchObject({ genres: ['Comedy'], language: 'fr' });
  });

  it('does not guess when there is no parent to inherit from', async () => {
    rows.watchlist = [
      { media_item_id: 's1', media_items: showSeason({ parent: null, parent_id: null }) },
    ];

    const { result } = await renderHookWithProviders(() => useWatchlist('user-1'));

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    // Unknown, not inferred from the title and not borrowed from anywhere.
    expect(result.current.data?.[0]).toMatchObject({ genres: [], language: null });
  });

  it('leaves a film reading its own metadata', async () => {
    rows.watchlist = [{ media_item_id: 'z', media_items: item('Sicario', '2015') }];

    const { result } = await renderHookWithProviders(() => useWatchlist('user-1'));

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data?.[0]).toMatchObject({ genres: ['Drama'], language: null });
  });
});

/**
 * The reason the inheritance had to reach the *entry* rather than one screen: the
 * collection filter model reads `genres` and `language` off whatever it is handed, so a
 * season that arrives describing nothing is a season the Genre and Language filters
 * silently drop.
 */
describe('the collection filters see an inherited season', () => {
  const season = {
    mediaItemId: 's1',
    title: 'Season 1',
    seriesTitle: 'The Last of Us',
    seasonNumber: 1,
    kind: 'season' as const,
    year: 2023,
    posterPath: null,
    genres: ['Drama', 'Thriller'],
    language: 'ja',
    runtimeMinutes: null,
    score: null,
    bucket: null,
    watchedOn: null,
  };

  it('keeps it under a genre it inherited', () => {
    expect(applyFilters([season], { ...emptyFilters(), genres: ['Drama'] })).toHaveLength(1);
  });

  it('keeps it under a language it inherited', () => {
    expect(applyFilters([season], { ...emptyFilters(), languages: ['ja'] })).toHaveLength(1);
  });

  it('still drops it from a genre it does not have', () => {
    expect(applyFilters([season], { ...emptyFilters(), genres: ['Comedy'] })).toEqual([]);
  });

  it('lets an animated Japanese season read as anime', () => {
    // The anime facet is Japanese original language *and* an animation genre. Both now
    // reach a season through its show, which is the only way a TV anime could ever
    // satisfy it.
    const anime = { ...season, genres: ['Animation'] };
    expect(applyFilters([anime], { ...emptyFilters(), anime: true })).toHaveLength(1);
    expect(applyFilters([season], { ...emptyFilters(), anime: true })).toEqual([]);
  });

  it('offers the inherited genres as facet options', () => {
    // The filter sheet builds its list from the rows in hand, so a TV collection used
    // to offer no genres at all.
    expect(facetOptions([season]).genres.map((option) => option.value)).toEqual([
      'Drama',
      'Thriller',
    ]);
  });
});
