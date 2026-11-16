import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

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

  it('names the season pool for a season sitting', async () => {
    mockRpc.mockResolvedValue({ data: [titles[0]], error: null });
    const view = await renderWithProviders(
      <RankingBatchSheet eventId="event-1" medium="tv_seasons" onClose={() => {}} />,
    );

    // "TV seasons" since 2026-11-14: TV is two rankings, so the pool is named.
    await waitFor(() => expect(view.getByText('#24 in TV seasons')).toBeTruthy());
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

/**
 * **Reopening a grown group reads it again** (Codex, PR 311). A published sitting can grow in
 * place when a later sitting joins it (20261126000100). Under the app's own staleTime (60 s;
 * the test providers use 0, which would hide the bug) the second open must fetch.
 */
describe('the member sheet under the app’s cache settings', () => {
  it('fetches the members again on every open, so a grown group shows its new titles', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 60_000, gcTime: 60_000, retry: false } },
    });
    const metrics = {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 47, left: 0, right: 0, bottom: 34 },
    };
    const sheet = () => (
      <QueryClientProvider client={client}>
        <SafeAreaProvider initialMetrics={metrics}>
          <RankingBatchSheet eventId="event-1" medium="movies" onClose={() => {}} />
        </SafeAreaProvider>
      </QueryClientProvider>
    );
    const heat = {
      media_item_id: 'heat',
      title: 'Heat',
      poster_path: null,
      position: 3,
      score: 10,
      bucket: 'loved',
    };
    const ronin = { ...heat, media_item_id: 'ronin', title: 'Ronin', position: 4, score: 9.5 };
    try {
      mockRpc.mockResolvedValue({ data: [heat], error: null });
      const first = await render(sheet());
      await waitFor(() => expect(first.getByText('Heat')).toBeTruthy());
      await first.unmount();

      mockRpc.mockResolvedValue({ data: [heat, ronin], error: null });
      const second = await render(sheet());
      await waitFor(() => expect(second.getByText('Ronin')).toBeTruthy());
      expect(
        mockRpc.mock.calls.filter(([name]) => name === 'ranking_batch_titles'),
      ).toHaveLength(2);
      await second.unmount();
    } finally {
      client.clear();
    }
  });
});
