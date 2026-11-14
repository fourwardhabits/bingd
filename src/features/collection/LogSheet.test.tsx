import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { AppState, StyleSheet } from 'react-native';

import { queryKeys } from '@/lib/query';
import { controlRowSite, type Host } from '@/test-utils/hit-rect';
import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { addDays, addMonths, formatWatchDate, today } from './dates';
import { LogSheet, type LoggableTitle, type LogSheetProps } from './LogSheet';
import { emptyLogState } from './use-log-state';
import {
  WHEN_SESSION_IDLE_MS,
  carriedWhen,
  rememberWhen,
  resetWhenSession,
} from './when-session';

/**
 * A real local store, because the remembered share default is only meaningful across
 * compositions: what a test needs to express is "they turned it off and saved, and the
 * next new note opened off".
 */
const mockPrefs = new Map<string, unknown>();

/** Resolves the local store's reads. Replaced by a test that needs to hold one open. */
let mockPrefGate: Promise<void> = Promise.resolve();

jest.mock('@/lib/prefs', () => ({
  readPref: async (name: string) => {
    await mockPrefGate;
    return mockPrefs.get(name) ?? null;
  },
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
const filmC: LoggableTitle = { ...filmA, id: 'film-c', title: 'Film C' };

/**
 * Lets the detached default-date stamp finish.
 *
 * The stamp is deliberately not awaited before the ranking hand-off, so "it did not
 * write" can only be asserted once it has had every chance to — otherwise an absence
 * assertion passes because it ran first, not because nothing was written.
 */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

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
  // The When sitting is module memory (R4); every test starts with none, as an app
  // launch does.
  resetWhenSession();
  mockPrefs.clear();
  mockPrefGate = Promise.resolve();
  mockRpc.mockReset();
  mockFrom.mockReset();
  mockRpc.mockResolvedValue({ data: { status: 'ok' }, error: null });
  stubReads(null, null);
});

const callsTo = (fn: string) => mockRpc.mock.calls.filter(([name]) => name === fn);

/**
 * How many times a table has been read.
 *
 * `mockFrom` records the table name, so this counts reads without every stub having to
 * cooperate. It is how the reconciliation tests below assert the *refetch* rather than
 * asserting that a helper was called — independent review 21e's surviving mutant lived
 * in the missing integration, not in a weak assertion.
 */
const readsOf = (table: string) =>
  mockFrom.mock.calls.filter(([name]) => name === table).length;

/**
 * Answers one RPC with an error and everything else normally.
 *
 * The error shapes matter and are copied from what a client actually receives: a
 * SQLSTATE this app raises on purpose is a refusal, `08007` and a bare `code: ''` are
 * not (`lib/write-outcome.ts`).
 */
const failing = (fn: string, error: { code?: string; message: string }) => {
  mockRpc.mockImplementation((name: string) =>
    Promise.resolve(
      name === fn ? { data: null, error } : { data: { status: 'ok' }, error: null },
    ),
  );
};

/**
 * **One row, one name (founder simplification, 2026-08-27).**
 *
 * `user_media` holds one `note` under one `note_visibility`, and the sheet now draws
 * it as exactly one row: Note, private by default. The Review / Private note pair this
 * replaces asked the reader to choose between two names for one piece of writing
 * before writing anything — the founder's exact complaint about the sheet. "Share as
 * a review" is a chip beside the text now, an explicit act on writing that already
 * exists rather than a fork in front of it, and the row's value carries the shared
 * state so a published note says so before the composer is even opened. There is no
 * confirmation dialog anywhere in this sheet any more.
 */
const WRITING = 'Note';

const open = async (title: LoggableTitle | null, props: Partial<LogSheetProps> = {}) => {
  const view = await renderWithProviders(
    <LogSheet title={title} onClose={() => {}} surface="search" {...props} />,
  );

  return {
    ...view,
    show: (next: LoggableTitle | null) =>
      view.rerender(<LogSheet title={next} onClose={() => {}} surface="search" {...props} />),
    bucket: (label: string) => view.getByLabelText(label),
    // The row and the field it discloses share the name "Note" — which is right for
    // a screen reader, since one is a button and the other a text field — so the
    // queries here separate them by role rather than by label.
    notesRow: () => view.getByRole('button', { name: WRITING }),
    // The row is inert until `useLogState` resolves, so that nothing can be
    // decided about a note the sheet has not been told about yet. A user waits for
    // that without noticing; a test has to say so.
    openNotes: async () => {
      await waitFor(() =>
        expect(view.getByLabelText(WRITING).props.accessibilityState.disabled).toBe(false),
      );
      return fireEvent.press(view.getByRole('button', { name: WRITING }));
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

    await fireEvent.press(sheet.bucket('I liked it'));
    await waitFor(() => expect(callsTo('log_title')).toHaveLength(1));
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'a private note about Film A');

    await sheet.show(filmB);

    expect(sheet.getByText('Film B')).toBeTruthy();
    expect(sheet.bucket('I liked it').props.accessibilityState.selected).toBe(false);
  });

  it('files unsaved typing against the title it was typed for, never the second', async () => {
    const sheet = await open(filmA);

    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'a private note about Film A');
    await sheet.show(filmB);

    // The swap unmounts Film A's body, and unmount is an autosave flush point: the
    // typed text is saved rather than discarded — against the title whose sheet it
    // was typed into, because the flush was armed by the old body. Film B gets
    // nothing filed against it.
    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    expect(callsTo('log_watched')[0][1]).toMatchObject({
      p_media_item_id: 'film-a',
      p_note: 'a private note about Film A',
    });
  });
});

describe('choosing a bucket', () => {
  it('saves the bucket for the title on screen', async () => {
    const sheet = await open(filmA);

    await fireEvent.press(sheet.bucket('I didn’t like it'));

    await waitFor(() =>
      /**
       * **One call, where there were three** (T3b, 20261003000100).
       *
       * It was `set_bucket`, then a read-back of the settled row, then
       * `log_watched(today)` if that row had no date — with a race in the middle this
       * file's own subject documented as accepted. `log_title` carries the date and
       * evaluates the condition, *only when this call creates the seen row*, inside the
       * lock.
       *
       * `today_default` is the basis because the sheet offered Today and the reader did
       * not touch the row. That distinction — offered versus chosen — is the one the
       * product could not previously record, and the whole reason a backfill through
       * Search was indistinguishable from watching three hundred films today.
       */
      expect(mockRpc).toHaveBeenCalledWith('log_title', {
        p_operation_id: 'operation-1',
        p_media_item_id: 'film-a',
        p_bucket: 'not_for_me',
        p_watched_on: expect.any(String),
        p_basis: 'today_default',
      }),
    );
  });

  /** The whole point of the slice: no second tap between bucketing and comparing. */
  it('enters ranking automatically once the save lands', async () => {
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await fireEvent.press(sheet.bucket('I liked it'));

    await waitFor(() =>
      expect(onRank).toHaveBeenCalledWith('loved', 'start', { freshLog: expect.any(Boolean) }),
    );
  });

  /**
   * **What the completion screen learns about the act** (TV show & season ranking,
   * 2026-11-14). `freshLog` is the server's own `created`: true only when this tap made
   * the seen row and its first watch, which is what makes a season's placement "tied to a
   * new watch" for Update Show. A re-rating of something already collected is not.
   */
  it('tells the ranking it began with a new watch log when log_title created the row', async () => {
    mockRpc.mockImplementation((name: string) =>
      Promise.resolve({
        data:
          name === 'log_title'
            ? { status: 'ok', created: true, watch_event_id: 'w-1' }
            : { status: 'ok' },
        error: null,
      }),
    );
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await fireEvent.press(sheet.bucket('I liked it'));

    await waitFor(() =>
      expect(onRank).toHaveBeenCalledWith('loved', 'start', { freshLog: true }),
    );
  });

  it('says no new watch when the title was already in the collection', async () => {
    mockRpc.mockImplementation((name: string) =>
      Promise.resolve({
        data: name === 'log_title' ? { status: 'ok', created: false } : { status: 'ok' },
        error: null,
      }),
    );
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await fireEvent.press(sheet.bucket('I liked it'));

    await waitFor(() =>
      expect(onRank).toHaveBeenCalledWith('loved', 'start', { freshLog: false }),
    );
  });

  it('does not enter ranking when the save was refused', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'nope' } });
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await fireEvent.press(sheet.bucket('I liked it'));

    await waitFor(() => expect(sheet.getByText('nope')).toBeTruthy());
    expect(onRank).not.toHaveBeenCalled();
  });

  it('carries a new operation id each time, so a change of mind is not read as a retry', async () => {
    const sheet = await open(filmA);

    await fireEvent.press(sheet.bucket('I liked it'));
    await waitFor(() => expect(callsTo('log_title')).toHaveLength(1));
    await fireEvent.press(sheet.bucket('It was fine'));
    await waitFor(() => expect(callsTo('log_title')).toHaveLength(2));

    const [first, second] = callsTo('log_title').map(([, args]) => args.p_operation_id);
    expect(first).not.toBe(second);
  });
});

/**
 * A ranked title's bucket belongs to the ranking. `set_bucket` refuses it with 55000,
 * so a ranked title re-enters comparison instead — by `rank_rebucket` when the band is
 * moving, and by unrank-then-`rank_start` when it is not. Either way the position is
 * discarded, so neither may happen on a stray tap.
 *
 * **The same-bucket case used to do nothing at all**, which is the founder’s device
 * finding: a Loved title, Change your rating, Loved, and no response of any kind. The
 * first test below is the one that changed, and it is the regression guard.
 */
/**
 * The shared control, asserted from the surface that owns its design.
 *
 * The onboarding sheet asks the same question and used to draw its own row, which is
 * how it ended up stacked. Both suites now assert the same testID and the same
 * direction, so the two cannot part company again without one of them going red.
 */
describe('the rating control', () => {
  it('is the shared three-choice row, laid out horizontally', async () => {
    stubReads(null, null);
    const sheet = await open(filmA);

    const row = sheet.getByTestId('bucket-choices');
    const style = Array.isArray(row.props.style)
      ? Object.assign({}, ...row.props.style)
      : row.props.style;
    expect(style.flexDirection).toBe('row');
    expect(row.props.accessibilityRole).toBe('radiogroup');
    expect(sheet.getAllByRole('radio')).toHaveLength(3);
  });
});

/**
 * The bounded logging sanity check (2026-08-24).
 *
 * The question behind it: can a passive act — opening something, looking at it, backing
 * out — leave a title marked as watched. Every writer that can create collection state
 * lives in this file or in `TasteBucketSheet`, and each one sits behind a tap; these
 * pin the passive half so a future effect cannot quietly acquire a write.
 */
describe('opening the sheet and leaving', () => {
  it('writes nothing at all when it is opened and dismissed', async () => {
    stubReads(null, null);
    const sheet = await open(filmA);

    await waitFor(() =>
      expect(sheet.getByLabelText('Watch date').props.accessibilityState.disabled).toBe(false),
    );
    await sheet.show(null);

    // "How was it?" is the watch claim, and it is a question, not an answer.
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('writes nothing when the date picker is opened and closed again', async () => {
    stubReads(null, null);
    const sheet = await open(filmA);

    await sheet.openDate();
    await fireEvent.press(sheet.dateRow());
    await sheet.show(null);

    expect(mockRpc).not.toHaveBeenCalled();
  });
});

/**
 * "I watched this, but I don't remember when" (founder report, 2026-08-24).
 *
 * The sheet stamps today's date the first time a bucket is chosen, and there was no way
 * to take it back: `log_watched` coalesces its date, so passing null means *leave it
 * alone*, and nothing else could write the column. `clear_watch_date` is the one writer
 * that can (20260824000100), and the two properties worth pinning are that it does not
 * un-log the title and that the stamp cannot silently put the date back.
 */
describe('forgetting the watch date', () => {
  it('clears a stored date through clear_watch_date, and says so on the row', async () => {
    stubReads({ bucket: 'loved', watched_on: '2026-08-01', note: '' }, null);
    const sheet = await open(filmA);

    await sheet.openDate();
    await fireEvent.press(sheet.getByRole('button', { name: 'Earlier' }));

    await waitFor(() => expect(callsTo('clear_watch_date')).toHaveLength(1));
    expect(callsTo('clear_watch_date')[0][1].p_media_item_id).toBe('film-a');
    // Not through log_watched, which cannot express it.
    expect(callsTo('log_watched')).toHaveLength(0);
    await waitFor(() => expect(sheet.dateRow().props.accessibilityValue.text).toBe('Earlier'));
  });

  it('leaves the rating alone, so the title stays logged', async () => {
    stubReads({ bucket: 'loved', watched_on: '2026-08-01', note: '' }, null);
    const sheet = await open(filmA);

    await sheet.openDate();
    await fireEvent.press(sheet.getByRole('button', { name: 'Earlier' }));
    await waitFor(() => expect(callsTo('clear_watch_date')).toHaveLength(1));

    // Nothing touched the bucket, which is what keeps the title watched: a bucket is a
    // watch signal in its own right (20260815040000).
    expect(callsTo('log_title')).toHaveLength(0);
    expect(sheet.bucket('I liked it').props.accessibilityState.selected).toBe(true);
  });

  it('does not let the default stamp write the date back', async () => {
    // The failure this guards is silent: clearing leaves `watched_on` null, which is
    // exactly the condition the bucket stamp reads as "no date yet".
    stubReads({ bucket: 'loved', watched_on: '2026-08-01', note: '' }, null);
    const sheet = await open(filmA, { onRank: jest.fn() });

    await sheet.openDate();
    await fireEvent.press(sheet.getByRole('button', { name: 'Earlier' }));
    await waitFor(() => expect(callsTo('clear_watch_date')).toHaveLength(1));

    await fireEvent.press(sheet.bucket('It was fine'));

    await waitFor(() => expect(callsTo('log_title')).toHaveLength(1));
    expect(callsTo('log_watched')).toHaveLength(0);
  });

  it('shows a logged row with no date as dateless rather than as today', async () => {
    // "Today" is a pending default and only honest before the row exists. Once it does
    // and still carries no date, printing today is the sheet claiming a value it never
    // saved — which is the shape of the bug the stamp was added to fix, seen from the
    // other side.
    stubReads({ bucket: 'loved', watched_on: null, note: '' }, null);
    const sheet = await open(filmA);

    await waitFor(() => expect(sheet.dateRow().props.accessibilityValue.text).toBe('Earlier'));
  });

  it('takes a real date again after a clear', async () => {
    stubReads({ bucket: 'loved', watched_on: '2026-08-01', note: '' }, null);
    const sheet = await open(filmA);

    await sheet.openDate();
    await fireEvent.press(sheet.getByRole('button', { name: 'Earlier' }));
    await waitFor(() => expect(callsTo('clear_watch_date')).toHaveLength(1));

    await fireEvent.press(sheet.getByRole('button', { name: 'Today' }));

    /**
     * **`set_watch_date`, not `log_watched`** (T3b, §D.5). The row exists, so the date
     * goes through the writer that can say where it came from: `reader`, because the
     * reader tapped a chip. `log_watched` still works and still means what it always
     * did, but it records `unattributed` — the honest answer for a client that cannot
     * distinguish a chosen date from a defaulted one, and the wrong one for a client
     * that can.
     */
    await waitFor(() => expect(callsTo('set_watch_date')).toHaveLength(1));
    expect(callsTo('set_watch_date')[0][1]).toMatchObject({
      p_watched_on: expect.any(String),
      p_basis: 'reader',
    });
  });

  it('asks the server even when the row it can see has no date', async () => {
    // `state` lags every write this sheet makes, so "no row, no date" is also what it
    // says for the whole window after a bucket stamp or a picked date has been sent and
    // not refetched. Deciding not to call from that read is how the clear gets skipped
    // and the date it was meant to remove lands a moment later. The server answers ok
    // and creates nothing for the genuinely empty cases (20260824000100).
    stubReads(null, null);
    const sheet = await open(filmA);

    await sheet.openDate();
    await fireEvent.press(sheet.getByRole('button', { name: 'Earlier' }));

    await waitFor(() => expect(callsTo('clear_watch_date')).toHaveLength(1));
    expect(sheet.dateRow().props.accessibilityValue.text).toBe('Earlier');
    // And it still creates nothing itself.
    expect(callsTo('log_watched')).toHaveLength(0);
    expect(callsTo('log_title')).toHaveLength(0);
  });

  /**
   * Independent review 36, MAJOR. Two writes to one column, neither carrying a version
   * the server could reject a stale one by, so the one that *lands* last decides what
   * is stored — and overlapping them made that a function of network timing rather than
   * of the order the reader tapped.
   */
  it('sends contradictory date taps in the order they were made', async () => {
    stubReads({ bucket: 'loved', watched_on: '2026-08-01', note: '' }, null);

    // The clear is held open, so the date picked after it would finish first if the two
    // were allowed to overlap. Reproduces the exact race before the queue existed.
    let releaseClear: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'clear_watch_date') await held;
      return { data: { status: 'ok' }, error: null };
    });

    const sheet = await open(filmA);
    await sheet.openDate();

    await fireEvent.press(sheet.getByRole('button', { name: 'Earlier' }));
    await fireEvent.press(sheet.getByRole('button', { name: 'Today' }));

    // The second tap has not reached the server while the first is still in flight.
    expect(callsTo('set_watch_date')).toHaveLength(0);

    await act(async () => {
      releaseClear();
      await Promise.resolve();
    });

    await waitFor(() => expect(callsTo('set_watch_date')).toHaveLength(1));
    // Order, which is the whole property: the clear went first and the date the reader
    // ended on is what the server was left holding. The second writer is
    // `set_watch_date` now (T3b) and the lane it queues on is unchanged.
    const order = mockRpc.mock.calls.map(([name]) => name);
    expect(order.indexOf('clear_watch_date')).toBeLessThan(order.indexOf('set_watch_date'));
    // The row, not the chip of the same name: what the sheet claims is stored has to
    // agree with what the server was left holding.
    expect(sheet.getByLabelText('Watch date').props.accessibilityValue.text).toBe('Today');
  });
});

