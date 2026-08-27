import { fireEvent, waitFor, within } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import ProfileScreen from '../../../app/(tabs)/profile';

const mockTables: Record<string, unknown[]> = {};
/**
 * Tables whose reads come back as a Postgres error.
 *
 * A stand-in that can only succeed can only test half a screen, and the half it cannot
 * test is the one the founder's TestFlight build was stuck in: every surface here holds
 * `data ?? []`, so a failed read and an empty account are the same value by the time the
 * render sees them.
 */
const mockFailing = new Set<string>();
/** Reads served per table, so a retry can be shown to have re-issued a real request. */
const mockReads: Record<string, number> = {};
// Recorded, because where the gear leads is a decision this screen makes.
const mockPush = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: (table: string) => {
      /**
       * Predicates rather than a column→value map, because `in` filters too now.
       *
       * The stand-in used to swallow `in`, `order` and `limit`, which made the one
       * bug this screen actually shipped untestable: Recent activity was the follow
       * feed's newest-30 window filtered down to oneself, so a busier follow set
       * pushed one's own history out of the window — behaviour that only exists
       * once ordering and the limit are real.
       */
      const filters: ((row: Record<string, unknown>) => boolean)[] = [];
      let sort: { column: string; ascending: boolean } | null = null;
      let max: number | null = null;
      const rows = () => {
        const matched = (mockTables[table] ?? []).filter((row) =>
          filters.every((keep) => keep(row as Record<string, unknown>)),
        ) as Record<string, unknown>[];
        if (sort) {
          const { column, ascending } = sort;
          matched.sort((a, b) => {
            const left = String(a[column] ?? '');
            const right = String(b[column] ?? '');
            return ascending ? left.localeCompare(right) : right.localeCompare(left);
          });
        }
        return max === null ? matched : matched.slice(0, max);
      };
      const answer = () => {
        mockReads[table] = (mockReads[table] ?? 0) + 1;
        return mockFailing.has(table)
          ? Promise.resolve({
              // Shaped like PostgREST's, and never shown to anybody: what the screen may
              // say about it is "check your connection", which is the whole point.
              data: null,
              error: { code: '08006', message: 'connection failure' },
              count: null,
            })
          : Promise.resolve({ data: rows(), error: null, count: rows().length });
      };
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters.push((row) => row[column] === value);
          return chain;
        },
        in: (column: string, values: unknown[]) => {
          filters.push((row) => values.includes(row[column]));
          return chain;
        },
        // Both return the chain rather than the answer, because the queries on
        // this screen end on different links: the watchlist on `order`, the
        // feed on `limit`. The chain is itself thenable, so awaiting either
        // works.
        limit: (count: number) => {
          max = count;
          return chain;
        },
        order: (column: string, options?: { ascending?: boolean }) => {
          sort = { column, ascending: options?.ascending ?? true };
          return chain;
        },
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => answer().then(resolve),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  // The inbox query refetches when the screen it is on regains focus, so anything
  // rendering a bell reaches for this. A no-op here: focus is not what these test.
  useFocusEffect: () => {},
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
  mockFailing.clear();
  for (const key of Object.keys(mockReads)) delete mockReads[key];
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
 * Every string the tree draws, in the order it draws them, as one string.
 *
 * Walking children rather than `JSON.stringify(view.toJSON())`, because the
 * serialised tree carries provider props that point back at themselves.
 */
const renderedText = (node: unknown): string => {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(renderedText).join(' ');
  const children = (node as { children?: unknown[] })?.children;
  return children ? children.map(renderedText).join(' ') : '';
};

/**
 * The Try again that belongs to one could-not-load block.
 *
 * Found by walking up from that block's own title rather than by asking for the only
 * "Try again" on the page, because a screen with one failed read usually has two — the
 * whole point of this fix is that each surface answers for itself and can be recovered
 * on its own. The nearest ancestor holding both is the `EmptyState`, so bottom-up
 * cannot reach past it into a neighbour's.
 */
