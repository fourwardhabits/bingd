import { fireEvent, waitFor, within } from '@testing-library/react-native';
import { StyleSheet, type TextStyle } from 'react-native';

import { TitleRowActions } from '@/features/collection/TitleRowActions';
import { expectRowFitsNarrow, naturalWidth } from '@/test-utils/narrow-row';
import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import PersonScreen from '../../../app/person/[id]';

const mockPush = jest.fn();
const mockCachePerson = jest.fn(() => Promise.resolve({ id: 6193, written: 0 }));
const mockSetWatchlist = jest.fn(() => Promise.resolve({ outcome: 'applied' as const }));

const tableRows: Record<string, unknown[]> = {};
let mockPersonId = '6193';
/**
 * Reads of one table start failing after N successes.
 *
 * The regression at review 13b was specifically "a successful read returned a live
 * claim, and every read after it failed" — React Query keeps the last good `data`, so
 * the screen went on believing somebody was fetching. A mock that always succeeds
 * cannot express that, which is why the first four claim tests could not tell the
 * broken implementation from the fixed one.
 */
let mockFailAfter: { table: string; successes: number } | null = null;
/**
 * How many times each table has actually been read.
 *
 * An invalidation is only worth anything if a read follows it, so the reconciliation
 * tests below assert the *refetch* rather than asserting that a helper was called.
 * Independent review 21e's point about the surviving mutant was that the integration was
 * missing, and a test on the helper would not have noticed.
 */
const mockReads: Record<string, number> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: (table: string) => {
      mockReads[table] = (mockReads[table] ?? 0) + 1;
      const filters: Record<string, unknown> = {};
      const failing = () => {
        if (!mockFailAfter || mockFailAfter.table !== table) return false;
        if (mockFailAfter.successes > 0) {
          mockFailAfter.successes -= 1;
          return false;
        }
        return true;
      };
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
        // Both return the chain: the collection reads page by keyset now, so the call is
        // `.order(...).limit(...)` and `then` is what resolves it.
        order: () => chain,
        limit: () => chain,
        gt: () => chain,
        maybeSingle: () =>
          failing()
            ? Promise.resolve({ data: null, error: { message: 'network down' } })
            : Promise.resolve({ data: rows()[0] ?? null, error: null }),
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
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
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

/**
 * **Partially mocked, on purpose.**
 *
 * `setWatchlist` is stood in for, because what this screen does with the *result* is the
 * thing under test. `mustReconcile` is the real one: a whole-module mock silently
 * dropped it, and a screen given a stub for the rule it is supposed to obey proves
 * nothing about whether it obeys the rule.
 */
/**
 * The log and ranking sheets are Search's own, tested where they live; here what matters
 * is that a filmography row opens them, with which title, and how often.
 */
const mockLogSheet: { props: Record<string, unknown> | null; opened: unknown[] } = {
  props: null,
  opened: [],
};
jest.mock('@/features/collection/LogSheet', () => ({
  LogSheet: (props: Record<string, unknown>) => {
    if (props.title && props.title !== mockLogSheet.props?.title) mockLogSheet.opened.push(props.title);
    mockLogSheet.props = props;
    return null;
  },
}));
/** Every subject the ranking sheet was handed, so a test can assert none was. */
const mockRankingSubjects: unknown[] = [];
jest.mock('@/features/ranking/RankingSheet', () => ({
  RankingSheet: (props: { subject?: unknown }) => {
    if (props.subject) mockRankingSubjects.push(props.subject);
    return null;
  },
}));

jest.mock('@/features/collection/writes', () => ({
  ...jest.requireActual('@/features/collection/writes'),
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
  mockFailAfter = null;
  for (const key of Object.keys(tableRows)) delete tableRows[key];
  tableRows.person_cache = [cached];
  tableRows.media_items = items;
  tableRows.watchlist = [];
  tableRows.rankings = [];
  tableRows.user_media = [];
  mockLogSheet.props = null;
  mockLogSheet.opened = [];
  mockRankingSubjects.length = 0;
});

const open = async () => {
  const view = await renderWithProviders(<PersonScreen />);
  await waitFor(() => expect(view.getByText('Leonardo DiCaprio')).toBeTruthy());
  return view;
};

/** Movies or TV, from the FILMOGRAPHY row's selector (FU1113-C). */
const chooseMedium = async (view: Awaited<ReturnType<typeof open>>, name: 'Movies' | 'TV') => {
  await fireEvent.press(view.getByTestId('filmography-medium'));
  await fireEvent.press(await view.findByRole('menuitem', { name }));
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
    await chooseMedium(view, 'TV');
    expect(view.getByText('Growing Pains (1985)')).toBeTruthy();
  });

  it('no longer frames any of it as the reader’s own catalogue', async () => {
    const view = await open();

    expect(view.queryByText(/in your catalogue/i)).toBeNull();
    expect(view.getByLabelText('Filmography')).toBeTruthy();
  });

  it('says who they are before it says what they did', async () => {
    const view = await open();

    expect(view.getByText('Born 1974 · USA')).toBeTruthy();
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
    // The adapter keeps the most popular credits. Somebody with ninety-seven should not
    // be presented as somebody with three. A row cached before the halves were counted
    // has only the combined total, which is the acting total when there is no crew half.
    const view = await open();

    expect(view.getByText('Showing 3 of 97 credits TMDB lists.')).toBeTruthy();
  });

  it('credits TMDB for the metadata', async () => {
    const view = await open();

    expect(view.getByText('Metadata from TMDB')).toBeTruthy();
  });
});

