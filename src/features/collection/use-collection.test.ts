import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

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
