import { fireEvent, waitFor, within } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import TitleScreen, { ErrorBoundary } from '../../../app/title/[id]';

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
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
  useRouter: () => ({ push: mockPush, back: mockBack, replace: mockReplace }),
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

/**
 * **The title page under every shape its data can actually arrive in.**
 *
 * The founder's report, physical Android, 2026-09-07: a title page renders briefly and
 * then the app's error boundary appears, often enough that title detail was a release
 * blocker. `RouteErrorBoundary` reported only to Sentry, which this project cannot read,
 * so the exception had no name — and the page's own suite exercises one film with a
 * complete row and one season with a complete row, which is not the catalogue.
 *
 * This file is the other half of that. Every test here renders the whole screen through
 * the real components against a row with something legitimately missing from it, because
 * the crash's shape — a first frame that draws and a later one that throws — is the shape
 * of a render that dereferences something the second read brought back empty.
 *
 * It is not a proof that nothing can throw. It is the set of shapes the catalogue is
 * known to produce, pinned so that the next change to this page cannot quietly stop
 * tolerating one of them.
 *
 * The rest of the page's behaviour lives in `TitleScreen.test.tsx`. Nothing here asserts
 * a layout: what is being claimed is that the screen reaches a rendered state at all.
 */

/** A film with every optional column filled — the control for the rows below. */
const completeFilm = {
  id: 'film-1',
  kind: 'movie',
  title: 'Inception',
  season_number: null,
  release_date: '2010-07-16',
  runtime_minutes: 148,
  episode_count: null,
  overview: 'A thief who steals corporate secrets through dream-sharing technology.',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  genres: ['Science Fiction', 'Action'],
  provenance: 'tmdb',
  tmdb_id: 27205,
  original_language: 'en',
  certification: 'PG-13',
  fetched_at: '2026-09-01T00:00:00Z',
  parent: null,
};

/**
 * A season of a series, in the shape PostgREST actually returns.
 *
 * The parent embed comes back as an **array** — that is the wire shape, however the
 * types describe it — and a season carries neither genres nor a certification of its
 * own, because TMDB publishes both on the series and `tmdb_upsert_seasons` writes
 * neither. Every one of those is a real column state, not a hypothetical.
 */
const completeSeason = {
  id: 'season-1',
  kind: 'season',
  title: 'Season 1',
  season_number: 1,
  release_date: '2023-01-15',
  runtime_minutes: null,
  episode_count: 9,
  overview: 'Twenty years after a fungal outbreak, a smuggler escorts a teenager.',
  poster_path: '/season.jpg',
  backdrop_path: null,
  genres: null,
  provenance: 'tmdb',
  tmdb_id: null,
  original_language: null,
  certification: null,
  fetched_at: '2026-09-01T00:00:00Z',
  parent: [
    {
      id: 'series-1',
      title: 'The Last of Us',
      poster_path: '/series.jpg',
      backdrop_path: '/series-backdrop.jpg',
      genres: ['Drama'],
      original_language: 'en',
      certification: 'TV-MA',
    },
  ],
};

/** The series grouping, which can be ranked by nobody and scored by nobody (PRD §10). */
const completeSeries = {
  ...completeSeason,
  id: 'series-1',
  kind: 'series',
  title: 'The Last of Us',
  season_number: null,
  episode_count: null,
  genres: ['Drama'],
  original_language: 'en',
  certification: 'TV-MA',
  parent: null,
};

beforeEach(() => {
  mockHeaderOptions = {};
  mockParams = {};
  mockPush.mockReset();
  mockBack.mockReset();
  mockReplace.mockReset();
  mockRpc.mockReset();
  alertSpy.mockClear();
  mockOpenURL.mockReset();
  mockEnrichmentArgs.length = 0;
  mockFetchSeasonEpisodes.mockReset();
  mockFetchWatchProviders.mockReset();
  mockFetchWatchProviders.mockResolvedValue({ region: 'US', link: null, providers: [] });
  mockFetchSeasonEpisodes.mockResolvedValue([]);
  mockRpcResults = {};
  mockRpcErrors = {};
  for (const key of Object.keys(mockReads)) delete mockReads[key];
  for (const key of Object.keys(tableRows)) delete tableRows[key];
  tableRows.user_media = [];
  tableRows.rankings = [];
  tableRows.watchlist = [];
  tableRows.media_cache = [];
  tableRows.watch_tags = [];
  tableRows.public_profiles = [];
});

/**
 * Opens the page on one catalogue row and waits for it to have drawn something.
 *
 * The heading is asserted through `title-name` rather than through a text query, because
 * a season legitimately says the same words twice — `The Last of Us` over `Season 1,
 * 2023`, and for an orphan season `Season 1` over `Season 1, 2023` — and a query that
 * matches both is a query about nothing.
 */
const openOn = async (row: Record<string, unknown>, name: string) => {
  mockOpenId = row.id as string;
  tableRows.media_items = [row];
  const view = await renderWithProviders(<TitleScreen />);
  await waitFor(() =>
    expect(view.getByTestId('title-name')).toHaveTextContent(new RegExp(name)),
  );
  return view;
};

/** Logs and ranks the title, so the score, the ordinal and Adjust are all in play. */
const rankIt = (mediaItemId: string, category: 'movies' | 'tv_seasons') => {
  tableRows.user_media = [
    {
      user_id: 'user-1',
      media_item_id: mediaItemId,
      bucket: 'loved',
      watched_on: '2026-02-12',
      note: null,
      note_has_spoilers: null,
      note_visibility: null,
    },
  ];
  tableRows.rankings = [
    { user_id: 'user-1', media_item_id: mediaItemId, position: 1, category, bucket: 'loved' },
  ];
};

