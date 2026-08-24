import { focusManager } from '@tanstack/react-query';
import { waitFor } from '@testing-library/react-native';

import { queryKeys } from '@/lib/query';
import { renderHookWithProviders } from '@/test-utils/render';

import { useTrending } from './use-trending';

type Read = { table: string; columns: string; ins: { column: string; values: unknown[] }[] };

const reads: Read[] = [];
const rows: Record<string, unknown[]> = {};
/** Errors to serve, one per read, before falling back to `rows`. */
const errors: (unknown | null)[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const read: Read = { table, columns: '', ins: [] };

      const chain = {
        select: (columns: string) => {
          read.columns = columns;
          reads.push(read);
          return chain;
        },
        in: (column: string, values: unknown[]) => {
          read.ins.push({ column, values });
          return chain;
        },
        then: (resolve: (value: unknown) => unknown) => {
          const failure = errors.length ? errors.shift() : null;
          return failure
            ? resolve({ data: null, error: failure })
            : resolve({ data: rows[table] ?? [], error: null });
        },
      };

      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

/** Well inside the week `isTooOldToShow` allows, whenever the suite runs. */
const recently = () => new Date(Date.now() - 60 * 60_000).toISOString();
const soon = () => new Date(Date.now() + 60 * 60_000).toISOString();
const justPassed = () => new Date(Date.now() - 60_000).toISOString();

const list = (listKey: string, ids: string[], over: Record<string, unknown> = {}) => ({
  list_key: listKey,
  payload: { ids },
  fetched_at: recently(),
  expires_at: soon(),
  ...over,
});

const title = (id: string, popularity: number | null) => ({
  id,
  title: id,
  release_date: '2026-01-01',
  poster_path: `/${id}.jpg`,
  popularity,
  kind: 'movie',
});

beforeEach(() => {
  reads.length = 0;
  errors.length = 0;
  for (const key of Object.keys(rows)) delete rows[key];
});

const readOf = (table: string) => reads.find((read) => read.table === table);

describe('reading the trending shelf', () => {
  it('reads the cache table and never the adapter', async () => {
    // The adapter's `trending` action is service_role and spends provider quota. A
    // client that reached it would make the TMDB bill a function of tab switches.
    rows.provider_list_cache = [];

    const { result } = await renderHookWithProviders(() => useTrending());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(readOf('provider_list_cache')).toBeDefined();
    expect(readOf('provider_list_cache')?.ins[0]?.values).toEqual([
      'trending.movie.day',
      'trending.series.day',
    ]);
  });

  it('caches under the shared key, which is how pull-to-refresh reaches it', async () => {
    // The Feed's RefreshControl cannot call this hook's `refetch` — the shelf owns it —
    // so it names the key instead (`app/(tabs)/feed.tsx`). Writing the key inline here
    // rather than through `queryKeys` is what would silently break that gesture, and it
    // would break it invisibly, because a shelf that never refreshes looks exactly like
    // a shelf with nothing new to show.
    rows.provider_list_cache = [list('trending.movie.day', ['film-1'])];
    rows.media_items = [title('film-1', 50)];

    const { result, client } = await renderHookWithProviders(() => useTrending());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(client.getQueryData(queryKeys.trending())).toBeDefined();
  });

  it('mixes the two lists into one shelf', async () => {
    rows.provider_list_cache = [
      list('trending.movie.day', ['film-1']),
      list('trending.series.day', ['show-1']),
    ];
    rows.media_items = [title('film-1', 50), title('show-1', 90)];

    const { result } = await renderHookWithProviders(() => useTrending());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.items.map((item) => item.mediaItemId)).toEqual([
      'show-1',
      'film-1',
    ]);
    expect(result.current.data?.items.map((item) => item.kind)).toEqual(['series', 'movie']);
  });

  it('drops a cached id whose title is no longer in the catalogue', async () => {
    // The payload holds ids so the metadata can expire on its own clock. The cost is
    // that the two can disagree, and a blank poster is the wrong way to show it.
    rows.provider_list_cache = [list('trending.movie.day', ['film-1', 'gone'])];
    rows.media_items = [title('film-1', 50)];

    const { result } = await renderHookWithProviders(() => useTrending());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.items.map((item) => item.mediaItemId)).toEqual(['film-1']);
  });

  it('still serves a list that has just passed its TTL, and says so', async () => {
    rows.provider_list_cache = [
      list('trending.movie.day', ['film-1'], { expires_at: justPassed() }),
    ];
    rows.media_items = [title('film-1', 50)];

    const { result } = await renderHookWithProviders(() => useTrending());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.items).toHaveLength(1);
    expect(result.current.data?.stale).toBe(true);
  });

  it('drops a list old enough that "trending now" would be false', async () => {
    rows.provider_list_cache = [
      list('trending.movie.day', ['film-1'], {
        fetched_at: '2020-01-01T00:00:00Z',
        expires_at: '2020-01-01T06:00:00Z',
      }),
    ];
    rows.media_items = [title('film-1', 50)];

    const { result } = await renderHookWithProviders(() => useTrending());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.items).toEqual([]);
  });

  it('is empty rather than broken when the adapter has never run', async () => {
    rows.provider_list_cache = [];

    const { result } = await renderHookWithProviders(() => useTrending());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({ items: [], stale: false });
  });

  /**
   * The shelf renders nothing when this read fails, and nothing is indistinguishable
   * from "there was nothing to show" — which is the right silence for a discovery strip
   * and the reason a transient failure must not be able to become permanent. The Feed
   * tab stays mounted for the life of the app, so nothing remounts to try again.
   */
  describe('after a failed read', () => {
    it('serves the list on the next attempt rather than staying empty', async () => {
      errors.push({ message: 'connection reset' });
      rows.provider_list_cache = [list('trending.movie.day', ['film-1'])];
      rows.media_items = [title('film-1', 50)];

      const { result } = await renderHookWithProviders(() => useTrending());
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.data).toBeUndefined();

      await result.current.refetch();

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.items.map((item) => item.mediaItemId)).toEqual(['film-1']);
    });

    it('asks again on its own when the app comes back to the foreground', async () => {
      // The recovery that needs no gesture. `refetchOnWindowFocus` is off by default
      // across the app and this query opts in; `startQueryFocusTracking` (lib/query.ts)
      // is what makes the event fire at all on a phone, and this stands in for it.
      //
      // A successful shelf is *not* refetched here — `staleTime` is thirty minutes and
      // focus only refetches stale data — so returning to the app costs nothing when
      // there is nothing wrong. An errored query has no data to be fresh, which is
      // precisely the state this has to get out of.
      errors.push({ message: 'connection reset' });
      rows.provider_list_cache = [list('trending.movie.day', ['film-1'])];
      rows.media_items = [title('film-1', 50)];

      const { result } = await renderHookWithProviders(() => useTrending());
      await waitFor(() => expect(result.current.isError).toBe(true));

      focusManager.setFocused(false);
      focusManager.setFocused(true);

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.items.map((item) => item.mediaItemId)).toEqual(['film-1']);
    });
  });
});
