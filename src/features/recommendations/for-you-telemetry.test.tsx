import { act, waitFor } from '@testing-library/react-native';

import { emptyFilters, type CollectionFilters } from '@/features/collection/filters';
import { renderHookWithProviders } from '@/test-utils/render';

import { resetImpressions } from './impressions';
import { resetRecommendationSession } from './session-seed';
import { useForYou } from './use-for-you';

/**
 * **What the hook reports about a wall, through the real pipeline** (Codex review of
 * #122, 2026-09-07).
 *
 * Two contracts, both derived inside `useForYou` and both easy to get wrong from a
 * mocked hook:
 *
 *   - `for_you_slate_shown` with `size: 0` means the slate query *succeeded* and the
 *     unfiltered wall drew nothing. Never while loading, never on a failed input, never
 *     for a wall the reader emptied with a filter, and once per wall key.
 *   - `popularityOnly` means the wall as drawn came from the popularity fallback alone.
 *     `anchorsUsed === 0` is not enough: `social_candidates` feeds the same pool.
 *
 * The Supabase boundary is mocked rather than the hook, so the query key, the three
 * gating inputs, the candidate reads and `select` are all real.
 */

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({ track: (...args: unknown[]) => mockTrack(...args) }));

let mockTables: Record<string, unknown[]> = {};
/** Tables whose read fails outright. */
const mockFailing = new Set<string>();
/**
 * A table whose read waits for the test to let it go. A read that never settles leaves
 * a mounted hook that cleanup cannot unwind, so the gate is released before unmount.
 */
let mockGate: { table: string; release: () => void; promise: Promise<void> } | null = null;
let mockRpcResults: Record<string, unknown> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string) =>
      Promise.resolve({ data: mockRpcResults[name] ?? null, error: null }),
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'order', 'limit']) {
        chain[method] = () => chain;
      }
      const answer = () =>
        mockFailing.has(table)
          ? { data: null, error: { code: '08006', message: 'connection failure' } }
          : { data: mockTables[table] ?? [], error: null };
      const gated = <T,>(value: () => T): Promise<T> =>
        mockGate?.table === table
          ? mockGate.promise.then(value)
          : Promise.resolve(value());
      chain.maybeSingle = () =>
        gated(() => ({ data: (mockTables[table] ?? [])[0] ?? null, error: null }));
      chain.then = (resolve: (value: unknown) => unknown) => gated(answer).then(resolve);
      return chain;
    },
  },
}));

/** A film in the catalogue, as `candidatesFor` reads one. */
const candidate = (id: string, genre = 'Drama') => ({
  id,
  title: `Title ${id}`,
  release_date: '2020-01-01',
  poster_path: null,
  kind: 'movie',
  genres: [genre],
  original_language: 'en',
  popularity: 300,
});

const slateShown = () =>
  mockTrack.mock.calls
    .filter(([event]) => (event as { name: string }).name === 'for_you_slate_shown')
    .map(([event]) => (event as { props: Record<string, unknown> }).props);

const render = (filters?: CollectionFilters) =>
  renderHookWithProviders(() => useForYou('user-1', 'movies', filters, 1));

const gate = (table: string) => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  mockGate = { table, release, promise };
};

beforeEach(() => {
  mockTrack.mockReset();
  mockTables = {};
  mockFailing.clear();
  mockGate = null;
  mockRpcResults = {};
  resetRecommendationSession();
  resetImpressions();
});

describe('an empty For You wall, as telemetry', () => {
  it('reports size 0 once when a successful unfiltered slate drew nothing', async () => {
    // No trending payload, no social candidates, no anchors: nothing to draw from.
    const { result } = await render();

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.isError).toBe(false);
    expect(result.current.data?.items).toEqual([]);
    await waitFor(() =>
      expect(slateShown()).toEqual([{ medium: 'movies', size: 0, repeat_count: 0 }]),
    );
  });

  it('reports nothing while the slate is still loading', async () => {
    gate('rankings');
    const { result, unmount } = await render();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.isPending).toBe(true);
    expect(slateShown()).toEqual([]);

    // Let the read finish before the hook goes, so nothing settles into a torn-down tree.
    await act(async () => {
      mockGate?.release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await unmount();
  });

  it('reports nothing for a slate whose input failed', async () => {
    mockFailing.add('rankings');
    const { result } = await render();

    await waitFor(() => expect(result.current.isError).toBe(true));
    await act(async () => {});
    expect(slateShown()).toEqual([]);
  });

  it('reports nothing for a wall the reader emptied with a filter', async () => {
    mockTables.provider_list_cache = [{ payload: { ids: ['pop-1'] } }];
    mockTables.media_items = [candidate('pop-1', 'Drama')];
    const filtered = { ...emptyFilters(), genres: ['Horror'] };
    const { result } = await render(filtered);

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.data?.items).toEqual([]);
    await act(async () => {});
    expect(slateShown().filter((props) => props.size === 0)).toEqual([]);

    // The same pool, unfiltered, is a wall: the filter is the only reason it was empty,
    // which is why the contract calls that the reader's doing and not the engine's.
    const plain = await render();
    await waitFor(() => expect(plain.result.current.data?.items).toHaveLength(1));
    expect(slateShown().filter((props) => props.size === 0)).toEqual([]);
  });

  it('does not repeat the report on a rerender of the same empty wall', async () => {
    const { rerender } = await render();

    await waitFor(() => expect(slateShown()).toHaveLength(1));
    await rerender(undefined);
    await act(async () => {});
    await rerender(undefined);
    await act(async () => {});

    expect(slateShown()).toHaveLength(1);
  });
});

describe('what the hook says a thin-taste wall is', () => {
  it('is popular when it came from the trending fallback alone', async () => {
    mockTables.provider_list_cache = [{ payload: { ids: ['pop-1', 'pop-2'] } }];
    mockTables.media_items = [candidate('pop-1', 'Drama'), candidate('pop-2', 'Comedy')];
    const { result } = await render();

    await waitFor(() => expect(result.current.data?.items).toHaveLength(2));

    expect(result.current.data).toMatchObject({
      anchorsUsed: 0,
      lowData: true,
      popularityOnly: true,
    });
  });

  it('is not popular when a followed reader’s title is on the wall, even with no anchor', async () => {
    mockTables.provider_list_cache = [{ payload: { ids: ['pop-1'] } }];
    mockRpcResults.social_candidates = [{ media_item_id: 'soc-1' }];
    mockTables.media_items = [candidate('pop-1', 'Drama'), candidate('soc-1', 'Comedy')];
    const { result } = await render();

    await waitFor(() => expect(result.current.data?.items).toHaveLength(2));

    // The slate is exactly what the pipeline produced — the social title is on the wall
    // because it scored onto it, not because the test put it there.
    expect(result.current.data?.items.map((item) => item.mediaItemId)).toContain('soc-1');
    expect(result.current.data).toMatchObject({
      anchorsUsed: 0,
      lowData: true,
      popularityOnly: false,
    });
  });

  it('is not popular when the social title did not make the wall', async () => {
    // Offered by `social_candidates` but not in the catalogue for this medium, so it
    // never became a candidate: the wall is the trending fallback and says so.
    mockTables.provider_list_cache = [{ payload: { ids: ['pop-1'] } }];
    mockRpcResults.social_candidates = [{ media_item_id: 'soc-missing' }];
    mockTables.media_items = [candidate('pop-1', 'Drama')];
    const { result } = await render();

    await waitFor(() => expect(result.current.data?.items).toHaveLength(1));

    expect(result.current.data).toMatchObject({ lowData: true, popularityOnly: true });
  });
});
