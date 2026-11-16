import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { BackHandler } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context. See app-directory.test.ts.
import FeedScreen from '../../../app/(tabs)/feed';

/**
 * **Feed poster rails** (founder spec 2026-11-16, 20261127000100).
 *
 * A grouped watchlist post or ranking sitting is drawn as a horizontal rail of its members'
 * posters; single-title activity keeps its cinematic card. The Feed screen with the
 * Supabase boundary mocked and everything above it real — the harness
 * `WatchlistGroup.test.tsx` and `CinematicFeed.test.tsx` use. Visibility, ordering, caps
 * and the author's scores are asserted against SQL in
 * `supabase/tests/feed-group-previews.test.mjs`.
 */

const mockPush = jest.fn();
let mockRows: unknown[] = [];
let mockRpc: Record<string, unknown> = {};
let mockWatched: { media_item_id: string }[] = [];
let mockReactions: unknown[] = [];
type MockFn = (input: unknown) => unknown;
const mockRpcCalls: { name: string; args: Record<string, unknown> }[] = [];
const mockFromLog: string[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpcCalls.push({ name, args });
      const value = mockRpc[name];
      // A read that never answers, to see what the card draws meanwhile.
      if (value === 'pending') return new Promise(() => {});
      if (value instanceof Error) return Promise.resolve({ data: null, error: value });
      const data = typeof value === 'function' ? (value as MockFn)(args) : (value ?? []);
      return Promise.resolve({ data, error: null });
    },
    from: (table: string) => {
      mockFromLog.push(table);
      const chain: Record<string, unknown> = {};
      const result = () => {
        if (table === 'follows') {
          return Promise.resolve({ data: [{ followee_id: 'friend' }], error: null });
        }
        if (table === 'feed_events') return Promise.resolve({ data: mockRows, error: null });
        if (table === 'user_media') return Promise.resolve({ data: mockWatched, error: null });
        if (table === 'reactions') return Promise.resolve({ data: mockReactions, error: null });
        return Promise.resolve({ data: [], error: null });
      };
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        gt: () => chain,
        or: () => chain,
        order: () => chain,
        range: () => chain,
        limit: () => result(),
        then: (resolve: (value: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          result().then(resolve, reject),
      });
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: (...a: unknown[]) => mockPush(...a), setParams: () => {} }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: (callback: () => void) => callback(),
  useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
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

jest.mock('@/lib/prefs', () => ({
  readPref: () => Promise.resolve(null),
  writePref: () => Promise.resolve(),
}));

jest.mock('@/lib/analytics', () => ({ track: () => {} }));

type Media = {
  kind: 'movie' | 'season' | 'series';
  title: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  season_number?: number | null;
  parent?: Record<string, unknown> | null;
};

const event = (
  id: string,
  type: string,
  media: Media | null,
  {
    actor = 'friend',
    username = 'ada',
    name = 'Ada',
    at = '2026-11-04T10:00:00Z',
    payload = {},
    mediaId = `film-${id}`,
  }: {
    actor?: string;
    username?: string;
    name?: string;
    at?: string;
    payload?: Record<string, unknown>;
    mediaId?: string;
  } = {},
) => ({
  id,
  type,
  actor_id: actor,
  media_item_id: media ? mediaId : null,
  created_at: at,
  causal_at: at,
  causal_step: 0,
  payload,
  media_items: media
    ? {
        release_date: '2023-07-21',
        genres: ['Drama'],
        runtime_minutes: 180,
        season_number: null,
        parent: null,
        poster_path: null,
        backdrop_path: null,
        ...media,
      }
    : null,
  profiles: { username, display_name: name, avatar_path: null },
});

const textOf = (json: unknown): string => {
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const child of (node as { children?: unknown[] }).children ?? []) walk(child);
  };
  walk(json);
  return parts.join(' ').replace(/\s+/g, ' ');
};

beforeEach(() => {
  mockRows = [];
  mockRpc = {};
  mockWatched = [];
  mockReactions = [];
  mockRpcCalls.length = 0;
  mockPush.mockClear();
  jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((() => ({ remove: () => {} })) as never);
});

const OPPENHEIMER: Media = {
  kind: 'movie',
  title: 'Oppenheimer',
  poster_path: '/opp-poster.jpg',
  backdrop_path: '/opp-backdrop.jpg',
};

const DUNE: Media = {
  kind: 'movie',
  title: 'Dune',
  poster_path: '/dune.jpg',
  backdrop_path: '/dune-wide.jpg',
};