/**
 * **One medium at a time** (FU1113-C): no All tab. The page opens on Movies when the half on
 * screen has films and on TV otherwise, for this visit only, and the FILMOGRAPHY row's
 * selector moves between them.
 */
describe('Movies or TV', () => {
  it('opens on Movies, offers Movies and TV, and has no All', async () => {
    const view = await open();

    expect(view.getByTestId('filmography-medium').props.accessibilityLabel).toBe('Showing Movies');
    expect(view.queryByRole('tab', { name: 'All' })).toBeNull();
    expect(view.queryByText('All')).toBeNull();
    await fireEvent.press(view.getByTestId('filmography-medium'));
    expect(
      (await view.findAllByRole('menuitem')).map((item) => item.props.accessibilityLabel),
    ).toEqual(['Movies', 'TV']);
  });

  it('shows only films under Movies, and only television under TV', async () => {
    const view = await open();

    expect(view.queryByText('Growing Pains (1985)')).toBeNull();
    expect(view.getByText('Inception (2010)')).toBeTruthy();

    await chooseMedium(view, 'TV');
    await waitFor(() => expect(view.getByText('Growing Pains (1985)')).toBeTruthy());
    expect(view.queryByText('Inception (2010)')).toBeNull();
  });

  it('opens on TV for somebody with no films in the half on screen', async () => {
    tableRows.person_cache = [
      {
        ...cached,
        payload: {
          ...cached.payload,
          credits: cached.payload.credits.filter((credit) => credit.kind === 'series'),
        },
      },
    ];
    const view = await open();

    expect(view.getByTestId('filmography-medium').props.accessibilityLabel).toBe('Showing TV');
    expect(view.getByText('Growing Pains (1985)')).toBeTruthy();
  });

  it('is not remembered: a new visit opens on Movies again', async () => {
    const first = await open();
    await chooseMedium(first, 'TV');
    await first.unmount();

    const view = await open();
    expect(view.getByTestId('filmography-medium').props.accessibilityLabel).toBe('Showing Movies');
  });
});

/**
 * **Cast is what they acted in; Crew is the other half** (2026-09-13).
 *
 * Cast search sends people here to see what an actor has been in, so a directing or
 * producing credit must never be drawn as though it were a part.
 */
