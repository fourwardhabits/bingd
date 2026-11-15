import { act, waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { resetImpressions } from './impressions';
import { resetRecommendationSession } from './session-seed';
import { ENGINE_REREAD_MS } from './use-engine';
import { useForYou } from './use-for-you';

/**
 * An operator's rollback reaching a reader who never leaves the tab (Codex P2 on #301).
 *
 * The engine is cached as `v2_metadata`; the server is then flipped to `v1`. Before the
 * fix, nothing re-read it while the tab stayed mounted: `staleTime` only re-reads on a
 * mount, focus or reconnect, and Try again refetched the slate under the old key — which
 * re-ran V2's `queryFn`, catalogue fill included. Now Try again re-asks the engine first,
 * and the engine re-reads itself once per staleness window.
 *
 * The Supabase boundary is mocked as in `for-you-engine-v2.test.tsx`, so the engine read,
 * the gating, the slate key and the catalogue fill are the shipped code.
 */

jest.mock('@/lib/analytics', () => ({ track: jest.fn() }));

let mockTables: Record<string, unknown[]> = {};
let mockRpcResults: Record<string, unknown> = {};
const mockRpcCalls: { name: string; args: unknown }[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args?: unknown) => {
      mockRpcCalls.push({ name, args });
      return Promise.resolve({ data: mockRpcResults[name] ?? null, error: null });
    },
    from: (table: string) => {
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

const film = (id: string, language: string) => ({
  id,
  title: `Title ${id}`,
  release_date: '2016-01-01',
  poster_path: `/${id}.jpg`,
  kind: 'movie',
  genres: ['Drama'],
  original_language: language,
  popularity: 300,
});

const loggedFilm = (id: string) => ({
  media_item_id: id,
  bucket: 'loved',
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
    original_language: 'ja',
    parent_id: null,
    parent: null,
  },
});

const english = Array.from({ length: 24 }, (_, index) => film(`en-${index}`, 'en'));
const japanese = Array.from({ length: 8 }, (_, index) => film(`ja-${index}`, 'ja'));

const setup = () => {
  mockTables.user_media = ['seen-1', 'seen-2', 'seen-3', 'seen-4'].map(loggedFilm);
  mockTables.provider_list_cache = [{ payload: { ids: english.map((row) => row.id) } }];
  mockTables.media_items = english;
  mockRpcResults = {
    recommendation_engine: 'v2_metadata',
    catalogue_candidates: japanese.map((row) => ({ ...row, source: 'language:ja' })),
    social_candidates: [],
  };
};

const render = () => renderHookWithProviders(() => useForYou('user-1', 'movies', undefined, 1));
const callsOf = (name: string) => mockRpcCalls.filter((call) => call.name === name).length;
/** The engine segment of every For You slate key the cache holds. */
const slateEngines = (client: Awaited<ReturnType<typeof render>>['client']) =>
  client
    .getQueryCache()
    .findAll({ queryKey: ['for-you', 'user-1'] })
    .map((query) => query.queryKey[5]);

beforeEach(() => {
  mockTables = {};
  mockRpcResults = {};
  mockRpcCalls.length = 0;
  resetRecommendationSession();
  resetImpressions();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('a server-side engine rollback on a mounted For You tab', () => {
  it('reaches the wall on Try again / Refresh, without running the old engine again', async () => {
    setup();
    const { result, client } = await render();
    await waitFor(() => expect(result.current.data?.engine).toBe('v2_metadata'));
    expect(callsOf('catalogue_candidates')).toBe(1);
    expect(slateEngines(client)).toEqual(['v2_metadata']);

    // The operator turns V2 off. Nothing has re-read it yet: the wall is still V2.
    mockRpcResults.recommendation_engine = 'v1';
    mockRpcCalls.length = 0;
    expect(result.current.data?.engine).toBe('v2_metadata');

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.data?.engine).toBe('v1'));
    expect(callsOf('recommendation_engine')).toBe(1);
    // The new key is V1's, and it was drawn by V1: the catalogue was never asked.
    expect(slateEngines(client)).toContain('v1');
    expect(client.getQueryData(['recommendation-engine', 'user-1'])).toBe('v1');
    expect(callsOf('catalogue_candidates')).toBe(0);
    // V1's own source, which proves the V1 queryFn is what ran.
    expect(callsOf('social_candidates')).toBe(1);
    expect(result.current.data?.items.some((item) => item.language === 'ja')).toBe(false);
  });

  it('still refetches the slate when the engine has not moved', async () => {
    setup();
    const { result } = await render();
    await waitFor(() => expect(result.current.data?.engine).toBe('v2_metadata'));
    mockRpcCalls.length = 0;

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(callsOf('catalogue_candidates')).toBe(1));
    expect(callsOf('recommendation_engine')).toBe(1);
    expect(result.current.data?.engine).toBe('v2_metadata');
  });

  it('re-reads the engine once per staleness window with nobody touching the tab', async () => {
    jest.useFakeTimers();
    setup();
    const { result, client } = await render();
    await waitFor(() => expect(result.current.data?.engine).toBe('v2_metadata'));
    expect(callsOf('recommendation_engine')).toBe(1);

    mockRpcResults.recommendation_engine = 'v1';
    mockRpcCalls.length = 0;

    // A minute short of the window: the reader still has the engine they launched with.
    await act(async () => {
      jest.advanceTimersByTime(ENGINE_REREAD_MS - 60_000);
      await Promise.resolve();
    });
    expect(callsOf('recommendation_engine')).toBe(0);
    expect(result.current.data?.engine).toBe('v2_metadata');

    // The window passes: the engine is re-read, and the wall follows the rollback.
    await act(async () => {
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.data?.engine).toBe('v1'));
    expect(callsOf('recommendation_engine')).toBe(1);
    expect(callsOf('catalogue_candidates')).toBe(0);
    expect(slateEngines(client)).toContain('v1');
    expect(ENGINE_REREAD_MS).toBe(30 * 60_000);
  });
});