const retryUnder = (view: Awaited<ReturnType<typeof open>>, title: string) => {
  let node: ReturnType<typeof view.getByText> | null = view.getByText(title);
  while (node && !within(node).queryByText('Try again')) node = node.parent;
  if (!node) throw new Error(`Nothing to retry under "${title}"`);
  return within(node).getByText('Try again');
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

  it('offers Invite friends beneath the pair', async () => {
    // The own profile is the one page about the person doing the inviting, so it is
    // the entry point for the invite link — `/u/[username]` deliberately has no such
    // control (see PublicProfileScreen.test.tsx).
    const view = await open();

    await waitFor(() =>
      expect(view.getByRole('button', { name: 'Invite friends' })).toBeTruthy(),
    );
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
    expect(await stat(view, 'TV')).toBeDefined();
    expect(view.queryByLabelText(/^Watchlist: /)).toBeNull();
    expect(view.queryByLabelText(/^Watched: /)).toBeNull();
  });

  it('leaves no dash behind once the counts have landed', async () => {
    mockTables.rankings = [1, 2].map((n) => rankedRow(`film-${n}`, n));

    const view = await open();

    await waitFor(async () => expect(await stat(view, 'Movies')).toBe('2'));
    // The success case has to be *visibly* different from the two states below it, or
    // "it loaded" and "it never will" are the same screen.
    expect(view.queryByText('—')).toBeNull();
    expect(view.queryByText('Could not load your counts')).toBeNull();
  });

  it('says zero for an account that genuinely has none', async () => {
    // Deliberate, and not the same answer as a failed read: nobody follows this account
    // and it has ranked nothing, which is a fact rather than an absence of one.
    const view = await open();

    await waitFor(async () => expect(await stat(view, 'Followers')).toBe('0'));
    expect(await stat(view, 'Movies')).toBe('0');
    expect(view.queryByText('Could not load your counts')).toBeNull();
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
    // A friend's ranking under a heading on your own profile is a different
    // claim from the one the heading makes. The query asks about this actor
    // alone, so the friend's event must never arrive here at all.
    mockTables.feed_events = [activity('e1', 'user-1', 'Sai'), activity('e2', 'friend', 'Anna')];

    const view = await open();
    // A regex, because the title and its year share one Text node: the activity
    // row stopped repeating the title inside its sentence on 2026-08-16, so the
    // only place it appears is beside the year.
    await waitFor(() => expect(view.getAllByText(/Inception/)).toHaveLength(1));
    expect(view.queryByText('Anna')).toBeNull();
  });

  it('shows old activity even when the people you follow are busier', async () => {
    /**
     * The founder's report, as a fixture: a substantial history, none of it recent,
     * behind a follow set that out-posts them. The old implementation filtered the
     * follow feed — the newest 30 events across *everyone* — down to oneself, so
     * thirty fresher events from a friend left nothing of one's own to filter, and
     * the section claimed "Nothing here yet" about an account with years of it.
     * Recent activity asks about the actor directly now; how old the newest ranking
     * is was never supposed to matter.
     */
    mockTables.follows = [{ follower_id: 'user-1', followee_id: 'friend', state: 'approved' }];
    mockTables.feed_events = [
      { ...activity('mine', 'user-1', 'Sai'), created_at: '2026-01-01T00:00:00Z' },
      ...Array.from({ length: 30 }, (_, i) => ({
        ...activity(`friend-${i}`, 'friend', 'Anna'),
        media_item_id: 'film-2',
        media_items: movie('film-2', 'Heat'),
        created_at: `2026-08-15T00:00:${String(i).padStart(2, '0')}Z`,
      })),
    ];

    const view = await open();

    await waitFor(() => expect(view.getAllByText(/Inception/)).toHaveLength(1));
    expect(view.queryByText(/Heat/)).toBeNull();
    expect(view.queryByText('Nothing here yet')).toBeNull();
  });

  it('puts a new ranking first, and keeps the newest five', async () => {
    // The rest of the contract: a fresh activity takes the top slot, and the five the
    // section holds are the newest five *of this person's*, however old the fifth is.
    mockTables.feed_events = Array.from({ length: 6 }, (_, i) => ({
      ...activity(`e${i}`, 'user-1', 'Sai'),
      media_item_id: `film-${i}`,
      media_items: movie(`film-${i}`, `Film number ${i}`),
      created_at: `2026-08-0${i + 1}T00:00:00Z`,
    }));

    const view = await open();

    await waitFor(() => expect(view.getAllByText(/Film number 5/)).toHaveLength(1));
    // Six events, five slots: the oldest is the one that yields.
    expect(view.queryByText(/Film number 0/)).toBeNull();
    const drawn = renderedText(view.toJSON());
    expect(drawn.indexOf('Film number 5')).toBeLessThan(drawn.indexOf('Film number 4'));
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
    // An invitation, not an apology. The distinction is the subject of the block below.
    expect(view.queryByText('Could not load these rankings')).toBeNull();
  });
});

