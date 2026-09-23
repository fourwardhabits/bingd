import { fireEvent, waitFor } from '@testing-library/react-native';
import { strToU8, zipSync } from 'fflate';

import { renderWithProviders } from '@/test-utils/render';

import { ImportScreen, shouldOfferRanking } from './ImportScreen';

/**
 * The importer's screen, exercised through the states a person actually passes.
 *
 * The picker and the network are the two things a test cannot have, so both are mocked at
 * their own boundary and nothing else is: the archive is a **real ZIP**, built here and
 * read by the real `zipSource`, `inspect`, `parseCsv` and `normalise`. So what these assert
 * is the whole reading path arriving at the right words, rather than a screen fed a
 * hand-made preview object that could drift from what the reader produces.
 */

/** Job ids as the server issues them: a link's id must look like one to be read. */
const JOB = '11111111-2222-4333-8444-555555555555';
const GONE = '99999999-8888-4777-8666-555555555555';

const mockBack = jest.fn();
const mockDismissTo = jest.fn();
const mockReplace = jest.fn();
let mockCanGoBack = true;
const mockRpc = jest.fn();
const mockFrom = jest.fn();
let mockRpcResults: Record<string, unknown> = {};
let mockRpcErrors: Record<string, unknown> = {};
/** RPCs whose error is a lost answer (an aborted fetch) rather than a server refusal. */
let mockRpcLost = new Set<string>();

/** What the picker will answer with. `null` means the person cancelled. */
let mockPicked: Uint8Array | null = null;
let mockPickThrows = false;
/**
 * What the picker *says* the file weighs.
 *
 * Its own knob rather than `mockPicked.length`, because the guard it feeds exists to refuse
 * a file **before** it is read — so the only honest test of it is one where the bytes are
 * never fetched, which means the size cannot come from them.
 */
let mockPickedSize: number | undefined;

/** What a `select` on `import_jobs` answers. The open-job recovery reads the table. */
let mockLiveJob: { data: unknown; error: unknown } = { data: null, error: null };
let mockLiveJobThrows = false;
/** Every filter the open-job lookup applied, so a test can assert what it did NOT apply. */
let mockFilters: string[] = [];

jest.mock('expo-file-system', () => ({
  File: {
    pickFileAsync: () => {
      if (mockPickThrows) return Promise.reject(new Error('no'));
      if (mockPicked === null) return Promise.resolve({ canceled: true, result: null });
      return Promise.resolve({
        canceled: false,
        result: {
          size: mockPickedSize ?? mockPicked.length,
          bytes: () => Promise.resolve(mockPicked),
        },
      });
    },
  },
}));

/**
 * An answer that may differ per call.
 *
 * `import_status` is now read twice for different reasons — once before staging, to find out
 * whether the job `import_create` handed back is one the worker already owns, and then
 * repeatedly by the poll. A single fixed answer cannot express "pending, then done", which
 * is the ordinary case. So a result may be a function, and is called each time.
 */
const mockAnswer = (name: string) => {
  const value = mockRpcResults[name];
  return typeof value === 'function' ? (value as () => unknown)() : (value ?? null);
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      const error = mockRpcErrors[name] ?? null;
      const data = error ? null : mockAnswer(name);
      const result = {
        data,
        error,
        // PostgREST's `status: 0` is a request whose answer never came back.
        ...(error && mockRpcLost.has(name) ? { status: 0 } : {}),
        // `import_status` is read with `.maybeSingle()`.
        maybeSingle: () => Promise.resolve({ data, error }),
      };
      return Object.assign(Promise.resolve(result), result);
    },
    /**
     * **The builder records its filters rather than swallowing them**, which is the whole
     * reason this comment exists.
     *
     * An earlier version implemented `.is()` as an identity, and a test asserting that a
     * finished import is restored on reopen passed against a hook that filtered
     * `completed_at is null` — a predicate that excludes every finished job. The test was
     * green and the behaviour was impossible. A mock that quietly accepts any query is not
     * a stand-in for a database, it is a way of testing nothing.
     */
    from: (table: string) => {
      mockFrom(table);
      const builder: Record<string, unknown> = {
        select: () => builder,
        is: (column: string, value: unknown) => {
          mockFilters.push(`is:${column}:${String(value)}`);
          return builder;
        },
        eq: (column: string, value: unknown) => {
          mockFilters.push(`eq:${column}:${String(value)}`);
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: () =>
          mockLiveJobThrows
            ? Promise.reject(new Error('offline'))
            : Promise.resolve(mockLiveJob),
      };
      return builder;
    },
  },
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: () => {},
    replace: mockReplace,
    back: mockBack,
    dismissTo: mockDismissTo,
    canGoBack: () => mockCanGoBack,
  }),
  Stack: { Screen: () => null },
}));

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({
  track: (event: unknown) => mockTrack(event),
}));

