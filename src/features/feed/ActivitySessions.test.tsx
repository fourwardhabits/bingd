import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { Alert, BackHandler } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context. See app-directory.test.ts.
import FeedScreen from '../../../app/(tabs)/feed';
import { sessionSentence } from './activity';
import { sessionOf } from './use-feed';

/**
 * **Two posts per shared window, and the reader's bookmark** (founder, 2026-11-22;
 * 20261130001000).
 *
 * The Feed screen with the Supabase boundary mocked and everything above it real (the
 * harness `PosterRails.test.tsx` uses). The server's rules (the shared window, one post per
 * kind, order, privacy, pagination, the historical split) are asserted against SQL in
 * `supabase/tests/activity-sessions.test.mjs` and `session-split.test.mjs`; this is what
 * the reader sees:
 *
 *   * a window's ranking post and watchlist post as two cards, each naming its newest title
 *     ("ranked Show F + 2 more", "added Movie E + 2 more to their watchlist"), with no split
 *     line and no bare count;
 *   * the reader's own bookmark on every poster of both rails and on a single title's
 *     artwork, showing the READER's watchlist and never the author's, toggling without
 *     opening the title, guarded against a second tap while a write is in flight, and
 *     reconciled when a write's outcome is unknown;
 *   * the card's place and posters moving only on a refresh.
 */

