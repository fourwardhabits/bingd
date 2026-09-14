import { act, waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { resetImpressions } from './impressions';
import {
  SESSION_IDLE_MS,
  noteAppState,
  refreshRecommendations,
  resetRecommendationSession,
} from './session-seed';
import { useForYou } from './use-for-you';

/**
 * **For You V2 through the real hook** (2026-09-13): what a reader sees across re-renders,
 * Refresh, a short absence, a long absence, and durable exposure.
 *
 * The Supabase boundary honours filters, as in `for-you-tv.test.tsx`, so the queryFn, the
 * query key, `select` and the draw are all real.
 */

jest.mock('@/lib/analytics', () => ({ track: () => {} }));
jest.mock('@/lib/tmdb-adapter', () => ({
  AdapterError: class AdapterError extends Error {},
  cacheSimilar: () => Promise.resolve(),
}));

type Row = Record<string, unknown>;
let mockTables: Record<string, Row[]> = {};
let mockRpcResults: Record<string, unknown> = {};
let mockExposureReads = 0;
/** RPCs the backend does not have yet: they answer the way PostgREST does. */
const mockRefused = new Set<string>();
/** Names of every RPC called, in order. */
const mockCalls: string[] = [];
/** An RPC whose answer waits for the test to release it. */
let mockHeld: { name: string; release: () => void; promise: Promise<void> } | null = null;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string) => {
      mockCalls.push(name);
      if (mockHeld?.name === name) {
        const held = mockHeld;
        return held.promise.then(() => ({ data: mockRpcResults[name] ?? null, error: null }));
      }
      if (name === 'recommendation_exposure_within' || name === 'recommendation_exposure') mockExposureReads += 1;
      if (mockRefused.has(name)) {
        return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
      }
      return Promise.resolve({ data: mockRpcResults[name] ?? null, error: null });
    },
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

const GENRES = ['Drama', 'Comedy', 'Thriller', 'Action', 'Horror', 'Romance'];

/** Eighty trending films with a real popularity gradient: a pool worth drawing from. */
function seedCatalogue() {
  const films: Row[] = Array.from({ length: 80 }, (_, index) => ({
    id: `film-${String(index).padStart(2, '0')}`,
    title: `Film ${index}`,
    release_date: '2020-01-01',
    poster_path: null,
    kind: 'movie',
    genres: [GENRES[index % GENRES.length]],
    original_language: 'en',
    popularity: 500 - index * 5,
    parent_id: null,
  }));
  mockTables.media_items = films;
  mockTables.provider_list_cache = [
    { list_key: 'trending.movie.week', payload: { ids: films.map((film) => film.id) } },
  ];
}

const idsOf = (items: { mediaItemId: string }[] | undefined) => (items ?? []).map((item) => item.mediaItemId);
const overlap = (a: string[], b: string[]) => a.filter((id) => b.includes(id)).length;

beforeEach(() => {
  mockTables = {};
  mockRpcResults = {};
  mockExposureReads = 0;
  mockRefused.clear();
  mockCalls.length = 0;
  mockHeld = null;
  resetRecommendationSession(1234);
  resetImpressions();
  seedCatalogue();
});

