import { Ionicons } from '@expo/vector-icons';
import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { Alert, Linking, StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { brand } from '@/ui/tokens';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import TitleScreen from '../../../app/title/[id]';
import { hydrateTitleLayout, setTitleLayout } from './title-layout';

const mockPush = jest.fn();
/**
 * Tables whose read is parked rather than answered, keyed to the callbacks waiting on it.
 *
 * See `the page behind an open sheet` at the foot of this file: the defect it pins is only
 * visible while a query is fetching, and this mock otherwise answers within the same
 * microtask as the call.
 */
const mockHeld = new Map<string, (() => void)[]>();
/** Answers now, or when the table is released. */
const held = <T,>(table: string, answer: () => T): Promise<T> => {
  const waiting = mockHeld.get(table);
  if (!waiting) return Promise.resolve(answer());
  return new Promise<T>((resolve) => waiting.push(() => resolve(answer())));
};
const holdReadsOf = (table: string) => mockHeld.set(table, []);
const releaseReadsOf = (table: string) => {
  const waiting = mockHeld.get(table) ?? [];
  mockHeld.delete(table);
  for (const answer of waiting) answer();
};
const tableRows: Record<string, unknown[]> = {};
let mockRpcResults: Record<string, unknown> = {};
// Recorded rather than discarded: the collection writers this screen now calls are
// only observable as the RPC they send.
const mockRpc = jest.fn();

/**
 * Alert is a native module. Reporting has no confirmation step and no visible state
 * change, so an alert is the entire observable outcome of one — both the thank-you and
 * the failure sentence can only be read here.
 */
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

/** What each RPC fails with, when a test asks it to. Keyed by name. */
let mockRpcErrors: Record<string, unknown> = {};
/**
 * How many times each table has been read. An invalidation is worth nothing unless a
 * read follows it, so the reconciliation tests assert the refetch itself rather than
 * asserting a helper was called (independent review 21e).
 */
const mockReads: Record<string, number> = {};
/** Every `select`, by table and column list, so one read of a table can be told from another. */
const mockSelects: [string, string][] = [];
/**
 * What a series' season-list read fails with, when a test asks it to: the one read of
 * `media_items` filtered to `kind = 'season'` by `parent_id` (`useSeasons`).
 */
let mockSeasonListError: unknown = null;
/**
 * The `parent_id` of every season-list read that was sent, in order. A season or movie
 * page has no series, and a read with `parent_id = null` is one Postgres refuses (22P02).
 */
const mockSeasonListReads: unknown[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      const error = mockRpcErrors[name] ?? null;
      // A result may be a function of the call's arguments — the circle's `following` read
      // and the Reviews tab's read are one RPC told apart by `p_sort`.
      const result = mockRpcResults[name];
      const data = typeof result === 'function' ? (result as typeof mockRpc)(args) : result;
      return Promise.resolve({ data: error ? null : (data ?? null), error });
    },
    from: (table: string) => {
      mockReads[table] = (mockReads[table] ?? 0) + 1;
      const filters: Record<string, unknown> = {};
      const rows = () => {
        const source = tableRows[table] ?? [];
        return source.filter((row) => {
          const object = row as Record<string, unknown>;
          return Object.entries(filters).every(([key, value]) => object[key] === value);
        });
      };
      const chain = {
        select: (columns = '') => {
          mockSelects.push([table, columns]);
          return chain;
        },
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        in: () => chain,
        filter: () => chain,
        // Both return the chain: the collection and band-size reads page by keyset now
        // (`lib/read-all.ts`), so the call is `.order(...).limit(...)` and `then` is what
        // resolves it. `order` used to resolve, which made `.limit` a call on a promise.
        order: () => chain,
        limit: () => chain,
        gt: () => chain,
        single: () => held(table, () => ({ data: rows()[0] ?? null, error: null })),
        maybeSingle: () => held(table, () => ({ data: rows()[0] ?? null, error: null })),
        // `count` as well as `data`: `useCredits` first asks whether the cache has
        // any rows at all, with a head-only count query, and a mock that answered
        // only `data` made every cast list read as empty.
        // Held open when the test asks, so a refetch can be *observed* while it is still
        // in flight. Every read in this file otherwise resolves in the same microtask as
        // the call, which is exactly why a page that only misbehaves during a fetch had
        // no test until now.
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => void) => {
          if (table === 'media_items' && filters.kind === 'season' && 'parent_id' in filters) {
            mockSeasonListReads.push(filters.parent_id);
            // What PostgREST answers for `parent_id=eq.null` on a uuid column.
            if (filters.parent_id === null) {
              void Promise.resolve({
                data: null,
                error: { code: '22P02', message: 'invalid input syntax for type uuid: "null"' },
              }).then(resolve, reject);
              return;
            }
          }
          if (
            mockSeasonListError &&
            table === 'media_items' &&
            filters.kind === 'season' &&
            'parent_id' in filters
          ) {
            void Promise.resolve({ data: null, error: mockSeasonListError }).then(
              resolve,
              reject,
            );
            return;
          }
          void held(table, () => ({ data: rows(), error: null, count: rows().length })).then(
            resolve,
            reject,
          );
        },
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

// The header is a decision this screen makes, so the mock records it rather than
// discarding it. `Stack.Screen` renders nothing either way; the difference is that the
// options it was handed can now be asserted on.
let mockHeaderOptions: Record<string, unknown> = {};
// Which title the screen is opened on. A series and a film are the same route, and the
// difference between them is most of what the seasons flow is about.
let mockOpenId = 'film-1';
// Anything else the link carried. `recBy` and `recAt` are set by a tap in Sent to you
// and by nothing else, which is the whole reason the callout can be trusted.
let mockParams: Record<string, string> = {};

// Whether this title is the screen on top; the immersive status bar depends on it.
let mockFocused = true;
// Every status-bar style the screen asks for, in render order.
const mockStatusBars: string[] = [];
/**
 * Production's opt-in by default, so the Show previews tests below keep testing it; the
 * Preview default (stills with the page) is its own test (founder Preview QA, 2026-11-07).
 */
let mockPreviewsByDefault = false;
jest.mock('@/features/title/trailer-previews', () => ({
  trailerPreviewsByDefault: () => mockPreviewsByDefault,
}));

jest.mock('expo-status-bar', () => ({
  StatusBar: ({ style }: { style: string }) => {
    mockStatusBars.push(style);
    return null;
  },
}));
jest.mock('expo-router', () => ({
  useIsFocused: () => mockFocused,
  useRouter: () => ({ push: mockPush }),
  useLocalSearchParams: () => ({ id: mockOpenId, ...mockParams }),
  Stack: {
    Screen: ({ options }: { options?: Record<string, unknown> }) => {
      if (options) mockHeaderOptions = options;
      return null;
    },
  },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

// The screen fetches missing metadata on open. Not what these tests are about, and it
// would otherwise reach the adapter — but *whether* it asks is a decision the screen
// makes, so the mock records the arguments rather than discarding them.
const mockEnrichmentArgs: unknown[][] = [];
jest.mock('@/features/title/use-enrichment', () => ({
  useTitleEnrichment: (...args: unknown[]) => {
    mockEnrichmentArgs.push(args);
    return { enriching: false };
  },
  // **The real freshness rule**, not a stub. The screen's job is to decide *whether* to
  // ask, and since 2026-08-30 a stale season list is one of the reasons — so a mock that
  // always said "fresh" would make the one assertion below vacuous.
  seasonListIsStale: jest.requireActual('@/features/title/use-enrichment').seasonListIsStale,
}));

/**
 * The Episodes tab's fallback fetch.
 *
 * `use-enrichment` is mocked above, so nothing seeds the episode cache here and the
 * tab takes its own path — which is the one these tests want to exercise. The seeding
 * half, and the gate that stops the two racing, are pinned in `use-enrichment.test.ts`
 * where the enrichment is the real one.
 */
const mockFetchSeasonEpisodes = jest.fn();
/**
 * Availability, which the page asks about on mount rather than behind a tab.
 *
 * Mocked here for two reasons. The block is above the tab row, so every test in this
 * file renders it and an unmocked call would reach the adapter; and *whether* the page
 * asks — once, and not again when somebody changes tabs — is a decision the screen
 * makes, so the mock records the arguments rather than discarding them.
 */
const mockFetchWatchProviders = jest.fn();
jest.mock('@/lib/tmdb-adapter', () => ({
  ...jest.requireActual('@/lib/tmdb-adapter'),
  fetchSeasonEpisodes: (...args: unknown[]) => mockFetchSeasonEpisodes(...args),
  fetchWatchProviders: (...args: unknown[]) => mockFetchWatchProviders(...args),
  /**
   * Since 2026-09-13 a film opens on Similar, so every film in this file asks for its
   * similar titles on arrival, and a cold facet reaches this. It is answered with "nothing
   * written" rather than left to the real adapter, which would reach for an edge function
   * the supabase mock does not have. What Similar does is `SimilarTab.test.tsx`'s subject.
   */
  cacheSimilar: () => Promise.resolve({ id: 'film-1', written: 0 }),
}));

// The device's country, which is part of the provider request. Fixed rather than left
// to the runner, so the argument this file asserts on is the same everywhere.
jest.mock('expo-localization', () => ({
  getLocales: () => [{ regionCode: 'US' }],
}));

/**
 * An air date as the row renders it.
 *
 * Computed rather than written out, because the exact string is the runtime's to
 * decide: a hard-coded "17 Apr 2011" would pass here and fail on a machine with a
 * different default locale. What is asserted is that the date is shown, joined to the
 * runtime, and read in UTC — a bare `new Date('2011-04-17')` is midnight UTC and
 * renders as the day before west of Greenwich.
 */
const airDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

// Opening a trailer and opening a review are both handovers to the operating system,
// and what is handed over is the assertion.
const mockOpenURL = jest.fn();
// `default`, because react-native's index re-exports this module's default rather
// than the module itself — a named-export-only mock leaves `Linking` undefined.
jest.mock('react-native/Libraries/Linking/Linking', () => ({
  __esModule: true,
  default: {
    openURL: (...args: unknown[]) => mockOpenURL(...args),
    addEventListener: () => ({ remove: () => {} }),
    getInitialURL: () => Promise.resolve(null),
  },
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

/** A real eleven-character YouTube key, because `videoUri` checks the shape. */
const videos = {
  media_item_id: 'film-1',
  facet: 'videos',
  payload: {
    results: [
      {
        id: 'v1',
        key: 'YoHD9XEInc0',
        name: 'Official Trailer',
        type: 'Trailer',
        site: 'YouTube',
        official: true,
      },
    ],
  },
};

/**
 * The Cinematic page is the default since the release pass (2026-11-07); this file tests
 * the Original page unless a block opts into Cinematic itself, so every test starts there.
 */
beforeEach(async () => {
  await setTitleLayout('original');
});

beforeEach(() => {
  mockPreviewsByDefault = false;
  mockHeaderOptions = {};
  mockOpenId = 'film-1';
  mockParams = {};
  mockPush.mockReset();
  mockRpc.mockReset();
  alertSpy.mockClear();
  mockOpenURL.mockReset();
  mockEnrichmentArgs.length = 0;
  mockFetchSeasonEpisodes.mockReset();
  mockFetchWatchProviders.mockReset();
  // The default for every test that is not about availability: a title the provider
  // carries nowhere, which draws no block at all. Nothing outside the Where to watch
  // describe below should be seeing one.
  mockFetchWatchProviders.mockResolvedValue({ region: 'US', link: null, providers: [] });
  // The default for every test that is not about Episodes: a season with no published
  // list. Nothing outside the Episodes describes below should be reaching for one.
  mockFetchSeasonEpisodes.mockResolvedValue([]);

  mockHeld.clear();
  mockRpcResults = {};
  mockRpcErrors = {};
  mockSeasonListError = null;
  mockSeasonListReads.length = 0;
  for (const key of Object.keys(mockReads)) delete mockReads[key];
  mockSelects.length = 0;
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
  await waitFor(() => expect(view.getByText(/^Inception/)).toBeTruthy());
  return view;
};

describe('a title nobody has ranked', () => {
  it('offers a visible Rank button, never an invisible tappable area', async () => {
    // The badge-only version was a hotspot: tappable, with nothing saying so. The
    // control is now labelled and present in both states, in the same place.
    const view = await open();

    expect(view.getByTestId('title-action-rank')).toBeTruthy();
    expect(view.queryByLabelText('Ranked. Change your rating.')).toBeNull();
  });

  it('puts the genres above the description and never over the artwork', async () => {
    // The founder's order is metadata → genres → description: outward from what the
    // thing *is* to what it is *about*. Underneath the description they were a
    // footnote to a paragraph nobody had finished reading.
    const view = await open();
    expect(view.getByText('Science Fiction')).toBeTruthy();
  });

  it('does not put the ordinal anywhere', async () => {
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Details' }));

    expect(view.queryByText(/#\d/)).toBeNull();
  });

  /**
   * **An unranked title does not download the reader's ranked library** (2026-09-16).
   *
   * The ranked list feeds one thing on this page, the `#3 in Movies` segment, and only for
   * a title that is ranked. Unconditioned, every title opened from Search, For You or a
   * friend's activity read the whole list with its catalogue embed once the cache was a
   * minute old, which for a 700-title import is 700 rows per title opened.
   */
  it('does not read the ranked library for a title that is not in it', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-action-rank')).toBeTruthy());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const libraryReads = mockSelects.filter(
      ([table, columns]) => table === 'rankings' && columns.includes('media_items('),
    );
    expect(libraryReads).toHaveLength(0);
  });
});

/**
 * The page order, asserted rather than described (founder hierarchy pass).
 *
 * Every test above this one is a presence test — it asks whether something rendered,
 * not where. That is why the order drifted twice without a single failure: the score
 * moved below a paragraph of synopsis, five genre chips grew into three rows on a
 * 360pt screen, and the most prominent line under the title became the date the reader
 * already knew. None of it broke a test.
 *
 * So order is asserted here directly, off the rendered tree rather than off the source:
 * `readingOrder` walks `toJSON()` depth-first and collects the text it finds, which is
 * the order somebody scrolling reads it in. That is the property these assertions are
 * actually about, and it survives any amount of restructuring that keeps the reading
 * order intact.
 *
 * **Children only, never props.** `JSON.stringify(view.toJSON())` throws here: a node's
 * props carry React context objects that close a circle. The walk below is not an
 * optimisation, it is the reason this works at all.
 */
type RenderedNode = { children?: unknown } | string | null | undefined;

/** Every string in the tree, depth-first — the order a reader meets them in. */
const readingOrder = (node: unknown): string[] => {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(readingOrder);
  if (node && typeof node === 'object')
    return readingOrder((node as RenderedNode & object).children);
  return [];
};

describe('the page hierarchy', () => {
  /** Where a piece of rendered text sits in the page's reading order. */
  const positionOf = (view: { toJSON: () => unknown }, needle: string) => {
    const index = readingOrder(view.toJSON()).findIndex((text) => text.includes(needle));
    expect(index).toBeGreaterThanOrEqual(0);
    return index;
  };

  it('reads outward: title, metadata, actions, synopsis, genres, then the scores', async () => {
    /**
     * **The founder’s reconverged order** (physical Android, 2026-09-07): hero, title
     * and year, metadata, genres, synopsis, scores, where to watch, tabs.
     *
     * The page had been cut into six small bands with rules between them by successive
     * corrections — each defensible on its own, and together a screen the founder liked
     * less than the one it replaced. This is the rhythm restored: outward from what the
     * thing is called, to what it is, to what it is about, and only then to what other
     * people made of it and where to watch it.
     *
     * The genres and the synopsis have now swapped twice, so the reasoning is worth
     * stating here as well as in the screen. Genres-first reads outward, and that
     * argument lost to what the page looked like: a row of chips between the title and
     * the prose put a band of metadata in the one place a reader is trying to start
     * reading. The chips sit under the paragraph now, close to it, which they could only
     * do once `more` was guaranteed to be *on* the fourth line rather than under it.
     */
    const view = await open();
    await waitFor(() => expect(view.getByText('bingd')).toBeTruthy());

    expect(positionOf(view, '148 min')).toBeLessThan(
      positionOf(view, 'A thief who steals corporate secrets'),
    );
    expect(positionOf(view, 'A thief who steals corporate secrets')).toBeLessThan(
      positionOf(view, 'Science Fiction'),
    );
    expect(positionOf(view, 'Science Fiction')).toBeLessThan(positionOf(view, 'bingd'));
  });

  it('keeps the scores above the tabs, which is the rule that never changed', async () => {
    // Scores are core bingd. data and must not appear and disappear as somebody looks
    // at the cast. Every reordering of this page has preserved that, and this is what
    // says so out loud.
    const view = await open();
    await waitFor(() => expect(view.getByText('bingd')).toBeTruthy());

    expect(positionOf(view, 'bingd')).toBeLessThan(positionOf(view, 'Details'));
  });

  it('puts Rank, Save and Recommend in one group under the identity', async () => {
    /**
     * The founder's physical Android complaint, as an assertion. They were labelled
     * chips under the description, then bare glyphs beside the score, while Rank was a
     * full-height chip somewhere else again. The complaint each rearrangement was
     * answering is the same one: they did not read as alternatives to one another, which
     * is what they are. They are one group of three now, on one baseline, at one weight.
     *
     * Each glyph keeps a one-word caption. The founder's icon-only pass was right about
     * the weight and not about the words: a paper plane is Recommend here and Send
     * everywhere else, and nine points of `caption` settles it.
     */
    const view = await open();
    await waitFor(() => expect(view.getByText('bingd')).toBeTruthy());

    // Still there, still named in full for a screen reader — the acts are unchanged.
    expect(view.getByLabelText('Add Inception to your watchlist')).toBeTruthy();
    expect(view.getByLabelText('Recommend Inception to a friend')).toBeTruthy();

    // And in one cluster, above the synopsis rather than in a band of their own below
    // it. Only the rank control carries a word — the other two are glyphs with spoken
    // names — so the cluster is found by its own id rather than by reading text.
    expect(view.getByTestId('title-actions')).toBeTruthy();
    expect(view.getByTestId('title-action-rank')).toBeTruthy();
    expect(positionOf(view, 'Rank')).toBeLessThan(
      positionOf(view, 'A thief who steals corporate secrets'),
    );
  });

  it('draws the genres as one row between the metadata and the synopsis', async () => {
    /**
     * **How many chips fit is `GenreRow`’s question, not this page’s** (2026-09-07).
     *
     * It used to be a fixed three here, and that constant was the founder’s wrapped
     * `+1`: at some widths the third chip fitted and the marker did not. The count is
     * measured now, so the number of chips depends on a layout pass this renderer does
     * not run — asserting it here would be asserting the absence of a layout engine.
     * `GenreRow.test.tsx` covers the counting against real widths.
     *
     * What this page is still responsible for is that the row exists, that it is in the
     * right place, and that nothing is lost.
     */
    tableRows.media_items = [
      { ...film, genres: ['Science Fiction', 'Action', 'Adventure', 'Thriller', 'Drama'] },
    ];
    const view = await open();

    await waitFor(() => expect(view.getByTestId('genre-row')).toBeTruthy());
    expect(positionOf(view, '148 min')).toBeLessThan(
      positionOf(view, 'A thief who steals corporate secrets'),
    );
    expect(positionOf(view, 'A thief who steals corporate secrets')).toBeLessThan(
      positionOf(view, 'Science Fiction'),
    );
  });

  it('states the ones it could not fit, and loses none of them', async () => {
    tableRows.media_items = [
      { ...film, genres: ['Science Fiction', 'Action', 'Adventure', 'Thriller', 'Drama'] },
    ];
    const view = await open();

    // A count, not a chip: a reader must not be able to mistake it for a genre.
    await waitFor(() => expect(view.getByText(/^\+\d+$/)).toBeTruthy());
    expect(view.getByLabelText(/^And \d+ more genres\. See all genres$/)).toBeTruthy();

    await fireEvent.press(view.getByRole('tab', { name: 'Details' }));
    await waitFor(() =>
      expect(
        view.getByText('Science Fiction, Action, Adventure, Thriller, Drama'),
      ).toBeTruthy(),
    );
  });

  it('counts nothing when every genre fits', async () => {
    tableRows.media_items = [{ ...film, genres: ['Science Fiction'] }];
    const view = await open();

    await waitFor(() => expect(view.getByText('Science Fiction')).toBeTruthy());
    expect(view.queryByText(/^\+\d/)).toBeNull();
  });

  it('opens the whole list from the row', async () => {
    tableRows.media_items = [
      { ...film, genres: ['Science Fiction', 'Action', 'Adventure', 'Thriller'] },
    ];
    const view = await open();

    await waitFor(() => expect(view.getByTestId('genre-row')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Science Fiction. See all genres'));

    await waitFor(() => expect(view.getByLabelText('All genres')).toBeTruthy());
    for (const genre of ['Science Fiction', 'Action', 'Adventure', 'Thriller']) {
      expect(view.getAllByText(genre).length).toBeGreaterThan(0);
    }
  });

  it('leaves the genre chips exactly as the provider spells them', async () => {
    // No normalisation, no merging, no relabelling. "Sci-Fi" is not a synonym this
    // code gets to decide on: `media_items.genres` is what the adapter wrote, the
    // filter sheet's Genre section reads the same strings, and a rename here would
    // silently disagree with the facet a reader filters by.
    tableRows.media_items = [{ ...film, genres: ['Science Fiction', 'Action & Adventure'] }];
    const view = await open();

    await waitFor(() => expect(view.getByTestId('genre-row')).toBeTruthy());
    // Whichever of them the row has room for is spelled the provider’s way, and the
    // sheet behind it holds both, unaltered.
    expect(view.getByText('Science Fiction')).toBeTruthy();
    await fireEvent.press(view.getByLabelText('Science Fiction. See all genres'));
    await waitFor(() => expect(view.getByLabelText('All genres')).toBeTruthy());
    expect(view.getByText('Action & Adventure')).toBeTruthy();
  });
});

/**
 * The metadata line is `certification · runtime · director`, and all three can be absent
 * at once — an obscure title TMDB has not rated, has no runtime for, and credits no
 * director on.
 *
 * Independent review 17e: the line used to be a `Text` that was always rendered with a
 * filtered-and-joined string inside it, so "all three missing" produced an *empty* text
 * node rather than nothing. An empty `Text` is not nothing on screen — it is a line box
 * with the footnote's height, which reads as an unexplained gap under the title. That is
 * the same defect as the dead score space the founder's corrections removed from the
 * hero, which is why it is worth a test rather than a shrug.
 */
describe('the metadata line', () => {
  it('reads certification · runtime · director when it has all three', async () => {
    tableRows.media_items = [{ ...film, certification: 'PG-13' }];
    tableRows.media_cache = [credits];

    const view = await open();

    await waitFor(() =>
      expect(view.getByTestId('title-meta')).toHaveTextContent(
        'PG-13 · 148 min · Christopher Nolan',
      ),
    );
  });

  it('drops only the missing parts, without a stray separator', async () => {
    // No certification on the fixture. The line must not begin with a separator or
    // double one up where the missing value was.
    //
    // This one is **not** independently discriminating and the pair is what covers the
    // case: an implementation that dropped certification unconditionally would pass here,
    // because this fixture has none to lose. The test above is what fails that mutation.
    tableRows.media_cache = [credits];

    const view = await open();

    await waitFor(() =>
      expect(view.getByTestId('title-meta')).toHaveTextContent('148 min · Christopher Nolan'),
    );
    expect(view.getByTestId('title-meta')).not.toHaveTextContent(/^\s*·/);
    expect(view.getByTestId('title-meta')).not.toHaveTextContent(/·\s*·/);
  });

  it('renders no line at all when it would be empty, rather than an empty one', async () => {
    // Every part gone: no certification, no runtime, and no credits facet to name a
    // director. Under the original implementation the `Text` was rendered
    // unconditionally around a joined string, so this produced an empty line box and
    // `title-meta` was present. Restoring that shape fails exactly this assertion.
    tableRows.media_items = [{ ...film, certification: null, runtime_minutes: null }];
    tableRows.media_cache = [];

    const view = await open();

    expect(view.queryByTestId('title-meta')).toBeNull();
  });
});

describe('a title this user has ranked', () => {
  beforeEach(() => {
    tableRows.rankings = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        position: 1,
        category: 'movies',
        bucket: 'loved',
      },
      {
        user_id: 'user-1',
        media_item_id: 'other',
        position: 2,
        category: 'movies',
        bucket: 'loved',
      },
    ];
    tableRows.user_media = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        bucket: 'loved',
        watched_on: '2026-08-12',
        note: 'Held up better than I expected.',
        // Stated rather than left to the column default, because the Ranked menu now
        // names which of the two this writing is and a fixture that omits it would be
        // asserting against an assumption.
        note_visibility: 'private',
        note_has_spoilers: false,
      },
    ];
  });

  it('shows the score, not the position', async () => {
    const view = await open();

    // Top of a two-title Loved band, so the band's high. **Once**, and in the Scores
    // section: it sat on the poster's corner until the founder's 2026-09-07 lock, and
    // before that it was in both places at once.
    await waitFor(() => expect(view.getAllByLabelText('10.0 out of 10')).toHaveLength(1));
  });

  it('puts its one copy in the Scores row and never on the poster', async () => {
    const view = await open();

    await waitFor(() => expect(view.getByTestId('scores-section')).toBeTruthy());

    /**
     * **The number is stated exactly once on this page, and the poster carries none of
     * it** (founder lock, 2026-09-07).
     *
     * It was a badge overhanging the poster's lower-left corner with a `Your score`
     * caption under it. Every revision of that fought the artwork it was pinned to, and
     * beside a poster the number had nothing to be measured against. In the Scores row it
     * is the first term of a comparison the reader reads straight across.
     */
    expect(view.getAllByLabelText('10.0 out of 10')).toHaveLength(1);
    expect(view.getAllByText('Your score')).toHaveLength(1);

    // And the words and the number are in the same place: the unit, not the poster.
    const poster = view.getByTestId('title-poster-column');
    expect(within(poster).queryByText('Your score')).toBeNull();
    expect(within(poster).queryByLabelText(/out of 10/)).toBeNull();
    expect(view.queryByTestId('title-score-anchor')).toBeNull();

    // Three units, in the founder's order: me, then the people I chose, then the room.
    expect(view.getByText('Following')).toBeTruthy();
    expect(view.getByText('bingd')).toBeTruthy();
  });

  it('puts no bucket word, rank or watch date under the personal score', async () => {
    /**
     * All three were proposed for that cell and all three were cut. `I liked it` under a
     * 10.0 is jargon this screen has never spoken; the placement and the date are the
     * reader's *history* with the title rather than a qualification of an aggregate, and
     * they stay on the identity line where they describe exactly that.
     */
    const view = await open();
    await waitFor(() => expect(view.getByTestId('scores-section')).toBeTruthy());

    const scores = view.getByTestId('scores-section');
    expect(within(scores).queryByText(/^(I liked it|It was fine|Not for me)$/)).toBeNull();
    expect(within(scores).queryByText(/^#\d+ in /)).toBeNull();
    expect(within(scores).queryByText(/Watched /)).toBeNull();

    // Where they actually live.
    expect(view.getByTestId('title-context')).toHaveTextContent(/#1 in Movies/);
  });

  it('says where it sits in their own list, as an ordinal', async () => {
    // A segment of the identity's context line since 2026-09-07, rather than a row of
    // its own under a detached score: `#1 in Movies` is four characters of information
    // and does not deserve a line. The rule that decides whether there is one at all is
    // unchanged — top ten only, or nothing (`heroRankFor`).
    const view = await open();
    await waitFor(() =>
      expect(view.getByTestId('title-context')).toHaveTextContent(/#1 in Movies/),
    );
  });

  it('shows a Ranked control that opens the rating and collection menu', async () => {
    /**
     * **The control and its contract are the ones this page has always had** (founder,
     * final direction, 2026-09-07). An intermediate pass replaced it with an Adjust glyph
     * that went straight to a same-watch rerank; that was rejected, because choosing
     * between adjusting a placement and declaring a rewatch is the reader's decision and
     * the menu is where they make it.
     *
     * The menu is reachable two ways and both open the same sheet: the control itself,
     * and the overflow in the top bar.
     */
    const view = await open();

    await waitFor(() => expect(view.getByTestId('title-action-ranked')).toBeTruthy());
    expect(view.getByText('Ranked')).toBeTruthy();

    await fireEvent.press(view.getByTestId('title-action-ranked'));
    expect(view.getByText('Edit ranking')).toBeTruthy();
    expect(view.getByText('Log another watch')).toBeTruthy();
  });

  it('offers the same menu from the overflow control in the bar', async () => {
    const view = await open();

    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-more'));

    expect(view.getByText('Edit ranking')).toBeTruthy();
  });

  /**
   * The way out of a ranking, which did not exist before the pass that added this
   * sheet — `rank_unrank` and `unlog` were granted from the first migration and nothing
   * on the client had ever called either.
   *
   * **Two rows became five, in three groups.** The founder's device pass found the menu
   * was where writing went to be unreachable: once a title was ranked there was no
   * obvious way back to a review or a private note, and Rank again — which T2 built as
   * an atomic server call — was offered nowhere at all.
   *
   * "Remove ranking" is still gone and is still not coming back. It offered a state
   * Bingd does not otherwise have: a title kept in the collection with no position,
   * permanently, by choice.
   */
  it('groups the rows: your log, then ranking, then the collection', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-more'));

    await waitFor(() => expect(view.getByLabelText('Edit ranking')).toBeTruthy());
    // Five rows in one column with no structure is a list you read rather than a menu
    // you use, and the destructive one has to be last and on its own.
    expect(view.getByText('YOUR LOG')).toBeTruthy();
    expect(view.getByText('RANKING')).toBeTruthy();
    expect(view.getByText('COLLECTION')).toBeTruthy();
    expect(view.getByLabelText('Remove from collection')).toBeTruthy();
  });

  /**
   * **Rank again, which T2 built and nothing offered.**
   *
   * `rank_again` (20260825000200) unranks and re-opens a session inside the *same* band
   * in one atomic call — it exists because `rank_rebucket` refuses a bucket that is not
   * moving. The client reaches it by opening the ranking sheet in `rerank` mode, which
   * is the only way this app is allowed to do it: composing `rank_unrank` and
   * `rank_start` here would open a window in which the title has no position and no
   * session, and a dropped connection inside it loses the ranking outright.
   */
  /**
   * **The rewatch row opens the watch, and the atomic guarantee is still what matters
   * behind it** (T3b).
   *
   * The row reached `rank_again` directly until 20261005000100 — a forced full re-rank
   * that recorded no watch and no date. It opens the sheet that records the viewing
   * first, so this test asserts what is still true and load-bearing at this seam: the
   * screen never composes `rank_unrank` and `rank_start`, which would open a window in
   * which the title has no position and no session, and a dropped connection inside it
   * loses the ranking outright.
   */
  it('never composes an unrank and a restart, from either ranking row', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-more'));
    await waitFor(() => expect(view.getByLabelText('Log another watch')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Log another watch'));

    // The rewatch sheet opens on its bands; nothing is unranked or restarted by opening it.
    await waitFor(() => expect(view.getByTestId('rewatch-bucket-choices')).toBeTruthy());
    expect(mockRpc).not.toHaveBeenCalledWith('rank_unrank', expect.anything());
    expect(mockRpc).not.toHaveBeenCalledWith('rank_start', expect.anything());
  });

  it('names the title the rewatch is about, rather than deciding a rating', async () => {
    // The sheet decides no band: the re-check behind it passes `rankings.bucket`
    // straight through, which is asserted where that call is made
    // (`adjusting a ranking versus watching it again`). What belongs here is that the
    // row opens the right title's sheet at all.
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-more'));
    await waitFor(() => expect(view.getByLabelText('Log another watch')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Log another watch'));

    // The log sheet in rewatch mode: the title's own header, and How was it?.
    await waitFor(() => expect(view.getByTestId('rewatch-bucket-choices')).toBeTruthy());
    expect(view.getByText('How was it?')).toBeTruthy();
    expect(view.getAllByText('Inception').length).toBeGreaterThan(0);
  });

  /**
   * **The Ranking group is two rows, and it is the founder's list** (2026-09-08).
   *
   *   ★ Edit ranking         the current watch, corrected
   *   ↻ Log another watch    an explicit second viewing
   *
   * It was three. *Rank it again* and *Change your rating* were two doors into the same
   * correction, distinguished only by a mechanism — one skipped the band chooser — and
   * no ordinary reader could say which of the two they wanted from the labels. The
   * founder's consolidation keeps the act and drops the second door.
   *
   * **The subtext under each row is gone, and this test says so too.** It asserted both
   * sentences were present, and the founder's device pass is the reason it does the
   * opposite: `SheetRow` puts the label and its secondary sentence on one line, so at the
   * width of a phone every explanation in this menu truncated. Rows of clipped grey text
   * under clear labels are worse than no explanation, because the reader can see
   * something was meant to be said and cannot read it.
   */
  it('offers exactly two ranking rows, and neither of the retired labels', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-more'));

    await waitFor(() => expect(view.getByLabelText('Edit ranking')).toBeTruthy());
    expect(view.getByLabelText('Log another watch')).toBeTruthy();

    // The two labels the founder retired, in both the forms they were ever drawn in.
    expect(view.queryByText('Rank it again')).toBeNull();
    expect(view.queryByLabelText('Rank it again')).toBeNull();
    expect(view.queryByText('Change your rating')).toBeNull();
    expect(view.queryByLabelText('Change your rating')).toBeNull();
    expect(view.queryByLabelText('Rank again')).toBeNull();

    expect(view.queryByText('Pick a different loved, fine or not for me')).toBeNull();
    expect(view.queryByText('Compare it again in the same rating')).toBeNull();
  });

  /**
   * Every row in this menu, and not one secondary sentence between them.
   *
   * Asserted as a sweep rather than row by row, because the failure mode is *a row
   * somebody adds later with a `value` on it* — which is how the menu accumulated five
   * of them in the first place.
   */
  it('draws the whole ranked menu without a line of truncating subtext', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-more'));

    await waitFor(() => expect(view.getByLabelText('Log another watch')).toBeTruthy());
    // This fixture holds a private note, so the one writing row reads Edit your note.
    // The headings and the last three rows are the same whichever state it is in.
    for (const label of [
      'Edit your note',
      'Who I watched with',
      'Edit ranking',
      'Log another watch',
      'Remove from collection',
    ]) {
      expect(view.getByLabelText(label)).toBeTruthy();
    }
    for (const subtext of [
      'Anyone who can see your profile',
      'Only you can read this',
      'Compare it again in the same rating',
      'Pick a different loved, fine or not for me',
      'Rating, date and anything you wrote',
    ]) {
      expect(view.queryByText(subtext)).toBeNull();
    }
  });

  /**
   * **Writing, reachable after the fact — as one row (founder simplification,
   * 2026-08-27).**
   *
   * One `user_media` row holds one `note` under one `note_visibility`, and the menu
   * now shows it as one thing. The two rows this replaces — Edit and the conversion,
   * each way around — asked the reader to choose between two names for one piece of
   * writing before opening it. The label still says which state the writing is in,
   * because "Edit your review" is a promise about where the text is visible; the
   * conversion control lives in the composer, beside the text it describes.
   */
  const openMenu = async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-more'));
    await waitFor(() => expect(view.getByLabelText('Edit ranking')).toBeTruthy());
    return view;
  };

  it('says Edit your note for the note this title already carries, and lands in it', async () => {
    const view = await openMenu();

    expect(view.getByLabelText('Edit your note')).toBeTruthy();
    // The old pair — and the conversion rows that travelled with it — are gone.
    expect(view.queryByLabelText('Edit private note')).toBeNull();
    expect(view.queryByLabelText('Share as a review')).toBeNull();
    expect(view.queryByLabelText('Add a note')).toBeNull();

    await fireEvent.press(view.getByLabelText('Edit your note'));

    // A row that names a piece of writing lands the reader inside it: the log sheet
    // opens with the composer already showing the stored text.
    await waitFor(() =>
      expect(view.getByPlaceholderText('What did you think?').props.value).toBe(
        'Held up better than I expected.',
      ),
    );
  });

  it('says Edit your review when the writing is one', async () => {
    tableRows.user_media = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        bucket: 'loved',
        watched_on: '2026-08-12',
        note: 'Held up better than I expected.',
        note_visibility: 'public',
        note_has_spoilers: false,
      },
    ];
    const view = await openMenu();

    expect(view.getByLabelText('Edit your review')).toBeTruthy();
    // No conversion row in either direction: the chip in the composer is the only
    // control that moves writing between the two states now.
    expect(view.queryByLabelText('Edit review')).toBeNull();
    expect(view.queryByLabelText('Make it a private note')).toBeNull();
  });

  /**
   * **Who I watched with, reachable without going through the rating** (founder device
   * pass, 2026-08-29).
   *
   * Companions were behind *Change your rating*, which opens the bucket chooser — so the
   * way to correct who you watched something with ran through a control that offers to
   * re-rate it. The founder called that hidden, and it is: the row somebody is looking
   * for is named "Who I watched with" and the row they had to press was named something
   * else entirely.
   *
   * The row edits the log occurrence that is already there. Everything it must NOT do is
   * asserted below, because that list is the whole risk of adding a second door into the
   * same sheet.
   */
  it('offers Who I watched with directly under the writing row', async () => {
    const view = await openMenu();

    const rows = view.getAllByRole('button').map((node) => node.props.accessibilityLabel);
    const note = rows.indexOf('Edit your note');
    const who = rows.indexOf('Who I watched with');
    expect(note).toBeGreaterThanOrEqual(0);
    expect(who).toBe(note + 1);
  });

  it('opens the companion picker on the log that is already there', async () => {
    const view = await openMenu();
    await fireEvent.press(view.getByLabelText('Who I watched with'));

    // The picker is expanded on arrival — the point of the row — and the note composer
    // is not, so the keyboard stays down. Read off the row's own announced state rather
    // than off a child, because "expanded" is exactly what the row promises.
    await waitFor(() =>
      expect(view.getByLabelText('Who I watched with').props.accessibilityState?.expanded).toBe(
        true,
      ),
    );
    expect(view.queryByPlaceholderText('What did you think?')).toBeNull();
  });

  it('starts no ranking and creates no second log', async () => {
    const view = await openMenu();
    await fireEvent.press(view.getByLabelText('Who I watched with'));
    await waitFor(() =>
      expect(view.getByLabelText('Who I watched with').props.accessibilityState?.expanded).toBe(
        true,
      ),
    );

    // None of the four writers that would move a score, a band or a position, and none
    // of the two that would post an activity.
    // `log_title` joins the list, and `set_bucket` stays on it: the sheet calls the
    // first now (T3b) and installed clients still call the second, so a screen that
    // opened a row must be silent to both.
    for (const rpc of [
      'rank_again',
      'rank_start',
      'rank_rebucket',
      'set_bucket',
      'log_title',
    ]) {
      expect(mockRpc).not.toHaveBeenCalledWith(rpc, expect.anything());
    }
  });

  it('writes nothing at all until somebody is chosen', async () => {
    // Opening a row is not an edit. The founder's rule for every other row in this sheet
    // and there is no reason for this one to be the exception.
    const view = await openMenu();
    const before = mockRpc.mock.calls.length;

    await fireEvent.press(view.getByLabelText('Who I watched with'));
    await waitFor(() =>
      expect(view.getByLabelText('Who I watched with').props.accessibilityState?.expanded).toBe(
        true,
      ),
    );

    expect(mockRpc).not.toHaveBeenCalledWith('set_watch_tags', expect.anything());
    expect(mockRpc.mock.calls.length).toBeGreaterThanOrEqual(before);
  });

  /**
   * **The removal confirmation, shortened without dropping a consequence.**
   *
   * It was one paragraph of four clauses, which is a wall at the moment somebody is
   * trying to make a decision — the founder's note. It is two sentences now: what goes,
   * then who else it touches.
   *
   * Nothing was traded away for the length. Every consequence the old copy named is
   * still named — rating, watch date, writing, activity, reactions, comments, and that
   * you can log it again — and the second sentence stands alone because it is the half
   * that falls on somebody who is not in the room, which is exactly the sort a
   * confirmation exists to state.
   */
  it('names every consequence in two short sentences', async () => {
    const view = await openMenu();

    await fireEvent.press(view.getByLabelText('Remove from collection'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    const [heading, body] = alertSpy.mock.calls.at(-1) ?? [];
    // Media-aware, as the rest of the app is: a film by its name, a season by its
    // compact one.
    expect(heading).toBe('Remove Inception from your collection?');
    expect(body).toBe(
      'This removes your rating, watch date, review or private note, and related ' +
        'activity. You can log it again later.\n\nIt also removes any reactions and ' +
        'comments on that activity.',
    );
  });

  it('still asks before it removes anything, and removes nothing until it is answered', async () => {
    const view = await openMenu();

    await fireEvent.press(view.getByLabelText('Remove from collection'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    // Shorter copy, same gate. The deletion behaviour behind it is untouched by this
    // tranche.
    expect(mockRpc).not.toHaveBeenCalledWith('unlog', expect.anything());
    const buttons = alertSpy.mock.calls.at(-1)?.[2] ?? [];
    expect(buttons.map((button) => button.text)).toEqual(['Cancel', 'Remove']);
    expect(buttons.find((button) => button.text === 'Remove')?.style).toBe('destructive');
  });

  it('offers one Add a note row when there is no writing yet', async () => {
    tableRows.user_media = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        bucket: 'loved',
        watched_on: '2026-08-12',
        note: '',
        note_visibility: 'private',
        note_has_spoilers: false,
      },
    ];
    const view = await openMenu();

    // One row, one word. A note is private until its author shares it, and the
    // sharing is the composer's chip — not a second menu row.
    expect(view.getByLabelText('Add a note')).toBeTruthy();
    expect(view.queryByLabelText('Write review')).toBeNull();
    expect(view.queryByLabelText('Add private note')).toBeNull();
  });

  it('no longer offers to keep a title in the collection without a ranking', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-more'));
    await waitFor(() => expect(view.getByLabelText('Edit ranking')).toBeTruthy());

    expect(view.queryByLabelText('Remove ranking')).toBeNull();
    expect(view.queryByText('Keeps it in your collection')).toBeNull();
    // And nothing on the screen can reach the function on its own any more. It is still
    // granted and still load-bearing — `rank_rebucket` calls it to move a title between
    // bands — but no user-facing control invokes it directly.
    expect(mockRpc).not.toHaveBeenCalledWith('rank_unrank', expect.anything());
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
    // "bingd", not "Community". The old label described a population where the new one
    // names it, and the app has a name.
    expect(view.getByText('bingd')).toBeTruthy();
    expect(view.getByText('12 ratings')).toBeTruthy();
  });

  it('lives in its own row rather than beside the reader’s own score', async () => {
    // The two were the same shape at the same weight in the hero, one about you and
    // one about the room. The hero answers "what did I think" now; this row answers
    // what everybody else did, directly under the metadata.
    mockRpcResults.community_score = [{ score: '7.4', rating_count: 12, min_ratings: 3 }];
    const view = await open();

    await waitFor(() => expect(view.getByTestId('scores-section')).toBeTruthy());
  });

  it('never calls the aggregate a rank', async () => {
    mockRpcResults.community_score = [{ score: '7.4', rating_count: 12, min_ratings: 3 }];
    const view = await open();

    await waitFor(() => expect(view.getByText('bingd')).toBeTruthy());
    // It is a mean. An ordinal is what "#1 in Movies" is, and that is a different
    // line about a different thing.
    expect(view.queryByText(/community rank/i)).toBeNull();
  });

  it('withholds a number the sample cannot support, and does not count down to it', async () => {
    mockRpcResults.community_score = [{ score: null, rating_count: 2, min_ratings: 3 }];
    const view = await open();

    await waitFor(() =>
      expect(view.getAllByText('Not enough ratings').length).toBeGreaterThan(0),
    );
    // The founder’s correction: "2 ratings · 1 more needed" turns a reader into a
    // spectator of a counter they cannot move, and the shortfall is a property of a
    // config value rather than of the film.
    expect(view.queryByText(/more needed/)).toBeNull();
    // Never a zero, and never a real number faded to say "do not trust this".
    expect(view.queryByText('0.0')).toBeNull();
  });

  it('says the same thing when nobody has rated it at all', async () => {
    mockRpcResults.community_score = [{ score: null, rating_count: 0, min_ratings: 3 }];
    const view = await open();

    // One sentence for both, because the reader can act on neither and the difference
    // between nought and two is not a difference in what the page can tell them.
    await waitFor(() =>
      expect(view.getAllByText('Not enough ratings').length).toBeGreaterThan(0),
    );
  });
});

describe('the cast', () => {
  beforeEach(() => {
    tableRows.media_cache = [credits];
  });

  /**
   * The Cast tab, chosen.
   *
   * A film used to open on Cast. Since 2026-09-13 it opens on Similar (founder), and Cast
   * is second, so each test here presses it — once, which is all the RNTL setup in this
   * repo tolerates of a single element per test.
   */
  const openCast = async () => {
    const view = await open();
    await waitFor(() => expect(view.getByRole('tab', { name: 'Cast' })).toBeTruthy());
    await fireEvent.press(view.getByRole('tab', { name: 'Cast' }));
    return view;
  };

  it('names people rather than showing initials as the intended state', async () => {
    const view = await openCast();
    await waitFor(() => expect(view.getByText('Leonardo DiCaprio')).toBeTruthy());
    expect(view.getByText('Cobb')).toBeTruthy();
  });

  it('opens the person behind the face', async () => {
    const view = await openCast();
    await waitFor(() => expect(view.getByText('Leonardo DiCaprio')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Leonardo DiCaprio, who plays Cobb'));
    expect(mockPush).toHaveBeenCalledWith('/person/6193');
  });

  it('still lists someone with no photograph', async () => {
    // Below the top billing most people have no portrait, so a strip that only
    // worked with imagery would be half empty on every title.
    const view = await openCast();
    await waitFor(() => expect(view.getByText('Joseph Gordon-Levitt')).toBeTruthy());
  });
});

describe('tabs that have nothing behind them', () => {
  it('always offers Reviews, because the reader can write the first one', async () => {
    // The rule against permanently-empty tabs is about a tab that can only ever have
    // nothing — a film TMDB publishes no trailer for. Reviews can always have
    // something, and removing it until somebody else had written would mean the only
    // way to leave the first review of a film is to already have left it.
    const view = await open();

    expect(view.getByRole('tab', { name: 'Reviews' })).toBeTruthy();
  });

  /**
   * The count in parentheses (founder, physical QA, 2026-09-14): `Reviews 1` read as
   * ambiguous. The number is the server's `title_review_count`, which counts public reviews
   * the reader may see, their own included. Zero is plain `Reviews`, never `Reviews (0)`.
   */
  it('puts the review count in parentheses', async () => {
    mockRpcResults.title_review_count = 2;
    const view = await open();

    await waitFor(() => expect(view.getByRole('tab', { name: 'Reviews (2)' })).toBeTruthy());
    expect(view.queryByRole('tab', { name: 'Reviews 2' })).toBeNull();
  });

  it('never renders Reviews (0)', async () => {
    mockRpcResults.title_review_count = 0;
    const view = await open();

    await waitFor(() => expect(view.getByRole('tab', { name: 'Reviews' })).toBeTruthy());
    expect(view.queryByRole('tab', { name: /Reviews \(0\)/ })).toBeNull();
  });

  it('does not render a Videos tab until there are videos', async () => {
    const view = await open();
    expect(view.queryByRole('tab', { name: 'Videos' })).toBeNull();
  });

  it('renders Videos once the facet has something in it', async () => {
    tableRows.media_cache = [videos];
    const view = await open();

    await waitFor(() => expect(view.getByRole('tab', { name: 'Videos' })).toBeTruthy());
    await fireEvent.press(view.getByRole('tab', { name: 'Videos' }));
    await waitFor(() => expect(view.getByText('Official Trailer')).toBeTruthy());
  });

  it('opens a trailer on YouTube rather than playing it in the app', async () => {
    // The stored value is a site key, not a URL, so this is the one place the two are
    // joined — and the join is what has to be safe. `Linking.mockOpenURL` hands it to the
    // YouTube app where one is installed and to the browser where one is not; an
    // in-app player would be a native dependency for a single screen.
    tableRows.media_cache = [videos];
    const view = await open();

    await waitFor(() => expect(view.getByRole('tab', { name: 'Videos' })).toBeTruthy());
    await fireEvent.press(view.getByRole('tab', { name: 'Videos' }));
    await fireEvent.press(view.getByLabelText('Play Official Trailer on YouTube'));

    expect(mockOpenURL).toHaveBeenCalledWith('https://www.youtube.com/watch?v=YoHD9XEInc0');
  });

  it('refuses to build a link out of something that is not a video key', async () => {
    // A key is eleven characters of a known alphabet. Anything else is provider data
    // that has changed shape, and the app is about to hand it to the operating
    // system — so the row simply does not open rather than opening something else.
    tableRows.media_cache = [
      {
        ...videos,
        payload: {
          results: [{ ...videos.payload.results[0], key: 'https://evil.example/x' }],
        },
      },
    ];
    const view = await open();

    // `open()` waits for the title, which comes from the media row. The Videos tab comes
    // from the cached-videos query and is not on screen yet — the two tests above press
    // it through this same wait, and this one was pressing it through none.
    await waitFor(() => expect(view.getByRole('tab', { name: 'Videos' })).toBeTruthy());
    await fireEvent.press(view.getByRole('tab', { name: 'Videos' }));
    await fireEvent.press(view.getByLabelText('Play Official Trailer on YouTube'));

    expect(mockOpenURL).not.toHaveBeenCalled();
  });

  it('does not render a Seasons tab for a film', async () => {
    const view = await open();
    expect(view.queryByRole('tab', { name: 'Seasons' })).toBeNull();
  });

  it('does not render a Cast tab for a title with no credits', async () => {
    const view = await open();
    expect(view.queryByRole('tab', { name: 'Cast' })).toBeNull();
  });

  /**
   * **Original layout never mounts TrailerRail** (production trailer enablement,
   * 2026-11-09). The Cinematic page is the default; Original is one Labs switch away.
   * Even when `trailerPreviewsByDefault` returns `true` (production), the Original
   * layout's Videos tab is text rows — it never renders `trailer-still` or
   * `trailer-rail` testIDs and never makes a YouTube image request.
   */
  it('does not load YouTube thumbnails in Original layout, even when videos are present', async () => {
    tableRows.media_cache = [videos];
    const view = await open();

    // The Videos tab is present in Original layout (text rows).
    await waitFor(() => expect(view.getByRole('tab', { name: 'Videos' })).toBeTruthy());
    await fireEvent.press(view.getByRole('tab', { name: 'Videos' }));

    // No TrailerRail, no thumbnail images — not before and not after opening the tab.
    expect(view.queryByTestId('trailer-rail')).toBeNull();
    expect(view.queryByTestId('trailer-still')).toBeNull();
  });
});

/**
 * Reviews are Bingd's, not TMDB's.
 *
 * The founder's correction: a tab called Reviews on a social product should be Bingd's
 * own. TMDB's review endpoint is another site's members writing about a film — it was
 * labelled scrupulously and it was still the wrong content — so it left the primary
 * title UX entirely rather than being relabelled as critic writing, which was never on
 * the table.
 *
 * A review **is** a public Note. One source of truth with the Feed, one composer in the
 * log sheet, one spoiler flag, one visibility setting.
 */
describe('reviews', () => {
  const review = {
    // The `user_media` row the review is written on — its report subject, added by
    // 20260825000100. Not the media item: two people reviewing one film must be two
    // subjects, or the second complaint collides with the first and is dropped.
    id: 'um-ada-film1',
    user_id: 'user-2',
    username: 'ada',
    display_name: 'Ada',
    avatar_path: null,
    note: 'The last twenty minutes are the whole film.',
    has_spoilers: false,
    updated_at: '2026-08-16T10:00:00.000Z',
    score: '8.4',
    reaction_count: 3,
    // 20260911000100. The count is everybody's; `viewer_helpful` is only ever this
    // reader's own, which is what the row has to carry for the control to draw a state.
    helpful_count: 0,
    viewer_helpful: false,
  };

  it('shows a Bingd reader’s note, under their name and beside their score', async () => {
    mockRpcResults.title_reviews_v2 = [review];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.getByText('The last twenty minutes are the whole film.')).toBeTruthy();
    // The author's own number, in the app's one chromatic element. A review without it
    // is half the opinion.
    expect(view.getByText('8.4')).toBeTruthy();
  });

  it('names nothing of TMDB’s, because none of it is here any more', async () => {
    mockRpcResults.title_reviews_v2 = [review];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.queryByText(/themoviedb/i)).toBeNull();
    expect(view.queryByText(/critic/i)).toBeNull();
    expect(view.queryByText(/on TMDB/i)).toBeNull();
  });

  /**
   * Reporting a review.
   *
   * The subject is the `user_media` row rather than the title or the author, which is
   * the part worth pinning: reporting by `media_item_id` would have made two authors'
   * reviews of one film collide on `reports_one_open_per_reporter`, so the second
   * report a reader filed about that title would have been silently swallowed.
   */
  it('reports a review by its own id, not by the title or the author', async () => {
    mockRpcResults.title_reviews_v2 = [review];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    await fireEvent.press(view.getByLabelText("Report Ada's review"));
    await fireEvent.press(view.getByText('Hate speech'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('report', {
        p_subject_type: 'review',
        p_subject_id: 'um-ada-film1',
        p_reason: 'hate_speech',
      }),
    );
  });

  /**
   * The viewer's own review has no Report control.
   *
   * `report()` refuses a self-report with a 22023, so the control could only ever
   * produce an error message here. Absent rather than disabled: a disabled control asks
   * the reader to work out why, and the answer — "you wrote this" — is already obvious
   * from the row.
   */
  it('offers no Report on the viewer’s own review', async () => {
    mockRpcResults.title_reviews_v2 = [
      { ...review, id: 'um-mine', user_id: 'user-1', username: 'sai', display_name: 'Sai' },
    ];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));
    await waitFor(() => expect(view.getByText('Sai')).toBeTruthy());

    expect(view.queryByLabelText("Report Sai's review")).toBeNull();
  });

  it('says a review has gone rather than failing, when its author deleted it', async () => {
    mockRpcResults.title_reviews_v2 = [review];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    // P0002 is also what a note made private answers with, which is the same story to
    // the reader: it is not there to report any more.
    mockRpcErrors.report = { code: 'P0002', message: 'no such subject' };
    await fireEvent.press(view.getByLabelText("Report Ada's review"));
    await fireEvent.press(view.getByText('Spam or a scam'));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        'Could not report',
        'That has already been removed.',
      ),
    );
  });

  it('opens the reviewer’s profile', async () => {
    mockRpcResults.title_reviews_v2 = [review];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Ada, @ada'));
    expect(mockPush).toHaveBeenCalledWith('/u/ada');
  });

  it('masks a spoiler from somebody who has not watched this exact title', async () => {
    mockRpcResults.title_reviews_v2 = [{ ...review, has_spoilers: true }];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.queryByText('The last twenty minutes are the whole film.')).toBeNull();
  });

  it('shows it once they have watched it, rather than making them reveal it', async () => {
    // The founder's correction: somebody who has seen the film should not have to tap
    // through every spoiler on the page.
    mockRpcResults.title_reviews_v2 = [{ ...review, has_spoilers: true }];
    tableRows.user_media = [{ user_id: 'user-1', media_item_id: 'film-1' }];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));

    await waitFor(() =>
      expect(view.getByText('The last twenty minutes are the whole film.')).toBeTruthy(),
    );
  });

  it('offers the sort only when there is something to sort', async () => {
    mockRpcResults.title_reviews_v2 = [review];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.queryByRole('tab', { name: 'Top, most helpful first' })).toBeNull();
  });

  it('sorts by Top first, which is what a first-time reader wants', async () => {
    mockRpcResults.title_reviews_v2 = [
      review,
      { ...review, user_id: 'user-3', username: 'bo', display_name: 'Bo' },
    ];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));

    await waitFor(() =>
      expect(view.getByRole('tab', { name: 'Top, most helpful first' })).toBeTruthy(),
    );
    expect(
      view.getByRole('tab', { name: 'Top, most helpful first' }).props.accessibilityState
        .selected,
    ).toBe(true);
  });

  it('invites the first one rather than showing an empty box', async () => {
    mockRpcResults.title_reviews_v2 = [];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));

    await waitFor(() => expect(view.getByText('No reviews yet')).toBeTruthy());
    expect(view.getByText('Be the first to leave a review of this movie.')).toBeTruthy();
  });

  it('asks an unranked reader to rank first, because a review carries a score', async () => {
    mockRpcResults.title_reviews_v2 = [];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));

    await waitFor(() => expect(view.getByText('Rank to leave a review')).toBeTruthy());
  });

  it('offers a ranked reader the one composer there has ever been', async () => {
    // The log sheet, where the spoiler flag and the visibility are chosen beside the
    // text. A second composer here would be a second content model wearing a button.
    mockRpcResults.title_reviews_v2 = [];
    tableRows.rankings = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        position: 1,
        category: 'movies',
        bucket: 'loved',
      },
    ];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));

    await waitFor(() => expect(view.getByText('Write a review')).toBeTruthy());
  });

  it('is absent on a series, which cannot be ranked and so cannot be reviewed', async () => {
    mockOpenId = 'series-1';
    tableRows.media_items = [
      { ...film, id: 'series-1', kind: 'series', title: 'Breaking Bad', runtime_minutes: null },
    ];

    const view = await renderWithProviders(<TitleScreen />);
    await waitFor(() => expect(view.getByText(/^Breaking Bad/)).toBeTruthy());

    expect(view.queryByRole('tab', { name: 'Reviews' })).toBeNull();
  });
});

