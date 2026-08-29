import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { applyFilters, emptyFilters, facetOptions } from './filters';

import {
  BAND_ORDER,
  useLoggedCollection,
  useRankedCollection,
  useWatchlist,
} from './use-collection';

/**
 * A PostgREST that applies what the reads say (`test-utils/postgrest.ts`).
 *
 * It used to be a recorder that returned the seeded array whatever was asked of it, which
 * was enough while the question was "is this read scoped to one account". It is not enough
 * any more: these hooks page to exhaustion by keyset, and a stand-in that ignores `gt` and
 * `limit` makes a paging loop look correct while proving nothing about it — and would hide
 * the opposite failure, a loop that never ends because every page comes back full.
 */
jest.mock('@/lib/supabase', () => {
  // A `jest.mock` factory runs before this module's imports, so an `import` here would
  // be undefined.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createPostgrest } = require('@/test-utils/postgrest');
  const client = createPostgrest();
  (globalThis as { __pg?: unknown }).__pg = client;
  return { supabase: { from: client.from }, startSessionRefresh: () => () => {} };
});

const pg = () =>
  (globalThis as unknown as { __pg: import('@/test-utils/postgrest').Postgrest }).__pg;

const reads = () => pg().reads;
const rows = pg().tables;

const OWNER = 'user-1';

/**
 * The columns each read filters on, stamped onto whatever a test seeds.
 *
 * Not what any test below is about, and not skippable either: a stand-in that ignored
 * `eq(user_id)` would answer a scoped read and an unscoped one identically.
 */
const seed = (table: string, list: unknown[]) => {
  rows[table] = list.map((row, i) => ({
    user_id: OWNER,
    created_at: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
    ...(row as object),
  }));
};

const item = (title: string, year: string) => ({
  title,
  release_date: `${year}-01-01`,
  poster_path: `/${title}.jpg`,
  genres: ['Drama'],
  runtime_minutes: 120,
  kind: 'movie',
});

beforeEach(() => {
  reads().length = 0;
  pg().between = () => {};
  for (const key of Object.keys(pg().requests)) delete pg().requests[key];
  for (const key of Object.keys(rows)) delete rows[key];
});

const readOf = (table: string) => reads().find((read) => read.table === table)!;

describe('the ranked list', () => {
  beforeEach(() => {
    seed('rankings', [
      { media_item_id: 'a', bucket: 'loved', position: 1, category: 'movies', media_items: item('Heat', '1995') },
      { media_item_id: 'b', bucket: 'fine', position: 2, category: 'movies', media_items: item('Drive', '2011') },
    ]);
  });

  it('asks only for one account and one category, ordered by the key it pages on', async () => {
    const { result } = await renderHookWithProviders(() =>
      useRankedCollection('user-1', 'movies'),
    );

    await waitFor(() => expect(result.current.data).toHaveLength(2));

    const read = readOf('rankings');
    expect(read.filters).toEqual({ user_id: 'user-1', category: 'movies' });
    // **Not `position`**, though that is unique per category and is the order the list is
    // shown in. Inserting a ranking shifts every position below it, so a cursor on
    // `position` can be moved out from under a read by a concurrent ranking session —
    // the defect keyset paging exists to remove, one level down. `media_item_id` never
    // changes; the position order is applied in JS below.
    expect(read.order).toEqual([{ column: 'media_item_id', ascending: true }]);
  });

  it('returns them in position order all the same', async () => {
    seed('rankings', [
      { media_item_id: 'z', bucket: 'loved', position: 1, category: 'movies', media_items: item('Heat', '1995') },
      { media_item_id: 'a', bucket: 'fine', position: 2, category: 'movies', media_items: item('Drive', '2011') },
    ]);

    const { result } = await renderHookWithProviders(() => useRankedCollection('user-1', 'movies'));

    await waitFor(() => expect(result.current.data).toHaveLength(2));
    // Key order is `a, z`; position order is `z, a`. The sort has to survive the change
    // of request, or a ranked list silently reorders itself.
    expect(result.current.data?.map((entry) => entry.mediaItemId)).toEqual(['z', 'a']);
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
      // `rankings.created_at`, which the See all sheet's Recently ranked order reads
      // (20260901000100).
      rankedAt: '2026-01-01T00:00:00Z',
    });
  });

  it('carries the show’s name on a ranked season', async () => {
    seed('rankings', [
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
    ]);

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
    // Explicit timestamps, descending, so the order these are written in is the order
    // the hook returns them in — it sorts newest first over the assembled rows now that
    // the request is sorted by the key it pages on.
    seed('user_media', [
      { media_item_id: 'a', created_at: '2026-01-03T00:00:00Z', bucket: 'loved', watched_on: null, media_items: item('Heat', '1995') },
      { media_item_id: 'b', created_at: '2026-01-02T00:00:00Z', bucket: 'fine', watched_on: null, media_items: item('Drive', '2011') },
      { media_item_id: 'c', created_at: '2026-01-01T00:00:00Z', bucket: null, watched_on: null, media_items: item('Alien', '1979') },
    ]);
    seed('rankings', [{ media_item_id: 'a' }]);
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
    seed('watchlist', [{ media_item_id: 'z', media_items: item('Sicario', '2015') }]);

    const { result } = await renderHookWithProviders(() => useWatchlist('user-1'));

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(readOf('watchlist').filters).toEqual({ user_id: 'user-1' });
    // `created_at` is selected, not ordered on: it is not unique, and a `.gt()` cursor on
    // a value two rows share skips all but the last of them.
    expect(readOf('watchlist').order).toEqual([{ column: 'media_item_id', ascending: true }]);
    expect(readOf('watchlist').columns).toContain('created_at');
    expect(result.current.data?.[0]).toMatchObject({ title: 'Sicario', bucket: null });
  });

  it('still hands back the newest first', async () => {
    seed('watchlist', [
      { media_item_id: 'z', media_items: item('Sicario', '2015') },
      { media_item_id: 'a', media_items: item('Dune', '2021') },
    ]);

    const { result } = await renderHookWithProviders(() => useWatchlist('user-1'));

    await waitFor(() => expect(result.current.data).toHaveLength(2));
    // `seed` stamps ascending timestamps, so `a` is the newer of the two and leads even
    // though `z` comes second in key order.
    expect(result.current.data?.map((entry) => entry.mediaItemId)).toEqual(['a', 'z']);
  });
});

