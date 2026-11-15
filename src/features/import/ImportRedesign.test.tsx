import { fireEvent, waitFor, within } from '@testing-library/react-native';
import { strToU8, zipSync } from 'fflate';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import {
  IMDB_QA_MIRROR_CSV,
  QA_MIRROR_BUCKETS,
  QA_MIRROR_FIRST,
  QA_MIRROR_REIMPORT,
  QA_MIRROR_UNRESOLVED,
} from './__fixtures__/imdb-qa-mirror';
import { imdbSyntheticBytes } from './__fixtures__/imdb-synthetic';
import { normaliseImdb } from './imdb';
import { ImportScreen } from './ImportScreen';
import { episodeNote, FALLBACK_LINE, otherNote, tvNote } from './PreviewSummary';
import { bucketTotal, resultModel, type ResultModel } from './result-model';
import { forgetSessionImport } from './session-outcomes';

/**
 * The import UX redesign end to end (IMP1113-UI): the H1 synthetic mirror of the founder's
 * QA file through Ready, a first import and a re-import, and the H2 rows that are about the
 * screen rather than one component. The mocks are `ImdbOutcomes.test.tsx`'s: a picker that
 * hands over bytes, `supabase.rpc` answering from a table, and a readable `import_rows`.
 */

const JOB = '11111111-2222-4333-8444-555555555555';

let mockRpcResults: Record<string, unknown> = {};
const mockRpcNames: string[] = [];
let mockPicked: Uint8Array | null = null;
let mockLiveJob: { data: unknown; error: unknown } = { data: null, error: null };
let mockUnresolved: { data: unknown; error: unknown } = { data: [], error: null };
const mockDismissTo = jest.fn();

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

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string) => {
      mockRpcNames.push(name);
      const value = mockRpcResults[name];
      const data = typeof value === 'function' ? (value as () => unknown)() : (value ?? null);
      const result = {
        data,
        error: null,
        maybeSingle: () => Promise.resolve({ data, error: null }),
      };
      return Object.assign(Promise.resolve(result), result);
    },
    from: () => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve(mockLiveJob),
        range: (from: number, to: number) => {
          const { data, error } = mockUnresolved;
          return Promise.resolve({
            data: Array.isArray(data) ? data.slice(from, to + 1) : data,
            error,
          });
        },
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

jest.mock('@/lib/analytics', () => ({ track: () => {} }));

beforeEach(() => {
  mockRpcResults = {};
  mockRpcNames.length = 0;
  mockPicked = null;
  mockLiveJob = { data: null, error: null };
  mockUnresolved = { data: [], error: null };
  mockDismissTo.mockClear();
  forgetSessionImport();
});

const unresolved = (rows: readonly { name: string; year?: number | null }[]) => {
  mockUnresolved = { data: rows.map((raw, i) => ({ id: `r${i}`, raw })), error: null };
};

const openImdb = async () => {
  const view = await renderWithProviders(<ImportScreen surface="settings" chooser />);
  await waitFor(() => expect(view.getByTestId('choose-imdb')).toBeTruthy());
  await fireEvent.press(view.getByTestId('choose-imdb'));
  await waitFor(() => expect(view.getByText('Bring over your IMDb history')).toBeTruthy());
  return view;
};

type View = Awaited<ReturnType<typeof openImdb>>;

const toReady = async (csv: string) => {
  mockPicked = imdbSyntheticBytes(csv);
  const view = await openImdb();
  await fireEvent.press(view.getByRole('button', { name: 'Upload IMDb file' }));
  await waitFor(() => expect(view.getByText('Ready to import')).toBeTruthy());
  return view;
};

/** Pick, import, and land on the results with `counts`. */
const runImport = async (csv: string, counts: Record<string, number>) => {
  let reads = 0;
  mockRpcResults = {
    import_create: JOB,
    import_status: () => {
      reads += 1;
      return reads === 1
        ? { status: 'pending', counts: null, completed_at: null, provider: 'imdb' }
        : {
            status: 'done',
            counts,
            completed_at: '2026-11-14T00:00:00.000Z',
            provider: 'imdb',
          };
    },
  };
  const view = await toReady(csv);
  await fireEvent.press(view.getByRole('button', { name: 'Import' }));
  await waitFor(() => expect(view.getByTestId('import-result')).toBeTruthy());
  return view;
};