describe('the header', () => {
  /**
   * **This route draws no navigator header** (founder redesign, 2026-09-07).
   *
   * It had `headerTransparent` with a `headerBackground` that was mounted or unmounted
   * on a boolean, which gives two states and nothing between them — the ground and the
   * title arrived at a threshold, in one frame. The brief asks for a surface that gains
   * opacity as the hero leaves, and for the icons to change with it; `headerTintColor`
   * is a navigation option rather than an animatable value, so there was no way to do
   * the second at all. The bar is drawn by the page now (`TitleTopBar`).
   */
  it('leaves the artwork the whole top of the screen, and keeps the route title', async () => {
    await open();

    expect(mockHeaderOptions.headerShown).toBe(false);
    // `title` is still set, because on iOS a route's title is the back label of whatever
    // is pushed on top of it — a person page opened from the cast strip says `‹ Title`
    // rather than `‹ title/[id]` because of this.
    expect(mockHeaderOptions.title).toBe('Inception');
  });

  it('carries Back at all times, and does not name the page while the page does', async () => {
    const view = await open();

    // Back is present from the first frame and is `router.back()`, so it returns to
    // whatever pushed this route rather than to a route this screen chose.
    expect(view.getByTestId('title-back')).toBeTruthy();

    // The compact title is mounted so it can fade, and is kept out of the accessibility
    // tree until it is readable — otherwise a screen reader would meet the title twice
    // on every title page, which is the duplication the detail-header rule exists to
    // prevent. One `Inception` is findable, not two.
    expect(view.getAllByText(/^Inception/)).toHaveLength(1);
  });
});

