import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import RecommendationsScreen from '../../../app/(tabs)/recommendations';

import { relativeTime } from './use-sent-to-you';

const mockPush = jest.fn();
const mockRpc = jest.fn();
let mockRpcResults: Record<string, unknown> = {};
let mockWatchlist: unknown[] = [];

/**
 * What each RPC fails with, when it is asked to. Keyed by name so one call can be made
 * to fail while the rest of the screen keeps loading — a failure that took the whole
 * screen down with it would prove nothing about what the bookmark does.
 */
let mockRpcErrors: Record<string, unknown> = {};
/**
 * How many times each table has actually been read.
 *
 * An invalidation only means something if a read follows it, so the reconciliation tests
 * assert the refetch rather than that a helper was called. Independent review 21e: the
 * mutant survived because the integration was missing, not because an assertion was weak.
 */
const mockReads: Record<string, number> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      const error = mockRpcErrors[name] ?? null;
      return Promise.resolve({ data: error ? null : (mockRpcResults[name] ?? null), error });
    },
    from: (table: string) => {
      mockReads[table] = (mockReads[table] ?? 0) + 1;
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: table === 'watchlist' ? mockWatchlist : [], error: null }),
      };
      return chain;
    },
  },
}));

jest.mock('expo-router', () => ({
  // The inbox query refetches when the screen it is on regains focus, so anything
  // rendering a bell reaches for this. A no-op here: focus is not what these test.
  useFocusEffect: () => {},
  useRouter: () => ({ push: mockPush, replace: () => {}, back: () => {} }),
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

/**
 * For You's engine is three cached queries and a scorer, and none of it is what these
 * tests are about. The wall is stood in for; the half under test is the human one and
 * the filter state the two share.
 */
const mockSlate = {
  items: [],
  candidatePool: [
    {
      mediaItemId: 'pool-1',
      title: 'A Comedy',
      seriesTitle: null,
      kind: 'movie',
      year: 2020,
      posterPath: null,
      genres: ['Comedy'],
      language: 'en',
      runtimeMinutes: null,
      score: null,
      bucket: null,
      watchedOn: null,
    },
    {
      mediaItemId: 'pool-2',
      title: 'A Horror',
      seriesTitle: null,
      kind: 'movie',
      year: 2020,
      posterPath: null,
      genres: ['Horror'],
      language: 'en',
      runtimeMinutes: null,
      score: null,
      bucket: null,
      watchedOn: null,
    },
  ],
  anchorsUsed: 0,
  lowData: true,
  taste: null,
};

jest.mock('@/features/recommendations/use-for-you', () => ({
  useForYou: () => ({
    data: mockSlate,
    isPending: false,
    isError: false,
    refetch: () => Promise.resolve(),
  }),
}));

const recommendation = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  sender_id: 'user-2',
  sender_username: 'ada',
  sender_display_name: 'Ada',
  sender_avatar_path: null,
  media_item_id: 'film-1',
  media_kind: 'movie',
  media_title: 'Inception',
  series_title: null,
  poster_path: null,
  release_date: '2010-07-16',
  genres: ['Comedy'],
  original_language: 'en',
  runtime_minutes: 148,
  recommended_at: '2026-08-15T10:00:00.000Z',
  opened_at: null,
  ...over,
});

/**
 * Sent to you is the first chip in the filter row rather than a tab of its own.
 *
 * It was a peer of the whole engine, which made the top of the screen a two-level
 * navigation for one wall. As a chip it is what it always was: a narrowing of "things
 * to watch" down to "things people sent me".
 */
const openSent = async (view: Awaited<ReturnType<typeof renderWithProviders>>) => {
  await fireEvent.press(view.getByText(/^Sent to you/));
};

beforeEach(() => {
  mockPush.mockReset();
  mockRpc.mockReset();
  mockRpcResults = { my_notifications: [], recommendations_to_me: [] };
  mockRpcErrors = {};
  mockWatchlist = [];
  for (const key of Object.keys(mockReads)) delete mockReads[key];
});

describe('the wall and the list', () => {
  it('keeps human recommendations out of the algorithmic wall', async () => {
    mockRpcResults.recommendations_to_me = [recommendation()];
    const view = await renderWithProviders(<RecommendationsScreen />);

    // The wall is showing and the friend's title is not on it. PRD §13: the engine may
    // only give reasons it can reproduce from stored signals, and a friend's opinion is
    // not one of them.
    //
    // Asserted on the category control rather than on a heading, because the headings
    // are gone: a screen reached from a tab called For you does not need a band of
    // prose saying For you.
    await waitFor(() => expect(view.getByText('Movies')).toBeTruthy());
    expect(view.queryByText('Inception')).toBeNull();
    expect(view.queryByText('For you')).toBeNull();
    expect(view.queryByText('Based on your taste')).toBeNull();
    expect(view.queryByText(/^Inspired by/)).toBeNull();
  });

  it('counts what has not been opened on the chip itself', async () => {
    mockRpcResults.recommendations_to_me = [
      recommendation(),
      recommendation({ id: 'r2', media_item_id: 'film-2', opened_at: '2026-08-16T10:00:00.000Z' }),
    ];
    const view = await renderWithProviders(<RecommendationsScreen />);

    await waitFor(() => expect(view.getByText('Sent to you · 1')).toBeTruthy());
  });

  it('names the sender and how long ago, which is what the row is for', async () => {
    mockRpcResults.recommendations_to_me = [recommendation()];
    const view = await renderWithProviders(<RecommendationsScreen />);
    await openSent(view);

    await waitFor(() => expect(view.getByText('Inception (2010)')).toBeTruthy());
    expect(view.getByText(/Ada recommended this · /)).toBeTruthy();
  });

  it('puts unopened first, in the order the server returned', async () => {
    // The server orders unopened first and newest within that. The client must not
    // re-sort: two sorts over one list is how a screen comes to disagree with the
    // count above it.
    mockRpcResults.recommendations_to_me = [
      recommendation({ id: 'r2', media_item_id: 'film-2', media_title: 'Heat' }),
      recommendation({ id: 'r1', media_item_id: 'film-1', opened_at: '2026-08-16T10:00:00.000Z' }),
    ];
    const view = await renderWithProviders(<RecommendationsScreen />);
    await openSent(view);

    await waitFor(() => expect(view.getByText('Heat (2010)')).toBeTruthy());
    // The unopened one carries the mark; the opened one does not.
    expect(view.getByTestId('sent-unopened-film-2')).toBeTruthy();
    expect(view.queryByTestId('sent-unopened-film-1')).toBeNull();
  });

  it('records the open on the way to the title, once', async () => {
    mockRpcResults.recommendations_to_me = [recommendation()];
    const view = await renderWithProviders(<RecommendationsScreen />);
    await openSent(view);

    await waitFor(() => expect(view.getByText('Inception (2010)')).toBeTruthy());
    await fireEvent.press(view.getByText('Inception (2010)'));

    // The sender and the moment travel with the link, so the title page can say so
    // over its hero without asking the server who sent it.
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/title/[id]',
      params: { id: 'film-1', recBy: 'Ada', recAt: '2026-08-15T10:00:00.000Z' },
    });
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('mark_recommendation_opened', {
        p_recommendation_id: 'r1',
      }),
    );
  });

  it('does not re-record an open for a row that has one', async () => {
    mockRpcResults.recommendations_to_me = [
      recommendation({ opened_at: '2026-08-16T10:00:00.000Z' }),
    ];
    const view = await renderWithProviders(<RecommendationsScreen />);
    await openSent(view);

    await waitFor(() => expect(view.getByText('Inception (2010)')).toBeTruthy());
    await fireEvent.press(view.getByText('Inception (2010)'));

    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ id: 'film-1' }) }),
    );
    expect(mockRpc).not.toHaveBeenCalledWith('mark_recommendation_opened', expect.anything());
  });

  it('shows the watchlist state and can change it from the row', async () => {
    mockRpcResults.recommendations_to_me = [recommendation()];
    const view = await renderWithProviders(<RecommendationsScreen />);
    await openSent(view);

    await waitFor(() =>
      expect(view.getByLabelText('Add Inception to your watchlist')).toBeTruthy(),
    );
    await fireEvent.press(view.getByLabelText('Add Inception to your watchlist'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'set_watchlist',
        expect.objectContaining({ p_media_item_id: 'film-1', p_present: true }),
      ),
    );
  });

  /**
   * **A bookmark that commits and loses its reply.**
   *
   * `set_watchlist` writes the row, the connection dies before the 200 arrives, and
   * `writes.ts` reports `{ failed, changed }` (`lib/write-outcome.ts`). This screen used
   * to alert and return before invalidating, so the title stayed saved on the server and
   * unsaved on screen, and Queue Dragon went on counting the number from before it.
   * Independent review 21e, Major 3.
   */
  it('refetches the watchlist when a save may have landed anyway', async () => {
    mockRpcResults.recommendations_to_me = [recommendation()];
    // No SQLSTATE: the request was never answered, so nothing here can tell a refusal
    // from a commit whose reply was lost.
    mockRpcErrors.set_watchlist = { code: '', message: 'TypeError: Network request failed' };

    const view = await renderWithProviders(<RecommendationsScreen />);
    await openSent(view);
    await waitFor(() =>
      expect(view.getByLabelText('Add Inception to your watchlist')).toBeTruthy(),
    );
    const before = mockReads.watchlist ?? 0;

    await fireEvent.press(view.getByLabelText('Add Inception to your watchlist'));

    await waitFor(() => expect(mockReads.watchlist ?? 0).toBeGreaterThan(before));
  });

  it('refetches it for 08007 too, which carries a code and still proves nothing', async () => {
    // The finding that reopened all of this: `transaction_resolution_unknown` is a
    // SQLSTATE whose meaning is that the outcome is unknown. The previous rule — "an
    // error with a code means the server said no" — classified this as a refusal.
    mockRpcResults.recommendations_to_me = [recommendation()];
    mockRpcErrors.set_watchlist = { code: '08007', message: 'transaction resolution unknown' };

    const view = await renderWithProviders(<RecommendationsScreen />);
    await openSent(view);
    await waitFor(() =>
      expect(view.getByLabelText('Add Inception to your watchlist')).toBeTruthy(),
    );
    const before = mockReads.watchlist ?? 0;

    await fireEvent.press(view.getByLabelText('Add Inception to your watchlist'));

    await waitFor(() => expect(mockReads.watchlist ?? 0).toBeGreaterThan(before));
  });

  it('leaves the cache alone when the server refused outright', async () => {
    // The other half of the trade: a refusal this app raises on purpose proves nothing
    // was written, and a refetch there would be a round trip bought with nothing.
    mockRpcResults.recommendations_to_me = [recommendation()];
    mockRpcErrors.set_watchlist = { code: '42501', message: 'suspended' };

    const view = await renderWithProviders(<RecommendationsScreen />);
    await openSent(view);
    await waitFor(() =>
      expect(view.getByLabelText('Add Inception to your watchlist')).toBeTruthy(),
    );
    const before = mockReads.watchlist ?? 0;

    await fireEvent.press(view.getByLabelText('Add Inception to your watchlist'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('set_watchlist', expect.anything()),
    );
    expect(mockReads.watchlist ?? 0).toBe(before);
  });

  it('says nothing has been sent rather than showing an empty list', async () => {
    const view = await renderWithProviders(<RecommendationsScreen />);
    await openSent(view);

    await waitFor(() => expect(view.getByText('Nothing sent your way yet')).toBeTruthy());
  });
});