const preview = (
  eventId: string,
  rows: Partial<Record<string, unknown>>[],
): Record<string, unknown>[] =>
  rows.map((row, index) => ({
    event_id: eventId,
    ordinal: index + 1,
    kind: 'movie',
    season_number: null,
    release_date: '2021-10-22',
    poster_path: `/p${index}.jpg`,
    parent_title: null,
    score: null,
    ranked: false,
    ...row,
  }));

const WATCHLIST_MEMBERS = preview('w1', [
  { media_item_id: 'film-w1', title: 'Dune' },
  { media_item_id: 'arrival', title: 'Arrival' },
  { media_item_id: 'sicario', title: 'Sicario' },
  { media_item_id: 'enemy', title: 'Enemy', poster_path: null },
]);

const RANKING_MEMBERS = preview('r1', [
  { media_item_id: 'film-r1', title: 'Heat', score: 9.2, ranked: true },
  {
    media_item_id: 'severance-s1',
    kind: 'season',
    title: 'Season 1',
    season_number: 1,
    parent_title: 'Severance',
    score: 9.8,
    ranked: true,
  },
  { media_item_id: 'ronin', title: 'Ronin', score: null, ranked: false },
]);

/** The rail once its posters, not its placeholders, are drawn. */
const loadedRail = async (view: { getByTestId: (id: string) => unknown }, firstLabel: RegExp) =>
  waitFor(() => {
    const rail = view.getByTestId('feed-card-rail') as Parameters<typeof within>[0];
    within(rail).getByLabelText(firstLabel);
    return rail;
  });

/** The previews a call asked for, answered per event id as the server would. */
const answer = (rows: Record<string, unknown>[]) => (args: unknown) => {
  const ids = (args as { p_event_ids: string[] }).p_event_ids;
  return rows.filter((row) => ids.includes(row.event_id as string));
};

describe('a grouped watchlist post', () => {
  it('reads "added 4 titles to their watchlist" over a rail of its posters', async () => {
    mockRows = [event('w1', 'watchlist_added', DUNE, { payload: { count: 4 } })];
    mockRpc.feed_group_previews = answer(WATCHLIST_MEMBERS);
    const view = await renderWithProviders(<FeedScreen />);
    const rail = await loadedRail(view, /^Dune/);

    expect(textOf(view.toJSON())).toMatch(/Ada added 4 titles to their watchlist/);
    const tiles = within(rail).getAllByRole('button', { name: /, 2021/ });
    expect(tiles.map((tile) => tile.props.accessibilityLabel)).toEqual([
      'Dune, 2021',
      'Arrival, 2021',
      'Sicario, 2021',
      'Enemy, 2021',
    ]);
    // A save carries no score.
    expect(
      within(rail).queryByTestId('poster-score-pill', { includeHiddenElements: true }),
    ).toBeNull();
    // The representative's artwork is not drawn as well.
    expect(view.queryByTestId('feed-card-artwork')).toBeNull();
  });

  it('opens each poster’s own title, and View all opens the complete list', async () => {
    mockRows = [event('w1', 'watchlist_added', DUNE, { payload: { count: 4 } })];
    mockRpc.feed_group_previews = answer(WATCHLIST_MEMBERS);
    mockRpc.watchlist_group_titles = [];
    const view = await renderWithProviders(<FeedScreen />);
    const rail = await loadedRail(view, /^Dune/);

    // A horizontal drag scrolls the rail and opens nothing.
    await fireEvent.scroll(view.getByTestId('feed-card-rail-scroll'), {
      nativeEvent: {
        contentOffset: { x: 240, y: 0 },
        contentSize: { width: 600, height: 150 },
        layoutMeasurement: { width: 358, height: 150 },
      },
    });
    expect(mockPush).not.toHaveBeenCalled();
    await fireEvent.press(within(rail).getByLabelText('Sicario, 2021'));
    expect(mockPush).toHaveBeenLastCalledWith('/title/sicario');
    await fireEvent.press(within(rail).getByLabelText('Arrival, 2021'));
    expect(mockPush).toHaveBeenLastCalledWith('/title/arrival');

    expect(view.getByLabelText('View all 4 titles')).toBeTruthy();
    await fireEvent.press(view.getByTestId('feed-card-view-all'));
    await waitFor(() =>
      expect(mockRpcCalls).toContainEqual({
        name: 'watchlist_group_titles',
        args: { p_event_id: 'w1' },
      }),
    );
    // Closed again, as a reader would: an open sheet holds the screen.
    await waitFor(() => expect(view.getByTestId('watchlist-group-scroll')).toBeTruthy());
    await fireEvent.press(view.getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(
        view.queryByTestId('watchlist-group-scroll', { includeHiddenElements: true }),
      ).toBeNull(),
    );
  });

  it('keeps Like and Comment, drops Save and Share, and shows only the time', async () => {
    mockRows = [event('w1', 'watchlist_added', DUNE, { payload: { count: 4 } })];
    mockRpc.feed_group_previews = answer(WATCHLIST_MEMBERS);
    mockRpc.activity_comment_counts = [{ feed_event_id: 'w1', comment_count: 3 }];
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => view.getByTestId('feed-card-rail'));

    expect(view.getAllByTestId('feed-card-like')).toHaveLength(1);
    await waitFor(() =>
      expect(view.getByLabelText(/^3 comments on Ada's activity about 4 titles/)).toBeTruthy(),
    );
    expect(view.queryByTestId('feed-card-save')).toBeNull();
    expect(view.queryByTestId('feed-card-share')).toBeNull();
    // The representative's genre and runtime describe one title, not the batch.
    expect(textOf(view.toJSON())).not.toMatch(/Drama|180m|3h/);
  });

  it('draws placeholders, already sized, while the preview loads', async () => {
    mockRows = [event('w1', 'watchlist_added', DUNE, { payload: { count: 6 } })];
    mockRpc.feed_group_previews = 'pending';
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() =>
      expect(
        view.getAllByTestId('poster-rail-placeholder', { includeHiddenElements: true }),
      ).toHaveLength(4),
    );
    expect(textOf(view.toJSON())).toMatch(/Ada added 6 titles to their watchlist/);
    expect(view.getByLabelText('View all 6 titles')).toBeTruthy();
  });
});

