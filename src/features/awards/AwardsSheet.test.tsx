import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

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

/**
 * A PostgREST that applies what the reads say (`test-utils/postgrest.ts`).
 *
 * **The filters are honoured, and that is not decoration.** These reads page to
 * exhaustion by keyset, so a stub that ignored `gt` and `limit` and handed back the
 * whole seeded array every time would make the loop look like it worked while testing
 * nothing — and would hide the opposite bug, a loop that never ends because every page
 * looks full. `follows` is read twice, once per direction, and only a mock that applies
 * `eq` can tell the two apart at all.
 */
jest.mock('@/lib/supabase', () => {
  // Everything is inside the factory because `jest.mock` is hoisted above the imports
  // *and* above this file's own `const`s — a table object declared out here would be
  // captured as `undefined`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createPostgrest } = require('@/test-utils/postgrest');
  const client = createPostgrest();
  (globalThis as { __pg?: unknown }).__pg = client;
  return { supabase: { from: client.from, rpc: client.rpc }, startSessionRefresh: () => () => {} };
});

const pg = () =>
  (globalThis as unknown as { __pg: import('@/test-utils/postgrest').Postgrest }).__pg;

/** Rows per table, keyed by the table the query builder resolved to. */
const mockTables = pg().tables;

const OWNER = 'me';

/**
 * The columns each read filters on, stamped onto whatever a test seeds.
 *
 * They are here rather than in every literal because they are not what any test is
 * about — but they cannot be *skipped*, because a stand-in that ignored `eq(user_id)`
 * would answer a scoped read and an unscoped one identically, which is the shape of
 * half the defects this suite exists for. Seeded rows spell out only what their test
 * cares about; this makes them rows the shipped query would actually match.
 */
const SCOPE: Record<string, (row: Record<string, unknown>, index: number) => unknown> = {
  user_media: (row) => ({ user_id: OWNER, ...row }),
  rankings: (row) => ({ user_id: OWNER, ...row }),
  watchlist: (row, i) => ({
    user_id: OWNER,
    created_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    ...row,
  }),
  invite_attributions: (row) => ({ inviter_id: OWNER, activated_at: null, ...row }),
  comments: (row) => ({ author_id: OWNER, ...row }),
  title_recommendations: (row) => ({ sender_id: OWNER, ...row }),
  // A reaction is keyed by the pair, and two reactions on one event come from two
  // people — which is also what keeps the composite cursor's keys distinct.
  reactions: (row, i) => ({
    user_id: `reactor-${i}`,
    ...row,
    feed_events: { actor_id: OWNER, ...((row.feed_events as object) ?? {}) },
  }),
  follows: (row) => ({ state: 'approved', ...row }),
};

const seed = (table: string, rows: unknown[]) => {
  const stamp = SCOPE[table] ?? ((row: unknown) => row);
  mockTables[table] = rows.map((row, i) => stamp(row as Record<string, unknown>, i));
};
/** Reads that fail. */
const mockBroken = () => pg().broken;
/** Every table this render actually asked for, so a read can be asserted by name. */
const mockAsked = () => pg().reads.map((read) => read.table);
/** How many requests each table was asked for, so paging can be asserted. */
const mockRequests = () => pg().requests;

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

/**
 * `n` films. The ids are zero-padded because the read is ordered by them.
 *
 * `m10` sorts before `m2`, so unpadded ids would put Film 10 ahead of Film 2 in every
 * breakdown and make the pagination assertions below about nothing in particular. Real
 * ids are UUIDs, whose text order is their byte order; padding is how a readable id
 * behaves the same way.
 */
const movies = (n: number, over: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) =>
    watched(`m${String(i).padStart(4, '0')}`, { title: `Film ${i}`, ...over }),
  );

const profile = (username: string, name = username) => ({
  id: `id-${username}`,
  username,
  display_name: name,
  avatar_path: null,
});

beforeEach(() => {
  for (const key of Object.keys(mockTables)) delete mockTables[key];
  for (const key of Object.keys(pg().requests)) delete pg().requests[key];
  pg().reads.length = 0;
  pg().broken.clear();
  pg().between = () => {};
  for (const key of Object.keys(pg().rpcAnswers)) delete pg().rpcAnswers[key];
  pg().rpcCalls.length = 0;
});

/**
 * The count on the right of a row.
 *
 * `includeHiddenElements` because the row hides it from the accessibility tree on
 * purpose — the whole row is one announcement, and a second reading of "84 / 200" as
 * "eighty-four slash two hundred" helps nobody.
 */
const count = (text: string) => screen.getByText(text, { includeHiddenElements: true });

/**
 * The scrolling container the award rows sit in, found by walking up from a row.
 *
 * By its `contentContainerStyle`, which only a scroll view has — rather than by a
 * `testID` added to the source for this test’s benefit, and rather than by type, which
 * this library stopped offering a query for at v14.
 */
const awardList = () => {
  let node = screen.getByText('Movie Muncher').parent;
  while (node && node.props?.contentContainerStyle === undefined) node = node.parent;
  if (!node) throw new Error('no scroll container above the award rows');
  return {
    style: StyleSheet.flatten(node.props.style),
    content: StyleSheet.flatten(node.props.contentContainerStyle),
  };
};

