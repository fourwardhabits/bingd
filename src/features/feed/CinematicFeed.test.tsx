import { fireEvent, waitFor, within } from '@testing-library/react-native';
import { BackHandler } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context. See app-directory.test.ts.
import FeedScreen from '../../../app/(tabs)/feed';

/**
 * ---------------------------------------------------------------------------
 * THE CINEMATIC FEED CARD (founder-approved direction, 2026-11-04)
 *
 * The Supabase boundary is mocked and everything above it is real — the read, the
 * hydration, the masking decision and the card — so each rule below is proved on the
 * same path a phone takes. The rules are the brief's, one `it` each:
 *
 *   · artwork prefers a backdrop, a season borrows its series', and with no wide image the
 *     poster is set at its own shape rather than stretched;
 *   · a published review is shown; no review means no review area at all;
 *   · the newest comment the reader may see is previewed in the *commenter's* name, never
 *     as though the actor wrote it, and a spoiler is masked by the thread's own rule;
 *   · a card with no comments makes no comment read at all;
 *   · the four actions keep their writes — heart on tap, the six on a long press, Save to
 *     the watchlist, Share into Recommend.
 */

const mockPush = jest.fn();
let mockRows: unknown[] = [];
let mockRpc: Record<string, unknown> = {};
let mockWatched: { media_item_id: string }[] = [];
let mockReactions: unknown[] = [];
type MockFn = (input: unknown) => unknown;
const mockRpcCalls: { name: string; args: Record<string, unknown> }[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpcCalls.push({ name, args });
      const value = mockRpc[name];
      if (value instanceof Error) return Promise.resolve({ data: null, error: value });
      const data =
        typeof value === 'function' ? (value as MockFn)(args) : (value ?? []);
      return Promise.resolve({ data, error: null });
    },
    from: (table: string) => {
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

const comment = (
  id: string,
  body: string | null,
  at: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  parent_id: null,
  author_id: 'commenter',
  username: 'theo',
  display_name: 'Theo',
  avatar_path: null,
  body,
  has_spoilers: false,
  created_at: at,
  edited_at: null,
  deleted_at: body === null ? at : null,
  reaction_count: 0,
  reacted_by_me: false,
  reaction_kinds: [],
  my_reaction: null,
  mentions: [],
  ...extra,
});

const imageUris = (json: unknown): string[] => {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object') return;
    const n = node as { props?: Record<string, unknown>; children?: unknown[] };
    const source = n.props?.source;
    for (const entry of Array.isArray(source) ? source : [source]) {
      const uri = (entry as { uri?: string } | undefined)?.uri;
      if (uri) out.push(uri);
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(json);
  return out;
};

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

describe('artwork', () => {
  it('leads a ranking with the title’s backdrop and the score on it', async () => {
    mockRows = [
      event('e1', 'title_ranked', OPPENHEIMER, {
        payload: { score: 9.2, bucket: 'loved', category: 'movies', position: 3 },
      }),
    ];
    mockRpc.public_scores = [
      { user_id: 'friend', media_item_id: 'film-e1', score: 9.2, bucket: 'loved', position: 3, category: 'movies' },
    ];
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getByTestId('feed-card-score')).toBeTruthy());

    const uris = imageUris(view.toJSON());
    expect(uris.some((uri) => uri.endsWith('/w780/opp-backdrop.jpg'))).toBe(true);
    expect(view.queryByTestId('feed-card-poster-fallback')).toBeNull();
    expect(view.getByLabelText('9.2 out of 10, I liked it')).toBeTruthy();
  });

  it('borrows the series backdrop for a TV season, which has none of its own', async () => {
    mockRows = [
      event(
        'e2',
        'title_ranked',
        {
          kind: 'season',
          title: 'Season 1',
          season_number: 1,
          poster_path: '/tlou-s1.jpg',
          backdrop_path: null,
          parent: {
            title: 'The Last of Us',
            genres: ['Drama'],
            original_language: 'en',
            certification: 'TV-MA',
            backdrop_path: '/tlou-backdrop.jpg',
            poster_path: '/tlou.jpg',
          },
        },
        { payload: { score: 9.6, bucket: 'loved', category: 'tv_seasons' } },
      ),
    ];
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getByText(/The Last of Us, S1/)).toBeTruthy());

    expect(imageUris(view.toJSON()).some((uri) => uri.endsWith('/tlou-backdrop.jpg'))).toBe(true);
  });

  it('sets the poster at its own shape when there is no wide image, never stretched', async () => {
    mockRows = [event('e3', 'title_logged', { kind: 'movie', title: 'Whiplash', poster_path: '/whip.jpg' })];
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getByTestId('feed-card-poster-fallback')).toBeTruthy());

    const uris = imageUris(view.toJSON());
    // The blurred field and the sharp poster are the same picture; no backdrop URL at all.
    expect(uris.filter((uri) => uri.endsWith('/whip.jpg')).length).toBeGreaterThanOrEqual(2);
    expect(uris.some((uri) => uri.includes('/w780/'))).toBe(false);
  });

  it('keeps a card for a title with no artwork at all', async () => {
    mockRows = [event('e4', 'title_logged', { kind: 'movie', title: 'Harold and the Unposted Print' })];
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getByTestId('feed-card-poster-fallback')).toBeTruthy());
    expect(view.getByTestId('feed-card-artwork')).toBeTruthy();
  });
});