/**
 * The founder's report: tapping a series in search led to a page with nothing to do.
 *
 * A series cannot be ranked (AD-1), so everything a reader came for is one level down,
 * on a season. The flow has to be Search → Series → season list → Season → log. What
 * made it read as a dead end was that Seasons was the *last* tab, behind Cast, Videos
 * and Details, and disappeared entirely when the list had not arrived — so a series
 * opened on Cast and offered no route onward at all.
 */
describe('a series', () => {
  const series = {
    ...film,
    id: 'series-1',
    kind: 'series',
    title: 'Breaking Bad',
    release_date: '2008-01-20',
    runtime_minutes: null,
  };

  const season = (n: number, fetchedAt = new Date().toISOString()) => ({
    id: `season-${n}`,
    parent_id: 'series-1',
    kind: 'season',
    season_number: n,
    title: `Season ${n}`,
    release_date: `${2007 + n}-01-20`,
    poster_path: null,
    // When the provider last wrote this row. The season-list freshness rule reads it, and
    // the default is "written just now" so that every test above is about the screen
    // rather than about the clock.
    fetched_at: fetchedAt,
  });

  beforeEach(() => {
    mockOpenId = 'series-1';
    tableRows.media_items = [series, season(1), season(2)];
    tableRows.media_cache = [{ ...credits, media_item_id: 'series-1' }];
  });

  const openSeries = async () => {
    const view = await renderWithProviders(<TitleScreen />);
    await waitFor(() => expect(view.getByText(/^Breaking Bad/)).toBeTruthy());
    return view;
  };

  it('opens on its seasons rather than on its cast', async () => {
    const view = await openSeries();

    // Selected, not merely present. The series page has one job and this is it.
    await waitFor(() => expect(view.getByText(/Season 1/)).toBeTruthy());
    expect(view.getByText(/Season 2/)).toBeTruthy();
  });

  it('leads from a season to that season, which is the rankable unit', async () => {
    const view = await openSeries();

    await waitFor(() => expect(view.getByText(/Season 2/)).toBeTruthy());
    await fireEvent.press(view.getByText(/Season 2/));

    expect(mockPush).toHaveBeenCalledWith('/title/season-2');
  });

  it('says which seasons the reader has already ranked', async () => {
    tableRows.rankings = [
      {
        user_id: 'user-1',
        media_item_id: 'season-1',
        position: 1,
        category: 'tv_seasons',
        bucket: 'loved',
      },
    ];

    const view = await openSeries();

    // "Where am I up to" is the question a series page is opened to answer. Saying
    // "Season" beside a row already titled "Season 1" answered nothing.
    await waitFor(() => expect(view.getByText('Ranked')).toBeTruthy());
    // Twice since 2026-11-14: Season 2's row, and the show's own Your score, which is the
    // show's explicit ranking and is not made up from the ranked Season 1.
    expect(view.getAllByText('Not ranked yet')).toHaveLength(2);
  });

  it('offers Rank Show for the series itself, as its own ranking (2026-11-14)', async () => {
    const view = await openSeries();

    await waitFor(() => expect(view.getByText(/Season 1/)).toBeTruthy());
    const rank = view.getByTestId('title-action-rank');
    expect(within(rank).getByText('Rank Show')).toBeTruthy();
    expect(view.getByTestId('title-action-recommend')).toBeTruthy();
  });

  it('gives each season row the search row’s +, and ranks that season from it', async () => {
    const view = await openSeries();

    await waitFor(() => expect(view.getByLabelText('Log Breaking Bad, Season 2')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Log Breaking Bad, Season 2'));

    // The season's own log sheet, with its bands: a first season ranking begins here.
    await waitFor(() => expect(view.getByText(/liked it/i)).toBeTruthy());
    expect(mockPush).not.toHaveBeenCalledWith('/title/season-2');
  });

  /**
   * **Update Show, end to end** (founder brief §5, 2026-11-14). A season of a ranked show,
   * ranked for the first time from its row's `+`, ends on a reveal offering Update Show;
   * Update Show opens the show's own band chooser, and the correction it starts carries
   * the season placement as its link, so the server posts nothing for the show.
   */
  it('offers Update Show after a fresh season ranking and links the show correction to it', async () => {
    tableRows.rankings = [
      {
        user_id: 'user-1',
        media_item_id: 'series-1',
        position: 1,
        category: 'tv_shows',
        bucket: 'fine',
      },
    ];
    tableRows.user_media = [
      {
        user_id: 'user-1',
        media_item_id: 'series-1',
        bucket: 'fine',
        watched_on: null,
        note: null,
        note_visibility: 'private',
        note_has_spoilers: false,
      },
    ];
    mockRpcResults.log_title = { status: 'ok', created: true, watch_event_id: 'w-1' };
    mockRpcResults.rank_start = {
      done: true,
      position: 1,
      category: 'tv_seasons',
      bucket: 'loved',
      score: 10,
      adjustable: false,
      placement_id: 'placement-s2',
      parent: { media_item_id: 'series-1', ranked: true, bucket: 'fine' },
    };
    mockRpcResults.rank_again = {
      done: false,
      session_id: 'show-session',
      pivot: 'other-show',
    };
    const view = await openSeries();

    await waitFor(() => expect(view.getByLabelText('Log Breaking Bad, Season 2')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Log Breaking Bad, Season 2'));
    await waitFor(() => expect(view.getByLabelText('I liked it')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('I liked it'));

    // FU1113-D: the reveal's primary exit is "Update Show Ranking", with no score.
    const update = await view.findByTestId('reveal-update-show');
    expect(view.getByRole('button', { name: 'Update Show Ranking' })).toBe(update);
    await fireEvent.press(update);

    // The show's band chooser, on the band it already has: the same band re-ranks it
    // from where it stands, and the link rides along.
    await waitFor(() => expect(view.getByLabelText('It was fine')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('It was fine'));
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'rank_again',
        expect.objectContaining({
          p_media_item_id: 'series-1',
          p_new_watch: false,
          p_linked_placement_id: 'placement-s2',
        }),
      ),
    );
  });

  it('carries the open show decision through Add details to the details sheet', async () => {
    // WS-TVC (t168u §3B): Add details does not resolve the show. The post-rank sheet
    // offers Update Show in place of Done, and it opens the same linked correction.
    tableRows.rankings = [
      {
        user_id: 'user-1',
        media_item_id: 'series-1',
        position: 1,
        category: 'tv_shows',
        bucket: 'fine',
      },
    ];
    tableRows.user_media = [
      {
        user_id: 'user-1',
        media_item_id: 'series-1',
        bucket: 'fine',
        watched_on: null,
        note: null,
        note_visibility: 'private',
        note_has_spoilers: false,
      },
    ];
    mockRpcResults.log_title = { status: 'ok', created: true, watch_event_id: 'w-1' };
    mockRpcResults.rank_start = {
      done: true,
      position: 1,
      category: 'tv_seasons',
      bucket: 'loved',
      score: 10,
      adjustable: false,
      placement_id: 'placement-s2',
      parent: { media_item_id: 'series-1', ranked: true, bucket: 'fine' },
    };
    mockRpcResults.rank_again = {
      done: false,
      session_id: 'show-session',
      pivot: 'other-show',
    };
    const view = await openSeries();

    await waitFor(() => expect(view.getByLabelText('Log Breaking Bad, Season 2')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Log Breaking Bad, Season 2'));
    await waitFor(() => expect(view.getByLabelText('I liked it')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('I liked it'));

    await fireEvent.press(await view.findByTestId('reveal-add-details'));
    const update = await view.findByTestId('log-update-show');
    expect(view.getByTestId('log-keep-show')).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Done' })).toBeNull();
    await fireEvent.press(update);

    await waitFor(() => expect(view.getByLabelText('It was fine')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('It was fine'));
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'rank_again',
        expect.objectContaining({
          p_media_item_id: 'series-1',
          p_linked_placement_id: 'placement-s2',
        }),
      ),
    );
    expect(mockRpc.mock.calls.filter(([name]) => name === 'keep_show')).toHaveLength(0);
  });

  it('draws a ranked season row as its score circle, against seasons only', async () => {
    tableRows.rankings = [
      {
        user_id: 'user-1',
        media_item_id: 'season-1',
        position: 1,
        category: 'tv_seasons',
        bucket: 'loved',
      },
      {
        user_id: 'user-1',
        media_item_id: 'series-1',
        position: 1,
        category: 'tv_shows',
        bucket: 'fine',
      },
    ];
    const view = await openSeries();

    // A band of one scores its high: 10.0 for the loved season, never the show's 6.9.
    await waitFor(() => expect(view.getAllByTestId('title-row-actions-ranked').length).toBe(1));
    expect(view.getByLabelText('Log Breaking Bad, Season 2')).toBeTruthy();
  });

  it('keeps a route onward even before the seasons have arrived', async () => {
    // The list is empty because nothing has enriched this series yet — not because a
    // series has no seasons. Dropping the tab here is what left the page with no exit.
    tableRows.media_items = [series];

    const view = await openSeries();

    // The empty state, not the tab. The tab is drawn from the media row, which has
    // already arrived by the time this renders; the sentence under it waits on the
    // seasons query. Waiting on the tab therefore guards nothing — the same unguarded
    // shape the Following-score block was corrected for in #74.
    await waitFor(() => expect(view.getByText('Seasons are still loading')).toBeTruthy());
    expect(view.getByRole('tab', { name: 'Seasons' })).toBeTruthy();
  });

  /**
   * The founder's report of 2026-08-30: a series short of a season.
   *
   * The screen used to ask the provider about a series only when the row looked *thin* —
   * no artwork, no overview — which a series acquires once and keeps. So a season list
   * was written by whichever enrichment first reached the series and then never revisited,
   * and `media_refresh_due` is drained by no schedule, so nothing else was going to ask.
   *
   * These assert the **decision** rather than the request: `useTitleEnrichment` is mocked,
   * and what is checked is the second argument the screen hands it.
   */
  const askedToEnrich = () => mockEnrichmentArgs.some((args) => args[1] === true);

  it('asks the provider again when the season list has gone stale', async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    tableRows.media_items = [series, season(1, old), season(2, old)];

    const view = await openSeries();
    await waitFor(() => expect(view.getByText(/Season 2/)).toBeTruthy());

    expect(askedToEnrich()).toBe(true);
  });

  it('asks once, for this series, and not once per reason', async () => {
    // One reason, one call. Two hooks watching the same series would each spend a
    // provider request on it, which is why the season rule rides on `alsoWhen` rather
    // than on a second `useSeasonEnrichment`.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    tableRows.media_items = [series, season(1, old)];

    const view = await openSeries();
    await waitFor(() => expect(view.getByText(/Season 1/)).toBeTruthy());

    const asked = new Set(
      mockEnrichmentArgs
        .filter((args) => args[1] === true)
        .map((args) => (args[0] as { id?: string } | null)?.id),
    );
    expect([...asked]).toEqual(['series-1']);
  });
});

/**
 * The Following score (20260816001100) — what the people this reader follows made of
 * this title, above what everybody did.
 *
 * The server owns every rule that matters: approved followees only, `can_view_profile`
 * from the caller's own side, the exact media item, live rankings. `following-score.test.mjs`
 * is where those are asserted. What is asserted here is the screen's part — that it
 * shows the number, names the population honestly, and keeps the row with its grey
 * circle when the reader's following list has nothing to say.
 */
describe('the following score', () => {
  it('shows it above the community score, with the sample named', async () => {
    mockRpcResults.following_score = [{ score: '8.6', rating_count: 3, following_count: 9 }];
    mockRpcResults.community_score = [{ score: '7.4', rating_count: 12, min_ratings: 3 }];

    const view = await open();

    // Wait for the *score*, not for the label. Both units of `ScoresSection` are drawn
    // on mount — a row that appears when its data does is a page that moves under the
    // reader, which is the founder's own rule — so "Following" is on screen before
    // `following_score` has resolved and waiting on it guards nothing. The third test
    // in this block records the same lesson from the same CI flake; these two were
    // still waiting on the label.
    await waitFor(() => expect(view.getByText('8.6')).toBeTruthy());
    expect(view.getByText('Following')).toBeTruthy();
    /**
     * `3 ratings`, not `3 people you follow` (founder, physical Android, 2026-09-08).
     *
     * Counting people was more specific and measurably worse: in a third of the content
     * width it set on two lines and pushed the whole row taller, and every word past the
     * number restated the `Following` label directly above it. The label is what says
     * *whose* ratings these are; the line beneath it says how many.
     */
    expect(view.getByText('3 ratings')).toBeTruthy();
    expect(view.queryByText(/people you follow/)).toBeNull();
    expect(view.getByText('bingd')).toBeTruthy();
  });

  it('shows a single followee, which community would withhold', async () => {
    mockRpcResults.following_score = [{ score: '9.1', rating_count: 1, following_count: 4 }];
    const view = await open();

    // One account you chose to follow is not a weak estimate of a crowd; it is their
    // opinion, and it is the only case a new account can produce at all. Singular.
    await waitFor(() => expect(view.getByText('1 rating')).toBeTruthy());
    expect(view.getByText('9.1')).toBeTruthy();
  });

  it('keeps its row, empty, when nobody the reader follows has ranked it', async () => {
    mockRpcResults.following_score = [{ score: null, rating_count: 0, following_count: 0 }];
    mockRpcResults.community_score = [{ score: '7.4', rating_count: 12, min_ratings: 3 }];

    const view = await open();

    // Wait for the community *score*, not merely its label. Both rows are one
    // `ScoreRow`, which renders "Not enough ratings" for any null score — so between
    // the section mounting and community_score arriving, both rows carry those words
    // and `getByText` below would find two. The label renders on mount and therefore
    // does not close that window; the score does. (CI caught this as a flake; the
    // race was the test's, not the page's.)
    await waitFor(() => expect(view.getByText('7.4')).toBeTruthy());
    expect(view.getByText('bingd')).toBeTruthy();
    // Founder correction, 2026-08-18: the row is always drawn, with the grey circle
    // and the circle. A row that appears when the data does is a page that moves under
    // somebody reading it.
    //
    // The *words* are still Following's own rather than bingd.'s: "Not enough ratings" is
    // a fact about the app's sample, and this is a fact about the people the reader chose.
    // Shortened on 2026-09-08 — the label above already says whose ratings these are — but
    // the two rows still never share a string.
    expect(view.getByText('Following')).toBeTruthy();
    expect(view.getByText('No ratings yet')).toBeTruthy();
    // bingd. has a 7.4 to report here, so its own words are nowhere on the page: the two
    // rows never share a string in either direction.
    expect(view.queryByText('Not enough ratings')).toBeNull();
  });

  it('never calls it a friend score, because following is not mutual', async () => {
    mockRpcResults.following_score = [{ score: '8.6', rating_count: 3, following_count: 9 }];
    const view = await open();

    // The score rather than the label, for the reason above: asserting the absence of
    // a word while the section is still a skeleton would pass without ever drawing the
    // copy under test.
    await waitFor(() => expect(view.getByText('8.6')).toBeTruthy());
    expect(view.queryByText(/friend/i)).toBeNull();
  });

  it('shows a series its own Following and bingd scores (2026-11-14)', async () => {
    // A whole show is ranked in its own pool, so its aggregates are other readers' show
    // rankings — the RPCs are asked about the show itself, never about its seasons.
    mockOpenId = 'series-1';
    tableRows.media_items = [
      { ...film, id: 'series-1', kind: 'series', title: 'Breaking Bad', runtime_minutes: null },
    ];

    const view = await renderWithProviders(<TitleScreen />);
    await waitFor(() => expect(view.getByText(/^Breaking Bad/)).toBeTruthy());

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('following_score', { p_media_item_id: 'series-1' }),
    );
    expect(mockRpc).toHaveBeenCalledWith('community_score', { p_media_item_id: 'series-1' });
  });
});

/**
 * Independent review, 10: omitting the Following row whenever it had no ratings made
 * the feature undiscoverable for precisely the people it is meant to recruit — a new
 * account sees every title page look exactly as it did before following anybody.
 *
 * Two silences, and they are not the same silence.
 */
/**
 * Arriving from something a friend sent, which is the only route that says so.
 *
 * The fact belongs to the navigation rather than to the title. The same film opened
 * from search is not "recommended by Ada", so nothing about the page may assert it
 * unless the link that reached it carried the claim.
 */
/**
 * How a season names itself on its own page.
 *
 * The compact form, "Breaking Bad, S1", belongs to surfaces with one line to
 * say a whole name in: a feed row, a search result, a share card. Here the show is
 * already on the line above, so the heading is the season and its year, joined the way
 * anybody writes one down.
 */
describe('a season, on its own page', () => {
  it('reads as the show, then the season and a comma and a year', async () => {
    mockOpenId = 'season-1';
    tableRows.media_items = [
      {
        ...film,
        id: 'season-1',
        kind: 'season',
        title: 'Season 1',
        release_date: '2023-04-01',
        runtime_minutes: null,
        parent: {
          id: 'series-1',
          title: 'Breaking Bad',
          poster_path: null,
          backdrop_path: null,
        },
      },
    ];

    const view = await renderWithProviders(<TitleScreen />);

    // **The show is the heading now** (founder redesign, 2026-09-07), and the season and
    // its year are the subtitle beneath it. It ran the other way — a small Maroon series
    // line above `Season 1, 2023` in `title1` — which put the least identifying string
    // on the page in the largest type it has. Somebody arriving here is arriving at
    // Breaking Bad; which season they are on is the qualifier.
    await waitFor(() =>
      expect(view.getByTestId('title-name')).toHaveTextContent(/^Breaking Bad$/),
    );
    // Still the way to the series page: the heading is the link rather than a line above
    // the link.
    expect(view.getByLabelText('Breaking Bad, the series this belongs to')).toBeTruthy();
    /**
     * **One separator for the whole identity block** (founder grammar lock, 2026-09-07).
     *
     * It was a comma here and a middle dot on the metadata line directly beneath, which
     * made two adjacent lines of the same metadata look like two different kinds of
     * claim. The middle dot is the block's only joiner now, so `Season 1 · 2023` and
     * `TV-MA · 9 episodes` read as one grammar.
     */
    expect(view.getByTestId('title-subtitle')).toHaveTextContent(/^Season 1 · 2023$/);
    // Not the flattened form, which would say the show twice on one screen.
    expect(view.queryByText(/Breaking Bad, S1/)).toBeNull();
  });
});

/**
 * A title somebody recommended to the reader (20260929000100, founder F1).
 *
 * The context is no longer carried by the link: the page asks
 * `title_recommendations_for_me`, so it is here however the reader arrived — a push, the
 * inbox, search — and it is one card below the title rather than a pill on the artwork.
 */
describe('a title opened from a recommendation', () => {
  const sent = (over: Record<string, unknown> = {}) => ({
    id: 'rec-1',
    sender_id: 'user-2',
    sender_username: 'ada',
    sender_display_name: 'Ada',
    sender_avatar_path: null,
    message: null,
    recommended_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    opened_at: null,
    ...over,
  });

  it('says who sent it, and quotes the note they wrote', async () => {
    mockRpcResults.title_recommendations_for_me = [
      sent({ message: 'The second half is insane.' }),
    ];
    const view = await open();

    await waitFor(() => expect(view.getByText(/^Ada · /)).toBeTruthy());
    expect(view.getByTestId('recommendation-note')).toHaveTextContent(
      '“The second half is insane.”',
    );
    expect(view.getByText(/2d ago/)).toBeTruthy();
  });

  it('says it in one line when there was no note', async () => {
    mockRpcResults.title_recommendations_for_me = [sent()];
    const view = await open();

    await waitFor(() => expect(view.getByText(/^Recommended by Ada · /)).toBeTruthy());
    expect(view.queryByTestId('recommendation-note')).toBeNull();
  });

  it('says nothing when nobody sent it', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-name')).toBeTruthy());
    expect(view.queryByTestId('recommendation-card')).toBeNull();
  });

  it('says it on a title with no artwork too, in the same place', async () => {
    tableRows.media_items = [{ ...film, backdrop_path: null, poster_path: null }];
    mockRpcResults.title_recommendations_for_me = [sent()];

    const view = await open();
    await waitFor(() => expect(view.getByText(/^Recommended by Ada · /)).toBeTruthy());
  });

  it('marks what it shows as opened, once, whichever door the reader came through', async () => {
    mockRpcResults.title_recommendations_for_me = [sent({ message: 'Watch it.' })];
    const view = await open();

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('mark_recommendation_opened', {
        p_recommendation_id: 'rec-1',
      }),
    );
    const marks = mockRpc.mock.calls.filter(([name]) => name === 'mark_recommendation_opened');
    expect(marks).toHaveLength(1);
    expect(view.getByTestId('recommendation-card')).toBeTruthy();
  });

  it('does not mark one that was already opened', async () => {
    mockRpcResults.title_recommendations_for_me = [
      sent({ opened_at: new Date().toISOString() }),
    ];
    const view = await open();

    await waitFor(() => expect(view.getByText(/^Recommended by Ada · /)).toBeTruthy());
    expect(mockRpc).not.toHaveBeenCalledWith('mark_recommendation_opened', expect.anything());
  });

  it('leads with the newest note and offers the rest in a sheet', async () => {
    mockRpcResults.title_recommendations_for_me = [
      sent({ id: 'rec-2', sender_display_name: 'Bo', sender_username: 'bo' }),
      sent({ id: 'rec-1', message: 'This is the one I meant.' }),
    ];
    const view = await open();

    await waitFor(() => expect(view.getByText(/^Ada and 1 other · /)).toBeTruthy());
    await fireEvent.press(view.getByTestId('recommendation-card'));

    await waitFor(() => expect(view.getByText('Recommended by')).toBeTruthy());
    expect(view.getByTestId('recommender-rec-2')).toBeTruthy();
  });

  it('says nothing once the reader has ranked it', async () => {
    mockRpcResults.title_recommendations_for_me = [sent({ message: 'Watch it.' })];
    tableRows.rankings = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        position: 1,
        category: 'movies',
        bucket: 'loved',
      },
    ];

    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-name')).toBeTruthy());
    expect(view.queryByTestId('recommendation-card')).toBeNull();
  });
});

