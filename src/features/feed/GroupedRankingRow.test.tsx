import { waitFor } from '@testing-library/react-native';
import { BackHandler } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import FeedScreen from '../../../app/(tabs)/feed';

/**
 * ---------------------------------------------------------------------------
 * **A GROUPED SITTING IS AN ORDINARY TITLE ACTIVITY** (founder, 2026-09-25)
 *
 * PR #209 deleted `RankingBatchRow` — a bespoke card that led with the actor's avatar,
 * carried no poster, and read `Ada ranked Sheroes + 2 more`. Grouped sittings render
 * through `ActivityRow` now, exactly like every other activity about a title: poster,
 * actor avatar over it, and `Ada ranked Sheroes and 2 more` with the count pressable.
 *
 * **Why this file exists.** When the founder reported that grouped posts still looked
 * bespoke in preview, nothing in the suite could answer them. `RankingBatch.test.tsx`
 * covers the expanded sheet and `use-feed.test.ts` covers the read; the *row* — the thing
 * in the screenshot — was rendered by no test at all. The report turned out to be a
 * preview device on a bundle two OTAs old, which is exactly the kind of question a test
 * should settle in a second rather than an afternoon.
 *
 * The Supabase boundary is mocked and everything above it is real, so the row here is
 * built by the same read, the same mapping and the same component as the device's.
 */

const mockPush = jest.fn();

/** One `feed_events` page, shaped exactly as staging returns it. */
let mockRows: unknown[] = [];

/**
 * What `public_scores` answers for (actor, title).
 *
 * A `ranking_batch` payload is `{count, sitting}` and carries no score, so a card that
 * shows one has borrowed the live score exactly as a pre-snapshot `title_ranked` post
 * does. That borrowing is the fix for the founder's *Solo: A Star Wars Story* report, and
 * this is the read it depends on.
 */
let mockScores: unknown[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string) =>
      Promise.resolve({
        data: name === 'public_scores' ? mockScores : [],
        error: null,
      }),
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const result = () => {
        if (table === 'follows') {
          return Promise.resolve({ data: [{ followee_id: 'friend' }], error: null });
        }
        if (table !== 'feed_events') return Promise.resolve({ data: [], error: null });
        return Promise.resolve({ data: mockRows, error: null });
      };
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        gt: () => chain,
        or: () => chain,
        order: () => chain,
        limit: () => result(),
        then: (resolve: (value: unknown) => unknown) => result().then(resolve),
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

/**
 * A finalised sitting, copied from staging rather than invented: three titles placed,
 * `Sheroes` as the representative (the last one placed), and a poster on it.
 */
const sitting = (count: number, title = 'Sheroes') => ({
  id: 'event-batch',
  type: 'ranking_batch',
  actor_id: 'friend',
  media_item_id: 'film-sheroes',
  created_at: '2026-09-25T10:00:00Z',
  causal_at: '2026-09-25T10:00:00Z',
  causal_step: 0,
  payload: { count, sitting: 'a8894097-9d29-497d-8de5-fc2d222933c6' },
  media_items: {
    kind: 'movie',
    title,
    release_date: '2023-03-23',
    poster_path: '/sheroes.jpg',
    genres: [],
    runtime_minutes: 100,
    parent: null,
  },
  profiles: { username: 'ada', display_name: 'Ada', avatar_path: '/ada.jpg' },
});

beforeEach(() => {
  mockRows = [];
  mockScores = [];
  mockPush.mockClear();
  jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((() => ({ remove: () => {} })) as never);
});

/**
 * Every image source the screen drew, which is how the artwork is proved.
 *
 * `expo-image` normalises `source` to an array before it reaches the host view, so this
 * reads both shapes rather than the one a component happens to pass.
 */
const imageUris = (json: unknown): string[] => {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
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

/**
 * The row's sentence as a reader sees it.
 *
 * `getByText` matches one element's composed text, and this sentence is assembled from
 * sibling `Text` nodes — the verb carries its own spacing, the count is its own pressable
 * — so the thing to assert is the concatenation rather than any one node.
 */
const sentence = (json: unknown): string => {
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const child of (node as { children?: unknown[] }).children ?? []) walk(child);
  };
  walk(json);
  return parts.join(' ').replace(/\s+/g, ' ');
};

it('leads a grouped sitting with the title’s poster, not the actor’s avatar', async () => {
  mockRows = [sitting(3)];
  const view = await renderWithProviders(<FeedScreen />);

  await waitFor(() => expect(view.getByText(/Sheroes/)).toBeTruthy());

  const uris = imageUris(view.toJSON());
  // The poster is the leading artwork. The bespoke row had none at all, which is the
  // whole visual difference the founder was describing.
  expect(uris.some((uri) => uri.includes('/sheroes.jpg'))).toBe(true);
  // And the actor's avatar is over it rather than instead of it.
  expect(uris.some((uri) => uri.includes('/ada.jpg'))).toBe(true);
});

