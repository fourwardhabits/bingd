import { fireEvent, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';

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

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useLocalSearchParams: () => ({ username: 'anna' }),
  Stack: { Screen: () => null },
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
    expect(view.queryByRole('tab', { name: 'TV seasons' })).toBeNull();
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

describe('their notes', () => {
  const note = {
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

  it('shows the ones they made public', async () => {
    mockRpcResults.public_notes = [note];
    const view = await open();

    await waitFor(() =>
      expect(view.getByText('The last twenty minutes are the whole film.')).toBeTruthy(),
    );
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
 * Taste Match, which moved under the avatar in the founder's final layout.
 *
 * It used to sit in the name column as a headline and a detail line — "84% Taste Match"
 * over "12 titles in common" — where it was a third thing stacked against the identity
 * and pushed the bio down the page. It is now the avatar's own subheading, which is a
 * column about sixty points wide: a figure and a word, and no room for a sentence.
 */
describe('Taste Match', () => {
  it('shows the percentage under the avatar', async () => {
    mockRpcResults.taste_match = [{ score: 84, common_count: 12, min_common: 5 }];

    const view = await open();

    await waitFor(() => expect(view.getByText('84%')).toBeTruthy());
    expect(view.getByText('Match')).toBeTruthy();
    // The long form is gone from this surface. It reads badly under a photo and the
    // count was never the thing anybody came for.
    expect(view.queryByText(/Taste Match/)).toBeNull();
    expect(view.queryByText(/titles in common/)).toBeNull();
  });

  it('shows no badge at all rather than a low number, when there is not enough overlap', async () => {
    // An absence of evidence is not a low score. "0%" over three shared films would be
    // the feature's first lie, and the badge is a number or it is nothing.
    mockRpcResults.taste_match = [{ score: null, common_count: 3, min_common: 5 }];

    const view = await open();
    await waitFor(() => expect(view.getByText('@anna')).toBeTruthy());

    expect(view.queryByText('Match')).toBeNull();
    expect(view.queryByText(/%$/)).toBeNull();
  });

  it('says nothing when they have nothing in common at all', async () => {
    mockRpcResults.taste_match = [{ score: null, common_count: 0, min_common: 5 }];

    const view = await open();
    await waitFor(() => expect(view.getByText('@anna')).toBeTruthy());

    expect(view.queryByText('Match')).toBeNull();
  });

  it('is absent on the viewer’s own profile', async () => {
    // Both halves: the hook does not fire, and `taste_match` refuses the self case
    // too — one is a display decision and the other is what a modified client hits.
    tableRows.public_profiles = [{ ...anna, id: 'viewer' }];
    mockRpcResults.taste_match = [{ score: 100, common_count: 40, min_common: 5 }];

    const view = await open();
    await waitFor(() => expect(view.getByText('@anna')).toBeTruthy());

    expect(view.queryByText('Match')).toBeNull();
    expect(view.queryByText('100%')).toBeNull();
    expect(mockRpcCalls.some((call) => call.name === 'taste_match')).toBe(false);
  });

  it('shows nothing at all while the answer is still unknown', async () => {
    // No placeholder number that then changes. A match percentage that moves after
    // the reader has seen it is worse than one that arrives a moment later.
    mockRpcResults.taste_match = undefined;

    const view = await open();
    await waitFor(() => expect(view.getByText('@anna')).toBeTruthy());

    expect(view.queryByText('Match')).toBeNull();
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
    expect(view.getByRole('button', { name: 'Bingd Awards' })).toBeTruthy();
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

    await fireEvent.press(view.getByRole('button', { name: 'Bingd Awards' }));

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
    expect(view.queryByRole('button', { name: 'Bingd Awards' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Share Profile' })).toBeNull();
  });
});