/**
 * A finished job reopened by name (`?job=`). Was: restored from the open-job lookup inside
 * the 24-hour window, which QA 11-14 §6 removed.
 */
const restored = async (counts: Record<string, number>, provider = 'imdb') => {
  mockRpcResults = {
    ...mockRpcResults,
    import_status: { status: 'done', counts, completed_at: new Date().toISOString(), provider },
  };
  const view = await renderWithProviders(
    <ImportScreen surface="settings" chooser jobId={JOB} />,
  );
  await waitFor(() => expect(view.getByTestId('import-result')).toBeTruthy());
  return view;
};

/** Every number the results screen draws, by where it came from. */
const drawnNumbers = (view: View) => {
  const label = (id: string) =>
    view.queryByTestId(id)?.props.accessibilityLabel as string | undefined;
  const value = (id: string) => {
    const l = label(id);
    return l ? Number(/, (\d+)/.exec(l)![1]) : 0;
  };
  const unmatched = view.queryByRole('button', { name: /^Unmatched, / });
  const notes = view
    .queryAllByText(/^(We found \d+ TV|\d+ TV episodes? didn’t|\d+ titles? didn’t)/)
    .map((t) => Number(/(\d+)/.exec(String(t.props.children))![1]));
  return {
    present: value('result-present'),
    imported: value('result-imported'),
    unmatched: unmatched
      ? Number(/^Unmatched, (\d+)/.exec(unmatched.props.accessibilityLabel)![1])
      : 0,
    notes: notes.reduce((a, b) => a + b, 0),
  };
};

