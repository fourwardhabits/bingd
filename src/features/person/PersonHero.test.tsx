import { act, fireEvent, waitFor, within } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files.
import PersonScreen from '../../../app/person/[id]';

/**
 * **The person page's hero: a backdrop from their own work** (founder QA P1-9), rendered.
 *
 * Which credit is chosen is `pickPersonBackdrop`'s, and `backdrop.test.ts` pins the rule.
 * This file pins what the page does with it: the backdrop comes off the `media_items` rows
 * the page already reads — no provider request — the branded band stands in while the
 * credits load and where none has a backdrop, the portrait stays, and the sort control the
 * founder kept (Popular, Release date, Highest rated) is still all there.
 */

const mockPush = jest.fn();
const mockCachePerson = jest.fn(() => Promise.resolve({ id: 0, written: 0 }));
const tableRows: Record<string, unknown[]> = {};
const mockSelects: Record<string, string[]> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const rows = () =>
        (tableRows[table] ?? []).filter((row) =>
          Object.entries(filters).every(
            ([key, value]) => (row as Record<string, unknown>)[key] === value,
          ),
        );
      const chain = {
        select: (columns: string) => {
          (mockSelects[table] ??= []).push(columns);
          return chain;
        },
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        gt: () => chain,
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: rows(), error: null, count: rows().length }),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
  useLocalSearchParams: () => ({ id: '6193' }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

jest.mock('@/lib/tmdb-adapter', () => ({
  cachePerson: (...args: unknown[]) => mockCachePerson(...(args as [])),
}));

const FRESH = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
const HERO = 'https://image.tmdb.org/t/p/w1280';

type CreditEntry = {
  id: string;
  kind: 'movie' | 'series';
  role: string | null;
  as: 'cast' | 'crew';
  crew_role?: string | null;
  self?: boolean;
  tmdb_score?: number | null;
};

const person = (credits: CreditEntry[]) => ({
  tmdb_person_id: 6193,
  expires_at: FRESH,
  payload: {
    person: {
      name: 'Leonardo DiCaprio',
      profile_path: '/leo.jpg',
      known_for: 'Acting',
      biography: null,
      birthday: '1974-11-11',
    },
    credits,
    credit_total: credits.length,
  },
});

const item = (
  id: string,
  title: string,
  release_date: string | null,
  backdrop_path: string | null,
  kind: 'movie' | 'series' = 'movie',
) => ({ id, kind, title, release_date, poster_path: null, backdrop_path });

/** A year in the future, so "unreleased" does not depend on when the suite runs. */
const NEXT_YEAR = String(new Date().getFullYear() + 1);

const ACTOR: CreditEntry[] = [
  { id: 'inception', kind: 'movie', role: 'Cobb', as: 'cast', tmdb_score: 8.4 },
  { id: 'killers', kind: 'movie', role: 'Ernest Burkhart', as: 'cast', tmdb_score: 7.5 },
  { id: 'upcoming', kind: 'movie', role: 'Lead', as: 'cast' },
  { id: 'talk', kind: 'series', role: 'Self', as: 'cast', self: true },
];
const ACTOR_ITEMS = [
  item('inception', 'Inception', '2010-07-16', '/inception-bd.jpg'),
  item('killers', 'Killers of the Flower Moon', '2023-10-20', '/killers-bd.jpg'),
  item('upcoming', 'Untitled Project', `${NEXT_YEAR}-06-01`, '/upcoming-bd.jpg'),
  item('talk', 'Late Night', '2026-01-05', '/talk-bd.jpg', 'series'),
];

beforeEach(() => {
  mockPush.mockReset();
  mockCachePerson.mockClear();
  for (const key of Object.keys(tableRows)) delete tableRows[key];
  for (const key of Object.keys(mockSelects)) delete mockSelects[key];
  tableRows.person_cache = [person(ACTOR)];
  tableRows.media_items = ACTOR_ITEMS;
  tableRows.watchlist = [];
  tableRows.rankings = [];
  tableRows.user_media = [];
});

type View = Awaited<ReturnType<typeof renderWithProviders>>;

const open = async () => {
  const view = await renderWithProviders(<PersonScreen />);
  await waitFor(() => expect(view.getByTestId('person-name')).toBeTruthy());
  return view;
};

type Node = { props?: Record<string, unknown>; children?: unknown[] } | string | null;

/** Every image URI drawn under `node`, in tree order. */
function imageUris(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) imageUris(child, out);
    return out;
  }
  const element = node as Node;
  if (!element || typeof element === 'string') return out;
  const source = element.props?.source as { uri?: string } | { uri?: string }[] | undefined;
  for (const entry of Array.isArray(source) ? source : source ? [source] : []) {
    if (entry.uri) out.push(entry.uri);
  }
  for (const child of element.children ?? []) imageUris(child, out);
  return out;
}

