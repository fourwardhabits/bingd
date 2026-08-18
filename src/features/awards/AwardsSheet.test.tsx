import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { AwardsSheet } from './AwardsSheet';

/**
 * The sheet, against a stubbed database — what the founder's Android checklist looks at.
 *
 * The arithmetic lives in `awards.test.ts` and is not repeated here. What this file is
 * for is the join: that the reads it issues are the ones the row copy claims to be
 * about, that a locked track and an earned one draw differently, that a count that fails
 * costs its own award rather than the whole sheet, and that tapping a row opens the
 * titles behind its number.
 */

/**
 * Rows per table. `mockCounts` stands in for a `head: true` read, which returns none.
 *
 * The `mock` prefix is Jest's escape hatch: a factory passed to `jest.mock` is hoisted
 * above every other statement in the file, so it may only close over variables whose
 * names say they are for mocking.
 */
const mockTables: Record<string, unknown[]> = {};
const mockCounts: Record<string, number> = {};
/** Reads that fail, by the key the query builder resolved to. */
const mockBroken = new Set<string>();
/** Every table this render actually asked for, so a read can be asserted by name. */
const mockAsked: string[] = [];

/**
 * A `PostgrestFilterBuilder` in miniature.
 *
 * `head: true` reads are told apart by the option the real client is given, which is
 * what lets one stub answer both the collection read and the eight counts.
 */
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      mockAsked.push(table);
      let head = false;
      let column: string | null = null;
      const chain: Record<string, unknown> = {
        select: (_columns: string, options?: { head?: boolean }) => {
          head = Boolean(options?.head);
          return chain;
        },
        eq: (field: string, value: unknown) => {
          // The note count and the watched read are both `user_media`; the filter on
          // note_visibility is what separates them.
          if (field === 'note_visibility') column = 'public_notes';
          if (field === 'feed_events.actor_id') column = 'reactions_received';
          void value;
          return chain;
        },
        neq: () => chain,
        not: () => chain,
        or: () => chain,
        then: (resolve: (value: unknown) => unknown) => {
          const key = column ?? table;
          if (mockBroken.has(key)) {
            return Promise.resolve({ data: null, count: null, error: { message: 'nope' } }).then(
              resolve,
            );
          }
          return Promise.resolve({
            data: head ? null : (mockTables[key] ?? []),
            count: head ? (mockCounts[key] ?? 0) : null,
            error: null,
          }).then(resolve);
        },
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

const movie = (id: string, over: Record<string, unknown> = {}) => ({
  media_item_id: id,
  media_items: {
    kind: 'movie',
    title: `Film ${id}`,
    season_number: null,
    poster_path: null,
    genres: [],
    original_language: 'en',
    release_date: '2020-01-01',
    parent: null,
    ...over,
  },
});

const movies = (n: number, over: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => movie(`m${i}`, over));

beforeEach(() => {
  for (const key of Object.keys(mockTables)) delete mockTables[key];
  for (const key of Object.keys(mockCounts)) delete mockCounts[key];
  mockBroken.clear();
  mockAsked.length = 0;
});

/**
 * The count on the right of a row.
 *
 * `includeHiddenElements` because the row hides it from the accessibility tree on
 * purpose — the whole row is one announcement, and a second reading of "84 / 200" as
 * "eighty-four slash two hundred" helps nobody. It is still on screen, and this is the
 * assertion that it is.
 */
const count = (text: string) => screen.getByText(text, { includeHiddenElements: true });

const open = async (props: Partial<React.ComponentProps<typeof AwardsSheet>> = {}) => {
  const view = await renderWithProviders(
    <AwardsSheet userId="me" onClose={() => {}} {...props} />,
  );
  await waitFor(() => expect(screen.getByText('Movie Muncher')).toBeTruthy());
  return view;
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
    // The founder cut the summary: a count of what you have earned, at the top of a
    // shelf, turns the shelf into a report card. Neither the number nor the invitation
    // it used to show on a fresh account survives.
    expect(screen.queryByText(/awards earned/)).toBeNull();
    expect(screen.queryByText(/Keep watching and the rest will turn up/)).toBeNull();
    expect(
      screen.queryByText('Watch, rank and talk about things. These fill themselves in.'),
    ).toBeNull();
  });

  it('shows the goal still to reach, with the count beside it', async () => {
    mockTables.user_media = movies(7);
    await open();
    expect(screen.getByText('Next: Watch 50 movies')).toBeTruthy();
    expect(count('7 / 50')).toBeTruthy();
  });

  it('names the tier earned and the next one on the same row', async () => {
    mockTables.user_media = movies(84);
    await open();
    expect(screen.getByText('Bronze earned')).toBeTruthy();
    expect(screen.getByText('Next: Watch 200 movies')).toBeTruthy();
    expect(count('84 / 200')).toBeTruthy();
  });

  it('states the tier and what earned it once the top is reached', async () => {
    mockTables.user_media = movies(1164);
    await open();
    expect(screen.getByText('Gold earned')).toBeTruthy();
    expect(screen.getByText('Watched 1,000 movies')).toBeTruthy();
    // A bare count, not `1,164 / 1,000`, and no fourth tier invented to be short of.
    expect(count('1,164')).toBeTruthy();
    expect(screen.queryByText(/1,164 \//, { includeHiddenElements: true })).toBeNull();
  });

  it('says a locked track is locked, and an earned one is not', async () => {
    mockTables.user_media = movies(60);
    await open();
    // The whole row is one announcement, which is how a screen reader gets the
    // count attached to the goal it counts toward rather than four loose fragments.
    expect(screen.getByLabelText(/^Movie Muncher\. Bronze earned\./)).toBeTruthy();
    expect(screen.getByLabelText(/^Season Snacker\. Bronze locked\./)).toBeTruthy();
  });

  it('carries no explanatory paragraph on any row', async () => {
    mockCounts.watchlist = 30;
    await open();
    // All three are gone: two because the metric was fixed, one because the goal line
    // already says it.
    expect(
      screen.queryByText('Counts links you made. Bingd cannot see whether they were opened.'),
    ).toBeNull();
    expect(
      screen.queryByText('Your watchlist right now, so it goes down when you watch something.'),
    ).toBeNull();
    expect(screen.queryByText('The number is whichever side you are further behind on.')).toBeNull();
  });

  it('loses one award to a failed count rather than the whole sheet, and says which', async () => {
    mockTables.user_media = movies(60);
    mockBroken.add('follows');
    await open();

    // Nineteen awards still loaded. Mutual Mania is the twentieth and it says it
    // could not be read rather than reporting a zero nobody measured — independent
    // review 20's finding and the founder's Phase 7, which are one instruction.
    expect(screen.getByText('Bronze earned')).toBeTruthy();
    expect(screen.getByLabelText('Mutual Mania. Could not load this one')).toBeTruthy();
    expect(count('—')).toBeTruthy();
    // The old locked wording is gone with it: a locked row claims a number.
    expect(screen.queryByLabelText(/^Mutual Mania\. Hello locked/)).toBeNull();
  });

  it('gives up on the sheet when the collection itself cannot be read', async () => {
    // The one fatal read: thirteen tracks are meaningless without it, so a half-empty
    // list of numbers would be worse than saying so.
    mockBroken.add('user_media');
    await renderWithProviders(<AwardsSheet userId="me" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Could not load your awards')).toBeTruthy());
    expect(screen.getByText('Try again')).toBeTruthy();
  });
});

/**
 * **Where the Invite Instigator number comes from.**
 *
 * The founder's instruction was that the award must count people who joined, not links
 * that were minted — and the difference is invisible on screen, because both are a
 * number. It is only visible in which table is asked. So this asserts the table.
 */
describe('Invite Instigator', () => {
  it('reads attributed signups and never invite link creations', async () => {
    await open();
    expect(mockAsked).toContain('invite_attributions');
    expect(mockAsked).not.toContain('invite_link_creations');
  });

  it('sits at zero rather than borrowing a number that means something else', async () => {
    // Nothing writes an attribution yet — the link resolver does not exist — so this is
    // a true zero. Twenty links minted would once have read as Silver; the count the
    // sheet shows is the one from the table that records arrivals.
    mockCounts.invite_link_creations = 20;
    await open();
    expect(screen.getByText('Next: Bring 3 people to Bingd')).toBeTruthy();
    expect(screen.getByLabelText(/^Invite Instigator\. Bronze locked\. Next: Bring 3 people/))
      .toBeTruthy();
  });

  it('is third, under Movie Muncher and Season Snacker, and stays there', async () => {
    // The pinned three. Asserted through the rendered order rather than the comparator,
    // because the sheet is where the rule is visible to anybody.
    mockTables.user_media = movies(1164);
    await open();
    const names = screen
      .getAllByLabelText(/^(Movie Muncher|Season Snacker|Invite Instigator|Rating Rascal)\./)
      .map((node) => String(node.props.accessibilityLabel).split('.')[0]);
    expect(names.slice(0, 3)).toEqual(['Movie Muncher', 'Season Snacker', 'Invite Instigator']);
  });
});

/**
 * The drill-down, which is the goals sheet's argument applied to awards: a count of your
 * own collection that you cannot enumerate is a claim you have to take on faith.
 */
describe('the titles behind a number', () => {
  const collection = [
    movie('a', { title: 'Ringu', original_language: 'ja', genres: ['Horror'], release_date: '1998-01-31' }),
    movie('b', { title: 'Airplane!', genres: ['Comedy'], release_date: '1980-07-02' }),
    {
      media_item_id: 'c',
      media_items: {
        kind: 'season',
        title: 'Season 1',
        season_number: 1,
        poster_path: null,
        genres: [],
        original_language: 'en',
        release_date: '2023-01-15',
        parent: { title: 'The Last of Us' },
      },
    },
  ];

  it('opens a track whose number is made of titles, and names them', async () => {
    mockTables.user_media = collection;
    await open({ onPressTitle: () => {} });

    fireEvent.press(screen.getByLabelText(/^Movie Muncher\./));

    await waitFor(() => expect(screen.getByText(/2 titles counted./)).toBeTruthy());
    expect(screen.getByText(/Ringu/)).toBeTruthy();
    expect(screen.getByText(/Airplane!/)).toBeTruthy();
    // The season is not a movie and is not in this list.
    expect(screen.queryByText(/The Last of Us, S1/)).toBeNull();
  });

  it('names a season by its show, not as a row called Season 1', async () => {
    mockTables.user_media = collection;
    await open({ onPressTitle: () => {} });

    fireEvent.press(screen.getByLabelText(/^Season Snacker\./));

    await waitFor(() => expect(screen.getByText(/The Last of Us, S1/)).toBeTruthy());
    expect(screen.getByText(/1 title counted./)).toBeTruthy();
  });

  it('lists only the titles that actually met the rule', async () => {
    mockTables.user_media = collection;
    await open({ onPressTitle: () => {} });

    fireEvent.press(screen.getByLabelText(/^Passport Mode\./));
    await waitFor(() => expect(screen.getByText(/1 title counted./)).toBeTruthy());
    expect(screen.getByText(/Ringu/)).toBeTruthy();
    expect(screen.queryByText(/Airplane!/)).toBeNull();
  });

  it('leads to the title', async () => {
    const onPressTitle = jest.fn();
    mockTables.user_media = collection;
    await open({ onPressTitle });

    fireEvent.press(screen.getByLabelText(/^Movie Muncher\./));
    await waitFor(() => expect(screen.getByText(/Ringu/)).toBeTruthy());
    fireEvent.press(screen.getByText(/Ringu/));

    expect(onPressTitle).toHaveBeenCalledWith('a');
  });

  it('leaves a row that has nothing behind it unpressable', async () => {
    mockTables.user_media = collection;
    await open({ onPressTitle: () => {} });
    // Mutual Mania is other people, and there is no privacy-safe list of them.
    expect(screen.getByLabelText(/^Mutual Mania\./).props.accessibilityRole).toBe('text');
    expect(screen.getByLabelText(/^Movie Muncher\./).props.accessibilityRole).toBe('button');
  });

  it('offers no drill-down at all where the caller cannot navigate', async () => {
    mockTables.user_media = collection;
    await open();
    // Without a destination a list of titles would lead nowhere, which is the goals
    // section's own rule.
    expect(screen.getByLabelText(/^Movie Muncher\./).props.accessibilityRole).toBe('text');
  });
});
