import { fireEvent, waitFor } from '@testing-library/react-native';

import { controlRowSite, type Host } from '@/test-utils/hit-rect';
import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

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

/** The local store behind the remembered Share choice (`note-visibility-pref`). */
const mockPrefs = new Map<string, unknown>();
jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) => Promise.resolve(mockPrefs.get(name) ?? null),
  writePref: (name: string, value: unknown) => {
    mockPrefs.set(name, value);
    return Promise.resolve();
  },
}));

beforeEach(() => {
  mockPrefs.clear();
  mockRewatch.mockClear();
  mockSaveNote.mockClear();
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

/**
 * **Both claims answer 44pt in the composer, and nothing in it moves** (A11Y-44,
 * design-system v3 A.2 #12). Measured in the real note box (gutter padding, `space[2]`
 * gap) at 360pt, where the two chips wrap, and at a width where they share a line; the
 * chips stay `space[2]` from the field above and the caption below (`hit-rect.ts`).
 */
it('gives both claims a 44pt target without moving the chips or the gaps', async () => {
  const sheet = await draw();
  await fireEvent.press(sheet.getByLabelText(/^Note/));
  const chips = [
    sheet.getByLabelText('This note contains spoilers'),
    sheet.getByLabelText('Share this note as a public review'),
  ] as unknown as Host[];
  for (const width of [360, 1000]) {
    const site = controlRowSite(chips, width);
    expect(site.wrapped).toBe(width === 360);
    for (const [index, hit] of site.hits.entries()) {
      expect(site.chips[index]!.height).toBe(theme.layout.control.chipHeight);
      expect(hit.height).toBeGreaterThanOrEqual(theme.layout.minTapTarget);
    }
    if (site.wrapped) expect(site.hits[0]!.bottom).toBeLessThanOrEqual(site.hits[1]!.top);
    expect(site.spaceAbove).toBe(theme.space[2]);
    expect(site.spaceBelow).toBe(theme.space[2]);
  }
});

it('opens a first-ever note private, the same as the log sheet', async () => {
  const view = await draw();

  await fireEvent.press(view.getByLabelText(/^Note/));

  await waitFor(() =>
    expect(
      view.getByLabelText('Share this note as a public review').props.accessibilityState
        .checked,
    ).toBe(false),
  );
  // Opening a composer is not an act: nothing is written until the reader writes.
  expect(mockSaveNote).not.toHaveBeenCalled();
});

it('opens a new note on the reader’s remembered Share choice, shown before any typing', async () => {
  mockPrefs.set('user-1.notes.share-choice', 'public');
  const view = await draw();

  await fireEvent.press(view.getByLabelText(/^Note/));

  await waitFor(() =>
    expect(
      view.getByLabelText('Share this note as a public review').props.accessibilityState.checked,
    ).toBe(true),
  );
  expect(mockSaveNote).not.toHaveBeenCalled();
});

it('remembers a Share tap on a new note, and nothing about a save without one', async () => {
  const view = await draw();
  await fireEvent.press(view.getByLabelText(/^Note/));
  await fireEvent.changeText(view.getByPlaceholderText('What did you think?'), 'Held up.');
  await fireEvent.press(view.getByLabelText('I liked it'));
  await waitFor(() => expect(mockSaveNote).toHaveBeenCalled());
  expect(mockPrefs.has('user-1.notes.share-choice')).toBe(false);
});

it('shares a new note only when the reader turns Share as a review on', async () => {
  const view = await draw();

  await fireEvent.press(view.getByLabelText(/^Note/));
  await fireEvent.press(view.getByLabelText('Share this note as a public review'));
  await fireEvent.changeText(view.getByPlaceholderText('What did you think?'), 'Held up.');
  await fireEvent.press(view.getByLabelText('I liked it'));

  await waitFor(() =>
    expect(mockSaveNote).toHaveBeenCalledWith(expect.objectContaining({ noteVisibility: 'public' })),
  );
  expect(mockPrefs.get('user-1.notes.share-choice')).toBe('public');
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
      // A first-ever note, so private (2026-11-04) — the same rule the log sheet follows.
      noteVisibility: 'private',
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
