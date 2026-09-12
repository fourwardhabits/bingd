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
    from: (table: string) => {
      mockFrom(table);
      const builder: Record<string, unknown> = {
        select: () => builder,
        is: () => builder,
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
    expect(screen.getByText(/One film/)).toBeTruthy();
    expect(screen.getByText(/kept/)).toBeTruthy();
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_completed',
      props: { applied: 1, unresolved: 1 },
    });
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
        completed_at: '2026-09-11T00:00:00.000Z',
      },
      error: null,
    };

    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    await waitFor(() => expect(screen.getByText(/Your history is in/)).toBeTruthy());
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

  it('says an import is already running, and does not offer to retry it', async () => {
    // `import_create` handed back a job the worker owns. There is nothing wrong and nothing
    // to retry; a "Try again" here would fail identically every time.
    mockPicked = exportZip(TWO_FILMS);
    mockRpcResults = {
      import_create: 'job-1',
      import_status: { status: 'working', counts: {}, completed_at: null },
    };

    const screen = await renderWithProviders(<ImportScreen surface="settings" />);
    await fireEvent.press(screen.getByText('Choose your export'));
    await waitFor(() => expect(screen.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(screen.getByText('Import 2 films'));

    await waitFor(() => expect(screen.getByText('Matching your films')).toBeTruthy());
    // Not staged onto: the whole point is that the running import is left alone.
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain('import_stage');
    // And the import that was never started is not counted as one.
    expect(mockTrack).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'import_started' }),
    );
  });
});

describe('starting over', () => {
  it('tells the server to let go of the half-staged job', async () => {
    // Forgetting the job id locally is not abandoning the job. `import_create` adopts an
    // open job for an hour, so without this the *next* archive stages beside the abandoned
    // one and both are applied as one collection.
    mockPicked = exportZip(TWO_FILMS);
    mockRpcResults = { import_create: 'job-1' };
    mockRpcErrors = { import_stage: { message: 'network' } };

    const screen = await renderWithProviders(<ImportScreen surface="settings" />);
    await fireEvent.press(screen.getByText('Choose your export'));
    await waitFor(() => expect(screen.getByText('Import 2 films')).toBeTruthy());
    await fireEvent.press(screen.getByText('Import 2 films'));
    await waitFor(() => expect(screen.getByText('Start over')).toBeTruthy());

    await fireEvent.press(screen.getByText('Start over'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('import_discard', { p_job_id: 'job-1' }),
    );
    expect(screen.getByText('Choose your export')).toBeTruthy();
  });
});

describe('a file that is not an export', () => {
  it('refuses one too large to be an export without reading it', async () => {
    // The picker deliberately filters nothing — a filter that greys out the correct file is
    // an unrecoverable dead end — so the plausible mis-tap is a video, and the size is the
    // only thing that can be checked before it is all in memory.
    mockPicked = exportZip(TWO_FILMS);
    mockPickedSize = 500 * 1024 * 1024;

    const screen = await renderWithProviders(<ImportScreen surface="settings" />);
    await fireEvent.press(screen.getByText('Choose your export'));

    await waitFor(() => expect(screen.getByText('That file is too big')).toBeTruthy());
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_archive_selected',
      props: { outcome: 'too_large' },
    });
  });
});
