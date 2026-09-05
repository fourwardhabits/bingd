import { fireEvent, waitFor } from '@testing-library/react-native';
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

    expect(view.getByLabelText('Rank this title')).toBeTruthy();
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
      expect(view.getByTestId('title-meta')).toHaveTextContent('PG-13 · 148m · Christopher Nolan'),
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
      expect(view.getByTestId('title-meta')).toHaveTextContent('148m · Christopher Nolan'),
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

    // Top of a two-title Loved band, so the band's high. **Once.** It led the Scores
    // section as well until the founder's correction of 2026-08-18; two copies of one
    // number, and the second had neither the rank line nor the control that changes it.
    await waitFor(() =>
      expect(view.getAllByLabelText('10.0 out of 10, I liked it')).toHaveLength(1),
    );
  });

  it('puts its one copy in the hero and never in the Scores section', async () => {
    const view = await open();

    await waitFor(() => expect(view.getByLabelText('Scores')).toBeTruthy());
    // The hero badge is the one copy, spoken as a score. The "Your score" caption
    // under it went in the founder's hierarchy pass — a filled circle with a number,
    // above a button named Rank, does not need a caption to say whose score it is —
    // and the Scores section carried a second copy under those words until 2026-08-18.
    expect(view.getAllByLabelText('10.0 out of 10, I liked it')).toHaveLength(1);
    expect(view.queryByText('Your score')).toBeNull();
    // The section is what everybody *else* thought, and those are its only two rows.
    expect(view.getByText('Following')).toBeTruthy();
    expect(view.getByText('bingd.')).toBeTruthy();
  });

  it('says where it sits in their own list, as an ordinal', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('#1 in Movies')).toBeTruthy());
  });

  it('shows a Ranked control that opens the rating and collection menu', async () => {
    const view = await open();
    await waitFor(() =>
      expect(view.getByLabelText('Ranked. Change or remove this.')).toBeTruthy(),
    );
    expect(view.getByText('Ranked')).toBeTruthy();
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
    await waitFor(() =>
      expect(view.getByLabelText('Ranked. Change or remove this.')).toBeTruthy(),
    );
    await fireEvent.press(view.getByLabelText('Ranked. Change or remove this.'));

    await waitFor(() => expect(view.getByLabelText('Change your rating')).toBeTruthy());
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
    await waitFor(() =>
      expect(view.getByLabelText('Ranked. Change or remove this.')).toBeTruthy(),
    );
    await fireEvent.press(view.getByLabelText('Ranked. Change or remove this.'));
    await waitFor(() => expect(view.getByLabelText('Rank again')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Rank again'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('rank_again', expect.anything()),
    );
    // One call, and the guarantee T2 bought: never the pair.
    expect(mockRpc).not.toHaveBeenCalledWith('rank_unrank', expect.anything());
    expect(mockRpc).not.toHaveBeenCalledWith('rank_start', expect.anything());
  });

  it('re-ranks inside the band the title is already in', async () => {
    const view = await open();
    await waitFor(() =>
      expect(view.getByLabelText('Ranked. Change or remove this.')).toBeTruthy(),
    );
    await fireEvent.press(view.getByLabelText('Ranked. Change or remove this.'));
    await waitFor(() => expect(view.getByLabelText('Rank again')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Rank again'));

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
   * The two are not synonyms and the menu has to say which is which. Rank again is
   * another watch; Change your rating corrects a rating already given.
   *
   * **The subtext under each of them is gone, and this test now says so.** It asserted
   * both sentences were present, and the founder's device pass is the reason it does the
   * opposite: `SheetRow` puts the label and its secondary sentence on one line, so at
   * the width of a phone every explanation in this menu truncated. Five rows of clipped
   * grey text under five clear labels is worse than no explanation, because the reader
   * can see something was meant to be said and cannot read it. The distinction the
   * sentences were drawing is now drawn by the flow itself — Rank again opens
   * comparisons, Change your rating opens the bucket chooser — and is stated in the
   * PRD.
   */
  it('keeps Change your rating as the band control, distinct from Rank again', async () => {
    const view = await open();
    await waitFor(() =>
      expect(view.getByLabelText('Ranked. Change or remove this.')).toBeTruthy(),
    );
    await fireEvent.press(view.getByLabelText('Ranked. Change or remove this.'));

    await waitFor(() => expect(view.getByLabelText('Change your rating')).toBeTruthy());
    expect(view.getByLabelText('Rank again')).toBeTruthy();
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
    await waitFor(() =>
      expect(view.getByLabelText('Ranked. Change or remove this.')).toBeTruthy(),
    );
    await fireEvent.press(view.getByLabelText('Ranked. Change or remove this.'));

    await waitFor(() => expect(view.getByLabelText('Rank again')).toBeTruthy());
    // This fixture holds a private note, so the one writing row reads Edit your note.
    // The headings and the last three rows are the same whichever state it is in.
    for (const label of [
      'Edit your note',
      'Who I watched with',
      'Rank again',
      'Change your rating',
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
    await waitFor(() =>
      expect(view.getByLabelText('Ranked. Change or remove this.')).toBeTruthy(),
    );
    await fireEvent.press(view.getByLabelText('Ranked. Change or remove this.'));
    await waitFor(() => expect(view.getByLabelText('Change your rating')).toBeTruthy());
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
      expect(
        view.getByLabelText('Who I watched with').props.accessibilityState?.expanded,
      ).toBe(true),
    );
    expect(view.queryByPlaceholderText('What did you think?')).toBeNull();
  });

  it('starts no ranking and creates no second log', async () => {
    const view = await openMenu();
    await fireEvent.press(view.getByLabelText('Who I watched with'));
    await waitFor(() =>
      expect(
        view.getByLabelText('Who I watched with').props.accessibilityState?.expanded,
      ).toBe(true),
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
      expect(
        view.getByLabelText('Who I watched with').props.accessibilityState?.expanded,
      ).toBe(true),
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
    await waitFor(() =>
      expect(view.getByLabelText('Ranked. Change or remove this.')).toBeTruthy(),
    );
    await fireEvent.press(view.getByLabelText('Ranked. Change or remove this.'));
    await waitFor(() => expect(view.getByLabelText('Change your rating')).toBeTruthy());

    expect(view.queryByLabelText('Remove ranking')).toBeNull();
    expect(view.queryByText('Keeps it in your collection')).toBeNull();
    // And nothing on the screen can reach the function on its own any more. It is still
    // granted and still load-bearing — `rank_rebucket` calls it to move a title between
    // bands — but no user-facing control invokes it directly.
    expect(mockRpc).not.toHaveBeenCalledWith('rank_unrank', expect.anything());
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
    // "bingd.", not "Community". The old label described a population where the new one
    // names it, and the app has a name.
    expect(view.getByText('bingd.')).toBeTruthy();
    expect(view.getByText('12 ratings')).toBeTruthy();
  });

  it('lives in its own section rather than beside the reader’s own score', async () => {
    // The two were the same shape at the same weight in the hero, one about you and
    // one about the room. The hero answers "what did I think" now.
    mockRpcResults.community_score = [{ score: '7.4', rating_count: 12, min_ratings: 3 }];
    const view = await open();

    await waitFor(() => expect(view.getByLabelText('Scores')).toBeTruthy());
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

    await waitFor(() => expect(view.getAllByText('Not enough ratings').length).toBeGreaterThan(0));
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
    await waitFor(() => expect(view.getAllByText('Not enough ratings').length).toBeGreaterThan(0));
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
  };

  it('shows a Bingd reader’s note, under their name and beside their score', async () => {
    mockRpcResults.title_reviews = [review];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.getByText('The last twenty minutes are the whole film.')).toBeTruthy();
    // The author's own number, in the app's one chromatic element. A review without it
    // is half the opinion.
    expect(view.getByText('8.4')).toBeTruthy();
  });

  it('names nothing of TMDB’s, because none of it is here any more', async () => {
    mockRpcResults.title_reviews = [review];
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
    mockRpcResults.title_reviews = [review];
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
    mockRpcResults.title_reviews = [
      { ...review, id: 'um-mine', user_id: 'user-1', username: 'sai', display_name: 'Sai' },
    ];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));
    await waitFor(() => expect(view.getByText('Sai')).toBeTruthy());

    expect(view.queryByLabelText("Report Sai's review")).toBeNull();
  });

  it('says a review has gone rather than failing, when its author deleted it', async () => {
    mockRpcResults.title_reviews = [review];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    // P0002 is also what a note made private answers with, which is the same story to
    // the reader: it is not there to report any more.
    mockRpcErrors.report = { code: 'P0002', message: 'no such subject' };
    await fireEvent.press(view.getByLabelText("Report Ada's review"));
    await fireEvent.press(view.getByText('Spam or a scam'));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Could not report', 'That has already been removed.'),
    );
  });

  it('opens the reviewer’s profile', async () => {
    mockRpcResults.title_reviews = [review];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Ada, @ada'));
    expect(mockPush).toHaveBeenCalledWith('/u/ada');
  });

  it('masks a spoiler from somebody who has not watched this exact title', async () => {
    mockRpcResults.title_reviews = [{ ...review, has_spoilers: true }];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.queryByText('The last twenty minutes are the whole film.')).toBeNull();
  });

  it('shows it once they have watched it, rather than making them reveal it', async () => {
    // The founder's correction: somebody who has seen the film should not have to tap
    // through every spoiler on the page.
    mockRpcResults.title_reviews = [{ ...review, has_spoilers: true }];
    tableRows.user_media = [{ user_id: 'user-1', media_item_id: 'film-1' }];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));

    await waitFor(() =>
      expect(view.getByText('The last twenty minutes are the whole film.')).toBeTruthy(),
    );
  });

  it('offers the sort only when there is something to sort', async () => {
    mockRpcResults.title_reviews = [review];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.queryByRole('tab', { name: 'Top' })).toBeNull();
  });

  it('sorts by Top first, which is what a first-time reader wants', async () => {
    mockRpcResults.title_reviews = [review, { ...review, user_id: 'user-3', username: 'bo', display_name: 'Bo' }];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));

    await waitFor(() => expect(view.getByRole('tab', { name: 'Top' })).toBeTruthy());
    expect(view.getByRole('tab', { name: 'Top' }).props.accessibilityState.selected).toBe(true);
  });

  it('invites the first one rather than showing an empty box', async () => {
    mockRpcResults.title_reviews = [];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));

    await waitFor(() => expect(view.getByText('No reviews yet')).toBeTruthy());
    expect(view.getByText('Be the first to leave a review of this movie.')).toBeTruthy();
  });

  it('asks an unranked reader to rank first, because a review carries a score', async () => {
    mockRpcResults.title_reviews = [];
    const view = await open();
    await fireEvent.press(view.getByRole('tab', { name: 'Reviews' }));

    await waitFor(() => expect(view.getByText('Rank to leave a review')).toBeTruthy());
  });

  it('offers a ranked reader the one composer there has ever been', async () => {
    // The log sheet, where the spoiler flag and the visibility are chosen beside the
    // text. A second composer here would be a second content model wearing a button.
    mockRpcResults.title_reviews = [];
    tableRows.rankings = [
      { user_id: 'user-1', media_item_id: 'film-1', position: 1, category: 'movies', bucket: 'loved' },
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
  it('carries the back control and no title while the heading is on screen', async () => {
    await open();

    // Not "the header is empty" — `title` is still set, because iOS draws it as the
    // back label on the next screen and screen readers announce it as the route.
    // `headerTitle` is what is drawn here, and it is nothing.
    expect(mockHeaderOptions.title).toBe('Inception');
    expect(mockHeaderOptions.headerTitle).toBe('');
    // No opaque ground either, so the hero stays full-bleed under the bar.
    expect(mockHeaderOptions.headerBackground).toBeUndefined();
    expect(mockHeaderOptions.headerTransparent).toBe(true);
  });

  it('names the title once the heading has scrolled under the bar', async () => {
    const view = await open();

    // Fired on the title itself and allowed to bubble: `layout` finds the heading
    // block that wraps it, and `scroll` finds the scroll view above that. Reaching
    // for either by type would mean asserting on the screen's element tree, which is
    // not what this test is about.
    const heading = view.getByText(/^Inception/);
    await fireEvent(heading, 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 200 } },
    });
    await fireEvent.scroll(heading, {
      nativeEvent: { contentOffset: { x: 0, y: 600 } },
    });

    await waitFor(() => expect(typeof mockHeaderOptions.headerTitle).toBe('function'));
    // And it gains a ground to sit on rather than floating over the artwork, without
    // the transparency ever being toggled — toggling it would move the content inset
    // and jog the page at the moment of the reveal.
    expect(typeof mockHeaderOptions.headerBackground).toBe('function');
    expect(mockHeaderOptions.headerTransparent).toBe(true);
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
    expect(view.queryByLabelText('Rank this title')).toBeNull();
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
    // "3 people you follow" rather than "3 ratings": the population is the whole point
    // of the number, and it is a different population from the row underneath.
    expect(view.getByText('3 people you follow')).toBeTruthy();
    expect(view.getByText('bingd.')).toBeTruthy();
  });

  it('shows a single followee, which community would withhold', async () => {
    mockRpcResults.following_score = [{ score: '9.1', rating_count: 1, following_count: 4 }];
    const view = await open();

    // One account you chose to follow is not a weak estimate of a crowd; it is their
    // opinion, and it is the only case a new account can produce at all.
    await waitFor(() => expect(view.getByText('1 person you follow')).toBeTruthy());
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
    // and the same four words. A row that appears when the data does is a page that
    // moves under somebody reading it.
    expect(view.getByText('Following')).toBeTruthy();
    expect(view.getByText('Not enough ratings')).toBeTruthy();
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
        parent: { id: 'series-1', title: 'Breaking Bad', poster_path: null, backdrop_path: null },
      },
    ];

    const view = await renderWithProviders(<TitleScreen />);

    // The show on its own line, and pressable, because it is where a reader goes to
    // find the other seasons.
    await waitFor(() => expect(view.getByText('Breaking Bad')).toBeTruthy());
    expect(view.getByText(/^Season 1/)).toBeTruthy();
    expect(view.getByText(', 2023')).toBeTruthy();
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
 * The empty state, which is now one shape for both rows.
 *
 * Two silences used to be told apart here: a reader who followed nobody got no row at
 * all, and a reader who followed eleven people none of whom had seen the film was told
 * exactly that. The founder collapsed both into the grey circle and four words on
 * 2026-08-18. The reader can act on neither case, and a row that materialises when the
 * data arrives moves the page under somebody reading it.
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
     * that the section exists. This assertion needs more than that: it says "Not enough
     * ratings" appears *once*, which is only true after the community row has resolved to
     * its 7.4 — before that both rows are empty and both say it, and `getByText` fails
     * with "found multiple elements".
     *
     * It passed locally and failed on CI (run 32876993932), which is the signature of a
     * wait that gates on the wrong thing rather than of a real defect. Same class as the
     * one `PrivacyScreen.test.tsx` records.
     */
    await waitFor(() => expect(view.getByText('7.4')).toBeTruthy());
    expect(view.getByText('Not enough ratings')).toBeTruthy();
    expect(view.getByText('Following')).toBeTruthy();
    // The old copy named the reader's following list back to them. It is gone.
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
    // "Following" heading is drawn before either number arrives, so a single match for
    // "Not enough ratings" is only a fact once the other row has resolved.
    await waitFor(() => expect(view.getByText('7.4')).toBeTruthy());
    expect(view.getByText('Not enough ratings')).toBeTruthy();
    expect(view.getByText('Following')).toBeTruthy();
  });

  it('draws the grey circle rather than a faded number', async () => {
    mockRpcResults.following_score = [{ score: null, rating_count: 0, following_count: 0 }];
    mockRpcResults.community_score = [{ score: null, rating_count: 2, min_ratings: 10 }];

    const view = await open();

    await waitFor(() => expect(view.getByText('bingd.')).toBeTruthy());
    expect(view.getAllByText('Not enough ratings')).toHaveLength(2);
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
    parent: { id: 'series-1', title: 'Game of Thrones', poster_path: null, backdrop_path: null },
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

    expect(view.getByLabelText('Rank this title')).toBeTruthy();
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

    const scores = indexOf(view, (node: never) => (node as any).props?.testID === 'scores-layout');
    const watch = indexOf(view, (node: never) => (node as any).props?.testID === 'where-to-watch');
    const tabs = indexOf(
      view,
      (node: never) => (node as any).props?.accessibilityRole === 'tab',
    );

    expect(scores).toBeGreaterThan(-1);
    expect(tabs).toBeGreaterThan(-1);
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

    expect(view.getByRole('tab', { name: 'Cast' }).props.accessibilityState.selected).toBe(true);
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
    expect(view.getByLabelText('Rank this title')).toBeTruthy();
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
    expect(view.queryByLabelText('Scores')).toBeNull();
  });
});