/** The hero's image URI, or null for the branded band. Headshots are `w185`, not this. */
const heroUri = (view: View) => {
  const uris = [...new Set(imageUris(view.toJSON()).filter((uri) => uri.startsWith(HERO)))];
  expect(uris.length).toBeLessThanOrEqual(1);
  return uris[0] ?? null;
};

describe('the person hero', () => {
  it('shows a backdrop from their latest released film, not the newest announced one', async () => {
    const view = await open();
    expect(heroUri(view)).toBe(`${HERO}/killers-bd.jpg`);
  });

  it('reads the backdrop off the catalogue rows already selected, and asks TMDB nothing', async () => {
    await open();
    expect(mockSelects.media_items).toEqual([
      'id, kind, title, release_date, poster_path, backdrop_path',
    ]);
    // A fresh cache row: the page never asks the adapter, with or without a hero.
    expect(mockCachePerson).not.toHaveBeenCalled();
  });

  it('keeps the headshot, straddling the hero, alongside the name', async () => {
    const view = await open();
    const block = view.getByTestId('person-identity');
    const headshots = [...new Set(imageUris(block))];
    expect(headshots).toEqual(['https://image.tmdb.org/t/p/w185/leo.jpg']);
    expect(within(block).getByText('Leonardo DiCaprio')).toBeTruthy();
  });

  it('never uses a self-appearance, even the newest credit with a backdrop', async () => {
    tableRows.person_cache = [person([ACTOR[0]!, ACTOR[3]!])];
    const view = await open();
    expect(heroUri(view)).toBe(`${HERO}/inception-bd.jpg`);
  });

  it('draws the branded band when no credit has a backdrop — no broken image', async () => {
    tableRows.media_items = ACTOR_ITEMS.map((row) => ({ ...row, backdrop_path: null }));
    const view = await open();
    expect(heroUri(view)).toBeNull();
    expect(view.getByTestId('person-identity')).toBeTruthy();
  });

  it('draws the branded band for somebody with no credits at all', async () => {
    tableRows.person_cache = [person([])];
    const view = await open();
    expect(heroUri(view)).toBeNull();
    expect(view.getByText('Nothing here')).toBeTruthy();
  });

  it('uses a crew credit for somebody who only works behind the camera', async () => {
    tableRows.person_cache = [
      person([
        { id: 'inception', kind: 'movie', role: 'Director', as: 'crew', crew_role: 'Director' },
        { id: 'upcoming', kind: 'movie', role: 'Director', as: 'crew', crew_role: 'Director' },
      ]),
    ];
    const view = await open();
    expect(heroUri(view)).toBe(`${HERO}/inception-bd.jpg`);
  });

  it('shows the band, not a picture, while the filmography is still loading', async () => {
    // Somebody else's fetch is in flight: a claim placeholder, which the page waits on.
    tableRows.person_cache = [{ tmdb_person_id: 6193, expires_at: FRESH, payload: {} }];
    const view = await renderWithProviders(<PersonScreen />);
    await waitFor(() => expect(view.getByTestId('person-loading')).toBeTruthy());
    expect(heroUri(view)).toBeNull();
  });

  it('keeps the first picture when a refresh brings a newer film, so it never flickers', async () => {
    const view = await open();
    expect(heroUri(view)).toBe(`${HERO}/killers-bd.jpg`);

    tableRows.person_cache = [
      person([{ id: 'newer', kind: 'movie', role: 'Lead', as: 'cast' }, ...ACTOR]),
    ];
    tableRows.media_items = [
      item('newer', 'A Newer Film', '2025-12-25', '/newer-bd.jpg'),
      ...ACTOR_ITEMS,
    ];
    await act(() => view.client.invalidateQueries({ queryKey: ['person', 6193] }));
    // The refresh landed — its new film is listed — and the hero did not change.
    await waitFor(() => expect(view.getByText('A Newer Film (2025)')).toBeTruthy());
    expect(heroUri(view)).toBe(`${HERO}/killers-bd.jpg`);
  });

  it('still offers Popular, Release date and Highest rated (TMDB)', async () => {
    const view = await open();
    await fireEvent.press(view.getByLabelText('Sort. Popular'));
    const menu = within(view.getByTestId('filmography-sort-menu'));
    const options = menu.getAllByRole('radio').map((node) => node.props.accessibilityLabel);
    expect(options).toEqual(['Popular', 'Release date', 'Highest rated (TMDB)']);
  });
});
