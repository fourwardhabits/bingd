import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import LogScreen from './log';

const mockRpc = jest.fn();
const mockSeasons = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => mockSeasons(),
        single: () => mockSeasons(),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

let issued = 0;
jest.mock('expo-crypto', () => ({
  randomUUID: () => `operation-${(issued += 1)}`,
}));

const series = {
  id: 'series-1',
  kind: 'series',
  title: 'Breaking Bad',
  release_date: '2008-01-20',
  poster_path: '/bb.jpg',
  provenance: 'wikidata',
};

const film = {
  id: 'film-1',
  kind: 'movie',
  title: 'Inception',
  release_date: '2010-07-16',
  poster_path: null,
  provenance: 'wikidata',
};

beforeEach(() => {
  issued = 0;
  mockRpc.mockReset();
  mockSeasons.mockReset();
  mockRpc.mockImplementation((fn: string) =>
    fn === 'search_titles'
      ? Promise.resolve({ data: [series, film], error: null })
      : Promise.resolve({ data: { status: 'ok' }, error: null }),
  );
  mockSeasons.mockResolvedValue({
    data: [
      { id: 'season-1', season_number: 1, title: 'Season 1', release_date: '2008-01-20', poster_path: null },
      { id: 'season-2', season_number: 2, title: 'Season 2', release_date: '2009-03-08', poster_path: null },
    ],
    error: null,
  });
});

const callsTo = (fn: string) => mockRpc.mock.calls.filter(([name]) => name === fn);

const search = async (term: string) => {
  const view = await renderWithProviders(<LogScreen />);
  await fireEvent.changeText(view.getByLabelText('Search'), term);
  return view;
};

// Result rows are addressed the way a screen reader announces them, which is also the only
// string that carries the "pick a season" hint.
const SERIES_ROW = 'Breaking Bad, 2008, Series · pick a season';
const FILM_ROW = 'Inception, 2010';

/**
 * The Log tab (screens.md §2).
 *
 * The distinction this screen exists to make visible: a series cannot be logged. The season
 * is the rankable unit and `_assert_loggable` refuses a series outright (AD-1), so tapping
 * one has to lead somewhere rather than fail.
 */
describe('a series in the results', () => {
  it('opens its seasons rather than the log sheet', async () => {
    const view = await search('breaking');

    await waitFor(() => expect(view.getByLabelText(SERIES_ROW)).toBeTruthy());
    expect(view.getByText('Series · pick a season')).toBeTruthy();

    await fireEvent.press(view.getByLabelText(SERIES_ROW));

    await waitFor(() =>
      expect(view.getByText('Seasons are ranked separately, so pick the one you watched.')),
    );
    // The log sheet's own prompt. If it were open, the user could bucket a series.
    expect(view.queryByText('How was it?')).toBeNull();
  });

  it('logs the season the user picked, not the series', async () => {
    const view = await search('breaking');

    await waitFor(() => expect(view.getByLabelText(SERIES_ROW)).toBeTruthy());
    await fireEvent.press(view.getByLabelText(SERIES_ROW));
    await waitFor(() => expect(view.getByText('Season 2')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Season 2, 2009'));

    // The series title travels with the season, or the header reads "Season 2" alone.
    await waitFor(() => expect(view.getByText('Breaking Bad: Season 2')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Loved it'));
    await waitFor(() => expect(callsTo('set_bucket')).toHaveLength(1));

    expect(callsTo('set_bucket')[0][1]).toMatchObject({ p_media_item_id: 'season-2' });
  });
});

describe('a film in the results', () => {
  it('goes straight to the bucket prompt', async () => {
    const view = await search('inception');

    await waitFor(() => expect(view.getByLabelText(FILM_ROW)).toBeTruthy());
    await fireEvent.press(view.getByLabelText(FILM_ROW));

    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('It was fine'));

    await waitFor(() => expect(callsTo('set_bucket')).toHaveLength(1));
    expect(callsTo('set_bucket')[0][1]).toMatchObject({
      p_media_item_id: 'film-1',
      p_bucket: 'fine',
    });
  });

  it('hands the comparison the same title it just logged', async () => {
    const view = await search('inception');

    await waitFor(() => expect(view.getByLabelText(FILM_ROW)).toBeTruthy());
    await fireEvent.press(view.getByLabelText(FILM_ROW));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('It was fine'));

    const find = () => view.getByRole('button', { name: 'Find where it lands' });
    await waitFor(() => expect(find().props.accessibilityState.disabled).toBe(false));
    await fireEvent.press(find());

    await waitFor(() => expect(callsTo('rank_start')).toHaveLength(1));
    expect(callsTo('rank_start')[0][1]).toEqual({
      p_media_item_id: 'film-1',
      p_bucket: 'fine',
    });
  });
});

describe('before anything is typed', () => {
  it('says what to do instead of showing an empty list', async () => {
    const view = await renderWithProviders(<LogScreen />);

    expect(view.getByText('What did you watch?')).toBeTruthy();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
