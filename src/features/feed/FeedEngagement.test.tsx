import { fireEvent, waitFor, within } from '@testing-library/react-native';
import { BackHandler, StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { fontFamily, theme } from '@/ui/tokens';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context. See app-directory.test.ts.
import FeedScreen from '../../../app/(tabs)/feed';

/**
 * ---------------------------------------------------------------------------
 * CONSISTENT ENGAGEMENT AND WORKING "AND OTHERS" LINKS (founder, 2026-11-19)
 *
 * The Feed screen with the Supabase boundary mocked and everything above it real — the
 * harness `CinematicFeed.test.tsx` and `PosterRails.test.tsx` use. Two decisions:
 *
 *   A. every Feed post draws the same labelled Like · Comment row in equal 44pt columns,
 *      with Save and Share only on an individual title's post, where they already worked;
 *   B. "and 3 others", "and 2 more", "4 titles" and "with Anna and 2 others" read as links,
 *      open the complete list, and never open the representative title.
 */

const mockPush = jest.fn();
let mockRows: unknown[] = [];
let mockRpc: Record<string, unknown> = {};
let mockTags: unknown[] = [];
type MockFn = (input: unknown) => unknown;
const mockRpcCalls: { name: string; args: Record<string, unknown> }[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpcCalls.push({ name, args });
      const value = mockRpc[name];
      if (value === 'pending') return new Promise(() => {});
      if (value instanceof Error) return Promise.resolve({ data: null, error: value });
      const data = typeof value === 'function' ? (value as MockFn)(args) : (value ?? []);
      return Promise.resolve({ data, error: null });
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const result = () => {
        if (table === 'follows') {
          return Promise.resolve({ data: [{ followee_id: 'friend' }], error: null });
        }
        if (table === 'feed_events') return Promise.resolve({ data: mockRows, error: null });
        if (table === 'watch_tags') return Promise.resolve({ data: mockTags, error: null });
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
};

const event = (
  id: string,
  type: string,
  media: Media | null,
  {
    actor = 'friend',
    username = 'ada',
    name = 'Ada',
    payload = {},
  }: {
    actor?: string;
    username?: string;
    name?: string;
    payload?: Record<string, unknown>;
  } = {},
) => ({
  id,
  type,
  actor_id: actor,
  media_item_id: media ? `film-${id}` : null,
  created_at: '2026-11-04T10:00:00Z',
  causal_at: '2026-11-04T10:00:00Z',
  causal_step: 0,
  payload,
  media_items: media
    ? {
        release_date: '2021-10-22',
        genres: ['Drama'],
        runtime_minutes: 155,
        season_number: null,
        parent: null,
        backdrop_path: null,
        poster_path: '/p.jpg',
        ...media,
      }
    : null,
  profiles: { username, display_name: name, avatar_path: null },
});

const DUNE: Media = { kind: 'movie', title: 'Dune' };

const AWARD = {
  award: 'movie-muncher',
  tier: 'bronze',
  award_name: 'Movie Muncher',
  tier_label: 'Bronze',
};

/** The previews a call asked for, answered per event id as the server would. */
const answer = (rows: Record<string, unknown>[]) => (args: unknown) => {
  const ids = (args as { p_event_ids: string[] }).p_event_ids;
  return rows.filter((row) => ids.includes(row.event_id as string));
};

const members = (eventId: string, titles: string[]) =>
  titles.map((title, index) => ({
    event_id: eventId,
    ordinal: index + 1,
    media_item_id: index === 0 ? `film-${eventId}` : `m-${index}`,
    kind: 'movie',
    season_number: null,
    release_date: '2021-10-22',
    poster_path: `/p${index}.jpg`,
    parent_title: null,
    title,
    score: null,
    ranked: false,
  }));

const style = (node: { props: { style?: unknown } }) =>
  StyleSheet.flatten(node.props.style as never) as Record<string, unknown>;

const entity = { fontFamily: fontFamily.sansSemibold, color: theme.text.primary };

/** Every action drawn, by its test id, in the order the row draws them. */
const actionsIn = (row: Parameters<typeof within>[0], prefix: string) =>
  ['like', 'comment', 'save', 'share'].filter(
    (name) => within(row).queryByTestId(`${prefix}-${name}`) != null,
  );

beforeEach(() => {
  mockRows = [];
  mockRpc = {};
  mockTags = [];
  mockRpcCalls.length = 0;
  mockPush.mockClear();
  jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((() => ({ remove: () => {} })) as never);
});

describe('A. the same engagement row on every post', () => {
  it('an award row: labelled Like and Comment, full size, and no Save or Share', async () => {
    mockRows = [event('a1', 'award_earned', null, { payload: AWARD })];
    mockRpc.activity_comment_counts = [{ feed_event_id: 'a1', comment_count: 2 }];
    const view = await renderWithProviders(<FeedScreen />);
    const row = await waitFor(() => view.getByTestId('activity-actions'));

    expect(actionsIn(row, 'activity')).toEqual(['like', 'comment']);
    expect(within(view.getByTestId('activity-like')).getByText('Like')).toBeTruthy();
    // The count is the Comment's label once there is one, as on a card.
    await waitFor(() =>
      expect(within(view.getByTestId('activity-comment')).getByText('2')).toBeTruthy(),
    );
    for (const id of ['activity-like', 'activity-comment']) {
      const column = style(view.getByTestId(id));
      expect(column).toMatchObject({ flexGrow: 1, flexBasis: 0 });
      expect(column.minHeight).toBeGreaterThanOrEqual(44);
      expect(column.minWidth).toBeGreaterThanOrEqual(44);
    }
    // Nothing invented: an award has no watchlist write and no link to send.
    expect(view.queryByText('Save')).toBeNull();
    expect(view.queryByText('Share')).toBeNull();
    // The time left the actions line for the line under the achievement.
    expect(view.getByTestId('activity-time')).toBeTruthy();
  });

  it('an award row’s Like reacts on a tap, offers the six on a hold, and Comment opens', async () => {
    mockRows = [event('a1', 'award_earned', null, { payload: AWARD })];
    const view = await renderWithProviders(<FeedScreen />);
    const like = await waitFor(() => view.getByTestId('activity-like'));

    await fireEvent.press(like);
    await waitFor(() =>
      expect(mockRpcCalls.find((call) => call.name === 'set_reaction')?.args).toMatchObject({
        p_feed_event_id: 'a1',
        p_kind: 'love',
      }),
    );

    await fireEvent(view.getByTestId('activity-like'), 'longPress');
    await waitFor(() => expect(view.getByLabelText('Laugh')).toBeTruthy());

    await fireEvent.press(view.getByTestId('activity-comment'));
    await waitFor(() =>
      expect(mockRpcCalls.some((call) => call.name === 'activity_comments')).toBe(true),
    );
  });

  it('a goal row draws the same labelled pair', async () => {
    mockRows = [
      event('g1', 'goal_completed', null, {
        payload: { year: 2026, category: 'movies', target: 25 },
      }),
    ];
    const view = await renderWithProviders(<FeedScreen />);
    const row = await waitFor(() => view.getByTestId('activity-actions'));
    expect(actionsIn(row, 'activity')).toEqual(['like', 'comment']);
  });

  it('a grouped post drawn as its rail: Like and Comment, in equal columns', async () => {
    mockRows = [event('w1', 'watchlist_added', DUNE, { payload: { count: 3 } })];
    mockRpc.feed_group_previews = answer(members('w1', ['Dune', 'Arrival', 'Sicario']));
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => view.getByTestId('feed-card-rail'));
    const row = view.getByTestId('feed-card-actions');
    expect(actionsIn(row, 'feed-card')).toEqual(['like', 'comment']);
    const [like, comment] = ['feed-card-like', 'feed-card-comment'].map((id) =>
      style(view.getByTestId(id)),
    );
    expect(like).toEqual(comment);
    expect(like).toMatchObject({ flexGrow: 1, flexBasis: 0, justifyContent: 'center' });
  });

  /**
   * Changed on 2026-11-19: a group whose preview failed fell back to the representative
   * card *with* that title's Save and Share. Both acted on one member of a group, so a
   * group has neither, drawn as its rail or not.
   */
  it('a grouped post on its fallback card still has no Save or Share', async () => {
    mockRows = [event('w1', 'watchlist_added', DUNE, { payload: { count: 4 } })];
    mockRpc.feed_group_previews = new Error('nope');
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getByText('3 others')).toBeTruthy());
    expect(view.queryByTestId('feed-card-rail')).toBeNull();
    expect(actionsIn(view.getByTestId('feed-card-actions'), 'feed-card')).toEqual([
      'like',
      'comment',
    ]);
  });

  it('an individual title keeps all four; the reader’s own keeps all but Save', async () => {
    mockRows = [
      event('e1', 'title_ranked', DUNE),
      event('e2', 'title_ranked', DUNE, { actor: 'user-1', username: 'sai', name: 'Sai' }),
    ];
    const view = await renderWithProviders(<FeedScreen />);
    const rows = await waitFor(() => {
      const found = view.getAllByTestId('feed-card-actions');
      expect(found).toHaveLength(2);
      return found;
    });
    expect(actionsIn(rows[0]!, 'feed-card')).toEqual(['like', 'comment', 'save', 'share']);
    expect(actionsIn(rows[1]!, 'feed-card')).toEqual(['like', 'comment', 'share']);
    for (const label of ['Like', 'Comment', 'Save', 'Share']) {
      expect(within(rows[0]!).getByText(label)).toBeTruthy();
    }
  });
});

