import { fireEvent, waitFor, within } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { imdbSyntheticBytes } from './__fixtures__/imdb-synthetic';
import { COLLAPSED, PAGE } from './ImportOutcomeList';
import { ImportScreen } from './ImportScreen';
import { forgetSessionImport, sessionImportFor } from './session-outcomes';
import { MAX_PAGES, readUnresolvedRows, UNRESOLVED_PAGE } from './use-imdb-outcomes';

/**
 * The IMDb summary by title (`outcomes.ts`, `ImportOutcomeList.tsx`), on screen.
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
    expect(view.getByRole('button', { name: 'Choose IMDb CSV' })).toBeTruthy(),
  );
  await fireEvent.press(view.getByRole('button', { name: 'Choose IMDb CSV' }));
  await waitFor(() => expect(view.getByText('Ready to import')).toBeTruthy());
  await fireEvent.press(view.getByRole('button', { name: 'Import 7 movies' }));
  await waitFor(() => expect(view.getByText(/^Your IMDb history is/)).toBeTruthy());
  return view;
};

/** A finished job restored on open, as after a restart: nothing of the file in memory. */
const restored = async (counts: Record<string, number> = COUNTS) => {
  mockLiveJob = {
    data: {
      id: JOB,
      status: 'done',
      counts,
      completed_at: new Date().toISOString(),
      provider: 'imdb',
    },
    error: null,
  };
  const view = await renderWithProviders(<ImportScreen surface="settings" chooser />);
  await waitFor(() =>
    expect(view.getByText(/Your IMDb history|Nothing was added/)).toBeTruthy(),
  );
  return view;
};

const rowsOf = (view: Awaited<ReturnType<typeof restored>>, section: string) =>
  view.queryAllByTestId(`outcome-row-${section}`);

