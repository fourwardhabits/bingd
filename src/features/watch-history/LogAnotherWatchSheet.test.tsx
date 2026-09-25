import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { LogAnotherWatchSheet } from './LogAnotherWatchSheet';

/**
 * *Another watch*, and the note it writes (founder item 11, 2026-09-25).
 *
 * This sheet had a Note field with no claims beside it, because it was writing
 * `watch_events.note` — a private diary line, owner-only by schema, which cannot be
 * published and so had nothing for "Contains spoilers" or "Share as a review" to act on.
 * It writes the title's one note now, through the same `save_note` the log sheet uses.
 *
 * What only this file can prove is the hand-off: the reader's commit here is **choosing a
 * bucket**, not a Save button, so the note has to be flushed before the rewatch is logged.
 */

jest.mock('@/features/auth/session', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

jest.mock('@/lib/analytics', () => ({ track: jest.fn() }));

jest.mock('@/features/collection/use-companions', () => ({
  ...jest.requireActual('@/features/collection/use-companions'),
  useTaggablePeople: () => ({ data: [], isPending: false }),
}));

const mockRewatch = jest.fn((_input: unknown) =>
  Promise.resolve({ outcome: 'ok', watchEventId: 'w-new' }),
);
jest.mock('./writes', () => ({
  logRewatch: (input: unknown) => mockRewatch(input),
  newOperationId: () => 'op-rewatch',
}));

const mockSaveNote = jest.fn((_input: unknown) =>
  Promise.resolve({ outcome: 'ok', noteVersion: '2026-09-25T00:00:00Z' }),
);
jest.mock('@/features/collection/writes', () => ({
  saveNote: (input: unknown) => mockSaveNote(input),
  newOperationId: () => 'op-note',
}));

const mockLogState = jest.fn(() => ({
  data: {
    note: '',
    noteVisibility: 'private' as const,
    noteSpoilers: false,
    noteVersion: null,
  },
}));
jest.mock('@/features/collection/use-log-state', () => ({
  useLogState: (...args: unknown[]) => mockLogState(...(args as [])),
}));

/**
 * The remembered share default — the same `note-visibility-pref` the log sheet reads
 * (founder, 2026-09-25). `null` is a reader who has never chosen, whose first-ever note
 * opens shared.
 */
let mockRemembered: 'public' | 'private' | null = null;
const mockRemember = jest.fn();
jest.mock('@/features/collection/note-visibility-pref', () => ({
  readNoteVisibilityDefault: () => Promise.resolve(mockRemembered),
  rememberNoteVisibility: (...args: unknown[]) => {
    mockRemember(...args);
    return Promise.resolve();
  },
}));

beforeEach(() => {
  mockRewatch.mockClear();
  mockSaveNote.mockClear();
  mockRemember.mockClear();
  mockRemembered = null;
});

const draw = () =>
  renderWithProviders(
    <LogAnotherWatchSheet
      open
      title="The Operative"
      mediaItemId="film-1"
      onClose={() => {}}
      onRank={() => {}}
      onSaved={() => {}}
    />,
  );

it('offers the same two claims as the log sheet', async () => {
  const view = await draw();

  await fireEvent.press(view.getByLabelText(/^Note/));

  expect(view.getByLabelText('This note contains spoilers')).toBeTruthy();
  expect(view.getByLabelText('Share this note as a public review')).toBeTruthy();
});

it('opens a first-ever note shared, the same as the log sheet', async () => {
  const view = await draw();

  await fireEvent.press(view.getByLabelText(/^Note/));

  await waitFor(() =>
    expect(
      view.getByLabelText('Share this note as a public review').props.accessibilityState
        .checked,
    ).toBe(true),
  );
  // Opening a composer is not an act: nothing is written until the reader writes.
  expect(mockSaveNote).not.toHaveBeenCalled();
});

it('follows the reader\u2019s remembered choice for a new note', async () => {
  mockRemembered = 'private';
  const view = await draw();

  await fireEvent.press(view.getByLabelText(/^Note/));

  await waitFor(() => expect(view.getByText('Only you can read this.')).toBeTruthy());
});

it('remembers a new note\u2019s visibility once it actually saves', async () => {
  const view = await draw();

  await fireEvent.press(view.getByLabelText(/^Note/));
  await fireEvent.changeText(view.getByPlaceholderText('What did you think?'), 'Held up.');
  await fireEvent.press(view.getByLabelText('I liked it'));

  await waitFor(() => expect(mockRemember).toHaveBeenCalledWith('user-1', 'public'));
});

it('writes the note to the title, not to the watch', async () => {
  const view = await draw();

  await fireEvent.press(view.getByLabelText(/^Note/));
  await fireEvent.changeText(view.getByPlaceholderText('What did you think?'), 'Better second time.');
  await fireEvent.press(view.getByLabelText('I liked it'));

  await waitFor(() => expect(mockSaveNote).toHaveBeenCalledTimes(1));
  expect(mockSaveNote).toHaveBeenCalledWith(
    expect.objectContaining({
      mediaItemId: 'film-1',
      note: 'Better second time.',
      // A first-ever note, so the product default — the same one the log sheet opens on.
      noteVisibility: 'public',
    }),
  );

  // The rewatch itself carries no note: `watch_events.note` is not written from here.
  await waitFor(() => expect(mockRewatch).toHaveBeenCalledTimes(1));
  const [rewatch] = mockRewatch.mock.calls[0] as [Record<string, unknown>];
  expect(rewatch.note).toBeUndefined();
});

it('flushes the note before the watch is logged, so a bucket press cannot lose it', async () => {
  const order: string[] = [];
  mockSaveNote.mockImplementation((_input: unknown) => {
    order.push('note');
    return Promise.resolve({ outcome: 'ok', noteVersion: 'v1' });
  });
  mockRewatch.mockImplementation((_input: unknown) => {
    order.push('rewatch');
    return Promise.resolve({ outcome: 'ok', watchEventId: 'w-new' });
  });

  const view = await draw();
  await fireEvent.press(view.getByLabelText(/^Note/));
  await fireEvent.changeText(view.getByPlaceholderText('What did you think?'), 'Held up.');
  await fireEvent.press(view.getByLabelText('It was fine'));

  await waitFor(() => expect(order).toEqual(['note', 'rewatch']));
});
