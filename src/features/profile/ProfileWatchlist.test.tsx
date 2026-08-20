import { waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { ProfileWatchlist } from './ProfileWatchlist';
import { PROFILE_WATCHLIST_LIMIT } from './use-public-profile';

/**
 * The Watchlist shelf on a profile: what it shows, and what it must never show.
 *
 * **Founder decision, 2026-08-20.** Top Ranked says what somebody loves; this says what
 * they want to watch next, which is the socially actionable half.
 *
 * Shipping it moved a documented privacy line. `20260820000200` replaced `watchlist_own`
 * with `watchlist_read` — `can_i_view(user_id)`, the oracle rankings already use — so the
 * watchlist stopped being always-private and became profile content. The RLS half of that
 * is proved in `supabase/tests/rls.test.mjs`, from a second user's session, which is where
 * a policy can actually be tested. What is left for this file is the half the client owns:
 *
 *   - that there is **no visibility logic here at all**, so the rule cannot be
 *     reimplemented slightly differently on the device;
 *   - that an unauthorised read — which arrives as zero rows, not as an error — renders
 *     **nothing**, disclosing neither titles nor a count nor the existence of the section.
 *
 * The last one is the subtle one and it is why there is no empty state and no skeleton.
 * "Nothing saved yet" on a private profile is a smaller leak than a list, but it is still
 * a statement about an account the reader is not entitled to.
 */

type Row = {
  media_item_id: string;
  created_at: string;
  media_items: {
    kind: 'movie' | 'series' | 'season';
    title: string;
    season_number: number | null;
    release_date: string | null;
    poster_path: string | null;
    parent: { title: string } | null;
  };
};

let mockRowsByUser: Record<string, Row[]> = {};
/** What the query actually asked the database for, so the bound can be asserted. */
let mockQuery: { userId?: string; limit?: number; orders: [string, boolean][] } = { orders: [] };

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: (column: string, value: string) => {
          if (column === 'user_id') mockQuery.userId = value;
          return chain;
        },
        order: (column: string, options: { ascending: boolean }) => {
          mockQuery.orders.push([column, options.ascending]);
          return chain;
        },
        limit: (n: number) => {
          mockQuery.limit = n;
          return chain;
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({
            // The policy is the filter. A user the viewer cannot see simply has no rows
            // here, which is exactly what PostgREST returns under `watchlist_read`.
            data: table === 'watchlist' ? (mockRowsByUser[mockQuery.userId ?? ''] ?? []) : [],
            error: null,
          }).then(resolve),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

const film = (id: string, title: string, savedAt: string): Row => ({
  media_item_id: id,
  created_at: savedAt,
  media_items: {
    kind: 'movie',
    title,
    season_number: null,
    release_date: '2014-01-01',
    poster_path: null,
    parent: null,
  },
});

const season = (id: string, series: string, number: number, savedAt: string): Row => ({
  media_item_id: id,
  created_at: savedAt,
  media_items: {
    kind: 'season',
    title: `Season ${number}`,
    season_number: number,
    release_date: '2023-01-01',
    poster_path: null,
    parent: { title: series },
  },
});

beforeEach(() => {
  mockRowsByUser = {};
  mockQuery = { orders: [] };
});

const open = async (userId: string) => {
  const view = await renderWithProviders(
    <ProfileWatchlist userId={userId} onPressTitle={() => {}} />,
  );
  return view;
};

describe('the shelf on a profile you can see', () => {
  beforeEach(() => {
    mockRowsByUser['them'] = [
      film('a', 'Dune', '2026-08-19T10:00:00Z'),
      film('b', 'Heat', '2026-08-18T10:00:00Z'),
      film('c', 'Sicario', '2026-08-17T10:00:00Z'),
    ];
  });

  it('is headed Watchlist and lists what they saved', async () => {
    const view = await open('them');
    // The header renders its label uppercased; the accessible name is the real one.
    await waitFor(() => expect(view.getByLabelText('Watchlist')).toBeTruthy());
    for (const title of ['Dune', 'Heat', 'Sicario']) {
      expect(view.getByLabelText(new RegExp(`^${title}`))).toBeTruthy();
    }
  });

  it('asks the database for the most recently added first', async () => {
    await open('them');
    await waitFor(() => expect(mockQuery.orders.length).toBeGreaterThan(0));
    // Ordered in the query rather than after the fact, which is what makes the bound
    // below mean "the twelve most recent" instead of "twelve arbitrary rows, sorted".
    expect(mockQuery.orders[0]).toEqual(['created_at', false]);
    // The tie-break, so two titles saved in the same millisecond cannot swap between
    // reads and re-key the shelf.
    expect(mockQuery.orders[1]).toEqual(['media_item_id', true]);
  });

  it('bounds the read rather than paging somebody entire backlog', async () => {
    await open('them');
    await waitFor(() => expect(mockQuery.limit).toBeDefined());
    expect(mockQuery.limit).toBe(PROFILE_WATCHLIST_LIMIT);
    expect(PROFILE_WATCHLIST_LIMIT).toBeGreaterThanOrEqual(10);
    expect(PROFILE_WATCHLIST_LIMIT).toBeLessThanOrEqual(15);
  });

  it('names a season by its series, the way every other surface does', async () => {
    mockRowsByUser['them'] = [season('s', 'The Last of Us', 2, '2026-08-19T10:00:00Z')];
    const view = await open('them');
    // `Season 2` on its own is what the row holds and is meaningless on a wall of
    // artwork. `compactName` is applied in the hook so the shelf and the title page it
    // opens agree on what the thing is called.
    await waitFor(() => expect(view.getByLabelText(/^The Last of Us, S2/)).toBeTruthy());
  });

  it('reads only the account whose profile is on screen', async () => {
    await open('them');
    await waitFor(() => expect(mockQuery.userId).toBe('them'));
  });
});

describe('the shelf on a profile you cannot see', () => {
  it('renders nothing at all — not the titles, not a count, not the heading', async () => {
    // An unviewable profile is zero rows, indistinguishable from an empty watchlist. That
    // is the disclosure rule PRD §16 applies everywhere else: a 404 for a private account
    // is itself a statement that the account is there.
    mockRowsByUser['them'] = [film('a', 'Dune', '2026-08-19T10:00:00Z')];
    const view = await open('private-stranger');

    await waitFor(() => expect(mockQuery.userId).toBe('private-stranger'));
    expect(view.queryByLabelText('Watchlist')).toBeNull();
    expect(view.queryByText('Dune')).toBeNull();
    // Nothing of the section survives: no heading, no shelf, no count, no placeholder.
    expect(view.queryByText(/d/)).toBeNull();
  });

  it('draws no skeleton on the way to drawing nothing', async () => {
    // A loading state would announce the section before knowing whether there is one,
    // which is the leak in slow motion.
    mockRowsByUser['private-stranger'] = [];
    const view = await open('private-stranger');
    // Before the read resolves and after it: the same nothing, so there is no frame in
    // which the section announces itself.
    expect(view.queryByLabelText('Watchlist')).toBeNull();
    await waitFor(() => expect(mockQuery.userId).toBe('private-stranger'));
    expect(view.queryByLabelText('Watchlist')).toBeNull();
  });

  it('hides itself for an account with an empty watchlist, identically', async () => {
    mockRowsByUser['them'] = [];
    const empty = await open('them');
    await waitFor(() => expect(mockQuery.userId).toBe('them'));

    mockQuery = { orders: [] };
    mockRowsByUser['them'] = [film('a', 'Dune', '2026-08-19T10:00:00Z')];
    const unauthorised = await open('private-stranger');
    await waitFor(() => expect(mockQuery.userId).toBe('private-stranger'));

    /**
     * **The two cases must render identically, and this compares the trees rather than
     * asserting each is empty.** If they ever diverge, the difference is an oracle: a
     * reader could tell "this account has saved nothing" from "you are not allowed to
     * know", and the second is a fact about an account they are not entitled to.
     */
    // Serialised rather than deep-equalled: the two trees hold distinct callback
    // identities from two renders, which is not a difference a reader can see.
    expect(JSON.stringify(unauthorised.toJSON())).toEqual(JSON.stringify(empty.toJSON()));
    expect(empty.queryByLabelText('Watchlist')).toBeNull();
  });
});
