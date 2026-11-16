import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import { LogSheet, type LoggableTitle, type LogSheetProps } from './LogSheet';

/**
 * **B5 — a watch's note, shared as a review through the title's one composer.**
 *
 * Watch History opens the log sheet's Note on a watch's own note (`seedNote`). The rules
 * this suite holds the composer to:
 *
 *   - opening writes nothing, and closing however the reader closes writes nothing;
 *   - the draft opens private, whatever is stored or remembered;
 *   - typing and Spoilers are held, not autosaved;
 *   - *Share as a review* is the commit, and it goes through `save_note` with the draft
 *     as it then reads and the spoiler choice beside it — never `set_watch_details`;
 *   - after that the composer is the ordinary one again.
 *
 * The reads are the log sheet suite's stubs; `user_media` answers from a mutable row so
 * the save can be read back by a sheet opened afterwards.
 */

const mockPrefs = new Map<string, unknown>();
jest.mock('@/lib/prefs', () => ({
  readPref: async (name: string) => mockPrefs.get(name) ?? null,
  writePref: (name: string, value: unknown) => {
    mockPrefs.set(name, value);
    return Promise.resolve();
  },
}));

const mockRpc = jest.fn();
const mockFrom = jest.fn();
jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
}));

let issued = 0;
jest.mock('expo-crypto', () => ({
  randomUUID: () => `operation-${(issued += 1)}`,
}));

const FILM: LoggableTitle = {
  id: 'film-a',
  title: 'Film A',
  year: 2010,
  posterUri: null,
  kind: 'movie',
};
const WATCH_NOTE = 'Third time, on the big screen, and it still lands.';

/** The stored `user_media` row, which `save_note` below writes back into. */
let mockStored: Record<string, unknown> | null = null;

const stubReads = () => {
  mockFrom.mockImplementation((table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({
        data:
          table === 'user_media'
            ? mockStored
            : table === 'rankings'
              ? { bucket: 'loved' }
              : null,
        error: null,
      }),
      // `watch_tags` and the watch count are awaited directly.
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: [], count: 3, error: null }).then(resolve),
    };
    return chain;
  });
};

beforeEach(() => {
  issued = 0;
  mockPrefs.clear();
  mockRpc.mockReset();
  mockFrom.mockReset();
  mockStored = {
    bucket: 'loved',
    watched_on: '2026-10-24',
    note: null,
    note_updated_at: null,
    note_visibility: null,
    note_has_spoilers: false,
  };
  mockRpc.mockImplementation((name: string, args: Record<string, unknown>) => {
    if (name === 'save_note' && mockStored) {
      mockStored = {
        ...mockStored,
        note: args.p_note,
        note_visibility: args.p_note_visibility,
        note_has_spoilers: args.p_note_spoilers,
        note_updated_at: '2026-11-15T10:00:00Z',
      };
      return Promise.resolve({
        data: { status: 'ok', note_updated_at: '2026-11-15T10:00:00Z' },
        error: null,
      });
    }
    return Promise.resolve({ data: { status: 'ok' }, error: null });
  });
  stubReads();
});

const callsTo = (fn: string) => mockRpc.mock.calls.filter(([name]) => name === fn);
const writes = () => mockRpc.mock.calls.map(([name]) => name as string);