/**
 * A Letterboxd export, as a real archive.
 *
 * Deliberately includes the files the contract refuses to open, so that every test in this
 * file is running against an archive that *contains* private material and is proving the
 * screen never renders any of it.
 */
const exportZip = (watched: string, extras: Record<string, string> = {}) =>
  zipSync(
    Object.fromEntries(
      Object.entries({
        'letterboxd-sai-2026-09-11/watched.csv': watched,
        'letterboxd-sai-2026-09-11/reviews.csv': 'Date,Name,Review\n2024-01-02,Shrek,secret\n',
        'letterboxd-sai-2026-09-11/deleted/diary.csv': 'Date,Name\n2024-01-02,Regret\n',
        ...extras,
      }).map(([k, v]) => [k, strToU8(v)]),
    ),
  );

const TWO_FILMS =
  'Date,Name,Year,Letterboxd URI\n' +
  '2024-01-02,Shrek,2001,https://boxd.it/2a\n' +
  '2024-01-03,Dune,2021,https://boxd.it/2b\n';

beforeEach(() => {
  mockBack.mockClear();
  mockDismissTo.mockClear();
  mockReplace.mockClear();
  mockCanGoBack = true;
  mockRpc.mockClear();
  mockFrom.mockClear();
  mockTrack.mockClear();
  mockRpcResults = {};
  mockRpcErrors = {};
  mockRpcLost = new Set();
  mockPicked = null;
  mockPickThrows = false;
  mockPickedSize = undefined;
  mockLiveJob = { data: null, error: null };
  mockLiveJobThrows = false;
  mockFilters = [];
});

describe('before a file is chosen', () => {
  it('says what is read and what is never opened', async () => {
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    expect(screen.getByText(/movies you.+watched/)).toBeTruthy();
    expect(screen.getByText(/never open your reviews/)).toBeTruthy();
    // The retention promise, which is Contract V3 §14 and the thing somebody is deciding on.
    expect(screen.getByText(/ZIP stays on your phone/)).toBeTruthy();
    // **And the links, which an earlier draft of this sentence left out.** `filmUri` and
    // every `diaryUri` do cross the wire and are kept permanently — the diary one is half
    // the primary key that makes a re-import a no-op. Asserted here because the failure
    // mode is a privacy sentence quietly drifting into being untrue.
    expect(screen.getByText(/Letterboxd links/)).toBeTruthy();
  });

  it('counts the entry point once', async () => {
    await renderWithProviders(<ImportScreen surface="onboarding" />);

    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_opened',
      props: { surface: 'onboarding' },
    });
  });
});

