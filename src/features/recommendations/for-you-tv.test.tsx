import { act, waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { resetImpressions } from './impressions';
import { recommendationAnchorSeed, refreshRecommendations, resetRecommendationSession } from './session-seed';
import { useForYou } from './use-for-you';

/**
 * **The TV wall's source defects, through the real hook** (For You repetition audit,
 * 2026-09-13), and the stability of rotated anchors inside one launch.
 *
 * Three defects, each invisible to the existing screen suites because their Supabase mocks
 * ignore filters — so a season row and a series row came back from the same `kind = 'series'`
 * read and the season-versus-series mismatch could not be seen at all. This file's mock
 * **honours `eq`, `in` and `gt`**, which is the whole point of it:
 *
 *   1. `social_candidates` returns what followees ranked, which on TV is a season; the TV
 *      wall reads series, so the source contributed nothing to television.
 *   2. The TV wall excluded `user_media` ids, which are seasons; a show the reader had
 *      logged a season of came back as though it were unseen.
 *   3. A TV reader with no season ranked had exactly one twenty-title trending list.
 */

jest.mock('@/lib/analytics', () => ({ track: () => {} }));

const mockCacheSimilar = jest.fn();
/** When set, a fill writes the facet the way the adapter does: `liked-N` → `[rec-N]`. */
let mockFillWrites = false;
/** When set, a fill never settles — the wall must draw anyway (2026-09-23). */
let mockFillHangs = false;
jest.mock('@/lib/tmdb-adapter', () => ({
  AdapterError: class AdapterError extends Error {},
  cacheSimilar: (id: string) => {
    mockCacheSimilar(id);
    if (mockFillWrites) {
      (mockTables.media_cache ??= []).push({
        media_item_id: id,
        facet: 'similar',
        payload: { ids: [id.replace('liked-', 'rec-')] },
        expires_at: '2999-01-01T00:00:00Z',
      });
    }
    if (mockFillHangs) return new Promise(() => {});
    return Promise.resolve();
  },
}));

type Row = Record<string, unknown>;
let mockTables: Record<string, Row[]> = {};
let mockRpcResults: Record<string, unknown> = {};
/** Every id set asked of `media_cache`, in order: which anchors a slate actually used. */
const mockSimilarAsks: string[][] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string) => Promise.resolve({ data: mockRpcResults[name] ?? null, error: null }),
    from: (table: string) => {
      const filters: ((row: Row) => boolean)[] = [];
      let limit = Infinity;
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.order = () => chain;
      chain.eq = (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return chain;
      };
      chain.in = (column: string, values: unknown[]) => {
        if (table === 'media_cache' && column === 'media_item_id') {
          mockSimilarAsks.push([...(values as string[])]);
        }
        filters.push((row) => values.includes(row[column]));
        return chain;
      };
      chain.gt = (column: string, value: string) => {
        filters.push((row) => String(row[column]) > value);
        return chain;
      };
      chain.limit = (count: number) => {
        limit = count;
        return chain;
      };
      const rows = () =>
        (mockTables[table] ?? []).filter((row) => filters.every((keep) => keep(row))).slice(0, limit);
      chain.maybeSingle = () => Promise.resolve({ data: rows()[0] ?? null, error: null });
      chain.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve);
      return chain;
    },
  },
}));

const show = (id: string, genre = 'Drama', popularity = 200): Row => ({
  id,
  title: `Show ${id}`,
  release_date: '2021-01-01',
  poster_path: null,
  kind: 'series',
  genres: [genre],
  original_language: 'en',
  popularity,
  parent_id: null,
});

const seasonOf = (id: string, parent: string): Row => ({
  id,
  title: 'Season 1',
  release_date: '2021-01-01',
  poster_path: null,
  kind: 'season',
  genres: ['Drama'],
  original_language: 'en',
  popularity: 50,
  parent_id: parent,
});

/** How a `user_media` or `rankings` row embeds its title, as the collection reads it. */
const embedded = (media: Row) => ({
  title: media.title,
  season_number: 1,
  release_date: media.release_date,
  poster_path: null,
  genres: media.genres,
  runtime_minutes: null,
  kind: media.kind,
  original_language: media.original_language,
  parent_id: media.parent_id,
  parent: null,
});

const list = (key: string, ids: string[]): Row => ({ list_key: key, payload: { ids } });

const wallIds = (items: { mediaItemId: string }[] | undefined) =>
  (items ?? []).map((item) => item.mediaItemId).sort();

beforeEach(() => {
  mockTables = {};
  mockRpcResults = {};
  mockSimilarAsks.length = 0;
  mockCacheSimilar.mockReset();
  mockFillWrites = false;
  mockFillHangs = false;
  resetRecommendationSession(1);
  resetImpressions();
});

