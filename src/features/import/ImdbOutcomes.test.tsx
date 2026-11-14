import { fireEvent, waitFor, within } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { imdbSyntheticBytes } from './__fixtures__/imdb-synthetic';
import { ImportScreen } from './ImportScreen';
import { UNMATCHED_PAGE } from './UnmatchedDisclosure';
import { forgetSessionImport, sessionImportFor } from './session-outcomes';
import { MAX_PAGES, readUnresolvedRows, UNRESOLVED_PAGE } from './use-imdb-outcomes';

/**
 * The results' *Unmatched* row by title (`outcomes.ts`, `UnmatchedDisclosure.tsx`), on
 * screen. IMP1113-UI rewrote this file with the screen: the per-heading lists of shows,
 * episodes and other kinds became notes (founder), so what is listed by title now is the
 * Unmatched row alone, behind a disclosure, paged by fifty.
 *
 * The same mocks as `ImdbImport.test.tsx`, plus a readable `import_rows`: `mockUnresolved`
 * is what the owner's RLS-scoped select returns for the job, in `{ id, raw }` rows as
 * `_import_settle` leaves them (name and year only).
 */

const JOB = '11111111-2222-4333-8444-555555555555';

let mockRpcResults: Record<string, unknown> = {};
let mockPicked: Uint8Array | null = null;
let mockLiveJob: { data: unknown; error: unknown } = { data: null, error: null };
let mockUnresolved: { data: unknown; error: unknown } = { data: [], error: null };
let mockRowReads: { table: string; columns: string; eq: unknown[]; range: number[] }[] = [];

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
      const value = mockRpcResults[name];
      const data = typeof value === 'function' ? (value as () => unknown)() : (value ?? null);
      const result = {
        data,
        error: null,
        maybeSingle: () => Promise.resolve({ data, error: null }),
      };
      return Object.assign(Promise.resolve(result), result);
    },
    from: (table: string) => {
      const read = { table, columns: '', eq: [] as unknown[], range: [] as number[] };
      const builder: Record<string, unknown> = {
        select: (columns: string) => {
          read.columns = columns;
          return builder;
        },
        eq: (...args: unknown[]) => {
          read.eq = args;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve(mockLiveJob),
        range: (from: number, to: number) => {
          read.range = [from, to];
          mockRowReads.push(read);
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
    dismissTo: () => {},
    canGoBack: () => true,
  }),
  Stack: { Screen: () => null },
}));

jest.mock('@/lib/analytics', () => ({ track: () => {} }));

beforeEach(() => {
  mockRpcResults = {};
  mockPicked = null;
  mockLiveJob = { data: null, error: null };
  mockUnresolved = { data: [], error: null };
  mockRowReads = [];
  forgetSessionImport();
});

const unresolved = (rows: { name: string; year?: number | null }[]) => {
  mockUnresolved = {
    data: rows.map((raw, i) => ({ id: `r${String(i).padStart(5, '0')}`, raw })),
    error: null,
  };
};

/**
 * The synthetic file's job, settled: two movies not added (one unmatched, one already
 * ranked), the undated show not found, the other two shows matched, the episode and the
 * game unsupported. Movies: 5 + 1 + 1 = 7. Shows: 2 + 1 = 3.
 */
const COUNTS = {
  applied: 6,
  watched: 5,
  kept: 1,
  unmatched: 2,
  unsupported: 4,
  unsupported_tv: 2,
  unsupported_episode: 1,
};
const UNRESOLVED = [{ name: 'Too Loud', year: 2003 }, { name: 'The Long Valley' }];

