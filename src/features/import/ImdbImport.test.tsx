import { fireEvent, waitFor } from '@testing-library/react-native';
import { strToU8, zipSync } from 'fflate';
import { Linking, StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import {
  IMDB_HEADER,
  IMDB_SYNTHETIC_CSV,
  imdbSyntheticBytes,
} from './__fixtures__/imdb-synthetic';
import { IMDB_HOW_TO_STEPS } from './ExportHelp';
import { ImportScreen } from './ImportScreen';
import { forgetSessionImport } from './session-outcomes';

/**
 * The IMDb import and the choice of service, on screen (founder spec 2026-11-10, §7, §8, §10).
 *
 * The same mocks as `ImportScreen.test.tsx`: the picker hands over bytes, `supabase.rpc`
 * answers from a table, and the open-job lookup answers from `mockLiveJob`. The Letterboxd
 * behaviour is pinned there and in `LetterboxdStep.test.tsx`, unchanged; this file is what
 * the choice and IMDb add.
 */

const JOB = '11111111-2222-4333-8444-555555555555';

const mockRpc = jest.fn();
const mockDismissTo = jest.fn();
let mockRpcResults: Record<string, unknown> = {};
let mockPicked: Uint8Array | null = null;
let mockLiveJob: { data: unknown; error: unknown } = { data: null, error: null };
let mockSelected: string[] = [];

jest.mock('expo-file-system', () => ({
  File: {
    pickFileAsync: () =>
      mockPicked === null
        ? Promise.resolve({ canceled: true, result: null })
        : Promise.resolve({
            canceled: false,
            result: { size: mockPicked.length, bytes: () => Promise.resolve(mockPicked) },
          }),
  },
}));

const mockAnswer = (name: string) => {
  const value = mockRpcResults[name];
  return typeof value === 'function' ? (value as () => unknown)() : (value ?? null);
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      const data = mockAnswer(name);
      const result = {
        data,
        error: null,
        maybeSingle: () => Promise.resolve({ data, error: null }),
      };
      return Object.assign(Promise.resolve(result), result);
    },
    from: () => {
      const builder: Record<string, unknown> = {
        select: (columns: string) => {
          mockSelected.push(columns);
          return builder;
        },
        is: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve(mockLiveJob),
      };
      return builder;
    },
  },
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    back: () => {},
    dismissTo: mockDismissTo,
    canGoBack: () => true,
  }),
  Stack: { Screen: () => null },
}));

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({
  track: (event: unknown) => mockTrack(event),
}));

beforeEach(() => {
  mockRpc.mockClear();
  mockDismissTo.mockClear();
  mockTrack.mockClear();
  mockRpcResults = {};
  mockPicked = null;
  mockLiveJob = { data: null, error: null };
  mockSelected = [];
  // The parse an import leaves in memory for its summary is per process. Each test is a
  // fresh app, so one test's file is never another's (`session-outcomes.ts`).
  forgetSessionImport();
});

const calls = (name: string) =>
  mockRpc.mock.calls.filter(([n]) => n === name).map(([, args]) => args);

const openChooser = async () => {
  const view = await renderWithProviders(<ImportScreen surface="settings" chooser />);
  await waitFor(() => expect(view.getByText('Bring your watch history')).toBeTruthy());
  return view;
};

const openImdb = async () => {
  const view = await openChooser();
  await fireEvent.press(view.getByTestId('choose-imdb'));
  await waitFor(() => expect(view.getByText('Bring over your IMDb history')).toBeTruthy());
  return view;
};