describe('B. "and others" links', () => {
  it('"and 3 others" on a grouped watchlist post is a link to the whole group', async () => {
    mockRows = [event('w1', 'watchlist_added', DUNE, { payload: { count: 4 } })];
    mockRpc.feed_group_previews = new Error('nope');
    const view = await renderWithProviders(<FeedScreen />);
    const link = await waitFor(() => view.getByTestId('feed-card-tail-link'));
    expect(link.props.children).toBe('3 others');
    expect(style(link)).toMatchObject(entity);
    expect(link.props.accessibilityRole).toBe('button');

    await fireEvent.press(link);
    await waitFor(() =>
      expect(mockRpcCalls).toContainEqual({
        name: 'watchlist_group_titles',
        args: { p_event_id: 'w1' },
      }),
    );
    // The link opened the list and nothing else: not the representative title.
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('says "1 other" for a group of two', async () => {
    mockRows = [event('w1', 'watchlist_added', DUNE, { payload: { count: 2 } })];
    mockRpc.feed_group_previews = new Error('nope');
    const view = await renderWithProviders(<FeedScreen />);
    const link = await waitFor(() => view.getByTestId('feed-card-tail-link'));
    expect(link.props.children).toBe('1 other');
  });

  it('"and 2 more" on a ranking sitting opens the sitting, not the title', async () => {
    mockRows = [event('r1', 'ranking_batch', DUNE, { payload: { count: 3, sitting: 's-1' } })];
    mockRpc.feed_group_previews = new Error('nope');
    const view = await renderWithProviders(<FeedScreen />);
    const link = await waitFor(() => view.getByTestId('feed-card-tail-link'));
    expect(link.props.children).toBe('2 more');
    expect(style(link)).toMatchObject(entity);

    await fireEvent.press(link);
    await waitFor(() =>
      expect(mockRpcCalls).toContainEqual({
        name: 'ranking_batch_titles',
        args: { p_event_id: 'r1' },
      }),
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('"4 titles" over a rail is a link to the complete list', async () => {
    mockRows = [event('w1', 'watchlist_added', DUNE, { payload: { count: 4 } })];
    mockRpc.feed_group_previews = answer(
      members('w1', ['Dune', 'Arrival', 'Sicario', 'Enemy']),
    );
    const view = await renderWithProviders(<FeedScreen />);
    const link = await waitFor(() => view.getByTestId('feed-card-group-link'));
    expect(link.props.children).toBe('4 titles');
    expect(style(link)).toMatchObject(entity);

    await fireEvent.press(link);
    await waitFor(() =>
      expect(mockRpcCalls).toContainEqual({
        name: 'watchlist_group_titles',
        args: { p_event_id: 'w1' },
      }),
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('"with Anna and 2 others" opens everyone they watched with, and nothing else', async () => {
    mockRows = [event('e1', 'title_logged', DUNE)];
    mockTags = ['Anna', 'Raj', 'Beth'].map((name) => ({
      tagger_id: 'friend',
      media_item_id: 'film-e1',
      profiles: { display_name: name, username: name.toLowerCase() },
    }));
    const view = await renderWithProviders(<FeedScreen />);
    const link = await waitFor(() => view.getByTestId('feed-card-companions-link'));
    expect(link.props.children).toBe('2 others');
    expect(style(link)).toMatchObject(entity);

    await fireEvent.press(link);
    const list = await waitFor(() => view.getByTestId('companions-sheet-list'));
    for (const name of ['Anna', 'Raj', 'Beth']) {
      expect(within(list).getByLabelText(name)).toBeTruthy();
    }
    expect(view.getByText('Ada watched with')).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('two companions are both named, with no count to open', async () => {
    mockRows = [event('e1', 'title_logged', DUNE)];
    mockTags = ['Anna', 'Raj'].map((name) => ({
      tagger_id: 'friend',
      media_item_id: 'film-e1',
      profiles: { display_name: name, username: name.toLowerCase() },
    }));
    const view = await renderWithProviders(<FeedScreen />);
    await waitFor(() => expect(view.getByText('Anna and Raj')).toBeTruthy());
    expect(view.queryByTestId('feed-card-companions-link')).toBeNull();
  });
});
