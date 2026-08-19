import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { LogSheet, type LoggableTitle, type LogSheetProps } from './LogSheet';

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

let issued = 0;
jest.mock('expo-crypto', () => ({
  randomUUID: () => `operation-${(issued += 1)}`,
}));

const filmA: LoggableTitle = {
  id: 'film-a',
  title: 'Film A',
  year: 2010,
  posterUri: null,
  kind: 'movie',
};

const filmB: LoggableTitle = { ...filmA, id: 'film-b', title: 'Film B' };

/**
 * `useLogState` issues two reads. Both are the same chain shape, so one builder
 * serves either — the table name decides what comes back.
 */
const stubReads = (
  logged: Record<string, unknown> | null,
  ranked: { bucket: string } | null,
) => {
  mockFrom.mockImplementation((table: string) => ({
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: table === 'user_media' ? logged : ranked,
            error: null,
          }),
        }),
      }),
    }),
  }));
};

/**
 * A `user_media` read that fails the way a backend one migration behind fails.
 *
 * SQLSTATE 42703 is what PostgREST returns when the client selects a column the
 * database does not have, and it is exactly what the founder's device hit: the sheet
 * asks for `note_visibility`, the column is not there, and the row that used to say
 * `Loading` said it for ever.
 */
const stubFailedLogState = () => {
  mockFrom.mockImplementation((table: string) => ({
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === 'user_media'
              ? {
                  data: null,
                  error: {
                    code: '42703',
                    message: 'column user_media.note_visibility does not exist',
                  },
                }
              : { data: null, error: null },
        }),
      }),
    }),
  }));
};

/**
 * The same stub, held open until the test releases it.
 *
 * Every other test here awaits the resolved row before touching anything, which is
 * exactly the reason the load-boundary defect survived to review: the window where
 * the sheet is showing `emptyLogState` for a title that already has a note was never
 * entered. This is what enters it.
 */
const stubSlowReads = (
  logged: Record<string, unknown> | null,
  ranked: { bucket: string } | null,
) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  mockFrom.mockImplementation((table: string) => ({
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: async () => {
            await gate;
            return { data: table === 'user_media' ? logged : ranked, error: null };
          },
        }),
      }),
    }),
  }));

  return { release: () => release() };
};

beforeEach(() => {
  issued = 0;
  mockRpc.mockReset();
  mockFrom.mockReset();
  mockRpc.mockResolvedValue({ data: { status: 'ok' }, error: null });
  stubReads(null, null);
});

const callsTo = (fn: string) => mockRpc.mock.calls.filter(([name]) => name === fn);

const open = async (title: LoggableTitle | null, props: Partial<LogSheetProps> = {}) => {
  const view = await renderWithProviders(<LogSheet title={title} onClose={() => {}} {...props} />);

  return {
    ...view,
    show: (next: LoggableTitle | null) =>
      view.rerender(<LogSheet title={next} onClose={() => {}} {...props} />),
    bucket: (label: string) => view.getByLabelText(label),
    // The row and the field it discloses share the name "Notes" — which is right for
    // a screen reader, since one is a button and the other a text field — so the
    // queries here separate them by role rather than by label.
    notesRow: () => view.getByRole('button', { name: 'Notes' }),
    // Both rows are inert until `useLogState` resolves, so that nothing can be
    // decided about a note the sheet has not been told about yet. A user waits for
    // that without noticing; a test has to say so.
    openNotes: async () => {
      await waitFor(() =>
        expect(view.getByLabelText('Notes').props.accessibilityState.disabled).toBe(false),
      );
      return fireEvent.press(view.getByRole('button', { name: 'Notes' }));
    },
    note: () => view.getByPlaceholderText('What did you think?'),
    dateRow: () => view.getByRole('button', { name: 'Watch date' }),
    openDate: async () => {
      await waitFor(() =>
        expect(view.getByLabelText('Watch date').props.accessibilityState.disabled).toBe(false),
      );
      return fireEvent.press(view.getByRole('button', { name: 'Watch date' }));
    },
  };
};

/**
 * The log sheet (screens.md §4), after the 2026-08-15 reversal that made ranking
 * automatic.
 *
 * The cases worth the most here are the ones where a wrong answer is silent: a note
 * that does not load and is then overwritten with nothing, a bucket tap that
 * re-ranks a title without asking, and state surviving a swap between two titles.
 */
