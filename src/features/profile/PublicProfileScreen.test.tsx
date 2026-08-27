import { fireEvent, waitFor } from '@testing-library/react-native';
import { Alert, Share, StyleSheet } from 'react-native';

import { theme } from '@/ui/tokens';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import PublicProfileScreen from '../../../app/u/[username]';

const mockPush = jest.fn();
const tableRows: Record<string, unknown[]> = {};
let mockRpcResults: Record<string, unknown> = {};
let mockRpcErrors: Record<string, { code?: string; message: string } | null> = {};
// A fresh id every call, so a held one is visibly held rather than two undefineds
// comparing equal. `expo-crypto` has no native module under jest.
let issued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id-${(issued += 1)}` }));
const mockRpcCalls: { name: string; args: Record<string, unknown> }[] = [];

/**
 * The mock honours its arguments, and that is deliberate.
 *
 * Independent review pointed out that a mock ignoring what it is asked returns the
 * fixture whatever the screen requests — so `useProfileNotes` asking for the
 * *viewer's* notes instead of the subject's would still pass, which is precisely the
 * mutation a privacy test exists to catch. `rpc` records its arguments and `in`
 * filters on the ids it was given.
 */
/**
 * Reporting has no confirmation step and no visible state change, so the alert it
 * raises is the whole of what a test can observe about it.
 */
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpcCalls.push({ name, args });
      const error = mockRpcErrors[name] ?? null;
      return Promise.resolve({ data: error ? null : (mockRpcResults[name] ?? null), error });
    },
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const inFilters: Record<string, unknown[]> = {};
      const rows = () =>
        (tableRows[table] ?? []).filter((row) => {
          const object = row as Record<string, unknown>;
          return (
            Object.entries(filters).every(([key, value]) => object[key] === value) &&
            Object.entries(inFilters).every(([key, values]) => values.includes(object[key]))
          );
        });
      const answer = () =>
        Promise.resolve({ data: rows(), error: null, count: rows().length });
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        in: (column: string, values: unknown[]) => {
          inFilters[column] = values;
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => answer().then(resolve),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

/**
 * The awards sheet, stubbed to record what it was handed.
 *
 * The question this screen has to answer about it is one question — *whose* awards —
 * and rendering the real sheet would answer it through nine reads and a scroll view.
 * The prop is the contract.
 */
let awardsProps: { userId: string } | null = null;
jest.mock('@/features/awards/AwardsSheet', () => ({
  AwardsSheet: (props: { userId: string }) => {
    awardsProps = props;
    return null;
  },
}));

/**
 * `Stack.Screen` renders its `headerRight`, which it did not used to.
 *
 * It was `() => null`, which was fine while the only thing this screen put in the
 * navigation header was a title. Report and Block now live behind a menu in the corner
 * — the same corner the owner's profile keeps its gear and bell in — so a double that
 * throws the options away hides the controls these tests are about. Rendering only
 * `headerRight` rather than pretending to be a navigator: it is the one option with a
 * component in it, and the title is asserted through `options` where it matters.
 */
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useLocalSearchParams: () => ({ username: 'anna' }),
  Stack: {
    Screen: ({ options }: { options?: { headerRight?: () => React.ReactNode } }) =>
      options?.headerRight?.() ?? null,
  },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'viewer', username: 'sai', display_name: 'Sai' }),
}));

const anna = {
  id: 'anna-id',
  username: 'anna',
  display_name: 'Anna',
  avatar_path: null,
  created_at: '2026-01-01T00:00:00Z',
};

const ranking = (id: string, title: string, position: number, over: Record<string, unknown> = {}) => ({
  media_item_id: id,
  bucket: 'loved',
  position,
  category: 'movies',
  user_id: 'anna-id',
  media_items: {
    title,
    release_date: '2010-01-01',
    poster_path: null,
    genres: ['Drama'],
    runtime_minutes: 120,
    kind: 'movie',
    parent: null,
  },
  ...over,
});

beforeEach(() => {
  mockPush.mockReset();
  mockRpcResults = {};
  alertSpy.mockClear();
  mockRpcErrors = {};
  issued = 0;
  mockRpcCalls.length = 0;
  awardsProps = null;
  for (const key of Object.keys(tableRows)) delete tableRows[key];
  tableRows.public_profiles = [anna];
  tableRows.rankings = [];
  tableRows.follows = [];
  tableRows.feed_events = [];
  tableRows.user_media = [];
  tableRows.media_items = [];
  tableRows.watch_tags = [];
  tableRows.watchlist = [];
});

const open = async () => renderWithProviders(<PublicProfileScreen />);

describe('a private account the viewer has found', () => {
  const identity = {
    id: 'anna-id',
    username: 'anna',
    display_name: 'Anna',
    avatar_path: 'anna-id/1.jpg',
    visibility: 'private',
  };

  /**
   * **Discovery is worthless if the row leads nowhere.**
   *
   * `20260819000100` made a private account findable by name. Before this screen
   * existed, tapping one landed on "This profile is not available" — the same answer as
   * a handle nobody has taken — with no way to ask, which turned the private setting
   * from a door into a wall.
   */
  it('draws the identity and a Follow control, with no content', async () => {
    tableRows.public_profiles = [];
    mockRpcResults.profile_identity = [identity];

    const view = await open();

    await waitFor(() => expect(view.getByText('Anna')).toBeTruthy());
    expect(view.getByText('@anna')).toBeTruthy();
    expect(view.getByText('Follow')).toBeTruthy();
    expect(view.getByText('This account is private')).toBeTruthy();
    // Nothing that belongs to the account rather than to its identity.
    expect(view.queryByText('Followers')).toBeNull();
    expect(view.queryByText('Movies')).toBeNull();
  });

  it('does not draw zeros where the counts would be', async () => {
    // Zeros are not "no answer". They are a statement that somebody has no followers
    // and has ranked nothing, told about an account this viewer was never entitled to
    // count — so the row is omitted rather than filled in.
    tableRows.public_profiles = [];
    mockRpcResults.profile_identity = [identity];

    const view = await open();

    await waitFor(() => expect(view.getByText('Anna')).toBeTruthy());
    expect(view.queryByText('0')).toBeNull();
  });

  it('asks for the identity on every profile, not only the ones that came back empty', async () => {
    // A request issued only for private accounts would report somebody's visibility
    // setting to anybody watching the network — which is exactly what answering for
    // public accounts too is there to prevent, server-side and here.
    const view = await open();
    await waitFor(() => expect(view.getByText('@anna')).toBeTruthy());

    expect(mockRpcCalls.some((call) => call.name === 'profile_identity')).toBe(true);
  });
});

describe('a profile the viewer may not see', () => {
  it('answers the same way for a blocked, suspended, or unclaimed handle', async () => {
    // `profile_identity` is silent for all three, and so is `public_profiles`. The
    // screen must not tell them apart: doing so reports a block to the person it was
    // applied to, and a suspension to anybody who asks (PRD §16).
    tableRows.public_profiles = [];
    mockRpcResults.profile_identity = [];
    const view = await open();

    await waitFor(() => expect(view.getByText('This profile is not available.')).toBeTruthy());
    expect(view.queryByText('Anna')).toBeNull();
  });
});

describe('what this person likes', () => {
  beforeEach(() => {
    tableRows.rankings = [
      ranking('a', 'Heat', 1),
      ranking('b', 'Sinners', 2),
    ];
  });

  it('leads with their titles and the scores on them', async () => {
    const view = await open();

    // Uppercasing is a style; the accessible name keeps the spelling, which is
    // what `SectionHeader` exists to get right.
    await waitFor(() => expect(view.getByLabelText('Top ranked')).toBeTruthy());
    // Two loved titles: the top of the band takes 10.0 and the bottom takes 7.0.
    await waitFor(() => expect(view.getAllByLabelText(/10\.0 out of 10/).length).toBeGreaterThan(0));
  });

  it('shows what they want to watch next, right after what they love', async () => {
    /**
     * The founder's ordering decision, on the screen it is aimed at: this is somebody
     * else's profile, and their watchlist is the socially actionable half — "I want to
     * watch that too" is a reason to reach out, which their finished rankings never give.
     *
     * The section is here at all because `20260820000200` moved the watchlist behind
     * `can_i_view`. A profile this viewer could not see would return no rows from the same
     * query and the section would be absent — proved from a real second session in
     * `supabase/tests/rls.test.mjs`, and at the component level in
     * `ProfileWatchlist.test.tsx`.
     */
    tableRows.watchlist = [
      {
        user_id: 'anna-id',
        media_item_id: 'w1',
        created_at: '2026-08-19T10:00:00Z',
        media_items: {
          kind: 'movie',
          title: 'Sicario',
          season_number: null,
          release_date: '2015-01-01',
          poster_path: null,
          parent: null,
        },
      },
    ];

    const view = await open();

    await waitFor(() => expect(view.getByLabelText('Watchlist')).toBeTruthy());
    expect(view.getByLabelText(/^Sicario/)).toBeTruthy();
  });

  it('has no Watchlist section when the read comes back empty', async () => {
    // Which is both cases at once, and deliberately indistinguishable: an account that has
    // saved nothing, and an account this viewer is not authorised to see.
    const view = await open();
    await waitFor(() => expect(view.getByLabelText('Top ranked')).toBeTruthy());
    expect(view.queryByLabelText('Watchlist')).toBeNull();
  });

  it('shows one wall rather than a wall and then the same list again', async () => {
    // The founder's correction. This screen used to draw a poster wall of six, then a
    // Movies / TV control, then the whole ranked list *again* as rows with a score on
    // each — the same six titles twice before a reader reached anything new.
    //
    // The filter now changes the wall. It is offered only where both halves have
    // something, so a fixture with films alone is not asked to choose, which is what
    // this asserts: the wall is there and the control is not.
    const view = await open();

    await waitFor(() => expect(view.getByLabelText('Top ranked')).toBeTruthy());
    expect(view.queryByRole('tab', { name: 'TV' })).toBeNull();
  });

  it('names a ranked season with its show, where a name is rendered at all', async () => {
    tableRows.rankings = [
      ranking('s2', 'Season 2', 1, {
        category: 'movies',
        media_items: {
          title: 'Season 2',
          release_date: '2010-01-01',
          poster_path: null,
          genres: ['Comedy'],
          runtime_minutes: 22,
          kind: 'season',
          parent: { title: 'Parks and Recreation' },
        },
      }),
    ];
    const view = await open();

    // The wall is artwork and a score, so the season's full name reaches a reader
    // through the tile's accessibility label — which is where a picture has to say
    // what it is, and is the only place it was ever legible to a screen reader.
    await waitFor(() =>
      expect(view.getAllByLabelText(/Parks and Recreation, S2/).length).toBeGreaterThan(0),
    );
  });

  it('says so plainly when they have ranked nothing', async () => {
    tableRows.rankings = [];
    const view = await open();

    await waitFor(() => expect(view.getByText('Nothing ranked yet')).toBeTruthy());
  });

  it('shows their activity without the viewer having to follow them', async () => {
    // The first version filtered the viewer's own feed, which spans the follow set
    // — so every public account the viewer had not followed showed an empty Recent
    // activity while plainly having some. `feed_events_read` was doing the
    // authorising all along; the follow set was only ever a filter.
    tableRows.feed_events = [
      {
        id: 'e1',
        type: 'title_ranked',
        actor_id: 'anna-id',
        media_item_id: 'a',
        created_at: '2026-08-15T00:00:00Z',
        payload: { position: 1, category: 'movies', bucket: 'loved', score: 9.1 },
        media_items: {
          kind: 'movie',
          title: 'Heat',
          release_date: '1995-01-01',
          poster_path: null,
          genres: ['Drama'],
          runtime_minutes: 170,
          parent: null,
        },
        profiles: { username: 'anna', display_name: 'Anna', avatar_path: null },
      },
    ];
    tableRows.follows = [];
    const view = await open();

    await waitFor(() => expect(view.getByLabelText('Recent activity')).toBeTruthy());
    expect(view.getAllByText(/Heat/).length).toBeGreaterThan(0);
  });
});

/**
 * Reporting, from the profile.
 *
 * Two subjects reachable from this one screen: the account itself, and each review it
 * publishes. They are separate rows in `reports` with separate subject types, because
 * "this person is impersonating someone" and "this particular review is abusive" are
 * different complaints and a queue that conflated them would be triaged wrongly.
 */
describe('reporting from a profile', () => {
  const reportCalls = () => mockRpcCalls.filter((call) => call.name === 'report');

  /**
   * **Report moved into the header menu, and this is how you reach it now.**
   *
   * It was a tertiary button in the row beside Follow. The founder's device pass is
   * that the primary action area of somebody else's profile then read as a moderation
   * console — follow them, block them, report them, all at one altitude — so the two
   * rare and severe acts went behind the hamburger in the corner. Still one tap from
   * every profile; no longer permanently beside the control the page is for.
   */
  const openMenu = async (view: Awaited<ReturnType<typeof open>>) => {
    await waitFor(() => expect(view.getByLabelText('More options for Anna')).toBeTruthy());
    return fireEvent.press(view.getByLabelText('More options for Anna'));
  };

  it('reports the profile itself, resolving nothing on the client', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('Anna')).toBeTruthy());

    await openMenu(view);
    await fireEvent.press(view.getByText('Report'));
    await fireEvent.press(view.getByText('Pretending to be someone'));

    await waitFor(() => expect(reportCalls()).toHaveLength(1));
    expect(reportCalls()[0]?.args).toEqual({
      p_subject_type: 'profile',
      p_subject_id: 'anna-id',
      p_reason: 'impersonation',
    });
  });

  /**
   * **Reporting is not blocking, and one must not perform the other.**
   *
   * They are different acts with different consequences: a block is between two people
   * and takes effect at once, a report is a message to whoever runs Bingd. Bundling
   * them would silently block somebody who only wanted to flag a profile — and the
   * reverse, hiding Report once a block exists, is the inversion the database
   * deliberately refuses (20260813002000 §4).
   */
  it('does not block the account as a side effect', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('Anna')).toBeTruthy());

    // Report and Block are two rows in one menu now, which makes this assertion more
    // rather than less worth keeping: they are adjacent, and adjacency is how a wire
    // gets crossed.
    await openMenu(view);
    await fireEvent.press(view.getByText('Report'));
    await fireEvent.press(view.getByText('Harassment or bullying'));

    await waitFor(() => expect(reportCalls()).toHaveLength(1));
    expect(mockRpcCalls.map((call) => call.name)).not.toContain('block');
  });

  it('tells the reporter it was received, without promising a timeline', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('Anna')).toBeTruthy());

    await openMenu(view);
    await fireEvent.press(view.getByText('Report'));
    await fireEvent.press(view.getByText('Something else'));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Thanks for telling us', 'We will take a look at this.'),
    );
  });

  it('explains a refusal rather than failing silently', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('Anna')).toBeTruthy());

    mockRpcErrors.report = { code: '53400', message: 'report limit reached for today' };
    await openMenu(view);
    await fireEvent.press(view.getByText('Report'));
    await fireEvent.press(view.getByText('Spam or a scam'));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        'Could not report',
        'You have reported a lot today. Please try again tomorrow.',
      ),
    );
  });
});

describe('their notes', () => {
  const note = {
    // The `user_media` row this review lives on — its report subject, from
    // 20260825000100. Keyed per row rather than per title so that two people's reviews
    // of one film are two subjects rather than one.
    id: 'um-anna-film1',
    user_id: 'anna-id',
    media_item_id: 'film-1',
    note: 'The last twenty minutes are the whole film.',
    has_spoilers: false,
    updated_at: '2026-08-15T00:00:00Z',
  };

  beforeEach(() => {
    tableRows.media_items = [
      { id: 'film-1', kind: 'movie', title: 'Inception', poster_path: null, parent: null },
    ];
  });

  it('reports one of their reviews by its own id', async () => {
    mockRpcResults.public_notes = [note];
    const view = await open();
    await waitFor(() =>
      expect(view.getByText('The last twenty minutes are the whole film.')).toBeTruthy(),
    );

    await fireEvent.press(view.getByLabelText('Report this review of Inception'));
    await fireEvent.press(view.getByText('Sexual content'));

    await waitFor(() =>
      expect(mockRpcCalls.filter((call) => call.name === 'report')).toHaveLength(1),
    );
    expect(mockRpcCalls.find((call) => call.name === 'report')?.args).toEqual({
      // The review, not the profile it is displayed on and not the title it is about.
      p_subject_type: 'review',
      p_subject_id: 'um-anna-film1',
      p_reason: 'sexual_content',
    });
  });

  it('shows the ones they made public', async () => {
    mockRpcResults.public_notes = [note];
    const view = await open();

    await waitFor(() =>
      expect(view.getByText('The last twenty minutes are the whole film.')).toBeTruthy(),
    );
  });

  /**
   * This screen *can* be the viewer's own: Settings › Privacy links here as "see your
   * public profile". An earlier comment in the screen claimed otherwise, and the
   * control it justified was a Report on your own review — a button whose only
   * possible outcome is the server's 22023 refusal. The review stays visible; only
   * the recourse against its own author goes.
   */
  it('offers no Report on the viewer’s own reviews, on their own profile', async () => {
    tableRows.public_profiles = [{ ...anna, id: 'viewer' }];
    mockRpcResults.public_notes = [{ ...note, id: 'um-viewer-film1', user_id: 'viewer' }];
    const view = await open();

    await waitFor(() =>
      expect(view.getByText('The last twenty minutes are the whole film.')).toBeTruthy(),
    );
    expect(view.queryByLabelText('Report this review of Inception')).toBeNull();
  });

  /**
   * **Reviews, because that is what they are.** This section is fed by `public_notes` —
   * writing its author chose to publish, the same rows the title page lists under a tab
   * called Reviews, through the same predicate. It was headed "Notes", which put the
   * private word over the public thing and was the sharpest of the three names one
   * object had.
   */
  it('heads the section Reviews, not Notes', async () => {
    mockRpcResults.public_notes = [note];
    const view = await open();

    // `SectionHeader` uppercases what it draws and keeps the real title as its
    // accessible name, so both are asserted — the word somebody sees and the word
    // somebody hears.
    await waitFor(() => expect(view.getByLabelText('Reviews')).toBeTruthy());
    expect(view.getByText('REVIEWS')).toBeTruthy();
    expect(view.queryByLabelText('Notes')).toBeNull();
    expect(view.queryByText('NOTES')).toBeNull();
  });

  it('shows nothing at all when every note is private', async () => {
    // `public_notes` returns only public ones, so a private note is absent rather
    // than filtered here — there is no client-side rule to get wrong.
    mockRpcResults.public_notes = [];
    const view = await open();

    await waitFor(() => expect(view.getByText('Anna')).toBeTruthy());
    expect(view.queryByText('Notes')).toBeNull();
  });

  it('masks a spoiler note for a viewer who has not watched that exact title', async () => {
    mockRpcResults.public_notes = [
      { ...note, note: 'He was dead the whole time.', has_spoilers: true },
    ];
    const view = await open();

    await waitFor(() => expect(view.getByText('Contains spoilers')).toBeTruthy());
    expect(view.queryByText('He was dead the whole time.')).toBeNull();
  });

  it('shows it once the viewer has watched that exact title', async () => {
    tableRows.user_media = [{ user_id: 'viewer', media_item_id: 'film-1' }];
    mockRpcResults.public_notes = [
      { ...note, note: 'He was dead the whole time.', has_spoilers: true },
    ];
    const view = await open();

    await waitFor(() => expect(view.getByText('He was dead the whole time.')).toBeTruthy());
  });

  it('asks for the subject’s notes, not the viewer’s', async () => {
    // A mock that ignored its arguments would pass with the wrong id in the call,
    // which is the mutation that would quietly show a visitor their own notes on
    // somebody else's page.
    mockRpcResults.public_notes = [note];
    const view = await open();
    await waitFor(() => expect(view.getByText('Anna')).toBeTruthy());

    const call = mockRpcCalls.find((entry) => entry.name === 'public_notes');
    expect(call?.args.p_user_ids).toEqual(['anna-id']);
  });

  it('masks a spoiler note inside recent activity too', async () => {
    // The notes section and the activity section mask separately, so each needs
    // its own assertion — review found this one uncovered, and a `masked={false}`
    // slipped into the activity row would have leaked without failing anything.
    tableRows.feed_events = [
      {
        id: 'e1',
        type: 'title_ranked',
        actor_id: 'anna-id',
        media_item_id: 'film-1',
        created_at: '2026-08-15T00:00:00Z',
        payload: { position: 1, category: 'movies', bucket: 'loved', score: 9.1 },
        media_items: {
          kind: 'movie',
          title: 'Inception',
          release_date: '2010-01-01',
          poster_path: null,
          genres: ['Drama'],
          runtime_minutes: 148,
          parent: null,
        },
        profiles: { username: 'anna', display_name: 'Anna', avatar_path: null },
      },
    ];
    mockRpcResults.public_notes = [
      { ...note, note: 'Everyone dies at the end.', has_spoilers: true },
    ];
    const view = await open();

    await waitFor(() => expect(view.getAllByText('Contains spoilers').length).toBe(2));
    expect(view.queryByText('Everyone dies at the end.')).toBeNull();
  });

  it('does not let one season unmask another', async () => {
    // The viewer has watched Season 1. The note is on Season 2, and stays masked.
    tableRows.user_media = [{ user_id: 'viewer', media_item_id: 'season-1' }];
    tableRows.media_items = [
      {
        id: 'season-2',
        kind: 'season',
        title: 'Season 2',
        poster_path: null,
        parent: { title: 'Parks and Recreation' },
      },
    ];
    mockRpcResults.public_notes = [
      { ...note, media_item_id: 'season-2', note: 'Ben leaves.', has_spoilers: true },
    ];
    const view = await open();

    await waitFor(() => expect(view.getByText('Contains spoilers')).toBeTruthy());
    expect(view.queryByText('Ben leaves.')).toBeNull();
  });
});

describe('the relationship controls', () => {
  it('offers Follow on a public profile the viewer does not follow', async () => {
    mockRpcResults.follow_state_with = [
      { user_id: 'anna-id', following: null, followed_by: null, blocked: false },
    ];

    const view = await open();
    await waitFor(() => expect(view.getByText('Follow')).toBeTruthy());
  });

  /**
   * **One operation id per follow, held across the retry a lost reply invites.**
   *
   * The edge converges — `follow` assigns — but the RPC is rate-limited, so a replay
   * under a fresh id spends a second slot against `follows.max_per_day` for one tap.
   * Nothing raises and the button behaves; the ceiling simply arrives early for somebody
   * who has not reached it. Independent review 21j (`lib/operation-intent.ts`).
   */
  it('replays an unanswered follow under the id the first attempt used', async () => {
    mockRpcResults.follow_state_with = [
      { user_id: 'anna-id', following: null, followed_by: null, blocked: false },
    ];
    mockRpcErrors.follow = { code: '', message: 'TypeError: Network request failed' };

    const view = await open();
    await waitFor(() => expect(view.getByText('Follow')).toBeTruthy());

    await fireEvent.press(view.getByText('Follow'));
    await waitFor(() =>
      expect(mockRpcCalls.filter((call) => call.name === 'follow')).toHaveLength(1),
    );
    await fireEvent.press(view.getByText('Follow'));
    await waitFor(() =>
      expect(mockRpcCalls.filter((call) => call.name === 'follow')).toHaveLength(2),
    );

    const ids = mockRpcCalls
      .filter((call) => call.name === 'follow')
      .map((call) => call.args.p_operation_id);
    expect(typeof ids[0]).toBe('string');
    expect(ids[1]).toBe(ids[0]);
  });

  it('takes a fresh id for a follow the server answered', async () => {
    mockRpcResults.follow_state_with = [
      { user_id: 'anna-id', following: null, followed_by: null, blocked: false },
    ];

    const view = await open();
    await waitFor(() => expect(view.getByText('Follow')).toBeTruthy());

    await fireEvent.press(view.getByText('Follow'));
    await waitFor(() =>
      expect(mockRpcCalls.filter((call) => call.name === 'follow')).toHaveLength(1),
    );
    // The button's label is driven by a query the stub answers from a fixture, so it
    // does not move; what matters is that the second press is a second intent.
    await fireEvent.press(view.getByText('Follow'));
    await waitFor(() =>
      expect(mockRpcCalls.filter((call) => call.name === 'follow')).toHaveLength(2),
    );

    const ids = mockRpcCalls
      .filter((call) => call.name === 'follow')
      .map((call) => call.args.p_operation_id);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('says Following once there is an approved edge', async () => {
    mockRpcResults.follow_state_with = [
      { user_id: 'anna-id', following: 'approved', followed_by: null, blocked: false },
    ];

    const view = await open();
    // Two matches: the stat row's "Following" count label, and the button. Asserting
    // the count is what keeps this honest — a single match would mean the button had
    // vanished and the stat label was standing in for it.
    await waitFor(() => expect(view.getAllByText('Following')).toHaveLength(2));
    // And the unrelated state is gone. Exact matching, so "Following" is not "Follow".
    expect(view.queryByText('Follow')).toBeNull();
  });

  it('says Requested while a private account has not answered', async () => {
    // `pending` means two different things depending on direction, which is why the
    // label lives in one place. From this side it is "waiting on them".
    mockRpcResults.follow_state_with = [
      { user_id: 'anna-id', following: 'pending', followed_by: null, blocked: false },
    ];

    const view = await open();
    await waitFor(() => expect(view.getByText('Requested')).toBeTruthy());
  });

  it('offers no controls on the viewer’s own profile', async () => {
    tableRows.public_profiles = [{ ...anna, id: 'viewer' }];
    mockRpcResults.follow_state_with = [
      { user_id: 'viewer', following: null, followed_by: null, blocked: false },
    ];

    const view = await open();
    await waitFor(() => expect(view.getByText('@anna')).toBeTruthy());

    expect(view.queryByText('Follow')).toBeNull();
    expect(view.queryByText('Block')).toBeNull();
  });

  it('reaches Unblock after blocking, though the profile itself is gone', async () => {
    // Independent review 12, third Major. Blocking makes can_view_profile false in
    // *both* directions, so the account leaves public_profiles for the blocker too —
    // and the only Unblock control lived on the profile that had just disappeared.
    // This is the state a real blocker lands in: no profile row, but a block of
    // their own that names the account.
    tableRows.public_profiles = [];
    mockRpcResults.my_blocks = [
      { user_id: 'anna-id', username: 'anna', display_name: 'Anna', avatar_path: null },
    ];

    const view = await open();

    await waitFor(() => expect(view.getByText('You blocked @anna')).toBeTruthy());
    expect(view.getByText('Unblock')).toBeTruthy();
    // And not the generic wording, which would leave the user with no way back.
    expect(view.queryByText('This profile is not available.')).toBeNull();
  });

  /**
   * **Blocking must not become a way to suppress the complaint.**
   *
   * The database states the rule and states it deliberately: `report()` checks that a
   * subject exists and *not* that the caller can still see it (20260813002000 §4). The
   * client half of it was lost when Report moved into the header menu — review 41's
   * third Major. `subjectId` is built from `public_profiles` and `profile_identity`,
   * and blocking empties both, so the menu was rendering `null` on exactly the profile
   * where moderation matters most.
   *
   * The viewer's own block list is the one read that can still name them, which is why
   * the blocked branch already reaches for it. The header now does too.
   */
  it('still offers Report on somebody the viewer has blocked', async () => {
    tableRows.public_profiles = [];
    mockRpcResults.my_blocks = [
      { user_id: 'anna-id', username: 'anna', display_name: 'Anna', avatar_path: null },
    ];

    const view = await open();
    await waitFor(() => expect(view.getByText('You blocked @anna')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('More options for @anna'));

    await waitFor(() => expect(view.getByLabelText('Report')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Report'));
    await fireEvent.press(view.getByText('Harassment or bullying'));

    // Reported by the id the block list gave, which is the only one still available.
    await waitFor(() =>
      expect(mockRpcCalls.filter((call) => call.name === 'report')).toHaveLength(1),
    );
    expect(mockRpcCalls.find((call) => call.name === 'report')?.args).toEqual({
      p_subject_type: 'profile',
      p_subject_id: 'anna-id',
      p_reason: 'harassment',
    });
  });

  it('offers Unblock rather than Block in that menu, since the block already exists', async () => {
    tableRows.public_profiles = [];
    mockRpcResults.my_blocks = [
      { user_id: 'anna-id', username: 'anna', display_name: 'Anna', avatar_path: null },
    ];

    const view = await open();
    await waitFor(() => expect(view.getByText('You blocked @anna')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('More options for @anna'));

    // `follow_state_with` is asked about `subjectId`, which is empty here — so the block
    // is read from the viewer's own list instead. Getting this backwards would offer to
    // block somebody who is already blocked, on the one screen where that is most
    // obviously wrong.
    await waitFor(() => expect(view.getByLabelText('Unblock')).toBeTruthy());
    expect(view.queryByLabelText('Block')).toBeNull();
  });

  it('still says nothing about an account the viewer has not blocked', async () => {
    // The other half: `my_blocks` returning nothing must leave the private/nonexistent
    // answer exactly as it was, or the new branch becomes a disclosure of its own.
    tableRows.public_profiles = [];
    mockRpcResults.my_blocks = [];

    const view = await open();

    await waitFor(() => expect(view.getByText('This profile is not available.')).toBeTruthy());
    expect(view.queryByText(/You blocked/)).toBeNull();
  });
});

/**
 * Taste Match, which moved **under the handle** in the founder's final pass — and which
 * the founder reported as missing before it did.
 *
 * It was under the avatar, which is a column about sixty points wide: a figure and a
 * word, and no room for a sentence. So every state without a figure rendered as nothing
 * at all, and on a friend beta — where `taste.min_common` is five *exactly shared*
 * rankings — that is nearly every profile. The feature was wired, authorised, tested,
 * and invisible.
 *
 * Under the handle it has a line's width, so it says what it knows in all four states.
 */
describe('Taste Match', () => {
  /** Gives the subject enough rankings for the shortfall to be the viewer's. */
  const subjectHasRanked = (n: number) => {
    tableRows.rankings = Array.from({ length: n }, (_, i) =>
      ranking(`anna-film-${i}`, `Anna film ${i}`, i + 1),
    );
  };

  /** Gives the viewer `n` ranked titles of their own. */
  const viewerHasRanked = (n: number) => {
    const mine = Array.from({ length: n }, (_, i) => ({
      user_id: 'viewer',
      media_item_id: `mine-${i}`,
      category: 'movies',
      bucket: 'loved',
      position: i + 1,
      media_items: { title: `Mine ${i}`, kind: 'movie', parent: null },
    }));
    tableRows.rankings = [...(tableRows.rankings ?? []), ...mine];
    tableRows.user_media = mine.map((row) => ({
      user_id: 'viewer',
      media_item_id: row.media_item_id,
      bucket: 'loved',
      created_at: '2026-01-01T00:00:00Z',
      media_items: { title: 'Mine', kind: 'movie', parent: null },
    }));
  };

  it('shows the percentage under the handle', async () => {
    mockRpcResults.taste_match = [{ score: 84, common_count: 12, min_common: 5 }];

    const view = await open();

    await waitFor(() => expect(view.getByText('84% Match')).toBeTruthy());
    // The long form is gone from this surface. The count was never the thing anybody
    // came for, and a second line here competes with the handle above it.
    expect(view.queryByText(/Taste Match/)).toBeNull();
    expect(view.queryByText(/titles in common/)).toBeNull();
  });

  /**
   * The founder's incentive case, and the one where the advice is actually true: the
   * subject has plenty ranked, so the shortfall is the reader's and ranking more can
   * genuinely close it.
   */
  it('tells the viewer to rank more only when that is what is missing', async () => {
    subjectHasRanked(12);
    viewerHasRanked(1);
    mockRpcResults.taste_match = [{ score: null, common_count: 1, min_common: 5 }];

    const view = await open();

    await waitFor(() => expect(view.getByText('Rank more to see Match')).toBeTruthy());
    expect(view.queryByText(/%/)).toBeNull();
  });

  /**
   * And the case it must not blame the reader for. Anna has ranked three films; nothing
   * the viewer ranks can produce five shared titles with somebody who has three.
   */
  it('does not blame the viewer when the other account is the one with too little', async () => {
    subjectHasRanked(3);
    viewerHasRanked(40);
    mockRpcResults.taste_match = [{ score: null, common_count: 2, min_common: 5 }];

    const view = await open();

    await waitFor(() => expect(view.getByText('Not enough shared taste yet')).toBeTruthy());
    expect(view.queryByText(/Rank more/)).toBeNull();
  });

  it('says the overlap is short when both have ranked plenty', async () => {
    subjectHasRanked(30);
    viewerHasRanked(30);
    mockRpcResults.taste_match = [{ score: null, common_count: 2, min_common: 5 }];

    const view = await open();

    await waitFor(() => expect(view.getByText('Not enough shared taste yet')).toBeTruthy());
    expect(view.queryByText(/Rank more/)).toBeNull();
  });

  /**
   * The one thing the founder ruled out by name. An absence of evidence is not a low
   * score, and a placeholder percentage is worse than either.
   */
  it('never prints a number it does not have', async () => {
    mockRpcResults.taste_match = [{ score: null, common_count: 3, min_common: 5 }];

    const view = await open();
    await waitFor(() => expect(view.getByText('@anna')).toBeTruthy());

    expect(view.queryByText(/TBD/)).toBeNull();
    expect(view.queryByText(/%/)).toBeNull();
  });

  it('is absent on the viewer’s own profile', async () => {
    // Both halves: the hook does not fire, and `taste_match` refuses the self case
    // too — one is a display decision and the other is what a modified client hits.
    tableRows.public_profiles = [{ ...anna, id: 'viewer' }];
    mockRpcResults.taste_match = [{ score: 100, common_count: 40, min_common: 5 }];

    const view = await open();
    await waitFor(() => expect(view.getByText('@anna')).toBeTruthy());

    expect(view.queryByText(/Match/)).toBeNull();
    expect(view.queryByText('100%')).toBeNull();
    expect(mockRpcCalls.some((call) => call.name === 'taste_match')).toBe(false);
  });

  /**
   * An empty answer is not a zero. `taste_match` returning no row at all — which is what
   * a refusal looks like from the client's side, since the function declines rather than
   * raises — must not produce a percentage of any kind.
   *
   * The genuinely-still-loading case, where the line is absent rather than provisional,
   * is `tasteMatchState`'s own and is pinned in `use-taste-match.test.ts`: this mock
   * resolves in the same tick, so there is no pending moment here to observe.
   */
  it('prints no percentage when the server answers with nothing', async () => {
    mockRpcResults.taste_match = undefined;

    const view = await open();
    await waitFor(() => expect(view.getByText('@anna')).toBeTruthy());

    expect(view.queryByText(/%/)).toBeNull();
    expect(view.queryByText(/TBD/)).toBeNull();
  });

  /**
   * A private account the viewer has not been approved for is drawn from
   * `profile_identity` alone — no stats, no rankings, no aggregate — and `taste_match`
   * refuses it through `can_view_profile` for the same reason. The limitation is the
   * existing privacy contract rather than a decision this screen makes, and this pins
   * that nothing here widened it.
   */
  it('says nothing about Match on a private account the viewer cannot read', async () => {
    tableRows.public_profiles = [];
    mockRpcResults.profile_identity = [
      { id: 'anna-id', username: 'anna', display_name: 'Anna', avatar_path: null, visibility: 'private' },
    ];
    mockRpcResults.my_blocks = [];
    mockRpcResults.taste_match = [{ score: null, common_count: 0, min_common: 5 }];

    const view = await open();
    await waitFor(() => expect(view.getByText('This account is private')).toBeTruthy());

    expect(view.queryByText(/Match/)).toBeNull();
    expect(view.queryByText(/Not enough shared taste/)).toBeNull();
  });
});

/**
 * The two actions the founder found missing here.
 *
 * They were on the own profile and not on anybody else's, which is the drift
 * `ProfileIdentity` exists to stop: a reader could not tell that what they see on
 * somebody else is what other people see on them. Both are about the person being
 * looked at, and the tests that matter are the two where "the person" could silently
 * become the reader instead.
 */
describe('sharing and awards on somebody else’s profile', () => {
  it('offers both, under the follow control', async () => {
    const view = await open();

    await waitFor(() => expect(view.getByText('@anna')).toBeTruthy());
    expect(view.getByRole('button', { name: 'Share Profile' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'bingd. Awards' })).toBeTruthy();
    // But not Invite friends: an invitation is from the signed-in person, and this
    // page is about somebody else. The control lives on the own profile alone.
    expect(view.queryByRole('button', { name: 'Invite friends' })).toBeNull();
  });

  it('shares the viewed handle, not the reader’s own', async () => {
    // The reader is `sai`. A share that reached for the signed-in profile would hand
    // somebody a link to the sharer, from a page about a different person — and it
    // would look right, because it is a valid Bingd profile URL.
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const view = await open();

    await waitFor(() => expect(view.getByText('@anna')).toBeTruthy());
    await fireEvent.press(view.getByRole('button', { name: 'Share Profile' }));

    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(share).toHaveBeenCalledWith({
      message: 'https://bingd.app/u/anna',
      url: 'https://bingd.app/u/anna',
    });
    share.mockRestore();
  });

  it('opens the awards of the person being looked at', async () => {
    const view = await open();

    await waitFor(() => expect(view.getByText('@anna')).toBeTruthy());
    // Closed until asked for: it reads nine things when it mounts.
    expect(awardsProps).toBeNull();

    await fireEvent.press(view.getByRole('button', { name: 'bingd. Awards' }));

    // `anna-id`, never `viewer`. The whole sheet is a reading of one user's collection,
    // so the wrong id here is somebody else's awards under Anna's name.
    await waitFor(() => expect(awardsProps).not.toBeNull());
    expect(awardsProps?.userId).toBe('anna-id');
  });

  it('offers neither on an account the viewer may not read', async () => {
    // The controls live in the branch that renders only once `public_profiles` came
    // back. A private account the viewer does not follow never reaches it, so there is
    // no Awards button to open a collection they are not entitled to.
    tableRows.public_profiles = [];
    mockRpcResults.profile_identity = [
      { ...anna, avatar_path: null, visibility: 'private' },
    ];

    const view = await open();

    await waitFor(() => expect(view.getByText('This account is private')).toBeTruthy());
    expect(view.queryByRole('button', { name: 'bingd. Awards' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Share Profile' })).toBeNull();
  });
});

/**
 * **"Viewing another user's profile does not feel like viewing your own."**
 *
 * The founder's device pass, and the four differences it named: a different action
 * hierarchy, Awards styled differently, Follow and Block and Report dominating the
 * header, and Share and Awards in a different place. All four are one defect — the two
 * screens each drew their own action area, so they drifted the way two copies of
 * anything drift.
 *
 * The pair is `ProfileActions` now and is asserted in its own suite; what belongs here
 * is the *arrangement* this screen puts around it, which is the half that has to match
 * the owner's profile position for position:
 *
 *     [ Share Profile ]  [ bingd. Awards ]
 *     [        Follow / Following        ]
 *
 * The full-width slot underneath the pair holds Invite friends on your own profile, and
 * here it holds the one control that depends on who is looking.
 */
describe('the shape of somebody else’s profile', () => {
  it('puts Share and Awards in the pair, and the relationship underneath', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('Anna')).toBeTruthy());

    // Rendered order is the arrangement. Follow was above the pair, which put a
    // different thing in the top row on each of the two screens.
    const controls = view
      .getAllByText(/^(Share Profile|bingd\. Awards|Follow)$/)
      .map((node) => node.props.children);
    expect(controls).toEqual(['Share Profile', 'bingd. Awards', 'Follow']);
  });

  it('fills Awards in maroon, as the owner’s profile does', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('bingd. Awards')).toBeTruthy());

    // It was `secondary` here and filled on the owner's — the same object in two
    // treatments one tap apart. The founder wants Awards to pop on both.
    const awards = view.getByRole('button', { name: 'bingd. Awards' });
    expect(StyleSheet.flatten(awards.props.style).backgroundColor).toBe(theme.semantic.action);
  });

  it('fills Follow in maroon while there is no relationship', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('Follow')).toBeTruthy());

    const follow = view.getByRole('button', { name: 'Follow' });
    const style = StyleSheet.flatten(follow.props.style);
    expect(style.backgroundColor).toBe(theme.semantic.action);
    // Full width, which is the shape of the slot it sits in.
    expect(StyleSheet.flatten(follow.parent?.props?.style).alignSelf).toBe('stretch');
  });

  /**
   * **Following keeps the colour and gives up the fill.**
   *
   * It was `secondary` — grey — which made the control the reader had just pressed look
   * as though it had been swapped for a different, unrelated one. An outline in the same
   * Maroon says "same button, new state", which is what actually happened.
   */
  it('outlines Following in maroon rather than turning it grey', async () => {
    mockRpcResults.follow_state_with = [
      { user_id: 'anna-id', following: 'approved', followed_by: null, blocked: false },
    ];
    const view = await open();
    await waitFor(() => expect(view.getAllByText('Following')).toHaveLength(2));

    const following = view.getByRole('button', { name: 'Following' });
    const style = StyleSheet.flatten(following.props.style);
    expect(style.borderColor).toBe(theme.semantic.action);
    expect(style.backgroundColor).toBe(theme.surface.raised);
    expect(style.backgroundColor).not.toBe(theme.semantic.action);
  });

  it('gives Requested the same treatment without the same word', async () => {
    mockRpcResults.follow_state_with = [
      { user_id: 'anna-id', following: 'pending', followed_by: null, blocked: false },
    ];
    const view = await open();
    await waitFor(() => expect(view.getByText('Requested')).toBeTruthy());

    // The act is done and the button is reporting rather than offering, so it shares
    // the outline. It does not share the word: a pending request is not a follow, and
    // saying "Following" would tell somebody they have access nobody granted.
    const requested = view.getByRole('button', { name: 'Requested' });
    expect(StyleSheet.flatten(requested.props.style).borderColor).toBe(theme.semantic.action);
    // One match, and it is the stat row's count label rather than a button. Two would
    // mean the control had collapsed a pending request into an approved follow.
    expect(view.getAllByText('Following')).toHaveLength(1);
    expect(view.queryByRole('button', { name: 'Following' })).toBeNull();
  });

  it('will not unfollow on one tap', async () => {
    mockRpcResults.follow_state_with = [
      { user_id: 'anna-id', following: 'approved', followed_by: null, blocked: false },
    ];
    const view = await open();
    await waitFor(() => expect(view.getAllByText('Following')).toHaveLength(2));

    await fireEvent.press(view.getByRole('button', { name: 'Following' }));

    // Withdrawing an approved follow means the next one is a *request* somebody else
    // has to answer, so it is worth a sentence — and an accidental tap on a button that
    // now sits full-width under the thumb must not sever anything.
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Unfollow Anna?', expect.any(String), expect.any(Array)));
    expect(mockRpcCalls.map((call) => call.name)).not.toContain('unfollow');
  });

  it('keeps Report and Block out of the action area entirely', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('Follow')).toBeTruthy());

    // They are in the header menu, and the point of moving them was that a profile's
    // primary action area should not read as a moderation console. Closed menu, so
    // neither row is on screen.
    expect(view.queryByRole('button', { name: 'Block' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Report' })).toBeNull();
    expect(view.getByLabelText('More options for Anna')).toBeTruthy();
  });

  it('offers Report and Block behind the menu, in that order', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByLabelText('More options for Anna')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('More options for Anna'));

    // Report first: it is the lighter of the two and the one somebody is more often
    // looking for. Two rows rather than one, because neither act implies the other.
    await waitFor(() => expect(view.getByLabelText('Report')).toBeTruthy());
    expect(view.getByLabelText('Block')).toBeTruthy();
  });

  it('offers Unblock instead of Block once the account is blocked, and keeps Report', async () => {
    mockRpcResults.follow_state_with = [
      { user_id: 'anna-id', following: null, followed_by: null, blocked: true },
    ];
    const view = await open();
    await waitFor(() => expect(view.getByLabelText('More options for Anna')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('More options for Anna'));

    await waitFor(() => expect(view.getByLabelText('Unblock')).toBeTruthy());
    // Report survives a block, which is the client half of a rule the database states:
    // `report()` checks that a subject exists and deliberately not that the caller can
    // still see it, so blocking cannot become a way to suppress the complaint
    // (20260813002000 §4).
    expect(view.getByLabelText('Report')).toBeTruthy();
    expect(view.queryByLabelText('Block')).toBeNull();
  });
});
