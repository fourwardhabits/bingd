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
const mockSaveNote = jest.fn((_input: unknown) =>
  Promise.resolve({ outcome: 'ok', noteVersion: '2026-09-25T00:00:00Z' }),
);
jest.mock('@/features/collection/writes', () => ({
  removeFromCollection: (input: unknown) => mockRemove(input),
  saveNote: (input: unknown) => mockSaveNote(input),
  newOperationId: () => 'op-note',
}));

/**
 * Editing a watch writes the **title's** note (founder decision, 2026-09-25), so the log
 * state is what the editor reads. `private` with writing already in it is the case that
 * matters: no default may republish it.
 */
const mockLogState = jest.fn(() => ({
  data: {
    note: 'Still holds up.',
    noteVisibility: 'private' as const,
    noteSpoilers: false,
    noteVersion: '2026-09-24T00:00:00Z',
  },
}));
jest.mock('@/features/collection/use-log-state', () => ({
  useLogState: (...args: unknown[]) => mockLogState(...(args as [])),
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
  mockSaveNote.mockClear();
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

    // The note goes to `save_note` — the title's one note — not to the watch's own row.
    await waitFor(() => expect(mockSaveNote).toHaveBeenCalledTimes(1));
    expect(mockSaveNote).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaItemId: 'film-1',
        note: 'With popcorn.',
        noteVisibility: 'private',
        noteSpoilers: false,
      }),
    );
    // Nothing about the watch itself changed, so neither writer is called.
    expect(mockDetails).not.toHaveBeenCalled();
    // The date was not touched, so it is not rewritten, and nothing is re-ranked.
    expect(mockEdit).not.toHaveBeenCalled();
  });

  /**
   * The founder's item 11 (2026-09-25). The controls were missing here because this surface
   * had been built against `watch_events.note` — owner-only by schema, so there was nothing
   * for them to do. They are the log sheet's own, from `NoteComposer`.
   */
  it('offers both review claims when editing a watch', async () => {
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
    await fireEvent.press(view.getByLabelText(/^Note/));

    expect(view.getByLabelText('This note contains spoilers')).toBeTruthy();
    expect(view.getByLabelText('Share this note as a public review')).toBeTruthy();
  });

  it('opens a stored private note private, and never republishes it by default', async () => {
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
    await fireEvent.press(view.getByLabelText(/^Note/));

    expect(view.getByText('Only you can read this.')).toBeTruthy();
    // Opening the composer is not an act: nothing is written until the reader writes.
    expect(mockSaveNote).not.toHaveBeenCalled();
  });

  it('publishes only when the reader presses the chip', async () => {
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
    await fireEvent.press(view.getByLabelText(/^Note/));
    await fireEvent.press(view.getByLabelText('Share this note as a public review'));

    await waitFor(() => expect(mockSaveNote).toHaveBeenCalledTimes(1));
    expect(mockSaveNote).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'Still holds up.', noteVisibility: 'public' }),
    );
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
