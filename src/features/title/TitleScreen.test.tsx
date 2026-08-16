import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import TitleScreen from '../../../app/title/[id]';

const mockPush = jest.fn();
const tableRows: Record<string, unknown[]> = {};
let mockRpcResults: Record<string, unknown> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string) => Promise.resolve({ data: mockRpcResults[name] ?? null, error: null }),
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const rows = () => {
        const source = tableRows[table] ?? [];
        return source.filter((row) => {
          const object = row as Record<string, unknown>;
          return Object.entries(filters).every(([key, value]) => object[key] === value);
        });
      };
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        in: () => chain,
        filter: () => chain,
        order: () => Promise.resolve({ data: rows(), error: null }),
        limit: () => chain,
        single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        // `count` as well as `data`: `useCredits` first asks whether the cache has
        // any rows at all, with a head-only count query, and a mock that answered
        // only `data` made every cast list read as empty.
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: rows(), error: null, count: rows().length }),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useLocalSearchParams: () => ({ id: 'film-1' }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

// The screen fetches missing metadata on open. Not what these tests are about,
// and it would otherwise reach the adapter.
jest.mock('@/features/title/use-enrichment', () => ({
  useTitleEnrichment: () => ({ enriching: false }),
}));

const film = {
  id: 'film-1',
  kind: 'movie',
  title: 'Inception',
  release_date: '2010-07-16',
  runtime_minutes: 148,
  overview: 'A thief who steals corporate secrets through dream-sharing technology.',
  poster_path: null,
  backdrop_path: '/backdrop.jpg',
  genres: ['Science Fiction', 'Action'],
  provenance: 'tmdb',
  tmdb_id: 27205,
  original_language: 'en',
  parent: null,
};

const credits = {
  media_item_id: 'film-1',
  facet: 'credits',
  payload: {
    cast: [
      { id: 6193, name: 'Leonardo DiCaprio', character: 'Cobb', profile_path: '/leo.jpg' },
      { id: 24045, name: 'Joseph Gordon-Levitt', character: 'Arthur', profile_path: null },
    ],
    crew: [{ id: 525, name: 'Christopher Nolan', job: 'Director', department: 'Directing' }],
  },
};

beforeEach(() => {
  mockPush.mockReset();
  mockRpcResults = {};
  for (const key of Object.keys(tableRows)) delete tableRows[key];
  tableRows.media_items = [film];
  tableRows.user_media = [];
  tableRows.rankings = [];
  tableRows.watchlist = [];
  tableRows.media_cache = [];
  tableRows.watch_tags = [];
  tableRows.public_profiles = [];
});

const open = async () => {
  const view = await renderWithProviders(<TitleScreen />);
  await waitFor(() => expect(view.getByText('Inception')).toBeTruthy());
  return view;
};

describe('a title nobody has ranked', () => {
  it('makes the badge itself the way in, with no second Rank button beside it', async () => {
    const view = await open();

    // The founder's device test found a button and a badge doing the same job.
    // The badge is the control: dashed, labelled, and the only one.
    expect(view.getByLabelText('Not ranked. Rank this title.')).toBeTruthy();
    expect(view.queryByLabelText('Rank this title')).toBeNull();
    expect(view.queryByLabelText('Ranked. Rank again.')).toBeNull();
  });

  it('puts the genres under the description rather than over the artwork', async () => {
    const view = await open();
    expect(view.getByText('Science Fiction')).toBeTruthy();
  });

  it('does not put the ordinal anywhere', async () => {
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Details' }));

    expect(view.queryByText(/#\d/)).toBeNull();
  });
});

describe('a title this user has ranked', () => {
  beforeEach(() => {
    tableRows.rankings = [
      { user_id: 'user-1', media_item_id: 'film-1', position: 1, category: 'movies', bucket: 'loved' },
      { user_id: 'user-1', media_item_id: 'other', position: 2, category: 'movies', bucket: 'loved' },
    ];
    tableRows.user_media = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        bucket: 'loved',
        watched_on: '2026-08-12',
        note: 'Held up better than I expected.',
        note_has_spoilers: false,
      },
    ];
  });

  it('shows the score, not the position', async () => {
    const view = await open();

    // Top of a two-title Loved band, so the band's high.
    await waitFor(() => expect(view.getByLabelText('10.0 out of 10, Loved it')).toBeTruthy());
  });

  it('says where it sits in their own list, as an ordinal', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('#1 in Movies')).toBeTruthy());
  });

  it('puts the watch date where it answers "have I seen this"', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText(/Watched/)).toBeTruthy());
  });

  it('keeps the ordinal with its denominator in Details', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByRole('tab', { name: 'Details' })).toBeTruthy());
    await fireEvent.press(view.getByRole('tab', { name: 'Details' }));

    // "#1" alone is unreadable — one of how many? (PRD §10.)
    await waitFor(() => expect(view.getByText('#1 of 2 in Movies')).toBeTruthy());
  });
});

/**
 * Your score beside everyone else's (founder amendment, 2026-08-16). The two rules
 * that matter: the aggregate is never called a rank, and a sample too small to mean
 * anything shows its size instead of a number.
 */