/** Choose IMDb, pick the synthetic file, import it, and land on its summary. */
const importSynthetic = async (counts: Record<string, number> = COUNTS) => {
  mockPicked = imdbSyntheticBytes();
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
            completed_at: '2026-11-13T00:00:00.000Z',
            provider: 'imdb',
          };
    },
  };
  const view = await renderWithProviders(<ImportScreen surface="settings" chooser />);
  await waitFor(() => expect(view.getByTestId('choose-imdb')).toBeTruthy());
  await fireEvent.press(view.getByTestId('choose-imdb'));
  await waitFor(() =>
    expect(view.getByRole('button', { name: 'Upload IMDb file' })).toBeTruthy(),
  );
  await fireEvent.press(view.getByRole('button', { name: 'Upload IMDb file' }));
  await waitFor(() => expect(view.getByText('Ready to import')).toBeTruthy());
  await fireEvent.press(view.getByRole('button', { name: 'Import' }));
  await waitFor(() => expect(view.getByText(/^Your IMDb history is/)).toBeTruthy());
  return view;
};

/**
 * A finished job reopened by name, as after a restart: nothing of the file in memory. Was:
 * restored from the open-job lookup inside the 24-hour window, which QA 11-14 §6 removed;
 * a notification's `?job=` is how a finished summary comes back after a restart now.
 */
const restored = async (counts: Record<string, number> = COUNTS) => {
  mockRpcResults = {
    ...mockRpcResults,
    import_status: {
      status: 'done',
      counts,
      completed_at: new Date().toISOString(),
      provider: 'imdb',
    },
  };
  const view = await renderWithProviders(
    <ImportScreen surface="settings" chooser jobId={JOB} />,
  );
  await waitFor(() =>
    expect(view.getByText(/Your IMDb history|Nothing new came in/)).toBeTruthy(),
  );
  return view;
};

type View = Awaited<ReturnType<typeof restored>>;

/** Open the Unmatched row and wait for whatever it opens to. */
const openUnmatched = async (view: View) => {
  const toggle = await waitFor(() => view.getByRole('button', { name: /^Unmatched, / }));
  await fireEvent.press(toggle);
  await waitFor(() => expect(view.getByTestId('result-unmatched-content')).toBeTruthy());
  await waitFor(() => expect(view.queryByText('Getting the list…')).toBeNull());
  return within(view.getByTestId('result-unmatched-content'));
};

const rowsOf = (view: View) => view.queryAllByTestId('unmatched-row');

