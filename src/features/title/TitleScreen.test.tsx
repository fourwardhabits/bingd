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

// The header is a decision this screen makes, so the mock records it rather than
// discarding it. `Stack.Screen` renders nothing either way; the difference is that the
// options it was handed can now be asserted on.
let mockHeaderOptions: Record<string, unknown> = {};
// Which title the screen is opened on. A series and a film are the same route, and the
// difference between them is most of what the seasons flow is about.
let mockOpenId = 'film-1';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useLocalSearchParams: () => ({ id: mockOpenId }),
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
  mockPush.mockReset();
  mockOpenURL.mockReset();
  mockEnrichmentArgs.length = 0;
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

  it('shows a Ranked control that leads back into the rating flow', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByLabelText('Ranked. Change your rating.')).toBeTruthy());
    expect(view.getByText('Ranked')).toBeTruthy();
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

    await waitFor(() => expect(view.getByText('Community')).toBeTruthy());
    // It is a mean. An ordinal is what "#1 in Movies" is, and that is a different
    // line about a different thing.
    expect(view.queryByText(/community rank/i)).toBeNull();
  });

  it('withholds a number the sample cannot support, and says how short it is', async () => {
    mockRpcResults.community_score = [{ score: null, rating_count: 2, min_ratings: 3 }];
    const view = await open();

    await waitFor(() => expect(view.getByText('2 ratings · 1 more needed')).toBeTruthy());
    // Never a zero, and never a real number faded to say "do not trust this".
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

  const season = (n: number) => ({
    id: `season-${n}`,
    parent_id: 'series-1',
    kind: 'season',
    season_number: n,
    title: `Season ${n}`,
    release_date: `${2007 + n}-01-20`,
    poster_path: null,
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

    await waitFor(() => expect(view.getByRole('tab', { name: 'Seasons' })).toBeTruthy());
    expect(view.getByText('Seasons are still loading')).toBeTruthy();
  });
});

/**
 * The Following score (20260816001100) — what the people this reader follows made of
 * this title, above what everybody did.
 *
 * The server owns every rule that matters: approved followees only, `can_view_profile`
 * from the caller's own side, the exact media item, live rankings. `following-score.test.mjs`
 * is where those are asserted. What is asserted here is the screen's part — that it
 * shows the number, names the population honestly, and says nothing at all when the
 * reader's following list has nothing to say.
 */
describe('the following score', () => {
  it('shows it above the community score, with the sample named', async () => {
    mockRpcResults.following_score = [{ score: '8.6', rating_count: 3, following_count: 9 }];
    mockRpcResults.community_score = [{ score: '7.4', rating_count: 12, min_ratings: 3 }];

    const view = await open();

    await waitFor(() => expect(view.getByText('Following')).toBeTruthy());
    expect(view.getByText('8.6')).toBeTruthy();
    // "3 people you follow" rather than "3 ratings": the population is the whole point
    // of the number, and it is a different population from the row underneath.
    expect(view.getByText('3 people you follow')).toBeTruthy();
    expect(view.getByText('Community')).toBeTruthy();
  });

  it('shows a single followee, which community would withhold', async () => {
    mockRpcResults.following_score = [{ score: '9.1', rating_count: 1, following_count: 4 }];
    const view = await open();

    // One account you chose to follow is not a weak estimate of a crowd; it is their
    // opinion, and it is the only case a new account can produce at all.
    await waitFor(() => expect(view.getByText('1 person you follow')).toBeTruthy());
    expect(view.getByText('9.1')).toBeTruthy();
  });

  it('says nothing when nobody the reader follows has ranked it', async () => {
    mockRpcResults.following_score = [{ score: null, rating_count: 0, following_count: 0 }];
    mockRpcResults.community_score = [{ score: '7.4', rating_count: 12, min_ratings: 3 }];

    const view = await open();

    await waitFor(() => expect(view.getByText('Community')).toBeTruthy());
    // Not "No ratings yet". That silence is a fact about the reader's own following
    // list rather than about the film, and it would appear on every title page a new
    // account ever opened.
    expect(view.queryByText('Following')).toBeNull();
  });

  it('never calls it a friend score, because following is not mutual', async () => {
    mockRpcResults.following_score = [{ score: '8.6', rating_count: 3, following_count: 9 }];
    const view = await open();

    await waitFor(() => expect(view.getByText('Following')).toBeTruthy());
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
    expect(view.queryByText('Community')).toBeNull();
  });
});

/**
 * Independent review, 10: omitting the Following row whenever it had no ratings made
 * the feature undiscoverable for precisely the people it is meant to recruit — a new
 * account sees every title page look exactly as it did before following anybody.
 *
 * Two silences, and they are not the same silence.
 */
describe('the following score with nothing to say', () => {
  it('says so, for a reader who follows people', async () => {
    mockRpcResults.following_score = [{ score: null, rating_count: 0, following_count: 11 }];
    mockRpcResults.community_score = [{ score: '7.4', rating_count: 12, min_ratings: 3 }];

    const view = await open();

    await waitFor(() => expect(view.getByText('Following')).toBeTruthy());
    expect(view.getByText('Nobody you follow has ranked this')).toBeTruthy();
  });

  it('draws no row at all for a reader who follows nobody', async () => {
    mockRpcResults.following_score = [{ score: null, rating_count: 0, following_count: 0 }];
    mockRpcResults.community_score = [{ score: '7.4', rating_count: 12, min_ratings: 3 }];

    const view = await open();

    // It could only ever be empty, and drawing it on every title page of a brand-new
    // account is a row that never says anything.
    await waitFor(() => expect(view.getByText('Community')).toBeTruthy());
    expect(view.queryByText('Following')).toBeNull();
  });
});
