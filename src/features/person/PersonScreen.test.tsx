import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import PersonScreen from '../../../app/person/[id]';

const mockPush = jest.fn();
const mockCachePerson = jest.fn(() => Promise.resolve({ id: 6193, written: 0 }));
const mockSetWatchlist = jest.fn(() => Promise.resolve({ outcome: 'applied' as const }));

const tableRows: Record<string, unknown[]> = {};
let mockPersonId = '6193';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: null, error: null }),
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
        order: () => Promise.resolve({ data: rows(), error: null }),
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
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
  useLocalSearchParams: () => ({ id: mockPersonId }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

// The adapter is the one thing on this screen that leaves the device. What matters
// here is *whether* it is asked, and for whom.
jest.mock('@/lib/tmdb-adapter', () => ({
  cachePerson: (...args: unknown[]) => mockCachePerson(...(args as [])),
}));

jest.mock('@/features/collection/writes', () => ({
  newOperationId: () => 'op-1',
  setWatchlist: (...args: unknown[]) => mockSetWatchlist(...(args as [])),
}));

/**
 * A cached person, exactly as `tmdb_put_person` stores one: the record, and an
 * ordered list of credits that name a `media_items` id and what they did in it.
 * The titles themselves live in `media_items`, which is the whole point — a credit
 * here is a real catalogue row, not a provider id waiting to be imported.
 */
const FRESH = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
const LAPSED = new Date(Date.now() - 60_000).toISOString();

const cached = {
  tmdb_person_id: 6193,
  expires_at: FRESH,
  payload: {
    person: {
      name: 'Leonardo DiCaprio',
      profile_path: '/leo.jpg',
      known_for: 'Acting',
      biography: 'An actor and producer.',
      biography_truncated: false,
      birthday: '1974-11-11',
      place_of_birth: 'Los Angeles, California, USA',
    },
    credits: [
      { id: 'film-1', kind: 'movie', role: 'Cobb', as: 'cast' },
      { id: 'film-2', kind: 'movie', role: 'Jack Dawson', as: 'cast' },
      { id: 'series-1', kind: 'series', role: 'Luke Brower', as: 'cast' },
    ],
    credit_total: 97,
  },
};

const items = [
  { id: 'film-1', kind: 'movie', title: 'Inception', release_date: '2010-07-16', poster_path: '/i.jpg' },
  { id: 'film-2', kind: 'movie', title: 'Titanic', release_date: '1997-12-19', poster_path: null },
  {
    id: 'series-1',
    kind: 'series',
    title: 'Growing Pains',
    release_date: '1985-09-24',
    poster_path: null,
  },
];

beforeEach(() => {
  mockPersonId = '6193';
  mockPush.mockReset();
  mockCachePerson.mockClear();
  mockSetWatchlist.mockClear();
  for (const key of Object.keys(tableRows)) delete tableRows[key];
  tableRows.person_cache = [cached];
  tableRows.media_items = items;
  tableRows.watchlist = [];
  tableRows.rankings = [];
  tableRows.user_media = [];
});

const open = async () => {
  const view = await renderWithProviders(<PersonScreen />);
  await waitFor(() => expect(view.getByText('Leonardo DiCaprio')).toBeTruthy());
  return view;
};

/**
 * The change Phase E3 is: this page used to answer "which titles already in this
 * database mention this person", under a heading that said "In your catalogue". A
 * fresh install showed an actor with no credits, and an enriched one showed them with
 * two. The question the tap asked is what else they have worked on.
 */
describe('a person as a discovery surface', () => {
  it('lists their work rather than the reader’s catalogue', async () => {
    const view = await open();

    expect(view.getByText('Inception (2010)')).toBeTruthy();
    expect(view.getByText('Titanic (1997)')).toBeTruthy();
    expect(view.getByText('Growing Pains (1985)')).toBeTruthy();
  });

  it('no longer frames any of it as the reader’s own catalogue', async () => {
    const view = await open();

    expect(view.queryByText(/in your catalogue/i)).toBeNull();
    expect(view.getByLabelText('Known for')).toBeTruthy();
  });

  it('says who they are before it says what they did', async () => {
    const view = await open();

    expect(view.getByText('Acting · born 1974 · Los Angeles, California, USA')).toBeTruthy();
    expect(view.getByText('An actor and producer.')).toBeTruthy();
  });

  it('names the character, which is the part the catalogue row cannot hold', async () => {
    const view = await open();

    expect(view.getByText('Cobb')).toBeTruthy();
  });

  it('opens the catalogue row behind a credit', async () => {
    // No import step. The adapter wrote every credited title into media_items before
    // the cache row was written, so this is the ordinary title route.
    const view = await open();

    await fireEvent.press(view.getByText('Inception (2010)'));
    expect(mockPush).toHaveBeenCalledWith('/title/film-1');
  });

  it('says what it is not showing rather than implying this is everything', async () => {
    // The adapter keeps the forty most popular credits. Somebody with ninety-seven
    // should not be presented as somebody with three.
    const view = await open();

    expect(view.getByText('Showing 3 of 97 credits TMDB lists.')).toBeTruthy();
  });

  it('credits TMDB for the metadata', async () => {
    const view = await open();

    expect(view.getByText('Metadata from TMDB')).toBeTruthy();
  });
});

describe('filtering a filmography', () => {
  it('offers Movies and TV when there is something in both', async () => {
    const view = await open();

    expect(view.getByRole('tab', { name: 'Movies' })).toBeTruthy();
    expect(view.getByRole('tab', { name: 'TV' })).toBeTruthy();
  });

  it('shows only films under Movies', async () => {
    const view = await open();

    await fireEvent.press(view.getByRole('tab', { name: 'Movies' }));
    await waitFor(() => expect(view.queryByText('Growing Pains (1985)')).toBeNull());
    expect(view.getByText('Inception (2010)')).toBeTruthy();
  });

  it('offers no choice to somebody with only films', async () => {
    // A director with no television is not asked to choose between Movies and TV.
    tableRows.person_cache = [
      {
        ...cached,
        payload: {
          ...cached.payload,
          credits: cached.payload.credits.filter((credit) => credit.kind === 'movie'),
        },
      },
    ];
    const view = await open();

    expect(view.queryByRole('tab', { name: 'Movies' })).toBeNull();
    expect(view.queryByRole('tab', { name: 'TV' })).toBeNull();
  });
});

describe('the reader’s own state on somebody else’s work', () => {
  it('marks a film they have ranked', async () => {
    tableRows.rankings = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        position: 1,
        category: 'movies',
        bucket: 'loved',
        media_items: items[0],
      },
    ];
    const view = await open();

    await waitFor(() => expect(view.getByText('Ranked')).toBeTruthy());
  });

  it('marks a film they have watched but not ranked', async () => {
    tableRows.user_media = [{ user_id: 'user-1', media_item_id: 'film-2' }];
    const view = await open();

    await waitFor(() => expect(view.getByText('Watched')).toBeTruthy());
  });

  it('claims nothing about a series, which is logged one season at a time', async () => {
    // "Watched" against a whole show would be a claim the data does not make: a
    // user_media row is per media item, and a series is never one of them.
    tableRows.user_media = [{ user_id: 'user-1', media_item_id: 'series-1' }];
    const view = await open();

    await waitFor(() => expect(view.getByText('Growing Pains (1985)')).toBeTruthy());
    expect(view.queryByText('Watched')).toBeNull();
  });

  it('saves a title to the watchlist from the row', async () => {
    const view = await open();

    await fireEvent.press(view.getByLabelText('Add Inception to your watchlist'));

    expect(mockSetWatchlist).toHaveBeenCalledWith(
      expect.objectContaining({ mediaItemId: 'film-1', present: true }),
    );
  });

  it('offers to remove one that is already saved', async () => {
    tableRows.watchlist = [{ user_id: 'user-1', media_item_id: 'film-1', media_items: items[0] }];
    const view = await open();

    await waitFor(() =>
      expect(view.getByLabelText('Remove Inception from your watchlist')).toBeTruthy(),
    );
  });
});