/**
 * The empty state, which is one shape for both readers and its own sentence per row.
 *
 * Two silences used to be told apart here: a reader who followed nobody got no row at
 * all, and a reader who followed eleven people none of whom had seen the film was told
 * exactly that. The founder collapsed both into one circle on 2026-08-18. The reader can
 * act on neither case, and a row that materialises when the data arrives moves the page
 * under somebody reading it. That much is unchanged.
 *
 * What changed on 2026-09-07 is the *words*. Following borrowed bingd.'s four, "Not
 * enough ratings", and that hid a real distinction: the app being short of a sample and
 * nobody the reader chose having seen this are different facts, and only the second one
 * is something they can do anything about.
 */
describe('the following score with nothing to say', () => {
  it('says so for a reader who follows eleven people', async () => {
    mockRpcResults.following_score = [{ score: null, rating_count: 0, following_count: 11 }];
    mockRpcResults.community_score = [{ score: '7.4', rating_count: 12, min_ratings: 3 }];

    const view = await open();

    /**
     * Anchored on the **community** score, not on the "Following" heading.
     *
     * The heading is drawn before either number arrives, so waiting on it proves only
     * that the section exists. Anchoring on the community score is what makes the
     * assertions below statements about the settled page rather than about a frame of it.
     *
     * The original form of this wait passed locally and failed on CI (run 32876993932),
     * which is the signature of a wait that gates on the wrong thing rather than of a
     * real defect. Same class as the one `PrivacyScreen.test.tsx` records.
     */
    await waitFor(() => expect(view.getByText('7.4')).toBeTruthy());
    expect(view.getByText('No ratings yet')).toBeTruthy();
    expect(view.getByText('Following')).toBeTruthy();
    // And it is Following's own sentence: bingd. has a 7.4 to report, so its empty words
    // are nowhere on the page. The two rows no longer share a string.
    expect(view.queryByText('Not enough ratings')).toBeNull();
    // An older copy named the reader's following list back to them. Also gone.
    expect(view.queryByText('Nobody you follow has ranked this')).toBeNull();
  });

  it('says exactly the same for a reader who follows nobody', async () => {
    mockRpcResults.following_score = [{ score: null, rating_count: 0, following_count: 0 }];
    mockRpcResults.community_score = [{ score: '7.4', rating_count: 12, min_ratings: 3 }];

    const view = await open();

    // The row used to be absent in this case. Two silences told apart was a real
    // distinction and the founder collapsed it: the reader can act on neither, and a
    // row that materialises when the data arrives moves the page under them.
    //
    // Anchored on the community score for the reason the test above records: the
    // "Following" heading is drawn before either number arrives.
    await waitFor(() => expect(view.getByText('7.4')).toBeTruthy());
    expect(view.getByText('No ratings yet')).toBeTruthy();
    expect(view.getByText('Following')).toBeTruthy();
  });

  it('draws a stated absence rather than a faded number', async () => {
    mockRpcResults.following_score = [{ score: null, rating_count: 0, following_count: 0 }];
    mockRpcResults.community_score = [{ score: null, rating_count: 2, min_ratings: 10 }];

    const view = await open();

    await waitFor(() => expect(view.getByText('bingd')).toBeTruthy());
    // Each row in its own words, and each circle carrying an em dash rather than being
    // blank: "no blank cream disc that looks like broken content" is the founder's exact
    // constraint, and an empty circle is indistinguishable from one that failed to load.
    expect(view.getByText('No ratings yet')).toBeTruthy();
    expect(view.getByText('Not enough ratings')).toBeTruthy();
    // Never a zero, and never a real number greyed out to say "do not trust this".
    expect(view.queryByText('0.0')).toBeNull();
  });
});

/**
 * The action row: Watchlist and Recommend.
 *
 * Share was the third chip and is now the last row of the Recommend sheet, because
 * three labelled chips do not fit a 360pt screen and of the three it was the one with
 * somewhere else to be. Rank is deliberately not here either: it belongs opposite the
 * poster, with the score it changes.
 */
describe('the action row', () => {
  it('offers Watchlist and Recommend, and no separate Share', async () => {
    const view = await open();

    expect(view.getByLabelText('Add Inception to your watchlist')).toBeTruthy();
    expect(view.getByLabelText('Recommend Inception to a friend')).toBeTruthy();
    // Two chips fit a narrow Android screen and three did not. Sharing is not gone:
    // it is the last row of the Recommend sheet, which the next test opens.
    expect(view.queryByLabelText('Share Inception')).toBeNull();
  });

  it('opens a sheet headed with the title, and that is where sharing lives', async () => {
    const view = await open();
    await fireEvent.press(view.getByLabelText('Recommend Inception to a friend'));

    await waitFor(() => expect(view.getByText('Recommend Inception')).toBeTruthy());
    expect(view.getByText('Share off bingd')).toBeTruthy();
  });

  /**
   * **The bookmark, when the answer is lost.**
   *
   * `set_watchlist` commits, the reply never arrives, and `writes.ts` reports
   * `{ failed, changed }` (`lib/write-outcome.ts`). This screen used to set the error and
   * return before invalidating, so the title stayed on the watchlist server-side and off
   * it here. Independent review 21e, Major 3 — one of four screens with the same hole.
   */
  it('refetches when a watchlist save may have landed anyway', async () => {
    mockRpcErrors.set_watchlist = { code: '', message: 'TypeError: Network request failed' };
    const view = await open();
    const before = mockReads.watchlist ?? 0;

    await fireEvent.press(view.getByLabelText('Add Inception to your watchlist'));

    await waitFor(() => expect(mockReads.watchlist ?? 0).toBeGreaterThan(before));
  });

  it('refetches for 08007, which carries a code and still proves nothing', async () => {
    mockRpcErrors.set_watchlist = { code: '08007', message: 'transaction resolution unknown' };
    const view = await open();
    const before = mockReads.watchlist ?? 0;

    await fireEvent.press(view.getByLabelText('Add Inception to your watchlist'));

    await waitFor(() => expect(mockReads.watchlist ?? 0).toBeGreaterThan(before));
  });

  it('leaves the cache alone when the server refused the bookmark outright', async () => {
    mockRpcErrors.set_watchlist = { code: '42501', message: 'suspended' };
    const view = await open();
    const before = mockReads.watchlist ?? 0;

    await fireEvent.press(view.getByLabelText('Add Inception to your watchlist'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('set_watchlist', expect.anything()),
    );
    expect(mockReads.watchlist ?? 0).toBe(before);
  });

  it('offers Recommend on a series, which is rankable in its own pool (2026-11-14)', async () => {
    // `recommend_title` resolves a series through `rankable_category`, which maps it to
    // tv_shows, so the show page has the same capabilities as a film's.
    const film = (tableRows.media_items ?? [])[0] as Record<string, unknown>;
    mockOpenId = 'series-1';
    tableRows.media_items = [
      { ...film, id: 'series-1', kind: 'series', title: 'Breaking Bad', runtime_minutes: null },
    ];
    const view = await renderWithProviders(<TitleScreen />);
    await waitFor(() => expect(view.getByText(/^Breaking Bad/)).toBeTruthy());

    expect(view.getByLabelText(/^Recommend /)).toBeTruthy();
  });
});

/**
 * Episodes, on a season page.
 *
 * The founder's problem: somebody remembers watching a show and cannot remember
 * which seasons. Bingd ranks a season, so that gap sits directly in front of the one
 * action the page exists for. Episode titles, dates and stills are the recognition
 * cues that close it.
 *
 * What these assert is mostly the boundary of the feature rather than its middle.
 * Episodes is informational metadata (PRD §10) — a card opens a sheet of facts, nothing
 * is logged, nothing is scored — and the tab exists on a season and on nothing else.
 */
describe('a season, and its episodes', () => {
  const seasonRow = {
    ...film,
    id: 'season-1',
    kind: 'season',
    title: 'Season 1',
    release_date: '2011-04-17',
    runtime_minutes: null,
    parent: {
      id: 'series-1',
      title: 'Game of Thrones',
      poster_path: null,
      backdrop_path: null,
    },
  };

  const episode = (n: number, overrides: Record<string, unknown> = {}) => ({
    episode_number: n,
    title: `Episode title ${n}`,
    air_date: '2011-04-17',
    runtime_minutes: 62,
    still_path: `/still${n}.jpg`,
    overview: `What happens in episode ${n}.`,
    ...overrides,
  });

  beforeEach(() => {
    mockOpenId = 'season-1';
    tableRows.media_items = [seasonRow];
    mockFetchSeasonEpisodes.mockReset();
    mockFetchSeasonEpisodes.mockResolvedValue([episode(1), episode(2)]);
  });

  const openSeason = async () => {
    const view = await renderWithProviders(<TitleScreen />);
    await waitFor(() => expect(view.getByText(/^Season 1/)).toBeTruthy());
    return view;
  };

  it('leads the tab row, which makes it what the page opens on', async () => {
    // The founder's decision. Cast barely changes between seasons of a show, so it is
    // the least distinguishing thing on the page it used to lead; episodes are the
    // reason somebody is on a season page at all.
    const view = await openSeason();

    expect(view.getByRole('tab', { name: 'Episodes' })).toBeTruthy();
    expect(view.getByRole('tab', { name: 'Episodes' }).props.accessibilityState.selected).toBe(
      true,
    );
  });

  /** The episode detail sheet, opened from the rail by its card. */
  const openEpisode = async (view: Awaited<ReturnType<typeof openSeason>>, n: number) => {
    await waitFor(() => expect(view.getByTestId(`episode-card-${n}`)).toBeTruthy());
    await fireEvent.press(view.getByTestId(`episode-card-${n}`));
    return within(view.getByTestId('episode-sheet'));
  };

  it('shows episodes as one compact rail: number and title, and no synopsis', async () => {
    // Founder hotfix, 2026-11-07: the synopses made a season page excessively long.
    const view = await openSeason();

    await waitFor(() => expect(view.getByTestId('episode-rail')).toBeTruthy());
    expect(view.getByTestId('episode-rail').props.horizontal).toBe(true);
    expect(view.getByText('Episode 1')).toBeTruthy();
    expect(view.getByText('Episode title 1')).toBeTruthy();
    expect(view.getByText('Episode title 2')).toBeTruthy();
    // One line each for the number and the title, whatever their length.
    expect(view.getByText('Episode title 1').props.numberOfLines).toBe(1);
    // The synopsis, date and runtime are the sheet's, not the page's.
    expect(view.queryByText('What happens in episode 1.')).toBeNull();
    expect(view.queryByText(`${airDate('2011-04-17')} · 62 min`)).toBeNull();
  });

  it('keeps the provider’s order, as a list of buttons that say what they open', async () => {
    mockFetchSeasonEpisodes.mockResolvedValue([episode(1), episode(2), episode(3)]);
    const view = await openSeason();

    await waitFor(() => expect(view.getByTestId('episode-card-3')).toBeTruthy());
    const labels = view
      .getAllByRole('button', { name: /^Episode \d/ })
      .map((card) => card.props.accessibilityLabel);
    expect(labels).toEqual([
      'Episode 1, Episode title 1',
      'Episode 2, Episode title 2',
      'Episode 3, Episode title 3',
    ]);
    expect(view.getByTestId('episode-card-1').props.accessibilityHint).toBe(
      "Shows the episode's details",
    );
  });

  it('opens an episode’s full details in a sheet', async () => {
    const view = await openSeason();
    const sheet = await openEpisode(view, 2);

    expect(sheet.getByText('Season 1 · Episode 2')).toBeTruthy();
    expect(sheet.getByText('Episode title 2')).toBeTruthy();
    expect(sheet.getByText(`${airDate('2011-04-17')} · 62 min`)).toBeTruthy();
    expect(sheet.getByText('What happens in episode 2.')).toBeTruthy();
    // The larger still, from TMDB's w780 bucket.
    expect(JSON.stringify(sheet.getByTestId('episode-sheet-still').props.source)).toContain(
      '/w780/still2.jpg',
    );

    await fireEvent.press(view.getByText('Close'));
    expect(view.queryByTestId('episode-sheet')).toBeNull();
    // Reading an episode navigates nowhere and writes nothing.
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('shows a long title whole in the sheet, and on one line on the card', async () => {
    const long =
      'The One Where Everybody Finally Remembers What Happened at the Lake House That Summer';
    mockFetchSeasonEpisodes.mockResolvedValue([episode(1, { title: long })]);
    const view = await openSeason();

    await waitFor(() => expect(view.getByText(long)).toBeTruthy());
    expect(view.getByText(long).props.numberOfLines).toBe(1);

    const sheet = await openEpisode(view, 1);
    expect(sheet.getByText(long).props.numberOfLines).toBeUndefined();
  });

  it('names an episode by its number when the provider has no title for it', async () => {
    // "Episode 4", never a blank line and never a fabricated name.
    mockFetchSeasonEpisodes.mockResolvedValue([episode(4, { title: null })]);
    const view = await openSeason();

    await waitFor(() => expect(view.getByText('Episode 4')).toBeTruthy());
    expect(view.getByTestId('episode-card-4').props.accessibilityLabel).toBe('Episode 4');
  });

  it('keeps the frame for a missing still, and draws nothing invented in the sheet', async () => {
    // An unaired episode legitimately has no runtime, no still and often no synopsis.
    mockFetchSeasonEpisodes.mockResolvedValue([
      episode(3, { runtime_minutes: null, still_path: null, overview: null }),
    ]);
    const view = await openSeason();

    await waitFor(() => expect(view.getByTestId('episode-still-missing')).toBeTruthy());
    expect(view.getByTestId('episode-frame')).toBeTruthy();
    expect(view.queryByTestId('episode-still')).toBeNull();

    const sheet = await openEpisode(view, 3);
    // The date survives on its own, with no stray separator beside it.
    expect(sheet.getByTestId('episode-sheet-meta')).toHaveTextContent(
      new RegExp(`^${airDate('2011-04-17')}$`),
    );
    expect(sheet.queryByTestId('episode-sheet-still')).toBeNull();
    expect(view.queryByText(/Unknown|TBA|null|undefined/)).toBeNull();
  });

  it('shows a future episode with the date the provider published', async () => {
    mockFetchSeasonEpisodes.mockResolvedValue([
      episode(8, { air_date: '2099-01-01', runtime_minutes: null, still_path: null }),
    ]);
    const view = await openSeason();
    const sheet = await openEpisode(view, 8);

    expect(sheet.getByText(airDate('2099-01-01'))).toBeTruthy();
  });

  it('leaves the whole metadata line out when there is neither a date nor a runtime', async () => {
    mockFetchSeasonEpisodes.mockResolvedValue([
      episode(1, { air_date: null, runtime_minutes: null }),
    ]);
    const view = await openSeason();
    const sheet = await openEpisode(view, 1);

    expect(sheet.queryByTestId('episode-sheet-meta')).toBeNull();
  });

  it('says the provider has published no list, rather than showing an empty tab', async () => {
    mockFetchSeasonEpisodes.mockResolvedValue([]);
    const view = await openSeason();

    await waitFor(() => expect(view.getByText('No episodes listed')).toBeTruthy());
    expect(
      view.getByText('TMDB has not published an episode list for this season yet.'),
    ).toBeTruthy();
  });

  it('offers a retry when the request failed, which is a different thing to say', async () => {
    // An empty list is a fact about the show. A failure is something the reader can
    // do something about, and the two must not read the same.
    mockFetchSeasonEpisodes.mockRejectedValue(new Error('BG502'));
    const view = await openSeason();

    await waitFor(() => expect(view.getByText('Episodes did not load')).toBeTruthy());
    expect(view.getByText('Pull down to try again.')).toBeTruthy();
    // Never the provider's own words, or a status code.
    expect(view.queryByText(/BG502|TMDB is unavailable|Error/)).toBeNull();
  });

  it('hands a long season to the rail whole, with no "Show all" to find', async () => {
    // A daily soap or a long anime run that the provider models as one season. The rail
    // virtualises horizontally, so every episode is reachable by scrolling it.
    mockFetchSeasonEpisodes.mockResolvedValue(
      Array.from({ length: 200 }, (_, index) => episode(index + 1)),
    );
    const view = await openSeason();

    await waitFor(() => expect(view.getByTestId('episode-card-1')).toBeTruthy());
    expect(view.getByTestId('episode-rail').props.data).toHaveLength(200);
    expect(view.queryByTestId('episode-card-200')).toBeNull();
    expect(view.queryByLabelText(/Show all/)).toBeNull();
  });

  it('keeps the episodes when the reader visits another tab and comes back', async () => {
    const view = await openSeason();
    await waitFor(() => expect(view.getByText('Episode title 1')).toBeTruthy());

    await fireEvent.press(view.getByRole('tab', { name: 'Details' }));
    expect(view.queryByText('Episode title 1')).toBeNull();

    await fireEvent.press(view.getByRole('tab', { name: 'Episodes' }));
    expect(view.getByText('Episode title 1')).toBeTruthy();
    // One request for the whole visit. The list is cached for an hour.
    expect(mockFetchSeasonEpisodes).toHaveBeenCalledTimes(1);
  });

  it('offers nothing on an episode to rank or log', async () => {
    // The product boundary, as a test. An episode is not rankable, not loggable and
    // not a media_items row: its card opens a sheet of facts and nothing else.
    const view = await openSeason();
    await waitFor(() => expect(view.getByText('Episode title 1')).toBeTruthy());

    expect(view.queryByLabelText(/Rank Episode title 1/)).toBeNull();
    expect(view.queryByLabelText(/Log Episode title 1/)).toBeNull();
    const sheet = await openEpisode(view, 1);
    expect(sheet.queryByText(/^Rank|^Log/)).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('keeps Rank in reach while the episodes are on screen', async () => {
    // The journey the feature is for: recognise the season, then rank it. Rank lives
    // in the hero cluster above the tab row and is not inside any tab, so choosing
    // Episodes does not take it away.
    const view = await openSeason();
    await waitFor(() => expect(view.getByText('Episode title 1')).toBeTruthy());

    expect(view.getByTestId('title-action-rank')).toBeTruthy();
  });
});

describe('the Episodes tab belongs to seasons alone', () => {
  beforeEach(() => {
    mockFetchSeasonEpisodes.mockReset();
    mockFetchSeasonEpisodes.mockResolvedValue([]);
  });

  it('is absent from a film, which has no episodes to describe', async () => {
    const view = await open();

    expect(view.queryByRole('tab', { name: 'Episodes' })).toBeNull();
    expect(mockFetchSeasonEpisodes).not.toHaveBeenCalled();
  });

  it('is absent from a series grouping, where Seasons is the way down', async () => {
    // A series page must not become a cross-season episode browser. The rankable unit
    // is one level below it, and Seasons is what leads there.
    mockOpenId = 'series-1';
    tableRows.media_items = [
      { ...film, id: 'series-1', kind: 'series', title: 'Breaking Bad', runtime_minutes: null },
      {
        id: 'season-1',
        parent_id: 'series-1',
        kind: 'season',
        season_number: 1,
        title: 'Season 1',
        release_date: '2008-01-20',
        poster_path: null,
        fetched_at: new Date().toISOString(),
      },
    ];

    const view = await renderWithProviders(<TitleScreen />);
    await waitFor(() => expect(view.getByText(/^Breaking Bad/)).toBeTruthy());

    expect(view.queryByRole('tab', { name: 'Episodes' })).toBeNull();
    expect(view.getByRole('tab', { name: 'Seasons' })).toBeTruthy();
    expect(mockFetchSeasonEpisodes).not.toHaveBeenCalled();
  });
});

/**
 * Where to watch, on the page rather than on its own.
 *
 * `WhereToWatch.test.tsx` covers the block's own behaviour — the grouping, the sheet,
 * the one link, the failure story. What is left is the part only this screen can be
 * asked about: **where it sits**, and that adding it moved nothing.
 *
 * The founder's placement decision is a sentence about order — under the scores, over
 * the tabs — so it is asserted as order, in the tree, rather than as "the text is
 * somewhere on the page".
 */
describe('where to watch', () => {
  const NETFLIX = {
    provider_id: 8,
    name: 'Netflix',
    logo_path: '/netflix.jpg',
    offers: ['stream'],
  };

  /**
   * Where something sits in the rendered tree.
   *
   * `queryAll` walks in document order, so comparing two indices is comparing two
   * positions on the page. There is no role for "above", and reading it off the tree
   * by shape would agree with any arrangement that happened to contain both.
   */
  const indexOf = (view: Awaited<ReturnType<typeof open>>, match: (node: never) => boolean) => {
    const nodes = view.root!.queryAll(() => true);
    return nodes.findIndex(match as never);
  };

  beforeEach(() => {
    mockFetchWatchProviders.mockResolvedValue({
      region: 'US',
      link: 'https://www.themoviedb.org/movie/27205/watch?locale=US',
      providers: [NETFLIX],
    });
    tableRows.media_cache = [credits];
  });

  it('sits under the score block and over the tab row', async () => {
    mockRpcResults.community_score = [{ score: '7.4', rating_count: 12, min_ratings: 1 }];
    const view = await open();
    await waitFor(() => expect(view.getByTestId('where-to-watch')).toBeTruthy());

    const scores = indexOf(
      view,
      (node: never) => (node as any).props?.testID === 'scores-layout',
    );
    const watch = indexOf(
      view,
      (node: never) => (node as any).props?.testID === 'where-to-watch',
    );
    const tabs = indexOf(
      view,
      (node: never) => (node as any).props?.accessibilityRole === 'tab',
    );

    expect(scores).toBeGreaterThan(-1);
    expect(tabs).toBeGreaterThan(-1);
    // Scores, then the block, then the tab row. **No rule between the two** since
    // 2026-09-07: both carry a Maroon section heading and a section's worth of air, and
    // running a hairline as well is what left the page reading as a stack of bordered
    // bands. The page's one remaining rule is above the tab row.
    expect(watch).toBeGreaterThan(scores);
    expect(watch).toBeLessThan(tabs);
  });

  it('is a row on the page and never a tab', async () => {
    // The founder's decision, and the reason is what a tab would cost on either side:
    // a film opens on Cast and a season opens on Episodes, both of which are those
    // pages' point, and a season's row is already five entries long.
    const view = await open();
    await waitFor(() => expect(view.getByTestId('where-to-watch')).toBeTruthy());

    expect(view.queryByRole('tab', { name: 'Watch' })).toBeNull();
    expect(view.queryByRole('tab', { name: 'Where to watch' })).toBeNull();
  });

  it('leaves a film opening on its default tab, which is Similar', async () => {
    // Where to watch sits above the tab row and must not steal the default. Since
    // 2026-09-13 a film's default is Similar (founder); it was Cast.
    const view = await open();
    await waitFor(() => expect(view.getByTestId('where-to-watch')).toBeTruthy());

    expect(view.getByRole('tab', { name: 'Similar' }).props.accessibilityState.selected).toBe(
      true,
    );
  });

  it('asks once, and asks nothing more when the reader changes tabs', async () => {
    // The block is not gated behind a tab, so a re-render on every tab press must not
    // become a provider request on every tab press. This is the storm the founder
    // asked to be held off.
    const view = await open();
    await waitFor(() => expect(mockFetchWatchProviders).toHaveBeenCalledTimes(1));
    expect(mockFetchWatchProviders).toHaveBeenCalledWith('film-1', 'US');

    await fireEvent.press(view.getByRole('tab', { name: 'Details' }));
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));
    await fireEvent.press(view.getByRole('tab', { name: 'Cast' }));

    expect(mockFetchWatchProviders).toHaveBeenCalledTimes(1);
  });

  it('leaves the page whole when the provider cannot answer', async () => {
    // Availability is useful and not critical. A failure here must cost the block and
    // nothing else: no error banner, no spinner, no dead page.
    mockFetchWatchProviders.mockRejectedValue(new Error('BG502'));
    mockRpcResults.community_score = [{ score: '7.4', rating_count: 12, min_ratings: 1 }];
    const view = await open();

    await waitFor(() => expect(mockFetchWatchProviders).toHaveBeenCalled());
    expect(view.queryByTestId('where-to-watch')).toBeNull();
    expect(view.getByText(/^Inception/)).toBeTruthy();
    expect(view.getByText('7.4')).toBeTruthy();
    expect(view.getByRole('tab', { name: 'Cast' })).toBeTruthy();
    expect(view.getByTestId('title-action-rank')).toBeTruthy();
  });

  it('is on a series page too, under the show’s own scores', async () => {
    // A whole show is ranked in its own pool since 2026-11-14, so it has a Scores section
    // of its own, and availability still follows it.
    mockOpenId = 'series-1';
    tableRows.media_items = [
      {
        ...film,
        id: 'series-1',
        kind: 'series',
        title: 'Severance',
        tmdb_id: 95396,
      },
    ];

    const view = await renderWithProviders(<TitleScreen />);
    await waitFor(() => expect(view.getByTestId('where-to-watch')).toBeTruthy());
    expect(view.getByTestId('scores-section')).toBeTruthy();
  });
});

/**
 * **The score row, in the page's lower half** (founder reconvergence, physical Android,
 * 2026-09-07).
 *
 * This block has moved three times in a week and the reasoning is in the screen. What
 * matters here is that each move was invisible to the tests that existed: they asserted
 * that the pieces were present, and presence is exactly what never changed. So structure
 * is asserted off the rendered tree by `testID` in order, and the copy, the counts and
 * the drilldown are asserted alongside, because a reordering must not quietly cost any
 * of them.
 */
describe('the score row and what surrounds it', () => {
  type IdNode = { props?: { testID?: string }; children?: unknown[] } | string | null;

  /** Every testID in the tree, depth-first — children only, never other props. */
  const testIds = (node: unknown): string[] => {
    if (!node || typeof node === 'string') return [];
    if (Array.isArray(node)) return node.flatMap(testIds);
    const n = node as IdNode & object;
    const own = n.props?.testID ? [n.props.testID] : [];
    return [...own, ...testIds(n.children ?? [])];
  };

  const structure = (view: { toJSON: () => unknown }) => testIds(view.toJSON());
  const text = (view: { toJSON: () => unknown }) => readingOrder(view.toJSON());
  const at = (view: { toJSON: () => unknown }, needle: string) =>
    text(view).findIndex((t) => t.includes(needle));

  const rankThisFilm = () => {
    tableRows.rankings = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        position: 1,
        category: 'movies',
        bucket: 'loved',
      },
    ];
    tableRows.user_media = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        bucket: 'loved',
        watched_on: '2026-08-12',
        note: null,
        note_visibility: 'private',
        note_has_spoilers: false,
      },
    ];
  };

  it('announces itself with a SCORES heading', async () => {
    /**
     * **The heading is back** (founder redesign, 2026-09-07), having been removed on
     * 2026-09-06 on the argument that the units name themselves. That is true of each
     * unit and not of the pair: two circles with words beside them, arriving under a
     * synopsis with no heading, read as a continuation of the synopsis — and no
     * arrangement of two units gives a screen reader a landmark to jump to. It is the
     * app's own section treatment, which is what every other block announces itself with.
     */
    const view = await open();
    await waitFor(() => expect(view.getByTestId('scores-section')).toBeTruthy());

    expect(view.getByText('SCORES')).toBeTruthy();
  });

  it('puts bingd. before the reader’s own people, because it is the wider sample', async () => {
    // Founder's order, 2026-09-13, reversing 2026-09-07. A reader follows a handful of
    // people, so Following usually rests on one or two ratings; the number beside the
    // reader's own should be the one that can bear the comparison.
    const view = await open();
    await waitFor(() => expect(view.getByTestId('scores-section')).toBeTruthy());

    expect(at(view, 'bingd')).toBeLessThan(at(view, 'Following'));
  });

  it('follows the synopsis rather than the metadata', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('scores-section')).toBeTruthy());

    expect(at(view, '148 min')).toBeLessThan(at(view, 'A thief who steals corporate secrets'));
    expect(at(view, 'A thief who steals corporate secrets')).toBeLessThan(at(view, 'bingd'));
  });

  it('draws no rule between the title metadata and the synopsis', async () => {
    /**
     * The founder's instruction, and the thing that made the page feel fragmented: a
     * reader going from the title to what it is about must cross nothing.
     *
     * **Since 2026-09-07 there are no section rules on this page at all.** Both blocks
     * that had one now carry a Maroon section heading and a section's worth of air, and
     * running a hairline as well is what left the page reading as a stack of bordered
     * bands. The page's one remaining rule is above the tab row, which is not a section
     * boundary but a change of mode.
     */
    const view = await open();
    await waitFor(() => expect(view.getByTestId('scores-section')).toBeTruthy());

    const order = structure(view);
    expect(order).not.toContain('scores-divider');
    expect(order).not.toContain('where-to-watch-divider');
  });

  it('separates itself with a heading and air rather than a rule', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('scores-section')).toBeTruthy());

    // The heading opens the section and the units follow it. Whitespace is the app's
    // default separator from 2026-09-07; a rule marks a module, not a sibling.
    expect(view.queryByTestId('scores-divider')).toBeNull();
    expect(at(view, 'SCORES')).toBeLessThan(at(view, 'Following'));
  });

  it('sits above Where to watch, which announces itself the same way', async () => {
    // Availability has to be seeded: the block is the one thing on this page allowed to
    // draw nothing at all, and the default fixture gives it nothing to draw.
    mockFetchWatchProviders.mockResolvedValue({
      region: 'US',
      link: null,
      providers: [
        { provider_id: 8, name: 'Netflix', logo_path: '/netflix.jpg', offers: ['stream'] },
      ],
    });
    const view = await open();
    await waitFor(() => expect(view.getByTestId('where-to-watch')).toBeTruthy());

    const order = structure(view);
    expect(order.indexOf('scores-layout')).toBeLessThan(order.indexOf('where-to-watch'));
    // Two Maroon headings and a section's worth of air between them, and no hairline
    // anywhere in the pair.
    expect(order).not.toContain('where-to-watch-divider');
    expect(order).not.toContain('scores-divider');
  });

  it('holds for a ranked movie, with the personal score leading the row', async () => {
    rankThisFilm();
    mockRpcResults.community_score = [{ score: '7.4', rating_count: 12, min_ratings: 3 }];
    const view = await open();
    await waitFor(() => expect(view.getByText('7.4')).toBeTruthy());

    expect(at(view, 'A thief who steals corporate secrets')).toBeLessThan(at(view, 'bingd'));
    // Stated once, in the Scores row, where the reader's own number is the first term of
    // a comparison rather than a figure beside artwork with nothing to measure it by.
    expect(view.getAllByLabelText('10.0 out of 10')).toHaveLength(1);
    // Your score → bingd. → Following (founder, 2026-09-13).
    expect(at(view, 'Your score')).toBeLessThan(at(view, 'bingd'));
    expect(at(view, 'bingd')).toBeLessThan(at(view, 'Following'));
    expect(view.getByText('12 ratings')).toBeTruthy();
  });

  it('holds for an unranked movie', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('scores-section')).toBeTruthy());

    expect(view.getByTestId('title-action-rank')).toBeTruthy();
    expect(at(view, 'A thief who steals corporate secrets')).toBeLessThan(at(view, 'bingd'));
  });

  it('holds for a ranked TV season', async () => {
    mockOpenId = 'season-1';
    tableRows.media_items = [
      {
        ...film,
        id: 'season-1',
        kind: 'season',
        title: 'Season 1',
        release_date: '2023-04-01',
        runtime_minutes: null,
        parent: {
          id: 'series-1',
          title: 'Breaking Bad',
          poster_path: null,
          backdrop_path: null,
        },
      },
    ];
    tableRows.rankings = [
      {
        user_id: 'user-1',
        media_item_id: 'season-1',
        position: 1,
        category: 'tv_seasons',
        bucket: 'loved',
      },
    ];
    tableRows.user_media = [
      {
        user_id: 'user-1',
        media_item_id: 'season-1',
        bucket: 'loved',
        watched_on: null,
        note: null,
      },
    ];

    const view = await renderWithProviders(<TitleScreen />);
    await waitFor(() => expect(view.getByTestId('scores-section')).toBeTruthy());

    const order = structure(view);
    expect(order.indexOf('scores-section')).toBeGreaterThan(order.indexOf('title-meta'));
    expect(order.indexOf('scores-divider')).toBeLessThan(order.indexOf('scores-layout'));
  });

  it('draws the score row on a series, about the show alone (2026-11-14)', async () => {
    mockOpenId = 'series-1';
    tableRows.media_items = [
      { ...film, id: 'series-1', kind: 'series', title: 'Breaking Bad', runtime_minutes: null },
    ];

    const view = await renderWithProviders(<TitleScreen />);
    await waitFor(() => expect(view.getByText(/^Breaking Bad/)).toBeTruthy());

    expect(view.getByTestId('scores-section')).toBeTruthy();
    expect(view.getByTestId('scores-unit-you')).toBeTruthy();
  });

  it('keeps the insufficient-ratings state, in each row’s own words', async () => {
    const view = await open();
    // Three rows with nothing to report and three different sentences, because they are
    // three different facts: the reader has not ranked it, nobody they follow has, and
    // the app is short of a sample. Only the middle one is something they can act on.
    await waitFor(() => expect(view.getByText('Not enough ratings')).toBeTruthy());
    expect(view.getByText('No ratings yet')).toBeTruthy();
    expect(view.getByText('Not ranked yet')).toBeTruthy();

    expect(view.queryByText(/more needed/)).toBeNull();
  });

  it('still opens the people behind the Following number', async () => {
    mockRpcResults.following_score = [{ score: '8.6', rating_count: 3, following_count: 9 }];
    const view = await open();
    await waitFor(() => expect(view.getByText('3 ratings')).toBeTruthy());

    // The spoken label names the number before the sample, since a Pressable with its own
    // label absorbs its children's and the 8.6 would otherwise never be read out.
    await fireEvent.press(
      view.getByRole('button', { name: /^Following\. 8\.6 out of 10\. 3 ratings$/ }),
    );

    await waitFor(() =>
      expect(view.getByLabelText('People you follow who rated Inception')).toBeTruthy(),
    );
  });

  it('says the same numbers it always did', async () => {
    mockRpcResults.community_score = [{ score: '7.4', rating_count: 12, min_ratings: 3 }];
    mockRpcResults.following_score = [{ score: '9.1', rating_count: 1, following_count: 4 }];
    const view = await open();

    await waitFor(() => expect(view.getByText('7.4')).toBeTruthy());
    expect(view.getByText('12 ratings')).toBeTruthy();
    expect(view.getByText('9.1')).toBeTruthy();
    // Both aggregates count ratings the same way since 2026-09-08; the labels are what
    // distinguish the two populations.
    expect(view.getByText('1 rating')).toBeTruthy();
    expect(view.getByText('bingd')).toBeTruthy();
    expect(view.getByText('Following')).toBeTruthy();
  });
});

