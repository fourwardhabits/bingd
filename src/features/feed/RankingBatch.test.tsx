import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { RankingBatchRow } from './RankingBatchRow';
import { RankingBatchSheet } from './RankingBatchSheet';
import type { FeedItem } from './use-feed';

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

const event = (over: Partial<FeedItem> = {}) =>
  ({
    id: 'event-1',
    type: 'ranking_batch',
    actorId: 'michael-id',
    actorUsername: 'michael',
    actorName: 'Michael',
    actorAvatarUri: null,
    mediaItemId: 'oasis',
    kind: 'movie',
    title: "Oasis: Don't Look Back in Anger",
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    rankedCount: 18,
    followed: [],
    ...over,
  }) as FeedItem;

beforeEach(() => {
  mockRpc.mockReset();
});

describe('the collapsed row', () => {
  it('names the first title and counts the rest', async () => {
    const view = await renderWithProviders(
      <RankingBatchRow
        event={event()}
        onPressActor={() => {}}
        onPressTitle={() => {}}
        onOpenList={() => {}}
      />,
    );

    expect(view.getByText('Michael')).toBeTruthy();
    expect(view.getByText("Oasis: Don't Look Back in Anger")).toBeTruthy();
    // Eighteen ranked, one named, seventeen counted.
    expect(view.getByText(/\+ 17 more/)).toBeTruthy();
    expect(view.getByText('5m ago')).toBeTruthy();
  });

  it('says ranked, never watched or added', async () => {
    // Ranking chronology and watch chronology are different things, and this row is the
    // one place they could be confused.
    const view = await renderWithProviders(
      <RankingBatchRow
        event={event()}
        onPressActor={() => {}}
        onPressTitle={() => {}}
        onOpenList={() => {}}
      />,
    );

    expect(view.getByText(/ranked/)).toBeTruthy();
    expect(view.queryByText(/watched/i)).toBeNull();
    expect(view.queryByText(/rewatch/i)).toBeNull();
    expect(view.queryByText(/added/i)).toBeNull();
  });

  it('adds no tail for a sitting of one', async () => {
    const view = await renderWithProviders(
      <RankingBatchRow
        event={event({ rankedCount: 1 })}
        onPressActor={() => {}}
        onPressTitle={() => {}}
        onOpenList={() => {}}
      />,
    );

    expect(view.getByText("Oasis: Don't Look Back in Anger")).toBeTruthy();
    expect(view.queryByText(/more/)).toBeNull();
  });

  it('the title opens its page', async () => {
    const onPressTitle = jest.fn();
    const view = await renderWithProviders(
      <RankingBatchRow
        event={event()}
        onPressActor={() => {}}
        onPressTitle={onPressTitle}
        onOpenList={() => {}}
      />,
    );

    await fireEvent.press(view.getByText("Oasis: Don't Look Back in Anger"));

    expect(onPressTitle).toHaveBeenCalled();
  });

  it('the tail opens the sitting', async () => {
    const onOpenList = jest.fn();
    const view = await renderWithProviders(
      <RankingBatchRow
        event={event()}
        onPressActor={() => {}}
        onPressTitle={() => {}}
        onOpenList={onOpenList}
      />,
    );

    await fireEvent.press(view.getByText(/\+ 17 more/));

    expect(onOpenList).toHaveBeenCalled();
  });
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