describe('the choice of service', () => {
  it('says the founder’s words and offers exactly Letterboxd and IMDb, with their marks', async () => {
    const view = await openChooser();
    expect(
      view.getByText('Already track movies somewhere else? Bring your history into bingd.'),
    ).toBeTruthy();
    expect(view.getByRole('button', { name: /^Letterboxd\./ })).toBeTruthy();
    expect(view.getByRole('button', { name: /^IMDb\./ })).toBeTruthy();
    expect(view.getByTestId('logo-letterboxd', { includeHiddenElements: true })).toBeTruthy();
    expect(view.getByTestId('logo-imdb', { includeHiddenElements: true })).toBeTruthy();
    expect(view.queryByText(/Rotten Tomatoes/)).toBeNull();
  });

  it('opens Letterboxd’s page exactly as Settings always drew it', async () => {
    const view = await openChooser();
    await fireEvent.press(view.getByTestId('choose-letterboxd'));
    await waitFor(() =>
      expect(view.getByText('Bring over your Letterboxd history')).toBeTruthy(),
    );
    expect(view.getByRole('button', { name: 'Upload Letterboxd file' })).toBeTruthy();
    // Removed by the founder (IMP1113-UI): the service page has one action and its help.
    expect(view.queryByRole('button', { name: 'Choose a different service' })).toBeNull();
  });

  /**
   * **The open is counted on the choice, with the service chosen** (2026-11-11). Before the
   * choice there is no provider to name, and an open counted on mount could only guess
   * Letterboxd. Going back and choosing again is the same visit, counted once.
   */
  it('counts the open once, on the choice, naming the service', async () => {
    const view = await openChooser();
    expect(mockTrack).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'import_opened' }),
    );
    await fireEvent.press(view.getByTestId('choose-imdb'));
    await waitFor(() => expect(view.getByText('Bring over your IMDb history')).toBeTruthy());
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_opened',
      props: { surface: 'settings', provider: 'imdb' },
    });
    expect(
      mockTrack.mock.calls.filter(([event]) => event.name === 'import_opened'),
    ).toHaveLength(1);
  });

  // IMP1113-UI: *Choose a different service* was removed by the founder, so the test that
  // went back to the choice through it is now the assertion that it is gone.
  it('no longer offers a way back to the choice from a service page', async () => {
    const view = await openImdb();
    expect(view.queryByRole('button', { name: 'Choose a different service' })).toBeNull();
    expect(view.queryByText('Bring your watch history')).toBeNull();
  });

  it('shows an import already running instead of the choice', async () => {
    mockLiveJob = {
      data: { id: JOB, status: 'matching', counts: {}, completed_at: null, provider: 'imdb' },
      error: null,
    };
    const view = await renderWithProviders(<ImportScreen surface="settings" chooser />);
    await waitFor(() => expect(view.getByText('Importing your IMDb history')).toBeTruthy());
    expect(view.queryByText('Bring your watch history')).toBeNull();
    // The lookup asks for the job's provider, so its words can be the right ones.
    expect(mockSelected.some((columns) => columns.includes('provider'))).toBe(true);
    // Nobody chose, so the open is counted on the running job, with its provider.
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_opened',
      props: { surface: 'settings', provider: 'imdb' },
    });
  });
});

