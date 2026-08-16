import { waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import ProfileScreen from '../../../app/(tabs)/profile';

const mockTables: Record<string, unknown[]> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const rows = () =>
        (mockTables[table] ?? []).filter((row) =>
          Object.entries(filters).every(
            ([key, value]) => (row as Record<string, unknown>)[key] === value,
          ),
        );
      const answer = () => Promise.resolve({ data: rows(), error: null, count: rows().length });
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        in: () => chain,
        // Both return the chain rather than the answer, because the queries on
        // this screen end on different links: the watchlist on `order`, the
        // feed on `limit`. The chain is itself thenable, so awaiting either
        // works.
        limit: () => chain,
        order: () => chain,
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => answer().then(resolve),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
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

const movie = (id: string, title: string) => ({
  id,
  title,
  release_date: '2010-01-01',
  poster_path: null,
  genres: ['Drama'],
  runtime_minutes: 120,
  kind: 'movie',
});

const rankedRow = (id: string, position: number) => ({
  media_item_id: id,
  position,
  bucket: 'loved',
  category: 'movies',
  user_id: 'user-1',
  media_items: movie(id, `Film ${id}`),
});

beforeEach(() => {
  for (const key of Object.keys(mockTables)) delete mockTables[key];
  mockTables.follows = [];
  mockTables.rankings = [];
  mockTables.user_media = [];
  mockTables.watchlist = [];
  mockTables.feed_events = [];
});

const open = async () => {
  const view = await renderWithProviders(<ProfileScreen />);
  // The @handle rather than the display name: the name also appears inside
  // every activity sentence once the feed loads.
  await waitFor(() => expect(view.getByText('@sai')).toBeTruthy());
  return view;
};

/** The value rendered beneath a stat's label, read off its grouped announcement. */
const stat = async (view: Awaited<ReturnType<typeof open>>, label: string) => {
  const node = await view.findByLabelText(new RegExp(`^${label}: `));
  return String(node.props.accessibilityLabel).split(': ')[1];
};

describe('the Watchlist stat', () => {
  it('counts the watchlist, not the top-ranked slice', async () => {
    // The bug: this read `top.length`, the length of the top-six ranked slice,
    // so an account with six rankings and an empty watchlist reported six.
    mockTables.rankings = [1, 2, 3, 4, 5, 6].map((n) => rankedRow(`film-${n}`, n));
    mockTables.watchlist = [{ user_id: 'user-1', media_item_id: 'w1', media_items: movie('w1', 'Saved') }];

    const view = await open();
    await waitFor(async () => expect(await stat(view, 'Watchlist')).toBe('1'));
  });

  it('reads zero with rankings and nothing saved', async () => {
    mockTables.rankings = [1, 2, 3].map((n) => rankedRow(`film-${n}`, n));

    const view = await open();
    // The bug's signature exactly: three rankings and an empty watchlist used
    // to read three, because the stat was the length of the ranked slice.
    await waitFor(async () => expect(await stat(view, 'Watchlist')).toBe('0'));
  });
});

describe('recent activity', () => {
  const activity = (id: string, actor: string, name: string) => ({
    id,
    type: 'title_ranked',
    actor_id: actor,
    media_item_id: 'film-1',
    created_at: '2026-08-15T00:00:00Z',
    payload: { position: 1, category: 'movies', bucket: 'loved', score: 9.1 },
    media_items: movie('film-1', 'Inception'),
    profiles: { username: name, display_name: name, avatar_path: null },
  });

  it('shows only this profile\u2019s own activity', async () => {
    // The feed query spans everyone the user follows. A friend's ranking under
    // a heading on your own profile is a different claim from the one the
    // heading makes.
    mockTables.feed_events = [activity('e1', 'user-1', 'Sai'), activity('e2', 'friend', 'Anna')];

    const view = await open();
    await waitFor(() => expect(view.getAllByText('Inception')).toHaveLength(1));
    expect(view.queryByText('Anna')).toBeNull();
  });

  it('says so when there is none, rather than leaving a bare heading', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('Nothing here yet')).toBeTruthy());
  });

  it('never renders an unnamed actor', async () => {
    // On one's own profile an unnamed actor is impossible by construction, so
    // an item reading "Someone" here is unambiguously a bug — and it was one,
    // on every row, until the to-one embed was read correctly.
    mockTables.feed_events = [{ ...activity('e1', 'user-1', 'Sai'), profiles: null }];

    const view = await open();
    await waitFor(() => expect(view.getByText('Nothing here yet')).toBeTruthy());
    expect(view.queryByText(/Someone/)).toBeNull();
  });
});

describe('top ranked', () => {
  it('is a poster wall of six, headed like every other section', async () => {
    mockTables.rankings = [1, 2, 3, 4, 5, 6, 7].map((n) => rankedRow(`film-${n}`, n));

    const view = await open();
    // By label, not by text: the header is uppercased in CSS, so the accessible
    // name is the sentence case one and the rendered string is not.
    await waitFor(() => expect(view.getByLabelText('Top ranked')).toBeTruthy());

    // Six, not seven: two full rows of three. A single row of a three-column
    // grid reads as a stub, and a partial third row reads as a bug.
    await waitFor(() => expect(view.queryByLabelText(/Film film-7/)).toBeNull());
    expect(view.getByLabelText(/Film film-6/)).toBeTruthy();
  });

  it('invites a first ranking when there are none', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('No rankings yet')).toBeTruthy());
  });
});