describe('the shared filter state', () => {
  it('survives a tab change and narrows both lists', async () => {
    mockRpcResults.recommendations_to_me = [
      recommendation(),
      recommendation({
        id: 'r2',
        media_item_id: 'film-2',
        media_title: 'Hereditary',
        genres: ['Horror'],
      }),
    ];
    const view = await renderWithProviders(<RecommendationsScreen />);

    // Choose Comedy on For you.
    await fireEvent.press(view.getByText('Filters'));
    await waitFor(() => expect(view.getByText('Comedy')).toBeTruthy());
    await fireEvent.press(view.getByText('Comedy'));
    await fireEvent.press(view.getByText('Apply'));

    await waitFor(() => expect(view.getByText('Filters · 1')).toBeTruthy());

    // Switch tabs. The founder's example: Comedy stays on, and only the Comedy
    // recommendation survives.
    await openSent(view);

    await waitFor(() => expect(view.getByText('Inception (2010)')).toBeTruthy());
    expect(view.queryByText('Hereditary (2010)')).toBeNull();
    expect(view.getByText('Filters · 1')).toBeTruthy();
  });

  it('offers one obvious Clear all', async () => {
    mockRpcResults.recommendations_to_me = [
      recommendation({ id: 'r2', media_item_id: 'film-2', media_title: 'Hereditary', genres: ['Horror'] }),
    ];
    const view = await renderWithProviders(<RecommendationsScreen />);

    await fireEvent.press(view.getByText('Filters'));
    await waitFor(() => expect(view.getByText('Comedy')).toBeTruthy());
    await fireEvent.press(view.getByText('Comedy'));
    await fireEvent.press(view.getByText('Apply'));

    await openSent(view);
    // Everything is filtered out, and the empty state points at the control rather
    // than growing a second one beside it.
    await waitFor(() => expect(view.getByText('Nothing matches your filters')).toBeTruthy());
    expect(view.getAllByText('Clear all')).toHaveLength(1);

    await fireEvent.press(view.getByText('Clear all'));
    await waitFor(() => expect(view.getByText('Hereditary (2010)')).toBeTruthy());
  });

  it('does not change a recommendation by filtering it out', async () => {
    mockRpcResults.recommendations_to_me = [recommendation()];
    const view = await renderWithProviders(<RecommendationsScreen />);

    await fireEvent.press(view.getByText('Filters'));
    await waitFor(() => expect(view.getByText('Horror')).toBeTruthy());
    await fireEvent.press(view.getByText('Horror'));
    await fireEvent.press(view.getByText('Apply'));
    await openSent(view);

    await waitFor(() => expect(view.getByText('Nothing matches your filters')).toBeTruthy());
    // Filtering is a view. Nothing about it may reach the record — no open, no delete.
    expect(mockRpc).not.toHaveBeenCalledWith('mark_recommendation_opened', expect.anything());
  });
});

describe('how recently', () => {
  const now = Date.parse('2026-08-17T12:00:00.000Z');

  it('reads as an interval while the interval is the useful fact', () => {
    expect(relativeTime('2026-08-17T11:59:30.000Z', now)).toBe('just now');
    expect(relativeTime('2026-08-17T11:30:00.000Z', now)).toBe('30m ago');
    expect(relativeTime('2026-08-17T06:00:00.000Z', now)).toBe('6h ago');
    expect(relativeTime('2026-08-15T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('becomes a date once the interval has stopped meaning anything', () => {
    expect(relativeTime('2026-06-01T12:00:00.000Z', now)).toMatch(/2026/);
  });
});