describe('the TV wall', () => {
  it('rolls a followee’s ranked season up to its show, instead of dropping it', async () => {
    mockTables.media_items = [show('show-week'), show('show-social', 'Comedy'), seasonOf('season-social', 'show-social')];
    mockTables.provider_list_cache = [list('trending.series.week', ['show-week'])];
    mockRpcResults.social_candidates = [{ media_item_id: 'season-social', endorsements: 2 }];

    const { result } = await renderHookWithProviders(() => useForYou('user-1', 'tv'));

    await waitFor(() => expect(result.current.data?.items).toHaveLength(2));
    expect(wallIds(result.current.data?.items)).toEqual(['show-social', 'show-week']);
    // The season itself never reaches a wall of shows.
    expect(wallIds(result.current.data?.items)).not.toContain('season-social');
    // And it is honestly not a popularity-only wall: a followee's title is on it.
    expect(result.current.data?.popularityOnly).toBe(false);
    expect(result.current.data?.socialIds).toEqual(['show-social']);
  });

  it('does not recommend a show the reader has logged a season of', async () => {
    const logged = seasonOf('season-met', 'show-met');
    mockTables.media_items = [show('show-met'), show('show-new'), logged];
    mockTables.provider_list_cache = [list('trending.series.week', ['show-met', 'show-new'])];
    mockTables.user_media = [
      { user_id: 'user-1', media_item_id: 'season-met', bucket: null, watched_on: null, created_at: '2026-09-01T00:00:00Z', media_items: embedded(logged) },
    ];

    const { result } = await renderHookWithProviders(() => useForYou('user-1', 'tv'));

    await waitFor(() => expect(result.current.data?.items).toBeDefined());
    expect(wallIds(result.current.data?.items)).toEqual(['show-new']);
  });

  it('does not recommend a show whose season the reader ranked, even outside the anchors', async () => {
    // Ranked `fine`: never an anchor, so the anchor lock could not have caught it.
    const ranked = seasonOf('season-ranked', 'show-ranked');
    mockTables.media_items = [show('show-ranked'), show('show-new'), ranked];
    mockTables.provider_list_cache = [list('trending.series.week', ['show-ranked', 'show-new'])];
    mockTables.rankings = [
      { user_id: 'user-1', media_item_id: 'season-ranked', bucket: 'fine', position: 1, category: 'tv_seasons', created_at: '2026-09-01T00:00:00Z', media_items: embedded(ranked) },
    ];

    const { result } = await renderHookWithProviders(() => useForYou('user-1', 'tv'));

    await waitFor(() => expect(result.current.data?.items).toBeDefined());
    expect(wallIds(result.current.data?.items)).toEqual(['show-new']);
  });

  it('draws on the day list beside the week list, and still calls the wall popular', async () => {
    mockTables.media_items = [show('show-week'), show('show-day', 'Comedy'), show('show-both', 'Crime')];
    mockTables.provider_list_cache = [
      list('trending.series.week', ['show-week', 'show-both']),
      list('trending.series.day', ['show-both', 'show-day']),
    ];

    const { result } = await renderHookWithProviders(() => useForYou('user-1', 'tv'));

    await waitFor(() => expect(result.current.data?.items).toHaveLength(3));
    expect(wallIds(result.current.data?.items)).toEqual(['show-both', 'show-day', 'show-week']);
    // Trending is trending: no anchor, no followee, and the wall says so.
    expect(result.current.data).toMatchObject({ anchorsUsed: 0, popularityOnly: true });
  });

  it('does not pad an anchored TV wall with the day list', async () => {
    // The day list is for a reader with nothing to anchor on. Once a liked show resolves,
    // more trending titles competing for its wall would be popularity padding (review M2).
    const liked = seasonOf('season-liked', 'show-liked');
    mockTables.media_items = [
      show('show-liked'),
      liked,
      show('show-rec', 'Crime'),
      show('show-week', 'Comedy'),
      show('show-day', 'Comedy'),
    ];
    mockTables.rankings = [
      { user_id: 'user-1', media_item_id: 'season-liked', bucket: 'loved', position: 1, category: 'tv_seasons', created_at: '2026-09-01T00:00:00Z', media_items: embedded(liked) },
    ];
    mockTables.user_media = [
      { user_id: 'user-1', media_item_id: 'season-liked', bucket: 'loved', watched_on: null, created_at: '2026-09-01T00:00:00Z', media_items: embedded(liked) },
    ];
    mockTables.media_cache = [
      { media_item_id: 'show-liked', facet: 'similar', payload: { ids: ['show-rec'] }, expires_at: '2999-01-01T00:00:00Z' },
    ];
    mockTables.provider_list_cache = [
      list('trending.series.week', ['show-week']),
      list('trending.series.day', ['show-day']),
    ];

    const { result } = await renderHookWithProviders(() => useForYou('user-1', 'tv'));

    await waitFor(() => expect(result.current.data?.items.length).toBeGreaterThan(0));
    expect(result.current.data?.anchorsUsed).toBe(1);
    expect(wallIds(result.current.data?.items)).toEqual(['show-rec', 'show-week']);
  });

  it('leaves the Movies wall on the week list alone', async () => {
    const film: Row = { ...show('film-week'), kind: 'movie' };
    const dayFilm: Row = { ...show('film-day'), kind: 'movie' };
    mockTables.media_items = [film, dayFilm];
    mockTables.provider_list_cache = [
      list('trending.movie.week', ['film-week']),
      list('trending.movie.day', ['film-day']),
    ];

    const { result } = await renderHookWithProviders(() => useForYou('user-1', 'movies'));

    await waitFor(() => expect(result.current.data?.items).toHaveLength(1));
    expect(wallIds(result.current.data?.items)).toEqual(['film-week']);
  });
});