describe('reviews', () => {
  it('shows a published review under the artwork', async () => {
    mockRows = [event('e1', 'title_ranked', OPPENHEIMER)];
    mockRpc.public_notes = [
      { user_id: 'friend', media_item_id: 'film-e1', note: 'Three hours that felt like one.', has_spoilers: false },
    ];
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getByText(/Three hours that felt like one/)).toBeTruthy());
  });

  it('masks a spoiler review for a reader who has not seen the title', async () => {
    mockRows = [event('e1', 'title_ranked', OPPENHEIMER)];
    mockRpc.public_notes = [
      { user_id: 'friend', media_item_id: 'film-e1', note: 'The ending is a dream.', has_spoilers: true },
    ];
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getByLabelText(/Contains spoilers for Oppenheimer/)).toBeTruthy());
    expect(view.queryByText(/The ending is a dream/)).toBeNull();
  });

  it('draws no review area at all without a review', async () => {
    mockRows = [event('e1', 'title_ranked', OPPENHEIMER)];
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getByTestId('feed-card-artwork')).toBeTruthy());
    expect(view.queryByText(/Contains spoilers/)).toBeNull();
    expect(view.queryByLabelText(/Show the whole review/)).toBeNull();
  });
});

describe('the latest-comment preview', () => {
  const withComments = (rows: unknown[], count = rows.length) => {
    mockRpc.activity_comment_counts = [{ feed_event_id: 'e1', comment_count: count }];
    mockRpc.activity_comments = rows;
  };

  it('previews the newest comment in the commenter’s name, with “View all”', async () => {
    mockRows = [event('e1', 'title_ranked', OPPENHEIMER)];
    withComments([
      comment('c1', 'First!', '2026-11-04T10:05:00Z'),
      comment('c2', 'Top 3?? We need to talk.', '2026-11-04T10:09:00Z', {
        parent_id: 'c1',
        author_id: 'priya',
        username: 'priyan',
        display_name: 'Priya',
      }),
    ]);
    const view = await renderWithProviders(<FeedScreen />);
    const preview = await waitFor(() => view.getByTestId('feed-card-latest-comment'));

    const said = textOf(preview);
    // The reply is the newest thing said, and it is Priya's — not Ada's.
    expect(said).toContain('Priya');
    expect(said).toContain('Top 3?? We need to talk.');
    expect(said).not.toContain('Ada');
    expect(said).toContain('View all 2 comments');
  });

  it('opens the existing conversation when tapped', async () => {
    mockRows = [event('e1', 'title_ranked', OPPENHEIMER)];
    withComments([comment('c1', 'Top 3?? We need to talk.', '2026-11-04T10:09:00Z')]);
    const view = await renderWithProviders(<FeedScreen />);
    const preview = await waitFor(() => view.getByTestId('feed-card-latest-comment'));

    expect(view.queryByPlaceholderText('Add a comment')).toBeNull();
    fireEvent.press(preview);
    await waitFor(() => expect(view.getByPlaceholderText('Add a comment')).toBeTruthy());
  });

  it('drops a preview the conversation no longer contains once the thread is read', async () => {
    // Loaded, then withdrawn (or its author went private to this reader) before the
    // conversation is opened. The thread's fresh read is the newer answer.
    mockRows = [event('e1', 'title_ranked', OPPENHEIMER)];
    withComments([comment('c1', 'Soon to be withdrawn.', '2026-11-04T10:09:00Z')]);
    const view = await renderWithProviders(<FeedScreen />);
    const preview = await waitFor(() => view.getByTestId('feed-card-latest-comment'));
    expect(textOf(preview)).toContain('Soon to be withdrawn.');
    // Sanity: the hidden-element query does find a preview while one exists.
    expect(view.queryByTestId('feed-card-latest-comment', { includeHiddenElements: true })).toBeTruthy();

    mockRpc.activity_comments = [];
    fireEvent.press(view.getByTestId('feed-card-comment'));
    await waitFor(() => expect(view.getByPlaceholderText('Add a comment')).toBeTruthy());

    // Behind the open sheet, which hides the Feed from default queries — so look there too.
    const hidden = { includeHiddenElements: true };
    await waitFor(() =>
      expect(view.queryByTestId('feed-card-latest-comment', hidden)).toBeNull(),
    );
    expect(view.queryByText(/Soon to be withdrawn/, hidden)).toBeNull();
  });

  it('skips a retracted comment and previews the one before it', async () => {
    mockRows = [event('e1', 'title_ranked', OPPENHEIMER)];
    withComments(
      [comment('c1', 'Still here.', '2026-11-04T10:05:00Z'), comment('c2', null, '2026-11-04T10:09:00Z')],
      1,
    );
    const view = await renderWithProviders(<FeedScreen />);
    const preview = await waitFor(() => view.getByTestId('feed-card-latest-comment'));
    expect(textOf(preview)).toContain('Still here.');
  });

  it('masks a spoiler comment for a reader who has not seen the title', async () => {
    mockRows = [event('e1', 'title_ranked', OPPENHEIMER)];
    withComments([
      comment('c1', 'He builds the bomb.', '2026-11-04T10:09:00Z', { has_spoilers: true }),
    ]);
    const view = await renderWithProviders(<FeedScreen />);
    const preview = await waitFor(() => view.getByTestId('feed-card-latest-comment'));
    expect(textOf(preview)).toContain('Contains spoilers');
    expect(textOf(preview)).not.toContain('He builds the bomb.');
  });

  it('shows a spoiler comment to a reader who has seen the title', async () => {
    mockRows = [event('e1', 'title_ranked', OPPENHEIMER)];
    mockWatched = [{ media_item_id: 'film-e1' }];
    withComments([
      comment('c1', 'He builds the bomb.', '2026-11-04T10:09:00Z', { has_spoilers: true }),
    ]);
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(textOf(view.getByTestId('feed-card-latest-comment'))).toContain('He builds the bomb.'));
  });

  it('draws no preview when the comment read fails, rather than anything cached', async () => {
    mockRows = [event('e1', 'title_ranked', OPPENHEIMER)];
    mockRpc.activity_comment_counts = [{ feed_event_id: 'e1', comment_count: 1 }];
    mockRpc.activity_comments = new Error('offline');
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() =>
      expect(mockRpcCalls.some((call) => call.name === 'activity_comments')).toBe(true),
    );
    expect(view.queryByTestId('feed-card-latest-comment')).toBeNull();
    // The count still says there is a conversation to open.
    expect(view.getByTestId('feed-card-comment')).toBeTruthy();
  });

  it('never previews a reply whose root the server withheld', async () => {
    mockRows = [event('e1', 'title_ranked', OPPENHEIMER)];
    withComments([
      comment('c1', 'An earlier remark.', '2026-11-04T10:01:00Z'),
      comment('c2', 'Replying to someone you cannot see.', '2026-11-04T10:09:00Z', {
        parent_id: 'hidden-root',
      }),
    ]);
    const view = await renderWithProviders(<FeedScreen />);
    const preview = await waitFor(() => view.getByTestId('feed-card-latest-comment'));
    expect(textOf(preview)).toContain('An earlier remark.');
    expect(textOf(preview)).not.toContain('Replying to someone you cannot see.');
  });

  it('makes no comment read for a card with no comments, and draws no preview', async () => {
    mockRows = [event('e1', 'title_ranked', OPPENHEIMER)];
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getByTestId('feed-card-artwork')).toBeTruthy());
    await waitFor(() =>
      expect(mockRpcCalls.some((call) => call.name === 'activity_comment_counts')).toBe(true),
    );

    expect(mockRpcCalls.some((call) => call.name === 'activity_comments')).toBe(false);
    expect(view.queryByTestId('feed-card-latest-comment')).toBeNull();
  });
});