describe('the import just sent: every heading by title', () => {
  it('lists each title under the heading it landed in, with name, year and tt id', async () => {
    unresolved(UNRESOLVED);
    const view = await importSynthetic();
    await waitFor(() => expect(view.getByTestId('outcome-unmatched')).toBeTruthy());

    // The counts card is exactly what it was.
    expect(view.getByLabelText('5 Added to your collection')).toBeTruthy();
    expect(view.getByLabelText('1 Already in your collection')).toBeTruthy();
    expect(view.getByLabelText('2 Couldn’t match')).toBeTruthy();
    expect(view.getByLabelText('2 TV shows matched, not added')).toBeTruthy();
    expect(view.getByLabelText('2 Not supported')).toBeTruthy();

    const unmatched = within(view.getByTestId('outcome-unmatched'));
    expect(unmatched.getByText('Couldn’t match')).toBeTruthy();
    expect(unmatched.getByText(/couldn’t find a confident match/)).toBeTruthy();
    expect(unmatched.getByText('Too Loud (2003)')).toBeTruthy();
    expect(unmatched.getByText('tt9000011')).toBeTruthy();
    expect(unmatched.getByText('The Long Valley')).toBeTruthy();

    const tv = within(view.getByTestId('outcome-tv'));
    expect(tv.getByText('TV shows (not added yet)')).toBeTruthy();
    expect(tv.getByText('Harbour Lights (2011)')).toBeTruthy();
    expect(tv.getByText('Seven Winters (2019)')).toBeTruthy();
    expect(tv.getByText('Mini-series · tt9000003')).toBeTruthy();
    // Not found, so it is under Couldn't match and not here.
    expect(tv.queryByText('The Long Valley')).toBeNull();

    expect(
      within(view.getByTestId('outcome-episodes')).getByText('Harbour Lights: Pilot (2011)'),
    ).toBeTruthy();
    expect(
      within(view.getByTestId('outcome-other')).getByText('Starfall Quest (2021)'),
    ).toBeTruthy();
    expect(
      within(view.getByTestId('outcome-other')).getByText('Video game · tt9000009'),
    ).toBeTruthy();

    // A list replaces its sentence; nothing is said twice.
    expect(view.queryByText(/We couldn’t match 2 titles/)).toBeNull();
    expect(view.queryByText(/2 TV shows were matched but not added/)).toBeNull();
  });

  it('has exactly as many titles under each heading as the count beside it', async () => {
    unresolved(UNRESOLVED);
    const view = await importSynthetic();
    await waitFor(() => expect(view.getByTestId('outcome-unmatched')).toBeTruthy());
    const expected = { unmatched: 2, tv: 2, episodes: 1, other: 1 };
    for (const [section, n] of Object.entries(expected)) {
      expect(rowsOf(view, section)).toHaveLength(n);
      expect(
        within(view.getByTestId(`outcome-${section}`)).getByLabelText(`${n} titles`),
      ).toBeTruthy();
    }
    // Episodes + other = the card's "Not supported".
    expect(rowsOf(view, 'episodes').length + rowsOf(view, 'other').length).toBe(2);
  });

  it('reads the unmatched rows of this job only, name and year and nothing else', async () => {
    unresolved(UNRESOLVED);
    const view = await importSynthetic();
    await waitFor(() => expect(view.getByTestId('outcome-unmatched')).toBeTruthy());
    expect(mockRowReads).toEqual([
      { table: 'import_rows', columns: 'id, raw', eq: ['job_id', JOB], range: [0, 999] },
    ]);
  });

  it('labels every row for a screen reader with its heading', async () => {
    unresolved(UNRESOLVED);
    const view = await importSynthetic();
    await waitFor(() => expect(view.getByTestId('outcome-unmatched')).toBeTruthy());
    expect(view.getByLabelText('Too Loud, 2003, IMDb tt9000011, Couldn’t match')).toBeTruthy();
    expect(
      view.getByLabelText('The Long Valley, no year, IMDb tt9000014, Couldn’t match'),
    ).toBeTruthy();
    expect(
      view.getByLabelText(
        'Seven Winters, 2019, Mini-series, IMDb tt9000003, TV shows (not added yet)',
      ),
    ).toBeTruthy();
    expect(
      view.getByLabelText('Starfall Quest, 2021, Video game, IMDb tt9000009, Other'),
    ).toBeTruthy();
    for (const heading of ['Couldn’t match', 'TV shows (not added yet)', 'Episodes', 'Other']) {
      expect(view.getByRole('header', { name: heading })).toBeTruthy();
    }
  });

  it('keeps the parse in memory only, for this job only', async () => {
    unresolved(UNRESOLVED);
    await importSynthetic();
    expect(sessionImportFor(JOB)).toHaveLength(12);
    expect(sessionImportFor('22222222-2222-4333-8444-555555555555')).toBeNull();
  });

  it('a re-import that changed nothing lists nothing it cannot know', async () => {
    // Same file again: every movie is "Imported before" and every show is matched again.
    // Which movie is which is the server's to know, so those stay counts.
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
    expect(view.getByLabelText('7 Imported before')).toBeTruthy();
    expect(view.queryByLabelText(/Added to your collection/)).toBeTruthy();
    expect(view.queryByTestId('outcome-unmatched')).toBeNull();
    expect(rowsOf(view, 'tv')).toHaveLength(3);
    // No list exists for added or already-here titles.
    expect(view.queryByText('Paper Birds (2015)')).toBeNull();
    expect(mockRowReads).toEqual([]);
  });
});