describe('a title that is already ranked', () => {
  beforeEach(() => {
    stubReads({ bucket: 'loved', watched_on: '2026-08-01', note: '' }, { bucket: 'loved' });
  });

  /**
   * **No confirmation, in either direction** (founder QA, 2026-09-21).
   *
   * A band tap on a ranked title used to stop on "Rank <title> again? … [Re-rank]
   * [Cancel]". The approved contract is that *Edit ranking* goes straight into the
   * comparisons — so each test below asserts the hand-off happened on the tap itself,
   * and `expectNoConfirmation` pins that none of the card's words or buttons exist, so it
   * cannot come back without turning these red.
   */
  const expectNoConfirmation = (sheet: Awaited<ReturnType<typeof open>>) => {
    expect(sheet.queryByText(/again\?/)).toBeNull();
    expect(sheet.queryByText(/Changing this will re-rank/)).toBeNull();
    expect(sheet.queryByText(/Nothing changes until you finish/)).toBeNull();
    expect(sheet.queryByRole('button', { name: 'Re-rank' })).toBeNull();
    expect(sheet.queryByRole('button', { name: 'Cancel' })).toBeNull();
  };

  it('goes straight into the comparisons when the bucket it already has is tapped', async () => {
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await waitFor(() =>
      expect(sheet.bucket('I liked it').props.accessibilityState.selected).toBe(true),
    );
    await fireEvent.press(sheet.bucket('I liked it'));

    // The bucket it went in with is the bucket it comes out with. Only the mode differs
    // from a band change, because only the opening RPC does.
    expect(onRank).toHaveBeenCalledTimes(1);
    expect(onRank).toHaveBeenCalledWith('loved', 'rerank');
    expectNoConfirmation(sheet);
  });

  it('goes straight into the comparisons when a different bucket is tapped', async () => {
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await waitFor(() =>
      expect(sheet.bucket('I liked it').props.accessibilityState.selected).toBe(true),
    );
    await fireEvent.press(sheet.bucket('It was fine'));

    expect(onRank).toHaveBeenCalledTimes(1);
    expect(onRank).toHaveBeenCalledWith('fine', 'rebucket');
    expectNoConfirmation(sheet);
  });

  /**
   * **A re-rank records no watch and writes nothing from this sheet.** The session's one
   * server call belongs to the ranking sheet (`rank_again(p_new_watch: false)` or
   * `rank_rebucket`), and the database suite asserts that neither creates a watch event.
   * What is pinned here is that the tap itself sends nothing at all — in particular none
   * of the three calls that *would* record a viewing.
   */
  it('writes nothing and records no watch on the way into a re-rank', async () => {
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await waitFor(() =>
      expect(sheet.bucket('I liked it').props.accessibilityState.selected).toBe(true),
    );
    await fireEvent.press(sheet.bucket('I liked it'));
    await fireEvent.press(sheet.bucket('It was fine'));

    expect(callsTo('log_title')).toHaveLength(0);
    expect(callsTo('log_rewatch')).toHaveLength(0);
    expect(callsTo('set_watch_date')).toHaveLength(0);
    // set_bucket would have earned a 55000; rank_rebucket does the bucket change itself.
    expect(callsTo('set_bucket')).toHaveLength(0);
    expect(callsTo('rank_rebucket')).toHaveLength(0);
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
    expect(callsTo('log_title')).toHaveLength(0);
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

  /**
   * **The note editor is a writer with a middle too**, which is the sixth instance of
   * the shape reviews 21c, 21d and 21e found four times elsewhere.
   *
   * A date and a note changed together are `log_watched` and then `save_note`. The old
   * code tracked one flag for both "did it succeed" and "is there anything to refetch",
   * so `save_note` being refused after `log_watched` had landed skipped the refresh —
   * and the sheet went on showing the old date over a row that had already moved.
   */
  it('refreshes the date that landed even when the note that followed it was refused', async () => {
    stubReads(
      { bucket: 'loved', watched_on: '2026-08-01', note: 'before', note_updated_at: 'v1' },
      null,
    );
    mockRpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'save_note'
          ? { data: null, error: { code: '42501', message: 'suspended' } }
          : { data: { status: 'ok' }, error: null },
      ),
    );

    const sheet = await open(filmA);
    await sheet.openNotes();
    await waitFor(() => expect(sheet.note().props.value).toBe('before'));
    // Typed but not blurred, so the note edit is still local when the date is pressed —
    // which is what puts both writes into one save.
    await fireEvent.changeText(sheet.note(), 'after');
    const before = readsOf('user_media');
    await sheet.openDate();
    await fireEvent.press(sheet.getByRole('button', { name: 'Yesterday' }));

    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    // The row exists, so the date goes through `set_watch_date` (T3b) while the note
    // goes through `save_note`. Two writers, one save, and the property under test is
    // unchanged: the one that LANDED must still be refetched even though the one that
    // followed it was refused.
    expect(callsTo('set_watch_date')).toHaveLength(1);
    // The date is stored. The sheet has to re-read rather than keep showing the old one.
    await waitFor(() => expect(readsOf('user_media')).toBeGreaterThan(before));
  });

  it('refreshes when a note save was never answered', async () => {
    stubReads(
      { bucket: 'loved', watched_on: '2026-08-01', note: 'before', note_updated_at: 'v1' },
      null,
    );
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '', message: 'TypeError: Network request failed' },
    });

    const sheet = await open(filmA);
    await sheet.openNotes();
    await waitFor(() => expect(sheet.note().props.value).toBe('before'));
    const before = readsOf('user_media');
    await fireEvent.changeText(sheet.note(), 'after');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    await waitFor(() => expect(readsOf('user_media')).toBeGreaterThan(before));
  });

  it('refetches on a version conflict, and keeps the typed text', async () => {
    // 55000 from `save_note` is its version conflict: another device moved the note and
    // this edit was declined. The autosave contract for it (2026-08-27): forget the
    // remembered version, re-read what is really stored so the *next* save is judged
    // against the truth, and keep the typed text on screen — silently discarding
    // writing is the one thing this sheet must never do.
    stubReads(
      { bucket: 'loved', watched_on: '2026-08-01', note: 'before', note_updated_at: 'v1' },
      null,
    );
    mockRpc.mockResolvedValue({ data: null, error: { code: '55000', message: 'stale' } });

    const sheet = await open(filmA);
    await sheet.openNotes();
    await waitFor(() => expect(sheet.note().props.value).toBe('before'));
    const before = readsOf('user_media');
    await fireEvent.changeText(sheet.note(), 'after');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    await waitFor(() => expect(readsOf('user_media')).toBeGreaterThan(before));
    // The overlay holds the writing; the problem line says what happened.
    expect(sheet.note().props.value).toBe('after');
    expect(
      sheet.getByText('This note changed somewhere else. Reopen it to see the latest.'),
    ).toBeTruthy();
  });
});

/**
 * **The autosave lane (founder correctness pass, 2026-08-27).**
 *
 * Before it, the only thing that persisted typed text was the field's blur — and React
 * Native does not fire blur on unmount, so the backdrop, the header Close, the
 * post-rank Done and a collapsed row all discarded whatever was typed. The founder met
 * it as "my review didn't save".
 *
 * The contract has two halves. Typing at rest for 1200ms is one write — never a write
 * per keystroke. And every way of leaving the field — blur, collapsing the row, Close,
 * Done, backgrounding, unmount — flushes immediately rather than waiting the debounce
 * out. The debounce is pinned under fake timers; the flush points are events and need
 * no clock. (Unmount has its own test at the top of this file, where two titles swap.)
 */
/**
 * **The typing jump, and then the label itself** (founder, 2026-08-28 and 2026-08-29).
 *
 * The first report was Android: while typing in the Note, everything below one element
 * moved down two or three millimetres and immediately came back. The sheet frame, the
 * top of the screen and the keyboard were all stationary — so it was never keyboard
 * avoidance and never a snap point.
 *
 * The element was the "Saving…" line. It is a `footnote` — 18pt of line height — and it
 * *mounted and unmounted* above `styles.rows`, which is the Note composer and every row
 * beneath it. The autosave lane fires on a 1.2s trailing debounce with a max-wait cap,
 * so an ordinary sentence arms it repeatedly.
 *
 * That pass reserved the line, which stopped the movement. The founder's second report
 * is that it did not stop the *noise*: the label still appeared and disappeared several
 * times per sentence, and a status that flickers while somebody is typing is not
 * information whether or not it moves the page. So the successful path says nothing at
 * all, and the reserved box goes with it — there is nothing transient left to hold room
 * for.
 *
 * **What must not have changed is the saving.** Those tests are the rest of this file:
 * the debounce, the max-wait, and every flush point — blur, collapse, Close, Done,
 * background, unmount. This block asserts only what the founder's second report is
 * about, plus the one thing hiding a status could have broken, which is a failure the
 * reader can no longer see.
 */
