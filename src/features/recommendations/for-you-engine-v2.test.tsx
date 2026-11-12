import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { resetImpressions } from './impressions';
import { resetRecommendationSession } from './session-seed';
import { useForYou } from './use-for-you';

/**
 * Engine V2 through the real hook (founder spec 2026-11-10, §3 A1 and §9).
 *
 * The Supabase boundary is mocked, as in `for-you-telemetry.test.tsx`, so the engine
 * read, the gating, the query key, the profile, the catalogue fill, scoring and the draw
 * are all the shipped code. Two of the spec's done criteria are asserted here:
 *
 *   - **non-English titles enter the candidate pool and get selected**, for a reader whose
 *     only evidence is that they loved some Japanese films; and
 *   - **following alone has no effect**: under V2 `social_candidates` is never asked, so
 *     what the people a reader follows loved cannot reach the wall by that route.
 */

jest.mock('@/lib/analytics', () => ({ track: jest.fn() }));

let mockTables: Record<string, unknown[]> = {};
let mockRpcResults: Record<string, unknown> = {};
/** RPCs that fail, as a server that predates them or an outage would. */
let mockRpcErrors = new Set<string>();
const mockRpcCalls: { name: string; args: unknown }[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args?: unknown) => {
      mockRpcCalls.push({ name, args });
      if (mockRpcErrors.has(name)) {
        return Promise.resolve({ data: null, error: { code: 'PGRST202', message: `no function ${name}` } });
      }
      return Promise.resolve({ data: mockRpcResults[name] ?? null, error: null });
    },
    from: (table: string) => {
      // `in` and `eq` are honoured on columns the fixture rows carry, so a title is only
      // a candidate when something asked for it — which is the property under test.
      const filters: ((row: Record<string, unknown>) => boolean)[] = [];
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'gt', 'gte', 'lte', 'order', 'limit']) {
        chain[method] = () => chain;
      }
      chain.in = (column: string, values: unknown[]) => {
        filters.push((row) => !(column in row) || values.includes(row[column]));
        return chain;
      };
      chain.eq = (column: string, value: unknown) => {
        filters.push((row) => !(column in row) || row[column] === value);
        return chain;
      };
      const rows = () =>
        ((mockTables[table] ?? []) as Record<string, unknown>[]).filter((row) =>
          filters.every((keep) => keep(row)),
        );
      chain.maybeSingle = () => Promise.resolve({ data: rows()[0] ?? null, error: null });
      chain.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve);
      return chain;
    },
  },
}));

const film = (id: string, language: string, popularity = 300, genre = 'Drama') => ({
  id,
  title: `Title ${id}`,
  release_date: '2016-01-01',
  poster_path: `/${id}.jpg`,
  kind: 'movie',
  genres: [genre],
  original_language: language,
  popularity,
});

/** A logged, bucketed film as `useLoggedCollection` reads one: the reader's own evidence. */
const loggedFilm = (id: string, language: string, bucket: 'loved' | 'fine' | 'not_for_me') => ({
  media_item_id: id,
  bucket,
  watched_on: '2026-10-01',
  created_at: '2026-10-01T00:00:00Z',
  media_items: {
    title: `Logged ${id}`,
    season_number: null,
    release_date: '2014-01-01',
    poster_path: null,
    genres: ['Drama'],
    runtime_minutes: 110,
    kind: 'movie',
    original_language: language,
    parent_id: null,
    parent: null,
  },
});

const english = Array.from({ length: 24 }, (_, index) => film(`en-${index}`, 'en', 300));
const japanese = Array.from({ length: 8 }, (_, index) => film(`ja-${index}`, 'ja', 300));

const setup = (engine: 'v1' | 'v2_metadata') => {
  mockTables.user_media = ['seen-1', 'seen-2', 'seen-3', 'seen-4'].map((id) => loggedFilm(id, 'ja', 'loved'));
  // The popularity fallback is all English, which is the pool V1 builds for this reader.
  mockTables.provider_list_cache = [{ payload: { ids: english.map((row) => row.id) } }];
  mockTables.media_items = english;
  mockRpcResults = {
    recommendation_engine: engine,
    // Under V1 the server answers this empty; the mock answers whatever it is asked so
    // the test shows the client does not ask.
    catalogue_candidates: japanese.map((row) => ({ ...row, source: 'language:ja' })),
    // Somebody the reader follows loved these. Under V1 they join the pool.
    social_candidates: [{ media_item_id: 'followed-1', endorsers: 2 }],
  };
};

const render = () => renderHookWithProviders(() => useForYou('user-1', 'movies', undefined, 1));
const called = (name: string) => mockRpcCalls.some((call) => call.name === name);