describe('the actions', () => {
  it('likes on a tap, and opens the six on a long press', async () => {
    mockRows = [event('e1', 'title_ranked', OPPENHEIMER)];
    const view = await renderWithProviders(<FeedScreen />);
    const like = await waitFor(() => view.getByTestId('feed-card-like'));

    fireEvent.press(like);
    await waitFor(() =>
      expect(mockRpcCalls.find((call) => call.name === 'set_reaction')?.args).toMatchObject({
        p_feed_event_id: 'e1',
        p_kind: 'love',
      }),
    );

    fireEvent(like, 'longPress');
    await waitFor(() => expect(view.getByLabelText('Funny')).toBeTruthy());
  });

  it('shows who reacted above the actions', async () => {
    mockRows = [event('e1', 'title_ranked', OPPENHEIMER)];
    mockReactions = [
      { feed_event_id: 'e1', user_id: 'theo', kind: 'love', profiles: { id: 'theo', username: 'theo', display_name: 'Theo', avatar_path: null } },
      { feed_event_id: 'e1', user_id: 'priya', kind: 'funny', profiles: { id: 'priya', username: 'priyan', display_name: 'Priya', avatar_path: null } },
    ];
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getByLabelText('2 reactions. See who reacted.')).toBeTruthy());
  });

  it('saves to the watchlist and shares into Recommend', async () => {
    mockRows = [event('e1', 'watchlist_added', OPPENHEIMER)];
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getByTestId('feed-card-save')).toBeTruthy());

    expect(textOf(view.toJSON())).toContain('to their watchlist');
    // A watchlist add states no score.
    expect(view.queryByTestId('feed-card-score')).toBeNull();

    fireEvent.press(view.getByTestId('feed-card-save'));
    await waitFor(() =>
      expect(mockRpcCalls.find((call) => call.name === 'set_watchlist')?.args).toMatchObject({
        p_media_item_id: 'film-e1',
        p_present: true,
      }),
    );

    expect(view.getByTestId('feed-card-share')).toBeTruthy();
  });

  it('offers no Save on the reader’s own activity', async () => {
    mockRows = [event('e1', 'title_ranked', OPPENHEIMER, { actor: 'user-1', username: 'sai', name: 'Sai' })];
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getByTestId('feed-card-like')).toBeTruthy());
    expect(view.queryByTestId('feed-card-save')).toBeNull();
  });

  it('opens the title from the artwork', async () => {
    mockRows = [event('e1', 'title_ranked', OPPENHEIMER)];
    const view = await renderWithProviders(<FeedScreen />);
    fireEvent.press(await waitFor(() => view.getByTestId('feed-card-artwork')));
    expect(mockPush).toHaveBeenCalledWith('/title/film-e1');
  });
});