describe('a successful autosave says nothing', () => {
  it('mounts no status at all before anything is being saved', async () => {
    const sheet = await open(filmA);
    await sheet.openNotes();
    expect(sheet.queryByText('Saving…')).toBeNull();
    // And no reserved box either. It existed only to stop the label moving the rows,
    // and a blank slot for a label that never comes is dead space on every open.
    expect(sheet.queryByTestId('log-status-slot')).toBeNull();
  });

  it('mounts none while a save is in flight', async () => {
    // The write is held open, the way `clear_watch_date` is held elsewhere in this
    // file. Without it the save is over inside one commit and there is no in-flight
    // state to look at — which is also why the founder saw a *flash*.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'log_watched') await held;
      return { data: { status: 'ok' }, error: null };
    });

    const sheet = await open(filmA);
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'a thought worth keeping');

    // The debounce is real — see the lane's own note on why fake timers poison this
    // file. Waiting for the call rather than for a label is the point: the write is
    // demonstrably running, and there is still nothing on screen about it.
    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1), { timeout: 3000 });
    expect(sheet.queryByText('Saving…')).toBeNull();
    expect(sheet.queryByTestId('log-status-slot')).toBeNull();

    await act(async () => {
      release();
      await held;
    });
  });

  it('still writes what was typed, on the same debounce', async () => {
    // The guarantee the silence must not have cost. One write for a settled sentence,
    // carrying the text, exactly as before.
    const sheet = await open(filmA);
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'a thought worth keeping');
    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1), { timeout: 3000 });
    expect(callsTo('log_watched')[0][1].p_note).toBe('a thought worth keeping');
  });

  it('mounts nothing across a burst of keystrokes', async () => {
    // The founder's actual gesture: a burst that arms the lane several times over.
    // Every keystroke is a render of this sheet, and none of them may put a line on
    // screen or take one away.
    const sheet = await open(filmA);
    await sheet.openNotes();
    for (const text of ['o', 'on', 'one', 'one t', 'one tw', 'one two']) {
      await fireEvent.changeText(sheet.note(), text);
      expect(sheet.queryByText('Saving…')).toBeNull();
      expect(sheet.queryByTestId('log-status-slot')).toBeNull();
    }
  });

  it('but a refused save is still visible, and still retries', async () => {
    // **The one thing hiding a status could have broken.** A save that fails is
    // unresolved, and an unresolved failure the reader cannot see is worse than the
    // flicker this pass removed. The message names what happened and the next flush
    // retries — a save is never silently pretended.
    stubReads(
      { bucket: 'loved', watched_on: null, note: 'before', note_updated_at: 'v1' },
      null,
    );
    failing('save_note', { code: '22023', message: 'nope' });

    const sheet = await open(filmA);
    await sheet.openNotes();
    await waitFor(() => expect(sheet.note().props.value).toBe('before'));
    await fireEvent.changeText(sheet.note(), 'after');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    await waitFor(() => expect(sheet.getByText('nope')).toBeTruthy());
    // Drawn in the slot the transient label used to share, which now exists only when
    // there is a real event to put in it.
    expect(sheet.queryByTestId('log-status-slot')).toBeTruthy();
  });
});
describe('the autosave lane', () => {
  it('saves once when typing rests, not once per keystroke', async () => {
    // Real timers, deliberately. Faking the clock here poisons the process: React
    // Native's Promise polyfill flushes on `setImmediate` and React's scheduler
    // shares the same clock, so a fake-timer window either stalls the save this test
    // exists to observe or strands scheduled work when the real clock returns — and
    // the strand outlives the test. 1200ms of real waiting is the honest version.
    const sheet = await open(filmA);
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'one');
    await fireEvent.changeText(sheet.note(), 'one two');
    await fireEvent.changeText(sheet.note(), 'one two three');
    // Three keystroke bursts inside the window: nothing has been written yet.
    expect(callsTo('log_watched')).toHaveLength(0);

    // The debounce elapses for real, and the burst collapses into one write.
    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1), { timeout: 3000 });
    // The save carries what was in the field when the timer fired, not what armed it.
    expect(callsTo('log_watched')[0][1].p_note).toBe('one two three');
    expect(callsTo('save_note')).toHaveLength(0);

    // And it stays one write: a debounce that had leaked a timer per keystroke would
    // land its stragglers in this window.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });
    expect(callsTo('log_watched')).toHaveLength(1);
  });

  /**
   * Review 66, Majors 1 and 2. `state.exists` lags every write by a refetch, and the
   * first draft of the lane kept trusting it: the second save after the row's own
   * creation still went through `log_watched`, which coalesces (a clear resurrects)
   * and checks no version (another device's edit is overwritten). The sheet now
   * answers "does the row exist" from its own acknowledged writes as well.
   */
  it('moves to the assigning writer the moment its own write has created the row', async () => {
    const sheet = await open(filmA);
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'first thought');
    await fireEvent(sheet.note(), 'blur');
    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));

    // The query has not refetched — the stub never mirrors — so `state.exists` is
    // still false. The sheet must not care: it created the row itself.
    await fireEvent.changeText(sheet.note(), 'first thought, refined');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    expect(callsTo('save_note')[0][1].p_note).toBe('first thought, refined');
    expect(callsTo('log_watched')).toHaveLength(1);
  });

  it('clears a note it only just created', async () => {
    // The sharpest corner of the same staleness: the cleared field equals the stale
    // read (`'' === ''`), so a change-detector trusting the query alone writes
    // nothing at all and the old text resurrects on reopen. The lane remembers what
    // it last sent, and a clear against that is a change.
    const sheet = await open(filmA);
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'a passing thought');
    await fireEvent(sheet.note(), 'blur');
    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));

    await fireEvent.changeText(sheet.note(), '');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    expect(callsTo('save_note')[0][1].p_note).toBe('');
  });

  it('saves mid-stream once typing has outrun the max wait', async () => {
    // A trailing debounce alone re-arms on every keystroke, so a sentence typed
    // without a pause would ride unsaved for its whole length (review 66b). Once
    // dirty text has waited AUTOSAVE_MAX_WAIT, the next keystroke saves instead.
    //
    // The loop stops the moment a save appears rather than typing for a fixed
    // wall time: on a slow CI runner the fixed version outlived the suite's 15s
    // budget (the release gate's one red on the first run of this tranche). If
    // the runner is slow enough that a gap exceeds the ordinary debounce, the
    // trailing timer fires instead — either way a save lands mid-stream, which
    // is the contract: typing, however continuous, cannot stay unsaved.
    const sheet = await open(filmA);
    await sheet.openNotes();
    const started = Date.now();
    let draft = 'no';
    while (callsTo('log_watched').length === 0 && Date.now() - started < 10_000) {
      draft += ' pause';
      await fireEvent.changeText(sheet.note(), draft);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
      });
    }

    // The save fired during the stream — before any blur, close or rest the
    // reader chose to take.
    expect(callsTo('log_watched').length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('converges when a first save loses its reply and the text has moved on', async () => {
    // 08007: the first write may have committed. The retry is a new intent with the
    // current text, and `log_watched` assigns the new text over whatever landed —
    // `coalesce(excluded.note, …)` takes the non-null new value — so the two
    // outcomes of the ambiguous first write converge on what is in the field.
    failing('log_watched', { code: '08007', message: 'connection lost' });
    const sheet = await open(filmA);
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'the first attempt');
    await fireEvent(sheet.note(), 'blur');
    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));

    mockRpc.mockImplementation(() => Promise.resolve({ data: { status: 'ok' }, error: null }));
    await fireEvent.changeText(sheet.note(), 'the second thought');
    await fireEvent(sheet.note(), 'blur');

    // Still the coalescing writer — an unacknowledged write proves no row — and it
    // carries the current text, which is what makes the retry safe either way.
    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(2));
    expect(callsTo('log_watched')[1][1].p_note).toBe('the second thought');
  });

  it('saves what was typed when the sheet is closed from its header', async () => {
    const sheet = await open(filmA);
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'typed and then closed');

    // No blur first — the thumb goes straight from the field to Close, which is
    // exactly the sequence that used to lose the text.
    await fireEvent.press(sheet.getByLabelText('Close'));

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    expect(callsTo('log_watched')[0][1].p_note).toBe('typed and then closed');
  });

  it('saves what was typed when Done ends the post-rank flow', async () => {
    const onDone = jest.fn();
    const sheet = await open(filmA, {
      postRank: { score: 8.7, position: 3, category: 'movies' },
      onDone,
    });
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'written at the finish line');

    await fireEvent.press(sheet.getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    expect(callsTo('log_watched')[0][1].p_note).toBe('written at the finish line');
    expect(onDone).toHaveBeenCalled();
  });

  it('saves what was typed when the Note row is collapsed', async () => {
    const sheet = await open(filmA);
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'folded away mid-thought');

    await fireEvent.press(sheet.notesRow());

    // The composer is gone and the text is not: collapsing is a leave-the-field event
    // like any other.
    expect(sheet.queryByPlaceholderText('What did you think?')).toBeNull();
    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    expect(callsTo('log_watched')[0][1].p_note).toBe('folded away mid-thought');
  });

  it('saves what was typed when the app is backgrounded', async () => {
    // The subscription is captured rather than simulated: the stand-in takes the
    // OS's place, and invoking the handler is the app going to the background
    // mid-sentence. Swapped by assignment rather than `jest.spyOn`: the preset
    // already ships this method as a mock, and `mockRestore` on a pre-existing mock
    // strips its implementation — after which every later mount subscribes into
    // undefined and every unmount in the rest of the suite falls over.
    const handlers: Array<(next: string) => void> = [];
    const realSubscribe = AppState.addEventListener;
    AppState.addEventListener = ((_type: string, handler: (next: string) => void) => {
      handlers.push(handler);
      return { remove: () => {} };
    }) as unknown as typeof AppState.addEventListener;

    try {
      const sheet = await open(filmA);
      await sheet.openNotes();
      await fireEvent.changeText(sheet.note(), 'interrupted by a phone call');
      expect(callsTo('log_watched')).toHaveLength(0);

      await act(async () => {
        for (const handler of handlers) handler('background');
      });

      await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
      expect(callsTo('log_watched')[0][1].p_note).toBe('interrupted by a phone call');
    } finally {
      AppState.addEventListener = realSubscribe;
    }
  });

  it('shows the problem and retries on the next flush when a save is refused', async () => {
    // A save that fails is still unsaved writing. The failure re-arms the dirty flag,
    // so the next leave-the-field event retries rather than treating the refusal as
    // the end of the story — a save is never silently pretended.
    stubReads(
      { bucket: 'loved', watched_on: null, note: 'before', note_updated_at: 'v1' },
      null,
    );
    failing('save_note', { code: '22023', message: 'nope' });

    const sheet = await open(filmA);
    await sheet.openNotes();
    await waitFor(() => expect(sheet.note().props.value).toBe('before'));
    await fireEvent.changeText(sheet.note(), 'after');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    await waitFor(() => expect(sheet.getByText('nope')).toBeTruthy());

    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('save_note')).toHaveLength(2));
    expect(callsTo('save_note')[1][1].p_note).toBe('after');
  });

  it('bases a chained save on the version the last reply returned', async () => {
    // `state.noteVersion` lags every save by an invalidation round trip, so a second
    // autosave inside that window carrying the query's answer would 55000 against
    // this sheet's own predecessor. The reply's `note_version` is the base instead —
    // whichever of the two is newer by instant, which only real timestamps can say.
    const storedAt = '2026-08-27T10:00:00.000Z';
    const savedAt = '2026-08-27T10:00:05.000Z';
    stubReads(
      { bucket: 'loved', watched_on: null, note: 'first', note_updated_at: storedAt },
      null,
    );
    mockRpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'save_note'
          ? { data: { status: 'ok', note_version: savedAt }, error: null }
          : { data: { status: 'ok' }, error: null },
      ),
    );

    const sheet = await open(filmA);
    await sheet.openNotes();
    await waitFor(() => expect(sheet.note().props.value).toBe('first'));

    await fireEvent.changeText(sheet.note(), 'first, extended');
    await fireEvent(sheet.note(), 'blur');
    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    expect(callsTo('save_note')[0][1].p_base_updated_at).toBe(storedAt);

    await fireEvent.changeText(sheet.note(), 'first, extended twice');
    await fireEvent(sheet.note(), 'blur');
    await waitFor(() => expect(callsTo('save_note')).toHaveLength(2));
    expect(callsTo('save_note')[1][1].p_base_updated_at).toBe(savedAt);
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
  /**
   * The control is now the *publish* act rather than its absence: checked means the
   * note is shared as a review. It used to be "Only me", off by default, which made
   * keeping a note to yourself the thing you had to notice.
   */
  const reviewToggle = (sheet: Awaited<ReturnType<typeof open>>) =>
    sheet.getByLabelText('Share this note as a public review');

  /**
   * **Both claims answer 44pt in the composer, and nothing in it moves** (A11Y-44,
   * design-system v3 A.2 #12). Measured in the real note box (gutter padding, `space[2]`
   * gap) at 360pt, where the two chips wrap, and at a width where they share a line; the
   * chips stay `space[2]` from the field above and the caption below (`hit-rect.ts`).
   */
  it('gives both claims a 44pt target without moving the chips or the gaps', async () => {
    const sheet = await open(filmA);
    await sheet.openNotes();
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

  it('opens a first-ever note private: publishing is the reader’s own act', async () => {
    /**
     * **Private again, by the founder's rule of 2026-11-04.** It opened shared from
     * 2026-09-06, and with the details above the buckets (Option A) that published a
     * first note as a review a second after typing paused — before the title was even
     * ranked. A note is a public review only once its reader turns this on.
     */
    const sheet = await open(filmA);
    await sheet.openNotes();
    await waitFor(() =>
      expect(reviewToggle(sheet).props.accessibilityState.checked).toBe(false),
    );
    expect(sheet.getByText('Only you can read this.')).toBeTruthy();
    // Spoilers stay independent and stay off.
    expect(spoilerToggle(sheet).props.accessibilityState.checked).toBe(false);
  });

  it('writes a first note private when the reader was only logging', async () => {
    const sheet = await open(filmA);
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'just for me');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    expect(callsTo('log_watched')[0][1].p_note_visibility).toBe('private');
  });

  it('shares a first note only once the reader turns Share as a review on', async () => {
    const sheet = await open(filmA);
    await sheet.openNotes();
    await fireEvent.press(reviewToggle(sheet));
    await fireEvent.changeText(sheet.note(), 'everyone should see this');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    expect(callsTo('log_watched')[0][1].p_note_visibility).toBe('public');
  });

  /**
   * The other half of the same decision. "Write a review" on the title page is a
   * request to publish, and a sheet that quietly saved it privately would be its own
   * broken promise — so the intent, and only the intent, moves the starting state.
   */
  it('opens public when the reader came through Write a review', async () => {
    const sheet = await open(filmA, { noteIntent: 'review' });
    // One row now, so the intent has exactly one job left: it seeds the visibility of
    // a note that does not exist yet, and the chip shows the seeded state.
    await sheet.openNotes();

    expect(reviewToggle(sheet).props.accessibilityState.checked).toBe(true);
    expect(sheet.getByText(/Shown with your rating/)).toBeTruthy();
  });

  /**
   * **Intent never outranks a stored value.** Somebody who wrote a private note and
   * later taps "Write a review" on the same title must not have the note they already
   * have republished under them.
   */
  it('leaves a stored private note private even when opened to write a review', async () => {
    stubReads(
      {
        bucket: 'loved',
        watched_on: null,
        note: 'kept back',
        note_updated_at: 'v1',
        note_visibility: 'private',
        note_has_spoilers: false,
      },
      null,
    );
    const sheet = await open(filmA, { noteIntent: 'review' });
    await sheet.openNotes();

    await waitFor(() => expect(sheet.note().props.value).toBe('kept back'));
    expect(reviewToggle(sheet).props.accessibilityState.checked).toBe(false);
    expect(sheet.getByText('Only you can read this.')).toBeTruthy();
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
    await waitFor(() =>
      expect(reviewToggle(sheet).props.accessibilityState.checked).toBe(false),
    );
    expect(sheet.getByText('Only you can read this.')).toBeTruthy();

    // Editing the text must carry the stored visibility rather than the default.
    await fireEvent.changeText(sheet.note(), 'edited, still mine');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    expect(callsTo('save_note')[0][1].p_note_visibility).toBe('private');
  });

  it('writes the spoiler claim with a first note', async () => {
    // Through the review door, so the spoiler claim is being made about something
    // that will actually be shown to somebody.
    const sheet = await open(filmA, { noteIntent: 'review' });
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
    // A stored public note opens on its saved visibility, so the chip arrives ticked.
    await sheet.openNotes();
    await waitFor(() => expect(sheet.note().props.value).toBe('out in the open'));

    // Unticking "Share as a review" is how a published note is taken back.
    await waitFor(() =>
      expect(reviewToggle(sheet).props.accessibilityState.checked).toBe(true),
    );
    await fireEvent.press(reviewToggle(sheet));

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

    await waitFor(() =>
      expect(spoilerToggle(sheet).props.accessibilityState.checked).toBe(true),
    );
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
    const notes = sheet.getByLabelText(WRITING);
    expect(notes.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(notes);
    expect(sheet.queryByPlaceholderText('What did you think?')).toBeNull();

    slow.release();
    await waitFor(() => expect(sheet.notesRow().props.accessibilityState.disabled).toBe(false));

    await sheet.openNotes();
    await waitFor(() => expect(sheet.note().props.value).toBe('written when this was private'));
    // The stored visibility, not the default the sheet was showing a moment ago.
    expect(reviewToggle(sheet).props.accessibilityState.checked).toBe(false);
    expect(sheet.getByText('Only you can read this.')).toBeTruthy();
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

    /**
     * The claim is now structural rather than argumentary. `set_watch_date` **has no
     * note parameters at all**, so a date-only save cannot republish a note the reader
     * was not editing — where before the test had to assert three explicit nulls on a
     * writer that could have carried them.
     */
    await waitFor(() => expect(callsTo('set_watch_date')).toHaveLength(1));
    expect(Object.keys(callsTo('set_watch_date')[0][1])).toEqual([
      'p_operation_id',
      'p_media_item_id',
      'p_watched_on',
      'p_basis',
    ]);
    expect(callsTo('log_watched')).toHaveLength(0);
  });
});