/**
 * **A rerank is not a rewatch** (founder, physical Android, 2026-09-07).
 *
 * The report: ranked *Terrace House: Tokyo 2019-2020, S1*, adjusted the placement a
 * minute later, and the feed carried two "ranked" rows for one watch — 8.3, then 8.6.
 *
 * The database was never wrong. `_rank_finalize` has posted `title_ranked` only
 * `if p_new_watch or not v_replaced` since 20260826000500, so a session that replaces an
 * existing position announces nothing; production holds exactly one `rankings` row and
 * one `user_media` row for that season, so no watch was duplicated either. What produced
 * the second activity was this menu: the row that reads like "redo my ranking" was
 * **Rank again**, which the product defines as a second viewing and which therefore
 * earns an activity by design.
 *
 * The fix was to name the intent, and the menu carried three rows for a day:
 *
 *   Rank it again      `rerank` — same watch, no activity
 *   Log another watch  `again`  — a real rewatch, exactly one activity
 *   Change your rating  the band, through the log sheet
 *
 * ---------------------------------------------------------------------------
 * **AND THEN THERE WERE TWO** (founder, 2026-09-08)
 *
 * The first and third were two doors into one act. Both correct a rating already given,
 * both leave `p_new_watch` false, both write no activity; the only difference was that
 * one skipped the band chooser — a mechanism, which is precisely what the 2026-09-07
 * pass had decided this menu must stop exposing. So the menu is:
 *
 *   Edit ranking  the same-watch correction, whole. Opens the log sheet's band
 *                       chooser, from which a *different* band is `rank_rebucket` and
 *                       the *same* band is `rankAgain(newWatch: false)` — which is
 *                       exactly the call *Rank it again* used to make directly.
 *   Log another watch   `again` — a real rewatch, exactly one activity.
 *
 * **Nothing under the menu changed.** No RPC, no argument, no migration, no ranking
 * maths, and no historical activity. `rerank` is still reached; it is reached through
 * one row instead of two, and the tests below reach it the way a reader now does.
 *
 * These pin the parameter that decides it, `p_new_watch`, because that single boolean is
 * the whole difference between the two intents and nothing on screen shows it. Server
 * behaviour is not re-tested here — it is SQL, and it was already correct.
 */
describe('adjusting a ranking versus watching it again', () => {
  /** A ranked film, which is the only state this menu exists in. */
  beforeEach(() => {
    tableRows.rankings = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        position: 1,
        category: 'movies',
        bucket: 'loved',
      },
    ];
    tableRows.user_media = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        bucket: 'loved',
        watched_on: '2026-08-12',
        note: null,
        note_visibility: 'private',
        note_has_spoilers: false,
      },
    ];
  });

  const openMenu = async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-more'));
    await waitFor(() => expect(view.getByLabelText('Edit ranking')).toBeTruthy());
    return view;
  };

  /**
   * **The same-watch correction, taken the way a reader now takes it.**
   *
   * *Edit ranking* opens the log sheet's band chooser; re-choosing the band the
   * title already has is the correction, and it goes **straight into the comparisons** —
   * `rankAgain(newWatch: false)` on the tap, with no confirmation card between (founder QA,
   * 2026-09-21). That is the exact call the retired *Rank it again* row made in one tap,
   * which is what makes this a consolidated entry point rather than a lost capability.
   *
   * The fixture is a Loved film throughout this block, so `I liked it` is the same band.
   */
  const correctTheRating = async (view: Awaited<ReturnType<typeof openMenu>>) => {
    await fireEvent.press(view.getByLabelText('Edit ranking'));
    await waitFor(() => expect(view.getByText('I liked it')).toBeTruthy());
    await fireEvent.press(view.getByText('I liked it'));
  };

  /** The card that used to sit between the band tap and the comparisons, in every form. */
  const expectNoRerankConfirmation = (view: Awaited<ReturnType<typeof openMenu>>) => {
    expect(view.queryByText(/again\?/)).toBeNull();
    expect(view.queryByText(/Changing this will re-rank/)).toBeNull();
    expect(view.queryByText(/Nothing changes until you finish/)).toBeNull();
    expect(view.queryByText('Re-rank')).toBeNull();
  };

  /** Every `rank_again` call the screen made, with its arguments. */
  const againCalls = () =>
    mockRpc.mock.calls.filter(([name]: [string]) => name === 'rank_again');

  it('offers both intents, named so neither can be mistaken for the other', async () => {
    const view = await openMenu();

    expect(view.getByLabelText('Edit ranking')).toBeTruthy();
    expect(view.getByLabelText('Log another watch')).toBeTruthy();
    // Every label this row has ever worn that meant "another viewing" while reading like
    // "redo my ranking", plus the second correction door the founder consolidated away.
    expect(view.queryByLabelText('Rank again')).toBeNull();
    expect(view.queryByLabelText('Rank it again')).toBeNull();
    expect(view.queryByLabelText('Change your rating')).toBeNull();
  });

  it('corrects the placement of the same watch, without declaring a new one', async () => {
    /**
     * **The capability the consolidation had to keep.** `p_new_watch: false` is what
     * makes `_rank_finalize` suppress the activity, and re-running the comparisons is
     * what re-establishes the position — so this one assertion is the whole of "the
     * reader can still fix where a title sits without pretending to have watched it
     * again".
     */
    const view = await openMenu();

    await correctTheRating(view);

    await waitFor(() => expect(againCalls().length).toBe(1));
    expect(againCalls()[0]![1]).toEqual(
      expect.objectContaining({ p_new_watch: false, p_bucket: 'loved' }),
    );
    // And it is a correction end to end: no band change went with it.
    expect(mockRpc).not.toHaveBeenCalledWith('rank_rebucket', expect.anything());
  });

  /**
   * **The rewatch row records a watch first, and ranks nothing** (T3b, epic §J.3).
   *
   * It used to open the ranking sheet directly: a forced full re-rank that recorded no
   * watch and no date (§C.3.2), so a reader saying "I watched Heat again last night" was
   * made to answer six comparisons and the app learned nothing about the viewing.
   *
   * The assertion is therefore the opposite of what it was, and deliberately so: tapping
   * this row must call **no** `rank_again` at all. The re-check is offered after the
   * watch is saved, and it is optional — closing from there is a complete act.
   *
   * The correction row's own `p_new_watch: false` is asserted by the tests around this
   * one, which is where that half of the distinction now lives.
   */
  it('records a watch before it ranks anything, from the rewatch row', async () => {
    const view = await openMenu();

    await fireEvent.press(view.getByLabelText('Log another watch'));

    // The sheet opens on the bands; nothing is saved or ranked until one is chosen.
    await waitFor(() => expect(view.getByTestId('rewatch-bucket-choices')).toBeTruthy());
    expect(againCalls().length).toBe(0);
    expect(mockRpc).not.toHaveBeenCalledWith('log_rewatch_with_details', expect.anything());
  });

  it('never unranks and restarts, in either intent', async () => {
    // The atomic call is what keeps the title from having no position for a moment.
    // Composing the pair here would lose the ranking outright on a dropped connection.
    const view = await openMenu();

    await correctTheRating(view);

    await waitFor(() => expect(againCalls().length).toBe(1));
    expect(mockRpc).not.toHaveBeenCalledWith('rank_unrank', expect.anything());
    expect(mockRpc).not.toHaveBeenCalledWith('rank_start', expect.anything());
  });

  it('keeps the band the title already has, rather than deciding a rating', async () => {
    const view = await openMenu();

    await correctTheRating(view);

    // Straight through from `rankings.bucket`, in the database's own spelling. Correcting
    // a placement is not an opinion about the band, even though the reader now passes
    // through the band chooser to say so.
    await waitFor(() =>
      expect(againCalls()[0]![1]).toEqual(expect.objectContaining({ p_bucket: 'loved' })),
    );
  });

  it('carries one operation id per intent, so a retry is not a second opinion', async () => {
    const view = await openMenu();

    await correctTheRating(view);

    await waitFor(() => expect(againCalls().length).toBe(1));
    /**
     * The idempotency boundary is threaded: `rank_again` is called *through* the
     * operation-id parameter, so `_claim_operation_result` answers a repeat of one
     * intent with the stored result rather than running a second session.
     *
     * The key is asserted rather than its value, because this suite does not mock
     * `expo-crypto` and `randomUUID` yields nothing here. What would be wrong is the
     * parameter being absent from the call — that is the shape that turns a retry into
     * a second opinion, and it is what this pins.
     */
    expect(Object.keys(againCalls()[0]![1] as object)).toContain('p_operation_id');
  });

  it('does not open a second session when the rewatch row is double-tapped', async () => {
    const view = await openMenu();
    const row = view.getByLabelText('Log another watch');

    await fireEvent.press(row);
    await fireEvent.press(row);

    /**
     * The menu closes on the first press, so the second lands on nothing — and the
     * sheet is keyed by title, so even a re-entry would reuse one.
     *
     * **What it opens is the watch, not a session** (T3b). The double tap still has to
     * cost nothing, and the property is stronger than it was: no session exists yet at
     * all, because the re-check is offered only after the viewing is saved.
     */
    await waitFor(() => expect(view.getByTestId('rewatch-bucket-choices')).toBeTruthy());
    expect(againCalls().length).toBe(0);
    expect(view.queryAllByTestId('rewatch-bucket-choices')).toHaveLength(1);
  });

  it('holds for a season, which is the shape the founder reported', async () => {
    mockOpenId = 'season-1';
    tableRows.media_items = [
      {
        ...film,
        id: 'season-1',
        kind: 'season',
        title: 'Season 1',
        release_date: '2023-04-01',
        runtime_minutes: null,
        parent: {
          id: 'series-1',
          title: 'Breaking Bad',
          poster_path: null,
          backdrop_path: null,
        },
      },
    ];
    tableRows.rankings = [
      {
        user_id: 'user-1',
        media_item_id: 'season-1',
        position: 1,
        category: 'tv_seasons',
        bucket: 'loved',
      },
    ];
    tableRows.user_media = [
      {
        user_id: 'user-1',
        media_item_id: 'season-1',
        bucket: 'loved',
        watched_on: null,
        note: null,
      },
    ];

    const view = await renderWithProviders(<TitleScreen />);
    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-more'));
    await waitFor(() => expect(view.getByLabelText('Edit ranking')).toBeTruthy());

    await correctTheRating(view);

    await waitFor(() => expect(againCalls().length).toBe(1));
    expect(againCalls()[0]![1]).toEqual(expect.objectContaining({ p_new_watch: false }));
  });

  it('writes no ranking call from the row itself, only from what follows it', async () => {
    /**
     * *Edit ranking* opens the log sheet's band chooser and stops there. The
     * ranking call is decided by what the reader chooses next — the same band is a
     * correction, a different one is a rebucket — and a row that fired one on the way in
     * would be deciding a rating on the reader's behalf.
     */
    const view = await openMenu();

    await fireEvent.press(view.getByLabelText('Edit ranking'));

    expect(againCalls()).toHaveLength(0);
    expect(mockRpc).not.toHaveBeenCalledWith('rank_rebucket', expect.anything());
  });

  it('moves the band from the same row, which is the other half of the correction', async () => {
    /**
     * **The capability check the consolidation exists to survive.** One row now has to
     * carry both same-watch corrections: the position, above, and the band, here. A
     * different band is `rank_rebucket`, which re-runs the comparisons because PRD §10
     * refuses to estimate a new position for a moved band — and it is still not a
     * viewing, so it writes no activity of its own.
     */
    const view = await openMenu();

    await fireEvent.press(view.getByLabelText('Edit ranking'));
    await waitFor(() => expect(view.getByText('It was fine')).toBeTruthy());
    // One tap, and the comparisons open: there is no confirmation to press.
    await fireEvent.press(view.getByText('It was fine'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'rank_rebucket',
        expect.objectContaining({ p_bucket: 'fine' }),
      ),
    );
    expectNoRerankConfirmation(view);
    // A band change is its own call; it never routes through the rewatch one.
    expect(againCalls()).toHaveLength(0);
  });

  /**
   * **The contract, as the founder stated it after device QA (2026-09-21).**
   *
   *   Edit ranking → the comparisons, immediately, and NO watch event.
   *   Log another watch  → a separate sheet, and a watch event.
   *
   * The first half used to stop on "Rank <title> again? … [Re-rank] [Cancel]". Both
   * halves are asserted together so that neither can drift toward the other.
   */
  it('goes straight into the comparisons, and records no watch, from Edit ranking', async () => {
    const view = await openMenu();

    await correctTheRating(view);

    // The session opened on the band tap itself.
    await waitFor(() => expect(againCalls().length).toBe(1));
    expect(againCalls()[0]![1]).toEqual(expect.objectContaining({ p_new_watch: false }));
    expectNoRerankConfirmation(view);
    // None of the calls that record a viewing was made.
    expect(mockRpc).not.toHaveBeenCalledWith('log_rewatch', expect.anything());
    expect(mockRpc).not.toHaveBeenCalledWith('log_title', expect.anything());
    expect(mockRpc).not.toHaveBeenCalledWith('set_watch_date', expect.anything());
  });

  /**
   * **The approved rewatch flow** (founder QA, 2026-09-21): the viewing's details, Save, then
   * the ORDINARY ranking entry — *How was it?* with nothing preselected — then comparisons
   * in whichever band was chosen, tied to the viewing. No *Re-check placement*, no *Keep at
   * #X*, and no assumption that the band the title had last time is still right.
   */
  it('records a watch, then asks How was it? afresh and ranks in the band chosen', async () => {
    mockRpcResults.log_rewatch_with_details = { status: 'ok', watch_event_id: 'event-2' };
    const view = await openMenu();

    await fireEvent.press(view.getByLabelText('Log another watch'));

    // The log sheet's layout: How was it? on top, nothing preselected, then the same
    // optional rows as the ordinary log, all closed.
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    expect(view.getByLabelText(/Who I watched with/)).toBeTruthy();
    expect(view.getByLabelText(/^Note/)).toBeTruthy();
    expect(view.getByLabelText(/Watch date/)).toBeTruthy();
    expect(view.queryByPlaceholderText('What did you think?')).toBeNull();
    expect(view.queryByText(/Re-check placement/)).toBeNull();
    expect(view.queryByText(/Keep at #/)).toBeNull();
    expect(view.queryByText('Save watch')).toBeNull();

    // Choosing a band saves the watch (details in the same call), then ranks. The
    // fixture is Loved; a DIFFERENT band re-ranks there, on this viewing.
    await fireEvent.press(view.getByText('It was fine'));
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('log_rewatch_with_details', expect.anything()),
    );
    await waitFor(() => expect(againCalls().length).toBe(1));
    expect(againCalls()[0]![1]).toEqual(
      expect.objectContaining({ p_bucket: 'fine', p_watch_event_id: 'event-2' }),
    );
  });
});

/**
 * **The page does not move because something else refetched** (founder, physical iOS
 * 1.0.1 build 9, 2026-09-09).
 *
 * The founder's report is a title page that slid down and back up, exposing a blank band
 * above the hero, while a review was being typed into the sheet in front of it. It was
 * reported once against build 8, answered by holding the bottom safe-area inset steady
 * (`use-stable-bottom-inset.ts`), and came back unchanged — because the inset was never
 * the channel.
 *
 * The channel is `RefreshControl.refreshing`, and the chain has five links:
 *
 *   1. the log sheet autosaves the note *while it is being typed*;
 *   2. a successful save invalidates `queryKeys.title(mediaItemId)`;
 *   3. this page's `personal` query is keyed under that prefix, so it refetches;
 *   4. `isRefetching` goes true, and it was wired straight to `refreshing`;
 *   5. iOS reads that as `beginRefreshing()` — a *programmatic pull* — which grows the
 *      scroll view's top content inset and animates the content down to meet it.
 *
 * The test drives link 2 directly, which is the only link that needs a person in the real
 * world, and asserts link 5 cannot follow. `usePullRefresh` is the fix and
 * `use-pull-refresh.test.tsx` holds its own contract; this is the binding, on the page the
 * founder was actually looking at.
 */