/** Lets any timer or detached write that would run have run. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
  });

const open = async (props: Partial<LogSheetProps> = {}) => {
  const onClose = jest.fn();
  const view = await renderWithProviders(
    <LogSheet title={FILM} onClose={onClose} surface="title" inWatchHistory {...props} />,
  );
  return {
    ...view,
    onClose,
    // The parent letting go of the title, which is how the sheet unmounts in the app (and
    // what its last-net flush runs on). `unmount()` would tear the providers down too.
    hide: () =>
      view.rerender(
        <LogSheet title={null} onClose={onClose} surface="title" inWatchHistory {...props} />,
      ),
    note: () => view.getByPlaceholderText('What did you think?'),
    share: () => view.getByLabelText('Share this note as a public review'),
    spoilers: () => view.getByLabelText('This note contains spoilers'),
  };
};

describe('a watch note offered as a review (B5)', () => {
  it('opens the composer on the watch note, private, and writes nothing', async () => {
    mockPrefs.set('user-1.notes.share-choice', 'public');
    const sheet = await open({ seedNote: WATCH_NOTE });

    await waitFor(() => expect(sheet.note().props.value).toBe(WATCH_NOTE));
    // Private however the reader last chose: the watch note is writing that exists.
    expect(sheet.share().props.accessibilityState).toMatchObject({ checked: false });
    expect(sheet.getByText('Only you can read this.')).toBeTruthy();
    expect(sheet.getByTestId('log-note-seed-hint')).toBeTruthy();

    await settle();
    expect(writes()).toEqual([]);
  });

  it('holds typing and Spoilers, and closing writes nothing', async () => {
    // Captured rather than simulated, and swapped by assignment, as the log sheet suite
    // does it: the preset ships this method as a mock, and `mockRestore` would strip it.
    const handlers: ((next: string) => void)[] = [];
    const realSubscribe = AppState.addEventListener;
    AppState.addEventListener = ((_type: string, handler: (next: string) => void) => {
      handlers.push(handler);
      return { remove: () => {} };
    }) as unknown as typeof AppState.addEventListener;

    try {
      const sheet = await open({ seedNote: WATCH_NOTE });
      await waitFor(() => expect(sheet.note().props.value).toBe(WATCH_NOTE));

      await fireEvent.changeText(sheet.note(), `${WATCH_NOTE} Edited.`);
      await fireEvent(sheet.note(), 'blur');
      await fireEvent.press(sheet.spoilers());
      // Backgrounding is one of the autosave's flush points; the held draft ignores it.
      await act(async () => {
        for (const handler of handlers) handler('background');
      });
      await settle();
      expect(writes()).toEqual([]);

      // Collapsing the row, then closing the sheet: two more of its flush points.
      await fireEvent.press(sheet.getByRole('button', { name: 'Note' }));
      await fireEvent.press(sheet.getByLabelText('Close'));
      expect(sheet.onClose).toHaveBeenCalled();
      await sheet.hide();
      await settle();
      expect(writes()).toEqual([]);
      expect(mockStored?.note).toBeNull();
    } finally {
      AppState.addEventListener = realSubscribe;
    }
  });

  it('shares the edited draft through save_note, with the spoiler choice, on the explicit tap', async () => {
    const sheet = await open({ seedNote: WATCH_NOTE });
    await waitFor(() => expect(sheet.note().props.value).toBe(WATCH_NOTE));

    await fireEvent.changeText(sheet.note(), 'Better the third time.');
    await fireEvent.press(sheet.spoilers());
    await settle();
    expect(writes()).toEqual([]);

    await fireEvent.press(sheet.share());

    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    expect(callsTo('save_note')[0][1]).toMatchObject({
      p_media_item_id: 'film-a',
      p_note: 'Better the third time.',
      p_note_visibility: 'public',
      p_note_spoilers: true,
    });
    // The title's pathway only: the watch's own note is not this sheet's to write.
    expect(callsTo('set_watch_details')).toHaveLength(0);
    expect(callsTo('log_watched')).toHaveLength(0);
    expect(sheet.queryByTestId('log-note-seed-hint')).toBeNull();
    expect(
      sheet.getByText(
        'Shown with your rating, hidden until people who have not seen it tap to reveal.',
      ),
    ).toBeTruthy();

    // Published, it is the ordinary composer again: further writing autosaves into it.
    await fireEvent.changeText(sheet.note(), 'Better the third time. Really.');
    await fireEvent(sheet.note(), 'blur');
    await waitFor(() => expect(callsTo('save_note')).toHaveLength(2));
    expect(callsTo('save_note')[1][1]).toMatchObject({
      p_note: 'Better the third time. Really.',
      p_note_visibility: 'public',
    });
  });

  it('persists: a sheet opened afterwards reads the shared review back', async () => {
    const first = await open({ seedNote: WATCH_NOTE });
    await waitFor(() => expect(first.note().props.value).toBe(WATCH_NOTE));
    await fireEvent.press(first.share());
    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    await first.hide();

    // An ordinary open, with no seed: the stored review, shared, is what it shows.
    const again = await open();
    await waitFor(() =>
      expect(
        again.getByRole('button', { name: 'Note' }).props.accessibilityState.disabled,
      ).toBe(false),
    );
    expect(again.getByText(`Shared · ${WATCH_NOTE.split(/\s+/).length} words`)).toBeTruthy();
  });

  /**
   * Replacing an existing review: the caller has asked, and the field holds the watch's
   * note. The stored review stays until Share, and a close keeps it, published as it was.
   */
  it('keeps an existing review until Share, then replaces it', async () => {
    mockStored = {
      ...mockStored,
      note: 'The title review.',
      note_visibility: 'public',
      note_has_spoilers: true,
      note_updated_at: '2026-11-01T00:00:00Z',
    };
    const closed = await open({ seedNote: WATCH_NOTE });
    await waitFor(() => expect(closed.note().props.value).toBe(WATCH_NOTE));
    // Opens unshared even over a published review: the reader turns it on for this text.
    expect(closed.share().props.accessibilityState).toMatchObject({ checked: false });
    await fireEvent.press(closed.getByLabelText('Close'));
    await closed.hide();
    await settle();
    expect(writes()).toEqual([]);
    expect(mockStored?.note).toBe('The title review.');

    const sheet = await open({ seedNote: WATCH_NOTE });
    await waitFor(() => expect(sheet.note().props.value).toBe(WATCH_NOTE));
    await fireEvent.press(sheet.share());
    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    expect(callsTo('save_note')[0][1]).toMatchObject({
      p_note: WATCH_NOTE,
      p_note_visibility: 'public',
      // The stored claim, shown on the chip and left as the reader left it.
      p_note_spoilers: true,
      p_base_updated_at: '2026-11-01T00:00:00Z',
    });
  });

  it('does not share an emptied draft, so it cannot clear the stored note', async () => {
    mockStored = { ...mockStored, note: 'The title review.', note_visibility: 'private' };
    const sheet = await open({ seedNote: WATCH_NOTE });
    await waitFor(() => expect(sheet.note().props.value).toBe(WATCH_NOTE));

    await fireEvent.changeText(sheet.note(), '   ');
    await fireEvent.press(sheet.share());
    await settle();

    expect(writes()).toEqual([]);
    expect(sheet.getByText('Write something to share as a review.')).toBeTruthy();
    expect(sheet.share().props.accessibilityState).toMatchObject({ checked: false });
  });

  it('ignores the seed in the post-rank state', async () => {
    const sheet = await open({
      seedNote: WATCH_NOTE,
      postRank: { score: 9.1, position: 2, category: 'movies' },
    });
    await waitFor(() =>
      expect(
        sheet.getByRole('button', { name: 'Note' }).props.accessibilityState.disabled,
      ).toBe(false),
    );
    expect(sheet.queryByPlaceholderText('What did you think?')).toBeNull();
    await fireEvent.press(sheet.getByRole('button', { name: 'Note' }));
    expect(sheet.note().props.value).toBe('');
  });
});
