import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { RankingBatchSheet } from './RankingBatchSheet';

/**
 * The grouped ranking post (`20261020000100`, founder 2026-09-24).
 *
 * What only the client can get wrong: the sentence, whose count is in it, where the two
 * touches go, and — the one that matters most — that the expanded list puts the **score**
 * on the right and the standing in the subdued line, rather than the other way round.
 * Everything about *when* a post is created, and that it writes no watch, is asserted in
 * `supabase/tests/ranking-batch-feed.test.mjs` against real SQL.
 */

const mockRpc = jest.fn();
jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  startSessionRefresh: () => () => {},
}));

beforeEach(() => {
  mockRpc.mockReset();
});

describe('the expanded list', () => {
  const titles = [
    {
      media_item_id: 'oasis',
      title: "Oasis: Don't Look Back in Anger",
      poster_path: null,
      position: 24,
      score: 8.7,
      bucket: 'loved',
    },
    {
      media_item_id: 'heat',
      title: 'Heat',
      poster_path: null,
      position: 3,
      score: 10,
      bucket: 'loved',
    },
  ];

  it('puts the score on the right and the standing in the subdued line', async () => {
    // The founder's rule: the right-hand value is the rating, because that is what a feed
    // row, a collection row and a title page all put there. `#24` belongs in the
    // secondary text, never as the primary value.
    mockRpc.mockResolvedValue({ data: titles, error: null });
    const view = await renderWithProviders(
      <RankingBatchSheet eventId="event-1" medium="movies" onClose={() => {}} />,
    );

    await waitFor(() => expect(view.getByText('Heat')).toBeTruthy());
    expect(view.getByLabelText('8.7 out of 10, I liked it')).toBeTruthy();
    expect(view.getByLabelText('10.0 out of 10, I liked it')).toBeTruthy();
    expect(view.getByText('#24 in Movies')).toBeTruthy();
    expect(view.getByText('#3 in Movies')).toBeTruthy();
  });

  it('reads the sitting by its event id', async () => {
    mockRpc.mockResolvedValue({ data: titles, error: null });
    const view = await renderWithProviders(
      <RankingBatchSheet eventId="event-1" medium="movies" onClose={() => {}} />,
    );

    await waitFor(() => expect(view.getByText('Heat')).toBeTruthy());
    expect(mockRpc).toHaveBeenCalledWith('ranking_batch_titles', { p_event_id: 'event-1' });
  });

  it('uses the TV wording for a season sitting', async () => {
    mockRpc.mockResolvedValue({ data: [titles[0]], error: null });
    const view = await renderWithProviders(
      <RankingBatchSheet eventId="event-1" medium="tv_seasons" onClose={() => {}} />,
    );

    await waitFor(() => expect(view.getByText('#24 in TV')).toBeTruthy());
  });

  it('scrolls, because a sitting has no ceiling', async () => {
    mockRpc.mockResolvedValue({ data: titles, error: null });
    const view = await renderWithProviders(
      <RankingBatchSheet eventId="event-1" medium="movies" onClose={() => {}} />,
    );

    await waitFor(() => expect(view.getByTestId('ranking-batch-scroll')).toBeTruthy());
    expect(view.getAllByTestId('ranked-summary-row')).toHaveLength(2);
  });
});
