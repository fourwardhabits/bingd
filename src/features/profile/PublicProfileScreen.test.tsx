import { waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import PublicProfileScreen from '../../../app/u/[username]';

const mockPush = jest.fn();
const tableRows: Record<string, unknown[]> = {};
let mockRpcResults: Record<string, unknown> = {};
const mockRpcCalls: { name: string; args: Record<string, unknown> }[] = [];

/**
 * The mock honours its arguments, and that is deliberate.
 *
 * Independent review pointed out that a mock ignoring what it is asked returns the
 * fixture whatever the screen requests — so `useProfileNotes` asking for the
 * *viewer's* notes instead of the subject's would still pass, which is precisely the
 * mutation a privacy test exists to catch. `rpc` records its arguments and `in`
 * filters on the ids it was given.
 */
jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpcCalls.push({ name, args });
      return Promise.resolve({ data: mockRpcResults[name] ?? null, error: null });
    },
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const inFilters: Record<string, unknown[]> = {};
      const rows = () =>
        (tableRows[table] ?? []).filter((row) => {
          const object = row as Record<string, unknown>;
          return (
            Object.entries(filters).every(([key, value]) => object[key] === value) &&
            Object.entries(inFilters).every(([key, values]) => values.includes(object[key]))
          );
        });
      const answer = () =>
        Promise.resolve({ data: rows(), error: null, count: rows().length });
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        in: (column: string, values: unknown[]) => {
          inFilters[column] = values;
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => answer().then(resolve),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useLocalSearchParams: () => ({ username: 'anna' }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'viewer', username: 'sai', display_name: 'Sai' }),
}));

const anna = {
  id: 'anna-id',
  username: 'anna',
  display_name: 'Anna',
  avatar_path: null,
  created_at: '2026-01-01T00:00:00Z',
};

const ranking = (id: string, title: string, position: number, over: Record<string, unknown> = {}) => ({
  media_item_id: id,
  bucket: 'loved',
  position,
  category: 'movies',
  user_id: 'anna-id',
  media_items: {
    title,
    release_date: '2010-01-01',
    poster_path: null,
    genres: ['Drama'],
    runtime_minutes: 120,
    kind: 'movie',
    parent: null,
  },
  ...over,
});

beforeEach(() => {
  mockPush.mockReset();
  mockRpcResults = {};
  mockRpcCalls.length = 0;
  for (const key of Object.keys(tableRows)) delete tableRows[key];
  tableRows.public_profiles = [anna];
  tableRows.rankings = [];
  tableRows.follows = [];
  tableRows.feed_events = [];
  tableRows.user_media = [];
  tableRows.media_items = [];
  tableRows.watch_tags = [];
});

const open = async () => renderWithProviders(<PublicProfileScreen />);

describe('a profile the viewer may not see', () => {
  it('answers the same way for a private account and a name nobody has taken', async () => {
    // `public_profiles` is a security_invoker view, so a private account the viewer
    // does not follow simply does not come back — and the screen must not tell the
    // two apart, because doing so discloses that the account is there (PRD §16).
    tableRows.public_profiles = [];
    const view = await open();

    await waitFor(() => expect(view.getByText('This profile is not available.')).toBeTruthy());
    expect(view.queryByText('Anna')).toBeNull();
  });
});

describe('what this person likes', () => {
  beforeEach(() => {
    tableRows.rankings = [
      ranking('a', 'Heat', 1),
      ranking('b', 'Sinners', 2),
    ];
  });

  it('leads with their titles and the scores on them', async () => {
    const view = await open();

    // Uppercasing is a style; the accessible name keeps the spelling, which is
    // what `SectionHeader` exists to get right.
    await waitFor(() => expect(view.getByLabelText('Top ranked')).toBeTruthy());
    // Two loved titles: the top of the band takes 10.0 and the bottom takes 7.0.
    await waitFor(() => expect(view.getAllByLabelText(/10\.0 out of 10/).length).toBeGreaterThan(0));
  });

  it('offers both ranked lists, because a position only means anything in its category', async () => {
    const view = await open();

    await waitFor(() => expect(view.getByRole('tab', { name: 'Movies' })).toBeTruthy());
    expect(view.getByRole('tab', { name: 'TV seasons' })).toBeTruthy();
  });

  it('names a ranked season with its show', async () => {
    tableRows.rankings = [
      ranking('s2', 'Season 2', 1, {
        category: 'movies',
        media_items: {
          title: 'Season 2',
          release_date: '2010-01-01',
          poster_path: null,
          genres: ['Comedy'],
          runtime_minutes: 22,
          kind: 'season',
          parent: { title: 'Parks and Recreation' },
        },
      }),
    ];
    const view = await open();

    await waitFor(() =>
      expect(view.getAllByText(/Parks and Recreation — Season 2/).length).toBeGreaterThan(0),
    );
  });

  it('says so plainly when they have ranked nothing', async () => {
    tableRows.rankings = [];
    const view = await open();

    await waitFor(() => expect(view.getByText('Nothing ranked yet')).toBeTruthy());
  });

  it('shows their activity without the viewer having to follow them', async () => {
    // The first version filtered the viewer's own feed, which spans the follow set
    // — so every public account the viewer had not followed showed an empty Recent
    // activity while plainly having some. `feed_events_read` was doing the
    // authorising all along; the follow set was only ever a filter.
    tableRows.feed_events = [
      {
        id: 'e1',
        type: 'title_ranked',
        actor_id: 'anna-id',
        media_item_id: 'a',
        created_at: '2026-08-15T00:00:00Z',
        payload: { position: 1, category: 'movies', bucket: 'loved', score: 9.1 },
        media_items: {
          kind: 'movie',
          title: 'Heat',
          release_date: '1995-01-01',
          poster_path: null,
          genres: ['Drama'],
          runtime_minutes: 170,
          parent: null,
        },
        profiles: { username: 'anna', display_name: 'Anna', avatar_path: null },
      },
    ];
    tableRows.follows = [];
    const view = await open();

    await waitFor(() => expect(view.getByLabelText('Recent activity')).toBeTruthy());
    expect(view.getAllByText(/Heat/).length).toBeGreaterThan(0);
  });
});

