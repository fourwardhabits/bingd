import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import TitleScreen from '../../../app/title/[id]';

/**
 * The Similar tab.
 *
 * Its own file rather than another thousand lines on `TitleScreen.test.tsx`, because the
 * questions it asks need a mock that records *what was read* and not merely how often —
 * "the facet was not asked for before the tab was opened" is a claim about a filter, and
 * the shared harness there only counts reads per table.
 *
 * What is pinned here, in the order the feature was specified:
 *
 *   - the tab is last, and nothing is fetched until somebody opens it;
 *   - the page's own title, duplicates and unresolvable ids are out, and the budget holds;
 *   - a candidate the reader has already ranked stays, with the score they gave it;
 *   - a season asks its **parent series'** facet and gets series back, never a Season 1;
 *   - taste reorders within the provider's list and never adds to it;
 *   - loading, empty and a provider refusal each leave the page usable.
 */

const mockPush = jest.fn();

/** Every read, with the filters it carried. A claim about *what* was asked, not how much. */
type Read = { table: string; filters: Record<string, unknown> };
const reads: Read[] = [];
const tableRows: Record<string, unknown[]> = {};
/** Tables whose read comes back as a PostgREST error, for the degradation tests. */
const mockFailTables = new Set<string>();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const failure = () => (mockFailTables.has(table) ? { message: `${table} unavailable` } : null);
      const rows = () => {
        reads.push({ table, filters: { ...filters } });
        return (tableRows[table] ?? []).filter((row) => {
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
        // Deliberately not a filter. PostgREST would narrow here; the hook under test
        // rebuilds its order and its membership from the facet's own id list, so leaving
        // this wide is what proves the walk rather than the request is doing that work.
        in: () => chain,
        filter: () => chain,
        order: () => chain,
        limit: () => chain,
        gt: () => chain,
        single: () =>
          Promise.resolve({ data: rows()[0] ?? null, error: failure() }),
        maybeSingle: () =>
          Promise.resolve({ data: rows()[0] ?? null, error: failure() }),
        then: (resolve: (value: unknown) => unknown) => {
          const data = rows();
          return Promise.resolve({
            data,
            error: failure(),
            count: data.length,
          }).then(resolve);
        },
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

let mockOpenId = 'film-1';
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useLocalSearchParams: () => ({ id: mockOpenId }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

// Enrichment is not what this file is about, and an unmocked one would reach the adapter
// on every render.
jest.mock('@/features/title/use-enrichment', () => ({
  useTitleEnrichment: () => ({ enriching: false }),
  seasonListIsStale: () => false,
}));

/** The one provider call the tab can make, and the only thing it is allowed to cost. */
const mockCacheSimilar = jest.fn();
const mockFetchWatchProviders = jest.fn();
const mockFetchSeasonEpisodes = jest.fn();
jest.mock('@/lib/tmdb-adapter', () => ({
  ...jest.requireActual('@/lib/tmdb-adapter'),
  cacheSimilar: (...args: unknown[]) => mockCacheSimilar(...args),
  fetchWatchProviders: (...args: unknown[]) => mockFetchWatchProviders(...args),
  fetchSeasonEpisodes: (...args: unknown[]) => mockFetchSeasonEpisodes(...args),
}));

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({
  ...jest.requireActual('@/lib/analytics'),
  track: (event: unknown) => mockTrack(event),
}));

jest.mock('expo-localization', () => ({ getLocales: () => [{ regionCode: 'US' }] }));

jest.mock('react-native/Libraries/Linking/Linking', () => ({
  __esModule: true,
  default: {
    openURL: () => {},
    addEventListener: () => ({ remove: () => {} }),
    getInitialURL: () => Promise.resolve(null),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const film = {
  id: 'film-1',
  kind: 'movie',
  title: 'Inception',
  release_date: '2010-07-16',
  runtime_minutes: 148,
  overview: 'A thief who steals corporate secrets through dream-sharing technology.',
  poster_path: null,
  backdrop_path: null,
  genres: ['Science Fiction', 'Action'],
  provenance: 'tmdb',
  tmdb_id: 27205,
  original_language: 'en',
  popularity: 90,
  parent: null,
};

/**
 * A candidate film.
 *
 * `popularity` is flat across the set unless a test moves it, so the popularity prior
 * cannot separate two candidates by accident and an assertion about order is an assertion
 * about the term the test is actually interested in.
 */
const candidate = (
  n: number,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  id: `cand-${n}`,
  kind: 'movie',
  title: `Candidate ${n}`,
  release_date: `20${10 + n}-01-01`,
  runtime_minutes: 100,
  overview: null,
  poster_path: `/p${n}.jpg`,
  backdrop_path: null,
  genres: ['Science Fiction'],
  provenance: 'tmdb',
  tmdb_id: 1000 + n,
  original_language: 'en',
  popularity: 50,
  parent: null,
  ...overrides,
});

/** A fresh `similar` facet on `mediaItemId`, holding `ids` in the provider's order. */
const facet = (mediaItemId: string, ids: string[]) => ({
  media_item_id: mediaItemId,
  facet: 'similar',
  payload: { ids },
  expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
});

const HOUR = 3600_000;

beforeEach(() => {
  mockOpenId = 'film-1';
  mockPush.mockReset();
  mockTrack.mockReset();
  mockCacheSimilar.mockReset();
  mockCacheSimilar.mockResolvedValue({ id: 'film-1', written: 0 });
  mockFetchWatchProviders.mockReset();
  mockFetchWatchProviders.mockResolvedValue({ region: 'US', link: null, providers: [] });
  mockFetchSeasonEpisodes.mockReset();
  mockFetchSeasonEpisodes.mockResolvedValue([]);

  reads.length = 0;
  mockFailTables.clear();
  for (const key of Object.keys(tableRows)) delete tableRows[key];
  tableRows.media_items = [film];
  tableRows.user_media = [];
  tableRows.rankings = [];
  tableRows.watchlist = [];
  tableRows.media_cache = [];
  tableRows.watch_tags = [];
  tableRows.public_profiles = [];
});

/**
 * The page, waited for on the tab row rather than on a heading.
 *
 * Similar is on every kind of title, so this is one wait that works for a film, a series
 * and a season — including the malformed season below, whose heading depends on a parent
 * embed that deliberately did not come back.
 */
const open = async () => {
  const view = await renderWithProviders(<TitleScreen />);
  await waitFor(() => expect(view.getByRole('tab', { name: 'Similar' })).toBeTruthy());
  return view;
};

type View = Awaited<ReturnType<typeof open>>;

/**
 * The text a node renders, joined.
 *
 * A tab's accessible name comes from its child `Text` rather than from an
 * `accessibilityLabel` — `SegmentedTabs` only sets one where the label carries a glyph —
 * so an assertion about the tab *row* has to read the tree. Children only: a node's props
 * carry React context objects that close a circle and `JSON.stringify` throws on them.
 */
const textOf = (node: unknown): string => {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  const children = (node as { children?: unknown[] } | null)?.children;
  return Array.isArray(children) ? children.map(textOf).join('') : '';
};

/** How many times the `similar` facet itself was read, whoever it was read for. */
const facetReads = () =>
  reads.filter((read) => read.table === 'media_cache' && read.filters.facet === 'similar');

/**
 * The candidate names the grid is showing, in the order it is showing them.
 *
 * `PosterGrid` draws no text — that is its whole design, and its own header says why —
 * so a tile is only readable through the accessibility label it exists to carry. The
 * label is `title, year[, scored N out of 10]`, which is also why the score assertions
 * below read the label rather than hunting for a chip.
 */
const shown = (view: View) =>
  view
    .getAllByRole('button')
    .map((node) => String(node.props.accessibilityLabel ?? ''))
    .filter((label) => label.startsWith('Candidate '));

const names = (view: View) => shown(view).map((label) => label.split(',')[0]);

/** The first tile in the grid, as something pressable. */
const firstTile = (view: View) => {
  const [label] = shown(view);
  if (!label) throw new Error('the grid is empty');
  return view.getByLabelText(label);
};

const openSimilar = async (view: View) => {
  await fireEvent.press(view.getByRole('tab', { name: 'Similar' }));
};

// ---------------------------------------------------------------------------
// A film
// ---------------------------------------------------------------------------

describe('Similar, on a film', () => {
  const three = [candidate(1), candidate(2), candidate(3)];

  const withFacet = (ids: string[], rows = three) => {
    tableRows.media_items = [film, ...rows];
    tableRows.media_cache = [facet('film-1', ids)];
  };

  it('is the last tab, after Details', async () => {
    const view = await open();

    const labels = view.getAllByRole('tab').map(textOf);
    expect(labels[labels.length - 1]).toBe('Similar');
    expect(labels).toContain('Details');
  });

  it('asks for nothing until somebody opens it', async () => {
    // The whole point of the lazy gate. A cold facet is the expensive case — it is the
    // one that would spend a provider request — so it is the one the assertion uses.
    tableRows.media_items = [film, ...three];

    await open();

    expect(facetReads()).toHaveLength(0);
    expect(mockCacheSimilar).not.toHaveBeenCalled();
  });

  it('spends exactly one provider request when the facet is cold', async () => {
    tableRows.media_items = [film, ...three];
    // The adapter writes the facet, and the hook re-reads it. Both halves are here so
    // the count below is of a *completed* fill rather than of a failed one.
    mockCacheSimilar.mockImplementation(async () => {
      tableRows.media_cache = [facet('film-1', ['cand-1', 'cand-2', 'cand-3'])];
      return { id: 'film-1', written: 3 };
    });

    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(names(view)).toHaveLength(3));
    expect(mockCacheSimilar).toHaveBeenCalledTimes(1);
    expect(mockCacheSimilar).toHaveBeenCalledWith('film-1');
  });

  it('asks the provider for nothing when the facet is already warm', async () => {
    withFacet(['cand-1', 'cand-2', 'cand-3']);

    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(names(view)).toHaveLength(3));
    expect(mockCacheSimilar).not.toHaveBeenCalled();
  });

  it('refills a facet whose week has run out', async () => {
    tableRows.media_items = [film, ...three];
    tableRows.media_cache = [
      {
        ...facet('film-1', ['cand-1']),
        expires_at: new Date(Date.now() - HOUR).toISOString(),
      },
    ];
    mockCacheSimilar.mockImplementation(async () => {
      tableRows.media_cache = [facet('film-1', ['cand-1', 'cand-2'])];
      return { id: 'film-1', written: 2 };
    });

    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(names(view)).toEqual(['Candidate 1', 'Candidate 2']));
  });

  it('treats an empty list as an answer rather than as a cold cache', async () => {
    // TMDB genuinely associates nothing with plenty of obscure titles and the adapter
    // caches that fact deliberately. Asking again would spend a request per open for ever.
    withFacet([]);

    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(view.getByText('No similar titles yet')).toBeTruthy());
    expect(mockCacheSimilar).not.toHaveBeenCalled();
  });

  it('never lists the title the reader is already on', async () => {
    withFacet(['film-1', 'cand-1', 'cand-2']);

    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(names(view)).toEqual(['Candidate 1', 'Candidate 2']));
  });

  it('shows a repeated id once', async () => {
    withFacet(['cand-1', 'cand-2', 'cand-1']);

    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(names(view)).toEqual(['Candidate 1', 'Candidate 2']));
  });

  it('drops an id the catalogue cannot resolve', async () => {
    // A row lost to the six-month retention window, or one of the other kind. The facet
    // is a list of ids and nothing guarantees every one of them is still a row.
    withFacet(['cand-1', 'ghost-1', 'cand-2']);

    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(names(view)).toEqual(['Candidate 1', 'Candidate 2']));
  });

  it('draws nine at most, however many the provider returned', async () => {
    const twenty = Array.from({ length: 20 }, (_, index) => candidate(index + 1));
    withFacet(
      twenty.map((row) => row.id as string),
      twenty,
    );

    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(names(view).length).toBeGreaterThan(0));
    // Three across, so nine is exactly three rows and the tab ends where the screen does.
    expect(names(view)).toHaveLength(9);
  });

  it('keeps a film the reader has already ranked, and says what they gave it', async () => {
    // For You excludes the whole collection; this tab does not. "What else is like this"
    // is answered well by a film the reader loved, and the chip is what says so.
    withFacet(['cand-1', 'cand-2']);
    tableRows.rankings = [
      {
        user_id: 'user-1',
        media_item_id: 'cand-1',
        bucket: 'loved',
        position: 1,
        category: 'movies',
        created_at: '2026-01-01T00:00:00Z',
        media_items: candidate(1),
      },
    ];

    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(names(view)).toContain('Candidate 1'));
    await waitFor(() =>
      // `formatScore`'s one decimal, which is the string the Collection wall and the hero
      // already print. Nothing is formatted specially for this tab.
      expect(shown(view).find((label) => label.startsWith('Candidate 1'))).toMatch(
        /scored 10\.0 out of 10/,
      ),
    );
  });

  it('opens a candidate as an ordinary title page', async () => {
    withFacet(['cand-1', 'cand-2']);

    const view = await open();
    await openSimilar(view);
    await waitFor(() => expect(names(view)).toHaveLength(2));
    await fireEvent.press(firstTile(view));

    expect(mockPush).toHaveBeenCalledWith('/title/cand-1');
  });

  it('says so quietly when the provider refuses, and leaves the page working', async () => {
    // The hourly ceiling is a real refusal and it is about the *account*, not about this
    // film. It must never reach the route's error boundary: everything above the tab row
    // is the reader's own data and TMDB has no opinion about any of it.
    tableRows.media_items = [film, ...three];
    mockCacheSimilar.mockRejectedValue(new Error('BG429'));

    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(view.getByText('Could not load similar titles')).toBeTruthy());
    // The page itself, still there.
    expect(view.getByText(/^Inception/)).toBeTruthy();
    expect(view.getByRole('tab', { name: 'Details' })).toBeTruthy();
  });

  it('shows the list skeleton while the facet is still being filled', async () => {
    tableRows.media_items = [film, ...three];
    // Never settles, which is the only way to observe a pending state that otherwise
    // resolves in the same microtask as the call.
    mockCacheSimilar.mockImplementation(() => new Promise(() => {}));

    const view = await open();
    await openSimilar(view);

    await waitFor(() =>
      expect(view.getAllByTestId('skeleton-row', { includeHiddenElements: true }).length)
        .toBeGreaterThan(0),
    );
  });
});