describe('a second title', () => {
  it('does not inherit the first title’s bucket or note', async () => {
    const sheet = await open(filmA);

    await fireEvent.press(sheet.bucket('Loved it'));
    await waitFor(() => expect(callsTo('set_bucket')).toHaveLength(1));
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'a private note about Film A');

    await sheet.show(filmB);

    expect(sheet.getByText('Film B')).toBeTruthy();
    expect(sheet.bucket('Loved it').props.accessibilityState.selected).toBe(false);
  });

  it('does not file the first title’s note against the second', async () => {
    const sheet = await open(filmA);

    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'a private note about Film A');
    await sheet.show(filmB);

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(0));
  });
});

describe('choosing a bucket', () => {
  it('saves the bucket for the title on screen', async () => {
    const sheet = await open(filmA);

    await fireEvent.press(sheet.bucket('Not for me'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('set_bucket', {
        p_operation_id: 'operation-1',
        p_media_item_id: 'film-a',
        p_bucket: 'not_for_me',
      }),
    );
  });

  /** The whole point of the slice: no second tap between bucketing and comparing. */
  it('enters ranking automatically once the save lands', async () => {
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await fireEvent.press(sheet.bucket('Loved it'));

    await waitFor(() => expect(onRank).toHaveBeenCalledWith('loved', 'start'));
  });

  it('does not enter ranking when the save was refused', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'nope' } });
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await fireEvent.press(sheet.bucket('Loved it'));

    await waitFor(() => expect(sheet.getByText('nope')).toBeTruthy());
    expect(onRank).not.toHaveBeenCalled();
  });

  it('carries a new operation id each time, so a change of mind is not read as a retry', async () => {
    const sheet = await open(filmA);

    await fireEvent.press(sheet.bucket('Loved it'));
    await waitFor(() => expect(callsTo('set_bucket')).toHaveLength(1));
    await fireEvent.press(sheet.bucket('It was fine'));
    await waitFor(() => expect(callsTo('set_bucket')).toHaveLength(2));

    const [first, second] = callsTo('set_bucket').map(([, args]) => args.p_operation_id);
    expect(first).not.toBe(second);
  });
});

/**
 * A ranked title's bucket belongs to the ranking. `set_bucket` refuses it with 55000,
 * and the only legitimate route is `rank_rebucket`, which discards the position — so
 * it must never happen on a stray tap, and must not happen at all when nothing changed.
 */
describe('a title that is already ranked', () => {
  beforeEach(() => {
    stubReads({ bucket: 'loved', watched_on: '2026-08-01', note: '' }, { bucket: 'loved' });
  });

  it('does nothing when the bucket it already has is tapped again', async () => {
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await waitFor(() => expect(sheet.bucket('Loved it').props.accessibilityState.selected).toBe(true));
    await fireEvent.press(sheet.bucket('Loved it'));

    expect(onRank).not.toHaveBeenCalled();
    expect(callsTo('set_bucket')).toHaveLength(0);
    expect(sheet.queryByText(/will re-rank/)).toBeNull();
  });

  it('asks before re-ranking when a different bucket is tapped', async () => {
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await waitFor(() => expect(sheet.bucket('Loved it').props.accessibilityState.selected).toBe(true));
    await fireEvent.press(sheet.bucket('It was fine'));

    expect(sheet.getByText('Changing this will re-rank Film A.')).toBeTruthy();
    // Nothing has happened yet — the prompt is the whole point.
    expect(onRank).not.toHaveBeenCalled();
    expect(callsTo('set_bucket')).toHaveLength(0);
  });

  it('cancelling leaves the ranking and the bucket alone', async () => {
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await waitFor(() => expect(sheet.bucket('Loved it').props.accessibilityState.selected).toBe(true));
    await fireEvent.press(sheet.bucket('It was fine'));
    await fireEvent.press(sheet.getByRole('button', { name: 'Cancel' }));

    expect(onRank).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(sheet.bucket('Loved it').props.accessibilityState.selected).toBe(true);
  });

  it('confirming hands off in rebucket mode without writing the bucket first', async () => {
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await waitFor(() => expect(sheet.bucket('Loved it').props.accessibilityState.selected).toBe(true));
    await fireEvent.press(sheet.bucket('It was fine'));
    await fireEvent.press(sheet.getByRole('button', { name: 'Re-rank' }));

    expect(onRank).toHaveBeenCalledWith('fine', 'rebucket');
    // set_bucket would have earned a 55000; rank_rebucket does the bucket change itself.
    expect(callsTo('set_bucket')).toHaveLength(0);
  });

  /** Editing anything other than the bucket must not touch the ranking. */
  it('lets the note be edited without disturbing the ranking', async () => {
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'still holds up');
    await fireEvent(sheet.note(), 'blur');

    // A row already exists, so the note is an update — save_note, not log_watched.
    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    expect(onRank).not.toHaveBeenCalled();
    expect(callsTo('set_bucket')).toHaveLength(0);
    expect(callsTo('rank_rebucket')).toHaveLength(0);
  });
});

