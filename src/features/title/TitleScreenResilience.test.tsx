import { fireEvent, waitFor, within } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

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
    expect(view.getByTestId('title-subtitle')).toHaveTextContent(/^Season 1, 2023$/);
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

  it('renders a ranked title placed outside the top ten, where the genre path runs', async () => {
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

    // No ordinal is shown for a placement that is not a statement about the title, and
    // with no watch date there is no context line at all rather than an empty one.
    await waitFor(() => expect(view.getByTestId('personal-score')).toBeTruthy());
    expect(view.queryByTestId('title-context')).toBeNull();
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

  it('falls back to a showrunner credit where television has no director', async () => {
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
   * The badge is deliberately hidden from assistive technology.
   *
   * `PersonalScore` is one button carrying one sentence — "Your score: 10.0 out of 10" —
   * and the circle inside it sets its own `accessible` label, so without this wrapper a
   * screen reader on Android would find two nodes for one number. That is also what
   * excludes it from an ordinary query, so a test about the *drawn* number has to ask for
   * it. `YOU` sits outside the wrapper and needs no such thing.
   */
  const drawn = { includeHiddenElements: true } as const;

  it('says the number is the reader’s own, in words and on the badge', async () => {
    rankIt('film-1', 'movies');

    const view = await openOn(completeFilm, 'Inception');

    /**
     * **The words, not a badge on a badge.** A naked 10.0 beside artwork is what every
     * other product's critics' aggregate looks like, and the first answer to that — a
     * floating `YOU` pill on the circle — read as a sticker. Ownership is stated instead.
     *
     * Waiting on the number rather than on the words, because the words are drawn in both
     * states: that is the point of them, and it is what makes the region hold still.
     */
    await waitFor(() => expect(view.getByText('10.0', drawn)).toBeTruthy());
    expect(view.getByText('Your score')).toBeTruthy();
    expect(view.queryByText('YOU')).toBeNull();
    // And the spoken label, which leads with whose score it is rather than with the number.
    expect(view.getByLabelText(/^Your score: 10\.0 out of 10/)).toBeTruthy();
  });

  it('never calls it a star rating, or a rank', async () => {
    rankIt('film-1', 'movies');
    const view = await openOn(completeFilm, 'Inception');

    await waitFor(() => expect(view.getByText('10.0', drawn)).toBeTruthy());
    expect(view.queryByText(/star/i, drawn)).toBeNull();
    expect(view.getByLabelText(/out of 10/)).toBeTruthy();
  });

  it('draws the honest empty state for a title nobody has ranked', async () => {
    const view = await openOn(completeFilm, 'Inception');

    // Not a greyed zero and not a faded number (PRD §26.4).
    expect(view.getByLabelText('You have not ranked this yet')).toBeTruthy();
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
     * where the reader says which of the three things they mean. A control that went
     * straight to a rerank — or straight to a rewatch — would be the founder's Terrace
     * House bug rebuilt in a different shape: two intents behind one press.
     */
    rankIt('film-1', 'movies');
    const view = await openOn(completeFilm, 'Inception');

    await waitFor(() => expect(view.getByTestId('title-action-ranked')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-action-ranked'));

    // All three intents offered, and none of them taken by the press itself.
    expect(view.getByText('Rank it again')).toBeTruthy();
    expect(view.getByText('Log another watch')).toBeTruthy();
    expect(view.getByText('Change your rating')).toBeTruthy();
    expect(mockRpc).not.toHaveBeenCalledWith('rank_again', expect.anything());
    expect(mockRpc).not.toHaveBeenCalledWith('rank_unrank', expect.anything());
  });

  it('enters the same-watch rerank from Rank it again, declaring no new watch', async () => {
    rankIt('film-1', 'movies');
    const view = await openOn(completeFilm, 'Inception');

    await waitFor(() => expect(view.getByTestId('title-action-ranked')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-action-ranked'));
    await fireEvent.press(view.getByText('Rank it again'));

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

describe('the score and the poster', () => {
  const hidden = { includeHiddenElements: true } as const;

  it('is anchored to the poster, overhanging its corner, rather than stacked beneath it', async () => {
    /**
     * **Structural, not pixel** (founder, physical Android, 2026-09-07). The score sat
     * under the poster for one revision and produced a tall empty right-hand column. It
     * belongs to the artwork: inside the poster's own column, absolutely positioned, and
     * negative on both axes so the circle crosses the frame's lower-left corner onto Paper.
     */
    rankIt('film-1', 'movies');
    const view = await openOn(completeFilm, 'Inception');
    await waitFor(() => expect(view.getByText('10.0', hidden)).toBeTruthy());

    const column = view.getByTestId('title-poster-column');
    const anchor = within(column).getByTestId('title-score-anchor');
    const style = flat(anchor.props.style);

    expect(style.position).toBe('absolute');
    expect(style.left as number).toBeLessThan(0);
    expect(style.bottom as number).toBeLessThan(0);
    // And bounded: the overhang stays inside the 16pt gap between the poster and the
    // identity column, so the badge can neither cover a long title's last words nor take
    // a press meant for the linked series name (review 75). No slop for the same reason.
    expect(style.left as number).toBeGreaterThanOrEqual(-16);
    expect(view.getByTestId('personal-score').props.hitSlop).toBeUndefined();
    // Ownership in words, beneath the number, inside the same object.
    expect(within(anchor).getByText('Your score')).toBeTruthy();
    expect(view.queryByText('YOU')).toBeNull();
  });

  it('draws an empty ring for an unranked title, with no word inside it', async () => {
    // The word "Rank" inside the circle duplicated the button beside it. The honest
    // statement of "no score yet" is the empty dashed ring; the invitation is the button.
    const view = await openOn(completeFilm, 'Inception');

    const score = view.getByTestId('personal-score');
    expect(within(score).queryByText('Rank', hidden)).toBeNull();
    expect(within(score).queryByText(/\d\.\d/, hidden)).toBeNull();
    expect(view.getByLabelText('You have not ranked this yet')).toBeTruthy();
    expect(view.getByTestId('title-action-rank')).toBeTruthy();
  });
});

describe('the ranking menu, in the founder’s words', () => {
  it('names the three intents Rank it again, Log another watch and Change your rating', async () => {
    /**
     * Labels only (founder, 2026-09-07). *Adjust placement* named the mechanism and *I
     * watched it again* was a confession; these name the act in the verbs the rest of the
     * app uses. The rows' modes, RPCs and `p_new_watch` are pinned unchanged by the two
     * tests in "the action group" above.
     */
    rankIt('film-1', 'movies');
    const view = await openOn(completeFilm, 'Inception');

    await waitFor(() => expect(view.getByTestId('title-action-ranked')).toBeTruthy());
    await fireEvent.press(view.getByTestId('title-action-ranked'));

    expect(view.getByText('Rank it again')).toBeTruthy();
    expect(view.getByText('Log another watch')).toBeTruthy();
    expect(view.getByText('Change your rating')).toBeTruthy();
    expect(view.queryByText('Adjust placement')).toBeNull();
    expect(view.queryByText('I watched it again')).toBeNull();
  });
});