describe('the import just sent: Unmatched by title', () => {
  it('is collapsed, with the count, until it is opened', async () => {
    unresolved(UNRESOLVED);
    const view = await importSynthetic();
    expect(
      view.getByRole('button', { name: 'Unmatched, 2 titles', expanded: false }),
    ).toBeTruthy();
    expect(rowsOf(view)).toHaveLength(0);
  });

  it('lists each unmatched title with name, year, type and tt id, split by medium', async () => {
    unresolved(UNRESOLVED);
    const view = await importSynthetic();
    const list = await openUnmatched(view);
    // QA 11-14 §8: the reason sentence is gone; the list itself is the explanation. Was:
    // asserted present.
    expect(list.queryByText(/couldn’t find a confident match/)).toBeNull();
    // Both types are known from this session's parse, and both media are present, so the
    // list is split (IMP1113-UI §D). Movies first.
    expect(view.getByTestId('unmatched-medium')).toBeTruthy();
    expect(list.getByText('Too Loud (2003)')).toBeTruthy();
    expect(list.getByText('Movie · tt9000011')).toBeTruthy();
    expect(list.queryByText('The Long Valley')).toBeNull();

    await fireEvent.press(view.getByTestId('unmatched-medium'));
    await fireEvent.press(
      await waitFor(() => view.getByRole('menuitem', { name: 'TV shows' })),
    );
    await waitFor(() => expect(list.getByText('The Long Valley')).toBeTruthy());
    expect(list.getByText('TV Series · tt9000014')).toBeTruthy();
    expect(list.queryByText('Too Loud (2003)')).toBeNull();
  });

  it('has exactly as many titles as the count, across both media', async () => {
    unresolved(UNRESOLVED);
    const view = await importSynthetic();
    await openUnmatched(view);
    expect(rowsOf(view)).toHaveLength(1);
    await fireEvent.press(view.getByTestId('unmatched-medium'));
    await fireEvent.press(
      await waitFor(() => view.getByRole('menuitem', { name: 'TV shows' })),
    );
    await waitFor(() => expect(rowsOf(view)).toHaveLength(1));
  });

  it('reads the unmatched rows of this job only, name and year and nothing else', async () => {
    unresolved(UNRESOLVED);
    const view = await importSynthetic();
    await openUnmatched(view);
    expect(mockRowReads).toEqual([
      { table: 'import_rows', columns: 'id, raw', eq: ['job_id', JOB], range: [0, 999] },
    ]);
  });

  it('labels every row for a screen reader', async () => {
    unresolved(UNRESOLVED);
    const view = await importSynthetic();
    await openUnmatched(view);
    expect(view.getByLabelText('Too Loud, 2003, Movie, IMDb tt9000011')).toBeTruthy();
  });

  // H2 rows 7 and 8: a recognised show, an episode and another kind are notes, never rows,
  // and never listed under Unmatched or counted as imported.
  it('says recognised shows, episodes and other kinds in notes, and lists none of them', async () => {
    unresolved(UNRESOLVED);
    const view = await importSynthetic();
    expect(
      view.getByText(
        'We found 2 TV shows from your file in bingd, but TV shows from IMDb aren’t added yet.',
      ),
    ).toBeTruthy();
    expect(view.getByText(/1 TV episode didn’t come in/)).toBeTruthy();
    expect(view.getByText(/1 title didn’t come in because/)).toBeTruthy();
    expect(view.getByLabelText('Imported movies, 5')).toBeTruthy();
    await openUnmatched(view);
    for (const name of [
      'Harbour Lights (2011)',
      'Seven Winters (2019)',
      'Starfall Quest (2021)',
    ])
      expect(view.queryByText(name)).toBeNull();
    expect(view.queryByText(/Imported TV/)).toBeNull();
  });

  it('keeps the parse in memory only, for this job only', async () => {
    unresolved(UNRESOLVED);
    await importSynthetic();
    expect(sessionImportFor(JOB)).toHaveLength(12);
    expect(sessionImportFor('22222222-2222-4333-8444-555555555555')).toBeNull();
  });

  it('a re-import with nothing unmatched reads nothing and draws no Unmatched row', async () => {
    const view = await importSynthetic({
      applied: 7,
      watched: 0,
      already: 7,
      unsupported: 5,
      unsupported_tv: 3,
      unsupported_episode: 1,
    });
    await waitFor(() =>
      expect(view.getByText('Your IMDb history is already here')).toBeTruthy(),
    );
    expect(view.getByLabelText('Imported movies, 7. 7 from an earlier import')).toBeTruthy();
    expect(view.queryByRole('button', { name: /^Unmatched/ })).toBeNull();
    expect(mockRowReads).toEqual([]);
  });
});

