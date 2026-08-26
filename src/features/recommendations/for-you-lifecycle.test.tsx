import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context. See app-directory.test.ts.
import RecommendationsScreen from '../../../app/(tabs)/recommendations';

/**
 * **The skeleton on For You that never ended, on the founder's TestFlight build 4.**
 *
 * The wall stayed as six shimmering rows for the life of the process: the header drew,
 * the category selector drew, the chips drew, and the titles never arrived and never
 * failed either. No error, no retry, nothing to press.
 *
 * The cause is not a failed request. It is a request that was never made.
 * `useForYou` is scored *from* three other queries — the reader's ranked movies, their
 * ranked seasons, and what they have watched — so it gates itself on all three being
 * `isSuccess`, which is right: a slate built from `undefined` is popularity pretending to
 * be personalisation. What that misses is that `isSuccess` is not only "not yet". Once
 * any of the three settles to **error** it stays false, so the slate is never enabled,
 * never fetched, and never leaves `pending` — and `pending` is exactly what the screen
 * draws a skeleton for. Nothing retried, because from React Query's point of view nothing
 * had failed.
 *
 * So the rule these assert, which is the tranche's rule for every surface: **a query that
 * failed may not present as a query that is loading.** A source failure is the slate's
 * failure, and the retry has to re-run the request that actually broke — refetching the
 * slate would re-run a `queryFn` whose inputs are still missing.
 */

const mockReads: Record<string, number> = {};
/** Tables whose read fails, and how the failure is reported. */
const mockFailing = new Set<string>();
let mockTables: Record<string, unknown[]> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: [], error: null }),
    from: (table: string) => {
      mockReads[table] = (mockReads[table] ?? 0) + 1;
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'order', 'limit']) {
        chain[method] = () => chain;
      }
      const answer = () =>
        mockFailing.has(table)
          ? { data: null, error: { code: '08006', message: 'connection failure' } }
          : { data: mockTables[table] ?? [], error: null };
      chain.maybeSingle = () => Promise.resolve(answer());
      chain.then = (resolve: (value: unknown) => unknown) => resolve(answer());
      return chain;
    },
  },
}));

jest.mock('expo-router', () => ({
  useFocusEffect: () => {},
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({
    id: 'user-1',
    username: 'sai',
    display_name: 'Sai',
    avatar_path: null,
    avatarUri: null,
  }),
}));

beforeEach(() => {
  for (const key of Object.keys(mockReads)) delete mockReads[key];
  mockFailing.clear();
  mockTables = {};
});

describe('For You when one of the reads it is built from fails', () => {
  it('says so and offers a retry, rather than a skeleton with no end', async () => {
    // The reader's ranked movies — one of the three inputs to the slate.
    mockFailing.add('rankings');

    const view = await renderWithProviders(<RecommendationsScreen />);

    await waitFor(() => expect(view.getByText('Could not load recommendations')).toBeTruthy());
    // The defect, named: the state that used to persist forever.
    expect(view.queryByTestId('skeleton')).toBeNull();
    expect(view.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  /**
   * The retry has to re-run **the request that failed**, which is not this query.
   *
   * A retry that refetched only the slate would re-enter a `queryFn` whose inputs are
   * still missing, and the reader would press a button that could not possibly work.
   */
  it('retries the read that actually broke', async () => {
    mockFailing.add('rankings');

    const view = await renderWithProviders(<RecommendationsScreen />);
    await waitFor(() => expect(view.getByText('Could not load recommendations')).toBeTruthy());

    const before = mockReads.rankings ?? 0;
    mockFailing.clear();
    await fireEvent.press(view.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(mockReads.rankings ?? 0).toBeGreaterThan(before));
    // And recovering is the whole point: the error clears without a remount.
    await waitFor(() => expect(view.queryByText('Could not load recommendations')).toBeNull());
  });

  /**
   * The other half of the contract, and the reason the fix is not "show an error when
   * anything is undefined": an account with nothing in it is a *success* with no rows,
   * and it gets the deliberate empty state it always had.
   */
  it('still distinguishes an empty answer from a broken one', async () => {
    const view = await renderWithProviders(<RecommendationsScreen />);

    await waitFor(() => expect(view.getByText('Rank a few things first')).toBeTruthy());
    expect(view.queryByText('Could not load recommendations')).toBeNull();
    expect(view.queryByTestId('skeleton')).toBeNull();
  });
});