it('never truncates the sentence that holds a sitting’s “and N more”', async () => {
  mockRows = [
    event('e1', 'ranking_batch', { kind: 'movie', title: 'Keep Your Hands Off Eizouken! The Extended Edition', poster_path: '/k.jpg' }, {
      name: 'Suraj Kandukuri',
      payload: { count: 3, sitting: 's-1' },
    }),
  ];
  const view = await renderWithProviders(<FeedScreen />);
  const more = await waitFor(() => view.getByText('2 more'));
  // Every Text between the control and the card: none may clamp lines.
  type Node = { props?: Record<string, unknown>; parent?: Node | null };
  let node: Node | null = more as unknown as Node;
  while (node && node.props?.testID !== 'feed-scroll') {
    expect(node.props?.numberOfLines).toBeUndefined();
    node = node.parent ?? null;
  }
});

it('keeps the feed’s order, and awards keep their compact row', async () => {
  mockRows = [
    event('e1', 'title_ranked', OPPENHEIMER, { at: '2026-11-04T12:00:00Z' }),
    event('e2', 'award_earned', null, {
      at: '2026-11-04T11:00:00Z',
      payload: { award: 'movie-muncher', tier: 'bronze', award_name: 'Movie Muncher', tier_label: 'Bronze' },
    }),
    event('e3', 'watchlist_added', { kind: 'movie', title: 'Whiplash', poster_path: '/whip.jpg' }, { at: '2026-11-04T10:00:00Z' }),
  ];
  const view = await renderWithProviders(<FeedScreen />);
  await waitFor(() => expect(view.getAllByTestId('feed-card-artwork')).toHaveLength(2));

  const said = textOf(view.toJSON());
  expect(said.indexOf('Oppenheimer')).toBeLessThan(said.indexOf('earned the'));
  expect(said.indexOf('earned the')).toBeLessThan(said.indexOf('Whiplash'));
  // One activity, one card: nothing doubled.
  expect(within(view.getByTestId('feed-scroll')).getAllByLabelText(/^Oppenheimer, 2023/)).toHaveLength(1);
});