/**
 * **The founder's TestFlight report, as three assertions.** Identity drew; the counts
 * stayed `—`, Your 2026 stayed a skeleton and Top Ranked stayed a skeleton, for as long
 * as anybody was willing to wait.
 *
 * Every one of those surfaces tested `isPending` and nothing else, so a query that had
 * *failed* — pending false, data undefined — fell through to whichever branch handled the
 * absence of data. On the counts that was the loading dash; on Top Ranked it was "Nothing
 * ranked yet", which turned a broken request into a claim about how much the reader had
 * ranked. Neither could be retried without leaving the tab.
 *
 * The rule these hold the screen to: after a read has failed, no surface shows a skeleton
 * or a placeholder, each says which of them failed, and each can re-run its own request.
 */
describe('when a read behind this screen fails', () => {
  const failedActivity = (id: string) => ({
    id,
    type: 'title_ranked',
    actor_id: 'user-1',
    media_item_id: 'film-1',
    created_at: '2026-08-15T00:00:00Z',
    payload: { position: 1, category: 'movies', bucket: 'loved', score: 9.1 },
    media_items: movie('film-1', 'Inception'),
    profiles: { username: 'Sai', display_name: 'Sai', avatar_path: null },
  });

  it('admits the counts could not be read, rather than dashing them forever', async () => {
    mockFailing.add('rankings');

    const view = await open();

    await waitFor(() => expect(view.getByText('Could not load your counts')).toBeTruthy());
    // `—` is a promise that a number is coming, and `?? 0` would have been worse still:
    // "0 followers" is a claim about the account rather than a missing answer.
    expect(view.queryByText('—')).toBeNull();
    expect(view.queryByLabelText(/^Followers: /)).toBeNull();
    expect(retryUnder(view, 'Could not load your counts')).toBeTruthy();
  });

  it('re-issues the counts read on Try again, and shows what comes back', async () => {
    mockFailing.add('rankings');
    mockTables.rankings = [rankedRow('film-1', 1)];

    const view = await open();
    await waitFor(() => expect(view.getByText('Could not load your counts')).toBeTruthy());
    const before = mockReads.rankings ?? 0;

    mockFailing.delete('rankings');
    await fireEvent.press(retryUnder(view, 'Could not load your counts'));

    // The read count, not just the copy: a "Try again" that re-renders the same cached
    // failure is the same dead end with a button on it.
    await waitFor(async () => expect(await stat(view, 'Movies')).toBe('1'));
    expect(mockReads.rankings ?? 0).toBeGreaterThan(before);
    expect(view.queryByText('Could not load your counts')).toBeNull();
  });

  it('does not report an unread collection as an empty one', async () => {
    mockFailing.add('rankings');
    mockTables.rankings = [1, 2, 3].map((n) => rankedRow(`film-${n}`, n));

    const view = await open();

    await waitFor(() => expect(view.getByText('Could not load these rankings')).toBeTruthy());
    // The lie this replaced. Three films are ranked; the request for them did not return.
    expect(view.queryByText('Nothing ranked yet')).toBeNull();
  });

  it('repairs both halves of the wall from its one Try again', async () => {
    mockFailing.add('rankings');
    mockTables.rankings = [rankedRow('film-1', 1)];

    const view = await open();
    await waitFor(() => expect(view.getByText('Could not load these rankings')).toBeTruthy());
    const before = mockReads.rankings ?? 0;

    mockFailing.delete('rankings');
    await fireEvent.press(retryUnder(view, 'Could not load these rankings'));

    await waitFor(() => expect(view.getByLabelText(/Film film-1/)).toBeTruthy());
    // Movies and TV seasons are two reads and one wall, so one retry owes both.
    expect(mockReads.rankings ?? 0).toBeGreaterThanOrEqual(before + 2);
  });

  it('says the activity could not be read, rather than that there is none', async () => {
    mockFailing.add('feed_events');

    const view = await open();

    await waitFor(() => expect(view.getByText('Could not load your activity')).toBeTruthy());
    expect(view.queryByText('Nothing here yet')).toBeNull();
    expect(retryUnder(view, 'Could not load your activity')).toBeTruthy();
  });

  it('re-issues the activity read on Try again', async () => {
    mockFailing.add('feed_events');
    mockTables.feed_events = [failedActivity('e1')];

    const view = await open();
    await waitFor(() => expect(view.getByText('Could not load your activity')).toBeTruthy());
    const before = mockReads.feed_events ?? 0;

    mockFailing.delete('feed_events');
    await fireEvent.press(retryUnder(view, 'Could not load your activity'));

    await waitFor(() => expect(view.getAllByText(/Inception/)).toHaveLength(1));
    expect(mockReads.feed_events ?? 0).toBeGreaterThan(before);
    expect(view.queryByText('Could not load your activity')).toBeNull();
  });

  it('never puts the server’s own words on the screen', async () => {
    mockFailing.add('rankings');
    mockFailing.add('feed_events');

    const view = await open();

    await waitFor(() => expect(view.getByText('Could not load your counts')).toBeTruthy());
    // What the stand-in fails with. A reader is owed "check your connection"; a Postgres
    // code is a developer's sentence printed at somebody who cannot act on it.
    expect(view.queryByText(/08006/)).toBeNull();
    expect(view.queryByText(/connection failure/)).toBeNull();
  });
});