describe('the three kinds of title', () => {
  it('renders a movie', async () => {
    const view = await openOn(completeFilm, 'Inception');
    expect(view.getByTestId('title-meta')).toBeTruthy();
  });

  it('renders a season, whose parent arrives as an array', async () => {
    // The heading is the *show*, and the season and year are the subtitle beneath it.
    const view = await openOn(completeSeason, 'The Last of Us');
    // One separator for the whole block since 2026-09-07: the middle dot the metadata
    // line beneath already used, so the two lines read as one grammar.
    expect(view.getByTestId('title-subtitle')).toHaveTextContent(/^Season 1 · 2023$/);
  });

  it('renders a series, which has no score block and no rank control', async () => {
    const view = await openOn(completeSeries, 'The Last of Us');

    // A series cannot be ranked or recommended (PRD §10), so it gets neither — and it
    // gets no aggregate row rather than a permanent "Not enough ratings".
    expect(view.queryByTestId('personal-score')).toBeNull();
    expect(view.queryByTestId('scores-section')).toBeNull();
    expect(view.queryByTestId('title-action-rank')).toBeNull();
    expect(view.queryByTestId('title-action-recommend')).toBeNull();
    // Save survives, which is the one thing a series has always offered.
    expect(view.getByTestId('title-action-save')).toBeTruthy();
  });
});

describe('optional metadata that is absent in the catalogue', () => {
  it('renders a row with nothing optional on it at all', async () => {
    // The seed catalogue's ordinary state before anything has enriched it: no artwork,
    // no overview, no genres, no runtime, no rating, no provider id.
    const view = await openOn(
      {
        ...completeFilm,
        id: 'film-bare',
        title: 'Untitled',
        release_date: null,
        runtime_minutes: null,
        overview: null,
        poster_path: null,
        backdrop_path: null,
        genres: [],
        provenance: null,
        tmdb_id: null,
        original_language: null,
        certification: null,
        fetched_at: null,
      },
      'Untitled',
    );

    // No metadata line rather than an empty one: an empty `Text` is a line box with the
    // footnote's height, which reads as a gap under the title (review 17e).
    expect(view.queryByTestId('title-meta')).toBeNull();
    expect(view.queryByTestId('title-subtitle')).toBeNull();
    expect(view.queryByTestId('genre-row')).toBeNull();
  });

  it('renders a season whose parent could not be resolved', async () => {
    // A left join that came back empty. The season then has no show to inherit genres or
    // a rating from and no name but its own, and the page still has to draw.
    const view = await openOn(
      { ...completeSeason, id: 'season-orphan', parent: null },
      'Season 1',
    );

    expect(view.getByTestId('title-name')).toHaveTextContent(/^Season 1$/);
    // Nine episodes is still the season's own length, with no rating in front of it.
    expect(view.getByTestId('title-meta')).toHaveTextContent(/9 episodes/);
  });

  it('renders a ranked title while the credits facet is empty', async () => {
    tableRows.media_cache = [];
    rankIt('film-1', 'movies');

    const view = await openOn(completeFilm, 'Inception');

    // Certification and runtime, and no trailing separator where the director would be.
    await waitFor(() => expect(view.getByTestId('title-meta')).toHaveTextContent(/PG-13/));
    expect(view.getByTestId('title-meta')).not.toHaveTextContent(/· ·/);
    expect(view.getByTestId('title-meta').props.children).not.toMatch(/·\s*$/);
  });

  it('renders a title whose credits payload has a null cast and a nameless person', async () => {
    tableRows.media_cache = [
      {
        media_item_id: 'film-1',
        facet: 'credits',
        payload: {
          cast: [{ id: 1, name: '', character: null, profile_path: null }],
          crew: null,
        },
      },
    ];

    const view = await openOn(completeFilm, 'Inception');
    await fireEvent.press(view.getByRole('tab', { name: 'Cast' }));

    expect(view.getByTestId('title-name')).toBeTruthy();
  });

  it('renders a season whose episodes are missing every optional field', async () => {
    mockFetchSeasonEpisodes.mockResolvedValue([
      {
        episode_number: 1,
        title: null,
        air_date: null,
        runtime_minutes: null,
        still_path: null,
        overview: null,
      },
      {
        episode_number: 2,
        title: 'Infected',
        air_date: null,
        runtime_minutes: 0,
        still_path: null,
        overview: '',
      },
    ]);

    const view = await openOn(completeSeason, 'The Last of Us');

    // The number becomes the name when the provider has none, and an unaired episode
    // legitimately has no date, no runtime, no still and no synopsis.
    await waitFor(() => expect(view.getByText('Episode 1')).toBeTruthy());
  });

  it('renders a title with no synopsis at all', async () => {
    // Omit the paragraph; never a placeholder line, and never an empty `Text`, which is
    // a line box with the body's height rather than nothing.
    const view = await openOn(
      { ...completeFilm, id: 'film-quiet', overview: null },
      'Inception',
    );

    expect(view.queryByTestId('synopsis-column')).toBeNull();
    expect(view.queryByTestId('synopsis-more')).toBeNull();
  });

  it('renders a provider whose name and logo both came back empty', async () => {
    /**
     * The availability block reaches the page straight off the adapter's reply,
     * unvalidated, and **after the first frame** — so a dereference in it throws in the
     * middle of a render the reader is already looking at. That is the shape of the
     * founder's report, which is why this shape is pinned rather than assumed benign.
     */
    mockFetchWatchProviders.mockResolvedValue({
      region: 'US',
      link: null,
      providers: [
        { provider_id: 1, name: null, logo_path: null, offers: ['stream'] },
        { provider_id: 8, name: 'Netflix', logo_path: null, offers: ['stream'] },
      ],
    });

    const view = await openOn(completeFilm, 'Inception');

    await waitFor(() => expect(view.getByTestId('where-to-watch')).toBeTruthy());
    // The one it can name is named; the one it cannot is drawn as an empty well rather
    // than spoken as "null".
    expect(view.getByLabelText(/Where to watch\. Netflix\./)).toBeTruthy();
  });

  it('renders a ranked title placed outside the top ten, and shows no ordinal', async () => {
    // `heroRankFor` only reaches `genreRanksFor` for a placement past the tenth, so this
    // is the branch a single ranked fixture never exercises.
    tableRows.rankings = Array.from({ length: 40 }, (_, index) => ({
      user_id: 'user-1',
      media_item_id: index === 0 ? 'film-1' : `other-${index}`,
      position: index === 0 ? 25 : index + 1,
      category: 'movies',
      bucket: 'loved',
    }));
    tableRows.user_media = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        bucket: 'loved',
        watched_on: null,
        note: null,
        note_visibility: null,
      },
    ];

    const view = await openOn(completeFilm, 'Inception');

    /**
     * No ordinal is shown for a placement that is not a statement about the title, and
     * with no watch date there is no context line at all rather than an empty one.
     *
     * **Since 2026-09-07 this holds even where a genre placement would qualify.** The
     * identity line takes the overall rank or nothing: `#3 in Drama` beside a title reads
     * as that title's standing when it is really the standing of a slice the reader never
     * chose, and swapping to it precisely when the overall number is weaker is the page
     * flattering itself. `heroRankFor` still computes the genre reading for the
     * post-ranking reveal, which is a surface where the reader has just done the
     * comparison that produced it.
     */
    await waitFor(() => expect(view.getByTestId('title-name')).toBeTruthy());
    /**
     * **The slot is present and empty, rather than absent** (founder, 2026-09-08).
     *
     * It used to render nothing at all, and that was the layout jump: the line arrives
     * with the watch date the moment a ranking succeeds, and everything below it — the
     * actions row, the synopsis, the whole page — moved down by one caption line at the
     * exact moment the reader was being told their ranking had worked.
     *
     * So the element is always mounted and holds its own height with a zero-width space.
     * What this asserts is that it still says *nothing*: no placement, no date, and none
     * of the placeholder copy the founder ruled out.
     */
    /**
     * `includeHiddenElements`, because the empty slot is deliberately hidden.
     *
     * It carries `accessibilityElementsHidden` while it has nothing to say, and RNTL
     * excludes hidden elements from queries by default — so the slot being unfindable
     * *through the ordinary query* is the assertion that a screen reader is not handed a
     * blank line, and finding it this way is the assertion that the space is nevertheless
     * reserved.
     */
    expect(view.queryByTestId('title-context')).toBeNull();
    const context = view.getByTestId('title-context', { includeHiddenElements: true });
    expect(context).toBeTruthy();
    expect(context).not.toHaveTextContent(/#\d+/);
    expect(context).not.toHaveTextContent(/Watched/);
    expect(context).not.toHaveTextContent(/[A-Za-z0-9]/);
  });

  it('keeps the page when the viewer state fails but the catalogue does not', async () => {
    // The two reads were split on 2026-08-16 precisely so that one missing column in
    // `user_media` cannot take down a film the catalogue has perfectly well.
    mockOpenId = 'film-1';
    tableRows.media_items = [completeFilm];
    delete tableRows.user_media;

    const view = await renderWithProviders(<TitleScreen />);
    await waitFor(() => expect(view.getByTestId('title-name')).toHaveTextContent(/Inception/));
  });
});

