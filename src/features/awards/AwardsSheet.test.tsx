import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { AwardsSheet } from './AwardsSheet';

/**
 * The sheet, against a stubbed database — what the founder's Android checklist looks at.
 *
 * The arithmetic lives in `awards.test.ts` and is not repeated here. What this file is
 * for is the join: that the reads it issues are the ones the row copy claims to be
 * about, that a row is titled by the tier it has reached, that a read which fails costs
 * its own award rather than the whole sheet, and that **every** row opens into what it
 * is made of.
 */

/** Rows per table, keyed by the table the query builder resolved to. */
const mockTables: Record<string, unknown[]> = {};
/** Reads that fail. */
const mockBroken = new Set<string>();
/** Every table this render actually asked for, so a read can be asserted by name. */
const mockAsked: string[] = [];

/** A `PostgrestFilterBuilder` in miniature. Every award read now returns rows. */
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      mockAsked.push(table);
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        not: () => chain,
        or: () => chain,
        order: () => chain,
        then: (resolve: (value: unknown) => unknown) => {
          if (mockBroken.has(table)) {
            return Promise.resolve({ data: null, error: { message: 'nope' } }).then(resolve);
          }
          return Promise.resolve({ data: mockTables[table] ?? [], error: null }).then(resolve);
        },
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

const media = (over: Record<string, unknown> = {}) => ({
  kind: 'movie',
  title: 'A Film',
  season_number: null,
  poster_path: null,
  release_date: '2020-01-01',
  genres: [],
  original_language: 'en',
  parent: null,
  ...over,
});

const watched = (id: string, over: Record<string, unknown> = {}) => ({
  media_item_id: id,
  watched_on: null,
  note: null,
  note_visibility: null,
  media_items: media(over),
});

const movies = (n: number, over: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => watched(`m${i}`, { title: `Film ${i}`, ...over }));

const profile = (username: string, name = username) => ({
  id: `id-${username}`,
  username,
  display_name: name,
  avatar_path: null,
});

beforeEach(() => {
  for (const key of Object.keys(mockTables)) delete mockTables[key];
  mockBroken.clear();
  mockAsked.length = 0;
});

/**
 * The count on the right of a row.
 *
 * `includeHiddenElements` because the row hides it from the accessibility tree on
 * purpose — the whole row is one announcement, and a second reading of "84 / 200" as
 * "eighty-four slash two hundred" helps nobody.
 */
const count = (text: string) => screen.getByText(text, { includeHiddenElements: true });

const open = async (props: Partial<React.ComponentProps<typeof AwardsSheet>> = {}) => {
  const view = await renderWithProviders(
    <AwardsSheet userId="me" onClose={() => {}} {...props} />,
  );
  await waitFor(() => expect(screen.getByText('Movie Muncher')).toBeTruthy());
  return view;
};

/** Opens one award's breakdown. Rows are found by the name they are titled with. */
const drillInto = async (rowTitle: string) => {
  fireEvent.press(screen.getByLabelText(new RegExp(`^${rowTitle}\\.`)));
  await waitFor(() => expect(screen.getByText('Close')).toBeTruthy());
};