describe('the page behind an open sheet', () => {
  /**
   * The control, read off the scroll view that owns it.
   *
   * `refreshControl` is a *prop* holding an element rather than a child, so it is never a
   * node in the host tree and cannot be queried for. The scroll view carrying it is the
   * page's own; nothing else on this route has one.
   */
  const refreshControl = (view: Awaited<ReturnType<typeof open>>) =>
    view
      .root!.queryAll(() => true)
      .map((node) => node as never as { props?: Record<string, any> })
      .find((node) => node.props?.refreshControl)?.props?.refreshControl;

  it('does not begin refreshing because a query it observes was invalidated', async () => {
    const view = await open();

    const before = refreshControl(view);
    // The page draws a RefreshControl at all: the gesture the Seasons empty state promises.
    expect(before).toBeTruthy();
    expect(before.props.refreshing).toBe(false);

    // The refetch is parked, so the assertion below runs *while* the query is fetching.
    // Without this the read answers in the same microtask as the invalidation and there is
    // no in-flight moment for the old binding to be wrong in.
    holdReadsOf('user_media');

    // Exactly what a note autosave does. Nothing here pulls.
    await act(async () => {
      void view.client.invalidateQueries({ queryKey: ['title', 'film-1'] });
    });

    /**
     * A whole turn, not just a microtask.
     *
     * React Query notifies its observers through `notifyManager`, which batches into a
     * scheduled callback — so the fetch has begun before this line and the *render* that
     * reads it has not. Without the turn, the assertion below reads the frame from before
     * the refetch and passes whatever the binding is: a test that cannot fail, which is
     * what this one was until the line was added.
     */
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // On iOS this being true is not a spinner: it is the page held sixty points down,
    // with the band of background above the hero the founder photographed.
    expect(refreshControl(view).props.refreshing).toBe(false);

    await act(async () => {
      releaseReadsOf('user_media');
    });
  });
});

/**
 * **Pull to refresh asks for seasons only where there is a series** (2026-11-12).
 *
 * The page hands `useSeasons` no series on a season or movie page, and pull-to-refresh
 * called `seasons.refetch()` regardless. In React Query v5 `refetch()` ignores `enabled`,
 * so the queryFn ran with `seriesId === null`: `parent_id=eq.null`, a 22P02 from Postgres,
 * and two retries holding the spinner for about three seconds (22 such requests in seven
 * days of production logs). `useSeasons` now has a `skipToken` queryFn with no series, and
 * the page refetches seasons only on a whole-show page.
 */
describe('pull to refresh and the season list', () => {
  /** The page's own `RefreshControl`, read off the scroll view that carries it. */
  const refreshControl = (view: Awaited<ReturnType<typeof renderWithProviders>>) =>
    view
      .root!.queryAll(() => true)
      .map((node) => node as never as { props?: Record<string, any> })
      .find((node) => node.props?.refreshControl)?.props?.refreshControl;

  const pull = async (view: Awaited<ReturnType<typeof renderWithProviders>>) => {
    await act(async () => {
      refreshControl(view).props.onRefresh();
    });
    // Promptly: the test client does not retry, so anything still spinning here is
    // waiting on a request, not on a back-off.
    await waitFor(() => expect(refreshControl(view).props.refreshing).toBe(false));
  };

  /** The season list's own cache entry for "no series": never run, so never failed. */
  const expectNoSeriesQueryUntouched = (
    view: Awaited<ReturnType<typeof renderWithProviders>>,
  ) => {
    const state = view.client.getQueryState(['seasons', '']);
    expect(state?.status).not.toBe('error');
    expect(state?.fetchFailureCount ?? 0).toBe(0);
  };

  it('on a movie page, sends no season-list read with a null series', async () => {
    const view = await open();
    await pull(view);

    expect(mockSeasonListReads).not.toContain(null);
    expectNoSeriesQueryUntouched(view);
  });

  it('on a season page, sends no season-list read with a null series', async () => {
    mockOpenId = 'season-1';
    tableRows.media_items = [
      {
        ...film,
        id: 'season-1',
        kind: 'season',
        title: 'Season 1',
        release_date: '2023-04-01',
        runtime_minutes: null,
        parent: {
          id: 'series-1',
          title: 'Breaking Bad',
          poster_path: null,
          backdrop_path: null,
        },
      },
    ];
    const view = await renderWithProviders(<TitleScreen />);
    await waitFor(() =>
      expect(view.getByTestId('title-name')).toHaveTextContent(/^Breaking Bad$/),
    );

    await pull(view);

    expect(mockSeasonListReads).not.toContain(null);
    expectNoSeriesQueryUntouched(view);
  });

  it('on a whole-show page, still refetches the seasons, once', async () => {
    mockOpenId = 'series-1';
    tableRows.media_items = [
      { ...film, id: 'series-1', kind: 'series', title: 'Breaking Bad', runtime_minutes: null },
      {
        id: 'season-1',
        parent_id: 'series-1',
        kind: 'season',
        season_number: 1,
        title: 'Season 1',
        release_date: '2008-01-20',
        poster_path: null,
        fetched_at: new Date().toISOString(),
      },
    ];
    const view = await renderWithProviders(<TitleScreen />);
    await waitFor(() => expect(view.getByText(/Season 1/)).toBeTruthy());
    const before = mockSeasonListReads.length;
    expect(mockSeasonListReads).toEqual(Array(before).fill('series-1'));

    await pull(view);

    expect(mockSeasonListReads.slice(before)).toEqual(['series-1']);
  });
});

/**
 * **Anything in the collection can leave it without being ranked first** (Android beta
 * report, 2026-09-18).
 *
 * A Letterboxd import put the wrong *Hamlet* on somebody's shelf, logged and unranked. The
 * options sheet — the only door to Remove from collection — opened only for a ranked title,
 * so the one way out was to rank a film they had not watched and then remove it. `unlog`
 * has always accepted an unranked title; only the door was missing.
 *
 * The page cannot tell an imported row from a native one (it does not select `source`), so
 * both shapes are pinned: an imported row carries the diary date and a bucket from the
 * star, a natively logged one may carry neither.
 */
describe('a title in the collection that is not ranked', () => {
  // An import arrives with no bucket: a Letterboxd star is never a bingd opinion
  // (founder, 2026-09-21; 20261018000100).
  const importedRow = {
    user_id: 'user-1',
    media_item_id: 'film-1',
    bucket: null as string | null,
    watched_on: '2026-08-30',
    note: null,
    note_visibility: 'private',
    note_has_spoilers: false,
  };

  beforeEach(() => {
    tableRows.rankings = [];
    tableRows.user_media = [importedRow];
    mockRpcResults.unlog = { status: 'ok' };
  });

  const openMenu = async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-more'));
    await waitFor(() => expect(view.getByLabelText('Remove from collection')).toBeTruthy());
    return view;
  };

  it('offers the menu for an imported title that was never ranked', async () => {
    const view = await open();

    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
    // The Rank control is still the page's primary act, and still leads to the log.
    expect(view.getByTestId('title-action-rank')).toBeTruthy();
  });

  it('offers the menu for a title logged here with no date and no rating', async () => {
    tableRows.user_media = [{ ...importedRow, bucket: null, watched_on: null }];
    const view = await open();

    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
  });

  it('holds Remove from collection and nothing that acts on a ranking', async () => {
    const view = await openMenu();

    for (const label of [
      'Edit ranking',
      'Log another watch',
      'Who I watched with',
      'Add a note',
    ]) {
      expect(view.queryByLabelText(label)).toBeNull();
    }
    expect(view.queryByText('Ranking')).toBeNull();
  });

  it('asks with the same destructive confirmation before it removes anything', async () => {
    const view = await openMenu();

    await fireEvent.press(view.getByLabelText('Remove from collection'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertSpy.mock.calls.at(-1)?.[0]).toBe('Remove Inception from your collection?');
    const buttons = alertSpy.mock.calls.at(-1)?.[2] ?? [];
    expect(buttons.map((button) => button.text)).toEqual(['Cancel', 'Remove']);
    expect(buttons.find((button) => button.text === 'Remove')?.style).toBe('destructive');
    expect(mockRpc).not.toHaveBeenCalledWith('unlog', expect.anything());
  });

  it('removes it in one confirmed action, never asking for or touching a ranking', async () => {
    const view = await openMenu();
    await fireEvent.press(view.getByLabelText('Remove from collection'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());

    const buttons = alertSpy.mock.calls.at(-1)?.[2] ?? [];
    await act(async () => {
      buttons.find((button) => button.text === 'Remove')?.onPress?.();
    });

    // The operation id is expo-crypto's, which has no native module under Jest; what this
    // test is about is which title goes and through which call.
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'unlog',
        expect.objectContaining({ p_media_item_id: 'film-1' }),
      ),
    );
    // One write, and it is the removal: no ranking is started, finished or cleared on the way.
    expect(
      mockRpc.mock.calls.map(([name]) => name).filter((name) => /^rank_/.test(name)),
    ).toEqual([]);
    expect(mockRpc.mock.calls.filter(([name]) => name === 'unlog')).toHaveLength(1);
  });

  it('still clears a ranked title’s ranking first, which is the path that already worked', async () => {
    tableRows.rankings = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        position: 1,
        category: 'movies',
        bucket: 'loved',
      },
    ];
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-more'));
    // The full ranked menu, unchanged.
    await waitFor(() => expect(view.getByLabelText('Edit ranking')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Remove from collection'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());

    const buttons = alertSpy.mock.calls.at(-1)?.[2] ?? [];
    await act(async () => {
      buttons.find((button) => button.text === 'Remove')?.onPress?.();
    });

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('unlog', expect.anything()));
    const names = mockRpc.mock.calls.map(([name]) => name);
    expect(names.indexOf('rank_unrank')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('rank_unrank')).toBeLessThan(names.indexOf('unlog'));
  });
});

/**
 * **Add to List is one tap on the action row** (founder QA, 2026-09-21), beside Watchlist
 * and Share — it used to live only behind the page's ⋯ (lists-prd.md §R).
 *
 * What is pinned: every title has it, it opens the Add-to-list sheet directly (no menu,
 * so no presentation to serialise), the ⋯ no longer carries a duplicate row, and a title
 * with nothing else in its menu no longer draws a ⋯ at all.
 */
describe('Add to list', () => {
  beforeEach(() => {
    tableRows.rankings = [];
    tableRows.user_media = [];
  });

  const inCollection = () => {
    tableRows.user_media = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        bucket: 'loved',
        watched_on: '2026-08-30',
        note: null,
        note_visibility: 'private',
        note_has_spoilers: false,
      },
    ];
  };

  it('is a one-tap action on a title that is neither ranked nor logged', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-action-list')).toBeTruthy());
  });

  it('sits between Watchlist and Share on the action row', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-action-list')).toBeTruthy());
    const ids = view
      .getAllByTestId(/^title-action-(save|list|recommend)$/)
      .map((node) => node.props.testID as string);
    expect(ids.indexOf('title-action-save')).toBeLessThan(ids.indexOf('title-action-list'));
    expect(ids.indexOf('title-action-list')).toBeLessThan(
      ids.indexOf('title-action-recommend'),
    );
  });

  it('opens the Add-to-list sheet directly, with nothing refused', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-action-list')).toBeTruthy());

    await fireEvent.press(view.getByTestId('title-action-list'));

    await waitFor(() => expect(view.getByLabelText('New list')).toBeTruthy());
    const shows = (globalThis as unknown as { __modalShows: { refused: number } }).__modalShows;
    expect(shows.refused).toBe(0);
  });

  it('draws no ⋯ on a title with nothing else to manage', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-action-list')).toBeTruthy());
    expect(view.queryByTestId('title-more')).toBeNull();
  });

  it('no longer duplicates Add to list in the menu of a title in the collection', async () => {
    inCollection();
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-more'));

    await waitFor(() => expect(view.getByLabelText('Remove from collection')).toBeTruthy());
    expect(view.queryByLabelText('Add to list…')).toBeNull();
  });
});

/**
 * **Rank or Ranked on the title page** (founder, final UI simplification 2026-09-21): an
 * untouched title, an untouched import and an unfinished ranking all read the ordinary
 * **Rank** — never "Finish ranking" or "Ranking not finished". The tap is what knows the
 * difference: the log sheet, or straight back into the unfinished session.
 */
describe('the ranking state on the title page', () => {
  const logged = (bucket: string | null) => {
    tableRows.rankings = [];
    tableRows.user_media = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        bucket,
        watched_on: null,
        note: null,
        note_visibility: 'private',
        note_has_spoilers: false,
      },
    ];
  };

  const rankStarts = () => mockRpc.mock.calls.filter(([fn]) => fn === 'rank_start');

  it('reads Rank for an unfinished ranking, and Rank resumes it rather than asking again', async () => {
    logged('fine');
    const view = await open();

    await waitFor(() => expect(view.getByTestId('title-action-rank')).toBeTruthy());
    expect(view.getByText('Not ranked yet')).toBeTruthy();
    expect(view.queryByText('Finish ranking')).toBeNull();
    expect(view.queryByText('Ranking not finished')).toBeNull();

    await fireEvent.press(view.getByTestId('title-action-rank'));
    await waitFor(() => expect(rankStarts()).toHaveLength(1));
    expect(rankStarts()[0][1]).toMatchObject({ p_media_item_id: 'film-1', p_bucket: 'fine' });
    expect(view.queryByLabelText('How was it?')).toBeNull();
  });

  it('reads Rank for a seen title with no bucket, such as an untouched import, and logs it', async () => {
    logged(null);
    const view = await open();

    await waitFor(() => expect(view.getByTestId('title-action-rank')).toBeTruthy());
    expect(view.getByText('Not ranked yet')).toBeTruthy();
    expect(view.queryByText('Finish ranking')).toBeNull();

    await fireEvent.press(view.getByTestId('title-action-rank'));
    await waitFor(() => expect(view.getByLabelText('How was it?')).toBeTruthy());
    expect(rankStarts()).toHaveLength(0);
  });
});

/**
 * **The Immersive Scroll experiment** (founder, 2026-11-04).
 *
 * The same screen with the device switch set to `immersive`. Everything above is the
 * original page and still runs with the switch at its default, which is the first
 * property these pin: nothing changes for anybody who has not opted in. The rest is what
 * the brief asks of the experiment: one cinematic first screen, each piece of the page
 * stated once, and the same actions behind the same handlers.
 */