describe('the identity line', () => {
  it('uses a runtime for a movie', async () => {
    tableRows.media_cache = [
      {
        media_item_id: 'film-1',
        facet: 'credits',
        payload: {
          cast: [],
          crew: [
            { id: 525, name: 'Christopher Nolan', job: 'Director', department: 'Directing' },
          ],
        },
      },
    ];

    const view = await openOn(completeFilm, 'Inception');

    await waitFor(() =>
      expect(view.getByTestId('title-meta')).toHaveTextContent(
        /^PG-13 · 148 min · Christopher Nolan$/,
      ),
    );
  });

  it('uses an episode count for a TV season, and inherits the show’s rating', async () => {
    // Neither fact is on the season row: TMDB publishes a rating on the series and never
    // on a season, and a season's length is its episode count rather than a runtime.
    const view = await openOn(completeSeason, 'The Last of Us');

    expect(view.getByTestId('title-meta')).toHaveTextContent(/TV-MA · 9 episodes/);
    expect(view.getByTestId('title-meta')).not.toHaveTextContent(/min/);
  });

  it('omits a length TMDB reports as zero rather than printing it', async () => {
    // A season reported as having no episodes has not aired. `0 episodes` on this line
    // would read as a fact about the show rather than as data nobody has yet.
    const view = await openOn(
      { ...completeSeason, id: 'season-unaired', episode_count: 0 },
      'The Last of Us',
    );

    expect(view.getByTestId('title-meta')).toHaveTextContent(/TV-MA/);
    expect(view.getByTestId('title-meta')).not.toHaveTextContent(/episode/);
  });

  it('names a television Creator, and only a Creator', async () => {
    tableRows.media_cache = [
      {
        media_item_id: 'season-1',
        facet: 'credits',
        payload: {
          cast: [],
          crew: [{ id: 1, name: 'Craig Mazin', job: 'Creator', department: 'Production' }],
        },
      },
    ];

    const view = await openOn(completeSeason, 'The Last of Us');

    await waitFor(() =>
      expect(view.getByTestId('title-meta')).toHaveTextContent(
        /^TV-MA · 9 episodes · Craig Mazin$/,
      ),
    );
  });

  it('omits the credit rather than printing a season’s episode director', async () => {
    /**
     * **The defect this rule exists for** (founder grammar lock, 2026-09-07).
     *
     * The line read `director ?? showrunner` for every kind of title, and on a season the
     * `Director` credit is the person who directed *one episode of nine*. Every season
     * page in the app was presenting them in the slot a reader reads as "whose show is
     * this" — a confident falsehood in the one place on the page nobody can check.
     *
     * `TV-MA · 9 episodes` is the founder's answer, and it is better.
     */
    tableRows.media_cache = [
      {
        media_item_id: 'season-1',
        facet: 'credits',
        payload: {
          cast: [],
          crew: [
            { id: 1, name: 'Ali Abbasi', job: 'Director', department: 'Directing' },
            { id: 2, name: 'Carolyn Strauss', job: 'Executive Producer', department: 'Production' },
          ],
        },
      },
    ];

    const view = await openOn(completeSeason, 'The Last of Us');

    await waitFor(() =>
      expect(view.getByTestId('title-meta')).toHaveTextContent(/^TV-MA · 9 episodes$/),
    );
    // Neither stand-in. An executive producer is routinely a financier or a star with a
    // production deal, and an episode director directed one episode.
    expect(view.getByTestId('title-meta')).not.toHaveTextContent(/Ali Abbasi/);
    expect(view.getByTestId('title-meta')).not.toHaveTextContent(/Carolyn Strauss/);
    // And no dangling separator where the third segment would have been.
    expect(view.getByTestId('title-meta')).not.toHaveTextContent(/·\s*$/);
  });

  it('never borrows a television Creator for a film', async () => {
    // The rule falls both ways. A film has no creator credit worth the name, so a payload
    // carrying one must not fill the director's slot with it.
    tableRows.media_cache = [
      {
        media_item_id: 'film-1',
        facet: 'credits',
        payload: {
          cast: [],
          crew: [{ id: 1, name: 'Somebody Else', job: 'Creator', department: 'Production' }],
        },
      },
    ];

    const view = await openOn(completeFilm, 'Inception');

    await waitFor(() =>
      expect(view.getByTestId('title-meta')).toHaveTextContent(/^PG-13 · 148 min$/),
    );
    expect(view.getByTestId('title-meta')).not.toHaveTextContent(/Somebody Else/);
  });

  it('leaves no stray separator when the outer segments are the missing ones', async () => {
    // Built by filtering rather than by joining and trimming, so a gap anywhere in the
    // line closes up instead of leaving ` ·  · ` behind.
    //
    // The credits are stated rather than inherited from the default fixture: this file's
    // `beforeEach` does not reset `media_cache`, so a test that leaves a payload behind
    // is a test that decides what the next one sees.
    tableRows.media_cache = [
      {
        media_item_id: 'film-1',
        facet: 'credits',
        payload: {
          cast: [],
          crew: [{ id: 1, name: 'Christopher Nolan', job: 'Director', department: 'Directing' }],
        },
      },
    ];

    const view = await openOn(
      { ...completeFilm, runtime_minutes: null, certification: null },
      'Inception',
    );

    await waitFor(() =>
      expect(view.getByTestId('title-meta')).toHaveTextContent(/^Christopher Nolan$/),
    );
  });

  it('keeps every metadata line to one line', async () => {
    /**
     * The founder's rule: prefer truncation over wrapping the metadata into two lines. A
     * creative credit long enough to wrap turns a three-part line into a paragraph, and
     * two of those under a serif title is the "stack of bands" this pass is removing.
     */
    // Stated for the reason the test above records: `media_cache` survives between tests
    // in this file, and this one needs a season payload rather than whatever the last
    // test left behind.
    tableRows.media_cache = [
      {
        media_item_id: 'season-1',
        facet: 'credits',
        payload: {
          cast: [],
          crew: [{ id: 1, name: 'Craig Mazin', job: 'Creator', department: 'Production' }],
        },
      },
    ];

    const view = await openOn(completeSeason, 'The Last of Us');

    await waitFor(() => expect(view.getByTestId('title-meta')).toBeTruthy());
    expect(view.getByTestId('title-meta').props.numberOfLines).toBe(1);
    expect(view.getByTestId('title-subtitle').props.numberOfLines).toBe(1);
    // And the heading takes at most two before it truncates, rather than shrinking its
    // type to fit — a display face at a different size on every title reads as a bug.
    expect(view.getByTestId('title-name').props.numberOfLines).toBe(2);
  });

  it('shows the overall rank and never swaps to a genre rank', async () => {
    /**
     * **The founder's rule, and it is the one place this line could flatter the reader**
     * (2026-09-07).
     *
     * `heroRankFor` answers with the top-ten overall placement where there is one and
     * otherwise with the best top-ten *genre* placement. The identity line takes the first
     * and discards the second: `#3 in Science Fiction` beside a title reads as that
     * title's standing when it is really the standing of a slice the reader never chose,
     * and switching to it precisely when the overall number is weaker is a page reporting
     * the flattering fact rather than the true one.
     *
     * The fixture is built so the genre reading would win under the old rule: the film
     * sits 13th overall, which is outside the top ten, inside a Science Fiction group of
     * six — past `MIN_GENRE_SIZE` — where it is first.
     */
    tableRows.rankings = [
      { user_id: 'user-1', media_item_id: 'film-1', position: 13, category: 'movies', bucket: 'loved' },
      ...Array.from({ length: 12 }, (_, index) => ({
        user_id: 'user-1',
        media_item_id: `drama-${index}`,
        position: index + 1,
        category: 'movies',
        bucket: 'loved',
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        user_id: 'user-1',
        media_item_id: `scifi-${index}`,
        position: 14 + index,
        category: 'movies',
        bucket: 'loved',
      })),
    ];
    tableRows.user_media = [
      {
        user_id: 'user-1',
        media_item_id: 'film-1',
        bucket: 'loved',
        watched_on: '2026-02-12',
        note: null,
        note_has_spoilers: null,
        note_visibility: null,
      },
    ];

    const view = await openOn(completeFilm, 'Inception');

    // The watch date is there, so there *is* a context line to inspect — which is what
    // makes the absence of an ordinal a statement rather than an empty element.
    await waitFor(() =>
      expect(view.getByTestId('title-context')).toHaveTextContent(/Watched/),
    );
    expect(view.getByTestId('title-context')).not.toHaveTextContent(/#\d+ in Science Fiction/);
    expect(view.getByTestId('title-context')).not.toHaveTextContent(/#\d+ in Action/);
    expect(view.getByTestId('title-context')).not.toHaveTextContent(/#13 in Movies/);
    // And no dangling separator where the ordinal would have been.
    expect(view.getByTestId('title-context')).not.toHaveTextContent(/^\s*·/);
  });

  it('says where it sits and when it was watched, on one line', async () => {
    rankIt('season-1', 'tv_seasons');

    const view = await openOn(completeSeason, 'The Last of Us');

    await waitFor(() =>
      expect(view.getByTestId('title-context')).toHaveTextContent(/#1 in TV/),
    );
    expect(view.getByTestId('title-context')).toHaveTextContent(/Watched/);
  });
});

describe('the personal score', () => {
  /**
   * The number inside a badge is drawn but not separately announced.
   *
   * The circle sets its own `accessible` label — "10.0 out of 10" — so the `Text` inside
   * it is excluded from the accessibility tree and therefore from an ordinary query. A
   * test about the *drawn* number has to ask for it.
   */
  const drawn = { includeHiddenElements: true } as const;

  it('says the number is the reader’s own, in the Scores row', async () => {
    rankIt('film-1', 'movies');

    const view = await openOn(completeFilm, 'Inception');

    /**
     * **The words are the unit's label, not a badge on a badge** (founder lock,
     * 2026-09-07).
     *
     * A naked 10.0 beside artwork is what every other product's critics' aggregate looks
     * like. The first answer to that was a floating `YOU` pill on the circle, which read
     * as a sticker; the second was a `Your score` caption under a badge pinned to the
     * poster's corner. The answer that holds is putting the number where a label and two
     * comparisons already exist.
     *
     * Waiting on the number rather than on the words, because the words are drawn in both
     * states: that is the point of them, and it is what makes the region hold still.
     */
    await waitFor(() => expect(view.getByText('10.0', drawn)).toBeTruthy());
    expect(view.getByText('Your score')).toBeTruthy();
    expect(view.queryByText('YOU')).toBeNull();

    // And it is inside the Scores section, not beside the artwork.
    const scores = view.getByTestId('scores-section');
    expect(within(scores).getByText('10.0', drawn)).toBeTruthy();
    expect(within(scores).getByText('Your score')).toBeTruthy();
    expect(view.queryByTestId('personal-score')).toBeNull();
    expect(view.queryByTestId('title-score-anchor')).toBeNull();
  });

  it('never calls it a star rating, or a rank', async () => {
    rankIt('film-1', 'movies');
    const view = await openOn(completeFilm, 'Inception');

    await waitFor(() => expect(view.getByText('10.0', drawn)).toBeTruthy());
    expect(view.queryByText(/star/i, drawn)).toBeNull();
    /**
     * `getAll`, because since 2026-09-08 two nodes carry the phrase and both should: the
     * circle names itself `10.0 out of 10`, and the pressable unit around it names itself
     * `Your score. 10.0 out of 10`. A Pressable with its own label absorbs its children's,
     * so without the second one a screen reader pressing the unit would hear no number.
     */
    expect(view.getAllByLabelText(/out of 10/).length).toBeGreaterThan(0);
    expect(view.getByLabelText('Your score. 10.0 out of 10')).toBeTruthy();
  });

  it('draws the honest empty state for a title nobody has ranked', async () => {
    const view = await openOn(completeFilm, 'Inception');

    /**
     * A dash in a plain ring, with the sentence beside it. Not a greyed zero and not a
     * faded number (PRD §26.4), and — since the founder's 2026-09-07 lock — not a dashed
     * ring floating beside the poster either. The invitation is the button; this is the
     * statement of fact.
     */
    expect(view.getByLabelText('Your score: Not ranked yet')).toBeTruthy();
    expect(view.getByText('Not ranked yet')).toBeTruthy();
    expect(view.queryByText('0.0')).toBeNull();
  });
});

describe('the action group', () => {
  it('reads Ranked, Save and Recommend for a ranked title', async () => {
    rankIt('film-1', 'movies');
    const view = await openOn(completeFilm, 'Inception');

    // The rank control keeps its **word** in both states, at every width. There is no
    // responsive switch to a glyph: a control that is a word on one phone and a symbol
    // on another is two controls.
    await waitFor(() => expect(view.getByTestId('title-action-ranked')).toBeTruthy());
    expect(view.getByText('Ranked')).toBeTruthy();
    expect(view.getByTestId('title-action-save')).toBeTruthy();
    expect(view.getByTestId('title-action-recommend')).toBeTruthy();
    expect(view.queryByTestId('title-action-rank')).toBeNull();
  });

  it('opens the ranking-options menu from Ranked, and decides no intent itself', async () => {
    /**
     * **The interaction contract, unchanged.** Ranked opens the menu, and the menu is
     * where the reader says which of the two things they mean. A control that went
     * straight to a correction — or straight to a rewatch — would be the founder's
     * Terrace House bug rebuilt in a different shape: two intents behind one press.
     */
    rankIt('film-1', 'movies');
    const view = await openOn(completeFilm, 'Inception');

    await waitFor(() => expect(view.getByTestId('title-action-ranked')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-action-ranked'));

    // Both intents offered, and neither of them taken by the press itself.
    expect(view.getByText('Update your rating')).toBeTruthy();
    expect(view.getByText('Log another watch')).toBeTruthy();
    expect(mockRpc).not.toHaveBeenCalledWith('rank_again', expect.anything());
    expect(mockRpc).not.toHaveBeenCalledWith('rank_unrank', expect.anything());
  });

  it('enters the same-watch rerank from Update your rating, declaring no new watch', async () => {
    /**
     * **The capability the 2026-09-08 consolidation had to keep.** *Rank it again* used
     * to make this call in one tap and is gone; *Update your rating* opens the log
     * sheet's band chooser, and re-choosing the band the title already has is the same
     * `rankAgain(newWatch: false)`. The fixture is Loved, so `I liked it` is that band.
     */
    rankIt('film-1', 'movies');
    const view = await openOn(completeFilm, 'Inception');

    await waitFor(() => expect(view.getByTestId('title-action-ranked')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-action-ranked'));
    await fireEvent.press(view.getByText('Update your rating'));
    await waitFor(() => expect(view.getByText('I liked it')).toBeTruthy());
    await fireEvent.press(view.getByText('I liked it'));
    await waitFor(() => expect(view.getByText('Re-rank')).toBeTruthy());
    await fireEvent.press(view.getByText('Re-rank'));

    // `rank_again` with `p_new_watch: false` — the session runs over the position the
    // title already holds, and `_rank_finalize` posts `title_ranked` only `if p_new_watch
    // or not v_replaced` (20260826000500). No feed activity is written.
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'rank_again',
        expect.objectContaining({ p_new_watch: false }),
      ),
    );
    expect(mockRpc).not.toHaveBeenCalledWith(
      'rank_again',
      expect.objectContaining({ p_new_watch: true }),
    );
    expect(mockRpc).not.toHaveBeenCalledWith('rank_unrank', expect.anything());
  });

  it('declares a new watch only from the rewatch row', async () => {
    rankIt('film-1', 'movies');
    const view = await openOn(completeFilm, 'Inception');

    await waitFor(() => expect(view.getByTestId('title-action-ranked')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-action-ranked'));
    await fireEvent.press(view.getByText('Log another watch'));

    // The one row in the app that declares a second viewing, and the only one that asks
    // for an activity. Exactly one, on completion.
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'rank_again',
        expect.objectContaining({ p_new_watch: true }),
      ),
    );
    expect(mockRpc).not.toHaveBeenCalledWith(
      'rank_again',
      expect.objectContaining({ p_new_watch: false }),
    );
  });

  it('opens the log rather than a comparison for an unranked title', async () => {
    const view = await openOn(completeFilm, 'Inception');

    expect(view.getByText('Rank')).toBeTruthy();
    await fireEvent.press(view.getByTestId('title-action-rank'));

    // The bucket chooser, which is where a first ranking begins. Nothing is ranked yet,
    // so no ranking call is made by pressing this.
    await waitFor(() => expect(view.getByText(/liked it/i)).toBeTruthy());
    expect(mockRpc).not.toHaveBeenCalledWith('rank_again', expect.anything());
    expect(mockRpc).not.toHaveBeenCalledWith('rank_start', expect.anything());
  });

  it('keeps the bookmark’s two states, in the label and in the selected state', async () => {
    const view = await openOn(completeFilm, 'Inception');

    const save = view.getByTestId('title-action-save');
    expect(save.props.accessibilityLabel).toBe('Add Inception to your watchlist');
    expect(save.props.accessibilityState.selected).toBe(false);

    tableRows.watchlist = [{ user_id: 'user-1', media_item_id: 'film-1' }];
    await fireEvent.press(save);

    await waitFor(() =>
      expect(view.getByTestId('title-action-save').props.accessibilityLabel).toBe(
        'Remove Inception from your watchlist',
      ),
    );
    expect(view.getByTestId('title-action-save').props.accessibilityState.selected).toBe(true);
  });
});

describe('navigation', () => {
  it('goes back rather than to the feed', async () => {
    const view = await openOn(completeFilm, 'Inception');

    await fireEvent.press(view.getByTestId('title-back'));

    // The whole of the founder's "sometimes I end up on Feed": nothing on this page may
    // navigate anywhere by itself. Back is the route stack's decision, so a title opened
    // from Search returns to Search.
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('draws no navigator header of its own, so the artwork reaches the top', async () => {
    await openOn(completeFilm, 'Inception');

    expect(mockHeaderOptions.headerShown).toBe(false);
    // The route keeps its title: on iOS a route's title is the back label of whatever is
    // pushed on top of it, and `‹ title/[id]` is what its absence looks like.
    expect(mockHeaderOptions.title).toBe('Inception');
  });

  // Two tests rather than one render, unmount and re-render: this library keeps every
  // mounted tree in one document, so a second render inside one test is a second copy of
  // the screen and every query becomes ambiguous.
  it('offers no menu on a title with nothing to manage', async () => {
    const view = await openOn(completeFilm, 'Inception');

    expect(view.queryByTestId('title-more')).toBeNull();
  });

  it('offers the menu on a ranked title, where the Ranked chip used to keep it', async () => {
    rankIt('film-1', 'movies');
    const view = await openOn(completeFilm, 'Inception');

    await waitFor(() => expect(view.getByTestId('title-more')).toBeTruthy());
  });

  it('catches a render error on the route without navigating anywhere', async () => {
    /**
     * **The route-local boundary, and the whole reason it exists.**
     *
     * The root `RouteErrorBoundary` wraps `<Stack>`, so catching there unmounts the
     * navigator: the pushed route goes, everything behind it goes, and clearing the error
     * mounts a fresh `<Stack>` at the root index — which `nextRoute` reads as
     * `group === undefined` and answers with `/(tabs)/feed`. Nothing chose the feed; the
     * back stack stopped existing.
     *
     * Expo Router wraps a route's `ErrorBoundary` export around the route component and
     * nothing above it. What is asserted here is the part that matters to a reader: it
     * draws, it offers a retry, and **it navigates nowhere at all** — not to the feed, not
     * anywhere. Where the reader is stays the navigator's business.
     */
    const retry = jest.fn();
    const view = await renderWithProviders(
      <ErrorBoundary error={new Error('boom')} retry={retry} />,
    );

    expect(view.getByText('Something went wrong')).toBeTruthy();
    await fireEvent.press(view.getByText('Try again'));

    expect(retry).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('opens the series from a season’s heading', async () => {
    const view = await openOn(completeSeason, 'The Last of Us');

    await fireEvent.press(view.getByLabelText('The Last of Us, the series this belongs to'));

    expect(mockPush).toHaveBeenCalledWith('/title/series-1');
  });
});

/** A style prop, flattened, whichever form the component passed it in. */
const flat = (style: unknown): Record<string, unknown> =>
  Array.isArray(style)
    ? Object.assign({}, ...style.map(flat))
    : ((style ?? {}) as Record<string, unknown>);

/**
 * Every testID in the rendered tree, depth-first.
 *
 * Document order, which is what a "comes after" assertion needs and what a query by id
 * cannot give: `getByTestId` finds a node, not its position among its siblings.
 */
const testIds = (node: unknown): string[] => {
  if (!node || typeof node === 'string') return [];
  if (Array.isArray(node)) return node.flatMap(testIds);
  const n = node as { props?: { testID?: string }; children?: unknown };
  const own = n.props?.testID ? [n.props.testID] : [];
  return [...own, ...testIds(n.children ?? [])];
};

const structure = (view: { toJSON: () => unknown }) => testIds(view.toJSON());

/**
 * **The poster carries artwork and nothing else** (founder lock, 2026-09-07).
 *
 * The score has now been in four places: a detached column opposite the poster, stacked
 * beneath the poster, overhanging the poster's lower-left corner, and — now — the first
 * unit of the Scores row. Each of the first three fought the artwork it was pinned to,
 * and none of them gave the number anything to be measured against.
 *
 * These are the assertions that stop it coming back.
 */
describe('the score and the poster', () => {
  const hidden = { includeHiddenElements: true } as const;

  it('puts no score, caption, ring or badge on the poster', async () => {
    rankIt('film-1', 'movies');
    const view = await openOn(completeFilm, 'Inception');
    await waitFor(() => expect(view.getByText('10.0', hidden)).toBeTruthy());

    const column = view.getByTestId('title-poster-column');

    // The three shapes it took, all gone.
    expect(view.queryByTestId('title-score-anchor')).toBeNull();
    expect(view.queryByTestId('personal-score')).toBeNull();
    expect(within(column).queryByText('Your score')).toBeNull();
    expect(within(column).queryByText(/\d\.\d/, hidden)).toBeNull();
    expect(within(column).queryByLabelText(/out of 10/)).toBeNull();
    // And no ordinal badge either: the placement is a line of type in the identity
    // column, never a stamp on the artwork.
    expect(within(column).queryByText(/^#\d+/)).toBeNull();
    expect(view.queryByText('YOU')).toBeNull();
  });

  it('leaves the poster column with nothing to anchor an overlay to', async () => {
    /**
     * The structural form of the same rule, asserted on the *mechanism* rather than on
     * the absence of one testID.
     *
     * Every revision of the badge attached itself the same way: `position: 'relative'` on
     * this column, so an absolutely positioned child could be measured against the
     * poster's frame. Without the containing block there is nothing for an overlay to be
     * placed against, which is a harder thing to reintroduce by accident than a name.
     */
    rankIt('film-1', 'movies');
    const view = await openOn(completeFilm, 'Inception');
    await waitFor(() => expect(view.getByText('10.0', hidden)).toBeTruthy());

    const column = flat(view.getByTestId('title-poster-column').props.style);
    expect(column.position).toBeUndefined();
  });

  it('draws a stated absence for an unranked title, and only in the Scores row', async () => {
    /**
     * The word "Rank" inside the circle duplicated the button beside it, and a dashed
     * ring floating beside the poster read as a control somebody forgot to draw. The
     * honest statement of "no score yet" is a dash and a sentence, in the row where the
     * other two scores are; the invitation is the button.
     */
    const view = await openOn(completeFilm, 'Inception');

    const scores = view.getByTestId('scores-section');
    expect(within(scores).getByText('Not ranked yet')).toBeTruthy();
    expect(within(scores).queryByText('Rank', hidden)).toBeNull();
    expect(within(scores).queryByText(/\d\.\d/, hidden)).toBeNull();
    expect(view.getByLabelText('Your score: Not ranked yet')).toBeTruthy();
    expect(view.getByTestId('title-action-rank')).toBeTruthy();
  });
});

/**
 * **The identity column, and the dead band that used to sit above the action row.**
 *
 * The actions were a full-width row *after* the whole identity region, so they waited for
 * the bottom of a 150pt poster before they could be drawn — which on a short title left
 * an obvious empty band beside the artwork with the page's primary control below it. The
 * design draft's answer was a fixed 150pt identity row so the button always landed at the
 * same y; the founder rejected that as the same dead space made deliberate.
 */
describe('where the action row lives', () => {
  it('sits inside the identity column, above the synopsis', async () => {
    rankIt('film-1', 'movies');
    const view = await openOn(completeFilm, 'Inception');
    await waitFor(() => expect(view.getByTestId('title-action-ranked')).toBeTruthy());

    // Inside the same column as the title and its metadata, not a sibling of the whole
    // identity row — which is what lets it rise on a short title.
    const identity = view.getByTestId('title-identity-copy');
    expect(within(identity).getByTestId('title-actions')).toBeTruthy();
    expect(within(identity).getByTestId('title-name')).toBeTruthy();

    // And not in the poster's column, which is the other way this could be misread.
    const column = view.getByTestId('title-poster-column');
    expect(within(column).queryByTestId('title-actions')).toBeNull();
  });

  it('reserves no fixed height for the identity row', async () => {
    /**
     * The founder's correction of the design draft, as a measurement. A minimum height on
     * this row is what would put the action group at the same y on every title, and it is
     * exactly the dead space this pass exists to remove: the row is content-driven, and
     * whichever column is taller sets its height.
     */
    const view = await openOn(completeFilm, 'Inception');
    await waitFor(() => expect(view.getByTestId('title-name')).toBeTruthy());

    const row = flat(view.getByTestId('title-identity').props.style);
    expect(row.minHeight).toBeUndefined();
    expect(row.height).toBeUndefined();
    // Top-aligned, so the title and the poster begin on the same line rather than the
    // column sliding down to meet the artwork.
    expect(row.alignItems).toBe('flex-start');
    expect(row.flexDirection).toBe('row');
  });

  it('sits the poster level with the title rather than up inside the hero', async () => {
    /**
     * **The founder's 2026-09-08 correction, and the end of a four-value sequence.**
     *
     * The poster was pulled up across the hero's fade by a negative margin — 64, then 120,
     * then 88, then 56 — on the argument that artwork may cross a line the words may not.
     * On the device that made the poster a member of the *hero*, sitting level with the
     * middle of the title instead of with its first line, and no value of the lift fixes
     * that because the defect is membership rather than distance.
     *
     * A **positive** offset now, and a small one: enough to meet the title's cap height
     * rather than its line box. `title1` is 28pt on a 34pt line, so a poster aligned to
     * the box measures level with the ascent and reads a few points high.
     */
    const view = await openOn(completeFilm, 'Inception');
    await waitFor(() => expect(view.getByTestId('title-name')).toBeTruthy());

    const column = flat(view.getByTestId('title-poster-column').props.style);
    const offset = (column.marginTop ?? 0) as number;

    // Positive and small. Negative is the defect; more than a line's leading is a gap.
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThanOrEqual(theme.space[2]);
    // And nothing else displaces it: no lift by another name, and no overlay anchor.
    expect(column.top).toBeUndefined();
    expect(column.transform).toBeUndefined();
    expect(column.position).toBeUndefined();
  });

  it('starts the synopsis below both the poster and the left stack', async () => {
    /**
     * The structural guarantee, rather than a pixel one. The identity row is a plain flex
     * row with no height, no minimum and nothing absolutely positioned or negatively
     * margined inside it, so its height is exactly the taller of its two children — and
     * the synopsis, being the row's *sibling* rather than a child of either column, cannot
     * begin before both have finished.
     *
     * That is what makes it hold for a one-line film and a wrapped two-line season alike,
     * without anything having to compute which column won.
     */
    const view = await openOn(completeFilm, 'Inception');
    await waitFor(() => expect(view.getByTestId('title-name')).toBeTruthy());

    const order = structure(view);
    const identity = order.indexOf('title-identity');
    const poster = order.indexOf('title-poster-column');
    const actions = order.indexOf('title-actions');
    const synopsis = order.indexOf('synopsis-column');

    expect(identity).toBeGreaterThanOrEqual(0);
    expect(synopsis).toBeGreaterThan(poster);
    expect(synopsis).toBeGreaterThan(actions);
    // The poster and the actions are both inside the identity row; the synopsis is not.
    expect(poster).toBeGreaterThan(identity);
    expect(actions).toBeGreaterThan(identity);

    // The synopsis is full width: gutter padding only, and no width the poster could
    // have taken from it.
    const block = flat(view.getByTestId('synopsis-column').props.style);
    expect(block.width).toBeUndefined();
    expect(block.marginRight).toBeUndefined();
  });

  it('holds that order for a season whose title wraps to two lines', async () => {
    // The other shape of the same guarantee. A long season heading makes the left stack
    // the taller column, so the synopsis now clears *it* rather than the poster — and the
    // structural answer is identical because nothing in the row is measured.
    const view = await openOn(
      { ...completeSeason, parent: [{ ...completeSeason.parent[0], title: 'The Last of Us' }] },
      'The Last of Us',
    );
    await waitFor(() => expect(view.getByTestId('title-name')).toBeTruthy());

    const order = structure(view);
    expect(order.indexOf('synopsis-column')).toBeGreaterThan(order.indexOf('title-poster-column'));
    expect(order.indexOf('synopsis-column')).toBeGreaterThan(order.indexOf('title-actions'));
    expect(view.getByTestId('title-name').props.numberOfLines).toBe(2);
  });

  it('keeps the rank control content-sized rather than full width', async () => {
    /**
     * **The correction the founder called unacceptable in the previous build.** It took
     * `flex: 1` — the whole width the two glyphs left — and on the device a full-width
     * primary at the top of a reading page reads as a form's submit button.
     */
    rankIt('film-1', 'movies');
    const view = await openOn(completeFilm, 'Inception');
    await waitFor(() => expect(view.getByTestId('title-action-ranked')).toBeTruthy());

    const button = flat(view.getByTestId('title-action-ranked').props.style);
    expect(button.flex).toBeUndefined();
    expect(button.flexGrow).toBeUndefined();
    expect(button.alignSelf).not.toBe('stretch');
    // Capped inside the founder's 150–170 range, which is the guard at 130% type.
    expect(button.maxWidth as number).toBeLessThanOrEqual(170);
    expect(button.maxWidth as number).toBeGreaterThanOrEqual(150);
    // Still 44pt tall, so it shares a centre line with the two icon boxes beside it.
    expect(button.minHeight).toBe(theme.layout.minTapTarget);
    // And it keeps its word in both states: no responsive switch to a glyph.
    expect(view.getByText('Ranked')).toBeTruthy();
  });
});

describe('the ranking menu, in the founder’s words', () => {
  it('names the two intents Update your rating and Log another watch, and nothing else', async () => {
    /**
     * **The founder's menu, 2026-09-08.** It was three rows for a day: *Rank it again*,
     * *Log another watch* and *Change your rating*. The first and third were two doors
     * into one act — both correct a rating already given, both leave `p_new_watch` false,
     * both write no activity — separated only by whether the band chooser was skipped,
     * which is a mechanism, and naming mechanisms is what the 2026-09-07 rename had
     * already decided this menu must stop doing.
     *
     * Copy only, again. The rows' modes, RPCs and `p_new_watch` are pinned unchanged by
     * the tests in "the action group" above, and `rerank` is still reached — through one
     * row instead of two.
     */
    rankIt('film-1', 'movies');
    const view = await openOn(completeFilm, 'Inception');

    await waitFor(() => expect(view.getByTestId('title-action-ranked')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-action-ranked'));

    expect(view.getByText('Update your rating')).toBeTruthy();
    expect(view.getByText('Log another watch')).toBeTruthy();
    // Every label this group has ever carried and no longer does.
    expect(view.queryByText('Rank it again')).toBeNull();
    expect(view.queryByText('Change your rating')).toBeNull();
    expect(view.queryByText('Adjust placement')).toBeNull();
    expect(view.queryByText('I watched it again')).toBeNull();
  });
});