describe('H1: the synthetic mirror of the founder’s QA file', () => {
  const parsed = normaliseImdb(IMDB_QA_MIRROR_CSV);

  it('is seven distinct titles in the real header: five movie-kind, one show, one episode', () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.normalised.titles).toHaveLength(7);
    expect(parsed.normalised.counts).toMatchObject({
      titles: 7,
      movies: 5,
      tvShows: 1,
      episodes: 1,
      otherUnsupported: 0,
      malformed: 0,
      invalidIds: 0,
    });
    for (const title of parsed.normalised.titles) expect(title.imdbId).toMatch(/^tt91\d{5}$/);
  });

  it.each([
    ['first import', QA_MIRROR_FIRST, 'first'],
    ['re-import', QA_MIRROR_REIMPORT, 'reimport'],
  ] as const)(
    'puts every one of the seven rows in exactly one bucket (%s)',
    (_, counts, run) => {
      if (!parsed.ok) throw new Error('unparsed');
      const model = resultModel(counts, 'imdb');
      // Each parsed row is named once, and each is in exactly one bucket.
      expect(QA_MIRROR_BUCKETS.map((r) => r.imdbId).sort()).toEqual(
        parsed.normalised.titles.map((t) => t.imdbId).sort(),
      );
      const tally: Partial<Record<keyof ResultModel, number>> = {};
      for (const row of QA_MIRROR_BUCKETS) tally[row[run]] = (tally[row[run]] ?? 0) + 1;
      for (const [bucket, n] of Object.entries(tally)) {
        expect(model[bucket as keyof ResultModel]).toBe(n);
      }
      // And no bucket counts anything the rows do not account for.
      expect(bucketTotal(model)).toBe(7);
    },
  );

  it('shows Ready with Movies 5, one TV note, one episode note, and no Unmatched', async () => {
    const view = await toReady(IMDB_QA_MIRROR_CSV);
    expect(view.getByLabelText('Movies, 5')).toBeTruthy();
    expect(view.getByText(tvNote(1))).toBeTruthy();
    expect(
      view.getByText(
        'We’ll look for your 1 rated TV show, but TV shows from IMDb aren’t added yet.',
      ),
    ).toBeTruthy();
    expect(
      view.getByText('1 TV episode won’t come in because bingd doesn’t track single episodes.'),
    ).toBeTruthy();
    expect(view.queryByText(/Unmatched/)).toBeNull();
    expect(
      view.queryByText(/won’t come in because bingd doesn’t track (that|those) kind/),
    ).toBeNull();
    expect(view.getByText(FALLBACK_LINE)).toBeTruthy();
  });

  it('first import: in, with the card and notes adding up to the seven rows', async () => {
    unresolved(QA_MIRROR_UNRESOLVED);
    const view = await runImport(IMDB_QA_MIRROR_CSV, QA_MIRROR_FIRST);
    expect(view.getByText('Your IMDb history is in')).toBeTruthy();
    expect(view.getByLabelText('Already in bingd, 1')).toBeTruthy();
    expect(view.getByLabelText('Imported movies, 3')).toBeTruthy();
    expect(view.queryByText(/from an earlier import/)).toBeNull();
    expect(view.getByRole('button', { name: 'Unmatched, 1 title' })).toBeTruthy();
    expect(
      view.getByText(
        'We found 1 TV show from your file in bingd, but TV shows from IMDb aren’t added yet.',
      ),
    ).toBeTruthy();
    expect(
      view.getByText(
        '1 TV episode didn’t come in because bingd doesn’t track single episodes.',
      ),
    ).toBeTruthy();
    expect(view.queryByText(/Imported TV/)).toBeNull();
    const n = drawnNumbers(view);
    expect(n.present + n.imported + n.unmatched + n.notes).toBe(7);
    // The unmatched row is the short, with its id and type from this session's parse.
    await fireEvent.press(view.getByRole('button', { name: 'Unmatched, 1 title' }));
    await waitFor(() => expect(view.getByText('A Small Hour (2020)')).toBeTruthy());
    expect(view.getByText('Short · tt9100007')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Rank titles' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('re-import: already here, the three as an earlier import’s, still adding up to seven', async () => {
    unresolved(QA_MIRROR_UNRESOLVED);
    const view = await runImport(IMDB_QA_MIRROR_CSV, QA_MIRROR_REIMPORT);
    expect(view.getByText('Your IMDb history is already here')).toBeTruthy();
    expect(view.queryByText('Your IMDb history is in')).toBeNull();
    expect(view.getByLabelText('Already in bingd, 1')).toBeTruthy();
    expect(view.getByLabelText('Imported movies, 3. 3 from an earlier import')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Unmatched, 1 title' })).toBeTruthy();
    const n = drawnNumbers(view);
    expect(n.present + n.imported + n.unmatched + n.notes).toBe(7);
  });

  // H2 rows 15 and 16: the import UI writes no ranking, and Rank titles only navigates.
  it('writes no ranking: only import calls, and Rank titles opens Unranked without the importer', async () => {
    unresolved(QA_MIRROR_UNRESOLVED);
    const view = await runImport(IMDB_QA_MIRROR_CSV, QA_MIRROR_FIRST);
    expect(mockRpcNames.length).toBeGreaterThan(0);
    for (const name of mockRpcNames) expect(name).toMatch(/^import_/);
    const before = mockRpcNames.length;
    await fireEvent.press(view.getByRole('button', { name: 'Rank titles' }));
    expect(mockDismissTo).toHaveBeenCalledWith({
      pathname: '/(tabs)/collection',
      params: { show: 'unranked' },
    });
    expect(mockRpcNames.length).toBe(before);
  });
});