describe('choosing an export', () => {
  /**
   * **Choose a different file starts a fresh page** (founder, physical preview QA,
   * 2026-09-14). One scroll view used to carry every phase, so an offset from the preview
   * could survive into the shorter intro and draw it scrolled past its own end. The scroll
   * body is keyed by phase: coming back is a new scroll view, not the preview's.
   */
  it('returns from the preview on a new scroll body, not the preview’s', async () => {
    mockPicked = exportZip(TWO_FILMS);
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);
    await fireEvent.press(screen.getByText('Choose Letterboxd ZIP'));
    await waitFor(() => expect(screen.getByText('Ready to import')).toBeTruthy());

    type HostNode = { props: Record<string, unknown>; parent: HostNode | null };
    const scrollAbove = (text: string) => {
      let node = (screen.getByText(text) as unknown as HostNode).parent;
      while (node && node.props?.contentContainerStyle === undefined) node = node.parent;
      return node;
    };
    const previewScroll = scrollAbove('Ready to import');
    expect(previewScroll).toBeTruthy();

    await fireEvent.press(screen.getByText('Choose a different file'));
    await waitFor(() => expect(screen.getByText('Bring your Letterboxd history')).toBeTruthy());

    expect(scrollAbove('Bring your Letterboxd history')).not.toBe(previewScroll);
  });

  it('previews the counts and sends nothing yet', async () => {
    mockPicked = exportZip(TWO_FILMS);
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose Letterboxd ZIP'));

    await waitFor(() => expect(screen.getByText(/Here.+s what we found/)).toBeTruthy());
    expect(screen.getByText('Ready to import')).toBeTruthy();
    expect(screen.getByText('Watched films')).toBeTruthy();
    expect(screen.getByText('Import 2 films')).toBeTruthy();
    // The whole point of a preview: the decision has not been made yet.
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_archive_selected',
      props: { outcome: 'ok' },
    });
  });

  it('never renders anything out of the files it refuses to open', async () => {
    mockPicked = exportZip(TWO_FILMS);
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose Letterboxd ZIP'));

    await waitFor(() => expect(screen.getByText(/Here.+s what we found/)).toBeTruthy());
    expect(screen.queryByText(/secret/)).toBeNull();
    expect(screen.queryByText(/Regret/)).toBeNull();
  });

  it('explains a CSV picked instead of the archive, and offers the instructions', async () => {
    mockPicked = strToU8(TWO_FILMS);
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose Letterboxd ZIP'));

    await waitFor(() => expect(screen.getByText(/not the Letterboxd ZIP/)).toBeTruthy());
    expect(screen.getByText(/unzipped it/)).toBeTruthy();
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_archive_selected',
      props: { outcome: 'not_a_zip' },
    });
  });

  it('explains a zip that is not a Letterboxd export', async () => {
    mockPicked = zipSync({ 'holiday.txt': strToU8('hello') });
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose Letterboxd ZIP'));

    await waitFor(() => expect(screen.getByText(/isn.+t from Letterboxd/)).toBeTruthy());
  });

  it('treats an export with no films as empty rather than as an error', async () => {
    mockPicked = exportZip('Date,Name,Year,Letterboxd URI\n');
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose Letterboxd ZIP'));

    await waitFor(() => expect(screen.getByText(/nothing in that file yet/)).toBeTruthy());
  });

  it('goes quietly back to the start when the picker is dismissed', async () => {
    mockPicked = null;
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose Letterboxd ZIP'));

    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith({
        name: 'import_archive_selected',
        props: { outcome: 'cancelled' },
      }),
    );
    // No apology for a decision somebody made on purpose.
    expect(screen.getByText('Choose Letterboxd ZIP')).toBeTruthy();
  });
});

