import { waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { TrendingShelf } from './TrendingShelf';

const mockTrending = jest.fn();

jest.mock('./use-trending', () => ({
  useTrending: () => mockTrending(),
}));

jest.mock('@/features/collection/use-collection', () => ({
  useRankedCollection: () => ({ data: [] }),
}));

const shelf = () =>
  renderWithProviders(<TrendingShelf userId="user-1" onPressTitle={jest.fn()} />);

const items = [
  {
    mediaItemId: 'film-1',
    kind: 'movie' as const,
    rank: 0,
    popularity: 90,
    title: 'A Film',
    year: 2026,
    posterPath: '/a.jpg',
  },
];

beforeEach(() => mockTrending.mockReset());

/**
 * The shelf's contract is mostly about what it does *not* render.
 *
 * It sits above the social feed and fails silently on purpose: no skeleton, no error
 * card, no empty state. The founder's report on 2026-08-24 is the case these pin — the
 * shelf vanished and the Feed carried on, which is the design working, and the bug was
 * upstream in a cache nothing had refreshed for a week.
 */
describe('the trending shelf', () => {
  it('renders what it was given', async () => {
    mockTrending.mockReturnValue({ data: { items, stale: false } });

    const view = await shelf();
    await waitFor(() => expect(view.getByLabelText('Trending now')).toBeTruthy());
    expect(view.getByLabelText('A Film, 2026')).toBeTruthy();
  });

  it('renders nothing at all when the list is genuinely empty', async () => {
    // Not an empty state. A discovery strip with nothing to say should cost the social
    // feed no vertical space, which is the ordering PRD §14 asks for.
    mockTrending.mockReturnValue({ data: { items: [], stale: false } });

    const view = await shelf();
    expect(view.queryByLabelText('Trending now')).toBeNull();
  });

  it('renders nothing, and does not throw, when the read failed', async () => {
    // The property that keeps the Activity feed usable when Trending is not: this
    // component is the whole blast radius of a failed trending read.
    mockTrending.mockReturnValue({ data: undefined, isError: true, error: new Error('nope') });

    const view = await shelf();
    expect(view.queryByLabelText('Trending now')).toBeNull();
  });

  it('shows a stale list rather than a hole', async () => {
    // Past the six-hour TTL because the adapter's schedule slipped. It is still what
    // TMDB was featuring a few hours ago; anything older than a week is dropped
    // upstream in `use-trending`, where the claim stops being defensible.
    mockTrending.mockReturnValue({ data: { items, stale: true } });

    const view = await shelf();
    await waitFor(() => expect(view.getByLabelText('A Film, 2026')).toBeTruthy());
  });
});