describe('H2: the intro', () => {
  // Row 3: a cancelled picker changes nothing and sends nothing.
  it('stays exactly where it was when the picker is cancelled', async () => {
    mockPicked = null;
    const view = await openImdb();
    await fireEvent.press(view.getByRole('button', { name: 'Upload IMDb file' }));
    await waitFor(() => expect(view.getByText('Bring over your IMDb history')).toBeTruthy());
    expect(view.queryByText('Ready to import')).toBeNull();
    expect(view.queryByText(/couldn’t/)).toBeNull();
    expect(mockRpcNames).toEqual([]);
  });

  // Row 24: no line on the redesigned pages is capped or shrunk, so large text wraps.
  it('never caps or shrinks a line of the intro, Ready or the results', async () => {
    // The intro's Export / Upload pair is an `ActionPair` since QA 11-14 §7, so its two
    // labels follow the pair's rule, as the results' pair below does: one line in a row,
    // uncapped when stacked (`ActionPair.test.tsx`).
    const PAIR = new Set(['IMDb Export', 'Upload IMDb file', 'Done', 'Rank titles']);
    const uncapped = (view: View) => {
      const texts = view.queryAllByText(/./);
      expect(texts.length).toBeGreaterThan(0);
      for (const text of texts) {
        if (PAIR.has(text.props.children as string)) continue;
        expect(text.props.numberOfLines).toBeUndefined();
        expect(text.props.adjustsFontSizeToFit).toBeFalsy();
      }
    };
    const intro = await openImdb();
    uncapped(intro);
    await intro.unmount();
    const ready = await toReady(IMDB_QA_MIRROR_CSV);
    uncapped(ready);
    await ready.unmount();
    // The results, but for the ActionPair's two `fit` labels, which are one line by design
    // in a row and stack (uncapped) when they would not fit (`ActionPair.test.tsx`).
    unresolved(QA_MIRROR_UNRESOLVED);
    const results = await restored({ ...QA_MIRROR_FIRST });
    for (const text of results.queryAllByText(/./)) {
      if (text.props.children === 'Done' || text.props.children === 'Rank titles') continue;
      expect(text.props.numberOfLines).toBeUndefined();
    }
  });

  // Row 25: headings are headers, and the reading order is the drawing order.
  it('labels the page heading and orders Import before Choose a different file', async () => {
    const view = await toReady(IMDB_QA_MIRROR_CSV);
    expect(view.getByRole('header', { name: 'Ready to import' })).toBeTruthy();
    const names = view.getAllByRole('button').map((b) => b.props.testID);
    expect(names.indexOf('import-start')).toBeLessThan(names.indexOf('import-choose-again'));
    // Choose a different file: quiet, centred, and a 44pt target.
    const quiet = view.getByTestId('import-choose-again');
    const visible = theme.layout.control.compactAction.visibleHeight;
    expect(
      visible + quiet.props.hitSlop.top + quiet.props.hitSlop.bottom,
    ).toBeGreaterThanOrEqual(theme.layout.minTapTarget);
    expect(StyleSheet.flatten(quiet.parent!.props.style)).toMatchObject({
      alignItems: 'center',
    });
  });
});

describe('H2: Ready notes', () => {
  it('says episodes in the singular and plural, and nothing for none', async () => {
    expect(episodeNote(1)).toBe(
      '1 TV episode won’t come in because bingd doesn’t track single episodes.',
    );
    expect(episodeNote(2)).toBe(
      '2 TV episodes won’t come in because bingd doesn’t track single episodes.',
    );
    expect(tvNote(2)).toBe(
      'We’ll look for your 2 rated TV shows, but TV shows from IMDb aren’t added yet.',
    );
    expect(otherNote(2)).toMatch(/^2 titles won’t come in/);
    // None: a file of movies only has no episode or TV sentence at all.
    const moviesOnly = IMDB_QA_MIRROR_CSV.split('\n')
      .filter((line) => !/TV Series|TV Episode/.test(line))
      .join('\n');
    const view = await toReady(moviesOnly);
    expect(view.queryByText(/TV episode/)).toBeNull();
    expect(view.queryByText(/TV show/)).toBeNull();
    expect(view.getByLabelText('Movies, 5')).toBeTruthy();
  });
});

describe('H2: results', () => {
  // Row 11.
  it('all previously imported: already here, and ranking still offered', async () => {
    const view = await restored({ watched: 0, already: 5 });
    expect(view.getByText('Your IMDb history is already here')).toBeTruthy();
    expect(view.getByLabelText('Imported movies, 5. 5 from an earlier import')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Rank titles' })).toBeTruthy();
  });

  // Row 12.
  it('all unmatched: nothing new, the count, and only Done', async () => {
    unresolved([
      { name: 'A', year: 2001 },
      { name: 'B', year: 2002 },
    ]);
    const view = await restored({ watched: 0, kept: 0, already: 0, unmatched: 2 });
    expect(view.getByText('Nothing new came in')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Unmatched, 2 titles' })).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Rank titles' })).toBeNull();
    expect(view.getAllByRole('button', { name: 'Done' })).toHaveLength(1);
  });

  // Row 13.
  it('unsupported only: nothing new, notes and no card, only Done', async () => {
    const view = await restored({
      watched: 0,
      unsupported: 4,
      unsupported_tv: 2,
      unsupported_episode: 1,
    });
    expect(view.getByText('Nothing new came in')).toBeTruthy();
    expect(view.getByText(/We found 2 TV shows/)).toBeTruthy();
    expect(view.getByText(/1 TV episode didn’t come in/)).toBeTruthy();
    expect(view.getByText(/1 title didn’t come in/)).toBeTruthy();
    expect(view.queryByTestId('result-imported')).toBeNull();
    expect(view.queryByText('Unmatched')).toBeNull();
    expect(view.queryByRole('button', { name: 'Rank titles' })).toBeNull();
  });

  it('a failed write is a warning of its own, never folded into a row', async () => {
    const view = await restored({ watched: 2, failed: 1 });
    expect(view.getByLabelText('Imported movies, 2')).toBeTruthy();
    expect(view.getByText(/1 title couldn’t be saved/)).toBeTruthy();
  });

  // Row 20.
  it('Letterboxd: Watchlist and Diary rows on the results', async () => {
    const view = await restored(
      { watched: 2, kept: 1, watchlist: 3, viewings: 4 },
      'letterboxd',
    );
    expect(view.getByText('Your Letterboxd history is in')).toBeTruthy();
    expect(view.getByLabelText('Imported movies, 2')).toBeTruthy();
    expect(view.getByLabelText('Already in bingd, 1')).toBeTruthy();
    expect(view.getByLabelText('Added to watchlist, 3')).toBeTruthy();
    expect(view.getByLabelText('Diary entries, 4')).toBeTruthy();
    expect(view.queryByText(/TV/)).toBeNull();
  });
});