describe('after a restart', () => {
  it('lists Unmatched from the server as one list, with no tt ids or types', async () => {
    unresolved(UNRESOLVED);
    const view = await restored();
    const list = await openUnmatched(view);
    expect(rowsOf(view)).toHaveLength(2);
    // Types are not known without the parse, so there is no split (IMP1113-UI §D).
    expect(view.queryByTestId('unmatched-medium')).toBeNull();
    expect(list.getByText('Too Loud (2003)')).toBeTruthy();
    expect(list.getByText('The Long Valley')).toBeTruthy();
    // The tt id is not recovered from the server: it was redacted, and nothing asks for it.
    expect(view.queryByText(/tt9\d{6}/)).toBeNull();
    expect(view.getByText(/We found 2 TV shows from your file in bingd/)).toBeTruthy();
  });

  it('says details are not available when the rows cannot be read, keeping the count', async () => {
    mockUnresolved = { data: null, error: { message: 'offline' } };
    const view = await restored();
    const list = await openUnmatched(view);
    expect(list.getByText('Details aren’t available for this import.')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Unmatched, 2 titles' })).toBeTruthy();
    expect(rowsOf(view)).toHaveLength(0);
  });

  it('says details are not available when the rows do not add up to the count', async () => {
    unresolved([{ name: 'Too Loud', year: 2003 }]);
    const view = await restored();
    await waitFor(() => expect(mockRowReads.length).toBe(1));
    const list = await openUnmatched(view);
    expect(list.getByText('Details aren’t available for this import.')).toBeTruthy();
    expect(rowsOf(view)).toHaveLength(0);
  });
});

describe('a long list', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      name: `Lost ${String(i).padStart(4, '0')}`,
      year: 2000,
    }));

  // H2 row 19 / I5: 1,000+ unmatched rows render paged, never all at once.
  it('draws fifty at a time, and pages the read past a thousand', async () => {
    unresolved(many(1_250));
    const view = await restored({ watched: 1, unmatched: 1_250 });
    await openUnmatched(view);
    expect(mockRowReads.map((r) => r.range)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(rowsOf(view)).toHaveLength(UNMATCHED_PAGE);
    // The count is the whole number, never the rows drawn.
    expect(view.getByRole('button', { name: 'Unmatched, 1250 titles' })).toBeTruthy();
    await fireEvent.press(view.getByRole('button', { name: 'Show more (1200 left)' }));
    expect(rowsOf(view)).toHaveLength(2 * UNMATCHED_PAGE);
    await fireEvent.press(view.getByRole('button', { name: 'Show more (1150 left)' }));
    expect(rowsOf(view)).toHaveLength(3 * UNMATCHED_PAGE);
  });

  it('pages a list of more than two hundred and ends with no Show more', async () => {
    unresolved(many(201));
    const view = await restored({ watched: 1, unmatched: 201 });
    await openUnmatched(view);
    for (let shown = UNMATCHED_PAGE; shown < 201; shown += UNMATCHED_PAGE) {
      expect(rowsOf(view)).toHaveLength(shown);
      await fireEvent.press(view.getByTestId('unmatched-more'));
    }
    expect(rowsOf(view)).toHaveLength(201);
    expect(view.queryByTestId('unmatched-more')).toBeNull();
  });

  it('draws a list of fifty or fewer whole', async () => {
    unresolved(many(UNMATCHED_PAGE));
    const view = await restored({ watched: 1, unmatched: UNMATCHED_PAGE });
    await openUnmatched(view);
    expect(rowsOf(view)).toHaveLength(UNMATCHED_PAGE);
    expect(view.queryByTestId('unmatched-more')).toBeNull();
  });
});

describe('a small screen', () => {
  it('never truncates a count, a label or a title: everything wraps', async () => {
    unresolved([
      {
        name: 'A Very Long Title That Will Certainly Need To Wrap On A Small Phone',
        year: 1999,
      },
    ]);
    const view = await restored({ watched: 12_345, kept: 2, unmatched: 1 });
    await openUnmatched(view);
    const texts = [
      view.getByText('12345'),
      view.getByText('Imported movies'),
      view.getByText('Unmatched'),
      view.getByText(/A Very Long Title/),
    ];
    for (const text of texts) {
      expect(text.props.numberOfLines).toBeUndefined();
      expect(text.props.ellipsizeMode).toBeUndefined();
      expect(text.props.adjustsFontSizeToFit).toBeUndefined();
    }
  });
});

describe('readUnresolvedRows', () => {
  it('refuses to page past its ceiling rather than list part of a set', async () => {
    expect(await readUnresolvedRows(JOB, UNRESOLVED_PAGE * MAX_PAGES + 1)).toEqual({
      state: 'unavailable',
    });
    expect(mockRowReads).toEqual([]);
  });

  it('calls a row with no name unreadable, because the list would come up short', async () => {
    mockUnresolved = {
      data: [
        { id: 'a', raw: { name: 'Fine' } },
        { id: 'b', raw: {} },
      ],
      error: null,
    };
    expect(await readUnresolvedRows(JOB, 2)).toEqual({ state: 'unavailable' });
  });

  it('keeps a year only when it is a whole number', async () => {
    mockUnresolved = {
      data: [
        { id: 'a', raw: { name: 'One', year: 2001 } },
        { id: 'b', raw: { name: 'Two', year: '2002' } },
      ],
      error: null,
    };
    expect(await readUnresolvedRows(JOB, 2)).toEqual({
      state: 'ready',
      rows: [
        { name: 'One', year: 2001 },
        { name: 'Two', year: null },
      ],
    });
  });
});
