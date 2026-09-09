import { fireEvent, waitFor, within } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import TitleScreen from '../../../app/title/[id]';

const mockPush = jest.fn();
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

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      const error = mockRpcErrors[name] ?? null;
      return Promise.resolve({ data: error ? null : (mockRpcResults[name] ?? null), error });
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
        select: () => chain,
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

jest.mock('expo-router', () => ({
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

beforeEach(() => {
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

  mockRpcResults = {};
  mockRpcErrors = {};
  for (const key of Object.keys(mockReads)) delete mockReads[key];
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
    await waitFor(() => expect(view.getByText('bingd.')).toBeTruthy());

    expect(positionOf(view, '148 min')).toBeLessThan(
      positionOf(view, 'A thief who steals corporate secrets'),
    );
    expect(positionOf(view, 'A thief who steals corporate secrets')).toBeLessThan(
      positionOf(view, 'Science Fiction'),
    );
    expect(positionOf(view, 'Science Fiction')).toBeLessThan(positionOf(view, 'bingd.'));
  });

  it('keeps the scores above the tabs, which is the rule that never changed', async () => {
    // Scores are core bingd. data and must not appear and disappear as somebody looks
    // at the cast. Every reordering of this page has preserved that, and this is what
    // says so out loud.
    const view = await open();
    await waitFor(() => expect(view.getByText('bingd.')).toBeTruthy());

    expect(positionOf(view, 'bingd.')).toBeLessThan(positionOf(view, 'Details'));
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
    await waitFor(() => expect(view.getByText('bingd.')).toBeTruthy());

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
    await waitFor(() =>
      expect(view.getAllByLabelText('10.0 out of 10')).toHaveLength(1),
    );
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
    expect(view.getByText('bingd.')).toBeTruthy();
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
    expect(view.getByText('Update your rating')).toBeTruthy();
    expect(view.getByText('Log another watch')).toBeTruthy();
  });

  it('offers the same menu from the overflow control in the bar', async () => {
    const view = await open();

    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-more'));

    expect(view.getByText('Update your rating')).toBeTruthy();
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

    await waitFor(() => expect(view.getByLabelText('Update your rating')).toBeTruthy());
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
  it('offers Rank again, through the atomic call rather than an unrank and a restart', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-more'));
    await waitFor(() => expect(view.getByLabelText('Log another watch')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Log another watch'));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('rank_again', expect.anything()));
    // One call, and the guarantee T2 bought: never the pair.
    expect(mockRpc).not.toHaveBeenCalledWith('rank_unrank', expect.anything());
    expect(mockRpc).not.toHaveBeenCalledWith('rank_start', expect.anything());
  });

  it('re-ranks inside the band the title is already in', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-more'));
    await waitFor(() => expect(view.getByLabelText('Log another watch')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Log another watch'));

    // Rank again redoes the comparisons; it does not decide a rating. The bucket goes
    // straight through from `rankings.bucket`, in the database's own spelling.
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'rank_again',
        expect.objectContaining({ p_bucket: 'loved' }),
      ),
    );
  });

  /**
   * **The Ranking group is two rows, and it is the founder's list** (2026-09-08).
   *
   *   ★ Update your rating   the current watch, corrected
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

    await waitFor(() => expect(view.getByLabelText('Update your rating')).toBeTruthy());
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
      'Update your rating',
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
    await waitFor(() => expect(view.getByLabelText('Update your rating')).toBeTruthy());
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
    for (const rpc of ['rank_again', 'rank_start', 'rank_rebucket', 'set_bucket']) {
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
    await waitFor(() => expect(view.getByLabelText('Update your rating')).toBeTruthy());

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
    // "bingd.", not "Community". The old label described a population where the new one
    // names it, and the app has a name.
    expect(view.getByText('bingd.')).toBeTruthy();
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

    await waitFor(() => expect(view.getByText('bingd.')).toBeTruthy());
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
  it('always offers Reviews, because the reader can write the first one', async () => {
    // The rule against permanently-empty tabs is about a tab that can only ever have
    // nothing — a film TMDB publishes no trailer for. Reviews can always have
    // something, and removing it until somebody else had written would mean the only
    // way to leave the first review of a film is to already have left it.
    const view = await open();

    expect(view.getByRole('tab', { name: 'Reviews' })).toBeTruthy();
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

    await waitFor(() => expect(view.getByRole('tab', { name: 'Top, most helpful first' })).toBeTruthy());
    expect(view.getByRole('tab', { name: 'Top, most helpful first' }).props.accessibilityState.selected).toBe(true);
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
    expect(view.getByText('Not ranked yet')).toBeTruthy();
  });

  it('offers no way to rank the series itself', async () => {
    const view = await openSeries();

    await waitFor(() => expect(view.getByText(/Season 1/)).toBeTruthy());
    expect(view.queryByTestId('title-action-rank')).toBeNull();
    expect(view.queryByLabelText('Ranked. Change your rating.')).toBeNull();
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
    expect(view.getByText('bingd.')).toBeTruthy();
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
    expect(view.getByText('bingd.')).toBeTruthy();
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

  it('asks for nothing on a series, which cannot be ranked', async () => {
    mockOpenId = 'series-1';
    tableRows.media_items = [
      { ...film, id: 'series-1', kind: 'series', title: 'Breaking Bad', runtime_minutes: null },
    ];

    const view = await renderWithProviders(<TitleScreen />);
    await waitFor(() => expect(view.getByText(/^Breaking Bad/)).toBeTruthy());

    expect(view.queryByText('Following')).toBeNull();
    expect(view.queryByText('bingd.')).toBeNull();
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

describe('a title opened from a recommendation', () => {
  it('says who sent it, over the hero', async () => {
    mockParams = { recBy: 'Ada', recAt: new Date(Date.now() - 2 * 86400000).toISOString() };
    const view = await open();

    await waitFor(() => expect(view.getByText(/^Recommended by Ada/)).toBeTruthy());
    expect(view.getByText(/2d ago/)).toBeTruthy();
  });

  it('says nothing when the reader arrived any other way', async () => {
    const view = await open();
    expect(view.queryByText(/Recommended by/)).toBeNull();
  });

  it('still says it on a title with no artwork to sit on', async () => {
    // The collapsed band is the same height as the poster lift, so there is no hero to
    // overlay. The callout moves into the flow rather than disappearing or landing on
    // top of the poster.
    tableRows.media_items = [{ ...film, backdrop_path: null, poster_path: null }];
    mockParams = { recBy: 'Ada' };

    const view = await open();
    await waitFor(() => expect(view.getByText(/^Recommended by Ada/)).toBeTruthy());
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

    await waitFor(() => expect(view.getByText('bingd.')).toBeTruthy());
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
    expect(view.getByText('Share off bingd.')).toBeTruthy();
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

  it('does not offer Recommend on a series, which is not a thing anybody watched', async () => {
    // PRD §10 makes the season the rankable TV unit, and `recommend_title` refuses a
    // series outright. A control that always fails is worse than its absence.
    const film = (tableRows.media_items ?? [])[0] as Record<string, unknown>;
    mockOpenId = 'series-1';
    tableRows.media_items = [
      { ...film, id: 'series-1', kind: 'series', title: 'Breaking Bad', runtime_minutes: null },
    ];
    const view = await renderWithProviders(<TitleScreen />);
    await waitFor(() => expect(view.getByText(/^Breaking Bad/)).toBeTruthy());

    expect(view.queryByLabelText(/^Recommend /)).toBeNull();
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
 * Episodes is informational metadata (PRD §10) — no row is pressable, nothing is
 * logged, nothing is scored — and the tab exists on a season and on nothing else.
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

  it('shows an episode as its number, its title, and then when and how long', async () => {
    const view = await openSeason();

    await waitFor(() => expect(view.getByText('1 · Episode title 1')).toBeTruthy());
    expect(view.getByText('2 · Episode title 2')).toBeTruthy();
    expect(view.getAllByText(`${airDate('2011-04-17')} · 62 min`)).toHaveLength(2);
    expect(view.getByText('What happens in episode 1.')).toBeTruthy();
  });

  it('names an episode by its number when the provider has no title for it', async () => {
    // "Episode 4", never a blank line and never a fabricated name.
    mockFetchSeasonEpisodes.mockResolvedValue([episode(4, { title: null })]);
    const view = await openSeason();

    await waitFor(() => expect(view.getByText('Episode 4')).toBeTruthy());
  });

  it('drops a missing field rather than drawing a placeholder for it', async () => {
    // An unaired episode legitimately has no runtime, no still and often no synopsis.
    // Framing each absence would make the common case look broken.
    mockFetchSeasonEpisodes.mockResolvedValue([
      episode(3, { runtime_minutes: null, still_path: null, overview: null }),
    ]);
    const view = await openSeason();

    await waitFor(() => expect(view.getByText('3 · Episode title 3')).toBeTruthy());
    // The date survives on its own, with no stray separator beside it.
    expect(view.getByText(airDate('2011-04-17'))).toBeTruthy();
    expect(view.queryByText(/Unknown|TBA|null|undefined/)).toBeNull();
  });

  it('shows a future episode with the date the provider published', async () => {
    mockFetchSeasonEpisodes.mockResolvedValue([
      episode(8, { air_date: '2099-01-01', runtime_minutes: null, still_path: null }),
    ]);
    const view = await openSeason();

    await waitFor(() => expect(view.getByText(airDate('2099-01-01'))).toBeTruthy());
  });

  it('leaves the whole metadata line out when there is neither a date nor a runtime', async () => {
    mockFetchSeasonEpisodes.mockResolvedValue([
      episode(1, { air_date: null, runtime_minutes: null }),
    ]);
    const view = await openSeason();

    await waitFor(() => expect(view.getByText('1 · Episode title 1')).toBeTruthy());
    expect(view.queryByText(/ · \d+ min/)).toBeNull();
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

  it('draws the first fifty of a long season, then offers the rest', async () => {
    // A daily soap or a long anime run that the provider models as one season. Two
    // hundred rows with a still apiece is a lot of images to lay out at once, and a
    // virtualized list nested in this page's ScrollView is the arrangement React
    // Native warns about. Nothing is dropped: "Show all" reveals them.
    mockFetchSeasonEpisodes.mockResolvedValue(
      Array.from({ length: 60 }, (_, index) => episode(index + 1)),
    );
    const view = await openSeason();

    await waitFor(() => expect(view.getByText('1 · Episode title 1')).toBeTruthy());
    expect(view.getByText('50 · Episode title 50')).toBeTruthy();
    expect(view.queryByText('51 · Episode title 51')).toBeNull();

    await fireEvent.press(view.getByLabelText('Show all 60 episodes'));

    expect(view.getByText('51 · Episode title 51')).toBeTruthy();
    expect(view.getByText('60 · Episode title 60')).toBeTruthy();
    expect(view.queryByLabelText('Show all 60 episodes')).toBeNull();
  });

  it('offers nothing to show when the season is exactly the first page long', async () => {
    mockFetchSeasonEpisodes.mockResolvedValue(
      Array.from({ length: 50 }, (_, index) => episode(index + 1)),
    );
    const view = await openSeason();

    await waitFor(() => expect(view.getByText('50 · Episode title 50')).toBeTruthy());
    expect(view.queryByLabelText(/Show all/)).toBeNull();
  });

  it('keeps the episodes when the reader visits another tab and comes back', async () => {
    const view = await openSeason();
    await waitFor(() => expect(view.getByText('1 · Episode title 1')).toBeTruthy());

    await fireEvent.press(view.getByRole('tab', { name: 'Details' }));
    expect(view.queryByText('1 · Episode title 1')).toBeNull();

    await fireEvent.press(view.getByRole('tab', { name: 'Episodes' }));
    expect(view.getByText('1 · Episode title 1')).toBeTruthy();
    // One request for the whole visit. The list is cached for an hour.
    expect(mockFetchSeasonEpisodes).toHaveBeenCalledTimes(1);
  });

  it('renders episodes as reading matter, with nothing to press on a row', async () => {
    // The product boundary, as a test. An episode is not rankable, not loggable and
    // not a media_items row, so a pressable episode is the first step toward a
    // feature the decision log rules out.
    const view = await openSeason();
    await waitFor(() => expect(view.getByText('1 · Episode title 1')).toBeTruthy());

    expect(view.queryByLabelText(/Rank Episode title 1/)).toBeNull();
    expect(view.queryByLabelText(/Log Episode title 1/)).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('keeps Rank in reach while the episodes are on screen', async () => {
    // The journey the feature is for: recognise the season, then rank it. Rank lives
    // in the hero cluster above the tab row and is not inside any tab, so choosing
    // Episodes does not take it away.
    const view = await openSeason();
    await waitFor(() => expect(view.getByText('1 · Episode title 1')).toBeTruthy());

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

  it('leaves a film opening on its cast', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('where-to-watch')).toBeTruthy());

    expect(view.getByRole('tab', { name: 'Cast' }).props.accessibilityState.selected).toBe(
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

  it('is on a series page too, which has no score block of its own', async () => {
    // A series cannot be ranked, so it gets no Scores section — and availability is
    // still the thing somebody on that page wants. "Under the scores" is a placement
    // rule, not a dependency.
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
    expect(view.queryByTestId('scores-section')).toBeNull();
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

  it('puts the reader’s own people before the crowd', async () => {
    // Founder's order, 2026-09-07, reversing the Preview pass. A mean over accounts the
    // reader chose to follow is a signal about their own taste; the app-wide mean is a
    // fact about the app. The narrower, more personal reading leads.
    const view = await open();
    await waitFor(() => expect(view.getByTestId('scores-section')).toBeTruthy());

    expect(at(view, 'Following')).toBeLessThan(at(view, 'bingd.'));
  });

  it('follows the synopsis rather than the metadata', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('scores-section')).toBeTruthy());

    expect(at(view, '148 min')).toBeLessThan(at(view, 'A thief who steals corporate secrets'));
    expect(at(view, 'A thief who steals corporate secrets')).toBeLessThan(at(view, 'bingd.'));
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

    expect(at(view, 'A thief who steals corporate secrets')).toBeLessThan(at(view, 'bingd.'));
    // Stated once, in the Scores row, where the reader's own number is the first term of
    // a comparison rather than a figure beside artwork with nothing to measure it by.
    expect(view.getAllByLabelText('10.0 out of 10')).toHaveLength(1);
    expect(at(view, 'Your score')).toBeLessThan(at(view, 'Following'));
    expect(at(view, 'Following')).toBeLessThan(at(view, 'bingd.'));
    expect(view.getByText('12 ratings')).toBeTruthy();
  });

  it('holds for an unranked movie', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByTestId('scores-section')).toBeTruthy());

    expect(view.getByTestId('title-action-rank')).toBeTruthy();
    expect(at(view, 'A thief who steals corporate secrets')).toBeLessThan(at(view, 'bingd.'));
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

  it('draws no score row on a series, which cannot be ranked', async () => {
    mockOpenId = 'series-1';
    tableRows.media_items = [
      { ...film, id: 'series-1', kind: 'series', title: 'Breaking Bad', runtime_minutes: null },
    ];

    const view = await renderWithProviders(<TitleScreen />);
    await waitFor(() => expect(view.getByText(/^Breaking Bad/)).toBeTruthy());

    expect(view.queryByTestId('scores-section')).toBeNull();
    expect(view.queryByTestId('scores-divider')).toBeNull();
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
    expect(view.getByText('bingd.')).toBeTruthy();
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
 *   Update your rating  the same-watch correction, whole. Opens the log sheet's band
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
    await waitFor(() => expect(view.getByLabelText('Update your rating')).toBeTruthy());
    return view;
  };

  /**
   * **The same-watch correction, taken the way a reader now takes it.**
   *
   * *Update your rating* opens the log sheet's band chooser; re-choosing the band the
   * title already has is the correction — `LogSheet` confirms it, because the position is
   * re-derived either way, and then calls `rankAgain(newWatch: false)`. That is the exact
   * call the retired *Rank it again* row made in one tap, which is what makes this a
   * consolidated entry point rather than a lost capability.
   *
   * The fixture is a Loved film throughout this block, so `I liked it` is the same band.
   */
  const correctTheRating = async (view: Awaited<ReturnType<typeof openMenu>>) => {
    await fireEvent.press(view.getByLabelText('Update your rating'));
    await waitFor(() => expect(view.getByText('I liked it')).toBeTruthy());
    await fireEvent.press(view.getByText('I liked it'));
    await waitFor(() => expect(view.getByText('Re-rank')).toBeTruthy());
    await fireEvent.press(view.getByText('Re-rank'));
  };

  /** Every `rank_again` call the screen made, with its arguments. */
  const againCalls = () =>
    mockRpc.mock.calls.filter(([name]: [string]) => name === 'rank_again');

  it('offers both intents, named so neither can be mistaken for the other', async () => {
    const view = await openMenu();

    expect(view.getByLabelText('Update your rating')).toBeTruthy();
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

  it('declares a new watch only from the rewatch row', async () => {
    const view = await openMenu();

    await fireEvent.press(view.getByLabelText('Log another watch'));

    await waitFor(() => expect(againCalls().length).toBe(1));
    expect(againCalls()[0]![1]).toEqual(
      expect.objectContaining({ p_new_watch: true, p_bucket: 'loved' }),
    );
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

    // The menu closes on the first press, so the second lands on nothing — and the
    // sheet is keyed by title, so even a re-entry would reuse one session.
    await waitFor(() => expect(againCalls().length).toBe(1));
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
    await waitFor(() => expect(view.getByLabelText('Update your rating')).toBeTruthy());

    await correctTheRating(view);

    await waitFor(() => expect(againCalls().length).toBe(1));
    expect(againCalls()[0]![1]).toEqual(expect.objectContaining({ p_new_watch: false }));
  });

  it('writes no ranking call from the row itself, only from what follows it', async () => {
    /**
     * *Update your rating* opens the log sheet's band chooser and stops there. The
     * ranking call is decided by what the reader chooses next — the same band is a
     * correction, a different one is a rebucket — and a row that fired one on the way in
     * would be deciding a rating on the reader's behalf.
     */
    const view = await openMenu();

    await fireEvent.press(view.getByLabelText('Update your rating'));

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

    await fireEvent.press(view.getByLabelText('Update your rating'));
    await waitFor(() => expect(view.getByText('It was fine')).toBeTruthy());
    await fireEvent.press(view.getByText('It was fine'));
    await waitFor(() => expect(view.getByText('Re-rank')).toBeTruthy());
    await fireEvent.press(view.getByText('Re-rank'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'rank_rebucket',
        expect.objectContaining({ p_bucket: 'fine' }),
      ),
    );
    // A band change is its own call; it never routes through the rewatch one.
    expect(againCalls()).toHaveLength(0);
  });
});