/**
 * **A capped read may never become a denominator**, which is the correction this file
 * carries and the reason `use-collection.ts` was not deferred a second time.
 *
 * PostgREST silently truncates an unbounded select at 1,000 rows. Deferring these hooks
 * was argued on the grounds that they return *lists*, and a truncated list is a display
 * problem. They do not. `loggedCount` and `rankedCount` are `.length` on those arrays, and
 * `useBandSizes` takes the ranking total the same way and divides a score by it. An
 * account with 1,001 ranked films rendered **"#1,001 of 1,000"** with a wrong derived
 * score. Independent review 21b.
 *
 * So the totals are asserted at and around the boundary, in both directions, because the
 * failure has no other symptom: nothing errors, nothing logs, and the number that comes
 * out looks exactly like a number.
 */
describe('a collection past the page size', () => {
  const logged = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      media_item_id: `m${String(i).padStart(5, '0')}`,
      bucket: null,
      watched_on: null,
      media_items: item(`Film ${i}`, '2020'),
    }));

  const ranked = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ media_item_id: `m${String(i).padStart(5, '0')}` }));

  it.each([999, 1000, 1001, 2000, 2345])('counts %i logged titles, not a page of them', async (
    total,
  ) => {
    seed('user_media', logged(total));
    seed('rankings', []);

    const { result } = await renderHookWithProviders(() => useLoggedCollection('user-1'));

    await waitFor(() => expect(result.current.data).toBeDefined(), { timeout: 10_000 });
    expect(result.current.data?.loggedCount).toBe(total);
    expect(result.current.data?.entries).toHaveLength(total);
    expect(result.current.data?.unranked).toHaveLength(total);
  }, 30_000);

  it('counts every ranked title, so the split in the header adds up', async () => {
    // 1,001 ranked out of 1,500 logged: both sides of the header are past the cap, and
    // before this each would have said 1,000.
    seed('user_media', logged(1500));
    seed('rankings', ranked(1001));

    const { result } = await renderHookWithProviders(() => useLoggedCollection('user-1'));

    await waitFor(() => expect(result.current.data).toBeDefined(), { timeout: 10_000 });
    expect(result.current.data?.rankedCount).toBe(1001);
    expect(result.current.data?.loggedCount).toBe(1500);
    expect(result.current.data?.unranked).toHaveLength(499);
  }, 30_000);

  it('a title past the cap is ranked rather than quietly unranked', async () => {
    // The sharper version of the same bug: a short read on `rankings` does not shorten a
    // list, it moves titles into the unranked queue that the reader has already ranked.
    seed('user_media', logged(1200));
    seed('rankings', ranked(1200));

    const { result } = await renderHookWithProviders(() => useLoggedCollection('user-1'));

    await waitFor(() => expect(result.current.data).toBeDefined(), { timeout: 10_000 });
    expect(result.current.data?.unranked).toEqual([]);
    expect(result.current.data?.rankedCount).toBe(1200);
  }, 30_000);

  it('returns the whole ranked list, in position order, past two page boundaries', async () => {
    seed(
      'rankings',
      Array.from({ length: 2100 }, (_, i) => ({
        media_item_id: `m${String(i).padStart(5, '0')}`,
        bucket: 'loved',
        // Reversed, so a read that stopped early would also be visibly the wrong end.
        position: 2100 - i,
        category: 'movies',
        media_items: item(`Film ${i}`, '2020'),
      })),
    );

    const { result } = await renderHookWithProviders(() => useRankedCollection('user-1', 'movies'));

    await waitFor(() => expect(result.current.data).toBeDefined(), { timeout: 10_000 });
    expect(result.current.data).toHaveLength(2100);
    expect(result.current.data?.[0]?.position).toBe(1);
    expect(result.current.data?.at(-1)?.position).toBe(2100);
    expect(pg().requests.rankings).toBe(3);
  }, 30_000);

  it('makes one request when the first page is short', async () => {
    seed('watchlist', [{ media_item_id: 'z', media_items: item('Sicario', '2015') }]);
    const { result } = await renderHookWithProviders(() => useWatchlist('user-1'));

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(pg().requests.watchlist).toBe(1);
  });

  it('does not lose or repeat a title when another device logs one mid-read', async () => {
    // Codex's sequence, at the collection rather than the awards read: with `.range()`
    // paging, a row inserted before page one's boundary shifts every later offset — the
    // boundary row arrives twice, one row is never seen, and `loggedCount` still looks
    // like a plausible number.
    seed('user_media', logged(1500));
    seed('rankings', []);
    pg().between = (table, requests, tables) => {
      if (table !== 'user_media' || requests !== 1) return;
      (tables.user_media as unknown[]).push({
        user_id: OWNER,
        media_item_id: 'm00000-a',
        created_at: '2026-02-01T00:00:00Z',
        bucket: null,
        watched_on: null,
        media_items: item('Logged on the tablet', '2020'),
      });
    };

    const { result } = await renderHookWithProviders(() => useLoggedCollection('user-1'));

    await waitFor(() => expect(result.current.data).toBeDefined(), { timeout: 10_000 });
    const ids = result.current.data?.entries.map((entry) => entry.mediaItemId) ?? [];
    expect(ids).toHaveLength(1500);
    expect(new Set(ids).size).toBe(1500);
    expect(result.current.data?.loggedCount).toBe(1500);
  }, 30_000);
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
    seed('rankings', []);
    await renderHookWithProviders(() => useRankedCollection('user-1', 'tv_seasons'));

    // The embed was already being fetched for the show's name; this is two more columns
    // on it rather than another query.
    expect(readOf('rankings').columns).toContain(
      'parent:parent_id(title, genres, original_language)',
    );
  });

  it('gives a ranked season the show’s genres and language', async () => {
    seed('rankings', [
      {
        media_item_id: 's1',
        bucket: 'loved',
        position: 1,
        category: 'tv_seasons',
        media_items: showSeason(),
      },
    ]);

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
    seed('user_media', [
      { media_item_id: 's1', bucket: null, watched_on: null, media_items: showSeason() },
    ]);
    seed('rankings', []);

    const { result } = await renderHookWithProviders(() => useLoggedCollection('user-1'));

    await waitFor(() => expect(result.current.data?.entries).toHaveLength(1));
    expect(result.current.data?.entries[0]).toMatchObject({
      genres: ['Drama', 'Thriller'],
      language: 'ja',
    });
  });

  it('gives a watchlisted season the same', async () => {
    seed('watchlist', [{ media_item_id: 's1', media_items: showSeason() }]);

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
    seed('watchlist', [
      {
        media_item_id: 's1',
        media_items: showSeason({ genres: ['Comedy'], original_language: 'fr' }),
      },
    ]);

    const { result } = await renderHookWithProviders(() => useWatchlist('user-1'));

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data?.[0]).toMatchObject({ genres: ['Comedy'], language: 'fr' });
  });

  it('does not guess when there is no parent to inherit from', async () => {
    seed('watchlist', [
      { media_item_id: 's1', media_items: showSeason({ parent: null, parent_id: null }) },
    ]);

    const { result } = await renderHookWithProviders(() => useWatchlist('user-1'));

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    // Unknown, not inferred from the title and not borrowed from anywhere.
    expect(result.current.data?.[0]).toMatchObject({ genres: [], language: null });
  });

  it('leaves a film reading its own metadata', async () => {
    seed('watchlist', [{ media_item_id: 'z', media_items: item('Sicario', '2015') }]);

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
