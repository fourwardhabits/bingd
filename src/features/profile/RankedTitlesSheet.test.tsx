import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { RankedTitlesSheet } from './RankedTitlesSheet';

/**
 * The list behind a profile stat (external-beta polish, 2026-08-27).
 *
 * The order is the point: the founder asked for *newest addition first*, which is a
 * different question from Top Ranked's position order — so what is pinned here is that
 * the query asks the server for `created_at` descending and renders what comes back in
 * that order. The privacy rule is not asserted here because it is not decided here:
 * the read is `rankings` under `rankings_read`, exercised in the DB suites.
 */

const mockOrders: { column: string; ascending: boolean | undefined }[] = [];
const mockFilters: Record<string, unknown> = {};
let mockRows: unknown[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      expect(table).toBe('rankings');
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          mockFilters[column] = value;
          return chain;
        },
        order: (column: string, options?: { ascending?: boolean }) => {
          mockOrders.push({ column, ascending: options?.ascending });
          return chain;
        },
        limit: () => Promise.resolve({ data: mockRows, error: null }),
      };
      return chain;
    },
  },
}));

const ranked = (id: string, title: string) => ({
  media_item_id: id,
  created_at: '2026-08-01T00:00:00Z',
  media_items: { title, release_date: '2019-07-02', poster_path: null },
});

beforeEach(() => {
  mockOrders.length = 0;
  for (const key of Object.keys(mockFilters)) delete mockFilters[key];
  mockRows = [];
});

const open = (over: Partial<Parameters<typeof RankedTitlesSheet>[0]> = {}) =>
  renderWithProviders(
    <RankedTitlesSheet
      category="movies"
      userId="anna-id"
      name="Anna"
      isSelf={false}
      viewerId="viewer"
      onPressTitle={jest.fn()}
      onClose={jest.fn()}
      {...over}
    />,
  );

it('asks for the person’s rankings, newest addition first', async () => {
  mockRows = [ranked('m2', 'Later Film'), ranked('m1', 'Earlier Film')];

  const view = await open();

  await waitFor(() => expect(view.getByText(/Later Film/)).toBeTruthy());
  expect(mockFilters).toMatchObject({ user_id: 'anna-id', category: 'movies' });
  // `created_at` descending is the sort the sheet promises; the id tiebreak keeps two
  // same-moment additions from swapping between fetches.
  expect(mockOrders[0]).toEqual({ column: 'created_at', ascending: false });
  expect(mockOrders[1]).toEqual({ column: 'media_item_id', ascending: true });
});

it('renders the rows in the order the server decided', async () => {
  mockRows = [ranked('m2', 'Later Film'), ranked('m1', 'Earlier Film')];

  const view = await open();

  await waitFor(() => expect(view.getByText(/Later Film/)).toBeTruthy());
  // Render order follows array order in RN Testing Library's tree walk.
  const labels = view
    .getAllByLabelText(/Film, 2019/)
    .map((node) => node.props.accessibilityLabel);
  expect(labels).toEqual(['Later Film, 2019', 'Earlier Film, 2019']);
});

it('opens the tapped title', async () => {
  const onPressTitle = jest.fn();
  mockRows = [ranked('m1', 'A Film')];

  const view = await open({ onPressTitle });
  await waitFor(() => expect(view.getByText(/A Film/)).toBeTruthy());

  await fireEvent.press(view.getByText(/A Film/));

  expect(onPressTitle).toHaveBeenCalledWith('m1');
});

it('says the category is empty rather than showing a blank sheet', async () => {
  const view = await open({ category: 'tv_seasons' });

  await waitFor(() => expect(view.getByText('No tv seasons ranked yet')).toBeTruthy());
});

/**
 * The read is one page and the stat is not capped (review 60): a full page must say
 * it was cut rather than let the reader count 200 under a stat that says 230.
 */
it('discloses a full page as truncation, and only a full page', async () => {
  mockRows = Array.from({ length: 200 }, (_, i) => ranked(`m${i}`, `Film ${i}`));

  const view = await open();
  await waitFor(() => expect(view.getByText(/Film 0/)).toBeTruthy());
  expect(view.getByText('Showing the newest 200.')).toBeTruthy();

  mockRows = [ranked('m1', 'A Film')];
  const short = await open();
  await waitFor(() => expect(short.getByText(/A Film/)).toBeTruthy());
  expect(short.queryByText('Showing the newest 200.')).toBeNull();
});