describe('IMDb’s page', () => {
  /**
   * IMP1113-UI (H2 row 1), polished QA 11-14 §7: the founder's shorter text, a `title1`
   * heading, Export and Upload side by side, and the steps collapsed. The always-visible
   * steps, the privacy block and the separate help button are gone, and asserted gone.
   * Was: the longer body, `display`, and one Upload IMDb CSV button.
   */
  it('says the founder’s words under a title1 heading, with Export and Upload and the steps collapsed', async () => {
    const view = await openImdb();
    expect(
      view.getByText(
        'Movies you’ve rated join your collection unranked. Rank them using bingd’s ranking flow. Anything already ranked keeps its score.',
      ),
    ).toBeTruthy();
    const heading = view.getByText('Bring over your IMDb history');
    expect(StyleSheet.flatten(heading.props.style)).toMatchObject(theme.typography.title1);
    expect(view.getByRole('button', { name: 'IMDb Export' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Upload IMDb file' })).toBeTruthy();
    expect(view.queryByText('On imdb.com, sign in and open Your Ratings.')).toBeNull();
    expect(view.queryByText('How to get your file')).toBeNull();
    expect(view.queryByText(/The dates you rated things are never sent/)).toBeNull();
    expect(view.queryByText(/CSV stays on your phone/)).toBeNull();
    expect(view.getAllByRole('button', { name: 'Need help getting the file?' })).toHaveLength(
      1,
    );
  });

  /**
   * QA 11-14 §7: *IMDb Export* opens Your Ratings, where IMDb's Export control lives, and
   * counts `import_instructions_opened` as the help's link did, so the funnel keeps its
   * meaning. It never opens the picker.
   */
  it('IMDb Export opens Your Ratings, counts the open, and starts nothing', async () => {
    const view = await openImdb();
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await fireEvent.press(view.getByRole('button', { name: 'IMDb Export' }));
    expect(openURL).toHaveBeenCalledWith('https://www.imdb.com/list/ratings');
    openURL.mockRestore();
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_instructions_opened',
      props: { surface: 'settings', provider: 'imdb' },
    });
    expect(view.queryByText('Ready to import')).toBeNull();
    expect(view.getByRole('button', { name: 'Upload IMDb file' })).toBeTruthy();
  });

  /** Was: the help carried *Open your IMDb ratings*, which the Export action now repeats. */
  it('opens IMDb’s own steps inline, without a second export button', async () => {
    const view = await openImdb();
    await fireEvent.press(view.getByRole('button', { name: 'Need help getting the file?' }));
    await waitFor(() =>
      expect(view.getByText('On imdb.com, sign in and open Your Ratings.')).toBeTruthy(),
    );
    for (const step of IMDB_HOW_TO_STEPS) expect(view.getByText(step)).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Open your IMDb ratings' })).toBeNull();
    expect(view.getAllByRole('button', { name: 'IMDb Export' })).toHaveLength(1);
  });
});

describe('the IMDb preview', () => {
  const preview = async (csv = IMDB_SYNTHETIC_CSV) => {
    mockPicked = imdbSyntheticBytes(csv);
    const view = await openImdb();
    await fireEvent.press(view.getByRole('button', { name: 'Upload IMDb file' }));
    await waitFor(() => expect(view.getByText('Ready to import')).toBeTruthy());
    return view;
  };

  /**
   * IMP1113-UI §B: one *Movies* row from the parse, a sentence for shows, episodes and
   * other kinds, no *Ratings*, *Not supported* or *Unmatched* rows, no ranking mechanics,
   * and the J5 fallback line. Was: separate TV and Not supported rows and a ratings
   * paragraph, all removed by the founder.
   */
  it('counts movies from the parse, with a sentence for what will not come in', async () => {
    const view = await preview();
    expect(view.getByText('Here’s what we found.')).toBeTruthy();
    expect(view.getByLabelText('Movies, 7')).toBeTruthy();
    expect(view.queryByText('TV shows, not added')).toBeNull();
    expect(view.queryByText('Not supported')).toBeNull();
    expect(view.queryByText('Ratings')).toBeNull();
    expect(view.queryByText(/Unmatched/)).toBeNull();
    expect(
      view.getByText(
        'We’ll look for your 3 rated TV shows, but TV shows from IMDb aren’t added yet.',
      ),
    ).toBeTruthy();
    expect(
      view.getByText('1 TV episode won’t come in because bingd doesn’t track single episodes.'),
    ).toBeTruthy();
    expect(
      view.getByText('1 title won’t come in because bingd doesn’t track that kind of title.'),
    ).toBeTruthy();
    expect(view.getByText(/3 rows couldn’t be read/)).toBeTruthy();
    expect(view.queryByText(/bingd scores|start unranked/)).toBeNull();
    expect(
      view.getByText('Anything we can’t match will be listed after the import.'),
    ).toBeTruthy();
    expect(view.getByRole('button', { name: 'Import' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Choose a different file' })).toBeTruthy();
  });

  it('sends the job as an IMDb job, with only the fields the server names', async () => {
    let reads = 0;
    mockRpcResults = {
      import_create: JOB,
      import_status: () => {
        reads += 1;
        return reads === 1
          ? { status: 'pending', counts: null, completed_at: null, provider: 'imdb' }
          : { status: 'matching', counts: {}, completed_at: null, provider: 'imdb' };
      },
    };
    const view = await preview();
    await fireEvent.press(view.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(view.getByText('Importing your IMDb history')).toBeTruthy());

    expect(calls('import_create')).toEqual([{ p_provider: 'imdb' }]);
    const [{ p_rows: rows }] = calls('import_stage') as [{ p_rows: Record<string, unknown>[] }];
    for (const row of rows) {
      expect(
        Object.keys(row).every((key) =>
          [
            'kind',
            'correlation',
            'name',
            'originalTitle',
            'year',
            'imdbId',
            'titleType',
            'imdbRating',
          ].includes(key),
        ),
      ).toBe(true);
    }
    // **`films` is the movies, not every staged row** (2026-11-11). This mixed file stages
    // 12 rows, 3 of them TV shows that are matched and not added, so counting the rows
    // overstated the import. The shows are their own count.
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_started',
      props: { films: 7, tv_shows: 3, viewings: 0, provider: 'imdb' },
    });
    expect(rows.length).toBeGreaterThan(7);
  });

  it('names IMDb on the file it read and on the completion', async () => {
    let reads = 0;
    mockRpcResults = {
      import_create: JOB,
      import_status: () => {
        reads += 1;
        return reads === 1
          ? { status: 'pending', counts: null, completed_at: null, provider: 'imdb' }
          : {
              status: 'done',
              counts: { applied: 7, watched: 7, unmatched: 0 },
              completed_at: '2026-11-11T00:00:00.000Z',
              provider: 'imdb',
            };
      },
    };
    const view = await preview();
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_archive_selected',
      props: { outcome: 'ok', provider: 'imdb' },
    });
    await fireEvent.press(view.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(view.getByText('Your IMDb history is in')).toBeTruthy());
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_completed',
      props: { applied: 7, unresolved: 0, provider: 'imdb' },
    });
  });

  it('refuses the Letterboxd ZIP picked on the IMDb page, and says which to choose', async () => {
    mockPicked = zipSync({ 'watched.csv': strToU8('Date,Name,Year\n') });
    const view = await openImdb();
    await fireEvent.press(view.getByRole('button', { name: 'Upload IMDb file' }));
    await waitFor(() => expect(view.getByText('That’s a ZIP, not the IMDb file')).toBeTruthy());
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'import_archive_selected',
      props: { outcome: 'is_zip', provider: 'imdb' },
    });
    expect(view.getByRole('button', { name: 'Upload IMDb file' })).toBeTruthy();
  });

  it('refuses a CSV that is not an IMDb ratings export', async () => {
    mockPicked = strToU8('a,b,c\n1,2,3\n');
    const view = await openImdb();
    await fireEvent.press(view.getByRole('button', { name: 'Upload IMDb file' }));
    await waitFor(() =>
      expect(view.getByText('That isn’t an IMDb ratings export')).toBeTruthy(),
    );
  });

  it('refuses a file of only episodes, without offering an import of nothing', async () => {
    mockPicked = strToU8(
      `${IMDB_HEADER}\ntt9300001,8,2020-01-01,Pilot,,https://x,TV Episode,7,40,2010,Drama,1,,\n`,
    );
    const view = await openImdb();
    await fireEvent.press(view.getByRole('button', { name: 'Upload IMDb file' }));
    await waitFor(() =>
      expect(view.getByText('There are no movies in that file')).toBeTruthy(),
    );
  });
});