describe('selected anchors inside one launch', () => {
  /** Twelve liked films, each with a TMDB list of one title of its own — cached unless told. */
  const seedLikedAccount = ({ cached = true }: { cached?: boolean } = {}) => {
    const films: Row[] = [];
    mockTables.rankings = [];
    mockTables.media_cache = [];
    for (let index = 0; index < 12; index += 1) {
      const liked: Row = { ...show(`liked-${index}`), kind: 'movie' };
      const recommended: Row = { ...show(`rec-${index}`), kind: 'movie' };
      films.push(liked, recommended);
      mockTables.rankings.push({
        user_id: 'user-1',
        media_item_id: liked.id,
        bucket: 'loved',
        position: index + 1,
        category: 'movies',
        created_at: '2026-09-01T00:00:00Z',
        media_items: embedded(liked),
      });
      if (cached) {
        mockTables.media_cache.push({
          media_item_id: liked.id,
          facet: 'similar',
          payload: { ids: [recommended.id] },
          expires_at: '2999-01-01T00:00:00Z',
        });
      }
    }
    mockTables.media_items = films;
    mockTables.user_media = films
      .filter((film) => String(film.id).startsWith('liked-'))
      .map((film) => ({ user_id: 'user-1', media_item_id: film.id }));
  };

  /** Which liked films anchored the slate, read back from the candidates they produced. */
  const anchorsBehind = (scored: { mediaItemId: string }[]) =>
    scored.map((item) => item.mediaItemId.replace('rec-', 'liked-')).sort();

  it('reasons from the same eight on every render, refetch and Refresh of a launch', async () => {
    seedLikedAccount();
    const { result, rerender } = await renderHookWithProviders(() => useForYou('user-1', 'movies'));

    await waitFor(() => expect(result.current.data?.items.length).toBeGreaterThan(0));
    const scored = result.current.data!.scored;
    expect(result.current.data!.anchorsUsed).toBe(8);
    expect(anchorsBehind(scored)).toHaveLength(8);
    expect(anchorsBehind(scored)).toEqual(expect.arrayContaining(['liked-0', 'liked-1']));
    const reads = mockSimilarAsks.length;

    await rerender(undefined);
    await act(async () => {
      refreshRecommendations();
    });
    await rerender(undefined);

    // Refresh re-derives the arrangement from the cache: the scoring is the same object, so
    // the query did not run again, no list was re-read and no anchor was re-drawn.
    expect(result.current.data!.scored).toBe(scored);
    expect(mockSimilarAsks).toHaveLength(reads);
    expect(result.current.isPending).toBe(false);
  });

  /**
   * **A fill is work for the next launch, not a wall the reader waits behind** (2026-09-23).
   *
   * Measured against staging: one `cacheSimilar` is an edge call at 561ms p50 and six in
   * series were 3,368ms — with the grid empty for all of it. `fillAnchors` fires them and
   * does not await, *provided* the slate has an anchor to reason from; the facets it writes
   * last a week and are what the next launch draws on.
   *
   * A fill that never settles is the sharpest way to say it: under the old queryFn this
   * test could not finish.
   */
  it('draws the wall without waiting for a fill, once any anchor has a list', async () => {
    seedLikedAccount();
    // Four of twelve cached, so the chosen eight include titles that must be filled.
    mockTables.media_cache = mockTables.media_cache!.slice(0, 4);
    mockFillHangs = true;

    const { result } = await renderHookWithProviders(() => useForYou('user-1', 'movies'));

    await waitFor(() => expect(result.current.data?.items.length).toBeGreaterThan(0));
    // Drawn from the lists that were already there — and the fills were still fired, which
    // is what makes the next launch broader rather than this one slower.
    expect(result.current.data!.anchorsUsed).toBeGreaterThan(0);
    expect(mockCacheSimilar).toHaveBeenCalled();
  });

  /**
   * The other half of the same rule, and the reason it is not simply "never wait": with no
   * list at all the wall would be trending and whoever the reader follows, labelled
   * "Popular right now" — honest, and not what somebody who has loved twelve films is owed.
   */
  it('still waits for the fills when no anchor has a list at all', async () => {
    seedLikedAccount({ cached: false });
    mockFillWrites = true;

    const { result } = await renderHookWithProviders(() => useForYou('user-1', 'movies'));

    await waitFor(() => expect(result.current.data?.items.length).toBeGreaterThan(0));
    expect(result.current.data!.anchorsUsed).toBeGreaterThan(0);
    expect(result.current.data!.popularityOnly).toBe(false);
  });

  it('keeps the selection when a refetch finds the cache has moved underneath it', async () => {
    // Review m1. Selection weights titles whose lists are cached, and the cache moves on
    // its own: this launch's fills land, and other readers fill titles this launch never
    // chose. Four of twelve lists cached at first; every fill writes its facet; then every
    // remaining list appears before the refetch, which changes every weight in the draw.
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      seedLikedAccount();
      mockTables.media_cache = mockTables.media_cache!.slice(0, 4);
      mockFillWrites = true;
      mockCacheSimilar.mockReset();
      resetRecommendationSession(seed);

      const { result, unmount } = await renderHookWithProviders(() => useForYou('user-1', 'movies'));
      await waitFor(() => expect(result.current.data?.items.length).toBeGreaterThan(0));
      const first = result.current.data!.scored;
      const behind = anchorsBehind(first);
      const fills = mockCacheSimilar.mock.calls.length;
      for (let index = 0; index < 12; index += 1) {
        const id = `liked-${index}`;
        if (mockTables.media_cache!.some((row) => row.media_item_id === id)) continue;
        mockTables.media_cache!.push({
          media_item_id: id,
          facet: 'similar',
          payload: { ids: [`rec-${index}`] },
          expires_at: '2999-01-01T00:00:00Z',
        });
      }

      // The refetch really runs the queryFn — it reads the cached lists again — and React
      // Query's structural sharing may then hand back the same data if nothing moved.
      const reads = mockSimilarAsks.length;
      await act(async () => {
        result.current.refetch();
      });
      await waitFor(() => expect(mockSimilarAsks.length).toBeGreaterThan(reads));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      /**
       * **The selection is the memo's, not a fresh draw** — which is what review m1 asked
       * this test to pin, and it is now pinned against a wall the fills did not wait for.
       *
       * Since 2026-09-23 a slate with any cached anchor draws immediately and fires its
       * fills without awaiting them (`fillAnchors`), so the first wall is attributed to the
       * lists that were already there — a subset — and this refetch, which finds every list
       * present, shows the whole chosen eight. Stability is therefore the *superset*: every
       * anchor the first wall quoted is still behind this one, so no weight that moved
       * underneath it re-drew the selection.
       */
      const after = anchorsBehind(result.current.data!.scored);
      expect(after).toEqual(expect.arrayContaining(behind));
      expect(after).toHaveLength(8);
      // The fills this launch fired are the only ones: the refetch found every chosen list
      // in the cache and asked the adapter for nothing further.
      expect(mockCacheSimilar.mock.calls.length).toBe(fills);
      await unmount();
    }
  });

  it('draws different long-tail anchors on a different launch, keeping the top two', async () => {
    seedLikedAccount();
    const draws = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      resetRecommendationSession(seed);
      expect(recommendationAnchorSeed()).toBeGreaterThan(0);
      const { result, unmount } = await renderHookWithProviders(() => useForYou('user-1', 'movies'));
      await waitFor(() => expect(result.current.data?.items.length).toBeGreaterThan(0));
      const behind = anchorsBehind(result.current.data!.scored);
      expect(behind).toEqual(expect.arrayContaining(['liked-0', 'liked-1']));
      draws.add(behind.join());
      await unmount();
    }
    expect(draws.size).toBeGreaterThan(1);
    // Every list was already cached, so a wider, rotating budget cost no provider request.
    expect(mockCacheSimilar).not.toHaveBeenCalled();
  });

  it('never asks the provider for more than six lists in one slate, strongest first', async () => {
    seedLikedAccount({ cached: false });
    const { result } = await renderHookWithProviders(() => useForYou('user-1', 'movies'));

    await waitFor(() => expect(result.current.data).toBeDefined());
    const asked = mockCacheSimilar.mock.calls.map(([id]) => id as string);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.length).toBeLessThanOrEqual(6);
    expect(asked.slice(0, 2)).toEqual(['liked-0', 'liked-1']);
    for (const id of asked) expect(id).toMatch(/^liked-/);
  });
});
