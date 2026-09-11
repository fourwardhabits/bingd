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
let mockRpcResults: Record<string, unknown> = {};
let mockRpcErrors: Record<string, unknown> = {};

/** What the picker will answer with. `null` means the person cancelled. */
let mockPicked: Uint8Array | null = null;
let mockPickThrows = false;

jest.mock('expo-file-system', () => ({
  File: {
    pickFileAsync: () => {
      if (mockPickThrows) return Promise.reject(new Error('no'));
      if (mockPicked === null) return Promise.resolve({ canceled: true, result: null });
      return Promise.resolve({
        canceled: false,
        result: { bytes: () => Promise.resolve(mockPicked) },
      });
    },
  },
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      const error = mockRpcErrors[name] ?? null;
      const result = {
        data: error ? null : (mockRpcResults[name] ?? null),
        error,
        // `import_status` is read with `.maybeSingle()`.
        maybeSingle: () =>
          Promise.resolve({ data: error ? null : (mockRpcResults[name] ?? null), error }),
      };
      return Object.assign(Promise.resolve(result), result);
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
  mockTrack.mockClear();
  mockRpcResults = {};
  mockRpcErrors = {};
  mockPicked = null;
  mockPickThrows = false;
});

describe('before a file is chosen', () => {
  it('says what is read and what is never opened', async () => {
    const screen = await renderWithProviders(<ImportScreen surface="settings" />);

    expect(screen.getByText(/Films you.+watched/)).toBeTruthy();
    expect(screen.getByText(/Never opened/)).toBeTruthy();
    // The retention promise, which is Contract V3 §14 and the thing somebody is deciding on.
    expect(screen.getByText(/doesn.+t keep a copy of your export/)).toBeTruthy();
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
    expect(called).toEqual(['import_create', 'import_stage', 'import_ready', 'import_status']);

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
    mockRpcResults = {
      import_create: 'job-1',
      import_status: {
        status: 'done',
        counts: { applied: 1, watched: 1, watchlist: 0, viewings: 0, unmatched: 1 },
        completed_at: '2026-09-11T00:00:00.000Z',
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
