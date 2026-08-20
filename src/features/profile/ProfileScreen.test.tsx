import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import ProfileScreen from '../../../app/(tabs)/profile';

const mockTables: Record<string, unknown[]> = {};
// Recorded, because where the gear leads is a decision this screen makes.
const mockPush = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const rows = () =>
        (mockTables[table] ?? []).filter((row) =>
          Object.entries(filters).every(
            ([key, value]) => (row as Record<string, unknown>)[key] === value,
          ),
        );
      const answer = () => Promise.resolve({ data: rows(), error: null, count: rows().length });
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        in: () => chain,
        // Both return the chain rather than the answer, because the queries on
        // this screen end on different links: the watchlist on `order`, the
        // feed on `limit`. The chain is itself thenable, so awaiting either
        // works.
        limit: () => chain,
        order: () => chain,
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => answer().then(resolve),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  // No params, which is how this tab is reached everywhere except from an award
  // notification — that one arrives as `?awards=1` and opens the sheet on mount
  // (`features/notifications/routing.ts`). These tests are about the tab itself, so
  // they assert the ordinary arrival.
  useLocalSearchParams: () => ({}),
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({
    id: 'user-1',
    username: 'sai',
    display_name: 'Sai',
    // Present, because where the bio is drawn is one of the things this file asserts.
    bio: 'Films, mostly.',
    avatar_path: null,
    avatarUri: null,
  }),
}));

const movie = (id: string, title: string) => ({
  id,
  title,
  release_date: '2010-01-01',
  poster_path: null,
  genres: ['Drama'],
  runtime_minutes: 120,
  kind: 'movie',
});

const rankedRow = (id: string, position: number) => ({
  media_item_id: id,
  position,
  bucket: 'loved',
  category: 'movies',
  user_id: 'user-1',
  media_items: movie(id, `Film ${id}`),
});

beforeEach(() => {
  mockPush.mockReset();
  for (const key of Object.keys(mockTables)) delete mockTables[key];
  mockTables.follows = [];
  mockTables.rankings = [];
  mockTables.user_media = [];
  mockTables.watchlist = [];
  mockTables.feed_events = [];
});

const open = async () => {
  const view = await renderWithProviders(<ProfileScreen />);
  // The @handle rather than the display name: the name also appears inside
  // every activity sentence once the feed loads.
  await waitFor(() => expect(view.getByText('@sai')).toBeTruthy());
  return view;
};

/** The value rendered beneath a stat's label, read off its grouped announcement. */
const stat = async (view: Awaited<ReturnType<typeof open>>, label: string) => {
  const node = await view.findByLabelText(new RegExp(`^${label}: `));
  return String(node.props.accessibilityLabel).split(': ')[1];
};

/**
 * The Watchlist stat is gone, and its two tests with it.
 *
 * It read `top.length` — the length of the top-six ranked slice — so an account with
 * six rankings and an empty watchlist reported six. That was fixed; the founder's
 * acceptance pass then removed the stat itself. Five columns cram a three-digit number
 * into a wrap, and Watched and Watchlist are the reader's own working state rather than
 * a description of their collection: they belong in Collection, where they can be acted
 * on. The four that remain are the four a visitor already saw, which is what makes the
 * two profiles one product.
 */
/**
 * The controls at the top, which the founder restored after the device pass.
 *
 * Share Profile is the primary one because a profile is the thing you hand somebody so
 * they can follow you. Edit Profile is housekeeping and already has a home behind the
 * gear, so promoting it to the page’s main control made the most common act the
 * second-most prominent one.
 */
describe('the profile controls', () => {
  it('leads with Share Profile', async () => {
    const view = await open();

    await waitFor(() => expect(view.getByText('Share Profile')).toBeTruthy());
    expect(view.queryByText('Edit Profile')).toBeNull();
  });

  it('keeps the bell in its corner and puts settings beside it as a gear', async () => {
    const view = await open();

    await waitFor(() => expect(view.getByLabelText('Settings')).toBeTruthy());
    // The bell sits in the same place on every root tab. A text button next to it was
    // pushing it out of that corner on this one.
    expect(view.getByLabelText(/^Notifications/)).toBeTruthy();
  });

  it('opens settings from the gear', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByLabelText('Settings')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Settings'));
    expect(mockPush).toHaveBeenCalledWith('/settings');
  });
});

describe('the stat row', () => {
  it('shows the four that describe the collection, and no more', async () => {
    mockTables.rankings = [1, 2, 3].map((n) => rankedRow(`film-${n}`, n));

    const view = await open();

    await waitFor(async () => expect(await stat(view, 'Movies')).toBe('3'));
    expect(await stat(view, 'Followers')).toBeDefined();
    expect(await stat(view, 'Following')).toBeDefined();
    expect(await stat(view, 'TV seasons')).toBeDefined();
    expect(view.queryByLabelText(/^Watchlist: /)).toBeNull();
    expect(view.queryByLabelText(/^Watched: /)).toBeNull();
  });
});