describe('notes', () => {
  it('populates an existing note when the sheet is re-opened', async () => {
    stubReads({ bucket: 'loved', watched_on: null, note: 'watched it on 35mm' }, null);
    const sheet = await open(filmA);

    await sheet.openNotes();

    await waitFor(() => expect(sheet.note().props.value).toBe('watched it on 35mm'));
  });

  it('does not clear the field after saving', async () => {
    const sheet = await open(filmA);

    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'better than I expected');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    expect(sheet.note().props.value).toBe('better than I expected');
  });

  it('does not rewrite a note that has not changed', async () => {
    stubReads({ bucket: null, watched_on: null, note: 'unchanged' }, null);
    const sheet = await open(filmA);

    await sheet.openNotes();
    await waitFor(() => expect(sheet.note().props.value).toBe('unchanged'));
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(0));
  });

  /**
   * `log_watched` coalesces, so it can create a note and can never erase one — an
   * empty string reads as "no change" and the old text comes back on the next read.
   * Clearing has to go through `save_note`, which assigns.
   */
  it('clears a note through save_note, not log_watched', async () => {
    stubReads(
      { bucket: 'loved', watched_on: '2026-08-01', note: 'delete me', note_updated_at: 'v1' },
      null,
    );
    const sheet = await open(filmA);

    await sheet.openNotes();
    await waitFor(() => expect(sheet.note().props.value).toBe('delete me'));
    await fireEvent.changeText(sheet.note(), '');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    expect(callsTo('save_note')[0][1]).toMatchObject({
      p_media_item_id: 'film-a',
      p_note: '',
      // The version the edit was based on, so a second device's change is refused
      // rather than silently overwritten.
      p_base_updated_at: 'v1',
    });
    expect(callsTo('log_watched')).toHaveLength(0);
  });

  it('creates a first note through log_watched, since there is no row to update', async () => {
    const sheet = await open(filmA);

    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'first thoughts');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    expect(callsTo('log_watched')[0][1].p_note).toBe('first thoughts');
    expect(callsTo('save_note')).toHaveLength(0);
  });

  it('does not write an empty note when the field is merely touched', async () => {
    const sheet = await open(filmA);

    await sheet.openNotes();
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(0));
  });
});

/**
 * The two claims an author makes about their own note (founder amendment,
 * 2026-08-16). The cases that matter are the ones where getting it wrong publishes
 * something: a note written under the private-only promise must open on private and
 * stay there, and the sheet must send the state it is displaying rather than let the
 * server infer one.
 */
