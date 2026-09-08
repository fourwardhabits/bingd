import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { TopRanked } from './TopRanked';

/**
 * The wall of six, and the order it puts them in.
 *
 * **The defect this file exists for (physical QA, 2026-09-08).** Under **All**, somebody
 * else's profile printed
 *
 *     movie 10.0 · TV 10.0 · movie 9.9 · TV 10.0 · movie 9.9 · TV 9.9
 *
 * — a 9.9 above a 10.0, twice. It was not two code paths drifting: this component is
 * shared by both profile screens and the founder's own profile ran exactly the same
 * lines. It was that **All** ordered by `position`, which is a rank *inside one category*,
 * and then interleaved. A score is a position interpolated across the size of its band,
 * so two bands of different sizes decay at different rates and position order stops
 * agreeing with score order — invisible on a profile whose two bands are close in size,
 * wrong on one whose are not.
 *
 * The fixtures below make that disagreement small and legible rather than reproducing the
 * founder's 61-seasons-beside-44-films arithmetic. Every score here is an endpoint of
 * `BAND_RANGE` or an even step of a band of seven, so the numbers can be read off the
 * buckets without doing the interpolation by hand.
 */

type Row = {
  user_id: string;
  media_item_id: string;
  bucket: 'loved' | 'fine' | 'not_for_me';
  position: number;
  category: 'movies' | 'tv_seasons';
  created_at: string;
  media_items: {
    title: string;
    season_number: number | null;
    release_date: string | null;
    poster_path: string | null;
    genres: string[];
    runtime_minutes: number | null;
    kind: 'movie' | 'season';
    original_language: string | null;
    parent_id: string | null;
    parent: { title: string; genres: string[]; original_language: string | null } | null;
  };
};

let mockRows: Row[] = [];

/**
 * The stand-in honours `eq`, `gt`, `order` and `limit`.
 *
 * `useRankedCollection` reads through `readAllByKey`, which pages on a `media_item_id`
 * keyset and applies position order afterwards. A mock that ignored the keyset would hand
 * the same rows to every page and the traversal would refuse to loop rather than answer —
 * so the parts that look incidental to an ordering test are what makes the read finish at
 * all. Honouring `user_id` is what lets the parity tests below use two subjects.
 */
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => {
      const filters: Record<string, unknown> = {};
      let cursor: string | null = null;
      let max: number | null = null;
      const rows = () =>
        mockRows
          .filter(
            (row) =>
              Object.entries(filters).every(
                ([key, value]) => (row as unknown as Record<string, unknown>)[key] === value,
              ) &&
              (cursor === null || row.media_item_id > cursor),
          )
          .sort((a, b) => a.media_item_id.localeCompare(b.media_item_id))
          .slice(0, max ?? undefined);
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        gt: (_column: string, value: string) => {
          cursor = value;
          return chain;
        },
        order: () => chain,
        limit: (n: number) => {
          max = n;
          return chain;
        },
        then: (resolve: (result: unknown) => unknown) =>
          Promise.resolve({ data: rows(), error: null }).then(resolve),
      };
      return chain;
    },
  },
}));

const ranked = (
  id: string,
  title: string,
  position: number,
  category: 'movies' | 'tv_seasons',
  bucket: Row['bucket'] = 'loved',
  userId = 'anna-id',
): Row => ({
  user_id: userId,
  media_item_id: id,
  bucket,
  position,
  category,
  created_at: '2026-09-01T00:00:00Z',
  media_items: {
    title,
    season_number: category === 'tv_seasons' ? position : null,
    release_date: '2020-01-01',
    poster_path: null,
    genres: ['Drama'],
    runtime_minutes: 100,
    kind: category === 'tv_seasons' ? 'season' : 'movie',
    original_language: 'en',
    parent_id: category === 'tv_seasons' ? 'series-1' : null,
    parent: category === 'tv_seasons' ? { title, genres: ['Drama'], original_language: 'en' } : null,
  },
});

type View = Awaited<ReturnType<typeof renderWithProviders>>;

/**
 * The wall, first tile to last, as `score title`.
 *
 * Read off the tiles' accessibility labels, because that is where a wall of artwork says
 * what it is — `PosterGrid` renders `Title, year, scored 10.0 out of 10` — and because the
 * label is the one part of a poster a test and a screen reader agree about.
 */
const wall = (view: View) =>
  view.getAllByLabelText(/scored \d/).map((tile) => {
    const label = String(tile.props.accessibilityLabel ?? '');
    const title = /^([^,]+)/.exec(label)?.[1] ?? '';
    const score = /scored ([\d.]+) out of 10/.exec(label)?.[1] ?? '';
    return `${score} ${title}`;
  });

const open = (userId = 'anna-id', otherName: string | null = 'Anna') =>
  renderWithProviders(<TopRanked userId={userId} otherName={otherName} onPressTitle={() => {}} />);

const settled = async (view: View) => {
  await waitFor(() => expect(view.getAllByLabelText(/scored \d/).length).toBeGreaterThan(0));
  return view;
};

beforeEach(() => {
  mockRows = [];
});