describe('after a restart', () => {
  it('lists Couldn’t match from the server, and keeps counts and sentences for the rest', async () => {
    unresolved(UNRESOLVED);
    const view = await restored();
    await waitFor(() => expect(view.getByTestId('outcome-unmatched')).toBeTruthy());
    expect(rowsOf(view, 'unmatched')).toHaveLength(2);
    // The tt id is not recovered from the server: it was redacted, and nothing asks for it.
    expect(view.queryByText(/tt9\d{6}/)).toBeNull();
    expect(view.queryByTestId('outcome-tv')).toBeNull();
    expect(view.queryByTestId('outcome-episodes')).toBeNull();
    expect(view.queryByTestId('outcome-other')).toBeNull();
    expect(view.getByText(/2 TV shows were matched but not added/)).toBeTruthy();
    expect(view.getByText(/1 TV episode wasn’t added/)).toBeTruthy();
    expect(view.getByText(/1 title wasn’t added because it’s a kind of title/)).toBeTruthy();
    expect(view.getByLabelText('2 TV shows matched, not added')).toBeTruthy();
    expect(view.getByLabelText('2 Not supported')).toBeTruthy();
  });

  it('falls back to the sentence when the rows cannot be read', async () => {
    mockUnresolved = { data: null, error: { message: 'offline' } };
    const view = await restored();
    await waitFor(() => expect(view.getByText(/We couldn’t match 2 titles/)).toBeTruthy());
    expect(view.queryByTestId('outcome-unmatched')).toBeNull();
    expect(view.getByLabelText('2 Couldn’t match')).toBeTruthy();
  });

  it('falls back to the sentence when the rows do not add up to the count', async () => {
    unresolved([{ name: 'Too Loud', year: 2003 }]);
    const view = await restored();
    await waitFor(() => expect(mockRowReads.length).toBe(1));
    await waitFor(() => expect(view.getByText(/We couldn’t match 2 titles/)).toBeTruthy());
    expect(view.queryByTestId('outcome-unmatched')).toBeNull();
  });
});

describe('a long list', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      name: `Lost ${String(i).padStart(4, '0')}`,
      year: 2000,
    }));

  it('is collapsed, and Show all draws the rest', async () => {
    unresolved(many(40));
    const view = await restored({ watched: 1, unmatched: 40 });
    await waitFor(() => expect(view.getByTestId('outcome-unmatched')).toBeTruthy());
    expect(rowsOf(view, 'unmatched')).toHaveLength(COLLAPSED);
    // The count is the whole number, never the rows drawn.
    expect(view.getByLabelText('40 Couldn’t match')).toBeTruthy();
    await fireEvent.press(view.getByRole('button', { name: 'Show all 40' }));
    expect(rowsOf(view, 'unmatched')).toHaveLength(40);
    expect(view.queryByRole('button', { name: /^Show / })).toBeNull();
  });

  it('is drawn a page at a time past a hundred, and pages the read past a thousand', async () => {
    unresolved(many(1_250));
    const view = await restored({ watched: 1, unmatched: 1_250 });
    await waitFor(() => expect(view.getByTestId('outcome-unmatched')).toBeTruthy());
    expect(mockRowReads.map((r) => r.range)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(rowsOf(view, 'unmatched')).toHaveLength(COLLAPSED);
    await fireEvent.press(view.getByRole('button', { name: `Show ${PAGE} more of 1250` }));
    expect(rowsOf(view, 'unmatched')).toHaveLength(PAGE);
    await fireEvent.press(view.getByRole('button', { name: `Show ${PAGE} more of 1250` }));
    expect(rowsOf(view, 'unmatched')).toHaveLength(2 * PAGE);
  });

  it('a short list is never collapsed', async () => {
    unresolved(many(8));
    const view = await restored({ watched: 1, unmatched: 8 });
    await waitFor(() => expect(view.getByTestId('outcome-unmatched')).toBeTruthy());
    expect(rowsOf(view, 'unmatched')).toHaveLength(8);
    expect(view.queryByRole('button', { name: /^Show / })).toBeNull();
  });
});

describe('a small screen', () => {
  it('never truncates a count, a heading or a title: everything wraps', async () => {
    unresolved([
      {
        name: 'A Very Long Title That Will Certainly Need To Wrap On A Small Phone',
        year: 1999,
      },
    ]);
    const view = await restored({ watched: 12_345, kept: 2, unmatched: 1 });
    await waitFor(() => expect(view.getByTestId('outcome-unmatched')).toBeTruthy());
    const texts = [
      view.getByText('12345'),
      view.getByText('Added to your collection'),
      within(view.getByTestId('outcome-unmatched')).getByText('Couldn’t match'),
      within(view.getByTestId('outcome-unmatched')).getByText('1'),
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