describe('their notes', () => {
  const note = {
    user_id: 'anna-id',
    media_item_id: 'film-1',
    note: 'The last twenty minutes are the whole film.',
    has_spoilers: false,
    updated_at: '2026-08-15T00:00:00Z',
  };

  beforeEach(() => {
    tableRows.media_items = [
      { id: 'film-1', kind: 'movie', title: 'Inception', poster_path: null, parent: null },
    ];
  });

  it('shows the ones they made public', async () => {
    mockRpcResults.public_notes = [note];
    const view = await open();

    await waitFor(() =>
      expect(view.getByText('The last twenty minutes are the whole film.')).toBeTruthy(),
    );
  });

  it('shows nothing at all when every note is private', async () => {
    // `public_notes` returns only public ones, so a private note is absent rather
    // than filtered here — there is no client-side rule to get wrong.
    mockRpcResults.public_notes = [];
    const view = await open();

    await waitFor(() => expect(view.getByText('Anna')).toBeTruthy());
    expect(view.queryByText('Notes')).toBeNull();
  });

  it('masks a spoiler note for a viewer who has not watched that exact title', async () => {
    mockRpcResults.public_notes = [
      { ...note, note: 'He was dead the whole time.', has_spoilers: true },
    ];
    const view = await open();

    await waitFor(() => expect(view.getByText('Contains spoilers')).toBeTruthy());
    expect(view.queryByText('He was dead the whole time.')).toBeNull();
  });

  it('shows it once the viewer has watched that exact title', async () => {
    tableRows.user_media = [{ user_id: 'viewer', media_item_id: 'film-1' }];
    mockRpcResults.public_notes = [
      { ...note, note: 'He was dead the whole time.', has_spoilers: true },
    ];
    const view = await open();

    await waitFor(() => expect(view.getByText('He was dead the whole time.')).toBeTruthy());
  });

  it('asks for the subject’s notes, not the viewer’s', async () => {
    // A mock that ignored its arguments would pass with the wrong id in the call,
    // which is the mutation that would quietly show a visitor their own notes on
    // somebody else's page.
    mockRpcResults.public_notes = [note];
    const view = await open();
    await waitFor(() => expect(view.getByText('Anna')).toBeTruthy());

    const call = mockRpcCalls.find((entry) => entry.name === 'public_notes');
    expect(call?.args.p_user_ids).toEqual(['anna-id']);
  });

  it('masks a spoiler note inside recent activity too', async () => {
    // The notes section and the activity section mask separately, so each needs
    // its own assertion — review found this one uncovered, and a `masked={false}`
    // slipped into the activity row would have leaked without failing anything.
    tableRows.feed_events = [
      {
        id: 'e1',
        type: 'title_ranked',
        actor_id: 'anna-id',
        media_item_id: 'film-1',
        created_at: '2026-08-15T00:00:00Z',
        payload: { position: 1, category: 'movies', bucket: 'loved', score: 9.1 },
        media_items: {
          kind: 'movie',
          title: 'Inception',
          release_date: '2010-01-01',
          poster_path: null,
          genres: ['Drama'],
          runtime_minutes: 148,
          parent: null,
        },
        profiles: { username: 'anna', display_name: 'Anna', avatar_path: null },
      },
    ];
    mockRpcResults.public_notes = [
      { ...note, note: 'Everyone dies at the end.', has_spoilers: true },
    ];
    const view = await open();

    await waitFor(() => expect(view.getAllByText('Contains spoilers').length).toBe(2));
    expect(view.queryByText('Everyone dies at the end.')).toBeNull();
  });

  it('does not let one season unmask another', async () => {
    // The viewer has watched Season 1. The note is on Season 2, and stays masked.
    tableRows.user_media = [{ user_id: 'viewer', media_item_id: 'season-1' }];
    tableRows.media_items = [
      {
        id: 'season-2',
        kind: 'season',
        title: 'Season 2',
        poster_path: null,
        parent: { title: 'Parks and Recreation' },
      },
    ];
    mockRpcResults.public_notes = [
      { ...note, media_item_id: 'season-2', note: 'Ben leaves.', has_spoilers: true },
    ];
    const view = await open();

    await waitFor(() => expect(view.getByText('Contains spoilers')).toBeTruthy());
    expect(view.queryByText('Ben leaves.')).toBeNull();
  });
});