describe('the watch date', () => {
  /**
   * ---------------------------------------------------------------------------
   * **THE RACE THESE TESTS PINNED NO LONGER EXISTS** (T3b, 20261003000100)
   *
   * Five tests lived here, and between them they described one architecture: the sheet
   * tapped `set_bucket`, read the settled row back, decided from that answer whether the
   * title already had a date, and then stamped `log_watched(today)` in a floating
   * promise. Three of them were about the window in the middle — a cached "no date", a
   * refetch still in flight, a tap that raced the read — and this file's own subject
   * documented the residual as accepted, because closing it needed *"a server-side
   * conditional write, which the beta accepts as a residual risk"*.
   *
   * `log_title` is that conditional write. The sheet sends the bucket **and** the date
   * in one call and stops deciding anything: the server evaluates *only when this call
   * creates the seen row* inside the lock, so a date recorded on another device a
   * millisecond ago is seen by the test that matters.
   *
   * So the client no longer has a "does this title already have a date?" question to get
   * wrong, and tests that pin its answer would be pinning a deleted mechanism. What
   * replaces them is the smaller, truer claim: **the sheet always sends what its row
   * says, and never sends a second write to correct itself.** The behaviour those five
   * protected — a stored date is never overwritten — is asserted where it now lives, in
   * `supabase/tests/watch-events.test.mjs` ("on an ALREADY-SEEN title it sets the bucket
   * and ignores the date").
   */
  it('sends the date with the bucket, in one call and with the basis that produced it', async () => {
    const sheet = await open(filmA);

    await waitFor(() => expect(sheet.dateRow().props.accessibilityState.disabled).toBe(false));
    await fireEvent.press(sheet.bucket('I liked it'));

    await waitFor(() => expect(callsTo('log_title')).toHaveLength(1));
    const args = callsTo('log_title')[0][1];
    expect(args.p_watched_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The sheet offered Today and the reader did not touch the row. That is
    // `today_default` and not `reader`, and the difference is the whole provenance
    // model: nothing before this could tell an offered date from a chosen one.
    expect(args.p_basis).toBe('today_default');

    // And no second write to correct the first. The stamp is gone.
    expect(callsTo('log_watched')).toHaveLength(0);
  });

  it('sends its date even on a title that already has one, because the server decides', async () => {
    // The old sheet withheld the date here, from a read it had to wait for. It sends it
    // now and the server ignores it — which is the same outcome reached by the party
    // that can actually see whether the row existed a moment ago.
    stubReads({ bucket: null, watched_on: '2020-03-04', note: null }, null);
    const sheet = await open(filmA);

    await waitFor(() => expect(sheet.dateRow().props.accessibilityState.disabled).toBe(false));
    expect(sheet.dateRow().props.accessibilityValue.text).not.toBe('Today');

    await fireEvent.press(sheet.bucket('I liked it'));

    await waitFor(() => expect(callsTo('log_title')).toHaveLength(1));
    expect(callsTo('log_watched')).toHaveLength(0);
  });

  it('does not wait for the read before writing, because it no longer has to', async () => {
    // The window three deleted tests were about. A tap while the stored date is still in
    // flight used to be the dangerous case; it is now the ordinary one, and it costs one
    // round trip instead of two.
    const { release } = stubSlowReads(
      { bucket: null, watched_on: '2020-03-04', note: null },
      null,
    );
    const sheet = await open(filmA);

    await fireEvent.press(sheet.bucket('I liked it'));
    await waitFor(() => expect(callsTo('log_title')).toHaveLength(1));

    release();

    await waitFor(() => expect(sheet.dateRow().props.accessibilityState.disabled).toBe(false));
    expect(sheet.dateRow().props.accessibilityValue.text).not.toBe('Today');
    // No late stamp, because there is no late stamp to make.
    expect(callsTo('log_watched')).toHaveLength(0);
    expect(callsTo('log_title')).toHaveLength(1);
  });

  it('says Earlier when the reader has said so, and sends no date at all', async () => {
    const sheet = await open(filmA);
    await waitFor(() => expect(sheet.dateRow().props.accessibilityState.disabled).toBe(false));

    await sheet.openDate();
    await fireEvent.press(sheet.getByText('Earlier'));

    await waitFor(() => expect(sheet.dateRow().props.accessibilityValue.text).toBe('Earlier'));

    await fireEvent.press(sheet.bucket('I liked it'));
    await waitFor(() => expect(callsTo('log_title')).toHaveLength(1));
    const args = callsTo('log_title')[0][1];
    expect(args.p_watched_on).toBeNull();
    expect(args.p_basis).toBe('none');
  });

  it('shows a stored date rather than today', async () => {
    stubReads({ bucket: null, watched_on: '2020-03-04', note: null }, null);
    const sheet = await open(filmA);

    // Waiting on the row being enabled rather than on its text not being 'Today':
    // before the read lands the row has no text at all, which is also not 'Today',
    // and this test would have passed without ever seeing the date it is about.
    await waitFor(() => expect(sheet.dateRow().props.accessibilityState.disabled).toBe(false));
    expect(sheet.dateRow().props.accessibilityValue.text).not.toBe('Today');
  });
});

/**
 * **Ranking now is not watching now** (T0b, 2026-09-19).
 *
 * A title can already be in the collection with no watch date: an imported film with
 * no diary entry, an onboarding pick whose comparisons were abandoned, an earlier
 * "Earlier". The sheet displayed each of those as dateless — and the moment one was
 * ranked, the default-date stamp wrote today onto it anyway, because it asked only "is
 * there a date?" and never "was this title already here?". That fabricated a current
 * watch that counted toward this year's goal and this month's leaderboard.
 *
 * The invariant: a title that was already seen before this sheet began keeps exactly
 * the date it had, including none. Only a title logged for the first time gets Today.
 */
describe('ranking a title that was already seen', () => {
  it('does not stamp today onto a seen title with no date when it is ranked', async () => {
    stubReads({ bucket: null, watched_on: null, note: '' }, null);
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });
    await waitFor(() => expect(sheet.dateRow().props.accessibilityState.disabled).toBe(false));

    await fireEvent.press(sheet.bucket('I liked it'));
    await waitFor(() =>
      expect(onRank).toHaveBeenCalledWith('loved', 'start', { freshLog: expect.any(Boolean) }),
    );
    await settle();

    // One bucket write, the hand-off to ranking — and nothing about a date.
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['log_title']);
    expect(sheet.dateRow().props.accessibilityValue.text).toBe('Earlier');
  });

  it('writes no date when a note is added to a seen title with no date', async () => {
    stubReads({ bucket: 'fine', watched_on: null, note: '' }, null);
    const sheet = await open(filmA);

    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'better than I remembered');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    expect(callsTo('log_watched')).toHaveLength(0);
    expect(sheet.dateRow().props.accessibilityValue.text).toBe('Earlier');
  });

  it('ranks an imported title in its Letterboxd bucket without claiming a watch today', async () => {
    // The importer wrote the bucket from the star rating and, with no diary entry, no
    // date. Choosing that same bucket here is the ordinary way to rank it.
    stubReads({ bucket: 'loved', watched_on: null, note: '' }, null);
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });
    await waitFor(() =>
      expect(sheet.bucket('I liked it').props.accessibilityState.selected).toBe(true),
    );

    await fireEvent.press(sheet.bucket('I liked it'));
    await waitFor(() =>
      expect(onRank).toHaveBeenCalledWith('loved', 'start', { freshLog: expect.any(Boolean) }),
    );
    await settle();

    expect(callsTo('log_title')).toHaveLength(1);
    expect(callsTo('log_watched')).toHaveLength(0);
  });

  it('does not stamp an onboarding pick even when the bucket is tapped before its read lands', async () => {
    // Onboarding buckets with `set_bucket` and never writes a date; this pick's
    // comparisons were abandoned, so it is seen, unranked and undated. The tap races
    // the read, which is the window where the old stamp decided from a read taken
    // after its own bucket write.
    const { release } = stubSlowReads({ bucket: 'fine', watched_on: null, note: '' }, null);
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await fireEvent.press(sheet.bucket('It was fine'));
    await waitFor(() => expect(callsTo('log_title')).toHaveLength(1));
    release();

    await waitFor(() => expect(sheet.dateRow().props.accessibilityState.disabled).toBe(false));
    await settle();
    expect(callsTo('log_watched')).toHaveLength(0);
    expect(sheet.dateRow().props.accessibilityValue.text).toBe('Earlier');
  });

  it('re-ranks a ranked onboarding pick with no date and still writes no date', async () => {
    stubReads({ bucket: 'loved', watched_on: null, note: '' }, { bucket: 'loved' });
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });
    await waitFor(() =>
      expect(sheet.bucket('I liked it').props.accessibilityState.selected).toBe(true),
    );

    // One tap: the band is the decision, and there is no confirmation to press.
    await fireEvent.press(sheet.bucket('I liked it'));
    await settle();

    expect(onRank).toHaveBeenCalledWith('loved', 'rerank');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

/**
 * **A title logged for the first time** — the ordinary current-watch log, unchanged:
 * Today unless the reader says otherwise, Earlier for no date, and a picked date kept.
 */
describe('logging a title for the first time', () => {
  it('dates it today when the reader leaves the default, exactly as the row promised', async () => {
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });
    await waitFor(() => expect(sheet.dateRow().props.accessibilityValue?.text).toBe('Today'));

    await fireEvent.press(sheet.bucket('I liked it'));

    await waitFor(() => expect(callsTo('log_title')).toHaveLength(1));
    expect(callsTo('log_title')[0][1]).toMatchObject({
      p_watched_on: today(),
      // The sheet offered Today and the reader kept it, which is exactly what
      // `today_default` records and what `reader` would have claimed falsely.
      p_basis: 'today_default',
    });
    expect(onRank).toHaveBeenCalledWith('loved', 'start', { freshLog: expect.any(Boolean) });
    /**
     * **One call, and it used to be two.** `set_bucket` then `log_watched` was the
     * shape, with a read-back between them and a race this file documented as accepted.
     * The whole sequence from this sheet is now a single `log_title`, and the condition
     * that decided whether to send a date at all is evaluated by the server, inside the
     * lock, where it can actually see whether the row existed a moment ago.
     */
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['log_title']);
  });

  it('logs it seen with no date at all when the reader chooses Earlier', async () => {
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await sheet.openDate();
    await fireEvent.press(sheet.getByRole('button', { name: 'Earlier' }));
    await fireEvent.press(sheet.bucket('I liked it'));
    await waitFor(() =>
      expect(onRank).toHaveBeenCalledWith('loved', 'start', { freshLog: expect.any(Boolean) }),
    );
    await settle();

    expect(callsTo('log_title')).toHaveLength(1);
    expect(callsTo('log_watched')).toHaveLength(0);
    expect(sheet.dateRow().props.accessibilityValue.text).toBe('Earlier');
  });

  it('keeps a date picked from the calendar, and the bucket does not stamp over it', async () => {
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });
    // The 15th of last month: always in the past, never Today or Yesterday.
    const picked = `${addMonths(today(), -1).slice(0, 8)}15`;

    await sheet.openDate();
    await fireEvent.press(sheet.getByRole('button', { name: 'Pick a date' }));
    await fireEvent.press(sheet.getByRole('button', { name: 'Previous month' }));
    await fireEvent.press(sheet.getByRole('button', { name: formatWatchDate(picked) }));
    // The row does not exist yet, so the date write is what creates it — which is what
    // `log_watched` can do and `set_watch_date` deliberately cannot.
    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));

    await fireEvent.press(sheet.bucket('I liked it'));
    await waitFor(() =>
      expect(onRank).toHaveBeenCalledWith('loved', 'start', { freshLog: expect.any(Boolean) }),
    );
    await settle();

    // Every date that reached the server is the one the reader picked.
    expect(callsTo('log_watched').map(([, args]) => args.p_watched_on)).not.toContain(today());
    expect(new Set(callsTo('log_watched').map(([, args]) => args.p_watched_on))).toEqual(
      new Set([picked]),
    );
  });
});

/**
 * **The reader's own last answer, carried to the next title** (founder decision R4,
 * 2026-09-19).
 *
 * Somebody backfilling a library logs film after film they saw years ago. Each one
 * opening on Today meant either an extra tap per film or a false current date per film.
 * An explicit Earlier now carries to the next new title for the rest of the sitting —
 * visibly, with Today one tap away — and an explicit Today switches it back. Nothing
 * is inferred: the only inputs are those two taps.
 */
