import { waitFor } from '@testing-library/react-native';

import {
  useLoggedCollection,
  useRankedCollection,
  useWatchlist,
} from '@/features/collection/use-collection';

import type { Postgrest } from './postgrest';
import { renderHookWithProviders } from './render';
import {
  eventIds,
  feedEventRows,
  followRows,
  loggedLibrary,
  notificationRows,
  rankedLibrary,
  reactionsOn,
  userIds,
  watchlistRows,
} from './volume';

/**
 * The volume fixtures are only worth having if the readers they stand in front of accept
 * them. So this reads them back through the real hooks, at sizes past PostgREST's row cap,
 * with the cap turned on.
 */
jest.mock('@/lib/supabase', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createPostgrest } = require('@/test-utils/postgrest');
  const client = createPostgrest();
  (globalThis as { __pg?: unknown }).__pg = client;
  return { supabase: { from: client.from }, startSessionRefresh: () => () => {} };
});

const pg = () => (globalThis as unknown as { __pg: Postgrest }).__pg;
const OWNER = userIds(1)[0]!;

beforeEach(() => {
  pg().maxRows = 1000;
  pg().reads.length = 0;
});

describe('the volume fixtures', () => {
  it('are deterministic and unique', () => {
    expect(rankedLibrary(OWNER, 50)).toEqual(rankedLibrary(OWNER, 50));
    expect(new Set(eventIds(1000)).size).toBe(1000);
    expect(new Set(userIds(500)).size).toBe(500);
    expect(reactionsOn(eventIds(10), 4)).toHaveLength(40);
    expect(followRows(OWNER, 300)).toHaveLength(300);
    expect(feedEventRows(250, userIds(10))).toHaveLength(250);
    expect(notificationRows(100, userIds(3))).toHaveLength(100);
  });

  it('read back whole through the Collection readers past the 1,000-row cap', async () => {
    pg().tables.rankings = rankedLibrary(OWNER, 1200);
    pg().tables.user_media = loggedLibrary(OWNER, 1200);
    pg().tables.watchlist = watchlistRows(OWNER, 1100);

    const ranked = await renderHookWithProviders(() => useRankedCollection(OWNER, 'movies'));
    const logged = await renderHookWithProviders(() => useLoggedCollection(OWNER));
    const watchlist = await renderHookWithProviders(() => useWatchlist(OWNER));

    await waitFor(() => expect(ranked.result.current.data).toHaveLength(1200));
    expect(ranked.result.current.data!.map((entry) => entry.position)).toEqual(
      Array.from({ length: 1200 }, (_, i) => i + 1),
    );
    await waitFor(() => expect(logged.result.current.data).toBeDefined());
    await waitFor(() => expect(watchlist.result.current.data).toHaveLength(1100));
  });
});
