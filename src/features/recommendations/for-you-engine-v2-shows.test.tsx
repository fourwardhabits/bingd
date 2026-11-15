import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { resetImpressions } from './impressions';
import { resetRecommendationSession } from './session-seed';
import { useForYou } from './use-for-you';

/**
 * Engine V2 through the real hook, for a reader whose TV taste is **whole-show rankings**
 * (rec/v2-reconcile, 2026-11-13). The mock is `for-you-engine-v2.test.tsx`'s.
 *
 * Before the reconcile the V2 profile read films and seasons only, so a reader who ranked
 * three Korean shows whole had no Korean evidence at all and the catalogue was never asked
 * for Korean shows. The profile now reads `tv_shows` with V1's series-unit weights.
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
        return Promise.resolve({
          data: null,
          error: { code: 'PGRST202', message: `no function ${name}` },
        });
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

const show = (id: string, language: string, popularity = 300) => ({
  id,
  title: `Show ${id}`,
  release_date: '2018-01-01',
  poster_path: `/${id}.jpg`,
  kind: 'series',
  genres: ['Drama'],
  original_language: language,
  popularity,
});

/** A whole-show ranking as `useRankedCollection(…, 'tv_shows')` reads one. */
const rankedShow = (id: string, position: number) => ({
  media_item_id: id,
  bucket: 'loved',
  position,
  category: 'tv_shows',
  created_at: '2026-11-01T00:00:00Z',
  media_items: {
    title: `Ranked ${id}`,
    season_number: null,
    release_date: '2017-01-01',
    poster_path: `/${id}.jpg`,
    genres: ['Drama'],
    runtime_minutes: null,
    kind: 'series',
    original_language: 'ko',
    parent_id: null,
    parent: null,
  },
});

const englishShows = Array.from({ length: 24 }, (_, index) => show(`en-show-${index}`, 'en'));
const koreanShows = Array.from({ length: 8 }, (_, index) => show(`ko-show-${index}`, 'ko'));

const setup = (engine: 'v1' | 'v2_metadata' | 'v2_metadata_social') => {
  const ranked = ['kr-1', 'kr-2', 'kr-3'];
  mockTables.rankings = ranked.map((id, i) => rankedShow(id, i + 1));
  mockTables.user_media = [];
  // Every loved show has a cached TMDB list, all English, so nothing needs a fill.
  mockTables.media_cache = ranked.map((id) => ({
    media_item_id: id,
    facet: 'similar',
    payload: { ids: englishShows.map((row) => row.id) },
    expires_at: '2999-01-01T00:00:00Z',
  }));
  mockTables.provider_list_cache = [{ payload: { ids: englishShows.map((row) => row.id) } }];
  mockTables.media_items = englishShows;
  mockRpcResults = {
    recommendation_engine: engine,
    catalogue_candidates: koreanShows.map((row) => ({ ...row, source: 'language:ko' })),
    // Somebody the reader follows loved a show. Only V1 may ask for it on the TV wall.
    social_candidates: [{ media_item_id: 'followed-show', endorsers: 2 }],
  };
};

const render = () => renderHookWithProviders(() => useForYou('user-1', 'tv', undefined, 1));

beforeEach(() => {
  mockTables = {};
  mockRpcResults = {};
  mockRpcErrors = new Set();
  mockRpcCalls.length = 0;
  resetRecommendationSession();
  resetImpressions();
});

describe('Engine V2 for a reader who ranks shows whole', () => {
  it('reads the whole-show rankings into the profile and asks for Korean shows', async () => {
    setup('v2_metadata');
    const { result } = await render();
    await waitFor(() => expect(result.current.data?.engine).toBe('v2_metadata'));
    const ask = mockRpcCalls.find((call) => call.name === 'catalogue_candidates');
    expect(ask?.args).toMatchObject({ p_kind: 'series' });
    expect((ask?.args as { p_languages: string[] }).p_languages).toContain('ko');
    const pool = new Set(result.current.data!.scored.map((item) => item.mediaItemId));
    expect(koreanShows.some((row) => pool.has(row.id))).toBe(true);
    expect(result.current.data!.items.map((item) => item.language)).toContain('ko');
  });

  it('leaves V1 exactly as main has it: no catalogue request', async () => {
    setup('v1');
    const { result } = await render();
    await waitFor(() => expect(result.current.data?.items.length).toBeGreaterThan(0));
    expect(result.current.data?.engine).toBe('v1');
    expect(mockRpcCalls.some((call) => call.name === 'catalogue_candidates')).toBe(false);
  });

  it('under the v2_metadata_social prototype, draws the TV wall exactly as v2_metadata does', async () => {
    const pool = async (engine: 'v2_metadata' | 'v2_metadata_social') => {
      mockRpcCalls.length = 0;
      resetRecommendationSession();
      resetImpressions();
      setup(engine);
      mockTables.media_items = [...englishShows, show('followed-show', 'en')];
      const { result } = await render();
      await waitFor(() => expect(result.current.data?.engine).toBe(engine));
      const data = result.current.data!;
      const out = {
        askedSocial: mockRpcCalls.some((call) => call.name === 'social_candidates'),
        scored: data.scored.map((item) => [item.mediaItemId, item.explanation.total]),
      };
      return out;
    };
    const metadata = await pool('v2_metadata');
    const prototype = await pool('v2_metadata_social');
    expect(metadata.askedSocial).toBe(false);
    expect(prototype.askedSocial).toBe(false);
    // Same pool, same scores, title for title: the prototype changes nothing on TV.
    expect(prototype.scored).toEqual(metadata.scored);
    expect(prototype.scored.some(([id]) => id === 'followed-show')).toBe(false);
  });
});