describe('H2: Letterboxd Ready', () => {
  // Row 20.
  it('counts Movies, Watchlist and Diary entries, and no Ratings', async () => {
    mockPicked = zipSync(
      Object.fromEntries(
        Object.entries({
          'lb/watched.csv':
            'Date,Name,Year,Letterboxd URI\n2024-01-02,Shrek,2001,https://boxd.it/2a\n2024-01-03,Dune,2021,https://boxd.it/2b\n',
          'lb/ratings.csv':
            'Date,Name,Year,Letterboxd URI,Rating\n2024-01-02,Shrek,2001,https://boxd.it/2a,4\n',
          'lb/watchlist.csv':
            'Date,Name,Year,Letterboxd URI\n2024-01-04,Arrival,2016,https://boxd.it/3a\n',
          'lb/diary.csv':
            'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n' +
            '2024-01-02,Shrek,2001,https://boxd.it/aa,4,,,2024-01-02\n' +
            '2024-01-03,Shrek,2001,https://boxd.it/bb,4,Yes,,2024-02-02\n',
        }).map(([k, v]) => [k, strToU8(v)]),
      ),
    );
    const view = await renderWithProviders(<ImportScreen surface="settings" />);
    await fireEvent.press(view.getByRole('button', { name: 'Upload Letterboxd file' }));
    await waitFor(() => expect(view.getByText('Ready to import')).toBeTruthy());
    const card = within(view.getByTestId('import-preview'));
    expect(card.getByLabelText('Movies, 2')).toBeTruthy();
    expect(card.getByLabelText('Watchlist, 1')).toBeTruthy();
    expect(card.getByLabelText('Diary entries, 2')).toBeTruthy();
    expect(card.queryByText('Ratings')).toBeNull();
    expect(card.getByText(FALLBACK_LINE)).toBeTruthy();
  });
});

/**
 * Polish (IMP1113-UI): a file that belongs to the other service offers that service in
 * place, where the screen has the choice of service, and no failure says "go back".
 */