describe('a grouped ranking sitting', () => {
  it('reads "ranked 3 titles" and carries the author’s scores, with the season pill', async () => {
    mockRows = [
      event('r1', 'ranking_batch', DUNE, { payload: { count: 3 }, mediaId: 'film-r1' }),
    ];
    mockRpc.feed_group_previews = answer(RANKING_MEMBERS);
    const view = await renderWithProviders(<FeedScreen />);
    const rail = await loadedRail(view, /^Heat/);

    expect(textOf(view.toJSON())).toMatch(/Ada ranked 3 titles/);
    // The chips are hidden from the screen reader (the score is in each tile's label).
    const hidden = { includeHiddenElements: true };
    expect(within(rail).getByTestId('poster-score-pill', hidden)).toBeTruthy();
    expect(within(rail).getByText('9.2', hidden)).toBeTruthy();
    // A season keeps its own pill, named by its show.
    expect(within(rail).getByTestId('poster-season-pill', hidden)).toBeTruthy();
    expect(within(rail).getByText('S1 - 9.8', hidden)).toBeTruthy();
    expect(
      within(rail).getByLabelText(/^Severance, 2021, scored 9\.8 out of 10$/),
    ).toBeTruthy();
    // Unranked since: the poster stays, no number is invented.
    expect(within(rail).getByLabelText('Ronin, 2021')).toBeTruthy();
    expect(within(rail).getAllByTestId(/poster-(score|season)-pill/, hidden)).toHaveLength(2);
    // No badge on the card itself: the batch has no one score.
    expect(view.queryByTestId('feed-card-score')).toBeNull();
  });

  it('opens a member’s title, and View all opens the sitting', async () => {
    mockRows = [
      event('r1', 'ranking_batch', DUNE, { payload: { count: 3 }, mediaId: 'film-r1' }),
    ];
    mockRpc.feed_group_previews = answer(RANKING_MEMBERS);
    mockRpc.ranking_batch_titles = [];
    const view = await renderWithProviders(<FeedScreen />);
    const rail = await loadedRail(view, /^Heat/);

    await fireEvent.press(within(rail).getByLabelText(/^Severance/));
    expect(mockPush).toHaveBeenLastCalledWith('/title/severance-s1');
    await fireEvent.press(view.getByTestId('feed-card-view-all'));
    await waitFor(() =>
      expect(mockRpcCalls).toContainEqual({
        name: 'ranking_batch_titles',
        args: { p_event_id: 'r1' },
      }),
    );
    await waitFor(() => expect(view.getByTestId('ranking-batch-scroll')).toBeTruthy());
    await fireEvent.press(view.getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(
        view.queryByTestId('ranking-batch-scroll', { includeHiddenElements: true }),
      ).toBeNull(),
    );
  });
});

