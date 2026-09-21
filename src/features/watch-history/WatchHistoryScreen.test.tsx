import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Imported from `app/` by path, as TitleScreen.test.tsx does: a test file inside `app/`
// would be picked up by expo-router's require.context (app-directory.test.ts).
import WatchHistoryScreen from '../../../app/title/[id]/history';

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'film-1' }),
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

const mockEdit = jest.fn(() => Promise.resolve({ outcome: 'ok' }));
const mockDetails = jest.fn(() => Promise.resolve({ outcome: 'ok' }));
jest.mock('@/features/watch-history/writes', () => ({
  deleteWatchEvent: jest.fn(() => Promise.resolve({ outcome: 'ok' })),
  editWatchEvent: (input: unknown) => mockEdit(input),
  setWatchDetails: (input: unknown) => mockDetails(input),
  newOperationId: () => 'op-1',
}));

const event = (id: string, watchedOn: string, recordedAt: string) => ({
  id,
  watchedOn,
  basis: 'reader' as const,
  importRef: null,
  recordedAt,
});

const placement = (id: string, createdAt: string, position: number, watchEventId: string | null = null) => ({
  id,
  kind: 'initial',
  outcome: 'placed',
  position,
  categorySize: 11,
  fromPosition: null,
  score: 8,
  watchEventId,
  createdAt,
});

beforeEach(() => {
  mockEdit.mockClear();
  mockDetails.mockClear();
});

describe('Watch History — one row per viewing (founder QA, 2026-09-21)', () => {
  it('has no second logging flow and collapses the ledger to one placement per viewing', async () => {
    mockHistory.mockReturnValue({
      isPending: false,
      data: {
        count: 1,
        events: [event('w1', '2026-09-01', '2026-09-01T10:00:00Z')],
        details: new Map(),
        placements: [
          placement('p3', '2026-09-10T10:00:00Z', 4),
          placement('p2', '2026-09-05T10:00:00Z', 5),
          placement('p1', '2026-09-01T10:01:00Z', 8),
        ],
      },
    });
    const view = await renderWithProviders(<WatchHistoryScreen />);

    expect(view.queryByText('Add a past watch')).toBeNull();
    expect(view.queryByText('Log another watch')).toBeNull();
    expect(view.getByTestId('watch-date-w1').props.children).toMatch(/\(First watch\)$/);
    expect(view.getAllByText(/^#\d+ of \d+$/)).toHaveLength(1);
    expect(view.getByTestId('watch-placement-w1').props.children).toBe('#4 of 11');
    expect(view.queryByText(/Moved from/)).toBeNull();
    expect(view.queryByText(/Placed #/)).toBeNull();
  });

  it('draws each viewing with its own placement, companions and note', async () => {
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
        placements: [
          placement('again', '2026-09-20T10:02:00Z', 2, 'w2'),
          placement('first', '2026-09-01T10:01:00Z', 8),
        ],
      },
    });
    const view = await renderWithProviders(<WatchHistoryScreen />);

    expect(view.getByTestId('watch-placement-w1').props.children).toBe('#8 of 11');
    expect(view.getByTestId('watch-placement-w2').props.children).toBe('#2 of 11');
    expect(view.getByTestId('watch-with-w2').props.children).toBe('With Alex');
    expect(view.getByTestId('watch-note-w2').props.children).toBe('Better the second time.');
    expect(view.getByTestId('watch-date-w2').props.children).not.toMatch(/First watch/);
    expect(view.queryByTestId('watch-note-w1')).toBeNull();
  });

  it('edits a viewing from its pencil, writing only what changed', async () => {
    mockHistory.mockReturnValue({
      isPending: false,
      data: {
        count: 1,
        events: [event('w1', '2026-09-01', '2026-09-01T10:00:00Z')],
        details: new Map(),
        placements: [],
      },
    });
    const view = await renderWithProviders(<WatchHistoryScreen />);

    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    await fireEvent.changeText(view.getByLabelText('Note'), '  With popcorn.  ');
    await fireEvent.press(view.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockDetails).toHaveBeenCalledTimes(1));
    expect(mockDetails).toHaveBeenCalledWith(
      expect.objectContaining({ watchEventId: 'w1', note: 'With popcorn.', companionIds: [] }),
    );
    // The date was not touched, so it is not rewritten.
    expect(mockEdit).not.toHaveBeenCalled();
  });
});