describe('a file for the other service', () => {
  const lbZip = () => zipSync({ 'lb/watched.csv': strToU8('Date,Name,Year\n') });

  it('on IMDb’s page, a ZIP offers Letterboxd, and switching opens its page with nothing sent', async () => {
    mockPicked = lbZip();
    const view = await openImdb();
    await fireEvent.press(view.getByRole('button', { name: 'Upload IMDb file' }));
    await waitFor(() => expect(view.getByText('That’s a ZIP, not the IMDb file')).toBeTruthy());
    expect(
      view.getByText(
        'IMDb exports one CSV file. If this is your Letterboxd export, you can import it from Letterboxd instead.',
      ),
    ).toBeTruthy();
    expect(view.queryByText(/go back/)).toBeNull();
    const button = view.getByTestId('import-switch-provider');
    expect(view.getByRole('button', { name: 'Import from Letterboxd instead' })).toBe(button);
    // Quiet, centred, and a 44pt target.
    expect(
      theme.layout.control.compactAction.visibleHeight +
        button.props.hitSlop.top +
        button.props.hitSlop.bottom,
    ).toBeGreaterThanOrEqual(theme.layout.minTapTarget);
    expect(StyleSheet.flatten(button.parent!.props.style)).toMatchObject({
      alignItems: 'center',
    });

    await fireEvent.press(button);
    await waitFor(() =>
      expect(view.getByText('Bring over your Letterboxd history')).toBeTruthy(),
    );
    expect(view.getByRole('button', { name: 'Upload Letterboxd file' })).toBeTruthy();
    expect(view.queryByText('That’s a ZIP, not the IMDb file')).toBeNull();
    expect(mockRpcNames).toEqual([]);
  });

  it('on Letterboxd’s page, a CSV offers IMDb, and switching opens IMDb’s page', async () => {
    mockPicked = strToU8(IMDB_QA_MIRROR_CSV);
    const view = await renderWithProviders(<ImportScreen surface="settings" chooser />);
    await waitFor(() => expect(view.getByTestId('choose-letterboxd')).toBeTruthy());
    await fireEvent.press(view.getByTestId('choose-letterboxd'));
    await fireEvent.press(
      await waitFor(() => view.getByRole('button', { name: 'Upload Letterboxd file' })),
    );
    await waitFor(() => expect(view.getByText('That’s not the Letterboxd ZIP')).toBeTruthy());
    expect(
      view.getByText(
        'Letterboxd sends a ZIP file. If your computer unzipped it, use the original download. A single CSV isn’t enough. If this is your IMDb ratings export, you can import it from IMDb instead.',
      ),
    ).toBeTruthy();
    expect(view.queryByText(/go back/)).toBeNull();
    await fireEvent.press(view.getByRole('button', { name: 'Import from IMDb instead' }));
    await waitFor(() => expect(view.getByText('Bring over your IMDb history')).toBeTruthy());
    expect(view.getByRole('button', { name: 'Upload IMDb file' })).toBeTruthy();
  });

  it('without the choice of service, offers no switch and still says no "go back"', async () => {
    mockPicked = strToU8(IMDB_QA_MIRROR_CSV);
    const lb = await renderWithProviders(<ImportScreen surface="settings" />);
    await fireEvent.press(lb.getByRole('button', { name: 'Upload Letterboxd file' }));
    await waitFor(() => expect(lb.getByText('That’s not the Letterboxd ZIP')).toBeTruthy());
    expect(
      lb.getByText(
        'Letterboxd sends a ZIP file. If your computer unzipped it, use the original download. A single CSV isn’t enough.',
      ),
    ).toBeTruthy();
    expect(lb.queryByTestId('import-switch-provider')).toBeNull();
    await lb.unmount();

    mockPicked = lbZip();
    const imdb = await renderWithProviders(<ImportScreen surface="settings" provider="imdb" />);
    await fireEvent.press(imdb.getByRole('button', { name: 'Upload IMDb file' }));
    await waitFor(() => expect(imdb.getByText('That’s a ZIP, not the IMDb file')).toBeTruthy());
    expect(
      imdb.getByText(
        'IMDb exports one CSV file. If this is your Letterboxd export, choose Letterboxd instead.',
      ),
    ).toBeTruthy();
    expect(imdb.queryByText(/go back/)).toBeNull();
    expect(imdb.queryByTestId('import-switch-provider')).toBeNull();
  });
});

describe('a warning note', () => {
  it('reads in secondary ink and is announced as a warning; an information note is not', async () => {
    // Two rows the reader cannot use: an unquoted comma and a name id.
    const csv = `${IMDB_QA_MIRROR_CSV}tt9100008,8,2024-02-08,Broken, Row,Broken Row,https://www.imdb.com/title/tt9100008/,Movie,7,90,2001,Drama,1,,\nnm9100009,8,2024-02-09,Somebody,Somebody,https://www.imdb.com/name/nm9100009/,Movie,7,90,2001,Drama,1,,\n`;
    const view = await toReady(csv);
    const warning = view.getByLabelText(
      'Warning, 2 rows couldn’t be read, so we skipped them.',
    );
    expect(warning.props.accessible).toBe(true);
    const text = view.getByText('2 rows couldn’t be read, so we skipped them.');
    expect(StyleSheet.flatten(text.props.style).color).toBe(theme.text.secondary);
    // The information notes stay tertiary and carry no warning label.
    const info = view.getByText(tvNote(1));
    expect(StyleSheet.flatten(info.props.style).color).toBe(theme.text.tertiary);
    expect(view.queryByLabelText(/^Warning, We’ll look/)).toBeNull();
  });
});