describe('uploading', () => {
  it('stages the rows, hands the job over, and then says the app may be closed', async () => {
    mockPicked = exportZip(TWO_FILMS);
    mockRpcResults = { import_create: 'job-1', import_status: null };
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose Letterboxd ZIP'));
    await waitFor(() => expect(screen.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(screen.getByText('Import 2 films'));

    await waitFor(() => expect(screen.getByText(/You can close bingd\./)).toBeTruthy());

    const called = mockRpc.mock.calls.map(([name]) => name);
    // The `import_status` between `create` and `stage` is the guard against staging onto a
    // job the worker already owns: `import_create` adopts an open job, and `import_stage`
    // answers one that has moved on with a `22023` that used to be reported as a dropped
    // connection. Asking first is what turns that dead end into "an import is already
    // running", so its position in this sequence is the behaviour, not an implementation
    // detail that happens to be observable.
    expect(called).toEqual([
      'import_create',
      'import_status',
      'import_stage',
      'import_ready',
      'import_status',
    ]);

    const [, stageArgs] = mockRpc.mock.calls.find(([name]) => name === 'import_stage')!;
    expect((stageArgs as { p_rows: unknown[] }).p_rows).toHaveLength(2);
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_started',
      props: { films: 2, viewings: 0 },
    });
  });

  it('keeps the preview when the upload fails, so trying again is a real offer', async () => {
    mockPicked = exportZip(TWO_FILMS);
    mockRpcResults = { import_create: 'job-1' };
    mockRpcErrors = { import_stage: { message: 'network' } };
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose Letterboxd ZIP'));
    await waitFor(() => expect(screen.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(screen.getByText('Import 2 films'));

    await waitFor(() => expect(screen.getByText(/didn.+t finish sending/)).toBeTruthy());
    // `import_create` reuses the open job and `import_rows_once` makes a re-sent page free,
    // which is what makes this copy true rather than reassuring.
    expect(screen.getByText(/Nothing gets sent twice/)).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('treats a page whose answer was lost as a failed upload, which is safe to resend', async () => {
    // The production fetch deadline aborts a stalled request, and PostgREST answers that as
    // `status: 0`. A page is idempotent, so saying it did not finish is true enough.
    mockPicked = exportZip(TWO_FILMS);
    mockRpcResults = { import_create: 'job-1' };
    mockRpcErrors = { import_stage: { message: 'AbortError: timed out', code: '' } };
    mockRpcLost = new Set(['import_stage']);
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose Letterboxd ZIP'));
    await waitFor(() => expect(screen.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(screen.getByText('Import 2 films'));

    await waitFor(() => expect(screen.getByText(/didn.+t finish sending/)).toBeTruthy());
  });

  /**
   * **A lost hand-off is not a failed one** (independent review 83b). `import_ready` may
   * have committed before its reply was lost, so the screen says it could not check rather
   * than inviting a resend that would meet the person's own running import.
   */
  it('says it could not check when the hand-off answer was lost, and discards nothing', async () => {
    mockPicked = exportZip(TWO_FILMS);
    mockRpcResults = {
      import_create: '11111111-2222-4333-8444-555555555555',
      import_status: { status: 'pending', counts: null, completed_at: null },
    };
    mockRpcErrors = { import_ready: { message: 'AbortError: timed out', code: '' } };
    mockRpcLost = new Set(['import_ready']);
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose Letterboxd ZIP'));
    await waitFor(() => expect(screen.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(screen.getByText('Import 2 films'));

    await waitFor(() => expect(screen.getByText('We couldn’t check your import')).toBeTruthy());
    expect(screen.queryByText(/didn.+t finish sending/)).toBeNull();
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain('import_discard');
  });
});

describe('when it is over', () => {
  it('reports what landed and does not hide what did not', async () => {
    mockPicked = exportZip(TWO_FILMS);
    // **Pending first, done afterwards.** The pre-stage read must find a job that is still
    // taking rows, or `start` correctly refuses to stage onto somebody else's running
    // import and this never gets as far as the summary it is about.
    let reads = 0;
    mockRpcResults = {
      import_create: 'job-1',
      import_status: () => {
        reads += 1;
        return reads === 1
          ? { status: 'pending', counts: null, completed_at: null }
          : {
              status: 'done',
              counts: { applied: 1, watched: 1, watchlist: 0, viewings: 0, unmatched: 1 },
              completed_at: '2026-09-11T00:00:00.000Z',
            };
      },
    };
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose Letterboxd ZIP'));
    await waitFor(() => expect(screen.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(screen.getByText('Import 2 films'));

    await waitFor(() => expect(screen.getByText('Your Letterboxd history is in')).toBeTruthy());
    // The unresolved sentence: a partial import must not read as a complete one.
    expect(screen.getByText(/couldn.+t find 1 film/)).toBeTruthy();
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_completed',
      props: { applied: 1, unresolved: 1 },
    });
  });

  /**
   * **The counts are in two units, and the screen has to keep them apart.**
   *
   * `watched`, `kept` and `watchlist` are films; `viewings` is diary entries. The defect
   * this pins is a summary that said "Added to your collection: 22" beside a collection
   * that had not changed — every row the worker finished with was counted as an addition,
   * including the ones it deliberately left alone.
   */
  it('separates what it added from what was already there', async () => {
    mockPicked = exportZip(TWO_FILMS);
    let reads = 0;
    mockRpcResults = {
      import_create: 'job-1',
      import_status: () => {
        reads += 1;
        return reads === 1
          ? { status: 'pending', counts: null, completed_at: null }
          : {
              status: 'done',
              // One film added, two left alone (one ranked here, one imported before),
              // three diary entries across them — a rewatch is not a second film.
              counts: {
                applied: 3,
                watched: 1,
                kept: 1,
                already: 1,
                watchlist: 0,
                viewings: 3,
              },
              completed_at: '2026-09-11T00:00:00.000Z',
            };
      },
    };
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose Letterboxd ZIP'));
    await waitFor(() => expect(screen.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(screen.getByText('Import 2 films'));

    await waitFor(() => expect(screen.getByText('Added as watched')).toBeTruthy());
    expect(screen.getByLabelText('1 Added as watched')).toBeTruthy();
    expect(screen.getByLabelText('2 Already in bingd')).toBeTruthy();
    // Named as diary entries, because it is the one number that is not a count of films.
    expect(screen.getByLabelText('3 Diary entries saved')).toBeTruthy();
    // The helper line that used to explain why an import never overwrites a ranking is
    // gone (founder, 2026-09-22): the bridge is a question and a button, and the rule it
    // stated is enforced in the database (`20261018000100`), not in this paragraph.
    expect(screen.queryByText(/start unranked/)).toBeNull();
    // A zero is left out rather than drawn.
    expect(screen.queryByText('Added to your watchlist')).toBeNull();
  });

  it('does not claim a history arrived when nothing did', async () => {
    // A re-import of an archive whose films are all already ranked. Everything is `applied`
    // — the worker finished with every row — and nothing was written.
    mockPicked = exportZip(TWO_FILMS);
    let reads = 0;
    mockRpcResults = {
      import_create: 'job-1',
      import_status: () => {
        reads += 1;
        return reads === 1
          ? { status: 'pending', counts: null, completed_at: null }
          : {
              status: 'done',
              counts: { applied: 2, watched: 0, kept: 2, watchlist: 0, viewings: 2 },
              completed_at: '2026-09-11T00:00:00.000Z',
            };
      },
    };
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose Letterboxd ZIP'));
    await waitFor(() => expect(screen.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(screen.getByText('Import 2 films'));

    await waitFor(() =>
      expect(screen.getByText('Your Letterboxd history is already here')).toBeTruthy(),
    );
    expect(screen.queryByText('Your Letterboxd history is in')).toBeNull();
    // Nothing arrived, so there is nothing to rank.
    expect(screen.queryByText('Rank imported titles')).toBeNull();
  });
});

/**
 * The paths that exist because an import outlives the screen that started it.
 *
 * Everything above is one person, one archive, one sitting. These are the cases where the
 * server already has an opinion when the screen opens — which is the ordinary case for a
 * feature whose whole promise is "you can close the app and come back".
 */
describe('an import that is already happening', () => {
  it('picks up a running import when the screen opens', async () => {
    // The promise the `working` screen makes out loud. Without this, coming back meant a
    // fresh hook at `idle`: the running import invisible, and the next attempt to start one
    // walking into `import_create` adopting it and `import_stage` refusing.
    mockLiveJob = {
      data: { id: 'job-live', status: 'working', counts: {}, completed_at: null },
      error: null,
    };

    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await waitFor(() =>
      expect(screen.getByText('Importing your Letterboxd history')).toBeTruthy(),
    );
    expect(mockFrom).toHaveBeenCalledWith('import_jobs');
  });

  it('shows the summary when the import finished while they were away', async () => {
    mockLiveJob = {
      data: {
        id: 'job-live',
        status: 'done',
        counts: { applied: 2, watched: 2, watchlist: 0, viewings: 0 },
        completed_at: new Date(Date.now() - 60_000).toISOString(),
      },
      error: null,
    };

    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await waitFor(() => expect(screen.getByText('Your Letterboxd history is in')).toBeTruthy());
    // And a way on, so a restored summary is not a dead end for somebody holding a second
    // archive.
    expect(screen.getByText('Import another file')).toBeTruthy();
  });

  /**
   * **The filter that made the test above a lie.**
   *
   * The lookup asked for `completed_at is null`, and `_import_settle` writes `done` and
   * `completed_at` in the same statement — so a finished job was excluded from the one
   * query meant to find it, and the summary was unreachable on reopen. The test passed
   * because the mocked builder treated `.is()` as an identity.
   *
   * Asserted as the absence of the filter rather than only through the state, because that
   * is the thing that was wrong, and a future refactor could restore the filter while some
   * other path happened to produce a summary.
   */
  it('does not exclude finished jobs from the lookup', async () => {
    await renderWithProviders(<ImportScreen surface="settings" />);

    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('import_jobs'));
    expect(mockFilters).not.toContain('is:completed_at:null');
  });

  it('leaves an import that finished long ago alone', async () => {
    // Restoring it would mean opening the importer onto last month's summary for ever.
    mockLiveJob = {
      data: {
        id: 'job-old',
        status: 'done',
        counts: { applied: 2, watched: 2, watchlist: 0, viewings: 0 },
        completed_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      },
      error: null,
    };

    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('import_jobs'));
    expect(screen.getByText('Choose Letterboxd ZIP')).toBeTruthy();
  });

  it('ignores a half-staged job, because there is nothing to show for it', async () => {
    // A `pending` job is an upload that did not finish. The person is here to choose a
    // file, not to be told about a job whose contents they cannot see.
    mockLiveJob = {
      data: { id: 'job-half', status: 'pending', counts: {}, completed_at: null },
      error: null,
    };

    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('import_jobs'));
    expect(screen.getByText('Choose Letterboxd ZIP')).toBeTruthy();
  });

  it('still offers the importer when the lookup itself fails', async () => {
    // The recovery is a convenience; the importer is the feature. A throw here used to be
    // an unhandled rejection out of an effect that cannot await anything.
    mockLiveJobThrows = true;

    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('import_jobs'));
    expect(screen.getByText('Choose Letterboxd ZIP')).toBeTruthy();
  });

  it('refuses the second archive out loud rather than swallowing it', async () => {
    /**
     * **The refusal is the behaviour, and the old screen was the bug.**
     *
     * `import_create` handed back a job the worker owns, so this archive cannot be staged.
     * The first version settled to `working` — which reads as "your file is being
     * processed", drops the preview without a word, and then shows the *other* import's
     * counts under "Your history is in". Somebody who picked a second archive was told the
     * first one's result and had no way to learn their file was never sent.
     */
    mockPicked = exportZip(TWO_FILMS);
    mockRpcResults = {
      import_create: 'job-1',
      import_status: { status: 'matching', counts: {}, completed_at: null },
    };

    const screen = await renderWithProviders(<ImportScreen surface="settings" />);
    await fireEvent.press(screen.getByText('Choose Letterboxd ZIP'));
    await waitFor(() => expect(screen.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(screen.getByText('Import 2 films'));

    await waitFor(() => expect(screen.getByText('An import is already running')).toBeTruthy());
    // The sentence says what happened to *this* file, not what the other one is doing.
    expect(screen.getByText(/This file wasn.+t sent/)).toBeTruthy();

    // Not staged onto: the running import is left alone.
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain('import_stage');
    // And the import that was never started is not counted as one.
    expect(mockTrack).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'import_started' }),
    );
    // No pointless retry, because retrying fails identically until the other job settles.
    expect(screen.queryByText('Try again')).toBeNull();
  });

  it('offers a look at the running import rather than only naming it', async () => {
    mockPicked = exportZip(TWO_FILMS);
    mockRpcResults = {
      import_create: 'job-1',
      import_status: { status: 'matching', counts: {}, completed_at: null },
    };

    const screen = await renderWithProviders(<ImportScreen surface="settings" />);
    await fireEvent.press(screen.getByText('Choose Letterboxd ZIP'));
    await waitFor(() => expect(screen.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(screen.getByText('Import 2 films'));
    await waitFor(() => expect(screen.getByText('An import is already running')).toBeTruthy());

    await fireEvent.press(screen.getByText('See the import that’s running'));

    await waitFor(() =>
      expect(screen.getByText('Importing your Letterboxd history')).toBeTruthy(),
    );
  });
});

/**
 * Opened from a notification (`/settings/import?job=<id>`, 20260917001500).
 *
 * The tap can arrive on a cold start, from the background or with the app open. Every one of
 * those mounts this screen with a job id and nothing else, so the screen has to rebuild the
 * right phase from the server alone; no transient state from the session that started the
 * import survives to help it.
 */
describe('opened for a named import', () => {
  const job = (status: string, extra: Record<string, unknown> = {}) => ({
    status,
    counts: {},
    completed_at: status === 'done' || status === 'failed' ? '2026-01-01T00:00:00.000Z' : null,
    ...extra,
  });

  it('shows a still-running import, and asks about that job rather than the latest one', async () => {
    mockRpcResults = { import_status: job('matching') };
    const screen = await renderWithProviders(<ImportScreen surface="settings" jobId={JOB} />);

    await waitFor(() =>
      expect(screen.getByText('Importing your Letterboxd history')).toBeTruthy(),
    );
    expect(mockRpc).toHaveBeenCalledWith('import_status', { p_job_id: JOB });
    expect(mockFrom).not.toHaveBeenCalledWith('import_jobs');
  });

  it('shows the summary of a finished import, however long ago it finished', async () => {
    // Months old: the 24-hour restore window is for an unprompted reopen, not for a job
    // somebody asked for by name.
    mockRpcResults = {
      import_status: job('done', { counts: { applied: 19, watched: 19, watchlist: 2 } }),
    };
    const screen = await renderWithProviders(<ImportScreen surface="settings" jobId={JOB} />);

    await waitFor(() => expect(screen.getByText('Your Letterboxd history is in')).toBeTruthy());
    expect(screen.getByLabelText('19 Added as watched')).toBeTruthy();
    expect(screen.getByLabelText('2 Added to your watchlist')).toBeTruthy();
  });

  it('shows a failed import as a failure, with a way to try again', async () => {
    mockRpcResults = { import_status: job('failed') };
    const screen = await renderWithProviders(<ImportScreen surface="settings" jobId={JOB} />);

    await waitFor(() =>
      expect(screen.getByText('We couldn’t finish your Letterboxd import')).toBeTruthy(),
    );
    expect(screen.getByText('Choose Letterboxd ZIP')).toBeTruthy();
    expect(screen.queryByText('Your Letterboxd history is in')).toBeNull();
  });

  it('says it could not check, rather than offering a new import, when the job cannot be read', async () => {
    // A notification tapped on a bad connection. The import is fine; the importer's intro
    // would invite a second one.
    mockRpcErrors = { import_status: { message: 'network' } };
    const screen = await renderWithProviders(<ImportScreen surface="settings" jobId={JOB} />);

    await waitFor(() => expect(screen.getByText('We couldn’t check your import')).toBeTruthy());
    expect(screen.queryByText('Choose Letterboxd ZIP')).toBeNull();
    // Not a claim that it is still running: a finished job reads the same way offline.
    expect(screen.queryByText(/still running/)).toBeNull();

    mockRpcErrors = {};
    mockRpcResults = {
      import_status: {
        status: 'done',
        counts: { watched: 3 },
        completed_at: '2026-01-01T00:00:00.000Z',
      },
    };
    await fireEvent.press(screen.getByText('Try again'));
    await waitFor(() => expect(screen.getByText('Your Letterboxd history is in')).toBeTruthy());
  });

  it('opens the importer for a link that carries no job id', async () => {
    const screen = await renderWithProviders(
      <ImportScreen surface="settings" jobId="not-a-job" />,
    );

    await waitFor(() => expect(screen.getByText('Bring your Letterboxd history')).toBeTruthy());
    expect(mockRpc).not.toHaveBeenCalledWith('import_status', { p_job_id: 'not-a-job' });
  });

  it('opens the importer when the job is gone', async () => {
    mockRpcResults = { import_status: null };
    const screen = await renderWithProviders(<ImportScreen surface="settings" jobId={GONE} />);

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('import_status', { p_job_id: GONE }),
    );
    expect(screen.getByText('Bring your Letterboxd history')).toBeTruthy();
    expect(screen.getByText('Choose Letterboxd ZIP')).toBeTruthy();
  });
});

describe('restoring an import that ended while they were away', () => {
  it('restores a failed import as a failure, not as a summary', async () => {
    mockLiveJob = {
      data: {
        id: 'job-dead',
        status: 'failed',
        counts: {},
        completed_at: new Date(Date.now() - 60_000).toISOString(),
      },
      error: null,
    };
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await waitFor(() =>
      expect(screen.getByText('We couldn’t finish your Letterboxd import')).toBeTruthy(),
    );
    expect(screen.queryByText(/history is in/)).toBeNull();
  });
});

describe('the way on', () => {
  it('leads with Rank imported titles, which opens Collection on Unranked', async () => {
    mockRpcResults = {
      import_status: {
        status: 'done',
        counts: { applied: 19, watched: 19 },
        completed_at: '2026-01-01T00:00:00.000Z',
      },
      ranking_backlog: {
        status: 'ready',
        total: 19,
        remaining: 19,
        targets: [],
        checkpoint_every: 10,
      },
    };
    const screen = await renderWithProviders(<ImportScreen surface="settings" jobId={JOB} />);

    await waitFor(() => expect(screen.getByText('Rank imported titles')).toBeTruthy());
    expect(screen.getByText('Want to rank what you imported?')).toBeTruthy();
    // No helper line: the question and the button are the whole bridge (founder).
    expect(screen.queryByText(/start unranked/)).toBeNull();
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('Import another file')).toBeTruthy();

    await fireEvent.press(screen.getByText('Rank imported titles'));
    expect(mockDismissTo).toHaveBeenCalledWith({
      pathname: '/(tabs)/collection',
      params: { show: 'unranked' },
    });
  });

  it('lets somebody leave a running import without stopping it', async () => {
    mockRpcResults = { import_status: { status: 'applying', counts: {}, completed_at: null } };
    const screen = await renderWithProviders(<ImportScreen surface="settings" jobId={JOB} />);

    await waitFor(() => expect(screen.getByText('Leave it running')).toBeTruthy());
    expect(screen.getByText(/Your import will keep running/)).toBeTruthy();
    expect(screen.getByText(/may take a few minutes/)).toBeTruthy();

    await fireEvent.press(screen.getByText('Leave it running'));
    expect(mockBack).toHaveBeenCalled();
    // Leaving is only navigation: nothing is discarded or cancelled.
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain('import_discard');
  });

  it('lands on Settings when a notification opened it with nothing underneath', async () => {
    mockCanGoBack = false;
    mockRpcResults = { import_status: { status: 'matching', counts: {}, completed_at: null } };
    const screen = await renderWithProviders(<ImportScreen surface="settings" jobId={JOB} />);

    await waitFor(() => expect(screen.getByText('Leave it running')).toBeTruthy());
    await fireEvent.press(screen.getByText('Leave it running'));
    expect(mockReplace).toHaveBeenCalledWith('/settings');
  });
});

/**
 * The copy rules from physical QA, as absences, over every phase a notification can open:
 * entry, running, finished and failed. Backend words and em dashes are what crept in last
 * time.
 */
describe('the words', () => {
  const arrangements: Record<string, () => void> = {
    entry: () => {},
    running: () => {
      mockRpcResults = {
        import_status: { status: 'matching', counts: {}, completed_at: null },
      };
    },
    finished: () => {
      mockRpcResults = {
        import_status: {
          status: 'done',
          counts: { watched: 3, unmatched: 1 },
          completed_at: '2026-01-01T00:00:00.000Z',
        },
      };
    },
    failed: () => {
      mockRpcResults = {
        import_status: {
          status: 'failed',
          counts: {},
          completed_at: '2026-01-01T00:00:00.000Z',
        },
      };
    },
  };

  const headlines: Record<string, string> = {
    entry: 'Bring your Letterboxd history',
    running: 'Importing your Letterboxd history',
    finished: 'Your Letterboxd history is in',
    failed: 'We couldn’t finish your Letterboxd import',
  };

  it.each(Object.keys(arrangements))(
    'never says matching, processing, rows or payload, and uses no em dash (%s)',
    async (phase) => {
      arrangements[phase]!();
      const screen = await renderWithProviders(
        <ImportScreen surface="settings" jobId={phase === 'entry' ? null : JOB} />,
      );
      // The phase's own headline first, so the absences are read off the right screen.
      await waitFor(() => expect(screen.getByText(headlines[phase]!)).toBeTruthy());

      expect(screen.queryAllByText(/match|process|payload|\brows?\b/i)).toHaveLength(0);
      expect(screen.queryAllByText(/—/)).toHaveLength(0);
    },
  );
});

/**
 * The bridge into the ranking backlog (founder, 2026-09-22). The rule is small enough to
 * test on its own, and the screen test above proves it is wired to the button.
 */
describe('shouldOfferRanking', () => {
  const settled = { settled: true };

  it('offers nothing when the import added nothing', () => {
    expect(shouldOfferRanking(0, { ...settled, status: 'ready', total: 12 })).toBe(false);
  });

  it('offers the bridge while titles are still waiting', () => {
    expect(shouldOfferRanking(19, { ...settled, status: 'ready', total: 19 })).toBe(true);
  });

  it('says nothing once they have been ranked since', () => {
    expect(shouldOfferRanking(19, { ...settled, status: 'empty', total: 0 })).toBe(false);
  });

  it('falls back to the import count when the backlog is off or unreachable', () => {
    expect(shouldOfferRanking(19, { ...settled, status: 'disabled', total: 0 })).toBe(true);
    expect(shouldOfferRanking(19, { settled: true })).toBe(true);
  });

  it('waits for the answer rather than flashing a button', () => {
    expect(shouldOfferRanking(19, { settled: false })).toBe(false);
  });
});