// ---------------------------------------------------------------------------
// Television
// ---------------------------------------------------------------------------

/**
 * The half that needed a decision rather than an implementation.
 *
 * TMDB's recommendations are **series-level** and Bingd's rankable unit is the season, so
 * the only two honest options were to answer a season page from its parent or not to
 * answer it at all. The adapter already made that choice server-side in `handleSimilar`;
 * these pin the client half of it, and in particular that nothing anywhere picks a
 * season out of a similar series.
 */
describe('Similar, on television', () => {
  const series = {
    ...film,
    id: 'series-1',
    kind: 'series',
    title: 'Breaking Bad',
    release_date: '2008-01-20',
    runtime_minutes: null,
  };

  const season = {
    ...film,
    id: 'season-1',
    kind: 'season',
    title: 'Season 1',
    season_number: 1,
    release_date: '2008-01-20',
    runtime_minutes: null,
    parent_id: 'series-1',
    parent: {
      id: 'series-1',
      title: 'Breaking Bad',
      poster_path: null,
      backdrop_path: null,
      genres: ['Drama'],
      original_language: 'en',
      certification: 'TV-MA',
    },
  };

  /** A similar *show*. Never a season: the adapter normalises every association to one. */
  const show = (n: number) =>
    candidate(n, { kind: 'series', title: `Candidate ${n}`, runtime_minutes: null });

  it('answers a season page out of its parent series facet', async () => {
    mockOpenId = 'season-1';
    tableRows.media_items = [season, show(1), show(2)];
    tableRows.media_cache = [facet('series-1', ['cand-1', 'cand-2'])];

    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(names(view)).toEqual(['Candidate 1', 'Candidate 2']));
    // The series', and never the season's own — TMDB has no season-level recommendations.
    expect(facetReads().map((read) => read.filters.media_item_id)).toEqual(['series-1']);
  });

  it('hands the adapter the season, which is the call the server documents', async () => {
    mockOpenId = 'season-1';
    tableRows.media_items = [season, show(1)];
    mockCacheSimilar.mockImplementation(async () => {
      tableRows.media_cache = [facet('series-1', ['cand-1'])];
      return { id: 'series-1', written: 1 };
    });

    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(names(view)).toEqual(['Candidate 1']));
    // `handleSimilar` resolves the season to its series itself, and writes the facet on
    // the series row. Resolving it twice is how the two halves drift apart.
    expect(mockCacheSimilar).toHaveBeenCalledWith('season-1');
  });

  it('never turns a similar show into one of its seasons', async () => {
    // The rule this feature was specified around. A discovery card is the show; which
    // season somebody wants is a question the show's own page asks.
    mockOpenId = 'season-1';
    tableRows.media_items = [
      season,
      show(1),
      // A season of the candidate show, sitting in the catalogue exactly as it would in
      // production. Nothing may reach for it.
      {
        ...candidate(9),
        id: 'cand-1-s1',
        kind: 'season',
        title: 'Season 1',
        season_number: 1,
        parent_id: 'cand-1',
      },
    ];
    tableRows.media_cache = [facet('series-1', ['cand-1'])];

    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(names(view)).toEqual(['Candidate 1']));
    await fireEvent.press(firstTile(view));

    // The series id. Which is the existing series page, whose first tab is Seasons — the
    // flow the app already has, rather than a second one that picks for the reader.
    expect(mockPush).toHaveBeenCalledWith('/title/cand-1');
    expect(mockPush).not.toHaveBeenCalledWith('/title/cand-1-s1');
  });

  it('never lists a film under a show', async () => {
    mockOpenId = 'series-1';
    tableRows.media_items = [series, show(1), candidate(2)];
    tableRows.media_cache = [facet('series-1', ['cand-1', 'cand-2'])];

    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(names(view)).toEqual(['Candidate 1']));
  });

  it('degrades to an empty tab when a season has no parent to ask about', async () => {
    // Malformed rather than impossible: `parent_id` is `not null` by constraint, but the
    // embed is a read that can come back without it. The alternative to an empty tab
    // would be asking TMDB a /tv question about a season id, which is the wrong answer
    // delivered confidently.
    mockOpenId = 'season-1';
    tableRows.media_items = [{ ...season, parent: null }, show(1)];
    tableRows.media_cache = [facet('series-1', ['cand-1'])];

    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(view.getByText('No similar titles yet')).toBeTruthy());
    expect(mockCacheSimilar).not.toHaveBeenCalled();
    expect(facetReads()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Taste
// ---------------------------------------------------------------------------

/**
 * What personalisation is allowed to do here, and what it is not.
 *
 * It reorders. It does not widen: the candidate set is the provider's association list,
 * which is what keeps this a Similar tab rather than a second For You. `rank.ts`'
 * `scoreCandidate` is reused unchanged with the source title as the single anchor — see
 * `use-similar-titles.ts` for why the anchor's score is a flat 10.
 */
describe('the reader’s taste', () => {
  const horror = candidate(1, { genres: ['Horror'], title: 'Candidate 1' });
  const comedy = candidate(2, { genres: ['Comedy'], title: 'Candidate 2' });

  const ranked = (mediaItemId: string, genres: string[]) => ({
    user_id: 'user-1',
    media_item_id: mediaItemId,
    bucket: 'loved',
    position: 1,
    category: 'movies',
    created_at: '2026-01-01T00:00:00Z',
    media_items: {
      id: mediaItemId,
      kind: 'movie',
      title: 'Something Ranked',
      release_date: '2020-01-01',
      poster_path: null,
      genres,
      runtime_minutes: 100,
      original_language: 'en',
      parent_id: null,
      parent: null,
    },
  });

  beforeEach(() => {
    tableRows.media_items = [film, horror, comedy];
    // The provider's order: horror first.
    tableRows.media_cache = [facet('film-1', ['cand-1', 'cand-2'])];
  });

  it('keeps the provider order for a reader who has ranked nothing', async () => {
    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(names(view)).toEqual(['Candidate 1', 'Candidate 2']));
  });

  it('lifts a candidate that matches what the reader has ranked', async () => {
    // A comedy collection, and a comedy that TMDB put second. Nothing else separates the
    // two — same popularity, same language, adjacent provider positions.
    tableRows.rankings = [
      ranked('ranked-1', ['Comedy']),
      ranked('ranked-2', ['Comedy']),
      ranked('ranked-3', ['Comedy']),
    ];

    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(names(view)).toEqual(['Candidate 2', 'Candidate 1']));
  });

  it('reorders only within the provider list and never adds to it', async () => {
    // The failure this guards against is the tab quietly becoming For You. `trend-1` is a
    // perfect taste match sitting in the catalogue, and it is not in the facet — so it
    // must not appear however well it would score.
    tableRows.media_items = [
      film,
      horror,
      comedy,
      candidate(3, { id: 'trend-1', title: 'Candidate 3', genres: ['Comedy'] }),
    ];
    tableRows.rankings = [ranked('ranked-1', ['Comedy'])];

    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(names(view)).toHaveLength(2));
    expect(names(view)).not.toContain('Candidate 3');
  });

  it('draws the grid in provider order when the ranked read fails', async () => {
    // Taste is an ordering input, not a gate. A reader whose collection will not load
    // still gets TMDB's own relevance order rather than a skeleton or an error — which
    // is why the two ranked reads are deliberately outside this tab's pending and error
    // states. Comedy rankings are present and unreachable, so a passing assertion here
    // cannot be the no-rankings case above wearing a different name.
    tableRows.rankings = [ranked('ranked-1', ['Comedy'])];
    mockFailTables.add('rankings');

    const view = await open();
    await openSimilar(view);

    await waitFor(() => expect(names(view)).toEqual(['Candidate 1', 'Candidate 2']));
  });
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

describe('what the tab reports', () => {
  beforeEach(() => {
    tableRows.media_items = [film, candidate(1)];
    tableRows.media_cache = [facet('film-1', ['cand-1'])];
  });

  it('records the open, with which medium it was', async () => {
    const view = await open();
    await openSimilar(view);

    expect(mockTrack).toHaveBeenCalledWith({
      name: 'similar_tab_opened',
      props: { medium: 'movies' },
    });
  });

  it('records a title opened from it, and whether taste had moved the order', async () => {
    const view = await open();
    await openSimilar(view);
    await waitFor(() => expect(names(view)).toHaveLength(1));
    await fireEvent.press(firstTile(view));

    expect(mockTrack).toHaveBeenCalledWith({
      name: 'similar_title_opened',
      // False is the shipped path for a reader with no rankings, not a failure.
      props: { medium: 'movies', personalized: false },
    });
  });
});