/**
 * **The founder's ordering case**, built so every score is an endpoint of its band:
 *
 *   - movies: one `loved` (a band of one scores its high, 10.0) and one `fine` (likewise,
 *     6.9);
 *   - seasons: two `loved` (10.0, then 7.0 as the bottom of the band) and one
 *     `not_for_me` (3.4).
 *
 * Position order is m-a, s-a, m-b, s-b, s-c — which is what the old code drew, and it put
 * Movie B's 6.9 above TV B's 7.0.
 */
const orderingFixture = (userId: string) => [
  ranked('m-a', 'Movie A', 1, 'movies', 'loved', userId),
  ranked('m-b', 'Movie B', 2, 'movies', 'fine', userId),
  ranked('s-a', 'TV A', 1, 'tv_seasons', 'loved', userId),
  ranked('s-b', 'TV B', 2, 'tv_seasons', 'loved', userId),
  ranked('s-c', 'TV C', 3, 'tv_seasons', 'not_for_me', userId),
];

/**
 * The two 10.0s are separated by the id tiebreak — `m-a` before `s-a` — which is the
 * comparator being total, not a claim that films outrank seasons.
 */
const ORDERED = ['10.0 Movie A', '10.0 TV A', '7.0 TV B', '6.9 Movie B', '3.4 TV C'];

describe('All is one list ordered by score', () => {
  it('never puts a lower score above a higher one because the media types differ', async () => {
    mockRows = orderingFixture('anna-id');

    const view = await settled(await open('anna-id', 'Anna'));

    expect(wall(view)).toEqual(ORDERED);
  });

  it('orders the viewer’s own profile by exactly the same rule', async () => {
    /**
     * The parity the bug report implied was missing. Both profile screens render this one
     * component with nothing but a different `userId` and an `otherName` for the empty
     * state, so the founder's own profile looking right was band sizes being kind rather
     * than a second, correct path. Asserted against the same constant as the test above,
     * because "it is the same component" is the kind of claim that stops being true in a
     * later tranche without anybody noticing.
     */
    mockRows = orderingFixture('me-id');

    const view = await settled(await open('me-id', null));

    expect(wall(view)).toEqual(ORDERED);
  });

  it('takes the six after the sort, not before it', async () => {
    /**
     * Seven ranked films and one `fine` season. The season is its category's best and so
     * survives any per-category slice, but at 6.9 it is not one of this person's six best
     * titles — the old code drew it second, ahead of five films it outranked by position
     * and undercut by score.
     */
    mockRows = [
      ...Array.from({ length: 7 }, (_, index) =>
        ranked(`m-${index + 1}`, `Movie ${index + 1}`, index + 1, 'movies'),
      ),
      ranked('s-1', 'One Season', 1, 'tv_seasons', 'fine'),
    ];

    const view = await settled(await open());

    // Seven `loved` films: 3.0 spread over six steps.
    expect(wall(view)).toEqual([
      '10.0 Movie 1',
      '9.5 Movie 2',
      '9.0 Movie 3',
      '8.5 Movie 4',
      '8.0 Movie 5',
      '7.5 Movie 6',
    ]);
  });
});

describe('the category tabs still rank inside their own category', () => {
  it('shows Movies alone, in that ranking’s own order', async () => {
    mockRows = orderingFixture('anna-id');

    const view = await settled(await open());
    fireEvent.press(view.getByRole('tab', { name: 'Movies' }));

    await waitFor(() => expect(wall(view)).toEqual(['10.0 Movie A', '6.9 Movie B']));
  });

  it('shows TV alone, in that ranking’s own order', async () => {
    mockRows = orderingFixture('anna-id');

    const view = await settled(await open());
    fireEvent.press(view.getByRole('tab', { name: 'TV' }));

    await waitFor(() =>
      expect(wall(view)).toEqual(['10.0 TV A', '7.0 TV B', '3.4 TV C']),
    );
  });
});

describe('the walls with nothing to interleave', () => {
  it('has no tabs, and one ranking’s order, when only films are ranked', async () => {
    mockRows = [ranked('m-a', 'Movie A', 1, 'movies'), ranked('m-b', 'Movie B', 2, 'movies')];

    const view = await settled(await open());

    expect(wall(view)).toEqual(['10.0 Movie A', '7.0 Movie B']);
    expect(view.queryByRole('tab', { name: 'TV' })).toBeNull();
  });

  it('has no tabs, and one ranking’s order, when only seasons are ranked', async () => {
    mockRows = [
      ranked('s-a', 'TV A', 1, 'tv_seasons'),
      ranked('s-b', 'TV B', 2, 'tv_seasons'),
    ];

    const view = await settled(await open());

    expect(wall(view)).toEqual(['10.0 TV A', '7.0 TV B']);
    expect(view.queryByRole('tab', { name: 'Movies' })).toBeNull();
  });

  it('says so plainly when nothing is ranked at all', async () => {
    mockRows = [];

    const view = await open();

    await waitFor(() => expect(view.getByText('Nothing ranked yet')).toBeTruthy());
    expect(view.getByText('Anna has not ranked anything here yet.')).toBeTruthy();
  });
});
