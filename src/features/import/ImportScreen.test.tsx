import { fireEvent, waitFor } from '@testing-library/react-native';
import { strToU8, zipSync } from 'fflate';

import { renderWithProviders } from '@/test-utils/render';

import { ImportScreen } from './ImportScreen';

/**
 * The importer's screen, exercised through the states a person actually passes.
 *
 * The picker and the network are the two things a test cannot have, so both are mocked at
 * their own boundary and nothing else is: the archive is a **real ZIP**, built here and
 * read by the real `zipSource`, `inspect`, `parseCsv` and `normalise`. So what these assert
 * is the whole reading path arriving at the right words, rather than a screen fed a
 * hand-made preview object that could drift from what the reader produces.
 */

const mockBack = jest.fn();
const mockRpc = jest.fn();
const mockFrom = jest.fn();
let mockRpcResults: Record<string, unknown> = {};
let mockRpcErrors: Record<string, unknown> = {};

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
  useRouter: () => ({ push: () => {}, replace: () => {}, back: mockBack }),
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
  mockRpc.mockClear();
  mockFrom.mockClear();
  mockTrack.mockClear();
  mockRpcResults = {};
  mockRpcErrors = {};
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

    expect(screen.getByText(/Films you.+watched/)).toBeTruthy();
    expect(screen.getByText(/Never opened/)).toBeTruthy();
    // The retention promise, which is Contract V3 §14 and the thing somebody is deciding on.
    expect(screen.getByText(/no copy of it is kept/)).toBeTruthy();
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
  it('previews the counts and sends nothing yet', async () => {
    mockPicked = exportZip(TWO_FILMS);
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose your export'));

    await waitFor(() => expect(screen.getByText(/Here.+s what we found/)).toBeTruthy());
    expect(screen.getByText('Films watched')).toBeTruthy();
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

    await fireEvent.press(screen.getByText('Choose your export'));

    await waitFor(() => expect(screen.getByText(/Here.+s what we found/)).toBeTruthy());
    expect(screen.queryByText(/secret/)).toBeNull();
    expect(screen.queryByText(/Regret/)).toBeNull();
  });

  it('explains a CSV picked instead of the archive, and offers the instructions', async () => {
    mockPicked = strToU8(TWO_FILMS);
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose your export'));

    await waitFor(() => expect(screen.getByText(/not the export file/)).toBeTruthy());
    expect(screen.getByText(/unzipped it for you/)).toBeTruthy();
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_archive_selected',
      props: { outcome: 'not_a_zip' },
    });
  });

  it('explains a zip that is not a Letterboxd export', async () => {
    mockPicked = zipSync({ 'holiday.txt': strToU8('hello') });
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose your export'));

    await waitFor(() => expect(screen.getByText(/isn.+t a Letterboxd export/)).toBeTruthy());
  });

  it('treats an export with no films as empty rather than as an error', async () => {
    mockPicked = exportZip('Date,Name,Year,Letterboxd URI\n');
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose your export'));

    await waitFor(() => expect(screen.getByText(/nothing in there yet/)).toBeTruthy());
  });

  it('goes quietly back to the start when the picker is dismissed', async () => {
    mockPicked = null;
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose your export'));

    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith({
        name: 'import_archive_selected',
        props: { outcome: 'cancelled' },
      }),
    );
    // No apology for a decision somebody made on purpose.
    expect(screen.getByText('Choose your export')).toBeTruthy();
  });
});

describe('uploading', () => {
  it('stages the rows, hands the job over, and then says the app may be closed', async () => {
    mockPicked = exportZip(TWO_FILMS);
    mockRpcResults = { import_create: 'job-1', import_status: null };
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose your export'));
    await waitFor(() => expect(screen.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(screen.getByText('Import 2 films'));

    await waitFor(() => expect(screen.getByText(/close the app/)).toBeTruthy());

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

    await fireEvent.press(screen.getByText('Choose your export'));
    await waitFor(() => expect(screen.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(screen.getByText('Import 2 films'));

    await waitFor(() => expect(screen.getByText(/didn.+t finish sending/)).toBeTruthy());
    // `import_create` reuses the open job and `import_rows_once` makes a re-sent page free,
    // which is what makes this copy true rather than reassuring.
    expect(screen.getByText(/nothing is sent twice/)).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
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

    await fireEvent.press(screen.getByText('Choose your export'));
    await waitFor(() => expect(screen.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(screen.getByText('Import 2 films'));

    await waitFor(() => expect(screen.getByText(/Your history is in/)).toBeTruthy());
    // The unresolved sentence, named precisely rather than by a bare /kept/ — which now
    // also matches the "Diary entries kept" stat and found two elements.
    expect(screen.getByText(/couldn.+t be matched/)).toBeTruthy();
    expect(screen.getByText(/One film/)).toBeTruthy();
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
                applied: 3, watched: 1, kept: 1, already: 1,
                watchlist: 0, viewings: 3,
              },
              completed_at: '2026-09-11T00:00:00.000Z',
            };
      },
    };
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await fireEvent.press(screen.getByText('Choose your export'));
    await waitFor(() => expect(screen.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(screen.getByText('Import 2 films'));

    await waitFor(() => expect(screen.getByText('Added to your collection')).toBeTruthy());
    expect(screen.getByText('Already here, left alone')).toBeTruthy();
    // Named as diary entries, because it is the one number that is not a count of films.
    expect(screen.getByText('Diary entries kept')).toBeTruthy();
    // And the sentence that explains why "added" is smaller than the preview promised.
    expect(screen.getByText(/left .+ exactly as/)).toBeTruthy();
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

    await fireEvent.press(screen.getByText('Choose your export'));
    await waitFor(() => expect(screen.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(screen.getByText('Import 2 films'));

    await waitFor(() => expect(screen.getByText('Import finished')).toBeTruthy());
    expect(screen.queryByText(/Your history is in/)).toBeNull();
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

    await waitFor(() => expect(screen.getByText('Matching your films')).toBeTruthy());
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

    await waitFor(() => expect(screen.getByText(/Your history is in/)).toBeTruthy());
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
    expect(screen.getByText('Choose your export')).toBeTruthy();
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
    expect(screen.getByText('Choose your export')).toBeTruthy();
  });

  it('still offers the importer when the lookup itself fails', async () => {
    // The recovery is a convenience; the importer is the feature. A throw here used to be
    // an unhandled rejection out of an effect that cannot await anything.
    mockLiveJobThrows = true;

    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('import_jobs'));
    expect(screen.getByText('Choose your export')).toBeTruthy();
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
    await fireEvent.press(screen.getByText('Choose your export'));
    await waitFor(() => expect(screen.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(screen.getByText('Import 2 films'));

    await waitFor(() => expect(screen.getByText('An import is already running')).toBeTruthy());
    // The sentence says what happened to *this* file, not what the other one is doing.
    expect(screen.getByText(/This file hasn.+t been sent/)).toBeTruthy();

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
    await fireEvent.press(screen.getByText('Choose your export'));
    await waitFor(() => expect(screen.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(screen.getByText('Import 2 films'));
    await waitFor(() => expect(screen.getByText('An import is already running')).toBeTruthy());

    await fireEvent.press(screen.getByText('See the import that’s running'));

    await waitFor(() => expect(screen.getByText('Matching your films')).toBeTruthy());
  });
});
