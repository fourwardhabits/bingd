import { fireEvent, waitFor, within } from '@testing-library/react-native';
import { BackHandler } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context. See app-directory.test.ts.
import FeedScreen from '../../../app/(tabs)/feed';

/**
 * The Feed screen with the Supabase boundary mocked and everything above it real — the
 * read, the hydration and the card — the harness `CinematicFeed.test.tsx` uses, so a
 * grouped watchlist post is proved on the same path a phone takes.
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

/**
 * **A watchlist session is one post** (Feed Activity Grouping, 20261125000100).
 *
 * What only the client can get wrong: the sentence and its count, that the count opens
 * the members and the members open their titles, that the post keeps one reaction set and
 * one thread, and that a post written before grouping still reads as the single title it
 * always was. When a post is created and how it grows is asserted against SQL in
 * `supabase/tests/watchlist-grouping.test.mjs`.
 */
const BARBIE: Media = { kind: 'movie', title: 'Barbie' };

const members = [
  {
    media_item_id: 'film-w1',
    kind: 'movie',
    title: 'Oppenheimer',
    season_number: null,
    release_date: '2023-07-21',
    poster_path: null,
    parent_title: null,
    ordinal: 1,
  },
  {
    media_item_id: 'barbie',
    kind: 'movie',
    title: 'Barbie',
    season_number: null,
    release_date: '2023-07-21',
    poster_path: null,
    parent_title: null,
    ordinal: 2,
  },
  {
    media_item_id: 'shogun-s1',
    kind: 'season',
    title: 'Season 1',
    season_number: 1,
    release_date: '2024-02-27',
    poster_path: null,
    parent_title: 'Shōgun',
    ordinal: 3,
  },
];

describe('a grouped watchlist post on the Feed', () => {
  it('reads "added Oppenheimer and 2 others to their watchlist"', async () => {
    mockRows = [event('w1', 'watchlist_added', OPPENHEIMER, { payload: { count: 3 } })];
    const view = await renderWithProviders(<FeedScreen />);
    const card = await waitFor(() => view.getByTestId('feed-card'));

    expect(textOf(view.toJSON())).toMatch(
      /Ada added Oppenheimer \(2023\) and 2 others to their watchlist/,
    );
    expect(within(card).getByRole('button', { name: '2 others' })).toBeTruthy();
  });

  it('says "1 other" for a group of two', async () => {
    mockRows = [event('w1', 'watchlist_added', OPPENHEIMER, { payload: { count: 2 } })];
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getByText('1 other')).toBeTruthy());
    expect(view.queryByText(/others/)).toBeNull();
  });

  it('opens the members from the count, and a member opens its title page', async () => {
    mockRows = [event('w1', 'watchlist_added', OPPENHEIMER, { payload: { count: 3 } })];
    mockRpc.watchlist_group_titles = members;
    const view = await renderWithProviders(<FeedScreen />);
    fireEvent.press(await waitFor(() => view.getByText('2 others')));

    await waitFor(() => expect(view.getByTestId('watchlist-group-rows')).toBeTruthy());
    expect(mockRpcCalls).toContainEqual({
      name: 'watchlist_group_titles',
      args: { p_event_id: 'w1' },
    });
    const rows = within(view.getByTestId('watchlist-group-rows'));
    // Saved order, with year; a season named by its show.
    expect(rows.getByLabelText('Oppenheimer, 2023')).toBeTruthy();
    expect(rows.getByLabelText('Barbie, 2023')).toBeTruthy();
    expect(rows.getByLabelText('Shōgun, 2024, Season 1')).toBeTruthy();

    fireEvent.press(rows.getByLabelText('Barbie, 2023'));
    expect(mockPush).toHaveBeenCalledWith('/title/barbie');
    await waitFor(() => expect(view.queryByTestId('watchlist-group-rows')).toBeNull());
  });

  it('keeps one reaction set and one thread, on the post and nowhere in the members', async () => {
    mockRows = [event('w1', 'watchlist_added', OPPENHEIMER, { payload: { count: 3 } })];
    mockRpc.watchlist_group_titles = members;
    mockRpc.activity_comment_counts = [{ feed_event_id: 'w1', comment_count: 2 }];
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() =>
      expect(view.getByLabelText(/^2 comments on Ada's activity/)).toBeTruthy(),
    );
    expect(view.getAllByTestId('feed-card-like')).toHaveLength(1);
    expect(view.getAllByTestId('feed-card-comment')).toHaveLength(1);

    fireEvent.press(view.getByText('2 others'));
    await waitFor(() => expect(view.getByTestId('watchlist-group-rows')).toBeTruthy());
    const rows = within(view.getByTestId('watchlist-group-rows'));
    expect(rows.queryByTestId('feed-card-like')).toBeNull();
    expect(rows.queryByTestId('feed-card-comment')).toBeNull();
    expect(rows.queryByLabelText(/react/i)).toBeNull();
  });

  it('draws a post written before grouping as the single title it always was', async () => {
    // No count: a legacy post, and a one-title group, read the same way.
    mockRows = [
      event('legacy', 'watchlist_added', OPPENHEIMER, { payload: {} }),
      event('single', 'watchlist_added', BARBIE, {
        payload: { count: 1 },
        mediaId: 'barbie',
        at: '2026-11-04T09:00:00Z',
      }),
    ];
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getAllByTestId('feed-card')).toHaveLength(2));
    expect(view.queryByText(/\bothers?\b/)).toBeNull();
    expect(textOf(view.toJSON())).toMatch(/Ada added Oppenheimer \(2023\) to their watchlist/);
  });

  it('says nothing it cannot show when the member read fails', async () => {
    mockRows = [event('w1', 'watchlist_added', OPPENHEIMER, { payload: { count: 3 } })];
    mockRpc.watchlist_group_titles = new Error('denied');
    const view = await renderWithProviders(<FeedScreen />);
    fireEvent.press(await waitFor(() => view.getByText('2 others')));
    await waitFor(() => expect(view.getByText('Nothing to show here.')).toBeTruthy());
  });
});
