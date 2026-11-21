import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { BackHandler } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { RankedSummaryRow } from '@/features/ranking/RankedSummary';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context. See app-directory.test.ts.
import FeedScreen from '../../../app/(tabs)/feed';
import { sessionSentence } from './activity';
import { FeedCard } from './FeedCard';
import { sessionOf } from './use-feed';

/**
 * **An activity session is one post** (founder spec, 2026-11-21; 20261130000900).
 *
 * The Feed screen with the Supabase boundary mocked and everything above it real (the
 * harness `PosterRails.test.tsx` uses). The server's rules (windows, order, privacy,
 * pagination) are asserted against SQL in `supabase/tests/activity-sessions.test.mjs`; this
 * is what the reader sees: the newest title named with its own verb, a split that never
 * claims every title was ranked or saved, each poster's own mark, the card's place moving
 * only on a refresh, and what an older bundle's card makes of the same post.
 */

const mockPush = jest.fn();
let mockRows: unknown[] = [];
let mockRpc: Record<string, unknown> = {};
type MockFn = (input: unknown) => unknown;
const mockRpcCalls: { name: string; args: Record<string, unknown> }[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpcCalls.push({ name, args });
      const value = mockRpc[name];
      if (value === 'pending') return new Promise(() => {});
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

const KAIJU = { kind: 'series', title: 'Kaiju No. 8', release_date: '2024-04-13' };
const HEAT = { kind: 'movie', title: 'Heat', release_date: '1995-12-15' };

const post = (
  id: string,
  type: string,
  media: Record<string, unknown>,
  {
    at,
    payload,
    name = 'Suraj',
  }: { at: string; payload: Record<string, unknown>; name?: string },
) => ({
  id,
  type,
  actor_id: 'friend',
  media_item_id: `lead-${id}`,
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

/** A mixed session: 16 titles, the newest a ranking of Kaiju No. 8. */
const mixed = (overrides: Record<string, unknown> = {}) =>
  post('s1', 'ranking_batch', KAIJU, {
    at: minutesAgo(40),
    payload: {
      session: true,
      count: 16,
      ranked: 9,
      saved: 7,
      lead_action: 'ranked',
      started_at: minutesAgo(40),
      last_activity_at: minutesAgo(12),
      ...overrides,
    },
  });

const members = (eventId: string) => [
  {
    event_id: eventId,
    ordinal: 1,
    media_item_id: `lead-${eventId}`,
    kind: 'series',
    title: 'Kaiju No. 8',
    season_number: null,
    release_date: '2024-04-13',
    poster_path: '/k.jpg',
    parent_title: null,
    score: 9.1,
    ranked: true,
    action: 'ranked',
  },
  {
    event_id: eventId,
    ordinal: 2,
    media_item_id: 'arrival',
    kind: 'movie',
    title: 'Arrival',
    season_number: null,
    release_date: '2016-11-11',
    poster_path: '/a.jpg',
    parent_title: null,
    score: null,
    ranked: false,
    action: 'saved',
  },
  {
    event_id: eventId,
    ordinal: 3,
    media_item_id: 'heat',
    kind: 'movie',
    title: 'Heat',
    season_number: null,
    release_date: '1995-12-15',
    poster_path: '/h.jpg',
    parent_title: null,
    score: 8.4,
    ranked: true,
    action: 'ranked',
  },
];

const answer = (rows: Record<string, unknown>[]) => (args: unknown) => {
  const ids = (args as { p_event_ids: string[] }).p_event_ids;
  return rows.filter((row) => ids.includes(row.event_id as string));
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

const loadedRail = async (view: { getAllByTestId: (id: string) => unknown[] }, label: RegExp) =>
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

beforeEach(() => {
  mockRows = [];
  mockRpc = {};
  mockRpcCalls.length = 0;
  mockPush.mockClear();
  jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((() => ({ remove: () => {} })) as never);
});

describe('the sentence', () => {
  it('names the newest title with its own verb, counts the rest, and states the split', async () => {
    mockRows = [mixed()];
    mockRpc.feed_group_previews = answer(members('s1'));
    const view = await renderWithProviders(<FeedScreen />);
    await loadedRail(view, /^Kaiju No\. 8/);
    const text = textOf(view.toJSON());
    expect(text).toMatch(/Suraj ranked Kaiju No\. 8 \(2024\) \+ 15 more/);
    expect(text).not.toMatch(/ranked 16 titles/);
    expect(text).toMatch(/12m ago · 9 ranked · 7 saved/);
  });

  it('opens the complete list from "+ 15 more", saves marked as saves', async () => {
    mockRows = [mixed()];
    mockRpc.feed_group_previews = answer(members('s1'));
    mockRpc.ranking_batch_titles = [
      {
        media_item_id: 'lead-s1',
        title: 'Kaiju No. 8',
        position: 1,
        score: 9.1,
        bucket: 'loved',
        category: 'tv_shows',
        action: 'ranked',
      },
      {
        media_item_id: 'arrival',
        title: 'Arrival',
        position: null,
        score: null,
        bucket: null,
        category: null,
        action: 'saved',
      },
    ];
    const view = await renderWithProviders(<FeedScreen />);
    await loadedRail(view, /^Kaiju No\. 8/);
    await fireEvent.press(view.getByText('15 more'));
    await waitFor(() => expect(view.getByTestId('ranking-batch-saved-row')).toBeTruthy());
    expect(view.getByLabelText('Arrival, added to watchlist')).toBeTruthy();
    expect(view.getAllByTestId('ranked-summary-row')).toHaveLength(1);
    // A save's review is not asked for: only the ranked title's.
    await waitFor(() =>
      expect(mockRpcCalls).toContainEqual({
        name: 'public_notes',
        args: { p_user_ids: ['friend'], p_media_item_ids: ['lead-s1'], p_limit: 100 },
      }),
    );
  });

  it('each poster carries its own mark: a score when ranked, a bookmark when saved', async () => {
    mockRows = [mixed()];
    mockRpc.feed_group_previews = answer(members('s1'));
    const view = await renderWithProviders(<FeedScreen />);
    const rail = await loadedRail(view, /^Kaiju No\. 8/);
    const labels = within(rail)
      .getAllByRole('button')
      .map((tile) => tile.props.accessibilityLabel as string);
    expect(labels).toEqual([
      'Kaiju No. 8, 2024, scored 9.1 out of 10',
      'Arrival, 2016, added to watchlist',
      'Heat, 1995, scored 8.4 out of 10',
    ]);
    expect(
      within(rail).getAllByTestId('poster-saved-mark', { includeHiddenElements: true }),
    ).toHaveLength(1);
    expect(
      within(rail).getAllByTestId('poster-score-pill', { includeHiddenElements: true }),
    ).toHaveLength(2);
  });

  it.each([
    [
      'a mixed session whose newest title was saved',
      { lead_action: 'saved', ranked: 2, saved: 2, count: 4 },
      /Suraj saved Kaiju No\. 8 \(2024\) \+ 3 more/,
      /2 ranked · 2 saved/,
    ],
    [
      'saves alone',
      { lead_action: 'saved', ranked: 0, saved: 5, count: 5 },
      /Suraj added Kaiju No\. 8 \(2024\) \+ 4 more to their watchlist/,
      null,
    ],
    [
      'rankings alone',
      { lead_action: 'ranked', ranked: 7, saved: 0, count: 7 },
      /Suraj ranked Kaiju No\. 8 \(2024\) \+ 6 more/,
      null,
    ],
  ])('%s', async (_name, payload, sentence, split) => {
    mockRows = [
      mixed(payload).type === 'ranking_batch' && payload.ranked === 0
        ? { ...mixed(payload), type: 'watchlist_added' }
        : mixed(payload),
    ];
    mockRpc.feed_group_previews = answer(members('s1'));
    const view = await renderWithProviders(<FeedScreen />);
    await loadedRail(view, /^Kaiju No\. 8/);
    const text = textOf(view.toJSON());
    expect(text).toMatch(sentence);
    if (split) expect(text).toMatch(split);
    else expect(text).not.toMatch(/ranked · /);
  });

  it('sessionSentence never names a count as a verb', () => {
    expect(
      sessionSentence({ session: { leadAction: 'ranked', total: 16, ranked: 9, saved: 7 } }),
    ).toEqual({
      verb: 'ranked',
      tail: null,
      more: 15,
      moreLabel: '15 more',
      breakdown: '9 ranked · 7 saved',
    });
    expect(
      sessionSentence({ session: { leadAction: 'saved', total: 1, ranked: 0, saved: 1 } }),
    ).toBeNull();
    expect(
      sessionOf({ type: 'ranking_batch', created_at: 'x', payload: { count: 3 } }),
    ).toBeNull();
  });
});

describe('recency', () => {
  it('moves only on a refresh: the order and the posters stay put until the reader pulls', async () => {
    const other = post('o1', 'title_ranked', HEAT, {
      at: minutesAgo(20),
      payload: { score: 8 },
      name: 'Abi',
    });
    mockRows = [other, mixed()];
    mockRpc.feed_group_previews = answer(members('s1'));
    const view = await renderWithProviders(<FeedScreen />);
    await loadedRail(view, /^Kaiju No\. 8/);
    const order = () =>
      view.getAllByText(/^(Abi|Suraj)$/).map((node) => String(node.props.children));
    expect(order()).toEqual(['Abi', 'Suraj']);

    // The session gains a member on the server: it moves to the top and its newest title is
    // now a save, with the count unchanged (a title saved and then ranked does that).
    const grown = mixed({ last_activity_at: minutesAgo(1), lead_action: 'saved' });
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
    // Re-read for the new version even though the count did not change.
    await waitFor(() =>
      expect(
        mockRpcCalls.filter((c) => c.name === 'feed_group_previews').length,
      ).toBeGreaterThan(asked),
    );
    expect(textOf(view.toJSON())).toMatch(/Suraj saved Kaiju No\. 8 \(2024\) \+ 15 more/);
    expect(textOf(view.toJSON())).toMatch(/1m ago · 9 ranked · 7 saved/);
    // The card kept its identity: one session card, never a second.
    expect(view.getAllByTestId('feed-card')).toHaveLength(2);
  });

  it('a duplicate id across pages draws once (the client backstop)', async () => {
    mockRows = [mixed(), mixed()];
    mockRpc.feed_group_previews = answer(members('s1'));
    const view = await renderWithProviders(<FeedScreen />);
    await loadedRail(view, /^Kaiju No\. 8/);
    expect(view.getAllByTestId('feed-card')).toHaveLength(1);
  });
});

describe('what an older bundle draws', () => {
  /**
   * The card as the production bundles call it: no `session`, the group named by its size,
   * a rail whose saved posters simply have no score (their `readGroupPreviews` drops the
   * score of a member that is not `ranked`, and they know nothing of `action`).
   */
  it('a mixed session reads as a ranking group, with no score on a save, and does not crash', async () => {
    const view = await render(
      <FeedCard
        actorName="Suraj"
        verb="ranked"
        title="Kaiju No. 8"
        timeLabel="40m ago"
        artwork={{ treatment: 'none', uri: null } as never}
        onPressTitle={() => {}}
        reaction={{ count: 0, onPress: () => {} } as never}
        rail={{
          total: 16,
          tiles: [
            { id: 'k', title: 'Kaiju No. 8', score: 9.1 },
            { id: 'a', title: 'Arrival', score: null },
            { id: 'h', title: 'Heat', score: 8.4 },
          ],
          onPressTile: () => {},
          onPressAll: () => {},
        }}
      />,
    );
    const text = textOf(view.toJSON());
    expect(text).toMatch(/Suraj ranked 16 titles/);
    expect(text).not.toMatch(/saved/);
    expect(
      view.getAllByTestId('poster-score-pill', { includeHiddenElements: true }),
    ).toHaveLength(2);
    expect(view.queryByTestId('poster-saved-mark', { includeHiddenElements: true })).toBeNull();
  });

  it('its sheet row for a save shows the title with no standing and no score', async () => {
    const view = await render(
      <RankedSummaryRow
        title={{
          mediaItemId: 'a',
          title: 'Arrival',
          posterPath: null,
          position: null,
          score: null,
          bucket: null,
        }}
        medium="movies"
      />,
    );
    // The poster's initials and the title, and nothing else: no "#n in Movies", no score.
    const text = textOf(view.toJSON());
    expect(text).toMatch(/Arrival$/);
    expect(text).not.toMatch(/\d|#/);
  });
});