describe('what a note says about itself', () => {
  const spoilerToggle = (sheet: Awaited<ReturnType<typeof open>>) =>
    sheet.getByLabelText('This note contains spoilers');
  const privateToggle = (sheet: Awaited<ReturnType<typeof open>>) =>
    sheet.getByLabelText('Keep this note private');

  it('opens a new note on the social default', async () => {
    const sheet = await open(filmA);
    await sheet.openNotes();

    expect(privateToggle(sheet).props.accessibilityState.checked).toBe(false);
    expect(spoilerToggle(sheet).props.accessibilityState.checked).toBe(false);
    expect(sheet.getByText(/Shown with your rating/)).toBeTruthy();
  });

  it('opens a note written before notes were social on private, and leaves it there', async () => {
    stubReads(
      {
        bucket: 'loved',
        watched_on: null,
        note: 'written when this was private',
        note_updated_at: 'v1',
        note_visibility: 'private',
        note_has_spoilers: false,
      },
      null,
    );
    const sheet = await open(filmA);
    await sheet.openNotes();

    await waitFor(() => expect(privateToggle(sheet).props.accessibilityState.checked).toBe(true));
    expect(sheet.getByText('Only you can read this.')).toBeTruthy();

    // Editing the text must carry the stored visibility rather than the default.
    await fireEvent.changeText(sheet.note(), 'edited, still mine');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    expect(callsTo('save_note')[0][1].p_note_visibility).toBe('private');
  });

  it('writes the spoiler claim with a first note', async () => {
    const sheet = await open(filmA);
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'he was dead the whole time');
    await fireEvent.press(spoilerToggle(sheet));

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    expect(callsTo('log_watched')[0][1]).toMatchObject({
      p_note: 'he was dead the whole time',
      p_note_spoilers: true,
      p_note_visibility: 'public',
    });
  });

  it('makes an existing note private without waiting for a blur', async () => {
    stubReads(
      {
        bucket: 'loved',
        watched_on: null,
        note: 'out in the open',
        note_updated_at: 'v1',
        note_visibility: 'public',
        note_has_spoilers: false,
      },
      null,
    );
    const sheet = await open(filmA);
    await sheet.openNotes();
    await waitFor(() => expect(sheet.note().props.value).toBe('out in the open'));

    await fireEvent.press(privateToggle(sheet));

    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    expect(callsTo('save_note')[0][1]).toMatchObject({
      p_note: 'out in the open',
      p_note_visibility: 'private',
    });
  });

  it('does not write anything when a toggle is flipped against an empty field', async () => {
    const sheet = await open(filmA);
    await sheet.openNotes();
    await fireEvent.press(spoilerToggle(sheet));

    await waitFor(() => expect(spoilerToggle(sheet).props.accessibilityState.checked).toBe(true));
    expect(callsTo('log_watched')).toHaveLength(0);
    expect(callsTo('save_note')).toHaveLength(0);
  });

  /**
   * The defect independent review found on 2026-08-16, as the sequence that produced
   * it. Before the sheet knows what is stored it is showing an empty field and the
   * social default, and a title may already carry a note written back when notes
   * were private-only. Anything the user does in that window is a decision about a
   * note they have not been shown.
   */
  it('will not take a decision about a note it has not loaded yet', async () => {
    const slow = stubSlowReads(
      {
        bucket: 'loved',
        watched_on: null,
        note: 'written when this was private',
        note_updated_at: 'v1',
        note_visibility: 'private',
        note_has_spoilers: false,
      },
      null,
    );
    const sheet = await open(filmA);

    // The row is present so the sheet keeps its shape, but it cannot be opened
    // and therefore cannot be acted on.
    const notes = sheet.getByLabelText('Notes');
    expect(notes.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(notes);
    expect(sheet.queryByPlaceholderText('What did you think?')).toBeNull();

    slow.release();
    await waitFor(() => expect(sheet.notesRow().props.accessibilityState.disabled).toBe(false));

    await sheet.openNotes();
    await waitFor(() =>
      expect(sheet.note().props.value).toBe('written when this was private'),
    );
    // The stored visibility, not the default the sheet was showing a moment ago.
    expect(privateToggle(sheet).props.accessibilityState.checked).toBe(true);
    expect(callsTo('log_watched')).toHaveLength(0);
    expect(callsTo('save_note')).toHaveLength(0);
  });

  it('does not resend the note claims on a date-only save', async () => {
    stubReads(
      {
        bucket: 'loved',
        watched_on: '2026-08-01',
        note: 'unchanged',
        note_updated_at: 'v1',
        note_visibility: 'private',
        note_has_spoilers: false,
      },
      null,
    );
    const sheet = await open(filmA);
    await sheet.openDate();
    await fireEvent.press(sheet.getByRole('button', { name: 'Yesterday' }));

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    expect(callsTo('log_watched')[0][1]).toMatchObject({
      p_note: null,
      p_note_visibility: null,
      p_note_spoilers: null,
    });
  });
});

