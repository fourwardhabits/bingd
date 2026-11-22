import { render, waitFor, within } from '@testing-library/react-native';

import { PosterRail } from '@/ui/components/PosterWall';
import { renderWithProviders } from '@/test-utils/render';

import { batchReviews, RankingBatchSheet } from './RankingBatchSheet';

/**
 * **A reviewed first ranking inside its group** (20261130000800).
 *
 * The server now folds a reviewed first ranking into its half-hour group instead of giving
 * it a card of its own, so the review has to be readable from the group: under its own
 * title in the group's sheet, masked for spoilers as the Feed masks it. (Since 2026-11-22
 * its poster in the rail carries no review label.) Who may read it is decided by `public_notes` alone (asserted against
 * real SQL in `supabase/tests/reviewed-rankings-group.test.mjs`); what only the client can
 * get wrong is asking for the right author and titles, putting each review under its own
 * title, and never rendering a masked one.
 */

const mockRpc = jest.fn();
jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  startSessionRefresh: () => () => {},
}));

let mockWatched: Set<string> | undefined = new Set();
jest.mock('@/features/collection/use-watched', () => ({
  ...jest.requireActual('@/features/collection/use-watched'),
  useWatched: () => ({ data: mockWatched }),
}));

beforeEach(() => {
  mockRpc.mockReset();
  mockWatched = new Set();
});

const titles = [
  {
    media_item_id: 'seven',
    title: 'Se7en',
    poster_path: null,
    position: 2,
    score: 9.1,
    bucket: 'loved',
    category: 'movies',
  },
  {
    media_item_id: 'invincible',
    title: 'Invincible',
    poster_path: null,
    position: 1,
    score: 9.6,
    bucket: 'loved',
    category: 'tv_shows',
  },
];

/** `ranking_batch_titles` answers the titles; `public_notes` answers `notes`. */
const answer = (notes: Record<string, unknown>[]) =>
  mockRpc.mockImplementation((name: string) =>
    Promise.resolve({ data: name === 'public_notes' ? notes : titles, error: null }),
  );

describe("the group's sheet", () => {
  it("shows the author's review under its own title, asking for that author and those titles", async () => {
    answer([
      {
        user_id: 'author',
        media_item_id: 'invincible',
        note: 'Brutal, funny, and better every episode.',
        has_spoilers: false,
      },
    ]);
    const view = await renderWithProviders(
      <RankingBatchSheet
        eventId="group-1"
        medium="movies"
        actorId="author"
        viewerId="reader"
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(view.getByText('Brutal, funny, and better every episode.')).toBeTruthy(),
    );
    expect(mockRpc).toHaveBeenCalledWith('public_notes', {
      p_user_ids: ['author'],
      p_media_item_ids: ['seven', 'invincible'],
      p_limit: 100,
    });
    expect(view.getAllByTestId('ranking-batch-review')).toHaveLength(1);
    // Under Invincible, not under the title before it: the review and its row share a parent.
    const block = view.getByTestId('ranking-batch-review').parent!;
    expect(within(block).getByText('Invincible')).toBeTruthy();
    expect(within(block).queryByText('Se7en')).toBeNull();
  });

  it('never renders a spoiler review for a reader who has not seen the title', async () => {
    answer([
      {
        user_id: 'author',
        media_item_id: 'invincible',
        note: 'Omni-Man did it.',
        has_spoilers: true,
      },
    ]);
    const view = await renderWithProviders(
      <RankingBatchSheet
        eventId="group-1"
        medium="movies"
        actorId="author"
        viewerId="reader"
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(
        view.getByLabelText('Contains spoilers for Invincible. Show the review.'),
      ).toBeTruthy(),
    );
    expect(view.queryByText('Omni-Man did it.')).toBeNull();
  });

  it('shows a spoiler review to a reader who has seen that exact title', async () => {
    mockWatched = new Set(['invincible']);
    answer([
      {
        user_id: 'author',
        media_item_id: 'invincible',
        note: 'Omni-Man did it.',
        has_spoilers: true,
      },
    ]);
    const view = await renderWithProviders(
      <RankingBatchSheet
        eventId="group-1"
        medium="movies"
        actorId="author"
        viewerId="reader"
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(view.getByText('Omni-Man did it.')).toBeTruthy());
  });

  it('asks for no reviews without an author, as before', async () => {
    answer([]);
    const view = await renderWithProviders(
      <RankingBatchSheet eventId="group-1" medium="movies" onClose={() => {}} />,
    );
    await waitFor(() => expect(view.getByText('Invincible')).toBeTruthy());
    expect(mockRpc).not.toHaveBeenCalledWith('public_notes', expect.anything());
    expect(view.queryByTestId('ranking-batch-review')).toBeNull();
  });

  it("takes only the group author's notes, whatever else comes back", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          user_id: 'someone-else',
          media_item_id: 'invincible',
          note: 'Not theirs.',
          has_spoilers: false,
        },
        { user_id: 'author', media_item_id: 'seven', note: 'Theirs.', has_spoilers: false },
      ],
      error: null,
    });
    const reviews = await batchReviews('author', ['seven', 'invincible']);
    expect([...reviews.keys()]).toEqual(['seven']);
    expect(reviews.get('seven')).toEqual({ text: 'Theirs.', hasSpoilers: false });
  });
});

/**
 * Removed by the founder (2026-11-22): reviews play no part in how a group is drawn. A
 * reviewed first ranking is a poster like any other in the rail, with no "Review" label;
 * its review is read in the group's sheet, above.
 */
describe('the rail', () => {
  it('draws no review label on any poster', async () => {
    const view = await render(
      <PosterRail
        label="Ada's 2 titles"
        tiles={[
          { id: 'invincible', title: 'Invincible', score: 9.6 },
          { id: 'seven', title: 'Se7en', score: 9.1 },
        ]}
        onPressTile={() => {}}
        width={360}
      />,
    );
    expect(
      view.queryByTestId('poster-review-badge', { includeHiddenElements: true }),
    ).toBeNull();
    expect(view.queryByText('Review')).toBeNull();
    for (const label of view
      .getAllByRole('button')
      .map((tile) => String(tile.props.accessibilityLabel))) {
      expect(label).not.toMatch(/review/i);
    }
  });
});