const mockPush = jest.fn();
let mockRows: unknown[] = [];
let mockWatchlist: unknown[] = [];
let mockRpc: Record<string, unknown> = {};
type MockFn = (input: unknown) => unknown;
const mockRpcCalls: { name: string; args: Record<string, unknown> }[] = [];
const mockFromLog: string[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpcCalls.push({ name, args });
      const value = mockRpc[name];
      if (value === 'pending') return new Promise(() => {});
      // supabase-js answers a lost reply as an error, not a throw.
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
        if (table === 'watchlist') return Promise.resolve({ data: mockWatchlist, error: null });
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

const SHOW_F = { kind: 'series', title: 'Show F', release_date: '2024-04-13' };
const MOVIE_E = { kind: 'movie', title: 'Movie E', release_date: '2021-10-22' };
const HEAT = { kind: 'movie', title: 'Heat', release_date: '1995-12-15' };

const post = (
  id: string,
  type: string,
  media: Record<string, unknown>,
  {
    at,
    payload,
    name = 'Suraj',
    mediaId = `lead-${id}`,
  }: { at: string; payload: Record<string, unknown>; name?: string; mediaId?: string },
) => ({
  id,
  type,
  actor_id: 'friend',
  media_item_id: mediaId,
  created_at: at,
  causal_at: payload.last_activity_at ?? at,
  causal_step: 0,
  payload,
  media_items: {
    genres: ['Drama'],
    runtime_minutes: 120,
    season_number: null,
    parent: null,
    poster_path: null,
    backdrop_path: null,
    ...media,
  },
  profiles: { username: name.toLowerCase(), display_name: name, avatar_path: null },
});

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/** The founder's window: rankings F, D, A and saves E, C, B, one anchor. */
const rankingPost = (overrides: Record<string, unknown> = {}) =>
  post('r1', 'ranking_batch', SHOW_F, {
    at: minutesAgo(40),
    payload: {
      session: true,
      count: 3,
      ranked: 3,
      saved: 0,
      lead_action: 'ranked',
      started_at: minutesAgo(40),
      last_activity_at: minutesAgo(22),
      ...overrides,
    },
  });
const watchlistPost = (overrides: Record<string, unknown> = {}) =>
  post('w1', 'watchlist_added', MOVIE_E, {
    at: minutesAgo(36),
    payload: {
      session: true,
      count: 3,
      ranked: 0,
      saved: 3,
      lead_action: 'saved',
      started_at: minutesAgo(40),
      last_activity_at: minutesAgo(26),
      ...overrides,
    },
  });

const member = (
  eventId: string,
  ordinal: number,
  id: string,
  title: string,
  { score = null, kind = 'movie' }: { score?: number | null; kind?: string } = {},
) => ({
  event_id: eventId,
  ordinal,
  media_item_id: id,
  kind,
  title,
  season_number: null,
  release_date: '2020-01-01',
  poster_path: `/${id}.jpg`,
  parent_title: null,
  score,
  ranked: score != null,
  action: score != null ? 'ranked' : 'saved',
});

const MEMBERS = [
  member('r1', 1, 'lead-r1', 'Show F', { score: 9.1, kind: 'series' }),
  member('r1', 2, 'movie-d', 'Movie D', { score: 8.4 }),
  member('r1', 3, 'movie-a', 'Movie A', { score: 7.9 }),
  member('w1', 1, 'lead-w1', 'Movie E'),
  member('w1', 2, 'movie-c', 'Movie C'),
  member('w1', 3, 'movie-b', 'Movie B'),
];

const answer = (rows: Record<string, unknown>[]) => (args: unknown) => {
  const ids = (args as { p_event_ids: string[] }).p_event_ids;
  return rows.filter((row) => ids.includes(row.event_id as string));
};

/** The reader's own watchlist: Movie C only. */
const readerSaved = (...ids: string[]) =>
  ids.map((id) => ({
    media_item_id: id,
    created_at: minutesAgo(500),
    media_items: { title: id, kind: 'movie', release_date: '2020-01-01', poster_path: null },
  }));

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

const railOf = async (view: { getAllByTestId: (id: string) => unknown[] }, label: RegExp) =>
  waitFor(() => {
    const rails = view.getAllByTestId('feed-card-rail') as Parameters<typeof within>[0][];
    const rail = rails.find((r) => within(r).queryByLabelText(label));
    if (!rail) throw new Error('rail not loaded');
    return rail;
  });

const refresh = async (view: {
  getByTestId: (id: string) => { props: Record<string, any> };
}) => {
  const control = view.getByTestId('feed-scroll').props.refreshControl;
  await act(async () => {
    control.props.onRefresh();
  });
};

const watchlistWrites = () => mockRpcCalls.filter((c) => c.name === 'set_watchlist');

beforeEach(() => {
  mockRows = [];
  mockWatchlist = [];
  mockRpc = {};
  mockRpcCalls.length = 0;
  mockFromLog.length = 0;
  mockPush.mockClear();
  jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((() => ({ remove: () => {} })) as never);
});

describe('one window, two posts', () => {
  it('draws the ranking post and the watchlist post, each naming its newest title', async () => {
    mockRows = [rankingPost(), watchlistPost()];
    mockRpc.feed_group_previews = answer(MEMBERS);
    const view = await renderWithProviders(<FeedScreen />);
    await railOf(view, /^Show F/);
    await railOf(view, /^Movie E/);
    const text = textOf(view.toJSON());
    expect(text).toMatch(/Suraj ranked Show F \(2024\) \+ 2 more/);
    expect(text).toMatch(/Suraj added Movie E \(2021\) \+ 2 more to their watchlist/);
    // No split line and no bare count, anywhere.
    expect(text).not.toMatch(/ranked · |saved · | · \d+ saved/);
    expect(text).not.toMatch(/3 titles/);
    expect(view.getAllByTestId('feed-card')).toHaveLength(2);
  });

  it('the ranking rail carries the author’s scores; the watchlist rail carries none', async () => {
    mockRows = [rankingPost(), watchlistPost()];
    mockRpc.feed_group_previews = answer(MEMBERS);
    const view = await renderWithProviders(<FeedScreen />);
    const ranking = await railOf(view, /^Show F/);
    const watchlist = await railOf(view, /^Movie E/);
    const hidden = { includeHiddenElements: true };
    expect(within(ranking).getAllByTestId('poster-score-pill', hidden)).toHaveLength(3);
    expect(within(watchlist).queryByTestId('poster-score-pill', hidden)).toBeNull();
    // Nothing marks the author's saves.
    expect(within(watchlist).queryByTestId('poster-saved-mark', hidden)).toBeNull();
  });

  it('"+ 2 more" opens each post’s own complete list', async () => {
    mockRows = [rankingPost(), watchlistPost()];
    mockRpc.feed_group_previews = answer(MEMBERS);
    mockRpc.ranking_batch_titles = [];
    mockRpc.watchlist_group_titles = [];
    const view = await renderWithProviders(<FeedScreen />);
    await railOf(view, /^Show F/);
    // The "+" is part of the link (refined card feed, 2026-11-22): one unit, one press.
    const links = view.getAllByText('+ 2 more');
    expect(links).toHaveLength(2);
    for (const link of links) expect(link.props.accessibilityLabel).toBe('2 more');
    await fireEvent.press(links[0]!);
    await waitFor(() =>
      expect(mockRpcCalls).toContainEqual({
        name: 'ranking_batch_titles',
        args: { p_event_id: 'r1' },
      }),
    );
  });

  it('sessionSentence: one verb for one kind, no split', () => {
    expect(
      sessionSentence({ session: { leadAction: 'ranked', total: 3, ranked: 3, saved: 0 } }),
    ).toEqual({ verb: 'ranked', tail: null, more: 2, moreLabel: '2 more' });
    expect(
      sessionSentence({ session: { leadAction: 'saved', total: 3, ranked: 0, saved: 3 } }),
    ).toEqual({ verb: 'added', tail: 'to their watchlist', more: 2, moreLabel: '2 more' });
    expect(
      sessionSentence({ session: { leadAction: 'saved', total: 1, ranked: 0, saved: 1 } }),
    ).toBeNull();
    expect(
      sessionOf({ type: 'ranking_batch', created_at: 'x', payload: { count: 3 } }),
    ).toBeNull();
  });
});

describe('the reader’s bookmark', () => {
  it('is on every poster of both rails, and shows the READER’s watchlist only', async () => {
    mockRows = [rankingPost(), watchlistPost()];
    mockRpc.feed_group_previews = answer(MEMBERS);
    mockWatchlist = readerSaved('movie-c', 'movie-d');
    const view = await renderWithProviders(<FeedScreen />);
    const ranking = await railOf(view, /^Show F/);
    const watchlist = await railOf(view, /^Movie E/);
    await waitFor(() =>
      expect(
        within(watchlist).getByLabelText('Remove Movie C from your watchlist'),
      ).toBeTruthy(),
    );
    expect(within(ranking).getAllByTestId('poster-save')).toHaveLength(3);
    expect(within(watchlist).getAllByTestId('poster-save')).toHaveLength(3);
    const selected = (rail: Parameters<typeof within>[0]) =>
      within(rail)
        .getAllByTestId('poster-save')
        .map((b) => [b.props.accessibilityLabel, b.props.accessibilityState.selected]);
    expect(selected(ranking)).toEqual([
      ['Add Show F to your watchlist', false],
      ['Remove Movie D from your watchlist', true],
      ['Add Movie A to your watchlist', false],
    ]);
    // The author saved all three; only the one the READER saved is selected.
    expect(selected(watchlist)).toEqual([
      ['Add Movie E to your watchlist', false],
      ['Remove Movie C from your watchlist', true],
      ['Add Movie B to your watchlist', false],
    ]);
  });

  it('toggles inside a carousel without opening the title; the poster still opens it', async () => {
    mockRows = [rankingPost()];
    mockRpc.feed_group_previews = answer(MEMBERS);
    const view = await renderWithProviders(<FeedScreen />);
    const rail = await railOf(view, /^Show F/);
    await fireEvent.press(within(rail).getByLabelText('Add Movie D to your watchlist'));
    await waitFor(() =>
      expect(watchlistWrites().at(-1)?.args).toMatchObject({
        p_media_item_id: 'movie-d',
        p_present: true,
      }),
    );
    expect(mockPush).not.toHaveBeenCalled();
    await fireEvent.press(within(rail).getByLabelText(/^Movie D, 2020/));
    expect(mockPush).toHaveBeenLastCalledWith('/title/movie-d');
  });

  it('a second tap while a write is in flight writes nothing more', async () => {
    mockRows = [rankingPost()];
    mockRpc.feed_group_previews = answer(MEMBERS);
    mockRpc.set_watchlist = 'pending';
    const view = await renderWithProviders(<FeedScreen />);
    const rail = await railOf(view, /^Show F/);
    const target = within(rail).getByLabelText('Add Movie A to your watchlist');
    await fireEvent.press(target);
    await fireEvent.press(target);
    await fireEvent.press(within(rail).getByLabelText('Add Show F to your watchlist'));
    expect(watchlistWrites()).toHaveLength(1);
  });

  it('a write whose outcome is unknown is reconciled from the server, then reported', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockRows = [rankingPost()];
    mockRpc.feed_group_previews = answer(MEMBERS);
    mockRpc.set_watchlist = new TypeError('Network request failed');
    const view = await renderWithProviders(<FeedScreen />);
    const rail = await railOf(view, /^Show F/);
    const reads = () => mockFromLog.filter((t) => t === 'watchlist').length;
    await waitFor(() => expect(reads()).toBeGreaterThan(0));
    const before = reads();
    // The write committed on the server even though its reply was lost.
    mockWatchlist = readerSaved('movie-a');
    await fireEvent.press(within(rail).getByLabelText('Add Movie A to your watchlist'));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await waitFor(() =>
      expect(within(rail).getByLabelText('Remove Movie A from your watchlist')).toBeTruthy(),
    );
    expect(alert).toHaveBeenCalled();
    alert.mockRestore();
  });

  it('a single title’s artwork carries it top-right, with no Save under the artwork', async () => {
    mockRows = [
      post('s1', 'title_ranked', HEAT, {
        at: minutesAgo(5),
        payload: { score: 8 },
        mediaId: 'heat',
      }),
    ];
    mockWatchlist = readerSaved('heat');
    const view = await renderWithProviders(<FeedScreen />);
    const save = await waitFor(() => view.getByLabelText('Remove Heat from your watchlist'));
    expect(save.props.testID).toBe('feed-card-save');
    expect(within(view.getByTestId('feed-card-actions')).queryByText('Save')).toBeNull();
    await fireEvent.press(save);
    await waitFor(() =>
      expect(watchlistWrites().at(-1)?.args).toMatchObject({
        p_media_item_id: 'heat',
        p_present: false,
      }),
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('is not drawn on activity that is not a title', async () => {
    mockRows = [post('f1', 'follow_added', HEAT, { at: minutesAgo(5), payload: {} })];
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.queryByTestId('feed-scroll')).toBeTruthy());
    expect(view.queryByTestId('feed-card-save')).toBeNull();
    expect(view.queryByTestId('poster-save')).toBeNull();
  });
});

describe('recency', () => {
  it('moves only on a refresh: the order and the posters stay put until the reader pulls', async () => {
    const other = post('o1', 'title_ranked', HEAT, {
      at: minutesAgo(20),
      payload: { score: 8 },
      name: 'Abi',
    });
    mockRows = [other, rankingPost()];
    mockRpc.feed_group_previews = answer(MEMBERS);
    const view = await renderWithProviders(<FeedScreen />);
    await railOf(view, /^Show F/);
    const order = () =>
      view.getAllByText(/^(Abi|Suraj)$/).map((node) => String(node.props.children));
    expect(order()).toEqual(['Abi', 'Suraj']);

    // The ranking post gains a ranking on the server: it moves to the top, count unchanged
    // here, its version (last activity) moved.
    const grown = rankingPost({ last_activity_at: minutesAgo(1) });
    mockRows = [grown, other];
    const asked = mockRpcCalls.filter((c) => c.name === 'feed_group_previews').length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // No real-time jump: nothing re-read, nothing moved.
    expect(order()).toEqual(['Abi', 'Suraj']);
    expect(mockRpcCalls.filter((c) => c.name === 'feed_group_previews')).toHaveLength(asked);

    await refresh(view);
    await waitFor(() => expect(order()).toEqual(['Suraj', 'Abi']));
    await waitFor(() =>
      expect(
        mockRpcCalls.filter((c) => c.name === 'feed_group_previews').length,
      ).toBeGreaterThan(asked),
    );
    expect(view.getAllByTestId('feed-card')).toHaveLength(2);
  });

  it('a duplicate id across pages draws once (the client backstop)', async () => {
    mockRows = [rankingPost(), rankingPost()];
    mockRpc.feed_group_previews = answer(MEMBERS);
    const view = await renderWithProviders(<FeedScreen />);
    await railOf(view, /^Show F/);
    expect(view.getAllByTestId('feed-card')).toHaveLength(1);
  });
});

describe('a post 20261130000900 left mixed, until the split runs', () => {
  it('names its newest title with what was done to it, and draws no split line', async () => {
    mockRows = [rankingPost({ count: 4, ranked: 2, saved: 2, lead_action: 'saved' })];
    mockRpc.feed_group_previews = answer(MEMBERS);
    const view = await renderWithProviders(<FeedScreen />);
    await railOf(view, /^Show F/);
    const text = textOf(view.toJSON());
    expect(text).toMatch(/Suraj saved Show F \(2024\) \+ 3 more/);
    expect(text).not.toMatch(/2 ranked · 2 saved/);
  });
});