describe('the watch date', () => {
  it('defaults to today', async () => {
    const sheet = await open(filmA);

    // Once the row knows there is no stored date. Before that it states no value at
    // all, rather than a default it would overwrite a real date with.
    await waitFor(() => expect(sheet.dateRow().props.accessibilityValue?.text).toBe('Today'));
  });

  /**
   * The gap this closes: `log_watched` used to be called only when a non-empty note
   * was written, so a user could not record "I watched this last night" without also
   * typing something (screens.md §4 recorded it as a known omission).
   */
  it('saves without a note', async () => {
    const sheet = await open(filmA);

    await sheet.openDate();
    await fireEvent.press(sheet.getByRole('button', { name: 'Yesterday' }));

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    const [, args] = callsTo('log_watched')[0];
    expect(args.p_media_item_id).toBe('film-a');
    expect(args.p_watched_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(args.p_note).toBeNull();
  });

  /**
   * The row shows "Today" the moment the sheet opens, so choosing a bucket has to
   * store that. Otherwise the sheet displays a date it never saved, and reopening it
   * a week later still claims "Today".
   */
  it('stamps today when a bucket is chosen and no date exists', async () => {
    const sheet = await open(filmA);

    await fireEvent.press(sheet.bucket('Loved it'));

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    expect(callsTo('log_watched')[0][1].p_watched_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('does not overwrite a date already recorded', async () => {
    stubReads({ bucket: null, watched_on: '2020-03-04', note: null }, null);
    const sheet = await open(filmA);

    await waitFor(() =>
      expect(sheet.dateRow().props.accessibilityValue.text).not.toBe('Today'),
    );
    await fireEvent.press(sheet.bucket('Loved it'));

    await waitFor(() => expect(callsTo('set_bucket')).toHaveLength(1));
    expect(callsTo('log_watched')).toHaveLength(0);
  });

  it('shows a stored date rather than today', async () => {
    stubReads({ bucket: null, watched_on: '2020-03-04', note: null }, null);
    const sheet = await open(filmA);

    await waitFor(() =>
      expect(sheet.dateRow().props.accessibilityValue.text).not.toBe('Today'),
    );
  });
});

/**
 * What the rows do when the read behind them fails.
 *
 * The founder's device showed `Loading` for ever against a backend one migration
 * behind the client, because the sheet had two states where it needed three. These
 * are the properties that matter: it stops saying Loading, it says what is wrong, it
 * offers a way back, it does not block the thing that still works, and — the one that
 * is a privacy rule rather than a nicety — it does not open the note editor.
 */
describe('when the log state cannot be read', () => {
  beforeEach(() => {
    stubFailedLogState();
  });

  it('stops claiming to be loading', async () => {
    const sheet = await open(filmA);

    await waitFor(() =>
      expect(sheet.getByLabelText('Notes').props.accessibilityHint).toBe('Unavailable'),
    );
    for (const label of ['Notes', 'Who I watched with', 'Watch date']) {
      expect(sheet.getByLabelText(label).props.accessibilityHint).not.toBe('Loading');
    }
  });

  it('names the failing dependency outside production, and offers a retry', async () => {
    const sheet = await open(filmA);

    await waitFor(() =>
      expect(sheet.getByText(/note_visibility does not exist/)).toBeTruthy(),
    );
    expect(sheet.getByLabelText('Retry loading your notes and watch date')).toBeTruthy();
  });

  it('still lets a bucket be chosen and ranking start', async () => {
    // `set_bucket` needs none of what failed, so gating it would be punishing the
    // user for a fault in a different query.
    const sheet = await open(filmA);
    await waitFor(() =>
      expect(sheet.getByLabelText('Notes').props.accessibilityHint).toBe('Unavailable'),
    );

    await fireEvent.press(sheet.bucket('Loved it'));
    await waitFor(() => expect(callsTo('set_bucket')).toHaveLength(1));
  });

  /**
   * The privacy invariant, restated for the failure path.
   *
   * With no answer about what is stored we cannot know whether this title carries a
   * note written when notes were private-only, so the editor must stay shut. Making
   * a failed read fall back to the forward-facing `public` default would be the
   * exact publication the gate exists to prevent, arrived at from a new direction.
   */
  it('does not open the note editor, so nothing is decided about a note it cannot see', async () => {
    const sheet = await open(filmA);
    await waitFor(() =>
      expect(sheet.getByLabelText('Notes').props.accessibilityHint).toBe('Unavailable'),
    );

    await fireEvent.press(sheet.getByLabelText('Notes'));

    expect(sheet.queryByPlaceholderText('What did you think?')).toBeNull();
    expect(callsTo('save_note')).toHaveLength(0);
    expect(callsTo('log_watched')).toHaveLength(0);
  });
});

/**
 * One device, two accounts.
 *
 * `useLogState` was keyed by the title alone, so the cache entry holding a note —
 * the one thing PRD §22 keeps private at every visibility level — was shared between
 * whoever had opened that title. Independent review, 2026-08-16, constructed the
 * consequence: B opens the title, React Query serves A's cached state while
 * refetching, `loaded` is true because `existing` is defined, and if B's refetch fails
 * A's note stays on screen in B's sheet, editable.
 *
 * `queryClient.clear()` on sign-out was what had been preventing it in practice. This
 * test does not go through sign-out, because the point of the fix is that the key
 * alone is sufficient and no lifecycle has to be trusted for it.
 */
describe('two accounts on one device', () => {
  it('does not serve one account’s note to another from the cache', async () => {
    // The signed-in user is `user-1`, from the auth mock at the top of this file,
    // and their own read fails — the case where a shared cache entry would be the
    // only thing with anything in it.
    stubFailedLogState();
    const view = await renderWithProviders(<LogSheet title={filmA} onClose={() => {}} />);

    // Somebody else's note, written into the cache under the key shape this used to
    // have: title only, no account. One client, so a shared key really would be
    // shared — which is what makes this test able to fail.
    view.client.setQueryData(['log-state', filmA.id], {
      bucket: 'loved',
      watchedOn: null,
      note: 'A private note belonging to somebody else',
      noteVisibility: 'private',
      noteSpoilers: false,
      exists: true,
      noteVersion: 'v1',
      ranked: false,
    });

    await waitFor(() =>
      expect(view.getByLabelText('Notes').props.accessibilityHint).toBe('Unavailable'),
    );
    expect(view.queryByText('A private note belonging to somebody else')).toBeNull();
    expect(view.queryByPlaceholderText('What did you think?')).toBeNull();
  });
});

describe('rows that lead nowhere', () => {
  it('offers none, because a permanently inert row is an invitation with nothing behind it', async () => {
    // A "Photos — Coming soon" row sat in the middle of the primary logging flow
    // for a feature nothing in the schema, the API or the PRD plans for V1. The
    // argument for keeping it was that a row for something unbuilt tells the user it
    // is coming; the argument against is that it had been telling them that for as
    // long as the app has existed. Phase G removed it.
    const sheet = await open(filmA);

    expect(sheet.queryByLabelText('Photos')).toBeNull();
    expect(sheet.queryByText(/coming soon/i)).toBeNull();
  });
});

/**
 * Who I watched with (PRD §14). The rules that matter on this side are the two the
 * server also enforces — only connected people are offered, and at most ten — plus
 * the one it cannot: each tick saves on its own, because the sheet has no Done button
 * and saving from an unmount is where writes go to be lost.
 */
describe('who I watched with', () => {
  const withPeople = (rows: unknown[]) => {
    mockFrom.mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {};
      const answer = () =>
        Promise.resolve({
          data: table === 'follows' ? rows : table === 'watch_tags' ? [] : null,
          error: null,
        });
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        // The taggable read pages to exhaustion by keyset, and the direction filter and
        // the cursor share one `or` so that each page is a single request — an
        // intersection assembled from two snapshots can name a pair that never coexisted
        // (`use-companions.ts`, independent review 21c).
        or: () => chain,
        limit: () => chain,
        gt: () => chain,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (resolve: (value: unknown) => unknown) => answer().then(resolve),
      });
      return chain;
    });
  };

  /**
   * One mutual, as the single request returns it: both directions on two rows, with the
   * profile embedded on whichever end is not the viewer.
   */
  const person = (id: string, name: string) => {
    const profile = { id, username: name.toLowerCase(), display_name: name, avatar_path: null };
    const me = { id: 'user-1', username: 'sai', display_name: 'Sai', avatar_path: null };
    return [
      { follower_id: 'user-1', followee_id: id, follower: me, followee: profile },
      { follower_id: id, followee_id: 'user-1', follower: profile, followee: me },
    ];
  };

  const openWho = async () => {
    const sheet = await open(filmA);
    await waitFor(() =>
      expect(sheet.getByLabelText('Who I watched with').props.accessibilityState.disabled).toBe(
        false,
      ),
    );
    await fireEvent.press(sheet.getByRole('button', { name: 'Who I watched with' }));
    return sheet;
  };

  it('offers the people the viewer is connected to, each once', async () => {
    // The same person appears in both the following and the follower query when the
    // follow is mutual, and a list with your closest friend in it twice is a bug people
    // notice immediately. The stand-in answers both directions from this one array, so
    // Anna arrives twice from one row — which is how the duplicate actually reaches the
    // list. Writing her in twice would instead be two rows sharing a primary key, which
    // `follows` cannot hold and `readAllByKey` now refuses outright.
    withPeople([person('u1', 'Anna'), person('u2', 'Raj')].flat());
    const sheet = await openWho();

    await waitFor(() => expect(sheet.getByLabelText('Anna')).toBeTruthy());
    expect(sheet.getAllByLabelText('Anna')).toHaveLength(1);
    expect(sheet.getByLabelText('Raj')).toBeTruthy();
  });

  it('saves the whole list on each tick rather than waiting for a close', async () => {
    withPeople([person('u1', 'Anna'), person('u2', 'Raj')].flat());
    const sheet = await openWho();
    await waitFor(() => expect(sheet.getByLabelText('Anna')).toBeTruthy());

    await fireEvent.press(sheet.getByLabelText('Anna'));
    await waitFor(() => expect(callsTo('set_watch_tags')).toHaveLength(1));
    expect(callsTo('set_watch_tags')[0][1].p_tagged_ids).toEqual(['u1']);

    await fireEvent.press(sheet.getByLabelText('Raj'));
    await waitFor(() => expect(callsTo('set_watch_tags')).toHaveLength(2));
    // The complete set, not a delta: one call is one idempotency key, and "these
    // two people" replays correctly where "add Raj" does not.
    expect(callsTo('set_watch_tags')[1][1].p_tagged_ids).toEqual(['u1', 'u2']);
  });

  it('creates the watch first, since a tag hangs off one', async () => {
    withPeople([person('u1', 'Anna')].flat());
    const sheet = await openWho();
    await waitFor(() => expect(sheet.getByLabelText('Anna')).toBeTruthy());

    await fireEvent.press(sheet.getByLabelText('Anna'));

    await waitFor(() => expect(callsTo('set_watch_tags')).toHaveLength(1));
    expect(callsTo('log_watched')).toHaveLength(1);
  });

  it('untags on a second tap', async () => {
    withPeople([person('u1', 'Anna')].flat());
    const sheet = await openWho();
    await waitFor(() => expect(sheet.getByLabelText('Anna')).toBeTruthy());

    await fireEvent.press(sheet.getByLabelText('Anna'));
    await waitFor(() => expect(callsTo('set_watch_tags')).toHaveLength(1));
    await fireEvent.press(sheet.getByLabelText('Anna'));

    await waitFor(() => expect(callsTo('set_watch_tags')).toHaveLength(2));
    expect(callsTo('set_watch_tags')[1][1].p_tagged_ids).toEqual([]);
  });

  it('stops offering more once ten are chosen', async () => {
    withPeople(
      Array.from({ length: 12 }, (_, index) => person(`u${index}`, `Friend${index}`)).flat(),
    );
    const sheet = await openWho();
    await waitFor(() => expect(sheet.getByLabelText('Friend0')).toBeTruthy());

    for (let index = 0; index < 10; index += 1) {
      await fireEvent.press(sheet.getByLabelText(`Friend${index}`));
    }

    await waitFor(() =>
      expect(sheet.getByLabelText('Friend11').props.accessibilityState.disabled).toBe(true),
    );
    // Disabled rather than hidden, so the reason the tap did nothing is visible.
    expect(sheet.getByLabelText('Friend11').props.accessibilityHint).toBe(
      'You can tag up to 10 people',
    );
    expect(sheet.getByLabelText('Friend0').props.accessibilityState.disabled).toBe(false);
  });

  it('says so plainly when nobody can be tagged yet', async () => {
    withPeople([]);
    const sheet = await openWho();

    await waitFor(() => expect(sheet.getByText('Nobody to tag yet')).toBeTruthy());
  });
});
