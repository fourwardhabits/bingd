import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Imported from `app/` by path, as TitleScreen.test.tsx does: a test file inside `app/`
// would be picked up by expo-router's require.context (app-directory.test.ts).
import WatchHistoryScreen from '../../../app/title/[id]/history';

const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'film-1' }),
  useRouter: () => ({ back: mockBack }),
}));

jest.mock('@/features/auth/session', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

jest.mock('@/lib/analytics', () => ({ track: jest.fn() }));

jest.mock('@/features/collection/use-companions', () => ({
  ...jest.requireActual('@/features/collection/use-companions'),
  useTaggablePeople: () => ({
    data: [{ id: 'friend-1', username: 'alex', name: 'Alex', avatarUri: null }],
    isPending: false,
  }),
}));

const mockHistory = jest.fn();
jest.mock('@/features/watch-history/use-watch-history', () => ({
  useWatchHistory: () => mockHistory(),
}));

const mockEdit = jest.fn((_input: unknown) => Promise.resolve({ outcome: 'ok' }));
const mockDetails = jest.fn((_input: unknown) => Promise.resolve({ outcome: 'ok' }));
const mockDelete = jest.fn((_input: unknown) => Promise.resolve({ outcome: 'ok' }));
jest.mock('@/features/watch-history/writes', () => ({
  deleteWatchEvent: (input: unknown) => mockDelete(input),
  editWatchEvent: (input: unknown) => mockEdit(input),
  setWatchDetails: (input: unknown) => mockDetails(input),
  newOperationId: () => 'op-1',
}));

const mockRemove = jest.fn(
  (_input: unknown): Promise<{ outcome: string; message?: string }> =>
    Promise.resolve({ outcome: 'ok' }),
);
jest.mock('@/features/collection/writes', () => ({
  removeFromCollection: (input: unknown) => mockRemove(input),
}));

const event = (id: string, watchedOn: string, recordedAt: string) => ({
  id,
  watchedOn,
  basis: 'reader' as const,
  importRef: null,
  recordedAt,
});

const placement = (
  id: string,
  createdAt: string,
  score: number,
  kind = 'first',
  watchEventId: string | null = null,
) => ({
  id,
  kind,
  outcome: 'placed',
  position: 4,
  categorySize: 11,
  fromPosition: null,
  score,
  bucket: 'loved',
  watchEventId,
  createdAt,
});

const post = (createdAt: string, score: number, watchEventId: string | null = null) => ({
  createdAt,
  score,
  bucket: 'loved',
  watchEventId,
});

beforeEach(() => {
  mockEdit.mockClear();
  mockDetails.mockClear();
});

describe('Watch History — a historical feed of this title (founder QA, 2026-09-21)', () => {
  it('shows each watch with the score it had then, never the current one or #X of Y', async () => {
    mockHistory.mockReturnValue({
      isPending: false,
      data: {
        count: 2,
        events: [
          event('w1', '2026-09-01', '2026-09-01T10:00:00Z'),
          event('w2', '2026-09-20', '2026-09-20T10:00:00Z'),
        ],
        details: new Map(),
        placements: [
          // A later pure rerank — the current score is 6.1 now.
          placement('fix', '2026-09-21T10:00:00Z', 6.1, 'correction'),
          placement('again', '2026-09-20T10:02:00Z', 8.3, 'rewatch', 'w2'),
          placement('first', '2026-09-01T10:01:00Z', 9.0),
        ],
        posts: [post('2026-09-01T10:01:00Z', 9.0), post('2026-09-20T10:00:01Z', 8.3, 'w2')],
      },
    });
    const view = await renderWithProviders(<WatchHistoryScreen />);

    expect(view.queryByText('Add a past watch')).toBeNull();
    expect(view.queryByText('Log another watch')).toBeNull();
    expect(view.getByTestId('watch-date-w1').props.children).toMatch(/\(First watch\)$/);
    expect(view.getByTestId('watch-date-w2').props.children).not.toMatch(/First watch/);
    expect(view.getByTestId('watch-score-w1')).toBeTruthy();
    expect(view.getByLabelText(/^9\.0 out of 10/)).toBeTruthy();
    expect(view.getByLabelText(/^8\.3 out of 10/)).toBeTruthy();
    expect(view.queryByLabelText(/^6\.1 out of 10/)).toBeNull();
    expect(view.queryByText(/^#\d+ of \d+$/)).toBeNull();
  });

  it('draws the companions and the note under the watch that has them', async () => {
    mockHistory.mockReturnValue({
      isPending: false,
      data: {
        count: 2,
        events: [
          event('w1', '2026-09-01', '2026-09-01T10:00:00Z'),
          event('w2', '2026-09-20', '2026-09-20T10:00:00Z'),
        ],
        details: new Map([
          [
            'w2',
            {
              note: 'Better the second time.',
              companions: [{ id: 'friend-1', username: 'alex', name: 'Alex', avatarUri: null }],
            },
          ],
        ]),
        placements: [],
        posts: [],
      },
    });
    const view = await renderWithProviders(<WatchHistoryScreen />);

    expect(view.getByTestId('watch-with-w2').props.children).toBe('With Alex');
    expect(view.getByTestId('watch-note-w2').props.children).toBe('Better the second time.');
    expect(view.queryByTestId('watch-note-w1')).toBeNull();
    // A title never ranked has no score to draw.
    expect(view.queryByTestId('watch-score-w1')).toBeNull();
  });

  it('edits a watch from its small Edit action, through the log sheet\'s own rows', async () => {
    mockHistory.mockReturnValue({
      isPending: false,
      data: {
        count: 1,
        events: [event('w1', '2026-09-01', '2026-09-01T10:00:00Z')],
        details: new Map(),
        placements: [],
        posts: [],
      },
    });
    const view = await renderWithProviders(<WatchHistoryScreen />);

    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    // The same rows as the log sheet, closed until opened.
    expect(view.getByLabelText(/Who I watched with/)).toBeTruthy();
    expect(view.getByLabelText(/Watch date/)).toBeTruthy();
    await fireEvent.press(view.getByLabelText(/^Note/));
    await fireEvent.changeText(view.getByPlaceholderText('What did you think?'), '  With popcorn.  ');
    await fireEvent.press(view.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockDetails).toHaveBeenCalledTimes(1));
    expect(mockDetails).toHaveBeenCalledWith(
      expect.objectContaining({ watchEventId: 'w1', note: 'With popcorn.', companionIds: [] }),
    );
    // The date was not touched, so it is not rewritten, and nothing is re-ranked.
    expect(mockEdit).not.toHaveBeenCalled();
  });
});

/**
 * **The last watch is the title leaving** (founder, device QA, 2026-09-25).
 *
 * The control said *Remove from collection…* and pressing it produced a sentence asking
 * the reader to remove the title from their collection — which is what they had just
 * pressed. `delete_watch_event` refuses the only watch by design (`P0001 last_watch`,
 * §D.0: a title in the collection has at least one), and the screen turned that refusal
 * into advice instead of into the act.
 */
describe('removing a watch', () => {
  beforeEach(() => {
    mockRemove.mockClear();
    mockDelete.mockClear();
    mockBack.mockClear();
  });

  const oneWatch = {
    isPending: false,
    data: {
      count: 1,
      events: [event('w1', '2026-09-01', '2026-09-01T10:00:00Z')],
      details: new Map(),
      placements: [],
      posts: [],
    },
  };

  it('the only watch removes the title, and leaves for the title page', async () => {
    mockHistory.mockReturnValue(oneWatch);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));

    // No ellipsis: this is the act, not a doorway to somewhere that performs it.
    expect(view.getByText('Remove from collection')).toBeTruthy();
    await fireEvent.press(view.getByTestId('watch-remove-w1'));

    await waitFor(() => expect(mockRemove).toHaveBeenCalledTimes(1));
    expect(mockRemove).toHaveBeenCalledWith(
      expect.objectContaining({ mediaItemId: 'film-1', wasRanked: false }),
    );
    // Never the per-watch delete, which is the call the server would refuse.
    expect(mockDelete).not.toHaveBeenCalled();
    // And it does not stay on a list of watches for a title that is gone.
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
  });

  it('unranks first when the title was ranked', async () => {
    // `unlog` refuses a ranked title, so the canonical writer clears the ranking first.
    // The screen's job is only to tell it which case this is.
    mockHistory.mockReturnValue({
      ...oneWatch,
      data: {
        ...oneWatch.data,
        placements: [placement('p1', '2026-09-01T10:00:00Z', 8.2)],
      },
    });
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));

    await fireEvent.press(view.getByTestId('watch-remove-w1'));

    await waitFor(() => expect(mockRemove).toHaveBeenCalledTimes(1));
    expect(mockRemove).toHaveBeenCalledWith(expect.objectContaining({ wasRanked: true }));
  });

  it('one of several watches is still just that watch', async () => {
    mockHistory.mockReturnValue({
      isPending: false,
      data: {
        count: 2,
        events: [
          event('w1', '2026-09-01', '2026-09-01T10:00:00Z'),
          event('w2', '2026-08-01', '2026-08-01T10:00:00Z'),
        ],
        details: new Map(),
        placements: [],
        posts: [],
      },
    });
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));

    expect(view.getByText('Remove this watch')).toBeTruthy();
    await fireEvent.press(view.getByTestId('watch-remove-w1'));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(1));
    // The title keeps its place: removing one watch of several is not removing the title.
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('stays put and says why when the removal fails', async () => {
    mockRemove.mockResolvedValueOnce({ outcome: 'failed', message: 'No connection.' });
    mockHistory.mockReturnValue(oneWatch);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));

    await fireEvent.press(view.getByTestId('watch-remove-w1'));

    await waitFor(() => expect(view.getByText('No connection.')).toBeTruthy());
    expect(mockBack).not.toHaveBeenCalled();
  });
});