/**
 * **The order of the page, which the founder's final pass rearranged.**
 *
 * Identity, then the bio across the full width, then the stats, then the controls, then
 * the goals and the collection below them.
 *
 * Two things moved. The bio left the identity column, where it had two thirds of the
 * screen and competed with the name for it; and Share Profile and bingd. Awards moved
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
      'bingd. Awards',
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

  it('puts the Watchlist immediately after Top ranked', async () => {
    /**
     * **The founder's ordering decision, asserted as an ordering.** Top ranked says what
     * this person loves; Watchlist says what they want to watch next, and the second is
     * the one somebody else can act on — "I want to watch that too" is a reason to message
     * them. Anything between the two would break that reading, so the adjacency is the
     * test rather than mere presence.
     */
    mockTables.watchlist = [
      {
        user_id: 'user-1',
        media_item_id: 'w1',
        created_at: '2026-08-19T10:00:00Z',
        media_items: { ...movie('w1', 'Sicario'), season_number: null, parent: null },
      },
    ];

    const view = await open();
    await waitFor(() => expect(view.getByText('WATCHLIST')).toBeTruthy());

    // `SectionHeader` upper-cases, so these are the headings as they appear in the tree.
    const found = positions(view, ['TOP RANKED', 'WATCHLIST', 'RECENT ACTIVITY']);
    for (const piece of found) expect([piece.want, piece.at >= 0]).toEqual([piece.want, true]);
    const [top, watchlist, activity] = found.map((piece) => piece.at);
    expect(top).toBeLessThan(watchlist!);
    expect(watchlist!).toBeLessThan(activity!);
  });

  it('shows no Watchlist section for an account that has saved nothing', async () => {
    // Same rule as everywhere else on this screen: a section with nothing in it is not a
    // section. On somebody else's profile this is also the privacy behaviour — see
    // `ProfileWatchlist.test.tsx`.
    const view = await open();
    await waitFor(() => expect(view.getByText('TOP RANKED')).toBeTruthy());
    expect(view.queryByText('WATCHLIST')).toBeNull();
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