describe('the immersive title page (experiment)', () => {
  const ranked = () => {
    tableRows.rankings = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        position: 1,
        category: 'movies',
        bucket: 'loved',
      },
      {
        user_id: 'user-1',
        media_item_id: 'other',
        position: 2,
        category: 'movies',
        bucket: 'loved',
      },
    ];
    tableRows.user_media = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        bucket: 'loved',
        watched_on: '2026-08-12',
        note: null,
        note_visibility: 'private',
        note_has_spoilers: false,
      },
    ];
  };
  const reviewBy = (n: number) => ({
    id: `um-${n}`,
    user_id: `user-${n + 10}`,
    username: `reader${n}`,
    display_name: `Reader ${n}`,
    avatar_path: null,
    note: `Review number ${n}.`,
    has_spoilers: false,
    updated_at: '2026-08-16T10:00:00.000Z',
    score: '8.4',
    reaction_count: 0,
    helpful_count: 0,
    viewer_helpful: false,
  });

  it('shows the Original page to someone who chose it in Labs', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-identity-copy')).toBeTruthy());
    expect(view.queryByTestId('immersive-hero')).toBeNull();
  });

  describe('once opted in', () => {
    beforeEach(async () => {
      await hydrateTitleLayout();
      await setTitleLayout('immersive');
    });
    afterEach(async () => {
      await setTitleLayout('original');
      mockFocused = true;
    });

    it('asks for light status glyphs over the artwork while it is the screen on top', async () => {
      mockStatusBars.length = 0;
      const view = await open();
      await waitFor(() => expect(view.getByTestId('immersive-hero')).toBeTruthy());
      expect(mockStatusBars.at(-1)).toBe('light');
    });

    it('asks for dark status glyphs from the first frame when there is no artwork', async () => {
      // The band is Parchment then, and white glyphs on it would be unreadable.
      tableRows.media_items = [{ ...film, backdrop_path: null, poster_path: null }];
      mockStatusBars.length = 0;
      const view = await open();
      await waitFor(() => expect(view.getByTestId('immersive-hero')).toBeTruthy());
      expect(mockStatusBars.at(-1)).toBe('dark');
    });

    it('gives the full cast sheet a labelled way out', async () => {
      const six = Array.from({ length: 6 }, (_, n) => ({
        id: 9100 + n,
        name: `Player ${n + 1}`,
        character: null,
        profile_path: null,
      }));
      tableRows.media_cache = [{ ...credits, payload: { ...credits.payload, cast: six } }];
      const view = await open();
      await fireEvent.press(
        await waitFor(() => view.getByRole('button', { name: 'See all 6 cast members' })),
      );
      await waitFor(() => expect(view.getByTestId('cast-sheet')).toBeTruthy());
      await fireEvent.press(view.getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(view.queryByTestId('cast-sheet')).toBeNull());
    });

    it('asks for nothing once another screen covers it, so the next screen keeps its own', async () => {
      mockFocused = false;
      mockStatusBars.length = 0;
      const view = await open();
      await waitFor(() => expect(view.getByTestId('immersive-hero')).toBeTruthy());
      expect(mockStatusBars).toEqual([]);
    });

    /**
     * **The head of the page, then the page** (founder, title-page sprint, 2026-11-06): the
     * hero is the sharp artwork and the module and nothing else — no viewport-high floor, no
     * chevron — and About follows the module directly.
     */
    it('is only as tall as its contents, with no chevron, and About right after the module', async () => {
      const view = await open();
      await waitFor(() => expect(view.getByTestId('immersive-hero')).toBeTruthy());
      await act(async () => {
        fireEvent(view.getByTestId('title-scroll'), 'layout', {
          nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 744 } },
        });
      });

      const hero = view.getByTestId('immersive-hero');
      expect(StyleSheet.flatten(hero.props.style).minHeight).toBeUndefined();
      expect(view.queryByRole('button', { name: 'More about this title' })).toBeNull();
      expect(view.queryByTestId('immersive-more')).toBeNull();
      expect(view.queryByTestId('immersive-extension')).toBeNull();
      // About is a section after the hero, never inside it.
      expect(within(hero).queryByTestId('immersive-section-about')).toBeNull();
      const ids: string[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        const { props, children } = node as { props?: { testID?: string }; children?: unknown };
        if (props?.testID) ids.push(props.testID);
        walk(children);
      };
      walk(view.toJSON());
      expect(ids.indexOf('immersive-module')).toBeLessThan(
        ids.indexOf('immersive-section-about'),
      );
    });

    it('opens on the cinematic first screen, with none of the original identity block', async () => {
      const view = await open();
      await waitFor(() => expect(view.getByTestId('immersive-hero')).toBeTruthy());

      expect(view.queryByTestId('title-identity-copy')).toBeNull();
      expect(view.queryByTestId('title-poster-column')).toBeNull();
      // Everything that names or acts on the title sits in the one floating module.
      const module = within(view.getByTestId('immersive-module'));
      expect(module.getByTestId('title-name')).toBeTruthy();
      expect(module.getByTestId('genre-line')).toBeTruthy();
      expect(module.getByTestId('title-meta')).toBeTruthy();
      expect(module.getByTestId('title-actions')).toBeTruthy();
      expect(module.getByTestId('immersive-scores')).toBeTruthy();
    });

    /**
     * **A season's line: number, episode count, year** (founder hotfix, 2026-11-07), and
     * its episodes as one rail under their heading, with the synopsis in a sheet.
     */
    describe('on a season', () => {
      const season = {
        ...film,
        id: 'season-2',
        kind: 'season',
        title: 'Season 2',
        season_number: 2,
        release_date: '2025-04-13',
        runtime_minutes: null,
        episode_count: 7,
        certification: null,
        parent: {
          id: 'series-1',
          title: 'The Last of Us',
          poster_path: null,
          backdrop_path: null,
          certification: 'TV-MA',
        },
      };
      beforeEach(() => {
        mockOpenId = 'season-2';
        tableRows.media_items = [season];
        mockFetchSeasonEpisodes.mockReset();
        mockFetchSeasonEpisodes.mockResolvedValue([
          {
            episode_number: 1,
            title: 'Future Days',
            air_date: '2025-04-13',
            runtime_minutes: 59,
            still_path: '/s1.jpg',
            overview: 'Five years after the events of the first season.',
          },
        ]);
      });

      it('reads Season 2 · 7 episodes · 2025, and never a runtime', async () => {
        const view = await renderWithProviders(<TitleScreen />);
        await waitFor(() => expect(view.getByTestId('title-meta')).toBeTruthy());

        expect(view.getByTestId('title-meta')).toHaveTextContent(
          /^Season 2 · 7 episodes · 2025 · TV-MA$/,
        );
        expect(view.getByTestId('title-meta')).not.toHaveTextContent(/min/);
      });

      it('leaves the count out, not invented, when TMDB has none', async () => {
        tableRows.media_items = [{ ...season, episode_count: null }];
        const view = await renderWithProviders(<TitleScreen />);
        await waitFor(() => expect(view.getByTestId('title-meta')).toBeTruthy());

        expect(view.getByTestId('title-meta')).toHaveTextContent(/^Season 2 · 2025 · TV-MA$/);
      });

      it('puts the rail under the Episodes heading, and the synopsis only in the sheet', async () => {
        const view = await renderWithProviders(<TitleScreen />);
        const section = await waitFor(() => view.getByTestId('immersive-section-episodes'));

        const rail = within(section).getByTestId('episode-rail');
        expect(rail.props.horizontal).toBe(true);
        // The heading sits above the rail's scroller, outside it, with the section's own
        // gap between them, so a fling on the rail cannot land on the heading.
        expect(within(rail).queryByText('Episodes')).toBeNull();
        expect(
          StyleSheet.flatten(view.getByTestId('immersive-body-episodes').props.style)
            .paddingTop,
        ).toBeGreaterThan(0);
        expect(view.queryByText('Five years after the events of the first season.')).toBeNull();

        await fireEvent.press(within(section).getByTestId('episode-card-1'));
        const sheet = within(view.getByTestId('episode-sheet'));
        expect(sheet.getByText('Season 2 · Episode 1')).toBeTruthy();
        expect(
          sheet.getByText('Five years after the events of the first season.'),
        ).toBeTruthy();
      });
    });

    it('reads the genres under the title and the year first in the metadata', async () => {
      const view = await open();
      await waitFor(() => expect(view.getByTestId('genre-line')).toBeTruthy());

      expect(view.getByTestId('genre-line-text')).toHaveTextContent('Science Fiction · Action');
      expect(view.getByTestId('title-meta')).toHaveTextContent(/^2010 · /);
      // Not repeated in About: the module is where the genres live now.
      expect(view.queryByTestId('genre-row')).toBeNull();
      const order = readingOrder(view.toJSON());
      expect(order.indexOf('Inception')).toBeLessThan(
        order.findIndex((t) => t.includes('Science Fiction')),
      );
    });

    it('states the title, the scores, Rank and the synopsis once each', async () => {
      tableRows.media_cache = [credits];
      const view = await open();
      await waitFor(() => expect(view.getByTestId('immersive-scores')).toBeTruthy());

      expect(view.getAllByTestId('title-name')).toHaveLength(1);
      expect(view.getAllByTestId('immersive-scores')).toHaveLength(1);
      expect(view.queryByTestId('scores-section')).toBeNull();
      expect(view.getAllByTestId('title-action-rank')).toHaveLength(1);
      expect(view.getAllByText(film.overview)).toHaveLength(1);
      // The three labels the brief names, inside the one module.
      // Compact since post-QA sprint 2: the rating count rides in the label.
      expect(view.getByTestId('immersive-score-you-label')).toHaveTextContent('Your score');
      expect(view.getByTestId('immersive-score-bingd-label')).toHaveTextContent(
        /^bingd( \(\d+\))?$/,
      );
      expect(view.getByTestId('immersive-score-following-label')).toHaveTextContent(
        /^Following( \(\d+\))?$/,
      );
    });

    it('says why a score is missing, and never draws an empty circle', async () => {
      const view = await open();
      await waitFor(() => expect(view.getByTestId('immersive-scores')).toBeTruthy());
      const scores = within(view.getByTestId('immersive-scores'));

      // A dash in each column; the reason is what each column says, not a wrapped line.
      expect(scores.getAllByText('—')).toHaveLength(3);
      expect(view.getByTestId('immersive-score-you').props.accessibilityLabel).toBe(
        'Your score. Not ranked yet',
      );
      await waitFor(() =>
        expect(view.getByTestId('immersive-score-bingd').props.accessibilityLabel).toMatch(
          /^bingd score\. Not enough ratings yet(\. \d+ ratings?)?$/,
        ),
      );
      expect(view.getByTestId('immersive-score-following').props.accessibilityLabel).toMatch(
        /^People you follow\. No ratings yet from people you follow(\. \d+ ratings?)?$/,
      );
      expect(scores.queryByText('Not ranked yet')).toBeNull();
      expect(scores.queryAllByLabelText(/out of 10/)).toHaveLength(0);
    });

    /**
     * **One column of sections and no tabs** (founder, title-page sprint, 2026-11-06): About,
     * Where to Watch, Cast, Reviews, Trailers, Details and Similar, each once, in that order.
     */
    it('lays the page out in the brief’s order, with no tabs', async () => {
      tableRows.media_cache = [credits, videos];
      const view = await open();
      await waitFor(() => expect(view.getByTestId('immersive-section-cast')).toBeTruthy());
      await waitFor(() => expect(view.getByTestId('immersive-section-trailers')).toBeTruthy());

      for (const key of ['about', 'cast', 'reviews', 'trailers', 'details', 'similar']) {
        expect(view.getAllByTestId(`immersive-section-${key}`)).toHaveLength(1);
      }
      expect(view.queryByTestId('immersive-tabs')).toBeNull();
      expect(view.queryAllByRole('tab')).toHaveLength(0);

      const order = readingOrder(view.toJSON());
      const at = (word: string) => order.indexOf(word);
      // Section headings print in capitals; the spoken name keeps the title's case.
      // Final title refinement (2026-11-06): Trailers before Reviews, Similar before the
      // details, which are a closed disclosure at the foot.
      const headings = ['ABOUT', 'CAST', 'TRAILERS', 'REVIEWS', 'SIMILAR', 'MORE DETAILS'];
      for (const heading of headings) expect(at(heading)).toBeGreaterThan(-1);
      for (let i = 1; i < headings.length; i++) {
        expect(at(headings[i - 1]!)).toBeLessThan(at(headings[i]!));
      }
      // The cast is on the page, not behind a tab.
      expect(view.getByText('Leonardo DiCaprio')).toBeTruthy();
    });

    it('says who directed a film in the module, once, and leaves it and the genres out of Details', async () => {
      tableRows.media_cache = [credits];
      const view = await open();
      const director = await waitFor(() => view.getByTestId('title-director'));
      await fireEvent.press(view.getByRole('button', { name: 'More details' }));

      expect(director).toHaveTextContent('Directed by Christopher Nolan');
      expect(
        within(view.getByTestId('immersive-module')).getByTestId('title-director'),
      ).toBeTruthy();
      // Under the metadata, and the genres above both.
      const order = readingOrder(view.toJSON());
      const at = (text: string) => order.findIndex((t) => t.includes(text));
      expect(at('Science Fiction')).toBeLessThan(at('2010 · '));
      expect(at('2010 · ')).toBeLessThan(at('Directed by'));
      // Details states what the module does not.
      const details = within(view.getByTestId('immersive-section-details'));
      // Labels print in capitals, so these match either case.
      expect(details.queryByText('Christopher Nolan')).toBeNull();
      expect(details.queryByText(/^director$/i)).toBeNull();
      expect(details.queryByText(/^genres$/i)).toBeNull();
      expect(details.getByText(/^released$/i)).toBeTruthy();
      expect(details.getByText(/^original language$/i)).toBeTruthy();
      expect(view.getAllByText(/Christopher Nolan/)).toHaveLength(1);
    });

    it('draws no director line when there is no Director credit', async () => {
      tableRows.media_cache = [
        {
          ...credits,
          payload: {
            ...credits.payload,
            crew: [
              {
                id: 1,
                name: 'An Assistant',
                job: 'First Assistant Director',
                department: 'Directing',
              },
            ],
          },
        },
      ];
      const view = await open();
      await waitFor(() => expect(view.getByTestId('immersive-section-cast')).toBeTruthy());
      expect(view.queryByTestId('title-director')).toBeNull();
      expect(view.queryByText(/Directed by/)).toBeNull();
    });

    /**
     * **Trailers ask before they load anything from YouTube** (title-page sprint,
     * 2026-11-06): a thumbnail is a request to `i.ytimg.com`. The Trailers tab only made
     * them once opened; the always-visible section makes them only after Show previews.
     */
    it('draws trailer cards without YouTube thumbnails until previews are asked for', async () => {
      tableRows.media_cache = [credits, videos];
      const view = await open();
      const section = await waitFor(() => view.getByTestId('immersive-section-trailers'));
      const ytimg = () => {
        const found: string[] = [];
        const walk = (node: unknown): void => {
          if (Array.isArray(node)) return node.forEach(walk);
          if (!node || typeof node !== 'object') return;
          const { props, children } = node as {
            props?: { source?: unknown };
            children?: unknown;
          };
          const source = props?.source as { uri?: string } | { uri?: string }[] | undefined;
          for (const item of Array.isArray(source) ? source : [source]) {
            if (item?.uri?.includes('ytimg')) found.push(item.uri);
          }
          walk(children);
        };
        walk(view.toJSON());
        return found;
      };

      expect(within(section).getAllByRole('link').length).toBeGreaterThan(0);
      expect(ytimg()).toEqual([]);

      await fireEvent.press(
        view.getByRole('button', { name: 'Show trailer previews. Loads images from YouTube.' }),
      );
      await waitFor(() => expect(ytimg().length).toBeGreaterThan(0));
      expect(view.queryByRole('button', { name: /Show trailer previews/ })).toBeNull();
    });

    /**
     * **At a large text size** (independent review 1): a section's action drops under its
     * heading rather than running off a 320pt screen — Show previews is the reader's one way
     * to ask for thumbnails — and the module's title grows only to the display ceiling.
     */
    it('lets a section action wrap under its heading, and caps the title at 1.3×', async () => {
      tableRows.media_cache = [credits, videos];
      const view = await open();
      const section = await waitFor(() => view.getByTestId('immersive-section-trailers'));

      const heading = within(section).getByLabelText('Trailers');
      expect(StyleSheet.flatten(heading.props.style)).toMatchObject({ flexWrap: 'wrap' });
      expect(view.getByTestId('title-name').props.maxFontSizeMultiplier).toBe(1.3);
      expect(view.getByTestId('title-director').props.numberOfLines).toBe(2);
    });

    it('opens a trailer on YouTube from its card, before or without previews', async () => {
      tableRows.media_cache = [credits, videos];
      const view = await open();
      const section = await waitFor(() => view.getByTestId('immersive-section-trailers'));
      const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

      await fireEvent.press(within(section).getAllByRole('link')[0]!);
      expect(openURL).toHaveBeenCalledWith(
        expect.stringMatching(/^https:\/\/(www\.)?youtube\.com\//),
      );
      openURL.mockRestore();
    });

    /**
     * **A video tile, not an empty box** (final title refinement, 2026-11-06): before
     * previews, while one loads and when YouTube has no still, each card is the same Ink
     * frame with its kind and a play button — never a blank rectangle.
     */
    describe('trailer tiles', () => {
      const twoVideos = {
        ...videos,
        payload: {
          results: [
            ...videos.payload.results,
            {
              id: 'v2',
              key: 'abcdefghijk',
              name: 'Teaser',
              type: 'Teaser',
              site: 'YouTube',
              official: true,
            },
          ],
        },
      };
      const tiles = (section: ReturnType<typeof within>) =>
        section.getAllByTestId('trailer-thumb');

      it('draws the stills with the page outside production, with no Show previews', async () => {
        mockPreviewsByDefault = true;
        tableRows.media_cache = [credits, twoVideos];
        const view = await open();
        const section = within(
          await waitFor(() => view.getByTestId('immersive-section-trailers')),
        );
        expect(section.getAllByTestId('trailer-still')).toHaveLength(2);
        expect(view.queryByRole('button', { name: /Show trailer previews/ })).toBeNull();
        // The frame, kind and link are unchanged under the still.
        expect(within(tiles(section)[1]!).getByText('Teaser')).toBeTruthy();
        expect(section.getAllByRole('link')).toHaveLength(2);
      });

      it('draws each trailer as a video frame with its kind, before any preview', async () => {
        tableRows.media_cache = [credits, twoVideos];
        const view = await open();
        const section = within(
          await waitFor(() => view.getByTestId('immersive-section-trailers')),
        );

        expect(tiles(section)).toHaveLength(2);
        for (const tile of tiles(section)) {
          expect(StyleSheet.flatten(tile.props.style).backgroundColor).toBe(brand.ink);
        }
        expect(within(tiles(section)[0]!).getByText('Trailer')).toBeTruthy();
        expect(within(tiles(section)[1]!).getByText('Teaser')).toBeTruthy();
        expect(section.queryAllByTestId('trailer-still')).toHaveLength(0);
        // Where it plays, under the name, once.
        expect(section.getAllByText('YouTube')).toHaveLength(2);
      });

      it('keeps the frame for a trailer whose still YouTube cannot serve', async () => {
        tableRows.media_cache = [credits, twoVideos];
        const view = await open();
        const section = within(
          await waitFor(() => view.getByTestId('immersive-section-trailers')),
        );
        await fireEvent.press(
          view.getByRole('button', {
            name: 'Show trailer previews. Loads images from YouTube.',
          }),
        );
        const stills = await waitFor(() => {
          const found = section.getAllByTestId('trailer-still');
          expect(found).toHaveLength(2);
          return found;
        });
        // The image mock hands its source on as a list.
        expect([stills[0]!.props.source].flat()[0]).toMatchObject({
          uri: 'https://i.ytimg.com/vi/YoHD9XEInc0/hqdefault.jpg',
        });

        await act(async () =>
          stills[1]!.props.onError?.({ nativeEvent: { error: 'HTTP 404' } }),
        );

        expect(section.getAllByTestId('trailer-still')).toHaveLength(1);
        // The failed card is still the frame, its kind and its link.
        expect(within(tiles(section)[1]!).getByText('Teaser')).toBeTruthy();
        expect(section.getAllByRole('link')).toHaveLength(2);
      });

      /**
       * **YouTube's placeholder is not a still** (marquee cohesion sprint, measured against
       * the real host): a removed video answers 404 with a grey 120×90 image, which a client
       * that decodes it would draw as a grey logo. A real still is 480 wide.
       */
      it('keeps the frame when YouTube answers with its small placeholder image', async () => {
        tableRows.media_cache = [credits, twoVideos];
        const view = await open();
        const section = within(
          await waitFor(() => view.getByTestId('immersive-section-trailers')),
        );
        await fireEvent.press(
          view.getByRole('button', {
            name: 'Show trailer previews. Loads images from YouTube.',
          }),
        );
        const stills = await waitFor(() => {
          const found = section.getAllByTestId('trailer-still');
          expect(found).toHaveLength(2);
          return found;
        });

        // Decoded at YouTube's size, so the width is the image's and not the card's.
        expect(stills[0]!.props.allowDownscaling).toBe(false);
        await act(async () =>
          stills[0]!.props.onLoad?.({
            nativeEvent: { source: { width: 480, height: 360, url: 'real' } },
          }),
        );
        await act(async () =>
          stills[1]!.props.onLoad?.({
            nativeEvent: { source: { width: 120, height: 90, url: 'placeholder' } },
          }),
        );

        expect(section.getAllByTestId('trailer-still')).toHaveLength(1);
        expect(within(tiles(section)[1]!).getByText('Teaser')).toBeTruthy();
        expect(section.getAllByRole('link')).toHaveLength(2);
      });
    });

    /**
     * **More details, closed** (final title refinement, 2026-11-06): the facts the module
     * does not state, behind one disclosure at the foot of the page, after Similar.
     */
    it('keeps the details behind a closed More details until asked for', async () => {
      tableRows.media_cache = [credits];
      const view = await open();
      const toggle = await waitFor(() => view.getByRole('button', { name: 'More details' }));

      expect(toggle.props.accessibilityState).toMatchObject({ expanded: false });
      expect(view.queryByTestId('more-details')).toBeNull();

      await fireEvent.press(toggle);

      expect(
        view.getByRole('button', { name: 'More details' }).props.accessibilityState,
      ).toMatchObject({
        expanded: true,
      });
      const facts = within(view.getByTestId('more-details'));
      expect(facts.getByLabelText(/^Released: /)).toBeTruthy();
      expect(facts.getByLabelText(/^Original language: /)).toBeTruthy();
      // A film's runtime is already on the module's metadata line.
      expect(facts.queryByLabelText(/^Runtime: /)).toBeNull();

      await fireEvent.press(view.getByRole('button', { name: 'More details' }));
      expect(view.queryByTestId('more-details')).toBeNull();
    });

    /**
     * **Efficient vertically** (final title refinement, 2026-11-06): a section heading is its
     * own line rather than a 44pt row. The synopsis starts 4pt under ABOUT, because two
     * lines of text add their own leading; everything else 8pt, less a rail's own padding.
     */
    it('sets each section heading on its own line, the body just under it', async () => {
      tableRows.media_cache = [credits];
      const view = await open();
      const about = await waitFor(() => view.getByTestId('immersive-section-about'));
      const body = (key: string) =>
        StyleSheet.flatten(view.getByTestId(`immersive-body-${key}`).props.style);

      expect(
        StyleSheet.flatten(within(about).getByLabelText('About').props.style).minHeight,
      ).toBe(0);
      expect(body('about')).toMatchObject({ paddingTop: 4 });
      expect(body('similar')).toMatchObject({ paddingTop: 8 });
      // A rail's space is outside its scroll view, where See all's slop can use it without
      // a coasting rail taking the press (independent review 2).
      await waitFor(() => expect(view.getByTestId('immersive-body-cast')).toBeTruthy());
      expect(body('cast')).toMatchObject({ paddingTop: 8 });
      const strip = view.getByTestId('cast-strip');
      expect(StyleSheet.flatten(strip.props.contentContainerStyle)).toMatchObject({
        paddingVertical: 0,
      });
    });

    /**
     * **Where to Watch keeps to its own space** (independent review 1): its seam (28pt since the
     * marquee cohesion sprint, the same as every section's) is its
     * own row's top padding. It was a negative margin, which laid the row's Pressable over
     * the synopsis above it and its More control.
     */
    it('spaces Where to Watch inside its own row, never over the synopsis', async () => {
      mockFetchWatchProviders.mockResolvedValue({
        region: 'US',
        link: null,
        providers: [
          { provider_id: 8, name: 'Netflix', logo_path: '/n.jpg', offers: ['stream'] },
        ],
      });
      tableRows.media_cache = [credits];
      const view = await open();
      const row = await waitFor(() => view.getByTestId('where-to-watch'));

      expect(StyleSheet.flatten(row.props.style)).toMatchObject({ paddingTop: 28 });
      // Every section sits 28pt below the one before it.
      expect(
        StyleSheet.flatten(view.getByTestId('immersive-section-cast').props.style).paddingTop,
      ).toBe(28);
      // Nothing between the row and the page pulls it upward.
      let node = row.parent;
      while (node && node.props?.testID !== 'immersive-section-cast') {
        const style = StyleSheet.flatten(node.props?.style) ?? {};
        expect(Number(style.marginTop ?? 0)).toBeGreaterThanOrEqual(0);
        node = node.parent;
        if (node?.props?.testID === 'immersive-hero') break;
      }
    });

    it('ranks an unranked title from Rank, through the log sheet', async () => {
      const view = await open();
      await waitFor(() => expect(view.getByTestId('title-action-rank')).toBeTruthy());

      await fireEvent.press(view.getByTestId('title-action-rank'));

      await waitFor(() => expect(view.getByLabelText('How was it?')).toBeTruthy());
    });

    /**
     * **Rank and Log rewatch are never cut** (UI cohesion pass, 2026-11-06): in the card the
     * control may take the row's full width and the icons wrap, at any text size; the
     * original page's narrow column keeps its ceiling.
     */
    it('keeps Log rewatch and the icons on one row, fitting the word rather than cutting it', async () => {
      ranked();
      const view = await open();
      const control = await waitFor(() => view.getByTestId('title-action-ranked'));
      const style = StyleSheet.flatten(
        typeof control.props.style === 'function'
          ? control.props.style({ pressed: false })
          : control.props.style,
      );
      expect(style.maxWidth).toBe('100%');
      // It gives width back to the icons beside it (2026-11-14): one row, never two.
      expect(style.flexShrink).toBe(1);
      expect(StyleSheet.flatten(view.getByTestId('title-actions').props.style).flexWrap).toBe(
        'nowrap',
      );
      // One line, never cut: past 1.5x text the word fits itself to the row.
      const label = within(control).getByText('Log rewatch');
      expect(label.props.numberOfLines).toBe(1);
      expect(label.props.adjustsFontSizeToFit).toBe(true);
      expect(label.props.maxFontSizeMultiplier).toBe(1.5);
      const cluster = within(view.getByTestId('title-actions'));
      for (const id of ['title-action-save', 'title-action-list', 'title-action-recommend']) {
        expect(cluster.getByTestId(id)).toBeTruthy();
      }
    });

    /**
     * **Log rewatch, in place of Edit ranking** (founder, 2026-11-10). The ranked title's
     * primary action is another viewing: the existing *Log another watch* sheet, opened
     * directly, with no chooser between log and edit. *Edit ranking* stays in ⋯.
     */
    describe('Log rewatch on a ranked title', () => {
      const rewatchCalls = () =>
        mockRpc.mock.calls.filter(([name]: [string]) => name === 'log_rewatch_with_details');
      const againCalls = () =>
        mockRpc.mock.calls.filter(([name]: [string]) => name === 'rank_again');

      it('reads Log rewatch with the repeat icon, and no second Rank', async () => {
        ranked();
        const view = await open();
        const control = await waitFor(() => view.getByTestId('title-action-ranked'));

        expect(within(control).getByText('Log rewatch')).toBeTruthy();
        expect(within(control).queryByText('Edit ranking')).toBeNull();
        // An Ionicon renders as its glyph, so the icon is asserted by its character.
        const glyph = (name: keyof typeof Ionicons.glyphMap) =>
          String.fromCodePoint(Ionicons.glyphMap[name] as number);
        expect(within(control).getByText(glyph('repeat-outline'))).toBeTruthy();
        expect(within(control).queryByText(glyph('create-outline'))).toBeNull();
        expect(control.props.accessibilityLabel).toBe('Log a rewatch of Inception');
        expect(control.props.accessibilityHint).toBe('Opens a sheet to record another viewing');
        expect(view.queryByTestId('title-action-rank')).toBeNull();
        // The reader's own score is the prominent one, stated once.
        await waitFor(() => expect(view.getAllByLabelText('10.0 out of 10')).toHaveLength(1));
      });

      it('opens the rewatch sheet directly, and records nothing by opening it', async () => {
        ranked();
        const view = await open();
        await fireEvent.press(await waitFor(() => view.getByTestId('title-action-ranked')));

        await waitFor(() => expect(view.getByTestId('rewatch-bucket-choices')).toBeTruthy());
        expect(view.getByLabelText('Log another watch of Inception')).toBeTruthy();
        // Not the rating sheet, and no menu or chooser in between.
        expect(view.queryByLabelText('Edit ranking')).toBeNull();
        expect(view.queryByLabelText('Options for Inception')).toBeNull();
        expect(rewatchCalls()).toHaveLength(0);
        expect(againCalls()).toHaveLength(0);
      });

      it('does the same for a ranked season', async () => {
        mockOpenId = 'season-1';
        tableRows.media_items = [
          {
            ...film,
            id: 'season-1',
            kind: 'season',
            title: 'Season 1',
            release_date: '2023-04-01',
            runtime_minutes: null,
            parent: {
              id: 'series-1',
              title: 'Breaking Bad',
              poster_path: null,
              backdrop_path: null,
            },
          },
        ];
        tableRows.rankings = [
          {
            user_id: 'user-1',
            media_item_id: 'season-1',
            position: 1,
            category: 'tv_seasons',
            bucket: 'loved',
          },
        ];
        tableRows.user_media = [
          {
            user_id: 'user-1',
            media_item_id: 'season-1',
            bucket: 'loved',
            watched_on: null,
            note: null,
          },
        ];
        const view = await renderWithProviders(<TitleScreen />);
        const control = await waitFor(() => view.getByTestId('title-action-ranked'));
        expect(within(control).getByText('Log rewatch')).toBeTruthy();

        await fireEvent.press(control);
        await waitFor(() => expect(view.getByTestId('rewatch-bucket-choices')).toBeTruthy());
        expect(rewatchCalls()).toHaveLength(0);
      });

      it('records no watch when the sheet is closed', async () => {
        ranked();
        const view = await open();
        await fireEvent.press(await waitFor(() => view.getByTestId('title-action-ranked')));
        await waitFor(() => expect(view.getByTestId('rewatch-bucket-choices')).toBeTruthy());

        await fireEvent.press(view.getByRole('button', { name: 'Close' }));

        await waitFor(() => expect(view.queryByTestId('rewatch-bucket-choices')).toBeNull());
        expect(rewatchCalls()).toHaveLength(0);
        expect(againCalls()).toHaveLength(0);
        expect(
          within(view.getByTestId('title-action-ranked')).getByText('Log rewatch'),
        ).toBeTruthy();
      });

      it('saves exactly one viewing, then re-checks on that viewing rather than a new one', async () => {
        mockRpcResults.log_rewatch_with_details = { status: 'ok', watch_event_id: 'event-2' };
        ranked();
        const view = await open();
        await fireEvent.press(await waitFor(() => view.getByTestId('title-action-ranked')));
        await waitFor(() => expect(view.getByTestId('rewatch-bucket-choices')).toBeTruthy());

        await fireEvent.press(view.getByText('I liked it'));

        await waitFor(() => expect(againCalls()).toHaveLength(1));
        expect(rewatchCalls()).toHaveLength(1);
        // The comparisons are tied to the viewing just saved, so finishing them enriches
        // that one activity rather than writing a second (§K).
        expect(againCalls()[0]![1]).toEqual(
          expect.objectContaining({ p_bucket: 'loved', p_watch_event_id: 'event-2' }),
        );
        // Nothing else that records a viewing, or moves the ranking outside the session.
        for (const name of [
          'log_rewatch',
          'log_title',
          'set_watch_date',
          'rank_rebucket',
          'rank_unrank',
        ]) {
          expect(mockRpc).not.toHaveBeenCalledWith(name, expect.anything());
        }
      });

      /**
       * **A second press while the sheet is still leaving does nothing** (cross-PR review,
       * 2026-11-11). On iOS the sheet slides away after a band is chosen and only then
       * hands over to the comparisons (`onDismissed`). Log rewatch is on the page rather
       * than in the menu; if a press ever reached it in that gap, it would present the
       * sheet again mid-dismissal and drop the re-check. Defence in depth.
       */
      it('ignores Log rewatch while the sheet is still leaving, and the re-check still opens', async () => {
        type Held = { hold: boolean; pending: (() => void)[] };
        const { __modalDismissals: dismissals, __modalShows: shows } =
          globalThis as unknown as {
            __modalDismissals: Held;
            __modalShows: Held;
          };
        mockRpcResults.log_rewatch_with_details = { status: 'ok', watch_event_id: 'event-2' };
        ranked();
        const view = await open();
        await fireEvent.press(await waitFor(() => view.getByTestId('title-action-ranked')));
        await waitFor(() => expect(view.getByTestId('rewatch-bucket-choices')).toBeTruthy());

        dismissals.hold = true;
        await fireEvent.press(view.getByText('I liked it'));
        await waitFor(() => expect(rewatchCalls()).toHaveLength(1));
        await waitFor(() => expect(dismissals.pending.length).toBeGreaterThan(0));
        // Inside the slide-out: the comparisons have not opened yet.
        expect(againCalls()).toHaveLength(0);

        // The page counts as covered while the sheet is still presented — as UIKit, which
        // normally ignores touches during the transition — so the press is made on the
        // hidden control on purpose: this guards the state, not the platform.
        shows.hold = true;
        await fireEvent.press(
          view.getByTestId('title-action-ranked', { includeHiddenElements: true }),
        );
        // No presentation was issued over the dismissing sheet.
        expect(shows.pending).toHaveLength(0);
        shows.hold = false;

        dismissals.hold = false;
        await act(async () => {
          for (const finish of dismissals.pending.splice(0)) finish();
        });
        // The re-check still opens, on the viewing just saved, and only one viewing exists.
        await waitFor(() => expect(againCalls()).toHaveLength(1));
        expect(againCalls()[0]![1]).toEqual(
          expect.objectContaining({ p_watch_event_id: 'event-2' }),
        );
        expect(rewatchCalls()).toHaveLength(1);
      });

      it('keeps Edit ranking in the menu, as a correction that records no watch', async () => {
        ranked();
        const view = await open();
        await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
        await fireEvent.press(view.getByTestId('title-more'));
        await waitFor(() => expect(view.getByLabelText('Edit ranking')).toBeTruthy());
        expect(view.getByLabelText('Log another watch')).toBeTruthy();

        await fireEvent.press(view.getByLabelText('Edit ranking'));
        await waitFor(() => expect(view.getByText('I liked it')).toBeTruthy());
        await fireEvent.press(view.getByText('I liked it'));

        await waitFor(() => expect(againCalls()).toHaveLength(1));
        expect(againCalls()[0]![1]).toEqual(expect.objectContaining({ p_new_watch: false }));
        expect(rewatchCalls()).toHaveLength(0);
      });

      /**
       * **No second, prominent Edit ranking** (founder decision, 2026-11-11). Log rewatch is
       * the page's one ranking control; correcting the ranking stays where it was — ⋯ →
       * *Edit ranking* on this page, and the same *Edit ranking* in an expanded watch on
       * Watch History (#258), which this page's Watch history row opens. One label for the
       * one correction since 2026-11-11 (it read *Update your rating* in ⋯ before).
       */
      it('draws no Edit ranking control on the page: the correction is in ⋯ and Watch History', async () => {
        ranked();
        tableRows.watch_events = [
          { id: 'w1', media_item_id: 'film-1', user_id: 'user-1' },
          { id: 'w2', media_item_id: 'film-1', user_id: 'user-1' },
        ];
        const view = await open();
        const control = await waitFor(() => view.getByTestId('title-action-ranked'));
        expect(within(control).getByText('Log rewatch')).toBeTruthy();

        // Nothing on the page itself offers to edit the ranking: no button, no label, no
        // second ranking control beside Log rewatch.
        expect(view.queryAllByText(/Edit ranking/i)).toHaveLength(0);
        expect(view.queryAllByLabelText(/Edit (your )?ranking/i)).toHaveLength(0);
        expect(view.queryByLabelText('Edit ranking')).toBeNull();
        expect(view.queryByTestId('title-action-rank')).toBeNull();
        expect(view.getAllByTestId('title-action-ranked')).toHaveLength(1);

        // The way to it: ⋯ holds the correction, beside Log another watch.
        await fireEvent.press(view.getByTestId('title-more'));
        await waitFor(() => expect(view.getByLabelText('Edit ranking')).toBeTruthy());
        expect(view.getByLabelText('Log another watch')).toBeTruthy();
        expect(rewatchCalls()).toHaveLength(0);
        expect(againCalls()).toHaveLength(0);
      });

      /**
       * The same decision checked by behaviour rather than by wording (independent review):
       * whatever a control is called, none on the page opens the rating sheet — the
       * correction's band chooser — or writes a ranking. Each button is pressed on a fresh
       * page. Only ⋯'s own rows do that, and they are not on the page until ⋯ is opened.
       */
      it('has no control outside ⋯ that opens the ranking correction, whatever it is called', async () => {
        const correctionWrites = () =>
          mockRpc.mock.calls.filter(([name]: [string]) =>
            ['rank_again', 'rank_rebucket', 'set_bucket'].includes(name),
          );
        ranked();
        const first = await open();
        await waitFor(() => expect(first.getByTestId('title-action-ranked')).toBeTruthy());
        // The cluster is exactly Log rewatch and the three icon controls.
        const cluster = within(first.getByTestId('title-actions'));
        expect(
          cluster
            .getAllByRole('button')
            .map((node) => node.props.testID as string | undefined)
            .filter(Boolean)
            .sort(),
        ).toEqual(
          [
            'title-action-list',
            'title-action-ranked',
            'title-action-recommend',
            'title-action-save',
          ].sort(),
        );
        const count = first.getAllByRole('button').length;
        expect(count).toBeGreaterThan(3);
        await first.unmount();

        /**
         * A control's name, the way a screen reader reads it: its label, or the words
         * inside it — the app's own `Button` names itself by its text and sets no label,
         * so a label-only list would never press one (independent review).
         */
        const nameOf = (node: ReturnType<typeof first.getByTestId>) =>
          (node.props.accessibilityLabel as string | undefined) ??
          within(node)
            .queryAllByText(/\S/)
            .map((text) => String(text.props.children))
            .join(' ');
        // Back only leaves the page (and this file's router stand-in has no `back`).
        // *Write a review* (Reviews) is the one existing door into the same log sheet: it
        // opens on the review composer, for the reader's note, and is on main unchanged —
        // a writing control, not a ranking one. Anything else that opens the sheet fails.
        const allowed = new Set(['Back', 'Write a review']);

        // Every button, by position, each on a fresh page.
        for (let index = 0; index < count; index += 1) {
          mockRpc.mockClear();
          ranked();
          const view = await open();
          await waitFor(() => expect(view.getByTestId('title-action-ranked')).toBeTruthy());
          const buttons = view.getAllByRole('button');
          // The same page each time, so the same button is at the same position.
          expect(buttons).toHaveLength(count);
          const name = nameOf(buttons[index]!);
          if (!allowed.has(name)) {
            await fireEvent.press(buttons[index]!);
            // The correction's band chooser never opens, and nothing is re-ranked.
            expect({ name, chooser: view.queryAllByLabelText('How was it?').length }).toEqual({
              name,
              chooser: 0,
            });
            expect({ name, writes: correctionWrites().length }).toEqual({ name, writes: 0 });
          }
          await view.unmount();
        }
      });

      it('opens Watch History from its row (where #258 puts Edit ranking in an expanded watch)', async () => {
        ranked();
        tableRows.watch_events = [
          { id: 'w1', media_item_id: 'film-1', user_id: 'user-1' },
          { id: 'w2', media_item_id: 'film-1', user_id: 'user-1' },
        ];
        const view = await open();
        await waitFor(() => expect(view.getByTestId('title-action-ranked')).toBeTruthy());
        const row = await waitFor(() => view.getByRole('button', { name: 'Watch history' }));
        await fireEvent.press(row);
        expect(mockPush).toHaveBeenCalledWith('/title/film-1/history');
        expect(rewatchCalls()).toHaveLength(0);
        expect(againCalls()).toHaveLength(0);
      });
    });

    it('still resumes an unfinished ranking from Rank', async () => {
      tableRows.user_media = [
        {
          user_id: 'user-1',
          media_item_id: 'film-1',
          bucket: 'fine',
          watched_on: null,
          note: null,
          note_visibility: 'private',
          note_has_spoilers: false,
        },
      ];
      const view = await open();
      const control = await waitFor(() => view.getByTestId('title-action-rank'));
      expect(within(control).getByText('Rank Movie')).toBeTruthy();
      expect(view.queryByText('Log rewatch')).toBeNull();

      await fireEvent.press(control);
      await waitFor(() =>
        expect(mockRpc).toHaveBeenCalledWith(
          'rank_start',
          expect.objectContaining({ p_media_item_id: 'film-1', p_bucket: 'fine' }),
        ),
      );
      expect(view.queryByTestId('rewatch-bucket-choices')).toBeNull();
    });

    it('saves to the watchlist from the bookmark', async () => {
      const view = await open();
      await waitFor(() => expect(view.getByTestId('title-action-save')).toBeTruthy());

      await fireEvent.press(view.getByTestId('title-action-save'));

      await waitFor(() =>
        expect(mockRpc).toHaveBeenCalledWith(
          'set_watchlist',
          expect.objectContaining({ p_present: true }),
        ),
      );
    });

    it('opens Add to list and Recommend from the same cluster', async () => {
      const view = await open();
      await waitFor(() => expect(view.getByTestId('title-action-list')).toBeTruthy());

      await fireEvent.press(view.getByTestId('title-action-list'));
      await waitFor(() => expect(view.getByLabelText('New list')).toBeTruthy());
    });

    it('opens the recommendation sheet from Share', async () => {
      const view = await open();
      await waitFor(() =>
        expect(view.getByLabelText('Recommend Inception to a friend')).toBeTruthy(),
      );

      await fireEvent.press(view.getByLabelText('Recommend Inception to a friend'));
      await waitFor(() => expect(view.getByText('Recommend Inception')).toBeTruthy());
    });

    /**
     * **Reviews after Cast, every review in a sheet** (post-QA sprint 2, 2026-11-05).
     *
     * The page shows one or two — yours first — and See all opens the full list in a
     * sheet, where the order, Helpful, spoilers and reporting live. The Reviews tab and
     * the "From your circle" line are gone; Following is a filter inside the sheet.
     */
    describe('reviews after Cast', () => {
      const withNote = (visibility: 'public' | 'private', note = 'My own words on it.') => {
        ranked();
        tableRows.user_media = [
          {
            user_id: 'user-1',
            media_item_id: 'film-1',
            bucket: 'loved',
            watched_on: '2026-08-12',
            note,
            note_visibility: visibility,
            note_has_spoilers: false,
            note_updated_at: '2026-10-02T10:00:00.000Z',
          },
        ];
      };
      const sheetOf = async (view: Awaited<ReturnType<typeof open>>) => {
        await fireEvent.press(
          await waitFor(() =>
            view.getByRole('button', { name: /^See all \d+ reviews$|^See the review$/ }),
          ),
        );
        return within(await waitFor(() => view.getByTestId('reviews-sheet-list')));
      };
      const sortTab = (sheet: ReturnType<typeof within>, name: string | RegExp) =>
        sheet.getByRole('tab', { name });
      const reviewsCalledWith = (sort: string) =>
        mockRpc.mock.calls.some(
          ([name, args]) =>
            name === 'title_reviews_v2' && (args as { p_sort?: string }).p_sort === sort,
        );

      it('previews the two most helpful under the Cast, three lines each', async () => {
        tableRows.media_cache = [credits];
        mockRpcResults.title_reviews_v2 = [reviewBy(1), reviewBy(2), reviewBy(3)];
        mockRpcResults.title_review_count = 3;
        const view = await open();
        const preview = within(await waitFor(() => view.getByTestId('reviews-preview')));
        await waitFor(() => expect(preview.getByText('Review number 1.')).toBeTruthy());

        expect(preview.getByText('Review number 2.')).toBeTruthy();
        expect(preview.queryByText('Review number 3.')).toBeNull();
        expect(preview.getAllByTestId('review-preview')).toHaveLength(2);
        // Read as the Most Helpful list, at the server's ceiling.
        expect(mockRpc).toHaveBeenCalledWith(
          'title_reviews_v2',
          expect.objectContaining({ p_sort: 'top_desc', p_limit: 100 }),
        );
        // Reviews sits after the Cast, and before Similar and the details.
        const order = readingOrder(view.toJSON());
        expect(order.indexOf('CAST')).toBeLessThan(order.indexOf('REVIEWS'));
        expect(order.indexOf('REVIEWS')).toBeLessThan(order.indexOf('SIMILAR'));
        expect(order.indexOf('SIMILAR')).toBeLessThan(order.indexOf('MORE DETAILS'));
        expect(view.getByRole('button', { name: 'See all 3 reviews' })).toBeTruthy();
      });

      it('leads with your published review and its Edit, then one other', async () => {
        withNote('public');
        mockRpcResults.title_reviews_v2 = [
          reviewBy(1),
          {
            ...reviewBy(9),
            user_id: 'user-1',
            note: 'My own words on it.',
            display_name: 'Sai',
          },
          reviewBy(2),
        ];
        mockRpcResults.title_review_count = 3;
        const view = await open();
        const preview = within(await waitFor(() => view.getByTestId('reviews-preview')));
        const mine = await waitFor(() => preview.getByTestId('your-review'));

        expect(within(mine).getByText(/Your review/)).toBeTruthy();
        expect(preview.getAllByText('My own words on it.')).toHaveLength(1);
        expect(preview.getAllByTestId('review-preview')).toHaveLength(1);
        expect(preview.getByText('Review number 1.')).toBeTruthy();
        expect(preview.queryByText('Review number 2.')).toBeNull();
        const order = readingOrder(view.toJSON());
        expect(order.indexOf('My own words on it.')).toBeLessThan(
          order.indexOf('Review number 1.'),
        );
        // No score circle on your own review.
        expect(within(mine).queryAllByLabelText(/out of 10/)).toHaveLength(0);

        await fireEvent.press(within(mine).getByTestId('edit-review'));
        await waitFor(() => expect(view.getByLabelText('How was it?')).toBeTruthy());
      });

      it('never shows a private note as a review, anywhere', async () => {
        withNote('private', 'Only for me.');
        mockRpcResults.title_reviews_v2 = [reviewBy(1)];
        mockRpcResults.title_review_count = 1;
        const view = await open();
        await waitFor(() => expect(view.getByText('Review number 1.')).toBeTruthy());

        expect(view.queryByTestId('your-review')).toBeNull();
        expect(view.queryByText('Only for me.')).toBeNull();
        const sheet = await sheetOf(view);
        expect(sheet.queryByText('Only for me.')).toBeNull();
        expect(sheet.queryByTestId('your-review')).toBeNull();
      });

      it('masks a spoiler review in the preview for a reader who has not seen it', async () => {
        mockRpcResults.title_reviews_v2 = [
          { ...reviewBy(7), note: 'The top keeps spinning.', has_spoilers: true },
        ];
        mockRpcResults.title_review_count = 1;
        const view = await open();
        const row = await waitFor(() => view.getByTestId('review-preview'));
        expect(within(row).queryByText(/The top keeps spinning/)).toBeNull();
        expect(row.props.accessibilityLabel).toMatch(/Contains spoilers$/);
        expect(row.props.accessibilityLabel).not.toMatch(/spinning/);
      });

      it('says No reviews yet, with a compact Write a review for a ranked reader', async () => {
        ranked();
        mockRpcResults.title_reviews_v2 = [];
        mockRpcResults.title_review_count = 0;
        const view = await open();
        const empty = await waitFor(() => view.getByTestId('reviews-preview-empty'));
        expect(within(empty).getByText('No reviews yet')).toBeTruthy();
        expect(within(empty).getByRole('button', { name: 'Write a review' })).toBeTruthy();
        // Nothing to see all of.
        expect(view.queryByRole('button', { name: /^See all/ })).toBeNull();

        await fireEvent.press(within(empty).getByRole('button', { name: 'Write a review' }));
        await waitFor(() => expect(view.getByLabelText('How was it?')).toBeTruthy());
      });

      it('asks an unranked reader to rank first', async () => {
        mockRpcResults.title_reviews_v2 = [];
        mockRpcResults.title_review_count = 0;
        const view = await open();
        await waitFor(() =>
          expect(view.getByRole('button', { name: 'Rank to leave a review' })).toBeTruthy(),
        );
        expect(view.queryByTestId('your-review')).toBeNull();
      });

      it('draws no "From your circle" line any more', async () => {
        mockRpcResults.title_reviews_v2 = [reviewBy(7)];
        mockRpcResults.title_review_count = 1;
        const view = await open();
        await waitFor(() => expect(view.getByTestId('reviews-preview')).toBeTruthy());
        expect(view.queryByTestId('immersive-circle')).toBeNull();
        expect(reviewsCalledWith('following')).toBe(false);
      });

      it('lists every review in the sheet, once, Most Helpful first, and closes on Close', async () => {
        mockRpcResults.title_reviews_v2 = [reviewBy(1), reviewBy(2), reviewBy(3)];
        mockRpcResults.title_review_count = 3;
        const view = await open();
        const sheet = await sheetOf(view);

        for (const n of [1, 2, 3]) {
          expect(sheet.getAllByText(`Review number ${n}.`)).toHaveLength(1);
        }
        expect(sortTab(sheet, 'Most helpful first')).toBeSelected();
        // Helpful is the review's one reaction: a thumbs-up, and no heart beside it.
        expect(sheet.getByLabelText(/^Mark Reader 1's review helpful/)).toBeTruthy();
        expect(sheet.getByLabelText("Report Reader 1's review")).toBeTruthy();

        await fireEvent.press(view.getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(view.queryByTestId('reviews-sheet')).toBeNull());
      });

      it('marks a review helpful from the sheet, on the real vote', async () => {
        mockRpcResults.title_reviews_v2 = [reviewBy(1), reviewBy(2)];
        mockRpcResults.title_review_count = 2;
        mockRpcResults.set_review_helpful = { helpful_count: 1, viewer_helpful: true };
        const view = await open();
        const sheet = await sheetOf(view);

        await fireEvent.press(sheet.getByLabelText(/^Mark Reader 2's review helpful/));
        await waitFor(() =>
          expect(mockRpc).toHaveBeenCalledWith(
            'set_review_helpful',
            expect.objectContaining({ p_review_id: 'um-2', p_helpful: true }),
          ),
        );
      });

      it('orders by Newest on the server, and Oldest on a second tap', async () => {
        mockRpcResults.title_reviews_v2 = [reviewBy(1), reviewBy(2)];
        mockRpcResults.title_review_count = 2;
        const view = await open();
        const sheet = await sheetOf(view);

        await fireEvent.press(sortTab(sheet, 'Newest'));
        await waitFor(() => expect(reviewsCalledWith('recent_desc')).toBe(true), {
          timeout: 4000,
        });
        await fireEvent.press(sortTab(sheet, 'Newest first'));
        await waitFor(() => expect(reviewsCalledWith('recent_asc')).toBe(true), {
          timeout: 4000,
        });
        expect(sortTab(sheet, 'Oldest first')).toBeSelected();
      });

      it('orders by Rating over the complete list, highest first, then lowest', async () => {
        mockRpcResults.title_reviews_v2 = [
          { ...reviewBy(1), score: '6.1' },
          { ...reviewBy(2), score: '9.4' },
          { ...reviewBy(3), score: null },
          { ...reviewBy(4), score: '7.7' },
        ];
        mockRpcResults.title_review_count = 4;
        const view = await open();
        const sheet = await sheetOf(view);
        const calls = mockRpc.mock.calls.length;

        await fireEvent.press(sortTab(sheet, 'Rating'));
        // An instance tree names each string at its composite and its host; once each.
        const shown = () => [
          ...new Set(
            readingOrder(view.getByTestId('reviews-sheet-list')).filter((t) =>
              /^Review number \d\.$/.test(t),
            ),
          ),
        ];
        await waitFor(() =>
          expect(shown()).toEqual([
            'Review number 2.',
            'Review number 4.',
            'Review number 1.',
            'Review number 3.',
          ]),
        );
        // Re-ordered from the list already read: no new order was asked of the server.
        expect(
          mockRpc.mock.calls
            .slice(calls)
            .filter(([name]) => name === 'title_reviews_v2')
            .every(([, args]) => (args as { p_sort: string }).p_sort === 'top_desc'),
        ).toBe(true);

        await fireEvent.press(sortTab(sheet, 'Highest rated first'));
        // Lowest first; a review with no score stays last either way.
        await waitFor(() =>
          expect(shown()).toEqual([
            'Review number 1.',
            'Review number 4.',
            'Review number 2.',
            'Review number 3.',
          ]),
        );
      });

      it('never offers Rating over a list the server may have cut short', async () => {
        mockRpcResults.title_reviews_v2 = Array.from({ length: 100 }, (_, n) =>
          reviewBy(n + 1),
        );
        mockRpcResults.title_review_count = 140;
        const view = await open();
        const sheet = await sheetOf(view);

        expect(sheet.queryByRole('tab', { name: 'Rating' })).toBeNull();
        expect(sheet.getByTestId('reviews-truncated')).toHaveTextContent(
          'Showing the first 100 reviews in this order.',
        );
      });

      it('falls back to Most Helpful, label and rows alike, when Rating stops being honest', async () => {
        // Independent review, post-QA sprint 2: Rating chosen over 99 reviews, then a
        // refetch (after a vote) returns the 100-row ceiling. The sheet must not keep a
        // Rating label over a Helpful list.
        let full = false;
        const ninetyNine = Array.from({ length: 99 }, (_, n) => ({
          ...reviewBy(n + 1),
          score: String((n % 9) + 1),
        }));
        mockRpcResults.title_reviews_v2 = () =>
          full ? [...ninetyNine, { ...reviewBy(100), score: '9.9' }] : ninetyNine;
        mockRpcResults.title_review_count = 99;
        mockRpcResults.set_review_helpful = { helpful_count: 1, viewer_helpful: true };
        const view = await open();
        const sheet = await sheetOf(view);

        await fireEvent.press(sortTab(sheet, 'Rating'));
        await waitFor(() => expect(sortTab(sheet, 'Highest rated first')).toBeSelected());

        full = true;
        await fireEvent.press(sheet.getByLabelText(/^Mark Reader 1's review helpful/));
        await waitFor(
          () => expect(sheet.queryByRole('tab', { name: /Rating|rated/ })).toBeNull(),
          {
            timeout: 4000,
          },
        );
        expect(sortTab(sheet, 'Most helpful first')).toBeSelected();
        expect(sheet.getByTestId('reviews-truncated')).toBeTruthy();
      });

      it('keeps Following as a filter inside the sheet', async () => {
        mockRpcResults.title_reviews_v2 = (args: { p_sort: string }) =>
          args.p_sort === 'following' ? [reviewBy(7)] : [reviewBy(1), reviewBy(2)];
        mockRpcResults.title_review_count = 2;
        const view = await open();
        const sheet = await sheetOf(view);

        await fireEvent.press(sortTab(sheet, 'Only people you follow'));
        await waitFor(() => expect(sheet.getByText('Review number 7.')).toBeTruthy());
        expect(sheet.queryByText('Review number 1.')).toBeNull();
      });

      it('pins your own review at the top of the sheet, with Edit', async () => {
        withNote('public');
        mockRpcResults.title_reviews_v2 = [
          reviewBy(1),
          {
            ...reviewBy(9),
            user_id: 'user-1',
            note: 'My own words on it.',
            display_name: 'Sai',
          },
        ];
        mockRpcResults.title_review_count = 2;
        const view = await open();
        const sheet = await sheetOf(view);
        const mine = sheet.getByTestId('your-review');
        expect(sheet.getAllByText('My own words on it.')).toHaveLength(1);
        const order = readingOrder(view.getByTestId('reviews-sheet-list'));
        expect(order.indexOf('My own words on it.')).toBeLessThan(
          order.indexOf('Review number 1.'),
        );

        // Edit from inside the sheet: the sheet goes, then the one composer opens.
        await fireEvent.press(within(mine).getByTestId('edit-review'));
        await waitFor(() => expect(view.queryByTestId('reviews-sheet')).toBeNull());
      });
    });

    it('shows a compact cast preview and the whole cast from See all', async () => {
      const six = Array.from({ length: 6 }, (_, n) => ({
        id: 9000 + n,
        name: `Actor ${n + 1}`,
        character: `Role ${n + 1}`,
        profile_path: null,
      }));
      tableRows.media_cache = [{ ...credits, payload: { ...credits.payload, cast: six } }];
      const view = await open();
      await waitFor(() => expect(view.getByTestId('immersive-section-cast')).toBeTruthy());

      await fireEvent.press(view.getByRole('button', { name: 'See all 6 cast members' }));
      await waitFor(() => expect(view.getByTestId('cast-sheet')).toBeTruthy());
      expect(within(view.getByTestId('cast-sheet-list')).getByText('Actor 6')).toBeTruthy();
    });
  });
});

/**
 * **A whole show's length is its count of seasons** (visual refine, 2026-11-12).
 *
 * `YEAR · CERT · N seasons` on both layouts: the Cinematic module line says it in one,
 * and the Original page keeps its two lines, the year alone over `CERT · N seasons ·
 * Creator`, with the count in the length slot a film's runtime fills. The count is read
 * from the series page's own season list, excludes Specials, and is absent, never
 * `0 seasons` and never a stray separator, until that list has answered with a real
 * season. A season's page and a film's are unchanged.
 */
describe("a series' count of seasons", () => {
  const show = {
    ...film,
    id: 'series-1',
    kind: 'series',
    title: 'Fleabag',
    release_date: '2019-03-04',
    runtime_minutes: null,
    certification: 'TV-MA',
    backdrop_path: null,
  };
  const season = (n: number) => ({
    id: `season-${n}`,
    parent_id: 'series-1',
    kind: 'season',
    season_number: n,
    title: n === 0 ? 'Specials' : `Season ${n}`,
    release_date: '2019-03-04',
    poster_path: null,
    fetched_at: new Date().toISOString(),
  });

  const openShow = async () => {
    const view = await renderWithProviders(<TitleScreen />);
    await waitFor(() => expect(view.getAllByText(/Fleabag/).length).toBeGreaterThan(0));
    return view;
  };
  /** The season list has been read, so whatever the line says now is its final word. */
  const seasonsRead = () =>
    waitFor(() =>
      expect(
        mockSelects.some(
          ([table, columns]) => table === 'media_items' && columns.includes('season_number'),
        ),
      ).toBe(true),
    );

  beforeEach(() => {
    mockOpenId = 'series-1';
  });

  describe.each([
    [
      'Original',
      'original',
      (count: string) => ({ subtitle: '2019', meta: `TV-MA · ${count}` }),
    ],
    [
      'Cinematic',
      'immersive',
      (count: string) => ({ subtitle: null, meta: `2019 · TV-MA · ${count}` }),
    ],
  ] as const)('on the %s page', (_name, layout, expected) => {
    beforeEach(async () => {
      await hydrateTitleLayout();
      await setTitleLayout(layout);
    });
    afterEach(async () => {
      await setTitleLayout('original');
    });

    const expectLine = async (
      view: Awaited<ReturnType<typeof openShow>>,
      count: string | null,
    ) => {
      if (count == null) {
        // The segment is gone, and so is any separator it would have needed.
        const meta = layout === 'original' ? 'TV-MA' : '2019 · TV-MA';
        await waitFor(() =>
          expect(view.getByTestId('title-meta')).toHaveTextContent(new RegExp(`^${meta}$`)),
        );
        expect(view.getByTestId('title-meta')).not.toHaveTextContent(/season/);
        expect(view.getByTestId('title-meta')).not.toHaveTextContent(/·\s*$|·\s*·/);
        return;
      }
      const line = expected(count);
      await waitFor(() =>
        expect(view.getByTestId('title-meta')).toHaveTextContent(new RegExp(`^${line.meta}$`)),
      );
      if (line.subtitle) {
        expect(view.getByTestId('title-subtitle')).toHaveTextContent(
          new RegExp(`^${line.subtitle}$`),
        );
      }
    };

    it('reads 1 season, singular', async () => {
      tableRows.media_items = [show, season(1)];
      const view = await openShow();
      await expectLine(view, '1 season');
    });

    it('reads 3 seasons, plural', async () => {
      tableRows.media_items = [show, season(1), season(2), season(3)];
      const view = await openShow();
      await expectLine(view, '3 seasons');
    });

    it('does not count Specials: Season 0, 1 and 2 are 2 seasons', async () => {
      tableRows.media_items = [show, season(0), season(1), season(2)];
      const view = await openShow();
      await expectLine(view, '2 seasons');
    });

    it('says nothing for a show with only Specials', async () => {
      tableRows.media_items = [show, season(0)];
      const view = await openShow();
      await seasonsRead();
      await expectLine(view, null);
    });

    it('says nothing, never 0 seasons, while the list is empty', async () => {
      tableRows.media_items = [show];
      const view = await openShow();
      await seasonsRead();
      await expectLine(view, null);
      expect(view.queryByText(/0 seasons/)).toBeNull();
    });

    it('says nothing when the list fails to load', async () => {
      tableRows.media_items = [show, season(1), season(2)];
      mockSeasonListError = { message: 'season list unavailable' };
      const view = await openShow();
      await seasonsRead();
      await expectLine(view, null);
    });

    it('says nothing while the list is still loading, then the count once it lands', async () => {
      tableRows.media_items = [show, season(1), season(2)];
      // The series row answers; the season list read that follows it is parked.
      holdReadsOf('media_items');
      const view = await renderWithProviders(<TitleScreen />);
      releaseReadsOf('media_items');
      holdReadsOf('media_items');
      await waitFor(() => expect(view.getByTestId('title-meta')).toBeTruthy());
      await expectLine(view, null);
      // Discriminating: the hold, and nothing else, is what kept it out.
      releaseReadsOf('media_items');
      await expectLine(view, '2 seasons');
    });
  });

  it('leaves a season page as it was: Season 2 · 7 episodes · 2025', async () => {
    mockOpenId = 'season-2';
    tableRows.media_items = [
      {
        ...season(2),
        release_date: '2025-04-13',
        episode_count: 7,
        certification: null,
        overview: null,
        parent: { id: 'series-1', title: 'Fleabag', certification: 'TV-MA' },
      },
    ];
    const view = await renderWithProviders(<TitleScreen />);
    await waitFor(() =>
      expect(view.getByTestId('title-subtitle')).toHaveTextContent(
        /^Season 2 · 7 episodes · 2025$/,
      ),
    );
    expect(view.getByTestId('title-meta')).toHaveTextContent(/^TV-MA$/);

    view.unmount();
    await hydrateTitleLayout();
    await setTitleLayout('immersive');
    try {
      const cinematic = await renderWithProviders(<TitleScreen />);
      await waitFor(() =>
        expect(cinematic.getByTestId('title-meta')).toHaveTextContent(
          /^Season 2 · 7 episodes · 2025 · TV-MA$/,
        ),
      );
      expect(cinematic.getByTestId('title-meta')).not.toHaveTextContent(/seasons?\b(?! 2)/);
    } finally {
      await setTitleLayout('original');
    }
  });

  it('leaves a film as it was on both layouts', async () => {
    mockOpenId = 'film-1';
    tableRows.media_items = [{ ...film, certification: 'PG-13' }];
    tableRows.media_cache = [credits];
    const view = await open();
    await waitFor(() =>
      expect(view.getByTestId('title-meta')).toHaveTextContent(
        /^PG-13 · 148 min · Christopher Nolan$/,
      ),
    );

    view.unmount();
    await hydrateTitleLayout();
    await setTitleLayout('immersive');
    try {
      const cinematic = await open();
      await waitFor(() =>
        expect(cinematic.getByTestId('title-meta')).toHaveTextContent(
          /^2010 · PG-13 · 148 min$/,
        ),
      );
    } finally {
      await setTitleLayout('original');
    }
  });
});