beforeEach(() => {
  mockTables = {};
  mockRpcResults = {};
  mockRpcErrors = new Set();
  mockRpcCalls.length = 0;
  resetRecommendationSession();
  resetImpressions();
});

describe('Engine V2 on the For You wall', () => {
  it('is V1 when the server says nothing, and V1 never asks the catalogue', async () => {
    setup('v1');
    const { result } = await render();
    await waitFor(() => expect(result.current.data?.items.length).toBeGreaterThan(0));

    expect(result.current.data?.engine).toBe('v1');
    expect(called('catalogue_candidates')).toBe(false);
    expect(called('social_candidates')).toBe(true);
    // The English-only pool V1 builds for this reader: no Japanese title can be drawn.
    expect(result.current.data?.items.some((item) => item.language === 'ja')).toBe(false);
  });

  it('puts Japanese titles into the pool and onto the wall for a reader who loved Japanese films', async () => {
    setup('v2_metadata');
    const { result } = await render();
    await waitFor(() => expect(result.current.data?.engine).toBe('v2_metadata'));
    const data = result.current.data!;

    const ask = mockRpcCalls.find((call) => call.name === 'catalogue_candidates');
    expect(ask?.args).toMatchObject({ p_kind: 'movie', p_languages: ['ja'] });

    const pool = new Set(data.scored.map((item) => item.mediaItemId));
    for (const row of japanese.slice(0, 6)) expect(pool.has(row.id)).toBe(true);
    expect(data.catalogueIds.length).toBeGreaterThanOrEqual(6);

    const wallLanguages = data.items.map((item) => item.language);
    expect(wallLanguages).toContain('ja');
    // Selected on merit rather than appended: with no anchor and equal popularity, the
    // only thing separating them is the reader's demonstrated interest in the language.
    const japaneseScores = data.scored.filter((item) => item.language === 'ja').map((item) => item.explanation.total);
    const englishScores = data.scored.filter((item) => item.language === 'en').map((item) => item.explanation.total);
    expect(Math.min(...japaneseScores)).toBeGreaterThan(Math.max(...englishScores));
    // And the wall says so honestly: not "popular right now".
    expect(data.popularityOnly).toBe(false);
  });

  it('never asks who the reader follows, so following alone cannot reach the wall', async () => {
    setup('v2_metadata');
    mockTables.media_items = [...english, film('followed-1', 'en', 300)];
    const { result } = await render();
    await waitFor(() => expect(result.current.data?.engine).toBe('v2_metadata'));

    expect(called('social_candidates')).toBe(false);
    expect(result.current.data?.socialIds).toEqual([]);
    expect(result.current.data?.scored.some((item) => item.mediaItemId === 'followed-1')).toBe(false);
  });

  it('falls back to V1 when the engine read fails, as on a server that predates it', async () => {
    setup('v2_metadata');
    mockRpcErrors.add('recommendation_engine');
    const { result } = await render();
    await waitFor(() => expect(result.current.data?.items.length).toBeGreaterThan(0));

    expect(result.current.data?.engine).toBe('v1');
    expect(called('catalogue_candidates')).toBe(false);
    expect(called('social_candidates')).toBe(true);
  });

  it('still draws a V2 wall when the catalogue read fails, without the fill', async () => {
    setup('v2_metadata');
    mockRpcErrors.add('catalogue_candidates');
    const { result } = await render();
    await waitFor(() => expect(result.current.data?.engine).toBe('v2_metadata'));

    expect(called('catalogue_candidates')).toBe(true);
    expect(result.current.data?.catalogueIds).toEqual([]);
    expect(result.current.data?.items.length).toBeGreaterThan(0);
    expect(result.current.isError).toBe(false);
  });

  it('adds nothing for a language the lists already cover', async () => {
    setup('v2_metadata');
    // A reader who mostly watches English and loved four Japanese films: Japanese is a
    // sixth of their evidence, so its fair share of a 32-title pool is the floor of six.
    mockTables.user_media = [
      ...['seen-1', 'seen-2', 'seen-3', 'seen-4'].map((id) => loggedFilm(id, 'ja', 'loved')),
      ...Array.from({ length: 20 }, (_, index) => loggedFilm(`seen-en-${index}`, 'en', 'loved')),
    ];
    // The fallback already holds plenty of Japanese titles.
    mockTables.media_items = [...english, ...japanese];
    mockTables.provider_list_cache = [
      { payload: { ids: [...english, ...japanese].map((row) => row.id) } },
    ];
    mockRpcResults.catalogue_candidates = Array.from({ length: 8 }, (_, index) => ({
      ...film(`ja-extra-${index}`, 'ja', 300),
      source: 'language:ja',
    }));
    const { result } = await render();
    await waitFor(() => expect(result.current.data?.engine).toBe('v2_metadata'));

    expect(result.current.data?.catalogueIds).toEqual([]);
  });
});