describe('a For You session, as the reader lives it', () => {
  it('is the same wall on every re-render', async () => {
    const { result, rerender } = await renderHookWithProviders(() => useForYou('user-1', 'movies'));
    await waitFor(() => expect(result.current.data?.items).toHaveLength(20));
    const items = result.current.data!.items;

    await rerender(undefined);
    await rerender(undefined);

    expect(result.current.data!.items).toBe(items);
  });

  it('draws a genuinely new wall on Refresh, without a loading state', async () => {
    const { result } = await renderHookWithProviders(() => useForYou('user-1', 'movies'));
    await waitFor(() => expect(result.current.data?.items).toHaveLength(20));
    const first = idsOf(result.current.data!.items);

    await act(async () => {
      refreshRecommendations();
    });

    expect(result.current.isPending).toBe(false);
    const second = idsOf(result.current.data!.items);
    expect(second).toHaveLength(20);
    expect(overlap(second, first)).toBeLessThanOrEqual(4);
  });

  it('keeps the wall after a few minutes away, and draws a new one after a long absence', async () => {
    const { result } = await renderHookWithProviders(() => useForYou('user-1', 'movies'));
    await waitFor(() => expect(result.current.data?.items).toHaveLength(20));
    const first = result.current.data!.items;
    const t0 = Date.now();

    await act(async () => {
      noteAppState('background', t0);
      noteAppState('active', t0 + 5 * 60_000);
    });
    expect(result.current.data!.items).toBe(first);

    await act(async () => {
      noteAppState('background', t0 + 10 * 60_000);
      noteAppState('active', t0 + 10 * 60_000 + SESSION_IDLE_MS);
    });
    const resumed = idsOf(result.current.data!.items);
    expect(resumed).toHaveLength(20);
    expect(overlap(resumed, idsOf(first))).toBeLessThanOrEqual(4);
    // Every wall this process drew is already in the session's stamps, so the durable
    // exposure is not re-read — a re-read would redraw the wall a second time.
    expect(mockExposureReads).toBe(1);
  });

  it('keeps titles the server says were shown within the day off a new launch’s wall', async () => {
    const shownAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const recent = Array.from({ length: 20 }, (_, index) => `film-${String(index).padStart(2, '0')}`);
    mockRpcResults.recommendation_exposure_within = recent.map((id) => ({
      media_item_id: id,
      shown_count: 1,
      last_shown_at: shownAt,
    }));

    const { result } = await renderHookWithProviders(() => useForYou('user-1', 'movies'));
    // The exposure read settles independently of the slate; wait for a wall that reflects it.
    await waitFor(() => {
      expect(result.current.data?.items).toHaveLength(20);
      expect(overlap(idsOf(result.current.data!.items), recent)).toBeLessThanOrEqual(2);
    });
  });
});

describe('the durable exposure read', () => {
  const recentRows = () => {
    const shownAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    return Array.from({ length: 20 }, (_, index) => ({
      media_item_id: `film-${String(index).padStart(2, '0')}`,
      shown_count: 1,
      last_shown_at: shownAt,
    }));
  };

  it('falls back to the 72-hour reader on a backend that has not got the windowed one', async () => {
    mockRefused.add('recommendation_exposure_within');
    mockRpcResults.recommendation_exposure = recentRows();
    const recent = recentRows().map((row) => row.media_item_id);

    const { result } = await renderHookWithProviders(() => useForYou('user-1', 'movies'));
    await waitFor(() => {
      expect(result.current.data?.items).toHaveLength(20);
      expect(overlap(idsOf(result.current.data!.items), recent)).toBeLessThanOrEqual(2);
    });
    expect(mockExposureReads).toBe(2);
  });

  it('never hands back the wall on screen across Refreshes of a small pool', async () => {
    // Forty trending titles and nothing else: the shape of a new account's TV wall.
    // Consecutive Refreshes must keep producing a new wall (independent review of V2, M1).
    mockTables.media_items = (mockTables.media_items ?? []).slice(0, 40);
    mockTables.provider_list_cache = [
      { list_key: 'trending.movie.week', payload: { ids: mockTables.media_items.map((row) => row.id) } },
    ];
    const { result } = await renderHookWithProviders(() => useForYou('user-1', 'movies'));
    await waitFor(() => expect(result.current.data?.items).toHaveLength(20));

    let previous = idsOf(result.current.data!.items);
    for (let press = 0; press < 5; press += 1) {
      await act(async () => {
        refreshRecommendations();
      });
      const next = idsOf(result.current.data!.items);
      expect(next).toHaveLength(20);
      expect(overlap(next, previous)).toBeLessThanOrEqual(4);
      previous = next;
    }
  });
});

describe('recording what was seen', () => {
  it('records no impression until the durable exposure has settled', async () => {
    // Minor 4 of the review: a wall drawn before exposure arrives is redrawn a beat later, and
    // recording the first would stamp twenty titles the reader barely saw.
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockHeld = { name: 'recommendation_exposure_within', release, promise };

    const { result } = await renderHookWithProviders(() => useForYou('user-1', 'movies'));
    await waitFor(() => expect(result.current.data?.items).toHaveLength(20));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(mockCalls).not.toContain('note_recommendations_shown');

    await act(async () => {
      release();
      await promise;
    });
    await waitFor(() => expect(mockCalls).toContain('note_recommendations_shown'));
  });
});