it('reads “and N more”, never the old “+ N more”', async () => {
  mockRows = [sitting(3)];
  const view = await renderWithProviders(<FeedScreen />);

  await waitFor(() => expect(view.getByText(/Sheroes/)).toBeTruthy());

  expect(sentence(view.toJSON())).toContain('Ada ranked Sheroes');
  expect(sentence(view.toJSON())).toContain('and 2 more');
  // The count is the thing you press to see the rest, so it is its own control.
  expect(view.getByText('2 more')).toBeTruthy();
  // The deleted row's copy. A bundle carrying it would fail here rather than in a
  // screenshot a day later.
  expect(sentence(view.toJSON())).not.toContain('+ 2 more');
});

it('says nothing about a count when the sitting placed one title', async () => {
  mockRows = [sitting(1, 'One Ranger')];
  const view = await renderWithProviders(<FeedScreen />);

  await waitFor(() => expect(view.getByText(/One Ranger/)).toBeTruthy());

  expect(sentence(view.toJSON())).toContain('Ada ranked One Ranger');
  expect(sentence(view.toJSON())).not.toContain('more');
});

it('renders through the canonical shell whenever there is a representative title', async () => {
  /**
   * The founder's rule, stated as a test: *all* `ranking_batch` events with a valid
   * representative `media_item_id` use the ordinary shell, regardless of when the event
   * was created. There is no date, no schema version and no payload flag in the branch
   * that draws it — so an event written a month ago renders exactly as one written now,
   * and no backfill is needed for old rows.
   */
  mockRows = [
    { ...sitting(2, 'The Angel'), id: 'event-old', created_at: '2026-08-01T00:00:00Z',
      causal_at: '2026-08-01T00:00:00Z' },
  ];
  const view = await renderWithProviders(<FeedScreen />);

  await waitFor(() => expect(view.getByText(/The Angel/)).toBeTruthy());

  expect(imageUris(view.toJSON()).some((uri) => uri.includes('/sheroes.jpg'))).toBe(true);
  expect(view.getByText('1 more')).toBeTruthy();
});

/**
 * ---------------------------------------------------------------------------
 * **A SITTING OF ONE IS AN ORDINARY RANKING POST** (founder, production QA, 2026-09-25)
 *
 * Ranking a single title through the Unranked flow — *Solo: A Star Wars Story* — produced
 * a card with the poster, the avatar and the sentence of a normal ranking activity and
 * **no score badge**, because `_rank_finalize` is the only writer of a payload carrying a
 * score and a `ranking_batch` payload is `{count, sitting}`.
 *
 * A reader should not be able to tell which door a single ranking came through. Above one
 * title the representative is a stand-in for a set, so its own score on the row would read
 * as the sitting's — the grouped treatment keeps no badge and offers the tail instead.
 */
describe('the score badge on a sitting', () => {
  const liveScore = {
    user_id: 'friend',
    media_item_id: 'film-sheroes',
    score: 8.7,
    bucket: 'loved',
    position: 3,
    category: 'movies',
  };

  it('shows the live score when the sitting placed exactly one title', async () => {
    mockRows = [sitting(1, 'Solo: A Star Wars Story')];
    mockScores = [liveScore];
    const view = await renderWithProviders(<FeedScreen />);

    await waitFor(() => expect(view.getByText(/Solo/)).toBeTruthy());

    expect(view.getByLabelText('8.7 out of 10, I liked it')).toBeTruthy();
    // And nothing that says it was part of a set.
    expect(sentence(view.toJSON())).not.toContain('more');
  });

  it('keeps the grouped treatment above one title', async () => {
    mockRows = [sitting(3)];
    mockScores = [liveScore];
    const view = await renderWithProviders(<FeedScreen />);

    await waitFor(() => expect(view.getByText(/Sheroes/)).toBeTruthy());

    // No badge: the representative's own score is not the sitting's.
    expect(view.queryByLabelText('8.7 out of 10, I liked it')).toBeNull();
    expect(sentence(view.toJSON())).toContain('and 2 more');
  });

  it('draws no badge for a single sitting whose title is no longer ranked', async () => {
    // `public_scores` answers nothing, which is how "they unranked it" arrives. The post
    // still says ranked, and no number stands behind it.
    mockRows = [sitting(1, 'Solo: A Star Wars Story')];
    mockScores = [];
    const view = await renderWithProviders(<FeedScreen />);

    await waitFor(() => expect(view.getByText(/Solo/)).toBeTruthy());

    expect(view.queryByLabelText(/out of 10/)).toBeNull();
  });
});