describe('cast and crew', () => {
  const both = {
    ...cached,
    payload: {
      ...cached.payload,
      credits: [
        { id: 'film-1', kind: 'movie', role: 'Cobb', as: 'cast', crew_role: null },
        // Acted in and produced: in both halves, under a different label in each.
        { id: 'film-2', kind: 'movie', role: 'Jack Dawson', as: 'cast', crew_role: 'Producer' },
        // Behind the camera only.
        { id: 'film-3', kind: 'movie', role: 'Director', as: 'crew', crew_role: 'Director' },
      ],
      credit_total: 3,
      cast_total: 41,
      crew_total: 12,
    },
  };

  beforeEach(() => {
    tableRows.person_cache = [both];
    tableRows.media_items = [
      ...items,
      { id: 'film-3', kind: 'movie', title: 'Killers', release_date: '2023-10-20', poster_path: null },
    ];
  });

  it('opens on what they acted in, with no crew credit drawn as a part', async () => {
    const view = await open();

    expect(view.getByText('Inception (2010)')).toBeTruthy();
    expect(view.getByText('Titanic (1997)')).toBeTruthy();
    expect(view.getByText('Jack Dawson')).toBeTruthy();
    expect(view.queryByText('Killers (2023)')).toBeNull();
    expect(view.queryByText('Director')).toBeNull();
    expect(view.queryByText('Producer')).toBeNull();
    expect(view.getByText('Showing 2 of 41 acting credits TMDB lists.')).toBeTruthy();
  });

  it('keeps the work behind the camera under Crew, including a film they also acted in', async () => {
    const view = await open();

    await fireEvent.press(view.getByRole('tab', { name: 'Crew' }));

    await waitFor(() => expect(view.getByText('Killers (2023)')).toBeTruthy());
    expect(view.getByText('Director')).toBeTruthy();
    expect(view.getByText('Titanic (1997)')).toBeTruthy();
    expect(view.getByText('Producer')).toBeTruthy();
    // Not a crew credit, and not a character on this side.
    expect(view.queryByText('Inception (2010)')).toBeNull();
    expect(view.queryByText('Jack Dawson')).toBeNull();
    expect(view.getByText('Showing 2 of 12 crew credits TMDB lists.')).toBeTruthy();
  });

  it('offers no Cast and Crew choice to somebody with only acting credits', async () => {
    tableRows.person_cache = [cached];
    const view = await open();

    expect(view.queryByRole('tab', { name: 'Cast' })).toBeNull();
    expect(view.queryByRole('tab', { name: 'Crew' })).toBeNull();
  });

  it('opens on Crew for somebody with no acting credits at all', async () => {
    tableRows.person_cache = [
      {
        ...both,
        payload: { ...both.payload, credits: [both.payload.credits[2]], cast_total: 0, crew_total: 1 },
      },
    ];
    const view = await open();

    expect(view.getByText('Killers (2023)')).toBeTruthy();
    expect(view.getByText('Director')).toBeTruthy();
    expect(view.queryByRole('tab', { name: 'Cast' })).toBeNull();
  });

  it('leaves talk-show appearances out of the Cast list', async () => {
    tableRows.person_cache = [
      {
        ...cached,
        payload: {
          ...cached.payload,
          credits: [
            { id: 'film-1', kind: 'movie', role: 'Cobb', as: 'cast', crew_role: null, self: false },
            { id: 'series-1', kind: 'series', role: 'Self', as: 'cast', crew_role: null, self: true },
          ],
          cast_total: 1,
          crew_total: 0,
        },
      },
    ];
    const view = await open();

    expect(view.getByText('Inception (2010)')).toBeTruthy();
    expect(view.queryByText('Growing Pains (1985)')).toBeNull();
  });

  it('still shows appearances for somebody who has nothing else to show', async () => {
    // A presenter's page would otherwise say they had done nothing at all.
    tableRows.person_cache = [
      {
        ...cached,
        payload: {
          ...cached.payload,
          credits: [{ id: 'series-1', kind: 'series', role: 'Self - Host', as: 'cast', crew_role: null, self: true }],
          cast_total: 0,
          crew_total: 0,
        },
      },
    ];
    const view = await open();

    expect(view.getByText('Growing Pains (1985)')).toBeTruthy();
  });

  it('treats a series credited as Self on a row cached before the flag existed as an appearance', async () => {
    tableRows.person_cache = [
      {
        ...cached,
        payload: {
          ...cached.payload,
          credits: [
            { id: 'film-1', kind: 'movie', role: 'Cobb', as: 'cast' },
            { id: 'series-1', kind: 'series', role: 'Himself', as: 'cast' },
          ],
        },
      },
    ];
    const view = await open();

    expect(view.getByText('Inception (2010)')).toBeTruthy();
    expect(view.queryByText('Growing Pains (1985)')).toBeNull();
  });

  it('still names the job on a crew credit cached before crew roles were recorded', async () => {
    tableRows.person_cache = [
      {
        ...cached,
        payload: {
          ...cached.payload,
          credits: [{ id: 'film-3', kind: 'movie', role: 'Director', as: 'crew' }],
        },
      },
    ];
    const view = await open();

    expect(view.getByText('Killers (2023)')).toBeTruthy();
    expect(view.getByText('Director')).toBeTruthy();
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

  // Since 20261114000200 a whole show ranks in its own pool and is logged like a film, so
  // its credit row says what the show's title page says (RC review, 2026-11-11). Before,
  // this asserted "nothing about a series", which a ranked show made a contradiction.
  it('marks a show they have ranked as a show', async () => {
    tableRows.rankings = [
      {
        user_id: 'user-1',
        media_item_id: 'series-1',
        position: 1,
        category: 'tv_shows',
        bucket: 'loved',
        media_items: items[2],
      },
    ];
    const view = await open();
    await chooseMedium(view, 'TV');

    await waitFor(() => expect(view.getByText('Ranked')).toBeTruthy());
  });

  it('marks a show they have logged as a show but not ranked', async () => {
    tableRows.user_media = [{ user_id: 'user-1', media_item_id: 'series-1' }];
    const view = await open();
    await chooseMedium(view, 'TV');

    await waitFor(() => expect(view.getByText('Watched')).toBeTruthy());
  });

  it('claims nothing about a show they have not logged', async () => {
    const view = await open();
    await chooseMedium(view, 'TV');

    await waitFor(() => expect(view.getByText('Growing Pains (1985)')).toBeTruthy());
    expect(view.queryByText('Watched')).toBeNull();
    expect(view.queryByText('Ranked')).toBeNull();
  });

  it('saves a title to the watchlist from the row', async () => {
    const view = await open();

    await fireEvent.press(view.getByLabelText('Add Inception to Watchlist'));

    expect(mockSetWatchlist).toHaveBeenCalledWith(
      expect.objectContaining({ mediaItemId: 'film-1', present: true }),
    );
  });

  /**
   * **A write whose outcome is unknown still moved the watchlist.**
   *
   * `set_watchlist` commits, the reply is lost, and `writes.ts` reports
   * `{ failed, changed }` (`lib/write-outcome.ts`). This screen used to alert and return
   * before invalidating anything, so the row stayed saved on the server and empty here
   * until the cache went stale on its own. Independent review 21e, Major 3 — the mutant
   * that survived because the integration was missing rather than because the assertion
   * was weak.
   */
  it('refetches the watchlist when the save may have landed anyway', async () => {
    mockSetWatchlist.mockResolvedValueOnce({
      outcome: 'failed',
      message: 'network down',
      changed: true,
    } as never);
    const view = await open();
    const before = mockReads.watchlist ?? 0;

    await fireEvent.press(view.getByLabelText('Add Inception to Watchlist'));

    await waitFor(() => expect(mockReads.watchlist ?? 0).toBeGreaterThan(before));
  });

  it('leaves the cache alone when the server refused outright', async () => {
    // The other half of the trade. A refusal this app raises on purpose proves nothing
    // was written, so a refetch here would be a round trip bought with nothing.
    mockSetWatchlist.mockResolvedValueOnce({
      outcome: 'failed',
      message: 'Your account cannot make changes right now.',
    } as never);
    const view = await open();
    const before = mockReads.watchlist ?? 0;

    await fireEvent.press(view.getByLabelText('Add Inception to Watchlist'));

    await waitFor(() => expect(mockSetWatchlist).toHaveBeenCalled());
    expect(mockReads.watchlist ?? 0).toBe(before);
  });

  it('offers to remove one that is already saved', async () => {
    tableRows.watchlist = [{ user_id: 'user-1', media_item_id: 'film-1', media_items: items[0] }];
    const view = await open();

    await waitFor(() =>
      expect(view.getByLabelText('Remove Inception from Watchlist')).toBeTruthy(),
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

  it('renders the winner’s filmography when it lands, without being told', async () => {
    // The finding at review 13, and the assertion 13b asked for: the loser has nothing
    // invalidating this query on their behalf, so the only way they ever see the answer
    // is the poll. The row is swapped underneath exactly as the winner's write would.
    tableRows.person_cache = [claim];
    const view = await renderWithProviders(<PersonScreen />);

    await waitFor(() => expect(view.queryByText('Leonardo DiCaprio')).toBeNull());
    tableRows.person_cache = [cached];

    await waitFor(() => expect(view.getByText('Inception (2010)')).toBeTruthy(), {
      timeout: 6000,
    });
    // And it got there by waiting, not by spending a request the claim exists to stop.
    expect(mockCachePerson).not.toHaveBeenCalled();
  });

  it('spends no second provider request while the claim is live', async () => {
    tableRows.person_cache = [claim];
    await renderWithProviders(<PersonScreen />);

    // Held long enough for two poll intervals, so this is a property of the state
    // rather than of the first render happening to be quick.
    await new Promise((resolve) => setTimeout(resolve, 3200));
    expect(mockCachePerson).not.toHaveBeenCalled();
  });

  it('stops waiting when the reads stop answering, rather than spinning forever', async () => {
    // The regression at review 13b, made testable: one successful read returns a live
    // claim and every read after it fails. React Query keeps the last good `data`, so
    // the screen went on believing somebody was fetching — and an interval asking only
    // "is it still claimed" went on asking every 1.5 seconds for the life of the
    // screen. The one state that could not resolve itself was the one that polled
    // hardest, and the reader saw a spinner that never ended.
    //
    tableRows.person_cache = [claim];
    mockFailAfter = { table: 'person_cache', successes: 1 };
    const view = await renderWithProviders(<PersonScreen />);

    // Three failed polls at 1.5s each, plus the render that observes the third. The
    // *other* bound on this wait is a thirty-second timer, which covers a request that
    // hangs rather than failing; this is the one an outage reaches first, and it is the
    // one the defect was about.
    // The assertion is that the spinner ends and there is a way on, rather than which
    // of the two honest terminal states it lands in — "could not load" and "nothing
    // here yet" are both true of a database that has stopped answering, and which one
    // React Query reports depends on whether it kept the last good read.
    await waitFor(() => expect(view.getByText('Try again')).toBeTruthy(), {
      timeout: 12_000,
    });
    // And it never fell back to spending the request the claim exists to prevent.
    expect(mockCachePerson).not.toHaveBeenCalled();
  });

  it('asks again immediately when the claim has already lapsed', async () => {
    tableRows.person_cache = [{ ...claim, expires_at: LAPSED }];
    await renderWithProviders(<PersonScreen />);

    await waitFor(() => expect(mockCachePerson).toHaveBeenCalledWith(6193));
  });
});

/**
 * **The bookmark's two states, in Search's colours** (pre-GTM audit, 2026-09-07).
 *
 * This row drew Maroon in both states, so an unsaved bookmark on a person page read as
 * already selected while the same control on Search did not. Filled Maroon when saved,
 * outlined and secondary otherwise: the app's one watchlist treatment.
 */
describe('the bookmark on a credit row', () => {
  /** The glyph's colour: an icon renders as one host Text, and its colour is in the style. */
  const glyphColor = (control: {
    queryAll: (p: (n: { type: string }) => boolean) => { props: Record<string, unknown> }[];
  }) =>
    StyleSheet.flatten(
      control.queryAll((node) => node.type === 'Text')[0]?.props.style as TextStyle,
    ).color;

  it('draws an unsaved bookmark quietly', async () => {
    const view = await open();

    const add = await view.findByLabelText('Add Inception to Watchlist');

    expect(glyphColor(add)).toBe(theme.text.secondary);
  });

  it('draws a saved one in Maroon', async () => {
    tableRows.watchlist = [{ user_id: 'user-1', media_item_id: 'film-1', media_items: items[0] }];
    const view = await open();

    const remove = await view.findByLabelText('Remove Inception from Watchlist');

    expect(glyphColor(remove)).toBe(theme.semantic.action);
  });
});

/**
 * **Founder spec §6 (2026-11-13)**: name → biography → filmography, with at most
 * `Born YYYY · Country` between the first two; and on every eligible row Search's own
 * compact + Rank and bookmark, respecting what the reader has already ranked or saved.
 */
describe('the refined person page', () => {
  /** Every testID under the screen, in tree order. */
  const ids = (view: Awaited<ReturnType<typeof open>>) => {
    const out: string[] = [];
    const walk = (node: { props?: { testID?: string }; children?: unknown[] } | string | null) => {
      if (!node || typeof node === 'string') return;
      if (node.props?.testID) out.push(node.props.testID);
      for (const child of node.children ?? []) walk(child as never);
    };
    walk(view.toJSON() as never);
    return out;
  };

  it('reads name, then the one line of context, then the biography, then the filmography', async () => {
    const view = await open();
    const order = ids(view);
    const at = (id: string) => order.indexOf(id);
    expect(at('person-name')).toBeGreaterThan(-1);
    expect(at('person-name')).toBeLessThan(at('person-meta'));
    expect(at('person-meta')).toBeLessThan(at('biography'));
    expect(at('biography')).toBeLessThan(at('filmography-header'));
    expect(view.getByTestId('person-meta')).toHaveTextContent('Born 1974 · USA');
    expect(view.queryByText(/Acting ·/)).toBeNull();
    expect(view.queryByText(/Los Angeles/)).toBeNull();
  });

  it('heads the filmography at the large section size, Cast | Crew as the page’s navigation', async () => {
    tableRows.person_cache = [
      {
        ...cached,
        payload: {
          ...cached.payload,
          credits: [
            ...cached.payload.credits,
            { id: 'film-2', kind: 'movie', role: 'Producer', as: 'crew', crew_role: 'Producer' },
          ],
        },
      },
    ];
    const view = await open();
    // Row 1: FILMOGRAPHY at the large section size on the left, Movies / TV on the right.
    const header = view.getByTestId('filmography-header');
    const heading = within(view.getByTestId('filmography-header-leading')).getByLabelText('Filmography');
    expect(StyleSheet.flatten(heading.props.style).fontSize).toBe(
      theme.typography.sectionHeaderLarge.fontSize,
    );
    expect(heading.props.accessibilityRole).toBe('header');
    expect(
      within(view.getByTestId('filmography-header-trailing')).getByTestId('filmography-medium'),
    ).toBeTruthy();
    expect(StyleSheet.flatten(header.props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'nowrap' });

    // Row 2: Cast / Crew as quiet text tabs on the left, the Filters & Sort icon on the right.
    const controls = view.getByTestId('filmography-controls');
    expect(StyleSheet.flatten(controls.props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'nowrap' });
    const tabs = within(view.getByTestId('filmography-controls-leading'));
    expect(tabs.getByRole('tab', { name: 'Cast' })).toBeTruthy();
    expect(tabs.getByRole('tab', { name: 'Crew' })).toBeTruthy();
    // The text style, not the large segmented control: no `nav` track.
    expect(view.queryByTestId('nav-tabs')).toBeNull();
    const filter = within(view.getByTestId('filmography-controls-trailing')).getByTestId(
      'filmography-filter-sort',
    );
    expect(filter.props.accessibilityLabel).toBe('Filters and sort. Sorted by Popular. No filters');
    // No All tab, anywhere.
    expect(view.queryByRole('tab', { name: 'All' })).toBeNull();
    // Heading row above the controls row.
    const order = JSON.stringify(view.toJSON());
    expect(order.indexOf('filmography-header')).toBeLessThan(order.indexOf('filmography-controls'));
  });

  it('opens Filters & Sort from the icon: Popular, Release date, Highest rated (TMDB), and Decade', async () => {
    const view = await open();
    await fireEvent.press(view.getByTestId('filmography-filter-sort'));
    const sheet = await view.findByTestId('filmography-sort-section');
    expect(view.getByLabelText('Filters and sort the filmography')).toBeTruthy();
    // The standard browsing sheet, with the quiet Close pinned under it.
    expect(view.getByTestId('filmography-filter-close')).toBeTruthy();
    const orders = within(sheet).getAllByRole('radio').map((node) => node.props.accessibilityLabel);
    expect(orders.map((label: string) => label.split(',')[0])).toEqual(['Popular', 'Release date']);
    // A credit carries a year and nothing else to filter on: Decade only.
    const decades = within(view.getByTestId('filmography-decade-section'));
    expect(decades.getAllByRole('checkbox').map((node) => node.props.accessibilityLabel)).toEqual([
      '1990s, 1',
      '2010s, 1',
    ]);
    expect(view.queryByText('GENRE')).toBeNull();
    expect(view.queryByText('LANGUAGE')).toBeNull();
    expect(view.queryByText('RATING')).toBeNull();
    // Never a bingd score: the only rating axis anywhere is labelled TMDB's.
    expect(view.queryByText(/bingd/i)).toBeNull();
  });

  it('filters by decade on the press, and says so on the icon', async () => {
    const view = await open();
    await fireEvent.press(view.getByTestId('filmography-filter-sort'));
    await fireEvent.press(await view.findByRole('checkbox', { name: '2010s, 1' }));
    await fireEvent.press(view.getByTestId('filmography-filter-close-press'));
    await waitFor(() => expect(view.queryByText('Titanic (1997)')).toBeNull());
    expect(view.getByText('Inception (2010)')).toBeTruthy();
    expect(view.getByTestId('filmography-filter-sort').props.accessibilityLabel).toBe(
      'Filters and sort. Sorted by Popular. 1 filter on',
    );
  });

  it('offers + Rank on an unranked row and opens Search’s log sheet on that title', async () => {
    const view = await open();
    await fireEvent.press(view.getByLabelText('Log Inception'));
    await waitFor(() =>
      expect(mockLogSheet.props?.title).toEqual(
        expect.objectContaining({ id: 'film-1', title: 'Inception', kind: 'movie' }),
      ),
    );
    // A second tap while the sheet is up opens nothing new.
    await fireEvent.press(view.getByLabelText('Log Titanic'));
    expect(mockLogSheet.opened).toHaveLength(1);
  });

  /** One ranked row: Inception, loved, at the top of the reader's movies. */
  const rankInception = () => {
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
  };

  /** The host subtree under `testID`, as JSON with handlers dropped, for comparing two renders. */
  const subtree = (tree: unknown, testID: string, nth = 0): string => {
    const found: unknown[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const host = node as { props?: { testID?: string }; children?: unknown[] };
      if (host.props?.testID === testID) found.push(node);
      for (const child of host.children ?? []) walk(child);
    };
    walk(tree);
    return JSON.stringify(found[nth]);
  };

  /**
   * **FU1113-C: a filmography row is Search's row** (`TitleRowActions`, with the props
   * `app/(tabs)/log.tsx` builds). Ranked: the reader's score, alone — no `+`, no Bookmark,
   * never a blank trailing area. This replaces t171u §1.4's independent Bookmark on a
   * ranked row, by the FU1113-C brief; the title page still offers the watchlist.
   */
  it('draws the reader’s score on a ranked title, and nothing else', async () => {
    rankInception();
    const view = await open();
    await waitFor(() => expect(view.getByLabelText(/^10\.0 out of 10/)).toBeTruthy());
    expect(view.getByText('Ranked')).toBeTruthy();
    expect(view.queryByLabelText('Log Inception')).toBeNull();
    expect(view.queryByLabelText(/Inception (to|from) Watchlist/)).toBeNull();
    // The others are unranked: + and the Bookmark.
    expect(view.getByLabelText('Log Titanic')).toBeTruthy();
    expect(view.getByLabelText('Add Titanic to Watchlist')).toBeTruthy();
  });

  it('opens Search’s log sheet from the score, for a rerank, and starts no ranking', async () => {
    rankInception();
    const view = await open();
    await fireEvent.press(await view.findByLabelText(/^10\.0 out of 10/));
    await waitFor(() =>
      expect(mockLogSheet.props?.title).toEqual(expect.objectContaining({ id: 'film-1' })),
    );
    expect(mockRankingSubjects).toHaveLength(0);
    expect(mockSetWatchlist).not.toHaveBeenCalled();
  });

  it('shows a ranked title on the watchlist by its score alone, and writes nothing on render', async () => {
    rankInception();
    tableRows.watchlist = [{ user_id: 'user-1', media_item_id: 'film-1', media_items: items[0] }];
    const view = await open();
    await waitFor(() => expect(view.getByLabelText(/^10\.0 out of 10/)).toBeTruthy());
    expect(view.queryByLabelText(/Inception (to|from) Watchlist/)).toBeNull();
    expect(view.getByText('Ranked')).toBeTruthy();
    expect(mockSetWatchlist).not.toHaveBeenCalled();
  });

  it('draws an unranked title on the watchlist as + Rank and a selected Bookmark', async () => {
    tableRows.watchlist = [{ user_id: 'user-1', media_item_id: 'film-2', media_items: items[1] }];
    const view = await open();
    const remove = await view.findByLabelText('Remove Titanic from Watchlist');
    expect(remove.props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
    expect(view.getByLabelText('Log Titanic')).toBeTruthy();
    expect(mockSetWatchlist).not.toHaveBeenCalled();
  });

  /**
   * **C7, the shared-component check**: the trailing controls a filmography row draws are,
   * node for node, what `TitleRowActions` draws when given the props Search gives it for
   * the same title — ranked, unranked, and unranked on the watchlist.
   */
  it('renders each state exactly as Search renders the same title', async () => {
    rankInception();
    tableRows.watchlist = [{ user_id: 'user-1', media_item_id: 'film-2', media_items: items[1] }];
    const view = await open();
    await waitFor(() => expect(view.getByLabelText(/^10\.0 out of 10/)).toBeTruthy());
    await waitFor(() => expect(view.getByLabelText('Remove Titanic from Watchlist')).toBeTruthy());
    const page = view.toJSON();

    const search = await renderWithProviders(
      <>
        <TitleRowActions
          name="Inception"
          kind="movie"
          // `useMyScores`' row for it, which is what Search passes.
          score={{ score: 10, bucket: 'loved', category: 'movies', position: 1 } as never}
          saved
          onRank={() => {}}
          onToggleWatchlist={() => {}}
        />
        <TitleRowActions
          name="Titanic"
          kind="movie"
          score={null}
          saved
          onRank={() => {}}
          onToggleWatchlist={() => {}}
        />
      </>,
    );
    const expected = search.toJSON();
    // Both found, not two misses comparing equal.
    expect(subtree(page, 'title-row-actions-ranked')).toContain('10.0');
    expect(subtree(page, 'title-row-actions-unranked')).toContain('Remove Titanic from Watchlist');
    expect(subtree(page, 'title-row-actions-ranked')).toBe(subtree(expected, 'title-row-actions-ranked'));
    expect(subtree(page, 'title-row-actions-unranked')).toBe(
      subtree(expected, 'title-row-actions-unranked'),
    );
  });

  it('writes the watchlist once for a double tap on the bookmark', async () => {
    let land!: (value: { outcome: 'applied' }) => void;
    mockSetWatchlist.mockImplementationOnce(
      () => new Promise((resolve) => (land = resolve as never)),
    );
    const view = await open();
    const bookmark = await view.findByLabelText('Add Inception to Watchlist');
    await fireEvent.press(bookmark);
    await fireEvent.press(bookmark);
    expect(mockSetWatchlist).toHaveBeenCalledTimes(1);
    land({ outcome: 'applied' });
    await waitFor(() => expect(mockSetWatchlist).toHaveBeenCalledTimes(1));
  });

  /** Independent review, 2026-11-13: no `+` until the reader's rankings are known. */
  it('offers no + Rank until the reader’s rankings have been read, and keeps the bookmark', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realRankings = tableRows.rankings;
    // Hold the rankings read: the page must not guess that a ranked title is unranked.
    Object.defineProperty(tableRows, 'rankings', {
      configurable: true,
      get: () => {
        throw gate;
      },
    });
    const view = await renderWithProviders(<PersonScreen />);
    await waitFor(() => expect(view.getByText('Inception (2010)')).toBeTruthy());
    expect(view.queryByLabelText('Log Inception')).toBeNull();
    // The bookmark does not wait on the rankings: it needs only the watchlist.
    expect(await view.findByLabelText('Add Inception to Watchlist')).toBeTruthy();
    Object.defineProperty(tableRows, 'rankings', {
      configurable: true,
      writable: true,
      value: realRankings,
    });
    release();
  });
});


/**
 * **The filmography's spacing, by token** (FU1113-C): `theme.layout.section.above` between
 * the biography (or the identity) and FILMOGRAPHY, `headingToControls` from the heading row
 * to Cast / Crew, `controlsToContent` from the controls to the first credit — the same
 * with a long biography, a short one, or none.
 */
describe('the filmography’s rhythm', () => {
  const LONG = 'He began acting in television commercials and soap operas. '.repeat(12).trim();

  const bio = (biography: string | null) => {
    tableRows.person_cache = [
      {
        ...cached,
        payload: {
          ...cached.payload,
          person: { ...cached.payload.person, biography },
          credits: [
            ...cached.payload.credits,
            { id: 'film-2', kind: 'movie', role: 'Producer', as: 'crew', crew_role: 'Producer' },
          ],
        },
      },
    ];
  };

  /** The `paddingTop` of the nearest ancestor of `testID` that sets one. */
  const padAbove = (view: Awaited<ReturnType<typeof open>>, testID: string) => {
    let node = view.getByTestId(testID).parent;
    while (node) {
      const style = StyleSheet.flatten(node.props.style ?? {}) as { paddingTop?: number };
      if (typeof node.type === 'string' && style.paddingTop !== undefined) return style.paddingTop;
      node = node.parent;
    }
    return undefined;
  };

  it.each([
    ['a long biography', LONG],
    ['a short biography', 'An actor and producer.'],
    ['no biography', null],
  ])('spaces %s the same way', async (_name, biography) => {
    bio(biography);
    const view = await open();
    if (biography === LONG) expect(view.getByTestId('biography-toggle')).toBeTruthy();
    if (biography === null) expect(view.queryByTestId('biography')).toBeNull();

    expect(padAbove(view, 'filmography-header')).toBe(theme.layout.section.above);
    expect(padAbove(view, 'filmography-controls')).toBe(theme.layout.section.headingToControls);
    // The first credit's row sits in the list, which opens `controlsToContent` below them.
    const firstRow = view.getByLabelText(/^Inception, 2010/);
    let node = firstRow.parent;
    let pad: number | undefined;
    while (node && pad === undefined) {
      const style = StyleSheet.flatten(node.props.style ?? {}) as { paddingTop?: number };
      if (typeof node.type === 'string' && style.paddingTop !== undefined) pad = style.paddingTop;
      node = node.parent;
    }
    expect(pad).toBe(theme.layout.section.controlsToContent);
  });
});

describe('at 320pt and the largest text size (C9)', () => {
  it('keeps both filmography rows on one line each, controls at 44pt', async () => {
    tableRows.person_cache = [
      {
        ...cached,
        payload: {
          ...cached.payload,
          credits: [
            ...cached.payload.credits,
            { id: 'film-2', kind: 'movie', role: 'Producer', as: 'crew', crew_role: 'Producer' },
          ],
        },
      },
    ];
    const view = await open();

    // Row 1: FILMOGRAPHY, then Movies ▾. The heading truncates to one line if it must.
    const header = expectRowFitsNarrow(view.getByTestId, 'filmography-header');
    expect(header.targets.map((target) => target.label)).toEqual(['Showing Movies']);
    expect(view.getByLabelText('Filmography').props.numberOfLines).toBe(1);

    // Row 2: Cast / Crew, then the filter icon — and the tabs fit beside it whole.
    const controls = expectRowFitsNarrow(view.getByTestId, 'filmography-controls');
    expect(controls.targets).toHaveLength(1);
    expect(naturalWidth(view.getByTestId('filmography-controls-leading'))).toBeLessThanOrEqual(
      controls.room,
    );
    for (const name of ['Cast', 'Crew']) {
      const tab = view.getByRole('tab', { name });
      expect(StyleSheet.flatten(tab.props.style).minHeight).toBeGreaterThanOrEqual(
        theme.layout.minTapTarget,
      );
    }
  });
});