describe('the community score', () => {
  it('shows the number and the sample size once there are enough ratings', async () => {
    mockRpcResults.community_score = [{ score: '7.4', rating_count: 12, min_ratings: 3 }];
    const view = await open();

    await waitFor(() => expect(view.getByText('7.4')).toBeTruthy());
    expect(view.getByText('Community')).toBeTruthy();
    expect(view.getByText('12 ratings')).toBeTruthy();
  });

  it('never calls the aggregate a rank', async () => {
    mockRpcResults.community_score = [{ score: '7.4', rating_count: 12, min_ratings: 3 }];
    const view = await open();

    await waitFor(() => expect(view.getByText('Community')).toBeTruthy());
    // It is a mean. An ordinal is what "#1 in Movies" is, and that is a different
    // line about a different thing.
    expect(view.queryByText(/community rank/i)).toBeNull();
  });

  it('withholds a number the sample cannot support, and says how short it is', async () => {
    mockRpcResults.community_score = [{ score: null, rating_count: 2, min_ratings: 3 }];
    const view = await open();

    await waitFor(() => expect(view.getByText('2 so far · 1 more')).toBeTruthy());
    expect(view.queryByText('0.0')).toBeNull();
  });

  it('says plainly when nobody has rated it', async () => {
    mockRpcResults.community_score = [{ score: null, rating_count: 0, min_ratings: 3 }];
    const view = await open();

    await waitFor(() => expect(view.getByText('No ratings yet')).toBeTruthy());
  });
});

describe('the cast', () => {
  beforeEach(() => {
    tableRows.media_cache = [credits];
  });

  it('names people rather than showing initials as the intended state', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('Leonardo DiCaprio')).toBeTruthy());
    expect(view.getByText('Cobb')).toBeTruthy();
  });

  it('opens the person behind the face', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('Leonardo DiCaprio')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Leonardo DiCaprio, who plays Cobb'));
    expect(mockPush).toHaveBeenCalledWith('/person/6193');
  });

  it('still lists someone with no photograph', async () => {
    // Below the top billing most people have no portrait, so a strip that only
    // worked with imagery would be half empty on every title.
    const view = await open();
    await waitFor(() => expect(view.getByText('Joseph Gordon-Levitt')).toBeTruthy());
  });
});

describe('tabs that have nothing behind them', () => {
  it('has no Reviews tab, because nobody wrote a review', async () => {
    tableRows.user_media = [
      { user_id: 'user-1', media_item_id: 'film-1', note: 'A note, not a review.' },
    ];
    const view = await open();

    expect(view.queryByRole('tab', { name: 'Reviews' })).toBeNull();
  });

  it('does not render a Videos tab until there are videos', async () => {
    const view = await open();
    expect(view.queryByRole('tab', { name: 'Videos' })).toBeNull();
  });

  it('renders Videos once the facet has something in it', async () => {
    tableRows.media_cache = [
      {
        media_item_id: 'film-1',
        facet: 'videos',
        payload: {
          results: [
            { id: 'v1', key: 'abc123', name: 'Official Trailer', type: 'Trailer', official: true },
          ],
        },
      },
    ];
    const view = await open();

    await waitFor(() => expect(view.getByRole('tab', { name: 'Videos' })).toBeTruthy());
    await fireEvent.press(view.getByRole('tab', { name: 'Videos' }));
    await waitFor(() => expect(view.getByText('Official Trailer')).toBeTruthy());
  });

  it('does not render a Seasons tab for a film', async () => {
    const view = await open();
    expect(view.queryByRole('tab', { name: 'Seasons' })).toBeNull();
  });

  it('does not render a Cast tab for a title with no credits', async () => {
    const view = await open();
    expect(view.queryByRole('tab', { name: 'Cast' })).toBeNull();
  });
});

/**
 * Notes are social content now, in a section that says what they are. The tab that
 * used to say "Reviews" was one person's private sentence with a magazine's word on
 * top of it.
 */
describe('notes on the title', () => {
  const note = {
    user_id: 'user-2',
    media_item_id: 'film-1',
    note: 'The last twenty minutes are the whole film.',
    has_spoilers: false,
    updated_at: '2026-08-15T00:00:00Z',
  };

  beforeEach(() => {
    tableRows.public_profiles = [
      { id: 'user-2', username: 'anna', display_name: 'Anna', avatar_path: null },
    ];
  });

  it('shows someone else’s note under their name', async () => {
    mockRpcResults.public_notes = [note];
    const view = await open();

    await waitFor(() => expect(view.getByText('Anna')).toBeTruthy());
    expect(view.getByText('The last twenty minutes are the whole film.')).toBeTruthy();
  });

  it('masks a spoiler note from someone who has not watched this exact title', async () => {
    mockRpcResults.public_notes = [{ ...note, note: 'He was dead the whole time.', has_spoilers: true }];
    const view = await open();

    await waitFor(() => expect(view.getByText('Contains spoilers')).toBeTruthy());
    expect(view.queryByText('He was dead the whole time.')).toBeNull();
  });

  it('shows it once the viewer has watched the title', async () => {
    tableRows.user_media = [{ user_id: 'user-1', media_item_id: 'film-1', bucket: 'loved' }];
    mockRpcResults.public_notes = [{ ...note, note: 'He was dead the whole time.', has_spoilers: true }];
    const view = await open();

    await waitFor(() => expect(view.getByText('He was dead the whole time.')).toBeTruthy());
  });

  it('drops a note whose author cannot be named rather than showing an anonymous one', async () => {
    tableRows.public_profiles = [];
    mockRpcResults.public_notes = [note];
    const view = await open();

    await waitFor(() => expect(view.getByText('Inception')).toBeTruthy());
    expect(view.queryByText('The last twenty minutes are the whole film.')).toBeNull();
  });
});
