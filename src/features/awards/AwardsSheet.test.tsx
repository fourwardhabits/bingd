import { screen, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { AwardsSheet } from './AwardsSheet';

/**
 * The sheet, against a stubbed database — what the founder's Android checklist looks at.
 *
 * The arithmetic lives in `awards.test.ts` and is not repeated here. What this file is
 * for is the join: that the reads it issues are the ones the row copy claims to be
 * about, that a locked track and an earned one draw differently, and that a count that
 * fails to load costs its own award rather than the whole sheet.
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

/**
 * A `PostgrestFilterBuilder` in miniature.
 *
 * `head: true` reads are told apart by the option the real client is given, which is
 * what lets one stub answer both the collection read and the eight counts.
 */
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
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
    genres: [],
    original_language: 'en',
    release_date: '2020-01-01',
    ...over,
  },
});

beforeEach(() => {
  for (const key of Object.keys(mockTables)) delete mockTables[key];
  for (const key of Object.keys(mockCounts)) delete mockCounts[key];
  mockBroken.clear();
});

/**
 * The count on the right of a row.
 *
 * `includeHiddenElements` because the row hides it from the accessibility tree on
 * purpose — the whole row is one announcement, and a second reading of "27 / 50" as
 * "twenty-seven slash fifty" helps nobody. It is still on screen, and this is the
 * assertion that it is.
 */
const count = (text: string) => screen.getByText(text, { includeHiddenElements: true });

const open = async () => {
  const view = await renderWithProviders(<AwardsSheet userId="me" onClose={() => {}} />);
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

  it('invites rather than reporting a score of nothing on a fresh account', async () => {
    await open();
    expect(screen.getByText('Watch, rank and talk about things. These fill themselves in.')).toBeTruthy();
    // "0 awards earned" is a scoreline against somebody who has just arrived.
    expect(screen.queryByText(/0 awards earned/)).toBeNull();
  });

  it('counts what is earned once it is, by track and not by tier', async () => {
    mockTables.user_media = Array.from({ length: 12 }, (_, i) => movie(`m${i}`));
    await open();
    // Movie Muncher Bronze, and nothing else: twelve films is not three seasons.
    await waitFor(() => expect(screen.getByText(/1 award earned/)).toBeTruthy());
  });

  it('shows the goal still to reach, with the count beside it', async () => {
    mockTables.user_media = Array.from({ length: 7 }, (_, i) => movie(`m${i}`));
    await open();
    expect(screen.getByText('Next: Watch 10 movies')).toBeTruthy();
    expect(count('7 / 10')).toBeTruthy();
  });

  it('names the tier earned and the next one on the same row', async () => {
    mockTables.user_media = Array.from({ length: 27 }, (_, i) => movie(`m${i}`));
    await open();
    expect(screen.getByText('Bronze earned')).toBeTruthy();
    expect(screen.getByText('Next: Watch 50 movies')).toBeTruthy();
    expect(count('27 / 50')).toBeTruthy();
  });

  it('stops pointing forward once the top tier is earned', async () => {
    mockTables.user_media = Array.from({ length: 164 }, (_, i) => movie(`m${i}`));
    await open();
    expect(screen.getByText('Gold earned: Watched 150 movies')).toBeTruthy();
    // A bare count, not `164 / 150`, and no fourth tier invented to be short of.
    expect(count('164')).toBeTruthy();
    expect(screen.queryByText(/164 \//, { includeHiddenElements: true })).toBeNull();
  });

  it('says a locked track is locked, and an earned one is not', async () => {
    mockTables.user_media = Array.from({ length: 12 }, (_, i) => movie(`m${i}`));
    await open();
    // The whole row is one announcement, which is how a screen reader gets the
    // count attached to the goal it counts toward rather than four loose fragments.
    expect(screen.getByLabelText(/^Movie Muncher\. Bronze earned\./)).toBeTruthy();
    expect(screen.getByLabelText(/^Season Snacker\. Bronze locked\./)).toBeTruthy();
  });

  it('carries the caveat on the two tracks that need one', async () => {
    await open();
    expect(
      screen.getByText('Counts links you made. Bingd cannot see whether they were opened.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Your watchlist right now, so it goes down when you watch something.'),
    ).toBeTruthy();
  });

  it('loses one award to a failed count rather than the whole sheet', async () => {
    mockTables.user_media = Array.from({ length: 12 }, (_, i) => movie(`m${i}`));
    mockBroken.add('follows');
    await open();

    // Nineteen awards still loaded, and Mutual Mania reads as zero rather than
    // taking the other nineteen down with it.
    expect(screen.getByText('Bronze earned')).toBeTruthy();
    expect(screen.getByLabelText(/^Mutual Mania\. Hello locked\. Next: Follow 1 person/)).toBeTruthy();
  });

  it('gives up on the sheet when the collection itself cannot be read', async () => {
    // The one fatal read: seven tracks are meaningless without it, so a half-empty
    // list of numbers would be worse than saying so.
    mockBroken.add('user_media');
    await renderWithProviders(<AwardsSheet userId="me" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Could not load your awards')).toBeTruthy());
    expect(screen.getByText('Try again')).toBeTruthy();
  });
});