describe('the sheet', () => {
  it('lists all twenty tracks whether or not anything is earned', async () => {
    await open();
    for (const name of ['Movie Muncher', 'Passport Mode', 'Mutual Mania', 'Two-Screen Life']) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it('opens with its own name and no scoreline above the rows', async () => {
    mockTables.user_media = movies(60);
    await open();
    expect(screen.getByText('Bingd Awards')).toBeTruthy();
    expect(screen.queryByText(/awards earned/)).toBeNull();
  });

  it('shows the goal still to reach, with the count beside it', async () => {
    mockTables.user_media = movies(7);
    await open();
    expect(screen.getByText('Next: Watch 50 movies')).toBeTruthy();
    expect(count('7 / 50')).toBeTruthy();
  });

  it('loses one award to a failed read rather than the whole sheet, and says which', async () => {
    mockTables.user_media = movies(60);
    mockBroken.add('follows');
    await open();

    expect(screen.getByLabelText('Mutual Mania. Could not load this one')).toBeTruthy();
    expect(count('—')).toBeTruthy();
    // Nineteen still loaded.
    expect(screen.getByLabelText(/^Movie Muncher\. Bronze earned/)).toBeTruthy();
  });

  it('gives up on the sheet when the collection itself cannot be read', async () => {
    mockBroken.add('user_media');
    await renderWithProviders(<AwardsSheet userId="me" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Could not load your awards')).toBeTruthy());
  });
});

/**
 * **The row is titled by the tier it has reached, and that is the reward.**
 *
 * It used to keep the family name and add a third line reading "Dabbler earned", which
 * stated the achievement and celebrated it nowhere.
 */
describe('what a row is called', () => {
  /** One film per genre, which is the cheapest way to move Genre Gremlin. */
  const genres = (names: string[]) =>
    names.map((genre, i) => watched(`g${i}`, { title: `Film ${i}`, genres: [genre] }));

  const EIGHT = [
    'Action',
    'Adventure',
    'Animation',
    'Comedy',
    'Crime',
    'Drama',
    'Family',
    'Fantasy',
  ];
  const FOURTEEN = [...EIGHT, 'History', 'Horror', 'Music', 'Mystery', 'Romance', 'Thriller'];

  it('shows the family name and the requirement while locked', async () => {
    mockTables.user_media = genres(EIGHT.slice(0, 6));
    await open();
    expect(screen.getByText('Genre Gremlin')).toBeTruthy();
    expect(screen.getByText('Next: Watch 8 different genres')).toBeTruthy();
    expect(count('6 / 8')).toBeTruthy();
    // The reward is not spent early: the tier's name is nowhere on the sheet.
    expect(screen.queryByText('Dabbler')).toBeNull();
  });

  it('becomes the tier name once it is earned, with no separate earned line', async () => {
    mockTables.user_media = genres(EIGHT);
    await open();
    expect(screen.getByText('Dabbler')).toBeTruthy();
    expect(screen.getByText('Next: Watch 14 different genres')).toBeTruthy();
    // Both the old line and the next tier's name are absent.
    expect(screen.queryByText('Dabbler earned')).toBeNull();
    expect(screen.queryByText('Mixer')).toBeNull();
  });

  it('advances to the second tier name', async () => {
    mockTables.user_media = genres(FOURTEEN);
    await open();
    expect(screen.getByText('Mixer')).toBeTruthy();
    expect(screen.queryByText('Genre Gremlin')).toBeNull();
    expect(screen.queryByText('Chaos Collector')).toBeNull();
  });

  it('keeps the family name on a generic Bronze/Silver/Gold track', async () => {
    mockTables.user_media = movies(60);
    await open();
    // Earned at Bronze and still called Movie Muncher. A row headed "Bronze" would say
    // nothing about what was done.
    expect(screen.getByText('Movie Muncher')).toBeTruthy();
    expect(screen.queryByText('Bronze')).toBeNull();
    // The tier is still announced, so a screen reader is told what a sighted reader
    // sees in the art and the dots.
    expect(screen.getByLabelText(/^Movie Muncher\. Bronze earned/)).toBeTruthy();
  });

  it('says a locked track is locked without naming what it would become', async () => {
    await open();
    expect(screen.getByLabelText(/^Season Snacker\. Bronze locked/)).toBeTruthy();
    expect(screen.getByLabelText(/^Genre Gremlin\. Dabbler locked/)).toBeTruthy();
  });
});

/**
 * Every row opens. The founder's principle: a number the reader is shown is a number
 * they are entitled to check.
 */
describe('every award is explainable', () => {
  it('makes all twenty rows tappable', async () => {
    mockTables.user_media = movies(3);
    await open({ onPressTitle: () => {} });
    const awardRows = screen
      .getAllByRole('button')
      .filter((node) => /\. (Next:|[A-Z][a-z]+ (earned|locked))/.test(String(node.props.accessibilityLabel ?? '')));
    expect(awardRows).toHaveLength(20);
  });

  it('opens even where there is no navigation to offer', async () => {
    // The breakdown is worth showing on its own; only the links inside it need a route.
    mockTables.user_media = movies(3);
    await open();
    await drillInto('Movie Muncher');
    expect(screen.getByText(/3 \/ 50/)).toBeTruthy();
  });

  it('leaves a row whose number could not be read unpressable', async () => {
    mockBroken.add('follows');
    await open({ onPressTitle: () => {} });
    expect(
      screen.getByLabelText('Mutual Mania. Could not load this one').props.accessibilityRole,
    ).toBe('text');
  });
});

/**
 * A big collection must not be a big render.
 *
 * The founder's stated worst case is 1,000 movies and 500 ranked titles, and Movie
 * Muncher's gold tier is exactly 1,000 — so the sheet's ceiling and the collection's are
 * the same number. A `ScrollView` mounts every child it is handed, `maxHeight` bounds only
 * the viewport, and each title row carries a poster: before the cap, opening that award
 * mounted a thousand rows and started a thousand image requests in one frame.
 *
 * These tests are about the *mount*, which is why they count rendered rows rather than
 * asserting a number in the header. The header's number is the award's own and is proved
 * elsewhere — and the point of the cap is precisely that the two are allowed to differ,
 * as long as the sheet says so.
 */
describe('a long breakdown is revealed in pages', () => {
  /**
   * A title row, by the label the row announces itself with.
   *
   * Not `getByText`: `TitleRow` draws the year inside the same `Text` as the title, so
   * "Film 0" renders as "Film 0 (2020)" and an anchored text match silently finds
   * nothing. The accessibility label is the exact string and is what a screen reader
   * would read out, which makes it the better assertion anyway.
   */
  const film = (n: number) => screen.queryByLabelText(`Film ${n}, 2020`);

  /**
   * Presses a `Button` by its role.
   *
   * `Button` wraps its label in a `View` with `pointerEvents="none"`, so pressing the
   * text node does nothing at all — the press is swallowed and the test goes on to
   * assert against a sheet that never changed. Found the hard way: the first version of
   * these tests pressed the text and failed three assertions downstream for a reason
   * that looked like a pagination bug.
   */
  const press = (name: string) => fireEvent.press(screen.getByRole('button', { name }));

  it('mounts a page of rows rather than the whole collection', async () => {
    mockTables.user_media = movies(400);
    await open({ onPressTitle: () => {} });
    await drillInto('Movie Muncher');

    // Film 0..49 are mounted; Film 50 onward is not, which is the whole point: the
    // ScrollView would otherwise hold four hundred rows and four hundred posters.
    expect(film(0)).toBeTruthy();
    expect(film(49)).toBeTruthy();
    expect(film(50)).toBeNull();
    expect(film(399)).toBeNull();
  });

  it('says how many of how many, rather than hiding behind "more"', async () => {
    mockTables.user_media = movies(400);
    await open({ onPressTitle: () => {} });
    await drillInto('Movie Muncher');

    // The count above is 400; the list shows 50. A reader who counts the rows to check
    // the badge is owed the reason they do not match.
    expect(screen.getByText('Showing 50 of 400')).toBeTruthy();
  });

  it('reveals the next page on request, and stops offering when there are none', async () => {
    mockTables.user_media = movies(120);
    await open({ onPressTitle: () => {} });
    await drillInto('Movie Muncher');

    press('Show 50 more');
    await waitFor(() => expect(film(99)).toBeTruthy());
    expect(screen.getByText('Showing 100 of 120')).toBeTruthy();

    // The last page is short, and the control says so rather than over-promising.
    press('Show 20 more');
    await waitFor(() => expect(film(119)).toBeTruthy());
    expect(screen.queryByText(/^Showing /)).toBeNull();
    expect(screen.queryByText(/^Show \d+ more$/)).toBeNull();
  });

  it('offers nothing to expand when the whole breakdown already fits', async () => {
    mockTables.user_media = movies(12);
    await open({ onPressTitle: () => {} });
    await drillInto('Movie Muncher');

    expect(film(11)).toBeTruthy();
    expect(screen.queryByText(/^Showing /)).toBeNull();
    expect(screen.queryByText(/^Show \d+ more$/)).toBeNull();
  });

  it('starts a freshly opened award at the first page rather than the last one expanded', async () => {
    mockTables.user_media = movies(400);
    await open({ onPressTitle: () => {} });

    await drillInto('Movie Muncher');
    press('Show 50 more');
    await waitFor(() => expect(screen.getByText('Showing 100 of 400')).toBeTruthy());
    press('Close');

    await waitFor(() => expect(screen.queryByText(/^Showing /)).toBeNull());
    await drillInto('Movie Muncher');
    expect(screen.getByText('Showing 50 of 400')).toBeTruthy();
  });
});

describe('the breakdowns', () => {
  it('Movie Muncher lists the films, with the date where there is one', async () => {
    mockTables.user_media = [
      watched('a', { title: 'Ringu', release_date: '1998-01-31' }),
      { ...watched('b', { title: 'Airplane!' }), watched_on: '2026-02-03' },
    ];
    await open({ onPressTitle: () => {} });
    await drillInto('Movie Muncher');

    expect(screen.getByText(/Ringu/)).toBeTruthy();
    expect(screen.getByText(/Airplane!/)).toBeTruthy();
    expect(screen.getByText(/^Watched /)).toBeTruthy();
  });

  it('Season Snacker names a season by its show', async () => {
    mockTables.user_media = [
      watched('s1', {
        kind: 'season',
        title: 'Season 1',
        season_number: 1,
        release_date: '2023-01-15',
        parent: { title: 'The Last of Us', genres: ['Drama'], original_language: 'en' },
      }),
    ];
    await open({ onPressTitle: () => {} });
    await drillInto('Season Snacker');
    expect(screen.getByText(/The Last of Us, S1/)).toBeTruthy();
  });

  it('a genre award includes a TV season through its series genres', async () => {
    // The whole point of the metadata inheritance: the season carries no genres of its
    // own, and Softie Hours counts it because the show is a drama.
    mockTables.user_media = [
      watched('s1', {
        kind: 'season',
        title: 'Season 1',
        season_number: 1,
        parent: { title: 'The Last of Us', genres: ['Drama'], original_language: 'en' },
      }),
    ];
    await open({ onPressTitle: () => {} });
    expect(count('1 / 25')).toBeTruthy();
    await drillInto('Softie Hours');
    expect(screen.getByText(/The Last of Us, S1/)).toBeTruthy();
  });

  it('Passport Mode names the language rather than printing its code', async () => {
    mockTables.user_media = [watched('a', { title: 'Ringu', original_language: 'ja' })];
    await open({ onPressTitle: () => {} });
    await drillInto('Passport Mode');
    expect(screen.getByText('Japanese')).toBeTruthy();
  });

  it('Genre Gremlin lists genres, not titles, and the rows are the numerator', async () => {
    mockTables.user_media = [
      watched('a', { genres: ['Action'] }),
      watched('b', { genres: ['Action'] }),
      watched('c', { genres: ['Comedy'] }),
    ];
    await open({ onPressTitle: () => {} });
    await drillInto('Genre Gremlin');

    expect(screen.getByText('Action')).toBeTruthy();
    expect(screen.getByText('2 titles')).toBeTruthy();
    expect(screen.getByText('Comedy')).toBeTruthy();
    // Two genre rows against a numerator of two.
    expect(screen.getByText(/2 \/ 8/)).toBeTruthy();
  });

  it('Two-Screen Life shows both sides with their own caps', async () => {
    mockTables.user_media = [
      ...movies(3),
      ...Array.from({ length: 2 }, (_, i) =>
        watched(`s${i}`, {
          kind: 'season',
          title: `Season ${i + 1}`,
          season_number: i + 1,
          parent: { title: 'A Show', genres: [], original_language: 'en' },
        }),
      ),
    ];
    await open({ onPressTitle: () => {} });
    await drillInto('Two-Screen Life');

    expect(screen.getByText('Movies')).toBeTruthy();
    expect(screen.getByText('3 / 15')).toBeTruthy();
    expect(screen.getByText('TV seasons')).toBeTruthy();
    expect(screen.getByText('2 / 15')).toBeTruthy();
    // And the award's own line, which is the sum.
    expect(screen.getByText(/5 \/ 30/)).toBeTruthy();
  });

  it('Rating Rascal shows the score the reader gave', async () => {
    mockTables.user_media = movies(1);
    mockTables.rankings = [
      {
        media_item_id: 'm0',
        bucket: 'loved',
        position: 1,
        category: 'movies',
        media_items: media({ title: 'Heat' }),
      },
    ];
    await open({ onPressTitle: () => {} });
    await drillInto('Rating Rascal');
    expect(screen.getByText(/Heat/)).toBeTruthy();
    // A single loved title sits at the top of its band.
    expect(screen.getByText('10.0')).toBeTruthy();
  });

  it('Queue Dragon lists the watchlist being held now', async () => {
    mockTables.watchlist = [{ media_item_id: 'w1', media_items: media({ title: 'Dune' }) }];
    await open({ onPressTitle: () => {} });
    await drillInto('Queue Dragon');
    expect(screen.getByText(/Dune/)).toBeTruthy();
  });

  it('Comment Gremlin distinguishes a comment from a public note', async () => {
    mockTables.user_media = [
      {
        ...watched('a', { title: 'Arrival' }),
        note: 'Loved the structure.',
        note_visibility: 'public',
      },
    ];
    mockTables.comments = [
      {
        id: 'c1',
        created_at: '2026-01-02T00:00:00Z',
        feed_event_id: 'e1',
        feed_events: { media_item_id: 'b', media_items: media({ title: 'Heat' }) },
      },
    ];
    await open({ onPressTitle: () => {} });
    await drillInto('Comment Gremlin');

    expect(screen.getByText('Public note')).toBeTruthy();
    expect(screen.getByText(/^Comment · /)).toBeTruthy();
    // Never the writing itself.
    expect(screen.queryByText(/Loved the structure/)).toBeNull();
  });

  it('Hype Courier names the title and who it went to', async () => {
    mockTables.title_recommendations = [
      {
        id: 'r1',
        recommended_at: '2026-01-02T00:00:00Z',
        recipient_id: 'id-ada',
        media_items: media({ title: 'Heat' }),
        recipient: profile('ada', 'Ada'),
      },
    ];
    await open({ onPressTitle: () => {} });
    await drillInto('Hype Courier');
    expect(screen.getByText(/Heat/)).toBeTruthy();
    expect(screen.getByText(/To Ada/)).toBeTruthy();
  });

  it('Heart Magnet counts reactions per item, and the rows sum to the number', async () => {
    mockTables.reactions = [
      {
        feed_event_id: 'e1',
        feed_events: { media_item_id: 'a', media_items: media({ title: 'Heat' }) },
      },
      {
        feed_event_id: 'e1',
        feed_events: { media_item_id: 'a', media_items: media({ title: 'Heat' }) },
      },
      {
        feed_event_id: 'e2',
        feed_events: { media_item_id: 'b', media_items: media({ title: 'Arrival' }) },
      },
    ];
    await open({ onPressTitle: () => {} });
    expect(count('3 / 50')).toBeTruthy();
    await drillInto('Heart Magnet');

    expect(screen.getByText('2 reactions')).toBeTruthy();
    expect(screen.getByText('1 reaction')).toBeTruthy();
    // Who reacted is nowhere on the sheet.
    expect(screen.queryByText(/@/)).toBeNull();
  });

  it('Mutual Mania lists the people who follow back', async () => {
    mockTables.follows = [
      {
        follower_id: 'me',
        followee_id: 'id-ada',
        follower: profile('me'),
        followee: profile('ada', 'Ada'),
      },
      {
        follower_id: 'id-ada',
        followee_id: 'me',
        follower: profile('ada', 'Ada'),
        followee: profile('me'),
      },
      // One direction only: not a mutual, and not in the list.
      {
        follower_id: 'id-bo',
        followee_id: 'me',
        follower: profile('bo', 'Bo'),
        followee: profile('me'),
      },
    ];
    await open({ onPressTitle: () => {} });
    expect(count('1 / 5')).toBeTruthy();
    await drillInto('Mutual Mania');

    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.getByText('@ada')).toBeTruthy();
    expect(screen.queryByText('Bo')).toBeNull();
  });

  it('Invite Instigator is tappable and truthfully empty', async () => {
    await open({ onPressTitle: () => {} });
    await drillInto('Invite Instigator');
    expect(screen.getByText('No activated invites yet.')).toBeTruthy();
  });

  it('leads to a title', async () => {
    const onPressTitle = jest.fn();
    mockTables.user_media = [watched('a', { title: 'Ringu' })];

    await open({ onPressTitle });
    await drillInto('Movie Muncher');
    fireEvent.press(screen.getByText(/Ringu/));

    expect(onPressTitle).toHaveBeenCalledWith('a');
  });

  it('leads to a profile', async () => {
    const onPressProfile = jest.fn();
    mockTables.follows = [
      {
        follower_id: 'me',
        followee_id: 'id-ada',
        follower: profile('me'),
        followee: profile('ada', 'Ada'),
      },
      {
        follower_id: 'id-ada',
        followee_id: 'me',
        follower: profile('ada', 'Ada'),
        followee: profile('me'),
      },
    ];

    await open({ onPressProfile });
    await drillInto('Mutual Mania');
    fireEvent.press(screen.getByText('Ada'));

    expect(onPressProfile).toHaveBeenCalledWith('ada');
  });
});

/**
 * The reads are the authorization, and the drill-downs inherit it.
 *
 * Nothing here asks for more than the count already counted — the same rows, rendered.
 */
describe('privacy', () => {
  it('shows a person the reader may not see without disclosing them', async () => {
    // `can_i_view` filters the embed, so a blocked or suspended account comes back with
    // no profile. The follow still counts; the row says nothing about who it is.
    mockTables.follows = [
      { follower_id: 'me', followee_id: 'id-x', follower: profile('me'), followee: null },
      { follower_id: 'id-x', followee_id: 'me', follower: null, followee: profile('me') },
    ];
    await open({ onPressProfile: () => {} });
    expect(count('1 / 5')).toBeTruthy();
    await drillInto('Mutual Mania');

    expect(screen.getByText('Someone on Bingd')).toBeTruthy();
    expect(screen.getByText('This account is not available to you')).toBeTruthy();
  });

  it('reads attributed signups and never invite link creations', async () => {
    await open();
    expect(mockAsked).toContain('invite_attributions');
    expect(mockAsked).not.toContain('invite_link_creations');
  });
});
