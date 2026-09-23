import { waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { ProfileLists } from './ProfileLists';

/**
 * The Lists shelf on a profile.
 *
 * ---------------------------------------------------------------------------
 * THREE RULES, AND TWO OF THEM ARE PRIVACY
 *
 * **An unviewable profile and one with no public lists must render the same nothing.**
 * `profile_lists` answers both with zero rows — that is the server's half — and the only
 * way the two can look identical is if the client draws nothing for either. A "No lists
 * yet" line on a stranger's profile is a statement about an account the reader is not
 * entitled to, which is `ProfileWatchlist`'s rule and the reason this file exists.
 *
 * **Private and link-only lists are never drawn on a profile shelf, including the
 * owner's own.** The server enforces it and there is no client branch that could widen
 * it, which is what these tests pin: the component asks for `profile_lists` and nothing
 * else, and it holds no visibility logic of its own.
 *
 * **No editing controls.** This is the shelf the earlier draft of the PRD put a
 * `+ New list` tile and a two-tap Delete on. `Manage ›` is a door to the management
 * screen; it is not management on the profile.
 */

type Row = {
  id: string;
  title: string;
  item_count: number;
  order_style: 'ranked' | 'unranked';
  updated_at: string;
  posters: string[] | null;
};

let mockRowsByOwner: Record<string, Row[]> = {};
/** Which RPCs the component actually called, so "it asks for nothing else" is testable. */
let mockCalls: { fn: string; args: Record<string, unknown> }[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      mockCalls.push({ fn, args });
      const owner = String(args.p_owner_id ?? '');
      return Promise.resolve({
        // The policy is the filter. A profile the viewer cannot see, and one with no
        // public lists, are the same zero rows from out here — exactly as PostgREST
        // answers under `profile_lists`.
        data: fn === 'profile_lists' ? (mockRowsByOwner[owner] ?? []) : [],
        error: null,
      });
    },
  },
  startSessionRefresh: () => () => {},
}));

const list = (id: string, title: string, itemCount = 9): Row => ({
  id,
  title,
  item_count: itemCount,
  order_style: 'unranked',
  updated_at: '2026-09-12T10:00:00Z',
  posters: ['/a.jpg', '/b.jpg'],
});

beforeEach(() => {
  mockRowsByOwner = {};
  mockCalls = [];
});

const open = (props: Partial<React.ComponentProps<typeof ProfileLists>> = {}) =>
  renderWithProviders(
    <ProfileLists ownerId="them" isOwner={false} onOpenList={() => {}} {...props} />,
  );

describe("somebody else's profile", () => {
  it('draws the public lists it was given', async () => {
    mockRowsByOwner.them = [list('a', 'Best breakup movies', 14), list('b', 'Chicago movies')];

    const view = await open();

    await waitFor(() => view.getByText('Best breakup movies'));
    view.getByText('Chicago movies');
    // The count and nothing else. A shelf card carries no visibility chip: everything
    // on it is public by construction.
    view.getByText('14');
  });

  it('renders nothing at all when there are no public lists', async () => {
    const view = await open();

    // Not "no section with an empty state" — no section. The heading itself would be a
    // disclosure.
    await waitFor(() => expect(mockCalls.length).toBeGreaterThan(0));
    expect(view.queryByText('LISTS')).toBeNull();
    expect(view.queryByText(/Nothing public yet/)).toBeNull();
    // The provider wrapper is still the root; what matters is that the component put
    // nothing inside it, including hidden nodes.
    expect(view.queryAllByText(/./, { includeHiddenElements: true })).toHaveLength(0);
  });

  it('is indistinguishable from an unviewable profile', async () => {
    // Both are zero rows. This asserts the *rendered output* is identical rather than
    // that two code paths agree, because agreeing code paths is what a later refactor
    // breaks.
    mockRowsByOwner.empty = [];
    const withNoLists = await open({ ownerId: 'empty' });
    const unviewable = await open({ ownerId: 'private-account' });

    await waitFor(() => expect(mockCalls.length).toBeGreaterThanOrEqual(2));
    // Serialised, because `toEqual` on two React test trees compares element identity
    // and reports "serializes to the same string" for trees that are in fact identical.
    // The rendered output is what has to match; the objects behind it are not the claim.
    expect(JSON.stringify(withNoLists.toJSON())).toBe(JSON.stringify(unviewable.toJSON()));
  });

  it('offers See all only past three lists', async () => {
    mockRowsByOwner.them = [list('a', 'One'), list('b', 'Two'), list('c', 'Three')];
    const three = await open({ onSeeAll: () => {} });
    await waitFor(() => three.getByText('One'));
    expect(three.queryByText('See all')).toBeNull();

    mockRowsByOwner.four = [...(mockRowsByOwner.them ?? []), list('d', 'Four')];
    const four = await open({ ownerId: 'four', onSeeAll: () => {} });
    await waitFor(() => four.getByText('Four'));
    four.getByText('See all');
  });

  it('never offers Manage on a profile that is not the reader’s', async () => {
    mockRowsByOwner.them = [list('a', 'One')];
    const view = await open({ onManage: () => {}, onSeeAll: () => {} });
    await waitFor(() => view.getByText('One'));
    expect(view.queryByText('Manage')).toBeNull();
  });
});

describe('the owner’s own profile', () => {
  it('shows what a visitor would see, and says so when that is nothing', async () => {
    const view = await open({ ownerId: 'me', isOwner: true, onManage: () => {} });

    // The one place an empty state is correct: the owner already knows their account
    // exists, and this is how they learn the privacy model by looking at it (§Q.4).
    await waitFor(() => view.getByText(/Nothing public yet/));
    view.getByText('Manage');
  });

  it('keeps Manage present even when there is something to show', async () => {
    mockRowsByOwner.me = [list('a', 'Chicago movies')];
    const view = await open({ ownerId: 'me', isOwner: true, onManage: () => {} });

    await waitFor(() => view.getByText('Chicago movies'));
    view.getByText('Manage');
    // It is the second door, not a second home: no See all beside it.
    expect(view.queryByText('See all')).toBeNull();
  });

  it('reads the same public-only source a visitor does', async () => {
    mockRowsByOwner.me = [list('a', 'Chicago movies')];
    await open({ ownerId: 'me', isOwner: true, onManage: () => {} });

    await waitFor(() => expect(mockCalls.length).toBeGreaterThan(0));
    // Not `my_lists`, which is the one reader that returns every visibility. An owner
    // shelf reading that would draw a private list on an identity surface.
    expect(mockCalls.every((call) => call.fn === 'profile_lists')).toBe(true);
    expect(mockCalls[0]?.args.p_owner_id).toBe('me');
  });
});

describe('the shelf carries no editing controls', () => {
  it('has no create, edit or delete affordance anywhere', async () => {
    mockRowsByOwner.me = [list('a', 'Chicago movies')];
    const view = await open({ ownerId: 'me', isOwner: true, onManage: () => {} });

    await waitFor(() => view.getByText('Chicago movies'));
    for (const forbidden of [/new list/i, /delete/i, /edit/i, /\+/]) {
      expect(view.queryByText(forbidden)).toBeNull();
    }
  });
});