describe('recent activity', () => {
  const activity = (id: string, actor: string, name: string) => ({
    id,
    type: 'title_ranked',
    actor_id: actor,
    media_item_id: 'film-1',
    created_at: '2026-08-15T00:00:00Z',
    payload: { position: 1, category: 'movies', bucket: 'loved', score: 9.1 },
    media_items: movie('film-1', 'Inception'),
    profiles: { username: name, display_name: name, avatar_path: null },
  });

  it('shows only this profile\u2019s own activity', async () => {
    // The feed query spans everyone the user follows. A friend's ranking under
    // a heading on your own profile is a different claim from the one the
    // heading makes.
    mockTables.feed_events = [activity('e1', 'user-1', 'Sai'), activity('e2', 'friend', 'Anna')];

    const view = await open();
    // A regex, because the title and its year share one Text node: the activity
    // row stopped repeating the title inside its sentence on 2026-08-16, so the
    // only place it appears is beside the year.
    await waitFor(() => expect(view.getAllByText(/Inception/)).toHaveLength(1));
    expect(view.queryByText('Anna')).toBeNull();
  });

  it('says so when there is none, rather than leaving a bare heading', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('Nothing here yet')).toBeTruthy());
  });

  it('never renders an unnamed actor', async () => {
    // On one's own profile an unnamed actor is impossible by construction, so
    // an item reading "Someone" here is unambiguously a bug — and it was one,
    // on every row, until the to-one embed was read correctly.
    mockTables.feed_events = [{ ...activity('e1', 'user-1', 'Sai'), profiles: null }];

    const view = await open();
    await waitFor(() => expect(view.getByText('Nothing here yet')).toBeTruthy());
    expect(view.queryByText(/Someone/)).toBeNull();
  });
});

describe('top ranked', () => {
  it('is a poster wall of six, headed like every other section', async () => {
    mockTables.rankings = [1, 2, 3, 4, 5, 6, 7].map((n) => rankedRow(`film-${n}`, n));

    const view = await open();
    // By label, not by text: the header is uppercased in CSS, so the accessible
    // name is the sentence case one and the rendered string is not.
    await waitFor(() => expect(view.getByLabelText('Top ranked')).toBeTruthy());

    // Six, not seven: two full rows of three. A single row of a three-column
    // grid reads as a stub, and a partial third row reads as a bug.
    await waitFor(() => expect(view.queryByLabelText(/Film film-7/)).toBeNull());
    expect(view.getByLabelText(/Film film-6/)).toBeTruthy();
  });

  it('invites a first ranking when there are none', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('Nothing ranked yet')).toBeTruthy());
  });
});

/**
 * **The order of the page, which the founder's final pass rearranged.**
 *
 * Identity, then the bio across the full width, then the stats, then the controls, then
 * the goals and the collection below them.
 *
 * Two things moved. The bio left the identity column, where it had two thirds of the
 * screen and competed with the name for it; and Share Profile and Bingd Awards moved
 * *below* the stat row, so identity flows into the numbers that describe it without a
 * row of buttons interrupting, and the two controls sit next to the goals and the
 * poster wall they actually lead to.
 *
 * Asserted through the order the page reads in rather than through any measurement,
 * because the sequence a reader's eye takes is what was wrong.
 */
describe('the shape of the page', () => {
  /**
   * Every string the page draws, in the order it draws them.
   *
   * An element whose children are all strings is joined into one entry, because
   * `<Text>@{username}</Text>` is two children and "@sai" is one thing on the screen.
   */
  const textsInOrder = (node: unknown, out: string[] = []): string[] => {
    if (typeof node === 'string') {
      out.push(node);
      return out;
    }
    if (Array.isArray(node)) {
      for (const child of node) textsInOrder(child, out);
      return out;
    }
    const children = (node as { children?: unknown[] })?.children;
    if (!children) return out;
    if (children.every((child) => typeof child === 'string')) {
      out.push(children.join(''));
      return out;
    }
    for (const child of children) textsInOrder(child, out);
    return out;
  };

  /** Where each of these first appears in that order. */
  const positions = (view: Awaited<ReturnType<typeof open>>, wanted: string[]) => {
    const texts = textsInOrder(view.toJSON());
    return wanted.map((want) => ({
      want,
      at: texts.findIndex((text) => text.includes(want)),
    }));
  };

  it('reads identity, bio, stats, buttons, goals — in that order', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('Nothing ranked yet')).toBeTruthy());

    const found = positions(view, [
      '@sai',
      'Films, mostly.',
      'Followers',
      'Share Profile',
      'Bingd Awards',
      // Top ranked's empty state. A section heading would have been the natural marker,
      // and `SectionHeader` upper-cases its title, so none of them is on the page as it
      // is written.
      'Nothing ranked yet',
    ]);

    // Present at all, first: a missing piece would otherwise sort to the front as -1.
    for (const piece of found) expect([piece.want, piece.at >= 0]).toEqual([piece.want, true]);

    const order = found.map((piece) => piece.at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('keeps the bio out of the name column, where it used to wrap early', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('@sai')).toBeTruthy());

    // The bio is drawn after the handle and before the stats, which is the full-width
    // block between the identity header and the counts — not a third line inside the
    // column the photo leaves.
    const [handle, bio, followers] = positions(view, ['@sai', 'Films, mostly.', 'Followers']);
    expect(handle!.at).toBeLessThan(bio!.at);
    expect(bio!.at).toBeLessThan(followers!.at);
  });

  it('shows no Taste Match against yourself', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('@sai')).toBeTruthy());
    // A 100% match with your own catalogue is a tautology, and the badge slot under the
    // avatar is empty on this screen by construction.
    expect(view.queryByText('Match')).toBeNull();
  });
});
