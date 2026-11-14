import { Ionicons } from '@expo/vector-icons';
import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { Alert, StyleSheet, type AlertButton } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

// Imported from `app/` by path, as TitleScreen.test.tsx does: a test file inside `app/`
// would be picked up by expo-router's require.context (app-directory.test.ts).
import WatchHistoryScreen from '../../../app/title/[id]/history';

const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockPush = jest.fn();
let mockCanGoBack = true;
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'film-1' }),
  useRouter: () => ({
    back: mockBack,
    replace: mockReplace,
    push: mockPush,
    canGoBack: () => mockCanGoBack,
  }),
  // The route's stack options are recorded so a test can read the title and whether the
  // stack's own header is drawn.
  Stack: {
    Screen: ({ options }: { options?: { title?: string; headerShown?: boolean } }) => {
      mockHeader.title = options?.title;
      mockHeader.headerShown = options?.headerShown;
      return null;
    },
  },
}));
const mockHeader: { title?: string; headerShown?: boolean } = {};

/**
 * The rating and comparison sheets are the title page's own, and their behaviour is theirs
 * (`LogSheet.test.tsx`, `RankingSheet`'s suites). What this screen owns is *which* title it
 * hands them and what it does with their callbacks, so they are recorded rather than drawn.
 */
type SheetProps = Record<string, unknown> & { title?: unknown; subject?: unknown };
const mockLogSheet: { props: SheetProps | null } = { props: null };
const mockRankingSheet: { props: SheetProps | null } = { props: null };
jest.mock('@/features/collection/LogSheet', () => ({
  LogSheet: (props: SheetProps) => {
    mockLogSheet.props = props;
    return null;
  },
}));
jest.mock('@/features/ranking/RankingSheet', () => ({
  RankingSheet: (props: SheetProps) => {
    mockRankingSheet.props = props;
    return null;
  },
}));
const mockCelebrate = jest.fn();
jest.mock('@/features/awards/celebration-queue', () => ({
  useCelebrationHandoff: () => mockCelebrate,
}));
const FILM = { id: 'film-1', title: 'Heat', year: 1995, posterUri: null, kind: 'movie' as const };
const mockHistoryTitle = jest.fn(() => ({ data: FILM as typeof FILM | null }));
jest.mock('@/features/watch-history/use-history-title', () => ({
  useHistoryTitle: () => mockHistoryTitle(),
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
    ranked: false,
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
    // The date alone on every row, the earliest included (founder QA, 2026-11-12).
    expect(view.getByTestId('watch-date-w1').props.children).not.toMatch(/First watch/);
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

  it('never lets the remembered habit republish a stored private note', async () => {
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

  it('removing the only watch from a page opened cold opens the title page', async () => {
    mockCanGoBack = false;
    mockReplace.mockClear();
    mockHistory.mockReturnValue(oneWatch);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    await fireEvent.press(view.getByTestId('watch-remove-w1'));

    await waitFor(() => expect(mockRemove).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/title/film-1'));
    expect(mockBack).not.toHaveBeenCalled();
    mockCanGoBack = true;
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

/**
 * **A pushed page like the others** (founder, marquee cohesion sprint, 2026-11-07): the
 * stack's header with a title, a span line for two or more dated watches, and each row's
 * score and Edit on its right, Edit a full 44pt target.
 */
describe('the page', () => {
  const two = () =>
    mockHistory.mockReturnValue({
      isPending: false,
      data: {
        count: 2,
        events: [
          event('w1', '2024-03-04', '2024-03-04T10:00:00Z'),
          event('w2', '2026-10-12', '2026-10-12T10:00:00Z'),
        ],
        details: new Map(),
        placements: [placement('first', '2024-03-04T10:01:00Z', 9.0)],
        posts: [post('2024-03-04T10:01:00Z', 9.0)],
      },
    });

  it('has the bingd. header with Back, WATCH HISTORY once, and a span for two dated watches', async () => {
    two();
    const view = await renderWithProviders(<WatchHistoryScreen />);
    // The stack's own header is off, so its status-bar inset is not applied a second time
    // under `Screen`'s; the route keeps its title as the back label of anything above it.
    expect(mockHeader.headerShown).toBe(false);
    expect(mockHeader.title).toBe('Watch history');
    expect(view.getAllByTestId('app-header')).toHaveLength(1);
    expect(view.getByRole('button', { name: 'Back' })).toBeTruthy();
    expect(view.getAllByText('WATCH HISTORY')).toHaveLength(1);
    expect(view.getByTestId('watch-history-summary').props.children).toBe('Watched 2 times');
    expect(view.getByTestId('watch-history-span').props.children).toMatch(/^First .* · Latest /);
  });

  /**
   * **The span only when it says something** (founder QA, 2026-11-12): one dated watch, or
   * dated watches all on one day, would print the same date as both First and Latest.
   */
  type Row = Omit<ReturnType<typeof event>, 'watchedOn' | 'basis'> & {
    watchedOn: string | null;
    basis: 'reader' | 'none';
  };
  const history = (events: Row[]) =>
    mockHistory.mockReturnValue({
      isPending: false,
      data: { count: events.length, events, details: new Map(), placements: [], posts: [] },
    });
  const undated = (id: string, recordedAt: string) => ({
    ...event(id, '2000-01-01', recordedAt),
    watchedOn: null,
    basis: 'none' as const,
  });

  it('has no span for two watches on the same day', async () => {
    history([
      event('w1', '2026-10-12', '2026-10-12T10:00:00Z'),
      event('w2', '2026-10-12', '2026-10-12T22:00:00Z'),
    ]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    expect(view.getByTestId('watch-history-summary').props.children).toBe('Watched 2 times');
    expect(view.queryByTestId('watch-history-span')).toBeNull();
  });

  it('has no span for one dated watch beside an undated one', async () => {
    history([
      undated('w0', '2025-01-01T10:00:00Z'),
      event('w1', '2026-10-12', '2026-10-12T10:00:00Z'),
    ]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    expect(view.getByTestId('watch-history-summary').props.children).toBe('Watched 2 times');
    expect(view.queryByTestId('watch-history-span')).toBeNull();
  });

  it('keeps the span for two dated watches on different days, earliest first', async () => {
    history([
      event('w1', '2024-03-04', '2024-03-04T10:00:00Z'),
      event('w2', '2024-03-04', '2024-03-04T12:00:00Z'),
      event('w3', '2025-06-01', '2025-06-01T10:00:00Z'),
      undated('w0', '2023-01-01T10:00:00Z'),
    ]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    expect(view.getByTestId('watch-history-span').props.children).toBe(
      'First Mar 4, 2024 · Latest Jun 1, 2025',
    );
  });

  it('keeps the order, and the undated import in Earlier, with no First watch label', async () => {
    history([
      undated('w0', '2023-01-01T10:00:00Z'),
      event('w1', '2024-03-04', '2024-03-04T10:00:00Z'),
      event('w2', '2025-06-01', '2025-06-01T10:00:00Z'),
    ]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    // Newest first, the undated viewing last under Earlier — unchanged.
    const rows = view
      .getAllByTestId(/^watch-row-/)
      .map((node) => String(node.props.testID).replace('watch-row-', ''));
    expect(rows).toEqual(['w2', 'w1', 'w0']);
    expect(view.getByTestId('watch-date-w0').props.children).toBe('Earlier');
    expect(view.getByTestId('watch-date-w1').props.children).toBe('Mar 4, 2024');
    expect(view.queryByText(/First watch/)).toBeNull();
  });

  it('adds no padding of its own above the summary, under the label’s 44pt row', async () => {
    two();
    const view = await renderWithProviders(<WatchHistoryScreen />);
    const block = StyleSheet.flatten(view.getByTestId('watch-history-summary-block').props.style);
    expect(block.paddingTop ?? 0).toBe(0);
    expect(block.marginTop ?? 0).toBe(0);
  });

  it('makes Edit a full 44pt target', async () => {
    two();
    const view = await renderWithProviders(<WatchHistoryScreen />);
    const edit = view.getByTestId('watch-edit-w1');
    const style = StyleSheet.flatten(
      typeof edit.props.style === 'function' ? edit.props.style({ pressed: false }) : edit.props.style,
    );
    expect(style.minHeight).toBe(44);
    expect(style.minWidth).toBe(44);
  });

  it('says so when there is no watch left to show', async () => {
    mockHistory.mockReturnValue({
      isPending: false,
      data: { count: 0, events: [], details: new Map(), placements: [], posts: [] },
    });
    const view = await renderWithProviders(<WatchHistoryScreen />);
    expect(view.getByText('No watches recorded')).toBeTruthy();
    expect(mockHeader.title).toBe('Watch history');
    expect(view.getByTestId('app-header')).toBeTruthy();
  });

  it('loads under its own header, not behind a second brand splash', async () => {
    mockHistory.mockReturnValue({ isPending: true, data: undefined });
    const view = await renderWithProviders(<WatchHistoryScreen />);
    expect(view.getByTestId('app-header')).toBeTruthy();
    expect(view.getByLabelText('Loading your watch history')).toBeTruthy();
    expect(mockHeader.headerShown).toBe(false);
  });
});

describe('Back', () => {
  beforeEach(() => {
    mockBack.mockClear();
    mockReplace.mockClear();
  });

  it('goes back to the title page behind it', async () => {
    mockCanGoBack = true;
    mockHistory.mockReturnValue({
      isPending: false,
      data: { count: 0, events: [], details: new Map(), placements: [], posts: [] },
    });
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByRole('button', { name: 'Back' }));
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('opens the title page when there is nothing behind it', async () => {
    mockCanGoBack = false;
    mockHistory.mockReturnValue({
      isPending: false,
      data: { count: 0, events: [], details: new Map(), placements: [], posts: [] },
    });
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByRole('button', { name: 'Back' }));
    expect(mockReplace).toHaveBeenCalledWith('/title/film-1');
    expect(mockBack).not.toHaveBeenCalled();
    mockCanGoBack = true;
  });
});

/**
 * **The collapsed row** (founder, UI consistency sprint, 2026-11-10): the date — alone, with
 * no *(First watch)* since 2026-11-12 — and Edit directly under it on the left; the score at
 * the watch on the right, alone in its column so Edit cannot push it down.
 */
describe('a collapsed row', () => {
  const two = () =>
    mockHistory.mockReturnValue({
      isPending: false,
      data: {
        count: 2,
        events: [
          event('w1', '2024-03-04', '2024-03-04T10:00:00Z'),
          event('w2', '2026-10-12', '2026-10-12T10:00:00Z'),
        ],
        details: new Map([
          ['w2', { note: 'Better the second time.', companions: [{ id: 'friend-1', username: 'alex', name: 'Alex', avatarUri: null }] }],
        ]),
        placements: [placement('first', '2024-03-04T10:01:00Z', 9.0)],
        posts: [post('2024-03-04T10:01:00Z', 9.0), post('2026-10-12T10:01:00Z', 8.3, 'w2')],
      },
    });

  it('puts Edit directly under the date, and the score alone on the right', async () => {
    two();
    const view = await renderWithProviders(<WatchHistoryScreen />);
    const main = view.getByTestId('watch-main-w1');
    const [lead, right] = main.children as unknown as { props: { testID?: string } }[];
    // The date's column: the date, then Edit — nothing between them.
    const leadView = view.getByTestId('watch-date-w1').parent!;
    const order = (leadView.children as unknown as { props: { testID?: string } }[]).map(
      (child) => child.props.testID,
    );
    expect(order).toEqual(['watch-date-w1', 'watch-edit-w1']);
    expect(lead).toBeTruthy();
    // The score is the right column, and Edit is not in it.
    expect(right?.props.testID).toBe('watch-score-w1');
    // No *(First watch)* suffix on the earliest dated watch (founder QA, 2026-11-12).
    expect(view.getByTestId('watch-date-w1').props.children).toBe('Mar 4, 2024');
  });

  it('keeps the score level with the date, whether Edit or the editor is showing', async () => {
    two();
    const view = await renderWithProviders(<WatchHistoryScreen />);
    const main = () => StyleSheet.flatten(view.getByTestId('watch-main-w1').props.style);
    // Top-aligned, so neither Edit's 44pt target below the date nor its removal while
    // editing can move the circle (independent review).
    expect(main().alignItems).toBe('flex-start');
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    expect(main().alignItems).toBe('flex-start');
    expect(view.getByTestId('watch-score-w1')).toBeTruthy();
  });

  it('keeps the companions and the note under the row, never between the date and Edit', async () => {
    two();
    const view = await renderWithProviders(<WatchHistoryScreen />);
    expect(view.getByTestId('watch-with-w2').props.children).toBe('With Alex');
    expect(view.getByTestId('watch-note-w2').props.children).toBe('Better the second time.');
    const leadView = view.getByTestId('watch-date-w2').parent!;
    expect(leadView.children).toHaveLength(2);
  });

  it('expands the watch whose Edit was pressed, and only that one', async () => {
    two();
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    expect(view.getByTestId('watch-editor-w1')).toBeTruthy();
    expect(view.queryByTestId('watch-editor-w2')).toBeNull();
    // The other row keeps its Edit; the open one gives way to Cancel and Save.
    expect(view.getByTestId('watch-edit-w2')).toBeTruthy();
    expect(view.queryByTestId('watch-edit-w1')).toBeNull();
    expect(view.getByText('Who I watched with')).toBeTruthy();
    expect(view.getByText('Note')).toBeTruthy();
    expect(view.getByText('Watch date')).toBeTruthy();
    expect(view.getByText('Cancel')).toBeTruthy();
    expect(view.getByText('Save')).toBeTruthy();
  });

  it('draws the editor full width without pulling it out with a negative margin', async () => {
    two();
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    const editor = StyleSheet.flatten(view.getByTestId('watch-editor-w1').props.style);
    expect(editor.marginHorizontal ?? 0).toBe(0);
    expect(editor.marginLeft ?? 0).toBe(0);
  });

  it('newest first, with each watch keeping the score it had then', async () => {
    two();
    const view = await renderWithProviders(<WatchHistoryScreen />);
    const rows = view.getAllByTestId(/^watch-row-/).map((row) => row.props.testID);
    expect(rows).toEqual(['watch-row-w2', 'watch-row-w1']);
    expect(view.getByTestId('watch-score-w1')).toBeTruthy();
    expect(view.getByLabelText(/^9\.0 out of 10/)).toBeTruthy();
    expect(view.getByLabelText(/^8\.3 out of 10/)).toBeTruthy();
  });
});

/**
 * **Edit ranking** (founder, UI consistency sprint, 2026-11-10): the title's existing
 * correction flow, opened from a watch's editor. Three acts, kept three: Log another watch
 * is a new viewing (the title page's), Edit is this viewing's details, and Edit ranking is
 * the current ranking. This one creates no watch, edits none and removes none.
 */
describe('Edit ranking', () => {
  const ranked = (extra: Partial<{ placements: unknown[]; posts: unknown[] }> = {}) => {
    mockLogState.mockReturnValue({
      data: {
        note: 'Still holds up.',
        noteVisibility: 'private' as const,
        noteSpoilers: false,
        noteVersion: '2026-09-24T00:00:00Z',
        ranked: true,
      },
    });
    mockHistory.mockReturnValue({
      isPending: false,
      data: {
        count: 2,
        events: [
          event('w1', '2024-03-04', '2024-03-04T10:00:00Z'),
          event('w2', '2026-10-12', '2026-10-12T10:00:00Z'),
        ],
        details: new Map(),
        placements: [placement('first', '2024-03-04T10:01:00Z', 9.0), ...(extra.placements ?? [])],
        posts: [post('2024-03-04T10:01:00Z', 9.0), post('2026-10-12T10:01:00Z', 8.3, 'w2'), ...(extra.posts ?? [])],
      },
    });
  };

  const noWatchWrites = () => {
    expect(mockEdit).not.toHaveBeenCalled();
    expect(mockDetails).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    mockLogSheet.props = null;
    mockRankingSheet.props = null;
    mockDelete.mockClear();
    mockRemove.mockClear();
    mockCelebrate.mockClear();
    mockHistoryTitle.mockReturnValue({ data: FILM });
  });

  afterEach(() => {
    mockLogState.mockReturnValue({
      data: {
        note: 'Still holds up.',
        noteVisibility: 'private' as const,
        noteSpoilers: false,
        noteVersion: '2026-09-24T00:00:00Z',
        ranked: false,
      },
    });
  });

  it('is offered in the editor beside Remove, only for a ranked title', async () => {
    ranked();
    const view = await renderWithProviders(<WatchHistoryScreen />);
    // Not on the collapsed row: it is an act of the editor.
    expect(view.queryByText('Edit ranking')).toBeNull();
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    expect(view.getByTestId('watch-edit-ranking-w1')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Edit ranking' })).toBeTruthy();
    expect(view.getByText('Remove this watch')).toBeTruthy();
  });

  // The Watch History editor is held for the founder (2026-11-14): its Edit ranking icon stays
  // swap-vertical-outline in this release; the star-outline swap from 6bab0a6 is reverted.
  it('keeps the held editor’s Edit ranking icon, swap-vertical-outline', async () => {
    ranked();
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    // The jest renderer prints an Ionicons glyph rather than its name.
    const glyph = (name: 'star-outline' | 'swap-vertical-outline') =>
      String.fromCodePoint(Ionicons.glyphMap[name] as number);
    const row = within(view.getByTestId('watch-edit-ranking-w1'));
    expect(row.getByText(glyph('swap-vertical-outline'))).toBeTruthy();
    expect(row.queryByText(glyph('star-outline'))).toBeNull();
  });

  it('is not offered when the title has no ranking to correct', async () => {
    ranked();
    mockLogState.mockReturnValue({
      data: {
        note: '',
        noteVisibility: 'private' as const,
        noteSpoilers: false,
        noteVersion: '2026-09-24T00:00:00Z',
        ranked: false,
      },
    });
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    expect(view.queryByText('Edit ranking')).toBeNull();
    expect(view.getByText('Remove this watch')).toBeTruthy();
  });

  it('opens the title’s rating sheet, closes the editor, and writes nothing', async () => {
    ranked();
    const view = await renderWithProviders(<WatchHistoryScreen />);
    expect(mockLogSheet.props?.title).toBeNull();
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    await fireEvent.press(view.getByRole('button', { name: 'Edit ranking' }));

    await waitFor(() => expect(mockLogSheet.props?.title).toEqual(FILM));
    // The existing sheet, told it is on Watch History so it does not offer a push to it.
    expect(mockLogSheet.props?.inWatchHistory).toBe(true);
    expect(mockLogSheet.props?.postRank).toBeNull();
    expect(view.queryByTestId('watch-editor-w1')).toBeNull();
    noWatchWrites();
  });

  it('hands a band choice to the existing comparisons as a correction, not a viewing', async () => {
    ranked();
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    await fireEvent.press(view.getByRole('button', { name: 'Edit ranking' }));
    await waitFor(() => expect(mockLogSheet.props?.title).toEqual(FILM));

    // The sheet decides the mode — `rerank` for the same band, `rebucket` for a new one —
    // exactly as on the title page; this screen passes it through untouched.
    await act(async () => {
      (mockLogSheet.props!.onRank as (bucket: string, mode: string) => void)('loved', 'rerank');
    });
    expect(mockRankingSheet.props?.subject).toEqual(
      expect.objectContaining({ id: 'film-1', bucket: 'loved', mode: 'rerank' }),
    );
    // Never `again`, which is Log another watch's mode, and never tied to a viewing.
    expect(mockRankingSheet.props?.subject).not.toHaveProperty('watchEventId');
    expect(mockLogSheet.props?.title).toBeNull();
    noWatchWrites();
  });

  it('leaves the history exactly as it was when the comparisons are closed', async () => {
    ranked();
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    await fireEvent.press(view.getByRole('button', { name: 'Edit ranking' }));
    await waitFor(() => expect(mockLogSheet.props?.title).toEqual(FILM));
    await act(async () => {
      (mockLogSheet.props!.onRank as (bucket: string, mode: string) => void)('fine', 'rebucket');
    });
    await act(async () => {
      (mockRankingSheet.props!.onClose as () => void)();
    });

    expect(mockRankingSheet.props?.subject).toBeNull();
    expect(mockLogSheet.props?.title).toBeNull();
    noWatchWrites();
    expect(view.getByTestId('watch-history-summary').props.children).toBe('Watched 2 times');
    expect(view.getAllByTestId(/^watch-row-/)).toHaveLength(2);
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('returns to the rating sheet with the new score once a placement completes', async () => {
    ranked();
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    await fireEvent.press(view.getByRole('button', { name: 'Edit ranking' }));
    await waitFor(() => expect(mockLogSheet.props?.title).toEqual(FILM));
    await act(async () => {
      (mockLogSheet.props!.onRank as (bucket: string, mode: string) => void)('loved', 'rerank');
    });
    const result = { score: 7.1, position: 6, category: 'movies' };
    await act(async () => {
      (mockRankingSheet.props!.onFinishLog as (r: typeof result) => void)(result);
    });
    expect(mockLogSheet.props?.title).toEqual(FILM);
    expect(mockLogSheet.props?.postRank).toEqual(result);

    await act(async () => {
      (mockLogSheet.props!.onDone as () => void)();
    });
    expect(mockLogSheet.props?.title).toBeNull();
    expect(mockCelebrate).toHaveBeenCalledTimes(1);
    noWatchWrites();
  });

  /**
   * **A correction never rewrites an earlier watch's score** (`scoresByWatch`, founder
   * delta QA, 2026-09-21). The ledger after a pure rerank gains a placement and no watch;
   * the first watch keeps the number it had then, and so does a later watch with its own
   * post.
   */
  it('keeps every watch’s historical score after a correction lands', async () => {
    ranked({ placements: [placement('fix', '2026-11-10T09:00:00Z', 6.4, 'rerank')] });
    const view = await renderWithProviders(<WatchHistoryScreen />);
    expect(view.getByLabelText(/^9\.0 out of 10/)).toBeTruthy();
    expect(view.getByLabelText(/^8\.3 out of 10/)).toBeTruthy();
    expect(view.queryByLabelText(/^6\.4 out of 10/)).toBeNull();
    expect(view.getAllByTestId(/^watch-row-/)).toHaveLength(2);
  });
});

/**
 * **Edit ranking with unsaved watch edits** (stabilization pass, 2026-11-11). It used to
 * close the editor and drop a changed date or companions without a word. Now, with
 * something pending, it asks Save / Discard / Cancel in the app's native confirm; with
 * nothing pending it opens the ranking exactly as before.
 */
describe('Edit ranking with unsaved watch edits', () => {
  let alert: jest.SpyInstance;
  /** The buttons of the last confirm, so a test can press one as a person would. */
  const confirm = () => {
    const call = alert.mock.calls.at(-1) as [string, string | undefined, AlertButton[]];
    return {
      title: call[0],
      press: async (text: string) => {
        const button = call[2].find((b) => b.text === text);
        if (!button) throw new Error(`No "${text}" button in ${call[2].map((b) => b.text)}`);
        await act(async () => {
          button.onPress?.();
        });
      },
      texts: call[2].map((b) => b.text),
    };
  };

  const setUp = () => {
    mockLogState.mockReturnValue({
      data: {
        note: 'Still holds up.',
        noteVisibility: 'private' as const,
        noteSpoilers: false,
        noteVersion: '2026-09-24T00:00:00Z',
        ranked: true,
      },
    });
    mockHistory.mockReturnValue({
      isPending: false,
      data: {
        count: 2,
        events: [
          event('w1', '2024-03-04', '2024-03-04T10:00:00Z'),
          event('w2', '2026-10-12', '2026-10-12T10:00:00Z'),
        ],
        details: new Map(),
        placements: [placement('first', '2024-03-04T10:01:00Z', 9.0)],
        posts: [post('2024-03-04T10:01:00Z', 9.0), post('2026-10-12T10:01:00Z', 8.3, 'w2')],
      },
    });
  };

  /** Opens w1's editor and changes the date (to Earlier) and the companions (adds Alex). */
  const editW1 = async () => {
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    await fireEvent.press(view.getByLabelText(/^Watch date/));
    await fireEvent.press(view.getByText('Earlier'));
    await fireEvent.press(view.getByLabelText(/^Who I watched with/));
    await fireEvent.press(view.getByRole('checkbox', { name: 'Alex' }));
    return view;
  };

  const pressEditRanking = async (view: Awaited<ReturnType<typeof renderWithProviders>>) => {
    await fireEvent.press(view.getByRole('button', { name: 'Edit ranking' }));
  };

  beforeEach(() => {
    setUp();
    mockLogSheet.props = null;
    mockRankingSheet.props = null;
    mockDelete.mockClear();
    mockRemove.mockClear();
    mockHistoryTitle.mockReturnValue({ data: FILM });
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    alert.mockRestore();
    // `mockReset` also empties any unused `mockImplementationOnce`, so a test that failed
    // before its write ran cannot leave a failing or deferred write for the next one.
    mockEdit.mockReset();
    mockEdit.mockImplementation((_input: unknown) => Promise.resolve({ outcome: 'ok' }));
    mockDetails.mockReset();
    mockDetails.mockImplementation((_input: unknown) => Promise.resolve({ outcome: 'ok' }));
    mockLogState.mockReturnValue({
      data: {
        note: 'Still holds up.',
        noteVisibility: 'private' as const,
        noteSpoilers: false,
        noteVersion: '2026-09-24T00:00:00Z',
        ranked: false,
      },
    });
  });

  it('with nothing pending, opens the ranking straight away and asks nothing', async () => {
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    await pressEditRanking(view);

    await waitFor(() => expect(mockLogSheet.props?.title).toEqual(FILM));
    expect(alert).not.toHaveBeenCalled();
    expect(view.queryByTestId('watch-editor-w1')).toBeNull();
    expect(mockEdit).not.toHaveBeenCalled();
    expect(mockDetails).not.toHaveBeenCalled();
  });

  it('with a changed date or companions, asks Save, Discard or Cancel before moving', async () => {
    const view = await editW1();
    await pressEditRanking(view);

    expect(alert).toHaveBeenCalledTimes(1);
    expect(confirm().title).toBe('Save changes to this watch?');
    expect(confirm().texts).toEqual(['Cancel', 'Discard', 'Save']);
    // Nothing has moved and nothing is written until the reader chooses.
    expect(mockLogSheet.props?.title).toBeNull();
    expect(view.getByTestId('watch-editor-w1')).toBeTruthy();
    expect(mockEdit).not.toHaveBeenCalled();
    expect(mockDetails).not.toHaveBeenCalled();
  });

  it('asks for a changed date alone', async () => {
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    await fireEvent.press(view.getByLabelText(/^Watch date/));
    await fireEvent.press(view.getByText('Earlier'));
    await pressEditRanking(view);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('asks for changed companions alone', async () => {
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    await fireEvent.press(view.getByLabelText(/^Who I watched with/));
    await fireEvent.press(view.getByRole('checkbox', { name: 'Alex' }));
    await pressEditRanking(view);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('Save writes the watch, then opens the ranking once the write has landed', async () => {
    let land!: (value: { outcome: string }) => void;
    mockDetails.mockImplementationOnce(
      () => new Promise<{ outcome: string }>((resolve) => (land = resolve)),
    );
    const view = await editW1();
    await pressEditRanking(view);
    await confirm().press('Save');

    expect(mockEdit).toHaveBeenCalledWith(
      expect.objectContaining({ watchEventId: 'w1', watchedOn: null, basis: 'none' }),
    );
    await waitFor(() =>
      expect(mockDetails).toHaveBeenCalledWith(
        expect.objectContaining({ watchEventId: 'w1', companionIds: ['friend-1'] }),
      ),
    );
    // The companions write is still in flight: the ranking has not opened over it.
    expect(mockLogSheet.props?.title).toBeNull();
    expect(view.getByTestId('watch-editor-w1')).toBeTruthy();

    await act(async () => {
      land({ outcome: 'ok' });
    });
    await waitFor(() => expect(mockLogSheet.props?.title).toEqual(FILM));
    expect(view.queryByTestId('watch-editor-w1')).toBeNull();
    expect(view.queryByTestId('watch-history-error')).toBeNull();
    // Each written once: Save is not repeated by the ranking opening.
    expect(mockEdit).toHaveBeenCalledTimes(1);
    expect(mockDetails).toHaveBeenCalledTimes(1);
  });

  it('a failed Save stays in the editor, edits intact, says why, and does not open the ranking', async () => {
    mockDetails.mockImplementationOnce(() =>
      Promise.resolve({ outcome: 'failed', message: 'Could not save this watch.' }),
    );
    const view = await editW1();
    await pressEditRanking(view);
    await confirm().press('Save');

    await waitFor(() =>
      expect(view.getByTestId('watch-history-error').props.children).toBe(
        'Could not save this watch.',
      ),
    );
    expect(mockLogSheet.props?.title).toBeNull();
    expect(mockRankingSheet.props?.subject ?? null).toBeNull();
    expect(view.getByTestId('watch-editor-w1')).toBeTruthy();
    // The edits are still there: the companion still ticked, the date still Earlier.
    expect(view.getByRole('checkbox', { name: 'Alex' }).props.accessibilityState).toEqual(
      expect.objectContaining({ checked: true }),
    );
    await fireEvent.press(view.getByLabelText(/^Watch date/));
    expect(view.getByRole('button', { name: 'Earlier', selected: true })).toBeTruthy();

    // And asking again still asks, because the companions are still unsaved.
    alert.mockClear();
    await pressEditRanking(view);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('Discard drops the edits, writes nothing, and opens the ranking', async () => {
    const view = await editW1();
    await pressEditRanking(view);
    await confirm().press('Discard');

    await waitFor(() => expect(mockLogSheet.props?.title).toEqual(FILM));
    expect(view.queryByTestId('watch-editor-w1')).toBeNull();
    expect(mockEdit).not.toHaveBeenCalled();
    expect(mockDetails).not.toHaveBeenCalled();

    // Reopening the watch shows it as it was: the discarded edits are gone.
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    await fireEvent.press(view.getByLabelText(/^Who I watched with/));
    expect(view.getByRole('checkbox', { name: 'Alex' }).props.accessibilityState).toEqual(
      expect.objectContaining({ checked: false }),
    );
  });

  it('Cancel stays in the editor with the edits, writes nothing, and opens nothing', async () => {
    const view = await editW1();
    await pressEditRanking(view);
    await confirm().press('Cancel');

    expect(mockLogSheet.props?.title).toBeNull();
    expect(mockRankingSheet.props?.subject ?? null).toBeNull();
    expect(view.getByTestId('watch-editor-w1')).toBeTruthy();
    expect(view.getByRole('checkbox', { name: 'Alex' }).props.accessibilityState).toEqual(
      expect.objectContaining({ checked: true }),
    );
    expect(mockEdit).not.toHaveBeenCalled();
    expect(mockDetails).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('after Save, the ranking is still a correction: rerank passes through, never a rewatch', async () => {
    const view = await editW1();
    await pressEditRanking(view);
    await confirm().press('Save');
    await waitFor(() => expect(mockLogSheet.props?.title).toEqual(FILM));
    expect(mockLogSheet.props?.inWatchHistory).toBe(true);
    expect(mockLogSheet.props?.postRank).toBeNull();

    await act(async () => {
      (mockLogSheet.props!.onRank as (bucket: string, mode: string) => void)('loved', 'rerank');
    });
    expect(mockRankingSheet.props?.subject).toEqual(
      expect.objectContaining({ id: 'film-1', bucket: 'loved', mode: 'rerank' }),
    );
    expect(mockRankingSheet.props?.subject).not.toHaveProperty('watchEventId');
    // The only watch writes are the reader's own Save — the ranking adds, edits and
    // removes none, and creates no viewing.
    expect(mockEdit).toHaveBeenCalledTimes(1);
    expect(mockDetails).toHaveBeenCalledTimes(1);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
    expect(view.getAllByTestId(/^watch-row-/)).toHaveLength(2);
  });

  it('the editor’s own Save is unchanged: it writes and closes without asking', async () => {
    const view = await editW1();
    await fireEvent.press(view.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockDetails).toHaveBeenCalledTimes(1));
    expect(mockEdit).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    expect(view.queryByTestId('watch-editor-w1')).toBeNull();
    expect(mockLogSheet.props?.title).toBeNull();
  });

  it.each(['nothing pending', 'Discard', 'Save'] as const)(
    'flushes a typed note before the ranking opens (%s)',
    async (path) => {
      // The note write is held open, so the test can see whether the sheet waits for it.
      let noteLands!: (value: { outcome: string; noteVersion: string }) => void;
      mockSaveNote.mockImplementationOnce(
        (_input: unknown) =>
          new Promise<{ outcome: string; noteVersion: string }>((resolve) => (noteLands = resolve)),
      );
      const view =
        path === 'nothing pending'
          ? await renderWithProviders(<WatchHistoryScreen />)
          : await editW1();
      if (path === 'nothing pending') await fireEvent.press(view.getByTestId('watch-edit-w1'));
      await fireEvent.press(view.getByLabelText(/^Note/));
      await fireEvent.changeText(view.getByPlaceholderText('What did you think?'), `Note: ${path}`);
      await pressEditRanking(view);
      if (path !== 'nothing pending') await confirm().press(path);
      await waitFor(() =>
        expect(mockSaveNote).toHaveBeenCalledWith(expect.objectContaining({ note: `Note: ${path}` })),
      );
      // While the note is still being written, the ranking has not opened over it.
      expect(mockLogSheet.props?.title ?? null).toBeNull();
      await act(async () => {
        noteLands({ outcome: 'ok', noteVersion: '2026-11-11T00:00:00Z' });
      });
      await waitFor(() => expect(mockLogSheet.props?.title).toEqual(FILM));
      expect(mockSaveNote).toHaveBeenCalledTimes(1);
    },
  );

  it('a failed date write also stays in the editor and does not open the ranking', async () => {
    mockEdit.mockImplementationOnce(() =>
      Promise.resolve({ outcome: 'failed', message: 'Could not change the date.' }),
    );
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    await fireEvent.press(view.getByLabelText(/^Watch date/));
    await fireEvent.press(view.getByText('Earlier'));
    await pressEditRanking(view);
    await confirm().press('Save');

    await waitFor(() =>
      expect(view.getByTestId('watch-history-error').props.children).toBe(
        'Could not change the date.',
      ),
    );
    expect(mockLogSheet.props?.title).toBeNull();
    expect(view.getByTestId('watch-editor-w1')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Earlier', selected: true })).toBeTruthy();
  });

  it('a change undone before Edit ranking is nothing pending, and asks nothing', async () => {
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    await fireEvent.press(view.getByLabelText(/^Who I watched with/));
    await fireEvent.press(view.getByRole('checkbox', { name: 'Alex' }));
    await fireEvent.press(view.getByRole('checkbox', { name: 'Alex' }));
    await pressEditRanking(view);

    await waitFor(() => expect(mockLogSheet.props?.title).toEqual(FILM));
    expect(alert).not.toHaveBeenCalled();
  });

  it('a Save that lands after the reader moved to another watch does not open the ranking', async () => {
    let land!: (value: { outcome: string }) => void;
    mockDetails.mockImplementationOnce(
      () => new Promise<{ outcome: string }>((resolve) => (land = resolve)),
    );
    const view = await editW1();
    await pressEditRanking(view);
    await confirm().press('Save');
    await waitFor(() => expect(mockDetails).toHaveBeenCalledTimes(1));

    // While w1's write is in flight the reader opens w2 and starts editing it.
    await fireEvent.press(view.getByTestId('watch-edit-w2'));
    expect(view.queryByTestId('watch-editor-w1')).toBeNull();
    await fireEvent.press(view.getByLabelText(/^Who I watched with/));
    await fireEvent.press(view.getByRole('checkbox', { name: 'Alex' }));

    await act(async () => {
      land({ outcome: 'ok' });
    });
    // w1 saved, but the ranking does not open over w2's editor, and w2's edit is intact.
    expect(mockLogSheet.props?.title).toBeNull();
    expect(view.getByTestId('watch-editor-w2')).toBeTruthy();
    expect(view.getByRole('checkbox', { name: 'Alex' }).props.accessibilityState).toEqual(
      expect.objectContaining({ checked: true }),
    );
  });

  it('holds Cancel, Save and Edit ranking while its Save is in flight, so nothing is lost or doubled', async () => {
    let land!: (value: { outcome: string }) => void;
    mockDetails.mockImplementationOnce(
      () => new Promise<{ outcome: string }>((resolve) => (land = resolve)),
    );
    const view = await editW1();
    await pressEditRanking(view);
    await confirm().press('Save');
    await waitFor(() => expect(mockDetails).toHaveBeenCalledTimes(1));

    expect(view.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(view.getByRole('button', { name: 'Save' })).toBeDisabled();
    alert.mockClear();
    await pressEditRanking(view);
    expect(alert).not.toHaveBeenCalled();
    expect(view.getByTestId('watch-editor-w1')).toBeTruthy();

    await act(async () => {
      land({ outcome: 'ok' });
    });
    await waitFor(() => expect(mockLogSheet.props?.title).toEqual(FILM));
    expect(mockDetails).toHaveBeenCalledTimes(1);
    expect(mockEdit).toHaveBeenCalledTimes(1);
  });
});