describe('what keeps its cinematic card', () => {
  it('a single watchlist save, a legacy post and an ordinary ranking', async () => {
    mockRows = [
      event('single', 'watchlist_added', DUNE, { payload: { count: 1 } }),
      event('legacy', 'watchlist_added', DUNE, {
        payload: {},
        mediaId: 'legacy',
        at: '2026-11-04T09:00:00Z',
      }),
      event('ranked', 'title_ranked', DUNE, { mediaId: 'ranked', at: '2026-11-04T08:00:00Z' }),
      event('sitting-of-one', 'ranking_batch', DUNE, {
        payload: { count: 1 },
        mediaId: 'one',
        at: '2026-11-04T07:00:00Z',
      }),
    ];
    mockRpc.feed_group_previews = answer([]);
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getAllByTestId('feed-card')).toHaveLength(4));
    expect(view.queryByTestId('feed-card-rail')).toBeNull();
    expect(view.getAllByTestId('feed-card-artwork')).toHaveLength(4);
    // No group on the page: the preview is never asked for.
    expect(mockRpcCalls.some((call) => call.name === 'feed_group_previews')).toBe(false);
  });
});

describe('degrading safely', () => {
  it('falls back to the representative card when the preview read fails', async () => {
    mockRows = [event('w1', 'watchlist_added', DUNE, { payload: { count: 4 } })];
    mockRpc.feed_group_previews = new Error('nope');
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getByText('3 others')).toBeTruthy());
    expect(view.queryByTestId('feed-card-rail')).toBeNull();
    expect(view.getByTestId('feed-card-artwork')).toBeTruthy();
    expect(view.getAllByTestId('feed-card-like')).toHaveLength(1);
    expect(view.getAllByTestId('feed-card-comment')).toHaveLength(1);
  });

  it('never passes a short preview off as the group: one member found reads as the card', async () => {
    mockRows = [event('w1', 'watchlist_added', DUNE, { payload: { count: 4 } })];
    mockRpc.feed_group_previews = answer(WATCHLIST_MEMBERS.slice(0, 1));
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getByText('3 others')).toBeTruthy());
    expect(view.queryByTestId('feed-card-rail')).toBeNull();
  });

  it('names the whole group even when the preview shows fewer posters than it holds', async () => {
    mockRows = [event('w1', 'watchlist_added', DUNE, { payload: { count: 30 } })];
    mockRpc.feed_group_previews = answer(WATCHLIST_MEMBERS);
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => view.getByTestId('feed-card-rail'));
    expect(textOf(view.toJSON())).toMatch(/Ada added 30 titles to their watchlist/);
    expect(view.getByLabelText('View all 30 titles')).toBeTruthy();
  });
});

describe('one read for the page', () => {
  it('asks once for every group on it, and for nothing else', async () => {
    mockRows = [
      event('w1', 'watchlist_added', DUNE, { payload: { count: 4 } }),
      event('r1', 'ranking_batch', DUNE, {
        payload: { count: 3 },
        mediaId: 'film-r1',
        at: '2026-11-04T09:00:00Z',
      }),
      event('single', 'watchlist_added', DUNE, {
        payload: { count: 1 },
        mediaId: 'solo',
        at: '2026-11-04T08:00:00Z',
      }),
    ];
    mockRpc.feed_group_previews = answer([...WATCHLIST_MEMBERS, ...RANKING_MEMBERS]);
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getAllByTestId('feed-card-rail')).toHaveLength(2));
    const calls = mockRpcCalls.filter((call) => call.name === 'feed_group_previews');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual({ p_event_ids: ['w1', 'r1'], p_limit: 12 });
  });
});

describe('refreshing', () => {
  it('pull to refresh reads the rails again, so a rerank’s new score shows', async () => {
    mockRows = [
      event('r1', 'ranking_batch', DUNE, { payload: { count: 3 }, mediaId: 'film-r1' }),
    ];
    mockRpc.feed_group_previews = answer(RANKING_MEMBERS);
    const view = await renderWithProviders(<FeedScreen />);
    await loadedRail(view, /^Heat, 2021, scored 9\.2/);

    // Reranked elsewhere: same post, same count, a new score.
    mockRpc.feed_group_previews = answer(
      RANKING_MEMBERS.map((row) =>
        row.media_item_id === 'film-r1' ? { ...row, score: 7.4 } : row,
      ),
    );
    const control = view.getByTestId('feed-scroll').props.refreshControl;
    await act(async () => {
      control.props.onRefresh();
    });
    await loadedRail(view, /^Heat, 2021, scored 7\.4/);
    // Still one post, in its place.
    expect(view.getAllByTestId('feed-card')).toHaveLength(1);
  });
});