/**
 * The summary of a finished IMDb job, opened by name (`?job=`). Was: restored from the open-
 * job lookup inside the 24-hour window, which QA 11-14 §6 removed; a named job is the way a
 * finished summary is reopened now, so the assertions on the summary itself are unchanged.
 */
describe('the IMDb summary', () => {
  const finished = (counts: Record<string, number>) => {
    mockRpcResults = {
      import_status: {
        status: 'done',
        counts,
        completed_at: new Date().toISOString(),
        provider: 'imdb',
      },
    };
  };

  /**
   * IMP1113-UI §D, through `resultModel`. The six-outcome card it replaces had a row each
   * for Couldn't match, TV shows matched, Not supported and Couldn't import; the founder
   * made the recognised kinds notes, *Couldn't match* the expandable *Unmatched*, and
   * `failed` a warning note that is never folded into a row.
   */
  it('reports one card, with the recognised kinds and failures as notes', async () => {
    finished({
      watched: 640,
      kept: 12,
      duplicate: 1,
      already: 3,
      unmatched: 6,
      ambiguous: 2,
      unsupported: 148,
      unsupported_tv: 139,
      unsupported_episode: 7,
      failed: 1,
    });
    const view = await renderWithProviders(
      <ImportScreen surface="settings" chooser jobId={JOB} />,
    );
    await waitFor(() => expect(view.getByText('Your IMDb history is in')).toBeTruthy());
    expect(view.getByLabelText('Already in bingd, 12')).toBeTruthy();
    expect(view.getByLabelText('Imported movies, 643. 3 from an earlier import')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Unmatched, 8 titles' })).toBeTruthy();
    expect(
      view.queryByText(/Imported TV|Not supported|Couldn’t match|Couldn’t import/),
    ).toBeNull();
    expect(
      view.getByText(
        'We found 139 TV shows from your file in bingd, but TV shows from IMDb aren’t added yet.',
      ),
    ).toBeTruthy();
    expect(
      view.getByText(
        '7 TV episodes didn’t come in because bingd doesn’t track single episodes.',
      ),
    ).toBeTruthy();
    expect(
      view.getByText(
        '2 titles didn’t come in because bingd doesn’t track those kinds of titles.',
      ),
    ).toBeTruthy();
    expect(view.getByText(/1 title couldn’t be saved/)).toBeTruthy();
    expect(view.getByRole('button', { name: 'Rank titles' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Done' })).toBeTruthy();
    // Codex review (#289): a summary on screen is a way back to a fresh import.
    expect(view.getByRole('button', { name: 'Import another file' })).toBeTruthy();
  });

  /**
   * **Codex review, #289.** *Done* and *Rank titles* only navigate, so a reader on a finished
   * summary (opened by its notification, or finished in front of them) needs a way to start
   * another import, of another file or from the other service. *Import another file* is the
   * existing `reset`: the job leaves the screen and the choice of service is back. Was:
   * reached through the 24-hour restore, which QA 11-14 §6 removed.
   */
  it('lets a reader on a finished import start a fresh one', async () => {
    finished({ watched: 5 });
    const view = await renderWithProviders(
      <ImportScreen surface="settings" chooser jobId={JOB} />,
    );
    await waitFor(() => expect(view.getByText('Your IMDb history is in')).toBeTruthy());

    await fireEvent.press(view.getByRole('button', { name: 'Import another file' }));

    await waitFor(() => expect(view.getByText('Bring your watch history')).toBeTruthy());
    expect(view.queryByText('Your IMDb history is in')).toBeNull();
    // The existing reset, which on a finished job is answered `running` and deletes nothing.
    expect(calls('import_discard')).toEqual([{ p_job_id: JOB }]);
    // And the other service is one tap away.
    await fireEvent.press(view.getByTestId('choose-letterboxd'));
    await waitFor(() => expect(view.queryByText('Bring your watch history')).toBeNull());
  });

  it('says already here when a re-import changed nothing, and still offers ranking', async () => {
    finished({ watched: 0, already: 640 });
    const view = await renderWithProviders(
      <ImportScreen surface="settings" chooser jobId={JOB} />,
    );
    await waitFor(() =>
      expect(view.getByText('Your IMDb history is already here')).toBeTruthy(),
    );
    expect(
      view.getByLabelText('Imported movies, 640. 640 from an earlier import'),
    ).toBeTruthy();
    expect(view.queryByText('Unmatched')).toBeNull();
    // The 640 are the import's and still unranked, so ranking them is still the way on
    // (IMP1113-UI: *Rank titles* is offered whenever the import owns unranked titles).
    expect(view.getByRole('button', { name: 'Rank titles' })).toBeTruthy();
  });

  it('says nothing new came in when nothing matched and nothing was already here', async () => {
    finished({
      watched: 0,
      unmatched: 4,
      unsupported: 3,
      unsupported_tv: 2,
      unsupported_episode: 1,
    });
    const view = await renderWithProviders(
      <ImportScreen surface="settings" chooser jobId={JOB} />,
    );
    await waitFor(() => expect(view.getByText('Nothing new came in')).toBeTruthy());
    expect(view.queryByText('Your IMDb history is already here')).toBeNull();
    expect(view.queryByText('Your IMDb history is in')).toBeNull();
    expect(view.getByRole('button', { name: 'Unmatched, 4 titles' })).toBeTruthy();
    expect(view.getByText(/We found 2 TV shows from your file in bingd/)).toBeTruthy();
    expect(view.getByText(/1 TV episode didn’t come in/)).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Rank titles' })).toBeNull();
    expect(view.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('says already here when what was in the file was already in the collection', async () => {
    finished({ watched: 0, kept: 5 });
    const view = await renderWithProviders(
      <ImportScreen surface="settings" chooser jobId={JOB} />,
    );
    await waitFor(() =>
      expect(view.getByText('Your IMDb history is already here')).toBeTruthy(),
    );
    expect(view.getByLabelText('Already in bingd, 5')).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Rank titles' })).toBeNull();
  });
});

/**
 * QA 11-14 §6, IMDb side: Settings ▸ Import ▸ IMDb always opens the normal intro. A job that
 * finished a minute ago is history (not deleted, not discarded, not shown); the picker is
 * offered at once, with no cooldown; a reimport of the same file says *already here* in the
 * session it finishes in, and a newer file with additions says *is in*.
 */
describe('Settings ▸ Import ▸ IMDb after an earlier import', () => {
  const earlier = () => {
    mockLiveJob = {
      data: {
        id: JOB,
        status: 'done',
        counts: { watched: 0, already: 7 },
        completed_at: new Date(Date.now() - 60_000).toISOString(),
        provider: 'imdb',
      },
      error: null,
    };
  };
  const finishes = (counts: Record<string, number>) => {
    let reads = 0;
    mockRpcResults = {
      import_create: JOB,
      import_status: () => {
        reads += 1;
        return reads === 1
          ? { status: 'pending', counts: null, completed_at: null, provider: 'imdb' }
          : { status: 'done', counts, completed_at: new Date().toISOString(), provider: 'imdb' };
      },
    };
  };
  const importAgain = async () => {
    mockPicked = imdbSyntheticBytes(IMDB_SYNTHETIC_CSV);
    const view = await openImdb();
    await fireEvent.press(view.getByRole('button', { name: 'Upload IMDb file' }));
    await waitFor(() => expect(view.getByText('Ready to import')).toBeTruthy());
    await fireEvent.press(view.getByRole('button', { name: 'Import' }));
    return view;
  };

  it('opens on the choice and then the IMDb intro, not on the last summary', async () => {
    earlier();
    const view = await openImdb();
    expect(view.getByRole('button', { name: 'IMDb Export' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Upload IMDb file' })).toBeTruthy();
    expect(view.queryByText('Your IMDb history is already here')).toBeNull();
    expect(view.queryByText('Your IMDb history is in')).toBeNull();
    // The earlier job is history: nothing discards or re-reads it.
    expect(calls('import_discard')).toEqual([]);
    expect(calls('import_status')).toEqual([]);
  });

  it('says already here when the same file is imported again', async () => {
    earlier();
    finishes({ watched: 0, already: 7 });
    const view = await importAgain();
    await waitFor(() =>
      expect(view.getByText('Your IMDb history is already here')).toBeTruthy(),
    );
    expect(calls('import_create')).toEqual([{ p_provider: 'imdb' }]);
  });

  it('says the history is in, with the imported count, when a newer file adds movies', async () => {
    earlier();
    finishes({ watched: 3, already: 7 });
    const view = await importAgain();
    await waitFor(() => expect(view.getByText('Your IMDb history is in')).toBeTruthy());
    expect(view.queryByText('Your IMDb history is already here')).toBeNull();
    expect(view.getByLabelText('Imported movies, 10. 7 from an earlier import')).toBeTruthy();
  });

  /** Score preservation, as words only: nothing here writes a ranking. */
  it('says existing scores are kept, before and after', async () => {
    earlier();
    finishes({ watched: 3, kept: 4 });
    const view = await importAgain();
    await waitFor(() => expect(view.getByText('Your IMDb history is in')).toBeTruthy());
    expect(view.getByLabelText('Already in bingd, 4')).toBeTruthy();
    const intro = await openImdb();
    expect(intro.getByText(/Anything already ranked keeps its score\./)).toBeTruthy();
  });
});

describe('a failed IMDb import, reopened from its notification', () => {
  it('names IMDb and offers the IMDb file, not the Letterboxd one', async () => {
    mockRpcResults = {
      import_status: {
        status: 'failed',
        counts: {},
        completed_at: new Date().toISOString(),
        provider: 'imdb',
      },
    };
    const view = await renderWithProviders(
      <ImportScreen surface="settings" chooser jobId={JOB} />,
    );
    await waitFor(() =>
      expect(view.getByText('We couldn’t finish your IMDb import')).toBeTruthy(),
    );
    expect(view.getByRole('button', { name: 'Upload IMDb file' })).toBeTruthy();
    expect(view.queryByText(/Letterboxd/)).toBeNull();
    // Choosing the file again opens the IMDb reader: a ZIP is refused as a ZIP.
    mockPicked = zipSync({ 'watched.csv': strToU8('Date,Name,Year\n') });
    await fireEvent.press(view.getByRole('button', { name: 'Upload IMDb file' }));
    await waitFor(() => expect(view.getByText('That’s a ZIP, not the IMDb file')).toBeTruthy());
  });
});

describe('the onboarding question', () => {
  it('offers Letterboxd, IMDb and Not now, and Not now leaves without an import', async () => {
    const onLeave = jest.fn();
    const view = await renderWithProviders(
      <ImportScreen surface="onboarding" chooser onboarding={{ header: null, onLeave }} />,
    );
    await waitFor(() =>
      expect(view.getByText('Already tracking movies somewhere else?')).toBeTruthy(),
    );
    expect(view.getByTestId('choose-letterboxd')).toBeTruthy();
    expect(view.getByTestId('choose-imdb')).toBeTruthy();
    await waitFor(() => expect(mockSelected.length).toBeGreaterThan(0));
    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));
    expect(onLeave).toHaveBeenCalledWith('skipped');
    expect(calls('import_create')).toEqual([]);
  });

  it('keeps Not now on IMDb’s page', async () => {
    const onLeave = jest.fn();
    const view = await renderWithProviders(
      <ImportScreen surface="onboarding" chooser onboarding={{ header: null, onLeave }} />,
    );
    await waitFor(() => expect(view.getByTestId('choose-imdb')).toBeTruthy());
    await fireEvent.press(view.getByTestId('choose-imdb'));
    await waitFor(() => expect(view.getByText('Bring over your IMDb history')).toBeTruthy());
    await fireEvent.press(view.getByRole('button', { name: 'Not now' }));
    expect(onLeave).toHaveBeenCalled();
  });
});