describe('a person the cache has never held', () => {
  it('asks the adapter for them once', async () => {
    tableRows.person_cache = [];
    await renderWithProviders(<PersonScreen />);

    await waitFor(() => expect(mockCachePerson).toHaveBeenCalledWith(6193));
    expect(mockCachePerson).toHaveBeenCalledTimes(1);
  });

  it('spends nothing on an id that is not a person id', async () => {
    // A TMDB person id is a positive integer, and a route parameter is whatever the
    // link said. Refused here rather than at the provider, after a charged request.
    mockPersonId = 'not-a-number';
    tableRows.person_cache = [];
    await renderWithProviders(<PersonScreen />);

    await waitFor(() => expect(mockCachePerson).not.toHaveBeenCalled());
  });
});

/**
 * Both findings of independent review 13, which were the same omission seen twice:
 * the hook read `payload` and not `expires_at`, so it could distinguish neither a
 * lapsed filmography from a current one nor a claim placeholder from an empty cache.
 */
describe('a cached person that has gone stale', () => {
  it('is still rendered in full rather than replaced by a spinner', async () => {
    tableRows.person_cache = [{ ...cached, expires_at: LAPSED }];
    const view = await open();

    expect(view.getByText('Inception (2010)')).toBeTruthy();
  });

  it('is refreshed behind the reader, which is what makes the TTL real', async () => {
    // Without this the seven-day expiry in `20260817000500` is a number in a
    // migration that no code path can act on, and a filmography cached once is
    // cached for good.
    tableRows.person_cache = [{ ...cached, expires_at: LAPSED }];
    await open();

    await waitFor(() => expect(mockCachePerson).toHaveBeenCalledWith(6193));
  });

  it('is not refreshed while it is fresh', async () => {
    await open();

    expect(mockCachePerson).not.toHaveBeenCalled();
  });
});

describe('a person somebody else is already fetching', () => {
  // `tmdb_claim_person` writes a two-minute placeholder carrying `claimed_at` and no
  // credits. The loser of that race must wait for the winner's answer, not spend a
  // second provider request and not give up.
  const claim = {
    tmdb_person_id: 6193,
    expires_at: FRESH,
    payload: { claimed_at: new Date().toISOString() },
  };

  it('waits rather than reporting the person as missing', async () => {
    tableRows.person_cache = [claim];
    const view = await renderWithProviders(<PersonScreen />);

    await waitFor(() => expect(view.queryByText('Nothing here yet')).toBeNull());
  });

  it('spends no second provider request on them', async () => {
    tableRows.person_cache = [claim];
    await renderWithProviders(<PersonScreen />);

    // The whole point of the claim. A second request here is what it exists to stop.
    await waitFor(() => expect(mockCachePerson).not.toHaveBeenCalled());
  });

  it('asks again once the claim has lapsed without an answer', async () => {
    // A claim is a promise to fetch, and a promise can be broken — the isolate can be
    // killed mid-request. An expired placeholder is "nobody is coming back", not
    // "somebody is still working".
    tableRows.person_cache = [{ ...claim, expires_at: LAPSED }];
    await renderWithProviders(<PersonScreen />);

    await waitFor(() => expect(mockCachePerson).toHaveBeenCalledWith(6193));
  });
});