const open = async (props: Partial<React.ComponentProps<typeof AwardsSheet>> = {}) => {
  const view = await renderWithProviders(
    <AwardsSheet viewerId="me" userId="me" onClose={() => {}} {...props} />,
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

  /**
   * The founder’s second safe-area finding, which was really two.
   *
   * Done sits under a list of twenty rows that is always taller than the sheet on a
   * phone. The list was `flexGrow: 0` and nothing else — and a flex child in React
   * Native does not shrink unless it is told to, so it kept its full measured height
   * and pushed the footer past the bottom of a sheet capped at 90%.
   */
  it('keeps Done reachable under a list of twenty', async () => {
    await open();

    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeTruthy();

    // The list yields the space, rather than the footer being pushed out of the sheet.
    expect(awardList().style.flexShrink).toBe(1);
    // And it does not stretch when there is little to show — the loading and error
    // states are three rows, not a sheetful.
    expect(awardList().style.flexGrow).toBe(0);
  });

  it('leaves room under the last award for the sticky footer', async () => {
    // Without it the twentieth row finishes hard against Done, which is what the
    // founder saw as the content running into the footer.
    await open();

    expect(awardList().content.paddingBottom).toBeGreaterThanOrEqual(16);
  });

  it('opens with its own name and no scoreline above the rows', async () => {
    seed('user_media', movies(60));
    await open();
    expect(screen.getByText('bingd. Awards')).toBeTruthy();
    expect(screen.queryByText(/awards earned/)).toBeNull();
  });

  it('shows the goal still to reach, with the count beside it', async () => {
    seed('user_media', movies(7));
    await open();
    expect(screen.getByText('Next: Watch 50 movies')).toBeTruthy();
    expect(count('7 / 50')).toBeTruthy();
  });

  it('loses one award to a failed read rather than the whole sheet, and says which', async () => {
    seed('user_media', movies(60));
    mockBroken().add('follows');
    await open();

    expect(screen.getByLabelText('Mutual Mania. Could not load this one')).toBeTruthy();
    expect(count('—')).toBeTruthy();
    // Nineteen still loaded.
    expect(screen.getByLabelText(/^Movie Muncher\. Bronze earned/)).toBeTruthy();
  });

  /**
   * A collection that cannot be read costs the awards made of it, and no others.
   *
   * It used to reject the whole sheet, on the reasoning that thirteen tracks are
   * meaningless without the collection. Thirteen are — and seven are not, so refusing
   * those seven was the same wrong answer in the other direction. Review 21b's nit, and
   * it matters most in exactly the case the ceiling was built for: a collection too
   * large to read is no reason to withhold Mutual Mania.
   */
  it('costs the awards made of the collection, and keeps the ones that are not', async () => {
    mockBroken().add('user_media');
    seed('follows', [
      { follower_id: 'me', followee_id: 'id-ada', follower: profile('me'), followee: profile('ada', 'Ada') },
      { follower_id: 'id-ada', followee_id: 'me', follower: profile('ada', 'Ada'), followee: profile('me') },
    ]);
    await open();

    expect(screen.getByLabelText('Movie Muncher. Could not load this one')).toBeTruthy();
    expect(screen.queryByText('Could not load these awards')).toBeNull();
    // Mutual Mania has nothing to do with the collection and still knows its number.
    expect(count('1 / 5')).toBeTruthy();
  });

  it('still gives up on the whole sheet when nothing at all can be read', async () => {
    // Per-field degradation is right for one failed read and wrong for a device with no
    // signal: twenty rows of dashes is a worse sentence than one that says so and offers
    // Try again.
    for (const table of [
      'user_media',
      'rankings',
      'watchlist',
      'invite_attributions',
      'comments',
      'title_recommendations',
      'reactions',
      'follows',
    ]) {
      mockBroken().add(table);
    }

    await renderWithProviders(<AwardsSheet viewerId="me" userId="me" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Could not load these awards')).toBeTruthy());
  });

  it('keeps the written count when the collection is what failed', async () => {
    // **This used to be the other way round**, and the reason it flipped is the
    // founder's split. Comment Gremlin counted comments *plus* public notes, and notes
    // are rows on `user_media` — so a failed collection read had to take the written
    // count with it or report a confident undercount. Reviews left the track on
    // 2026-08-29, `written` comes from one query, and a collection that could not be
    // read now costs the thirteen collection tracks and not this one.
    mockBroken().add('user_media');
    seed('comments', [
      {
        id: 'c1',
        created_at: '2026-01-02T00:00:00Z',
        feed_event_id: 'e1',
        feed_events: { media_item_id: 'b', media_items: media({ title: 'Heat' }) },
      },
    ]);
    await open();

    // The collection tracks are the ones apologising; the comment track is not.
    expect(screen.getByLabelText('Movie Muncher. Could not load this one')).toBeTruthy();
    expect(screen.queryByLabelText('Comment Gremlin. Could not load this one')).toBeNull();
    expect(
      screen.getByLabelText('Comment Gremlin. Whisper locked. Next: Write 20 comments. 1 of 20'),
    ).toBeTruthy();
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

  /**
   * Fourteen genres: Dabbler, after the 2026-08-20 rebalance moved the ladder to
   * 14 / 16 / 17. The whole vocabulary is eighteen, so these are named out in full rather
   * than sliced from `CANONICAL_GENRES` — a fixture that tracked the constant would keep
   * passing if the constant and the threshold moved together, which is the one thing
   * these tests exist to catch.
   */
  const FOURTEEN = [
    'Action',
    'Adventure',
    'Animation',
    'Comedy',
    'Crime',
    'Documentary',
    'Drama',
    'Family',
    'Fantasy',
    'History',
    'Horror',
    'Music',
    'Mystery',
    'Romance',
  ];
  const SIXTEEN = [...FOURTEEN, 'Science Fiction', 'Thriller'];

  it('shows the family name and the requirement while locked', async () => {
    seed('user_media', genres(FOURTEEN.slice(0, 6)));
    await open();
    expect(screen.getByText('Genre Gremlin')).toBeTruthy();
    expect(screen.getByText('Next: Watch 14 different genres')).toBeTruthy();
    expect(count('6 / 14')).toBeTruthy();
    // The reward is not spent early: the tier's name is nowhere on the sheet.
    expect(screen.queryByText('Dabbler')).toBeNull();
  });

  it('becomes the tier name once it is earned, with no separate earned line', async () => {
    seed('user_media', genres(FOURTEEN));
    await open();
    expect(screen.getByText('Dabbler')).toBeTruthy();
    expect(screen.getByText('Next: Watch 16 different genres')).toBeTruthy();
    // Both the old line and the next tier's name are absent.
    expect(screen.queryByText('Dabbler earned')).toBeNull();
    expect(screen.queryByText('Mixer')).toBeNull();
  });

  it('advances to the second tier name', async () => {
    seed('user_media', genres(SIXTEEN));
    await open();
    expect(screen.getByText('Mixer')).toBeTruthy();
    expect(screen.getByText('Next: Watch 17 different genres')).toBeTruthy();
    expect(screen.queryByText('Genre Gremlin')).toBeNull();
    expect(screen.queryByText('Chaos Collector')).toBeNull();
  });

  it('reaches the top tier one genre short of the whole vocabulary', async () => {
    // Seventeen, not eighteen, and this is the fixture that says so on the sheet itself:
    // the reader who has never logged a Western is still Chaos Collector.
    seed('user_media', genres([...SIXTEEN, 'War']));
    await open();
    expect(screen.getByText('Chaos Collector')).toBeTruthy();
    expect(screen.getByText('Watched 17 different genres')).toBeTruthy();
  });

  it('keeps the family name on a generic Bronze/Silver/Gold track', async () => {
    seed('user_media', movies(60));
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

  /**
   * **A track with nothing earned is muted, title included** (founder, 2026-08-30).
   *
   * The badge already dimmed. The title stayed full ink, so a locked row read as an
   * earned one that happened to have a grey picture beside it — and a sheet of twenty is
   * scanned for exactly one thing, which of them have been won.
   *
   * Asserted against the tokens rather than a hex, because the rule is "use the muted
   * tone", not "use #5F5A56": a palette change must move these rows with everything
   * else, and a literal here would silently stop tracking it.
   */
  const titleColour = (label: string) =>
    (StyleSheet.flatten(screen.getByText(label).props.style) as { color?: string }).color;

  it('draws the title of a track with no tier earned in the muted tone', async () => {
    await open();

    // Nothing seeded, so every track is at zero.
    expect(titleColour('Movie Muncher')).toBe(theme.text.secondary);
    expect(titleColour('Genre Gremlin')).toBe(theme.text.secondary);
    // And it is genuinely a step down from ink rather than the same value twice.
    expect(theme.text.secondary).not.toBe(theme.text.primary);
  });

  it('returns the title to ink at the first tier, and keeps it there after', async () => {
    // Movie Muncher at Bronze: the family name, now earned. The threshold is the only
    // thing that moved between this fixture and the one above.
    seed('user_media', movies(60));
    await open();
    expect(titleColour('Movie Muncher')).toBe(theme.text.primary);

    // A track still at zero on the same sheet stays muted, so this is the row's own
    // state rather than a sheet-wide flag.
    expect(titleColour('Season Snacker')).toBe(theme.text.secondary);
  });

  it('keeps the requirement readable under a muted title', async () => {
    // The muted tone is `secondary` and not `tertiary` for this reason: a locked row
    // still has to say what would earn it, and a title fainter than its own subtitle
    // reads as broken rather than as locked.
    await open();
    const detail = screen.getByText('Next: Watch 14 different genres');
    const colour = (StyleSheet.flatten(detail.props.style) as { color?: string }).color;
    expect(colour).toBe(theme.text.secondary);
    expect(titleColour('Genre Gremlin')).toBe(theme.text.secondary);
  });

  it('draws a later tier in ink too', async () => {
    // Not "the first tier only". Every earned state is ink; only zero is muted.
    seed('user_media', genres(SIXTEEN));
    await open();
    expect(titleColour('Mixer')).toBe(theme.text.primary);
  });
});

/**
 * Every row opens. The founder's principle: a number the reader is shown is a number
 * they are entitled to check.
 */
describe('every award is explainable', () => {
  it('makes all twenty rows tappable', async () => {
    seed('user_media', movies(3));
    await open({ onPressTitle: () => {} });
    const awardRows = screen
      .getAllByRole('button')
      .filter((node) => /\. (Next:|[A-Z][a-z]+ (earned|locked))/.test(String(node.props.accessibilityLabel ?? '')));
    expect(awardRows).toHaveLength(20);
  });

  it('opens even where there is no navigation to offer', async () => {
    // The breakdown is worth showing on its own; only the links inside it need a route.
    seed('user_media', movies(3));
    await open();
    await drillInto('Movie Muncher');
    expect(screen.getByText(/3 \/ 50/)).toBeTruthy();
  });

  it('leaves a row whose number could not be read unpressable', async () => {
    mockBroken().add('follows');
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
/**
 * A count past the page size is still the whole count.
 *
 * PostgREST caps an unbounded select at 1,000 rows on this project — measured, not
 * assumed: `media_items` holds 2,835 and a select with no range returns exactly 1,000,
 * with the only evidence in a `Content-Range` header supabase-js throws away. Silent, so
 * the award simply reports a smaller number than the truth.
 *
 * It lands worst on the one track where the numbers coincide: **Movie Muncher's gold tier
 * is 1,000 movies.** A reader with 1,000 films and any television at all has more than
 * 1,000 rows in `user_media`, so before this fix the read came back short and the badge
 * they had earned could not be unlocked, for a reason nothing on screen could explain.
 */
describe('a collection past the page size', () => {
  it('counts every title rather than the first page of them', async () => {
    // 1,200 films: past the 1,000-row cap, and past Movie Muncher's gold tier.
    seed('user_media', movies(1200));
    await open();

    // Every tier earned, so the label is the bare total rather than a fraction.
    expect(count('1,200')).toBeTruthy();
    // Two requests, not one: the first page came back full, so there had to be a second.
    expect(mockRequests().user_media).toBe(2);
  });

  it('asks once more when the total lands exactly on a page boundary', async () => {
    seed('user_media', movies(1000));
    await open();

    expect(count('1,000')).toBeTruthy();
    // A full page cannot be known to be the last one, so the empty page is the price of
    // not guessing — and 1,000 is precisely the total a gold Movie Muncher has.
    expect(mockRequests().user_media).toBe(2);
  });

  it('makes one request when the first page is short', async () => {
    seed('user_media', movies(30));
    await open();
    expect(mockRequests().user_media).toBe(1);
  });

  it('refuses rather than reporting a partial count past the ceiling', async () => {
    // Twelve full pages and no thirteenth request to prove exhaustion. A truncated array
    // here would be a confident wrong number; the dash is the honest one.
    seed('user_media', movies(12_001));
    await open();

    expect(screen.getByLabelText('Movie Muncher. Could not load this one')).toBeTruthy();
  }, 30_000);
});

/**
 * **The number stays right while somebody else is writing.**
 *
 * Independent review 21b: `.range()` paging is not snapshot-consistent, because every
 * page is its own request and its own `READ COMMITTED` transaction. A title logged on
 * another device between two pages shifts the offsets underneath the read — the boundary
 * row arrives twice and one row is never seen — and the total still looks plausible.
 * Codex's sequence is 999 films assembling to 1,000 and unlocking Movie Muncher Gold on
 * an account that has not earned it.
 *
 * The mechanics of that are proved in `lib/read-all.test.ts`, against both strategies.
 * What these two are for is that the *shipped queries* carry the cursor — that the
 * predicate reaches PostgREST rather than living in a helper nothing calls.
 */
describe('while another device is writing', () => {
  it('does not count a film twice when one is logged between two pages', async () => {
    seed('user_media', movies(1500));
    pg().between = (table, requests, tables) => {
      if (table !== 'user_media' || requests !== 1) return;
      // Sorts before page one's boundary — the position that breaks offset paging.
      (tables.user_media as unknown[]).push({
        user_id: OWNER,
        media_item_id: 'm0000-a',
        watched_on: null,
        note: null,
        note_visibility: null,
        media_items: media({ title: 'Logged on the tablet' }),
      });
    };

    await open();

    // 1,500, not 1,501. The row that landed behind the cursor is outside this read
    // rather than duplicated into it, and nothing arrives twice.
    expect(count('1,500')).toBeTruthy();
  }, 30_000);

  it('pages every read on a cursor rather than an offset', async () => {
    seed('user_media', movies(1500));
    await open();

    const paged = pg().reads.filter((read) => read.table === 'user_media');
    expect(paged[0]!.gt).toEqual([]);
    expect(paged[1]!.gt).toEqual([['media_item_id', 'm0999']]);
    // No offsets anywhere on the sheet: `range` is what shifts under a concurrent write.
    expect(pg().reads.every((read) => !('range' in read))).toBe(true);
  }, 30_000);
});

/**
 * The two reads whose keys are pairs, and what each of them does about it.
 *
 * `follows` splits into one request per direction, which makes the other half of the pair
 * unique and the cursor a single column. `reactions` has no direction to split on, so it
 * is the one composite cursor in the app.
 */
describe('a key that is a pair', () => {
  /**
   * **One request, both directions.**
   *
   * This was briefly two requests, one per direction, which makes each cursor a single
   * column and is the obvious thing to do. Independent review 21c killed it: an
   * intersection taken from two snapshots can report a pair that never coexisted — read
   * `me → A`, have it deleted, have `A → me` approved, read the other direction — and
   * Mutual Mania is a present-tense claim about a pair.
   */
  it('reads follows in one request, with both directions and both privacy markers', async () => {
    seed('follows', [
      { follower_id: 'me', followee_id: 'id-ada', follower: profile('me'), followee: profile('ada', 'Ada') },
      { follower_id: 'id-ada', followee_id: 'me', follower: profile('ada', 'Ada'), followee: profile('me') },
    ]);
    await open();

    const reads = pg().reads.filter((read) => read.table === 'follows');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.filters).toEqual({ state: 'approved' });
    expect(reads[0]!.or).toBe('follower_id.eq.me,followee_id.eq.me');
    expect((reads[0]!.columns.match(/!inner/g) ?? []).length).toBe(2);
    expect(count('1 / 5')).toBeTruthy();
  });

  it('cannot report a mutual whose two edges never existed at once', async () => {
    // The sequence review 21c named, run against the stand-in. With one request there is
    // no window between the directions for it to happen in — the write below lands after
    // the only page has been served, so it cannot reach the intersection at all.
    seed('follows', [
      { follower_id: 'me', followee_id: 'id-ada', follower: profile('me'), followee: profile('ada', 'Ada') },
    ]);
    pg().between = (table, requests, tables) => {
      if (table !== 'follows' || requests !== 1) return;
      tables.follows = [
        {
          state: 'approved',
          follower_id: 'id-ada',
          followee_id: 'me',
          follower: profile('ada', 'Ada'),
          followee: profile('me'),
        },
      ];
    };

    await open();

    // Ada follows back only after the read; `me → Ada` was already gone by then. Neither
    // state was ever a mutual, and the sheet does not invent one.
    expect(count('0 / 5')).toBeTruthy();
  });

  /**
   * **Past one page, the number is refused rather than stated.**
   *
   * One request is one `READ COMMITTED` transaction and therefore one snapshot. Two are
   * not: page one can hold `me → A`, that edge can be deleted, `A → me` can be approved,
   * and page two holds the reverse — so the assembled arrays name a mutual that existed
   * at no instant. A count survives being read across pages; an intersection invents a
   * member.
   *
   * Review 21c rejected the two-request version of this and I fixed only the version I
   * had written; 21d pointed out that the multi-page case is the same defect with a
   * higher threshold, and that "every real account is under a thousand edges" is not an
   * invariant anything enforces.
   */
  it('pages the pair, and refuses to state a mutual count taken from two snapshots', async () => {
    seed(
      'follows',
      Array.from({ length: 1200 }, (_, i) => ({
        follower_id: 'me',
        followee_id: `id-${String(i).padStart(5, '0')}`,
        follower: profile('me'),
        followee: profile(`u${i}`),
      })),
    );
    await open();

    const reads = pg().reads.filter((read) => read.table === 'follows');
    expect(reads).toHaveLength(2);
    // The cursor and the direction filter share one `or=`, which is what keeps every page
    // a single request.
    expect(reads[1]!.or).toMatch(
      /^and\(follower_id\.gt\..+,or\(follower_id\.eq\.me,followee_id\.eq\.me\)\),and\(follower_id\.eq\..+,followee_id\.gt\..+,or\(.+\)\)$/,
    );
    // A dash, not a zero and not a number: the read was complete but not atomic.
    expect(screen.getByLabelText('Mutual Mania. Could not load this one')).toBeTruthy();
  }, 30_000);

  it('states the count at exactly one full page, which takes two requests', async () => {
    // Review 21e's first finding, and the sharpest possible landing: a full page is always
    // followed by an exhaustion probe, so 1,000 edges is two requests and one snapshot.
    // Counting requests rather than pages-with-rows put "could not load this one" on an
    // account that was read perfectly.
    seed(
      'follows',
      Array.from({ length: 1000 }, (_, i) => ({
        follower_id: 'me',
        followee_id: `id-${String(i).padStart(5, '0')}`,
        follower: profile('me'),
        followee: profile(`u${i}`),
      })),
    );
    await open();

    expect(pg().requests.follows).toBe(2);
    // One-way follows, so the honest answer is zero — a number, not a dash.
    expect(count('0 / 5')).toBeTruthy();
    expect(screen.queryByLabelText('Mutual Mania. Could not load this one')).toBeNull();
  }, 30_000);

  it('states the count when one request was enough, which is every real account', async () => {
    seed('follows', [
      { follower_id: 'me', followee_id: 'id-ada', follower: profile('me'), followee: profile('ada', 'Ada') },
      { follower_id: 'id-ada', followee_id: 'me', follower: profile('ada', 'Ada'), followee: profile('me') },
    ]);
    await open();

    expect(pg().requests.follows).toBe(1);
    expect(count('1 / 5')).toBeTruthy();
  });

  it('counts every reaction on an event that straddles a page boundary', async () => {
    // 1,002 events × 2 reactions is 2,004 rows, so both boundaries fall inside a group.
    // A cursor on `feed_event_id` alone would skip the rest of the boundary event, which
    // is a silent undercount of Heart Magnet — the exact shape of the defect.
    seed(
      'reactions',
      Array.from({ length: 1002 }, (_, e) =>
        Array.from({ length: 2 }, () => ({
          feed_event_id: `e${String(e).padStart(5, '0')}`,
          feed_events: {
            media_item_id: `t${String(e).padStart(5, '0')}`,
            media_items: media({ title: `Title ${e}` }),
          },
        })),
      ).flat(),
    );
    await open();

    expect(count('2,004')).toBeTruthy();
    expect(mockRequests().reactions).toBe(3);
    // The cursor is the pair, spelled the way PostgREST spells a tuple comparison.
    const second = pg().reads.filter((read) => read.table === 'reactions')[1]!;
    expect(second.or).toMatch(/^feed_event_id\.gt\..+,and\(feed_event_id\.eq\..+,user_id\.gt\..+\)$/);
  }, 30_000);
});

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
    seed('user_media', movies(400));
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
    seed('user_media', movies(400));
    await open({ onPressTitle: () => {} });
    await drillInto('Movie Muncher');

    // The count above is 400; the list shows 50. A reader who counts the rows to check
    // the badge is owed the reason they do not match.
    expect(screen.getByText('Showing 50 of 400')).toBeTruthy();
  });

  it('reveals the next page on request, and stops offering when there are none', async () => {
    seed('user_media', movies(120));
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
    seed('user_media', movies(12));
    await open({ onPressTitle: () => {} });
    await drillInto('Movie Muncher');

    expect(film(11)).toBeTruthy();
    expect(screen.queryByText(/^Showing /)).toBeNull();
    expect(screen.queryByText(/^Show \d+ more$/)).toBeNull();
  });

  it('starts a freshly opened award at the first page rather than the last one expanded', async () => {
    seed('user_media', movies(400));
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
    seed('user_media', [
      watched('a', { title: 'Ringu', release_date: '1998-01-31' }),
      { ...watched('b', { title: 'Airplane!' }), watched_on: '2026-02-03' },
    ]);
    await open({ onPressTitle: () => {} });
    await drillInto('Movie Muncher');

    expect(screen.getByText(/Ringu/)).toBeTruthy();
    expect(screen.getByText(/Airplane!/)).toBeTruthy();
    expect(screen.getByText(/^Watched /)).toBeTruthy();
  });

  it('Season Snacker names a season by its show', async () => {
    seed('user_media', [
      watched('s1', {
        kind: 'season',
        title: 'Season 1',
        season_number: 1,
        release_date: '2023-01-15',
        parent: { title: 'The Last of Us', genres: ['Drama'], original_language: 'en' },
      }),
    ]);
    await open({ onPressTitle: () => {} });
    await drillInto('Season Snacker');
    expect(screen.getByText(/The Last of Us, S1/)).toBeTruthy();
  });

  it('a genre award includes a TV season through its series genres', async () => {
    // The whole point of the metadata inheritance: the season carries no genres of its
    // own, and Softie Hours counts it because the show is a drama.
    seed('user_media', [
      watched('s1', {
        kind: 'season',
        title: 'Season 1',
        season_number: 1,
        parent: { title: 'The Last of Us', genres: ['Drama'], original_language: 'en' },
      }),
    ]);
    await open({ onPressTitle: () => {} });
    expect(count('1 / 25')).toBeTruthy();
    await drillInto('Softie Hours');
    expect(screen.getByText(/The Last of Us, S1/)).toBeTruthy();
  });

  it('Passport Mode names the language rather than printing its code', async () => {
    seed('user_media', [watched('a', { title: 'Ringu', original_language: 'ja' })]);
    await open({ onPressTitle: () => {} });
    await drillInto('Passport Mode');
    expect(screen.getByText('Japanese')).toBeTruthy();
  });

  it('Genre Gremlin lists genres, not titles, and the rows are the numerator', async () => {
    seed('user_media', [
      watched('a', { genres: ['Action'] }),
      watched('b', { genres: ['Action'] }),
      watched('c', { genres: ['Comedy'] }),
    ]);
    await open({ onPressTitle: () => {} });
    await drillInto('Genre Gremlin');

    expect(screen.getByText('Action')).toBeTruthy();
    expect(screen.getByText('2 titles')).toBeTruthy();
    expect(screen.getByText('Comedy')).toBeTruthy();
    // Two genre rows against a numerator of two, and the denominator is Dabbler's
    // threshold — the tier being worked toward, not the size of the vocabulary.
    expect(screen.getByText(/2 \/ 14/)).toBeTruthy();
  });

  it('Two-Screen Life shows both sides with their own caps', async () => {
    seed('user_media', [
      ...movies(3),
      ...Array.from({ length: 2 }, (_, i) =>
        watched(`s${i}`, {
          kind: 'season',
          title: `Season ${i + 1}`,
          season_number: i + 1,
          parent: { title: 'A Show', genres: [], original_language: 'en' },
        }),
      ),
    ]);
    await open({ onPressTitle: () => {} });
    await drillInto('Two-Screen Life');

    expect(screen.getByText('Movies')).toBeTruthy();
    expect(screen.getByText('3 / 15')).toBeTruthy();
    expect(screen.getByText('TV')).toBeTruthy();
    expect(screen.getByText('2 / 15')).toBeTruthy();
    // And the award's own line, which is the sum.
    expect(screen.getByText(/5 \/ 30/)).toBeTruthy();
  });

  it('Rating Rascal shows the score the reader gave', async () => {
    seed('user_media', movies(1));
    seed('rankings', [
      {
        media_item_id: 'm0',
        bucket: 'loved',
        position: 1,
        category: 'movies',
        media_items: media({ title: 'Heat' }),
      },
    ]);
    await open({ onPressTitle: () => {} });
    await drillInto('Rating Rascal');
    expect(screen.getByText(/Heat/)).toBeTruthy();
    // A single loved title sits at the top of its band.
    expect(screen.getByText('10.0')).toBeTruthy();
  });

  it('Queue Dragon lists the watchlist being held now', async () => {
    seed('watchlist', [{ media_item_id: 'w1', media_items: media({ title: 'Dune' }) }]);
    await open({ onPressTitle: () => {} });
    await drillInto('Queue Dragon');
    expect(screen.getByText(/Dune/)).toBeTruthy();
  });

  it('Comment Gremlin counts comments and leaves published reviews out of it', async () => {
    // The founder's split (2026-08-29): a review is a considered thing you publish
    // about a title you ranked, a comment is talking to somebody under their activity,
    // and one counter rewards neither. This asserts both halves — the comment is in the
    // drill-down, and the published review is not in it at all.
    seed('user_media', [
      {
        ...watched('a', { title: 'Arrival' }),
        note: 'Loved the structure.',
        note_visibility: 'public',
      },
    ]);
    seed('comments', [
      {
        id: 'c1',
        created_at: '2026-01-02T00:00:00Z',
        feed_event_id: 'e1',
        feed_events: { media_item_id: 'b', media_items: media({ title: 'Heat' }) },
      },
    ]);
    await open({ onPressTitle: () => {} });
    await drillInto('Comment Gremlin');

    expect(screen.getByText(/^Comment · /)).toBeTruthy();
    expect(screen.queryByText('Review')).toBeNull();
    expect(screen.queryByText(/Arrival/)).toBeNull();
    // Never the writing itself.
    expect(screen.queryByText(/Loved the structure/)).toBeNull();
  });

  it('Hype Courier names the title and who it went to', async () => {
    seed('title_recommendations', [
      {
        id: 'r1',
        recommended_at: '2026-01-02T00:00:00Z',
        recipient_id: 'id-ada',
        media_items: media({ title: 'Heat' }),
        recipient: profile('ada', 'Ada'),
      },
    ]);
    await open({ onPressTitle: () => {} });
    await drillInto('Hype Courier');
    expect(screen.getByText(/Heat/)).toBeTruthy();
    expect(screen.getByText(/To Ada/)).toBeTruthy();
  });

  it('Heart Magnet counts reactions per item, and the rows sum to the number', async () => {
    seed('reactions', [
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
    ]);
    await open({ onPressTitle: () => {} });
    expect(count('3 / 50')).toBeTruthy();
    await drillInto('Heart Magnet');

    expect(screen.getByText('2 reactions')).toBeTruthy();
    expect(screen.getByText('1 reaction')).toBeTruthy();
    // Who reacted is nowhere on the sheet.
    expect(screen.queryByText(/@/)).toBeNull();
  });

  it('Mutual Mania lists the people who follow back', async () => {
    seed('follows', [
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
    ]);
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
    seed('user_media', [watched('a', { title: 'Ringu' })]);

    await open({ onPressTitle });
    await drillInto('Movie Muncher');
    fireEvent.press(screen.getByText(/Ringu/));

    expect(onPressTitle).toHaveBeenCalledWith('a');
  });

  it('leads to a profile', async () => {
    const onPressProfile = jest.fn();
    seed('follows', [
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
    ]);

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
    seed('follows', [
      { follower_id: 'me', followee_id: 'id-x', follower: profile('me'), followee: null },
      { follower_id: 'id-x', followee_id: 'me', follower: null, followee: profile('me') },
    ]);
    await open({ onPressProfile: () => {} });
    expect(count('1 / 5')).toBeTruthy();
    await drillInto('Mutual Mania');

    expect(screen.getByText('Someone on bingd.')).toBeTruthy();
    expect(screen.getByText('This account is not available to you')).toBeTruthy();
  });

  it('reads attributed signups and never invite link creations', async () => {
    await open();
    expect(mockAsked()).toContain('invite_attributions');
    expect(mockAsked()).not.toContain('invite_link_creations');
  });
});

/**
 * Somebody else's awards — the founder's screenshot, pinned.
 *
 * A real phone showed another account's sheet reading `Movie Muncher 0 / 50` under a
 * profile header that said 34 movies, with Rating Rascal correctly at `34 / 100`. The
 * reads were target-scoped all along; what differed was policy. `user_media` is
 * owner-only (PRD §22), so the visitor's collection read returned zero rows and no
 * error — a zero presented as a fact about somebody else. The fix: a visitor reads the
 * `logged_collection` projection of the same rows, and the two facts with no
 * visitor-legal read at all are *withheld*, not zero.
 *
 * The invariant these tests state: opening B's awards from A's session computes B's
 * progress, and equals B's own sheet for every fact that is public by product
 * contract — subject only to the intended visibility policy, which the mock cannot
 * apply and `supabase/tests/logged-collection.test.mjs` does.
 */
describe('somebody else’s awards', () => {
  const THEM = 'them';

  /** `n` films as `logged_collection` returns them for the target. */
  const loggedMovies = (n: number, over: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) => ({
      user_id: THEM,
      media_item_id: `m${String(i).padStart(4, '0')}`,
      has_public_note: false,
      media_items: media({ title: `Film ${i}` }),
      ...over,
    }));

  const visit = () => {
    // The visitor path reads the invite count through its rpc; a null reply is the
    // oracle refusing and renders as unavailable, so every visit that is not about
    // that refusal seeds a real number. `??=` lets a test answer first.
    pg().rpcAnswers['invited_signup_count'] ??= 0;
    return open({ viewerId: 'viewer-1', userId: THEM });
  };

  it('computes the target’s progress: the Ravi fixture', async () => {
    // 34 ranked, logged movies; no TV; viewed by a different signed-in account.
    seed('logged_collection', loggedMovies(34));
    seed(
      'rankings',
      Array.from({ length: 34 }, (_, i) => ({
        user_id: THEM,
        media_item_id: `m${String(i).padStart(4, '0')}`,
        bucket: 'fine',
        position: i + 1,
        category: 'movies',
        media_items: media({ title: `Film ${i}` }),
      })),
    );
    await visit();

    // By row label, because a bare `0 / 15` is also Truth Worm's and Passport Mode's.
    // Movie Muncher read 0 of 50 on the device; the other two were right all along.
    expect(screen.getByLabelText(/^Movie Muncher\..*34 of 50$/)).toBeTruthy();
    expect(screen.getByLabelText(/^Season Snacker\..*0 of 15$/)).toBeTruthy();
    expect(screen.getByLabelText(/^Rating Rascal\..*34 of 100$/)).toBeTruthy();
  });

  it('never asks for the tables a visitor may not read', async () => {
    seed('logged_collection', loggedMovies(3));
    await visit();

    // The collection arrives through the projection, not the owner-only table —
    // asking `user_media` about somebody else is a request whose answer is a lie.
    expect(mockAsked()).toContain('logged_collection');
    expect(mockAsked()).not.toContain('user_media');
    // The sent-recommendations table is not asked at all: its zero is policy.
    expect(mockAsked()).not.toContain('title_recommendations');
    // And the invite rows are never selected either — the count arrives through the
    // definer scalar, which is the entire public surface of the invite graph.
    expect(mockAsked()).not.toContain('invite_attributions');
    expect(pg().rpcCalls).toEqual([{ name: 'invited_signup_count', args: { p_user: THEM } }]);
  });

  it('matches the sheet the owner sees, for everything public by contract', async () => {
    // The same 21 titles, once as the owner's own read and once as the projection a
    // visitor gets. The two modes must land on the same number — the regression the
    // founder caught was exactly these two disagreeing.
    seed('user_media', movies(21));
    const own = await open();
    expect(count('21 / 50')).toBeTruthy();
    // Async library: an unawaited unmount leaves an open act() that starves every
    // later render in the file.
    await own.unmount();

    seed('logged_collection', loggedMovies(21));
    await visit();
    expect(count('21 / 50')).toBeTruthy();
  });

  it('keeps the viewer’s own activity out of the target’s numbers', async () => {
    // Five of the viewer's own films and rankings sit in the same tables. Only the
    // target's two may count — and the read itself must say so, not the seed.
    seed('logged_collection', [
      ...loggedMovies(2),
      ...loggedMovies(5, { user_id: 'viewer-1' }).map((row, i) => ({
        ...row,
        media_item_id: `mine-${i}`,
      })),
    ]);
    seed('rankings', [
      {
        user_id: 'viewer-1',
        media_item_id: 'mine-0',
        bucket: 'loved',
        position: 1,
        category: 'movies',
        media_items: media({ title: 'My Film' }),
      },
    ]);
    await visit();

    expect(count('2 / 50')).toBeTruthy();
    expect(count('0 / 100')).toBeTruthy(); // the viewer's ranking is not the target's

    const read = pg().reads.find((r) => r.table === 'logged_collection');
    expect(read?.filters.user_id).toBe(THEM);
    expect(pg().reads.find((r) => r.table === 'rankings')?.filters.user_id).toBe(THEM);
  });

  it('says the one remaining two-party fact is theirs to see, not zero and not an error', async () => {
    seed('logged_collection', loggedMovies(1));
    await visit();

    expect(screen.getByLabelText('Hype Courier. Only they can see this one')).toBeTruthy();
    // Not the apology: nothing failed and nothing is known.
    expect(screen.queryByText('Could not load this one')).toBeNull();
  });

  it('shows a visitor the target’s Invite Instigator progress — the founder’s 2 / 3', async () => {
    // The count is public achievement data (founder, 2026-08-27); the graph is not.
    // Two activated invites read exactly as they do on the owner's sheet.
    pg().rpcAnswers['invited_signup_count'] = 2;
    seed('logged_collection', loggedMovies(1));
    await visit();

    expect(screen.getByLabelText(/^Invite Instigator\..*2 of 3$/)).toBeTruthy();
    expect(count('2 / 3')).toBeTruthy();
    expect(screen.queryByText('Only they can see this one')).not.toBeNull(); // Hype Courier only
  });

  it('reads unavailable, never zero, when the invite count cannot be fetched', async () => {
    // A refusal or a failure is not "brought nobody". `broken` fails the rpc the way
    // a broken table read fails.
    pg().broken.add('invited_signup_count');
    seed('logged_collection', loggedMovies(1));
    await visit();

    expect(screen.getByLabelText('Invite Instigator. Could not load this one')).toBeTruthy();
    expect(screen.queryByText('0 / 3', { includeHiddenElements: true })).toBeNull();
  });

  it('does not count their published reviews toward the comment track', async () => {
    // `logged_collection` still carries `has_public_note`; nothing on the client reads
    // it any more. A visitor's Comment Gremlin is their comments, which is the same
    // number the owner's own sheet shows — and neither of them is two.
    seed('logged_collection', loggedMovies(2).map((row, i) => ({
      ...row,
      has_public_note: i === 0,
    })));
    await visit();

    expect(
      screen.getByLabelText('Comment Gremlin. Whisper locked. Next: Write 20 comments. 0 of 20'),
    ).toBeTruthy();
  });

  it('feeds the genre tracks from the projection’s metadata', async () => {
    seed('logged_collection', loggedMovies(2, {}).map((row, i) => ({
      ...row,
      media_items: media({ title: `Film ${i}`, genres: i === 0 ? ['Horror'] : [] }),
    })));
    await visit();

    expect(count('1 / 25')).toBeTruthy(); // Scream Snack sees the visitor-read genres
  });
});