describe('the When row carries an explicit choice through a logging sitting', () => {
  it('opens the next new title on Earlier, visibly, after the reader chose Earlier', async () => {
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await sheet.openDate();
    await fireEvent.press(sheet.getByRole('button', { name: 'Earlier' }));
    await fireEvent.press(sheet.bucket('I liked it'));
    await waitFor(() => expect(onRank).toHaveBeenCalledTimes(1));

    await sheet.show(filmB);

    await waitFor(() => expect(sheet.dateRow().props.accessibilityValue.text).toBe('Earlier'));
    // On screen without opening anything: the answer the sheet is carrying is visible,
    // and Today is one tap away rather than behind a collapsed row.
    expect(sheet.dateRow().props.accessibilityState.expanded).toBe(true);
    expect(
      sheet.getByRole('button', { name: 'Earlier' }).props.accessibilityState.selected,
    ).toBe(true);
    expect(sheet.getByRole('button', { name: 'Today' }).props.accessibilityState.selected).toBe(
      false,
    );

    await fireEvent.press(sheet.bucket('It was fine'));
    await waitFor(() => expect(onRank).toHaveBeenCalledTimes(2));
    await settle();
    expect(callsTo('log_watched')).toHaveLength(0);
  });

  it('switches back to Today for the next title when the reader explicitly chooses Today', async () => {
    rememberWhen('user-1', 'earlier');
    const sheet = await open(filmB);
    await waitFor(() => expect(sheet.dateRow().props.accessibilityValue.text).toBe('Earlier'));

    await fireEvent.press(sheet.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    expect(callsTo('log_watched')[0][1].p_watched_on).toBe(today());
    // The calendar stays where the reader's thumb is.
    expect(sheet.dateRow().props.accessibilityState.expanded).toBe(true);
    expect(carriedWhen('user-1')).toBe('today');

    await sheet.show(filmC);

    await waitFor(() => expect(sheet.dateRow().props.accessibilityValue.text).toBe('Today'));
    expect(sheet.dateRow().props.accessibilityState.expanded).toBe(false);
  });

  it('leaves the carried mode alone when a specific date is picked', async () => {
    rememberWhen('user-1', 'earlier');
    const sheet = await open(filmA);
    await waitFor(() => expect(sheet.dateRow().props.accessibilityValue.text).toBe('Earlier'));

    await fireEvent.press(sheet.getByRole('button', { name: 'Yesterday' }));

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    // A date is a fact about this title and says nothing about the next one.
    expect(carriedWhen('user-1')).toBe('earlier');
  });

  it('opens on the ordinary Today once the sitting has been idle for about thirty minutes', async () => {
    const start = Date.now();
    rememberWhen('user-1', 'earlier', start);
    // Only for the mount, which is when the sheet reads the sitting; the test's own
    // waiting must keep a moving clock.
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start + WHEN_SESSION_IDLE_MS + 1);
    let sheet: Awaited<ReturnType<typeof open>>;
    try {
      sheet = await open(filmA);
    } finally {
      clock.mockRestore();
    }

    await waitFor(() => expect(sheet.dateRow().props.accessibilityValue?.text).toBe('Today'));
    expect(sheet.dateRow().props.accessibilityState.expanded).toBe(false);
  });

  it('opens on the ordinary Today after an app restart', async () => {
    rememberWhen('user-1', 'earlier');
    // A launch starts with no module memory, which is what a reset is.
    resetWhenSession();
    const sheet = await open(filmA);

    await waitFor(() => expect(sheet.dateRow().props.accessibilityValue?.text).toBe('Today'));
  });

  it('does not carry into a title already in the collection, which keeps its own date', async () => {
    rememberWhen('user-1', 'earlier');
    stubReads({ bucket: 'loved', watched_on: '2020-03-04', note: '' }, null);
    const sheet = await open(filmA);

    await waitFor(() => expect(sheet.dateRow().props.accessibilityState.disabled).toBe(false));
    expect(sheet.dateRow().props.accessibilityValue.text).toBe(formatWatchDate('2020-03-04'));
    expect(sheet.dateRow().props.accessibilityState.expanded).toBe(false);
  });

  /**
   * *Log another watch* is a new current viewing, and nothing it does may be turned
   * into an undated one by a carried Earlier. Under today's semantics it writes no date
   * at all (`rank_again` with `p_new_watch`), and the only log sheet it reaches is the
   * post-rank one — which never reads the sitting.
   */
  it('does not reach the sheet a Log another watch hands back to', async () => {
    rememberWhen('user-1', 'earlier');
    stubReads({ bucket: 'loved', watched_on: '2026-08-01', note: '' }, { bucket: 'loved' });
    const onDone = jest.fn();
    const sheet = await open(filmA, {
      postRank: { score: 8.7, position: 3, category: 'movies' },
      onDone,
    });

    await waitFor(() => expect(sheet.dateRow().props.accessibilityState.disabled).toBe(false));
    expect(sheet.dateRow().props.accessibilityValue.text).toBe(formatWatchDate('2026-08-01'));
    expect(sheet.dateRow().props.accessibilityState.expanded).toBe(false);

    await fireEvent.press(sheet.getByRole('button', { name: 'Done' }));

    expect(onDone).toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
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
      expect(sheet.getByLabelText(WRITING).props.accessibilityHint).toBe('Unavailable'),
    );
    for (const label of [WRITING, 'Who I watched with', 'Watch date']) {
      expect(sheet.getByLabelText(label).props.accessibilityHint).not.toBe('Loading');
    }
  });

  it('names the failing dependency outside production, and offers a retry', async () => {
    const sheet = await open(filmA);

    await waitFor(() => expect(sheet.getByText(/note_visibility does not exist/)).toBeTruthy());
    expect(
      sheet.getByLabelText('Retry loading what you wrote and your watch date'),
    ).toBeTruthy();
  });

  it('still lets a bucket be chosen and ranking start', async () => {
    // `set_bucket` needs none of what failed, so gating it would be punishing the
    // user for a fault in a different query.
    const sheet = await open(filmA);
    await waitFor(() =>
      expect(sheet.getByLabelText(WRITING).props.accessibilityHint).toBe('Unavailable'),
    );

    await fireEvent.press(sheet.bucket('I liked it'));
    await waitFor(() => expect(callsTo('log_title')).toHaveLength(1));
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
      expect(sheet.getByLabelText(WRITING).props.accessibilityHint).toBe('Unavailable'),
    );

    await fireEvent.press(sheet.getByLabelText(WRITING));

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
    const view = await renderWithProviders(
      <LogSheet title={filmA} onClose={() => {}} surface="search" />,
    );

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
      expect(view.getByLabelText(WRITING).props.accessibilityHint).toBe('Unavailable'),
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
  /** One mutual, flattened — the shape `withPeople` wants. */
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

  it('creates the watch with no date when the reader has said Earlier', async () => {
    // The watch a tag hangs off used to be created with `effectiveDate`, which falls
    // back to today even after the reader said they do not know when.
    withPeople([person('u1', 'Anna')].flat());
    const sheet = await open(filmA);

    await sheet.openDate();
    await fireEvent.press(sheet.getByRole('button', { name: 'Earlier' }));
    await waitFor(() => expect(callsTo('clear_watch_date')).toHaveLength(1));
    await fireEvent.press(sheet.getByRole('button', { name: 'Who I watched with' }));
    await waitFor(() => expect(sheet.getByLabelText('Anna')).toBeTruthy());
    await fireEvent.press(sheet.getByLabelText('Anna'));

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    expect(callsTo('log_watched')[0][1].p_watched_on).toBeNull();
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

  /**
   * **The companion path is a writer with a middle**, and this is its sequence matrix.
   *
   * On an unlogged title, ticking somebody is `log_watched` and then `set_watch_tags`.
   * Independent review 21e: the log succeeds, the follow lapses, the tag write returns
   * 42501 — and the sheet reverted the companion and never refreshed, so the collection
   * went on showing the title as unlogged while the database held the watch.
   *
   * The axes are which step fails and what the client was told about it. What is asserted
   * is the canonical state the client must reconcile, not the absence of an exception.
   */
  describe('when one step of it fails', () => {
    const tickAnna = async () => {
      withPeople(person('u1', 'Anna'));
      const sheet = await openWho();
      await waitFor(() => expect(sheet.getByLabelText('Anna')).toBeTruthy());
      const before = readsOf('user_media');
      await fireEvent.press(sheet.getByLabelText('Anna'));
      return { sheet, before };
    };

    it('refreshes after a log that landed, even though the tagging was refused', async () => {
      // The exact sequence 21e named. `log_watched` commits; `set_watch_tags` answers
      // 42501 because the follow lapsed while the sheet was open. The watch exists.
      failing('set_watch_tags', { code: '42501', message: 'not mutual' });
      const { sheet, before } = await tickAnna();

      await waitFor(() => expect(callsTo('set_watch_tags')).toHaveLength(1));
      expect(callsTo('log_watched')).toHaveLength(1);
      // The title is logged now, so the log state this sheet renders has to be re-read.
      await waitFor(() => expect(readsOf('user_media')).toBeGreaterThan(before));
      await waitFor(() =>
        expect(sheet.getByText('You can only tag people who follow you back.')).toBeTruthy(),
      );
    });

    it('refreshes when the log itself was never answered', async () => {
      // `log_watched` may have committed and lost its reply, so the row may exist. The
      // sequence stops — there is nothing to hang a tag off that we can name — but the
      // collection still has to be reconciled.
      failing('log_watched', { code: '', message: 'TypeError: Network request failed' });
      const { before } = await tickAnna();

      await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
      await waitFor(() => expect(readsOf('user_media')).toBeGreaterThan(before));
      // No tag was attempted against a watch nobody can vouch for.
      expect(callsTo('set_watch_tags')).toHaveLength(0);
    });

    it('refreshes when the log came back 08007', async () => {
      // The code that carries a SQLSTATE and still proves nothing.
      failing('log_watched', { code: '08007', message: 'transaction resolution unknown' });
      const { before } = await tickAnna();

      await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
      await waitFor(() => expect(readsOf('user_media')).toBeGreaterThan(before));
    });

    it('leaves the cache alone when the log was refused outright', async () => {
      // A suspension is the server declining, every time. Nothing was written, so a
      // refetch here would be a round trip bought with nothing.
      failing('log_watched', { code: '42501', message: 'suspended' });
      const { before } = await tickAnna();

      await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
      expect(readsOf('user_media')).toBe(before);
      expect(callsTo('set_watch_tags')).toHaveLength(0);
    });

    it('says it could not confirm when the tag write was never answered', async () => {
      // The list on screen is put back to the server's, *and* the server's is refetched
      // — the fallback is only honest if something re-reads it. Saying "that failed"
      // over a tag that may be stored is the false-success problem in reverse.
      failing('set_watch_tags', { code: '', message: 'TypeError: Network request failed' });
      const { sheet } = await tickAnna();

      await waitFor(() =>
        expect(
          sheet.getByText(
            'We could not confirm that. This list has been refreshed to whatever was saved.',
          ),
        ).toBeTruthy(),
      );
      await waitFor(() => expect(readsOf('watch_tags')).toBeGreaterThan(1));
    });

    it('replays an unanswered tag write under the id the first attempt used', async () => {
      // `set_watch_tags` replaces, so the tags converge — but it is rate-limited, and a
      // replay under a fresh id spends a second slot for one tick
      // (`lib/operation-intent.ts`). Independent review 21j.
      failing('set_watch_tags', { code: '', message: 'TypeError: Network request failed' });
      const { sheet } = await tickAnna();
      await waitFor(() => expect(callsTo('set_watch_tags')).toHaveLength(1));

      // Tapping Anna again is the retry: the failed save put the list back to what the
      // server last confirmed — nobody — so the tick computes [u1] a second time. Same
      // list, same intent, and the ledger has to be able to see that.
      await fireEvent.press(sheet.getByLabelText('Anna'));
      await waitFor(() => expect(callsTo('set_watch_tags')).toHaveLength(2));

      const ids = callsTo('set_watch_tags').map((call) => call[1].p_operation_id);
      expect(typeof ids[0]).toBe('string');
      expect(ids[1]).toBe(ids[0]);
      // Both really did send the same list, which is what makes them one intent rather
      // than two that happen to share a key.
      expect(callsTo('set_watch_tags')[0][1].p_tagged_ids).toEqual(['u1']);
      expect(callsTo('set_watch_tags')[1][1].p_tagged_ids).toEqual(['u1']);
    });

    it('sends the whole list again on a retry rather than a second tag', async () => {
      // Retry safety is a property of the RPC: `set_watch_tags` is handed the complete
      // list and replaces what is stored, so two attempts at the same intent store one
      // set. That is what makes a fresh operation id on the second attempt harmless.
      failing('set_watch_tags', { code: '', message: 'TypeError: Network request failed' });
      const { sheet } = await tickAnna();
      await waitFor(() => expect(callsTo('set_watch_tags')).toHaveLength(1));

      mockRpc.mockResolvedValue({ data: { status: 'ok' }, error: null });
      await fireEvent.press(sheet.getByLabelText('Anna'));

      await waitFor(() => expect(callsTo('set_watch_tags')).toHaveLength(2));
      for (const call of callsTo('set_watch_tags')) {
        // Never an "add this one" delta, which is what could accumulate under a retry.
        expect(Array.isArray(call[1].p_tagged_ids)).toBe(true);
      }
    });
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
/**
 * **One row, and what its value says.**
 *
 * `user_media.note` stores both a private note and a review; `note_visibility` is the
 * only thing that tells them apart. The sheet drew that one field as *two* rows —
 * Review and Private note, each converting to the other — and the founder's device
 * verdict was that it made the sheet conceptually complicated: a reader had to decide
 * which of two names their writing would go under before writing anything. It is one
 * row now, one word, private by default.
 *
 * The storage did not move and is not going to: one `note`, one `note_visibility`.
 * The invariants these tests hold are that the row's value tells the truth about the
 * shared state before the composer is opened, and that the chip — the only conversion
 * control left anywhere on this sheet — is an act the reader takes on writing they are
 * looking at.
 */
describe('the one Note row', () => {
  const shareChip = (sheet: Awaited<ReturnType<typeof open>>) =>
    sheet.getByLabelText('Share this note as a public review');

  it('offers exactly one writing row, and it reads Add while empty', async () => {
    const sheet = await open(filmA);
    await waitFor(() =>
      expect(sheet.getByLabelText(WRITING).props.accessibilityState.disabled).toBe(false),
    );

    expect(sheet.notesRow().props.accessibilityValue.text).toBe('Add');
    // The pair is gone, in both of its names.
    expect(sheet.queryByRole('button', { name: 'Review' })).toBeNull();
    expect(sheet.queryByRole('button', { name: 'Private note' })).toBeNull();
  });

  it('counts a private note in words, with no Shared claim', async () => {
    stubReads(
      {
        bucket: 'loved',
        watched_on: null,
        note: 'kept back',
        note_updated_at: 'v1',
        note_visibility: 'private',
        note_has_spoilers: false,
      },
      null,
    );
    const sheet = await open(filmA);

    await waitFor(() => expect(sheet.notesRow().props.accessibilityValue.text).toBe('2 words'));
  });

  it('says Shared over the word count once the note is a review', async () => {
    // The row's value is what announces a published note before the composer is even
    // opened — the whole reason the shared state rides on the row rather than only on
    // the chip inside it.
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

    await waitFor(() =>
      expect(sheet.notesRow().props.accessibilityValue.text).toBe('Shared · 4 words'),
    );
  });

  it('becomes a private note the moment the reader unshares it', async () => {
    // Private by default since 2026-11-04, so the helper is there on arrival, goes when
    // the reader shares, and comes back the moment they unshare. The copy must follow the
    // state either way: a shared note that says "Only you can read this" is the app
    // contradicting itself, and so is the reverse.
    const sheet = await open(filmA);
    await sheet.openNotes();
    await waitFor(() => expect(sheet.getByText('Only you can read this.')).toBeTruthy());
    await fireEvent.press(shareChip(sheet));
    await waitFor(() => expect(sheet.queryByText('Only you can read this.')).toBeNull());

    await fireEvent.press(shareChip(sheet));

    expect(sheet.notesRow().props.accessibilityState.expanded).toBe(true);
    await waitFor(() => expect(sheet.getByText('Only you can read this.')).toBeTruthy());
  });

  it('says Shared on the row while new writing is shared', async () => {
    const sheet = await open(filmA);
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'three words here');

    // Private by default (2026-11-04): the row says only the length until it is shared.
    await waitFor(() => expect(sheet.notesRow().props.accessibilityValue.text).toBe('3 words'));
    await fireEvent.press(shareChip(sheet));
    await waitFor(() =>
      expect(sheet.notesRow().props.accessibilityValue.text).toBe('Shared · 3 words'),
    );

    // And stops saying so the moment it is turned off.
    await fireEvent.press(shareChip(sheet));
    await waitFor(() => expect(sheet.notesRow().props.accessibilityValue.text).toBe('3 words'));
  });

  /**
   * **The chip is the only conversion control, and one tap of it saves.**
   *
   * The Review row's confirmation dialog is gone with the row. The chip is an explicit
   * act taken inside the composer, on writing the reader is looking at, and it has
   * always saved immediately rather than waiting for a blur — one tap publishes, the
   * same tap takes it back, and nothing asks a question in between.
   */
  it('publishes an existing private note on one tap of the chip, and no dialog', async () => {
    stubReads(
      {
        bucket: 'loved',
        watched_on: null,
        note: 'kept back',
        note_updated_at: 'v1',
        note_visibility: 'private',
        note_has_spoilers: false,
      },
      null,
    );
    const sheet = await open(filmA);
    await sheet.openNotes();
    await waitFor(() => expect(sheet.note().props.value).toBe('kept back'));

    expect(shareChip(sheet).props.accessibilityState.checked).toBe(false);
    await fireEvent.press(shareChip(sheet));

    // Exactly one save, carrying the conversion, and the chip reflects it at once.
    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    expect(callsTo('save_note')[0][1]).toMatchObject({
      p_note: 'kept back',
      p_note_visibility: 'public',
    });
    expect(shareChip(sheet).props.accessibilityState.checked).toBe(true);
    expect(sheet.getByText(/Shown with your rating/)).toBeTruthy();
  });

  it('takes it back on a second tap, keeping the text', async () => {
    // The stand-in behaves like the server: the first save really stores `public`, so
    // the refetch behind it returns the published state and the second tap is judged
    // against what is genuinely stored — exactly the device sequence.
    const row: Record<string, unknown> = {
      bucket: 'loved',
      watched_on: null,
      note: 'kept back',
      note_updated_at: 'v1',
      note_visibility: 'private',
      note_has_spoilers: false,
    };
    stubReads(row, null);
    mockRpc.mockImplementation((name: string, args?: { p_note_visibility?: string }) => {
      if (name === 'save_note') row.note_visibility = args?.p_note_visibility;
      return Promise.resolve({ data: { status: 'ok' }, error: null });
    });

    const sheet = await open(filmA);
    await sheet.openNotes();
    await waitFor(() => expect(sheet.note().props.value).toBe('kept back'));

    await fireEvent.press(shareChip(sheet));
    await waitFor(() => expect(callsTo('save_note')).toHaveLength(1));
    // Wait the reconciling refetch out, so the second tap runs against the stored
    // truth rather than racing it.
    await waitFor(() =>
      expect(sheet.client.getQueryData(queryKeys.logState('user-1', 'film-a'))).toMatchObject({
        noteVisibility: 'public',
      }),
    );

    await fireEvent.press(shareChip(sheet));

    await waitFor(() => expect(callsTo('save_note')).toHaveLength(2));
    // Unsharing changes who may read it and nothing else: the text travels intact.
    expect(callsTo('save_note')[1][1]).toMatchObject({
      p_note: 'kept back',
      p_note_visibility: 'private',
    });
    expect(shareChip(sheet).props.accessibilityState.checked).toBe(false);
    expect(sheet.note().props.value).toBe('kept back');
  });

  /**
   * The stored value still wins over the door the reader came through — the guarantee
   * `20260823000100`'s tranche established, restated at the row: the value must not
   * claim Shared for a note the intent prop failed to move.
   */
  it('calls a stored private note a private note, even under Write a review', async () => {
    stubReads(
      {
        bucket: 'loved',
        watched_on: null,
        note: 'kept back',
        note_updated_at: 'v1',
        note_visibility: 'private',
        note_has_spoilers: false,
      },
      null,
    );
    const sheet = await open(filmA, { noteIntent: 'review' });

    await waitFor(() => expect(sheet.notesRow().props.accessibilityValue.text).toBe('2 words'));
  });
});

/**
 * **The state a finished ranking returns to.**
 *
 * The founder's central complaint about the log flow: tap a bucket, answer the
 * comparisons, see a number, and it is over. The review you might write and the people
 * you watched it with were behind a second, unprompted visit to a sheet you had just
 * been thrown out of, and nothing on the reveal said so.
 *
 * Ranking is a subflow of logging now, and this sheet is what it returns to —
 * deliberately *this* sheet rather than a Finish screen of its own, because the rows
 * below the header are the canonical implementation of "the rest of your log" and a
 * second copy of them is a second copy that drifts. What `postRank` changes is the top
 * of the sheet, where the bucket question is replaced by its answer, and the addition of
 * a Done at the foot.
 */
describe('the state after a ranking', () => {
  const placed = { score: 8.7, position: 3, category: 'movies' };

  it('restates the score instead of asking the question again', async () => {
    const sheet = await open(filmA, { postRank: placed });

    await waitFor(() => expect(sheet.getByText('Ranked')).toBeTruthy());
    expect(sheet.getByText('#3 in Movies')).toBeTruthy();
    // Re-asking "How was it?" with a bucket already chosen would be the sheet
    // pretending the last minute did not happen — and worse, offering a control whose
    // next tap discards the position the reader just earned.
    expect(sheet.queryByText('How was it?')).toBeNull();
    expect(sheet.queryByTestId('bucket-choices')).toBeNull();
  });

  it('offers the writing and the details', async () => {
    const sheet = await open(filmA, { postRank: placed });

    await waitFor(() => expect(sheet.getByText('Ranked')).toBeTruthy());
    expect(sheet.getByRole('button', { name: WRITING })).toBeTruthy();
    expect(sheet.getByRole('button', { name: 'Who I watched with' })).toBeTruthy();
    expect(sheet.getByRole('button', { name: 'Watch date' })).toBeTruthy();
  });

  it('lets somebody finish without writing anything', async () => {
    const onDone = jest.fn();
    const sheet = await open(filmA, { postRank: placed, onDone });

    await waitFor(() => expect(sheet.getByText('Ranked')).toBeTruthy());
    await fireEvent.press(sheet.getByRole('button', { name: 'Done' }));

    expect(onDone).toHaveBeenCalled();
    // Done is "I am finished", not "commit" — every row above writes on its own, as
    // this sheet always has.
    expect(callsTo('save_note')).toHaveLength(0);
    expect(callsTo('log_watched')).toHaveLength(0);
  });

  it('does not open a composer by itself', async () => {
    const sheet = await open(filmA, { postRank: placed });

    await waitFor(() => expect(sheet.getByText('Ranked')).toBeTruthy());
    // A form that opens itself is a form that has to be dismissed. Writing is offered,
    // never required.
    expect(sheet.queryByPlaceholderText('What did you think?')).toBeNull();
  });

  it('is a review that gets written, if the reader shares it', async () => {
    const sheet = await open(filmA, { postRank: placed });
    await waitFor(() => expect(sheet.getByText('Ranked')).toBeTruthy());

    await sheet.openNotes();
    // Private by default since 2026-11-04, so sharing is pressed: that press is the act
    // that makes this a review.
    await fireEvent.press(sheet.getByLabelText('Share this note as a public review'));
    await fireEvent.changeText(sheet.note(), 'The last twenty minutes are the whole film.');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    expect(callsTo('log_watched')[0][1]).toMatchObject({
      p_note: 'The last twenty minutes are the whole film.',
      p_note_visibility: 'public',
    });
  });

  it('is a private note that stays private, if that is what gets written', async () => {
    const sheet = await open(filmA, { postRank: placed });
    await waitFor(() => expect(sheet.getByText('Ranked')).toBeTruthy());

    await sheet.openNotes();
    // Nothing pressed: a new note is private until the reader shares it, and finishing
    // the ranking that brought them here does not share it either.
    await fireEvent.changeText(sheet.note(), 'must rewatch');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    expect(callsTo('log_watched')[0][1]).toMatchObject({
      p_note: 'must rewatch',
      p_note_visibility: 'private',
    });
  });

  it('keeps the ordinary sheet exactly as it was', async () => {
    const sheet = await open(filmA);

    // No `postRank`, so the three buckets end the sheet and there is no Done — this
    // sheet has a Close in its header and a backdrop, and a title that has not been
    // ranked has no moment a Done would be the end of. Since Option A the buckets are
    // at the foot rather than the top, and their question is spoken, not drawn.
    await waitFor(() => expect(sheet.getByTestId('bucket-choices')).toBeTruthy());
    expect(sheet.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(sheet.queryByText('Ranked')).toBeNull();
  });

  it('names the TV category by the category the server sent', async () => {
    const sheet = await open(filmA, {
      postRank: { score: 6.2, position: 11, category: 'tv_seasons' },
    });

    // "TV seasons" since 2026-11-14: TV is two rankings now, so the pool is named.
    await waitFor(() => expect(sheet.getByText('#11 in TV seasons')).toBeTruthy());
  });

  it('names a whole show by its own pool', async () => {
    const sheet = await open(filmA, {
      postRank: { score: 8.4, position: 2, category: 'tv_shows' },
    });

    await waitFor(() => expect(sheet.getByText('#2 in TV shows')).toBeTruthy());
  });
});

/**
 * **"Add more details" means the whole log** — founder physical finding, 2026-08-30.
 *
 * The report was that the control "routes into only the Note/Review portion". All three
 * rows have in fact always been rendered here — what the founder was describing is what
 * a phone shows: a sheet that arrives with the note composer already expanded, under a
 * keyboard, puts the companions and the watch date below the fold.
 *
 * The path that does it is real and narrow. `openWriting` is set by the Ranked menu's
 * writing row, it is not reset by anything else on the title screen, and a reader who
 * came in that way, changed their rating from inside the sheet and finished the
 * comparison arrived back here with the intent still set.
 *
 * So the rule is stated on this sheet rather than at the call site — there are two
 * callers — and it is the one thing these tests are about: **the post-rank sheet opens on
 * nothing.** `openWriting` still does its job everywhere else, which is the second test.
 */
describe('add more details opens the whole log', () => {
  const placed = { score: 8.7, position: 3, category: 'movies' };

  it('does not land in the note composer, even carrying a writing intent', async () => {
    const sheet = await open(filmA, { postRank: placed, openWriting: 'private' });

    await waitFor(() => expect(sheet.getByText('Ranked')).toBeTruthy());
    expect(sheet.queryByPlaceholderText('What did you think?')).toBeNull();
  });

  it('offers all four of them, and each one opens', async () => {
    const sheet = await open(filmA, { postRank: placed, openWriting: 'private' });
    await waitFor(() => expect(sheet.getByText('Ranked')).toBeTruthy());

    // Who I watched with.
    await waitFor(() =>
      expect(sheet.getByLabelText('Who I watched with').props.accessibilityState.disabled).toBe(
        false,
      ),
    );
    await fireEvent.press(sheet.getByRole('button', { name: 'Who I watched with' }));
    // The picker itself, which with no mutuals in this fixture is its empty state. What
    // is being asserted is that the row *discloses* — the picker's own behaviour has its
    // own section above.
    await waitFor(() => expect(sheet.getByText('Nobody to tag yet')).toBeTruthy());

    // The note, and the spoiler claim that lives beside it.
    await sheet.openNotes();
    expect(sheet.note()).toBeTruthy();
    expect(sheet.getByLabelText('This note contains spoilers')).toBeTruthy();

    // And the watch date.
    await sheet.openDate();
    expect(sheet.getByText('Watch date')).toBeTruthy();
  });

  /**
   * The other half of the rule: `openWriting` is not broken, it is scoped. Opening the
   * sheet *to write something* — which is what the Ranked menu's row means — still lands
   * the reader in the composer, because there is no ranking that has just finished and
   * nothing else they came for.
   */
  it('still opens the composer when that is what the reader asked for', async () => {
    const sheet = await open(filmA, { openWriting: 'private' });

    await waitFor(() => expect(sheet.getByPlaceholderText('What did you think?')).toBeTruthy());
  });

  /**
   * **Editing details is not re-ranking, and does not create a second anything.**
   *
   * The rows write through `log_watched`, which upserts the one `user_media` row this
   * title already has. Nothing here touches `set_bucket`, `rank_start` or `rank_rebucket`
   * — and if it did, the position the reader has just earned would be discarded, which is
   * exactly the accident the post-rank state exists to prevent.
   */
  it('writes details without touching the ranking', async () => {
    const sheet = await open(filmA, { postRank: placed });
    await waitFor(() => expect(sheet.getByText('Ranked')).toBeTruthy());

    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'the third act earns it');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    expect(callsTo('log_title')).toHaveLength(0);
    expect(callsTo('rank_start')).toHaveLength(0);
    expect(callsTo('rank_rebucket')).toHaveLength(0);
    // One write against the row that already exists, not a second log.
    expect(callsTo('log_watched')).toHaveLength(1);
  });
});

/**
 * **Share as a review remembers what the reader chose last time** (founder, 2026-09-06).
 *
 * The founder's exact sequence: the first new note opens shared; turn it off and save,
 * and the next new note opens off; turn it back on and save, and the next opens on.
 *
 * The rule this must never break is the one that protects writing that already exists: a
 * saved note opens on the visibility it was saved with, whatever the habit is. A general
 * preference that could retroactively publish an old private note would be the worst
 * possible version of this feature, so the ordering is asserted here directly rather
 * than left to the implementation to remember.
 */
/**
 * **The remembered Share choice for new notes** (founder, 2026-11-04, amending `94c789a`).
 *
 * A first-ever note is private. Turning *Share as a review* on — or off — for a new note
 * is remembered for the next new one; nothing else moves that memory, and a note that
 * already exists always opens on its own stored visibility.
 */
describe('the remembered share choice', () => {
  const KEY = 'user-1.notes.share-choice';
  const shareOn = (sheet: Awaited<ReturnType<typeof open>>) =>
    sheet.getByLabelText('Share this note as a public review').props.accessibilityState.checked;
  const share = (sheet: Awaited<ReturnType<typeof open>>) =>
    fireEvent.press(sheet.getByLabelText('Share this note as a public review'));
  const publicWrites = () =>
    mockRpc.mock.calls.filter(
      ([, args]) => (args as { p_note_visibility?: string })?.p_note_visibility === 'public',
    );

  it('opens a first-ever note private', async () => {
    const sheet = await open(filmA);
    await sheet.openNotes();
    await waitFor(() => expect(shareOn(sheet)).toBe(false));
    expect(sheet.getByText('Only you can read this.')).toBeTruthy();
  });

  it('ignores the habit earlier builds stored, which recorded saves rather than choices', async () => {
    mockPrefs.set('user-1.notes.share-default', 'public');
    const sheet = await open(filmA);
    await sheet.openNotes();
    await waitFor(() => expect(shareOn(sheet)).toBe(false));
  });

  it('remembers turning sharing on, and opens the next new note shared, visibly', async () => {
    const first = await open(filmA);
    await first.openNotes();
    await share(first);
    await waitFor(() => expect(mockPrefs.get(KEY)).toBe('public'));
    await first.show(null);

    const next = await open(filmB);
    await next.openNotes();
    await waitFor(() => expect(shareOn(next)).toBe(true));
    // On screen before a word is typed, which is before any autosave can carry it.
    expect(next.getByText(/Shown with your rating/)).toBeTruthy();
    expect(next.queryByText('Only you can read this.')).toBeNull();
  });

  it('remembers turning sharing off too, and opens the next new note private', async () => {
    mockPrefs.set(KEY, 'public');
    const first = await open(filmA);
    await first.openNotes();
    await waitFor(() => expect(shareOn(first)).toBe(true));
    await share(first);
    await waitFor(() => expect(mockPrefs.get(KEY)).toBe('private'));
    await first.show(null);

    const next = await open(filmB);
    await next.openNotes();
    await waitFor(() => expect(shareOn(next)).toBe(false));
  });

  it('autosaves each switch with the state on screen: shared, then private, then shared', async () => {
    mockPrefs.set(KEY, 'public');
    const sheet = await open(filmA);
    await sheet.openNotes();
    await waitFor(() => expect(shareOn(sheet)).toBe(true));

    // Typed under a visible "shared": the debounced autosave creates the row as a review.
    await fireEvent.changeText(sheet.note(), 'first draft');
    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1), { timeout: 3000 });
    expect(callsTo('log_watched')[0][1]).toMatchObject({
      p_note: 'first draft',
      p_note_visibility: 'public',
    });

    // Turned off: saved at once, private, and remembered.
    await share(sheet);
    await waitFor(() =>
      expect(callsTo('save_note').at(-1)?.[1]).toMatchObject({ p_note_visibility: 'private' }),
    );
    expect(sheet.getByText('Only you can read this.')).toBeTruthy();
    await waitFor(() => expect(mockPrefs.get(KEY)).toBe('private'));

    // More typing autosaves under the state now shown: private.
    await fireEvent.changeText(sheet.note(), 'first draft, revised');
    await waitFor(
      () =>
        expect(callsTo('save_note').at(-1)?.[1]).toMatchObject({
          p_note: 'first draft, revised',
          p_note_visibility: 'private',
        }),
      { timeout: 3000 },
    );

    // And back on: public again, and remembered — this is still the note this sheet
    // composed, even though its first autosave has created the row.
    await share(sheet);
    await waitFor(() =>
      expect(callsTo('save_note').at(-1)?.[1]).toMatchObject({ p_note_visibility: 'public' }),
    );
    await waitFor(() => expect(mockPrefs.get(KEY)).toBe('public'));
  });

  it('keeps the Note row shut until the preference is read, so nothing can flip under typing', async () => {
    mockPrefs.set(KEY, 'public');
    let release = () => {};
    mockPrefGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sheet = await open(filmA);
    await waitFor(() =>
      expect(sheet.getByLabelText('Watch date').props.accessibilityState.disabled).toBe(false),
    );

    // The stored row is read; the preference is not. The composer cannot open yet.
    expect(sheet.notesRow().props.accessibilityState.disabled).toBe(true);
    expect(sheet.queryByPlaceholderText('What did you think?')).toBeNull();

    await act(async () => {
      release();
      await mockPrefGate;
    });
    await sheet.openNotes();
    await waitFor(() => expect(shareOn(sheet)).toBe(true));
  });

  it('saves a date picked while the preference is still being read', async () => {
    // Only the note waits for the Share choice; a date carries no visibility. Holding it
    // too dropped a pick made in that instant without a word (Codex, combined candidate).
    let release = () => {};
    mockPrefGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sheet = await open(filmA);
    await sheet.openDate();
    await fireEvent.press(sheet.getByRole('button', { name: 'Yesterday' }));

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    expect(callsTo('log_watched')[0][1]).toMatchObject({
      p_watched_on: addDays(today(), -1),
      p_note: null,
    });
    // And the note itself is still shut until the choice lands.
    expect(sheet.notesRow().props.accessibilityState.disabled).toBe(true);
    await act(async () => {
      release();
      await mockPrefGate;
    });
  });

  it('is not changed by opening a note, saving one, or finishing a ranking', async () => {
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'my own thoughts');
    await fireEvent(sheet.note(), 'blur');
    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    await fireEvent.press(sheet.bucket('I liked it'));
    await waitFor(() =>
      expect(onRank).toHaveBeenCalledWith('loved', 'start', { freshLog: expect.any(Boolean) }),
    );
    await settle();

    expect(mockPrefs.has(KEY)).toBe(false);
    expect(publicWrites()).toHaveLength(0);

    // The post-rank sheet the comparisons return to: same note, still private, still no
    // preference written.
    stubReads(
      {
        bucket: 'loved',
        note: 'my own thoughts',
        note_visibility: 'private',
        note_updated_at: 'v1',
      },
      { bucket: 'loved' },
    );
    await sheet.show(null);
    const after = await open(filmA, {
      postRank: { score: 8.7, position: 3, category: 'movies' },
    });
    await after.openNotes();
    await waitFor(() => expect(shareOn(after)).toBe(false));
    await settle();
    expect(mockPrefs.has(KEY)).toBe(false);
    expect(publicWrites()).toHaveLength(0);
  });

  it('opens existing writing on its stored visibility, whatever the preference says', async () => {
    mockPrefs.set(KEY, 'public');
    stubReads(
      {
        bucket: 'loved',
        note: 'kept to myself',
        note_visibility: 'private',
        note_updated_at: 'v1',
      },
      { bucket: 'loved' },
    );
    const kept = await open(filmA);
    await kept.openNotes();
    await waitFor(() => expect(shareOn(kept)).toBe(false));
    expect(kept.getByText('Only you can read this.')).toBeTruthy();
    await kept.show(null);

    mockPrefs.set(KEY, 'private');
    stubReads(
      {
        bucket: 'loved',
        note: 'said it out loud',
        note_visibility: 'public',
        note_updated_at: 'v1',
      },
      { bucket: 'loved' },
    );
    const published = await open(filmB);
    await published.openNotes();
    await waitFor(() => expect(shareOn(published)).toBe(true));
  });

  it('remembers an explicit tap on existing writing for new notes, and leaves stored notes alone', async () => {
    mockPrefs.set(KEY, 'public');
    stubReads(
      {
        bucket: 'loved',
        note: 'said too much',
        note_visibility: 'public',
        note_updated_at: 'v1',
      },
      { bucket: 'loved' },
    );
    const sheet = await open(filmA);
    await sheet.openNotes();
    await waitFor(() => expect(shareOn(sheet)).toBe(true));

    // Unshared on purpose: this review becomes private, and the tap is the reader's
    // latest explicit choice, so the next new note opens private.
    await share(sheet);
    await waitFor(() =>
      expect(callsTo('save_note').at(-1)?.[1]).toMatchObject({ p_note_visibility: 'private' }),
    );
    await waitFor(() => expect(mockPrefs.get(KEY)).toBe('private'));
    await sheet.show(null);

    // A different stored review still opens on its own saved value: shared.
    stubReads(
      {
        bucket: 'loved',
        note: 'still proud of this',
        note_visibility: 'public',
        note_updated_at: 'v2',
      },
      { bucket: 'loved' },
    );
    const other = await open(filmB);
    await other.openNotes();
    await waitFor(() => expect(shareOn(other)).toBe(true));
  });

  it('remembers Share turned on in the sheet after a ranking, for the next new note', async () => {
    // A note written before the bucket, ranked, then shared once the score is in: the tap
    // is on what is by now a stored note, and it is still the reader's choice.
    stubReads(
      {
        bucket: 'loved',
        note: 'my own thoughts',
        note_visibility: 'private',
        note_updated_at: 'v1',
      },
      { bucket: 'loved' },
    );
    const after = await open(filmA, {
      postRank: { score: 8.7, position: 3, category: 'movies' },
    });
    await after.openNotes();
    await waitFor(() => expect(shareOn(after)).toBe(false));
    await share(after);
    await waitFor(() => expect(mockPrefs.get(KEY)).toBe('public'));
    await after.show(null);

    stubReads(null, null);
    const next = await open(filmB);
    await next.openNotes();
    await waitFor(() => expect(shareOn(next)).toBe(true));
  });

  it('opens Write a review shared even for a reader whose choice is private, and does not record it', async () => {
    mockPrefs.set(KEY, 'private');
    const sheet = await open(filmA, { noteIntent: 'review' });
    await sheet.openNotes();

    await waitFor(() => expect(shareOn(sheet)).toBe(true));
    await settle();
    // The door asked for a review; the reader's habit is untouched until they tap.
    expect(mockPrefs.get(KEY)).toBe('private');
  });
});

/**
 * **Ranking-start, Option A** (founder, 2026-11-04).
 *
 * The details come first and the three buckets last, so the sheet reads top to bottom
 * and the tap that starts the comparisons is the last thing on it. Nothing new sits
 * between that tap and the comparisons, and nothing above it is required.
 *
 * What the order changed underneath is the point of most of these: a note, a date or a
 * companion is now often the *first* write, and so the one that creates the row. The
 * bucket used to be refused while such a write was running, and a note that created
 * the row did so without the date the row was showing.
 */
describe('the ranking-start order', () => {
  /** Where each landmark sits in the rendered tree, by its first appearance. */
  const order = (sheet: Awaited<ReturnType<typeof open>>, marks: string[]) => {
    const tree = JSON.stringify(sheet.toJSON());
    return marks.map((mark) => {
      const at = tree.indexOf(mark);
      if (at < 0) throw new Error(`not rendered: ${mark}`);
      return at;
    });
  };
  const ascending = (xs: number[]) =>
    xs.every((x, i) => i === 0 || (xs[i - 1] ?? Infinity) < x);

  it('puts who, then the date, then the note first, and the buckets last', async () => {
    const sheet = await open(filmA);
    await waitFor(() => expect(sheet.getByTestId('bucket-choices')).toBeTruthy());

    expect(
      ascending(
        order(sheet, [
          '"accessibilityLabel":"Who I watched with"',
          '"accessibilityLabel":"Watch date"',
          '"accessibilityLabel":"Note"',
          '"testID":"bucket-choices"',
        ]),
      ),
    ).toBe(true);
  });

  it('ends just under the buckets: no second margin beneath the labels', async () => {
    const sheet = await open(filmA);
    await waitFor(() => expect(sheet.getByTestId('bucket-choices')).toBeTruthy());
    const scroller = sheet.getByTestId('log-sheet-scroll');
    const content = StyleSheet.flatten(scroller.props.contentContainerStyle);
    // The sheet adds the navigation inset and its own 16pt; the content keeps only 4.
    expect(content.paddingBottom).toBe(4);
  });

  it('keeps its ordinary foot after a ranking, where Done is last', async () => {
    const sheet = await open(filmA, {
      postRank: { score: 8.7, position: 3, category: 'movies' },
    });
    await waitFor(() => expect(sheet.getByText('Ranked')).toBeTruthy());
    const scroller = sheet.getByTestId('log-sheet-scroll');
    expect(StyleSheet.flatten(scroller.props.contentContainerStyle).paddingBottom).toBe(16);
  });

  it('draws no question above the buckets, and still names the group with it', async () => {
    const sheet = await open(filmA);
    const group = await waitFor(() => sheet.getByTestId('bucket-choices'));

    expect(sheet.queryByText('How was it?')).toBeNull();
    expect(group.props.accessibilityRole).toBe('radiogroup');
    expect(group.props.accessibilityLabel).toBe('How was it?');
    expect(sheet.getAllByRole('radio').map((radio) => radio.props.accessibilityLabel)).toEqual([
      'I liked it',
      'It was fine',
      'I didn’t like it',
    ]);
  });

  it('keeps the same row order after a ranking, with Done last and no buckets', async () => {
    const sheet = await open(filmA, {
      postRank: { score: 8.7, position: 3, category: 'movies' },
    });
    await waitFor(() => expect(sheet.getByText('Ranked')).toBeTruthy());

    expect(sheet.queryByTestId('bucket-choices')).toBeNull();
    expect(
      ascending(
        order(sheet, [
          '"accessibilityLabel":"Who I watched with"',
          '"accessibilityLabel":"Watch date"',
          '"accessibilityLabel":"Note"',
          '"children":["Done"]',
        ]),
      ),
    ).toBe(true);
  });

  it('saves a note typed first before the bucket, then ranks, then dates it as the row showed', async () => {
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await sheet.openNotes();
    // Typed and not blurred: the tap on the bucket is what hands the text over.
    await fireEvent.changeText(sheet.note(), 'the ending landed');
    await fireEvent.press(sheet.bucket('I liked it'));

    await waitFor(() =>
      expect(onRank).toHaveBeenCalledWith('loved', 'start', { freshLog: expect.any(Boolean) }),
    );
    await waitFor(() => expect(callsTo('set_watch_date')).toHaveLength(1));
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual([
      'log_watched',
      'log_title',
      'set_watch_date',
    ]);
    // The note's own write sends no date: it upserts, and a date sent there could
    // overwrite one recorded on another device a moment earlier.
    expect(callsTo('log_watched')[0][1]).toMatchObject({
      p_note: 'the ending landed',
      p_watched_on: null,
    });
    // The bucket then dates the undated row the way `log_title` would have, with the
    // basis the reader's untouched Today earned.
    expect(callsTo('set_watch_date')[0][1]).toMatchObject({
      p_media_item_id: 'film-a',
      p_watched_on: today(),
      p_basis: 'today_default',
    });
  });

  it('keeps showing Today once a note written first has created the row', async () => {
    const sheet = await open(filmA);
    await waitFor(() => expect(sheet.dateRow().props.accessibilityValue?.text).toBe('Today'));

    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'first thoughts');
    // What the server holds now: a row this sheet just made, with no date yet.
    stubReads(
      { bucket: null, watched_on: null, note: 'first thoughts', note_updated_at: 'v1' },
      null,
    );
    const reads = readsOf('user_media');
    await fireEvent(sheet.note(), 'blur');
    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    await waitFor(() => expect(readsOf('user_media')).toBeGreaterThan(reads));
    await settle();

    // Not "Earlier": a dateless row this sheet created is a first log in progress, not
    // a title somebody logged without a date.
    expect(sheet.dateRow().props.accessibilityValue?.text).toBe('Today');
  });

  it('does not stamp a date that is already there by the time the bucket lands', async () => {
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'first thoughts');
    // Another device dated this title while the note was being written.
    stubReads(
      { bucket: null, watched_on: '2026-10-01', note: 'first thoughts', note_updated_at: 'v1' },
      null,
    );
    await fireEvent.press(sheet.bucket('I liked it'));
    await waitFor(() =>
      expect(onRank).toHaveBeenCalledWith('loved', 'start', { freshLog: expect.any(Boolean) }),
    );
    await settle();

    expect(callsTo('set_watch_date')).toHaveLength(0);
  });

  it('does not stamp a date when the fresh read fails and only the old cache is left', async () => {
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'first thoughts');
    await fireEvent(sheet.note(), 'blur');
    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    await settle();
    // From here the read fails. The cache still holds an undated row, which is exactly
    // what must not be taken as "still undated" — another device may have dated it.
    stubFailedLogState();
    await fireEvent.press(sheet.bucket('I liked it'));
    await waitFor(() =>
      expect(onRank).toHaveBeenCalledWith('loved', 'start', { freshLog: expect.any(Boolean) }),
    );
    await settle();

    expect(callsTo('set_watch_date')).toHaveLength(0);
  });

  it('holds the comparisons once when a detail fails while the tap waits, then goes on', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'log_watched') {
        await held;
        return {
          data: null,
          error: { code: '22023', message: 'That note could not be saved.' },
        };
      }
      return { data: { status: 'ok' }, error: null };
    });
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'a thought');
    await fireEvent(sheet.note(), 'blur');
    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    await fireEvent.press(sheet.bucket('I liked it'));
    await act(async () => {
      release();
      await held;
    });
    await settle();

    // The refusal is on screen, and nothing has moved on past it.
    expect(sheet.getByText('That note could not be saved.')).toBeTruthy();
    expect(callsTo('log_title')).toHaveLength(0);
    expect(onRank).not.toHaveBeenCalled();

    // The reader has seen it. Nothing above the buckets is required, so the next tap
    // ranks even though the note is refused again.
    await fireEvent.press(sheet.bucket('I liked it'));
    await waitFor(() =>
      expect(onRank).toHaveBeenCalledWith('loved', 'start', { freshLog: expect.any(Boolean) }),
    );
    expect(callsTo('log_title')).toHaveLength(1);
  });

  it('writes no date with a first note when the reader has said Earlier', async () => {
    const sheet = await open(filmA);

    await sheet.openDate();
    await fireEvent.press(sheet.getByRole('button', { name: 'Earlier' }));
    await waitFor(() => expect(callsTo('clear_watch_date')).toHaveLength(1));
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'saw it years ago');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    expect(callsTo('log_watched')[0][1].p_watched_on).toBeNull();
  });

  it('waits for a note still being saved, then starts the comparisons', async () => {
    // The tap used to be dropped here: `choose` refused while any write was in flight,
    // and with the note above the buckets that is the ordinary sequence — type, pause
    // long enough for the autosave, tap a bucket.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'log_watched') await held;
      return { data: { status: 'ok' }, error: null };
    });
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'a thought');
    await fireEvent(sheet.note(), 'blur');
    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));

    await fireEvent.press(sheet.bucket('I liked it'));
    await settle();
    // Not before the note has landed: `log_title` must find the row the note created.
    expect(callsTo('log_title')).toHaveLength(0);
    expect(onRank).not.toHaveBeenCalled();

    await act(async () => {
      release();
      await held;
    });

    await waitFor(() =>
      expect(onRank).toHaveBeenCalledWith('loved', 'start', { freshLog: expect.any(Boolean) }),
    );
    expect(callsTo('log_title')).toHaveLength(1);
  });

  it('starts one ranking for two quick taps on a bucket', async () => {
    // The bucket's own write is held, so the second tap lands while the first is still
    // in flight — the only window in which a double tap can mean two rankings.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'log_title') await held;
      return { data: { status: 'ok' }, error: null };
    });
    const onRank = jest.fn();
    const sheet = await open(filmA, { onRank });

    await fireEvent.press(sheet.bucket('I liked it'));
    await waitFor(() => expect(callsTo('log_title')).toHaveLength(1));
    await fireEvent.press(sheet.bucket('I liked it'));
    await act(async () => {
      release();
      await held;
    });

    await waitFor(() => expect(onRank).toHaveBeenCalled());
    await settle();
    expect(callsTo('log_title')).toHaveLength(1);
    expect(onRank).toHaveBeenCalledTimes(1);
  });

  describe('counting the first watch', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const analytics = require('@/lib/analytics') as typeof import('@/lib/analytics');
    const watches = (spy: jest.SpyInstance) =>
      spy.mock.calls.filter(([event]) => event.name === 'watch_logged').map(([event]) => event);

    it('counts it once when a note written first is what created the row', async () => {
      const spy = jest.spyOn(analytics, 'track');
      try {
        const sheet = await open(filmA);
        await sheet.openNotes();
        await fireEvent.changeText(sheet.note(), 'worth it');
        await fireEvent.press(sheet.bucket('I liked it'));
        await waitFor(() => expect(callsTo('log_title')).toHaveLength(1));
        await settle();

        // `log_title` found the row the note had created, so it answered created: false
        // (the stub sends no `created`). The title is still this reader's first log.
        expect(watches(spy)).toEqual([
          {
            name: 'watch_logged',
            props: { kind: 'first', basis: 'today_default', surface: 'search' },
          },
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    it('counts nothing for a title that was already seen before the sheet opened', async () => {
      stubReads({ bucket: null, watched_on: '2026-08-01', note: null }, null);
      const spy = jest.spyOn(analytics, 'track');
      try {
        const sheet = await open(filmA);
        await waitFor(() =>
          expect(sheet.getByLabelText('Watch date').props.accessibilityState.disabled).toBe(
            false,
          ),
        );
        await fireEvent.press(sheet.bucket('I liked it'));
        await waitFor(() => expect(callsTo('log_title')).toHaveLength(1));
        await settle();

        expect(watches(spy)).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

/**
 * **`Watched N times ›` is not drawn on Watch History itself** (UI consistency sprint,
 * 2026-11-10). Watch History's *Edit ranking* opens this sheet; from there, the row that
 * pushes Watch History would stack the screen the reader is already on. Everywhere else
 * the row is unchanged.
 */
describe('the watch-history row', () => {
  const twoWatches = () =>
    mockFrom.mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        or: () => chain,
        limit: () => chain,
        gt: () => chain,
        maybeSingle: () =>
          Promise.resolve({
            data:
              table === 'user_media'
                ? { bucket: 'loved' }
                : table === 'rankings'
                  ? { bucket: 'loved' }
                  : null,
            error: null,
          }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({
            data: table === 'watch_events' ? null : [],
            count: table === 'watch_events' ? 2 : null,
            error: null,
          }).then(resolve),
      });
      return chain;
    });

  it('offers Watch history from the second viewing', async () => {
    twoWatches();
    const view = await open(filmA);
    await waitFor(() =>
      expect(view.getByRole('button', { name: 'Watched 2 times' })).toBeTruthy(),
    );
  });

  it('draws neither that row nor a date row when opened from Watch History', async () => {
    twoWatches();
    const view = await open(filmA, { inWatchHistory: true });
    // The sheet itself is open and ready for a band, and the count has been read — so the
    // absences below are the prop's doing, not a query that has not answered yet.
    await waitFor(() => expect(view.getByLabelText('I liked it')).toBeTruthy());
    await waitFor(() => expect(readsOf('watch_events')).toBeGreaterThan(0));
    await settle();
    await settle();
    expect(view.queryByRole('button', { name: 'Watched 2 times' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Watch date' })).toBeNull();
  });
});

/**
 * **Update Show or Keep Show, after the details** (WS-TVC, founder spec t168u §3B/§3E).
 *
 * A season's reveal that offered Update Show and was left by *Add details* has not
 * resolved the show. The post-rank sheet carries that decision in place of Done: the
 * details the reader adds land first (the same barrier a bucket tap waits on), then
 * Update Show opens the show's correction with the link, or Keep Show records the
 * reaffirmation and ends the flow. Leaving the sheet any other way records nothing.
 */
describe('the show decision a season ranking left open', () => {
  const placed = { score: 9.1, position: 2, category: 'tv_seasons' };
  const decision = {
    showId: 'show-1',
    bucket: 'loved' as const,
    linkedPlacementId: 'placement-s2',
    showScore: 9.5,
  };
  const season: LoggableTitle = {
    ...filmA,
    id: 'season-2',
    title: 'Show · Season 2',
    kind: 'season',
  };

  /** FU1113-D D3/D4: the act's own words, no score, the eligible flow has no Done. */
  it('offers full-width Update Show Ranking and centred Keep Show Ranking, no score, in place of Done', async () => {
    const sheet = await open(season, {
      postRank: placed,
      showDecision: decision,
      onUpdateShow: jest.fn(),
    });

    await waitFor(() => expect(sheet.getByTestId('log-show-decision')).toBeTruthy());
    const update = sheet.getByRole('button', { name: 'Update Show Ranking' });
    const keep = sheet.getByRole('button', { name: 'Keep Show Ranking' });
    expect(update).toBe(sheet.getByTestId('log-update-show'));
    expect(keep).toBe(sheet.getByTestId('log-keep-show'));
    expect(sheet.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(sheet.queryByText(/Show 9\.5/)).toBeNull();
    expect(sheet.queryByText(/Show \d/)).toBeNull();

    // Update: the filled primary, standard size, stretched across the form (its column
    // centres nothing). Keep: its own row, centred across the same width, under it.
    const updateStyle = StyleSheet.flatten(update.props.style);
    expect(updateStyle.backgroundColor).toBe(theme.semantic.action);
    expect(updateStyle.minHeight).toBe(theme.layout.buttonMinHeight);
    expect(updateStyle.alignSelf).toBeUndefined();
    const column = StyleSheet.flatten(sheet.getByTestId('log-show-decision').props.style);
    expect(column.alignItems).toBeUndefined();
    expect(column.flexDirection).toBeUndefined();
    const keepRow = sheet.getByTestId('log-keep-row');
    expect(StyleSheet.flatten(keepRow.props.style).alignItems).toBe('center');
    expect(within(keepRow).getByRole('button', { name: 'Keep Show Ranking' })).toBe(keep);
    expect(StyleSheet.flatten(keep.props.style).backgroundColor).toBe('transparent');
  });

  it('keeps the same labels when the show score is not known', async () => {
    const sheet = await open(season, {
      postRank: placed,
      showDecision: { ...decision, showScore: null },
      onUpdateShow: jest.fn(),
    });

    await waitFor(() =>
      expect(sheet.getByRole('button', { name: 'Update Show Ranking' })).toBeTruthy(),
    );
    expect(sheet.getByRole('button', { name: 'Keep Show Ranking' })).toBeTruthy();
  });

  it('keeps the ordinary Done when no decision was carried', async () => {
    const sheet = await open(season, { postRank: placed });

    await waitFor(() => expect(sheet.getByRole('button', { name: 'Done' })).toBeTruthy());
    expect(sheet.queryByTestId('log-show-decision')).toBeNull();
  });

  it('lands a typed note before Update Show hands over the link', async () => {
    const order: string[] = [];
    mockRpc.mockImplementation((name: string) => {
      order.push(name);
      return Promise.resolve({ data: { status: 'ok' }, error: null });
    });
    const onUpdateShow = jest.fn(() => order.push('update-show'));
    const sheet = await open(season, {
      postRank: placed,
      showDecision: decision,
      onUpdateShow,
    });
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'the finale earns it');

    await fireEvent.press(sheet.getByTestId('log-update-show'));

    await waitFor(() => expect(onUpdateShow).toHaveBeenCalledTimes(1));
    expect(onUpdateShow).toHaveBeenCalledWith({
      showId: 'show-1',
      bucket: 'loved',
      linkedPlacementId: 'placement-s2',
    });
    expect(order.indexOf('log_watched')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('log_watched')).toBeLessThan(order.indexOf('update-show'));
    expect(callsTo('keep_show')).toHaveLength(0);
  });

  it('keeps once on a double tap, after the details, and then finishes', async () => {
    const order: string[] = [];
    mockRpc.mockImplementation((name: string) => {
      order.push(name);
      return Promise.resolve({
        data:
          name === 'keep_show'
            ? { status: 'kept', created: true, kept_at: 'now' }
            : { status: 'ok' },
        error: null,
      });
    });
    const onDone = jest.fn();
    const sheet = await open(season, { postRank: placed, showDecision: decision, onDone });
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'still a ten');

    await act(async () => {
      fireEvent.press(sheet.getByTestId('log-keep-show'));
      fireEvent.press(sheet.getByTestId('log-keep-show'));
    });

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    await settle();
    expect(callsTo('keep_show')).toHaveLength(1);
    expect(callsTo('keep_show')[0][1]).toEqual({ p_season_placement_id: 'placement-s2' });
    expect(order.indexOf('log_watched')).toBeLessThan(order.indexOf('keep_show'));
  });

  it('stays open with the reason when Keep Show is refused, and can try again', async () => {
    failing('keep_show', { code: 'P0002', message: 'stale' });
    const onDone = jest.fn();
    const sheet = await open(season, { postRank: placed, showDecision: decision, onDone });
    await waitFor(() => expect(sheet.getByTestId('log-keep-show')).toBeTruthy());

    await fireEvent.press(sheet.getByTestId('log-keep-show'));

    await waitFor(() => expect(sheet.getByTestId('log-keep-error')).toBeTruthy());
    expect(
      sheet.getByText('This season’s ranking has moved on, so there is nothing to keep.'),
    ).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    // Nothing optimistic: both choices are still there.
    expect(sheet.getByTestId('log-update-show')).toBeTruthy();

    mockRpc.mockResolvedValue({
      data: { status: 'kept', created: true, kept_at: 'now' },
      error: null,
    });
    await fireEvent.press(sheet.getByTestId('log-keep-show'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(callsTo('keep_show')).toHaveLength(2);
  });

  it('holds the first decision once when a detail failed meanwhile', async () => {
    failing('log_watched', { code: '22023', message: 'note refused' });
    const onUpdateShow = jest.fn();
    const sheet = await open(season, {
      postRank: placed,
      showDecision: decision,
      onUpdateShow,
    });
    await sheet.openNotes();
    await fireEvent.changeText(sheet.note(), 'will be refused');

    await fireEvent.press(sheet.getByTestId('log-update-show'));
    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    await waitFor(() => expect(sheet.getByText('note refused')).toBeTruthy());
    expect(onUpdateShow).not.toHaveBeenCalled();

    // The second tap goes on: nothing above is required to decide the show.
    await fireEvent.press(sheet.getByTestId('log-update-show'));
    await waitFor(() => expect(onUpdateShow).toHaveBeenCalledTimes(1));
  });

  it('does not finish a later sheet when a Keep Show reply lands after closing', async () => {
    // Independent review (WS-TVC): the reply of a Keep sent before the sheet closed must
    // not run `onDone` for whatever the reader has open by then.
    let answer: (value: unknown) => void = () => {};
    mockRpc.mockImplementation((name: string) =>
      name === 'keep_show'
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : Promise.resolve({ data: { status: 'ok' }, error: null }),
    );
    const onDone = jest.fn();
    const sheet = await open(season, { postRank: placed, showDecision: decision, onDone });
    await waitFor(() => expect(sheet.getByTestId('log-keep-show')).toBeTruthy());

    await fireEvent.press(sheet.getByTestId('log-keep-show'));
    await waitFor(() => expect(callsTo('keep_show')).toHaveLength(1));
    await sheet.show(null);
    await act(async () => {
      answer({ data: { status: 'kept', created: true, kept_at: 'now' }, error: null });
    });
    await settle();

    expect(onDone).not.toHaveBeenCalled();
  });

  /**
   * Independent review (Codex P2 on #286): a note still saving when Update Show or Keep
   * Show is tapped holds the decision at the details barrier. A sheet closed while it
   * waits must not go on to open the show's correction or send the reaffirmation.
   */
  describe('when the sheet closes while a detail is still saving', () => {
    /** `log_watched` stays in flight until the test answers it; everything else is ok. */
    const holdingTheNote = () => {
      let answer: () => void = () => {};
      mockRpc.mockImplementation((name: string) =>
        name === 'log_watched'
          ? new Promise((resolve) => {
              answer = () => resolve({ data: { status: 'ok' }, error: null });
            })
          : Promise.resolve({
              data:
                name === 'keep_show'
                  ? { status: 'kept', created: true, kept_at: 'now' }
                  : { status: 'ok' },
              error: null,
            }),
      );
      return () => answer();
    };

    it('does not open Update Show after the sheet is gone', async () => {
      const answerNote = holdingTheNote();
      const onUpdateShow = jest.fn();
      const sheet = await open(season, {
        postRank: placed,
        showDecision: decision,
        onUpdateShow,
      });
      await sheet.openNotes();
      await fireEvent.changeText(sheet.note(), 'still saving');

      await fireEvent.press(sheet.getByTestId('log-update-show'));
      await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
      await sheet.show(null);
      await act(async () => {
        answerNote();
      });
      await settle();

      expect(onUpdateShow).not.toHaveBeenCalled();
    });

    it('does not send Keep Show after the sheet is gone', async () => {
      const answerNote = holdingTheNote();
      const onDone = jest.fn();
      const sheet = await open(season, { postRank: placed, showDecision: decision, onDone });
      await sheet.openNotes();
      await fireEvent.changeText(sheet.note(), 'still saving');

      await fireEvent.press(sheet.getByTestId('log-keep-show'));
      await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
      await sheet.show(null);
      await act(async () => {
        answerNote();
      });
      await settle();

      expect(callsTo('keep_show')).toHaveLength(0);
      expect(onDone).not.toHaveBeenCalled();
    });

    it('still hands over Update Show once the save lands, while the sheet stays open', async () => {
      const answerNote = holdingTheNote();
      const onUpdateShow = jest.fn();
      const sheet = await open(season, {
        postRank: placed,
        showDecision: decision,
        onUpdateShow,
      });
      await sheet.openNotes();
      await fireEvent.changeText(sheet.note(), 'still saving');

      await fireEvent.press(sheet.getByTestId('log-update-show'));
      await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
      expect(onUpdateShow).not.toHaveBeenCalled();
      await act(async () => {
        answerNote();
      });

      await waitFor(() => expect(onUpdateShow).toHaveBeenCalledTimes(1));
    });

    it('still keeps the show once the save lands, while the sheet stays open', async () => {
      const answerNote = holdingTheNote();
      const onDone = jest.fn();
      const sheet = await open(season, { postRank: placed, showDecision: decision, onDone });
      await sheet.openNotes();
      await fireEvent.changeText(sheet.note(), 'still saving');

      await fireEvent.press(sheet.getByTestId('log-keep-show'));
      await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
      expect(callsTo('keep_show')).toHaveLength(0);
      await act(async () => {
        answerNote();
      });

      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(callsTo('keep_show')).toHaveLength(1);
    });
  });

  it('records nothing when the sheet is dismissed', async () => {
    const onClose = jest.fn();
    const onUpdateShow = jest.fn();
    const sheet = await open(season, {
      postRank: placed,
      showDecision: decision,
      onUpdateShow,
      onClose,
    });
    await waitFor(() => expect(sheet.getByTestId('log-show-decision')).toBeTruthy());

    await fireEvent.press(sheet.getByLabelText('Close'));
    await settle();

    expect(callsTo('keep_show')).toHaveLength(0);
    expect(onUpdateShow).not.toHaveBeenCalled();
  });
});
