import { fireEvent, waitFor, within } from '@testing-library/react-native';

import { rankingOf } from '@/test-utils/ranked-standing';
import { renderWithProviders } from '@/test-utils/render';

import { RankSessionScreen } from './RankSessionScreen';
import { RefineScreen } from './RefineScreen';

/**
 * **A completion summary states the ranking as it stands after the sitting** (QA
 * corrections, 2026-11-06).
 *
 * Phone QA ended a backlog sitting on `Pitch Black · #9 in Movies · 8.9` and
 * `Allied · #9 in Movies · 8.9`. Positions are unique, so one of those was stale: each
 * row was the answer its own placement returned, and Allied's placement at #9 had
 * pushed Pitch Black to #10 and re-scored it. These drive both real screens against a
 * server that answers exactly that way and assert the summary against the ranking the
 * server then holds — never against what a placement said at the time.
 */

const mockRpc = jest.fn();
jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () =>
            Promise.resolve({
              data: { id: 'pivot-1', kind: 'movie', title: 'Collateral', poster_path: null },
              error: null,
            }),
        }),
      }),
    }),
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

jest.mock('@/lib/prefs', () => ({
  readPref: () => Promise.resolve(null),
  writePref: () => Promise.resolve(),
}));

jest.mock('@/lib/analytics', () => ({
  ...jest.requireActual('@/lib/analytics'),
  track: () => {},
}));

const mockReadRanked = jest.fn();
jest.mock('@/features/collection/use-collection', () => ({
  ...jest.requireActual('@/features/collection/use-collection'),
  readRankedCollection: (...a: unknown[]) => mockReadRanked(...a),
}));

const target = (id: string, title: string) => ({
  media_item_id: id,
  title,
  poster_path: null,
  kind: 'movie',
  bucket: null,
  resume: false,
});
const PITCH_BLACK = target('pitch-black', 'Pitch Black');
const ALLIED = target('allied', 'Allied');
const HEAT = target('heat', 'Heat');

const queue = (targets: unknown[]) => ({
  status: targets.length ? 'ready' : 'empty',
  total: 3,
  remaining: targets.length,
  targets,
  checkpoint_every: 99,
});

const comparing = (pivot = 'pivot-1') => ({
  done: false,
  session_id: `session-${pivot}`,
  pivot,
  pivot_card: { id: pivot, kind: 'movie', title: 'Collateral', poster_path: null },
  resumed: false,
});

/** What a placement returns: where the title landed *at that moment*, and its score then. */
const landed = (position: number, score: number, extra: Record<string, unknown> = {}) => ({
  done: true,
  position,
  category: 'movies',
  bucket: 'loved',
  score,
  adjustable: false,
  activated: false,
  movement: null,
  ...extra,
});

/** Each RPC answers from its own queue in order; the last answer repeats. */
function serve(answers: Record<string, unknown[]>) {
  mockRpc.mockImplementation((fn: string) => {
    const q = answers[fn];
    const next = q && q.length > 1 ? q.shift() : q?.[0];
    return Promise.resolve({ data: next ?? null, error: null });
  });
}

const callsTo = (fn: string) => mockRpc.mock.calls.filter((c) => c[0] === fn);

/** A row's text, read off its accessible children. */
const rowText = (view: Awaited<ReturnType<typeof renderWithProviders>>) =>
  view.getAllByTestId('ranked-summary-row').map((row) =>
    within(row)
      .queryAllByText(/\S/)
      .map((t) => [t.props.children].flat().join(''))
      // The first text is the poster's initials, drawn when there is no artwork.
      .slice(1)
      .join(' · '),
  );

/** Answers "How was it?" with I liked it for the title on screen. */
async function likeIt(view: Awaited<ReturnType<typeof renderWithProviders>>, title: string) {
  await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
  await waitFor(() => expect(view.getByText(title)).toBeTruthy());
  await fireEvent.press(view.getByLabelText('I liked it'));
}

beforeEach(() => {
  mockRpc.mockReset();
  mockReadRanked.mockReset();
});

describe('the backlog summary', () => {
  it('the QA case: Allied lands at #9 after Pitch Black did — the summary says #9 and #10', async () => {
    serve({
      ranking_backlog: [queue([PITCH_BLACK, ALLIED]), queue([ALLIED]), queue([])],
      // Pitch Black: #9 of 22 in I liked it, 8.9. Allied: also #9, of 23, also 8.9 —
      // and it went in above Pitch Black, which the server shifted to #10.
      rank_backlog_start: [landed(9, 8.9), landed(9, 8.9)],
      refine_candidates: [{ status: 'empty', candidates: [], cta: { show: false } }],
    });
    mockReadRanked.mockResolvedValue(rankingOf({ loved: 23 }, { allied: 9, 'pitch-black': 10 }));
    const view = await renderWithProviders(
      <RankSessionScreen medium="movies" start="backlog" onExit={jest.fn()} />,
    );

    await likeIt(view, 'Pitch Black');
    await likeIt(view, 'Allied');

    await waitFor(() => expect(view.getByText('2 titles ranked')).toBeTruthy());
    await waitFor(() => expect(view.getAllByTestId('ranked-summary-row')).toHaveLength(2));
    expect(rowText(view)).toEqual([
      'Pitch Black · #10 in Movies · 8.8',
      'Allied · #9 in Movies · 8.9',
    ]);
    expect(view.getAllByText('#9 in Movies')).toHaveLength(1);
    expect(view.getByLabelText('8.8 out of 10, I liked it')).toBeTruthy();
    // The read went out after the sitting's last placement, never before it.
    const lastPlacement = Math.max(
      ...mockRpc.mock.invocationCallOrder.filter((_, i) => mockRpc.mock.calls[i][0] === 'rank_backlog_start'),
    );
    expect(mockReadRanked.mock.invocationCallOrder[0]).toBeGreaterThan(lastPlacement);
    expect(mockReadRanked).toHaveBeenCalledWith('user-1', 'movies');
    // Nothing about placement or scoring changed: two placements, as before.
    expect(callsTo('rank_backlog_start')).toHaveLength(2);
  });

  it('three titles, one through comparisons, each at the position the ranking holds', async () => {
    serve({
      ranking_backlog: [
        queue([PITCH_BLACK, ALLIED, HEAT]),
        queue([ALLIED, HEAT]),
        queue([HEAT]),
        queue([]),
      ],
      rank_backlog_start: [landed(3, 9.3), comparing(), landed(1, 10)],
      // Allied is placed by answering a comparison rather than straight from its bucket.
      rank_answer: [landed(2, 9.5)],
      refine_candidates: [{ status: 'empty', candidates: [], cta: { show: false } }],
    });
    // Heat at #1 pushed both down; Allied at #2 had already pushed Pitch Black to #4.
    mockReadRanked.mockResolvedValue(
      rankingOf({ loved: 5 }, { heat: 1, allied: 3, 'pitch-black': 4 }),
    );
    const view = await renderWithProviders(
      <RankSessionScreen medium="movies" start="backlog" onExit={jest.fn()} />,
    );

    await likeIt(view, 'Pitch Black');
    await likeIt(view, 'Allied');
    await waitFor(() => expect(view.getByLabelText('Choose Allied')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Choose Allied'));
    await likeIt(view, 'Heat');

    await waitFor(() => expect(view.getByText('3 titles ranked')).toBeTruthy());
    await waitFor(() => expect(view.getAllByTestId('ranked-summary-row')).toHaveLength(3));
    expect(rowText(view)).toEqual([
      'Pitch Black · #4 in Movies · 7.8',
      'Allied · #3 in Movies · 8.5',
      'Heat · #1 in Movies · 10.0',
    ]);
    expect(callsTo('rank_answer')).toHaveLength(1);
  });

  it('two titles printing the same score at different positions are both shown truthfully', async () => {
    serve({
      ranking_backlog: [queue([PITCH_BLACK, ALLIED]), queue([ALLIED]), queue([])],
      rank_backlog_start: [landed(50, 8.5), landed(52, 8.5)],
      refine_candidates: [{ status: 'empty', candidates: [], cta: { show: false } }],
    });
    // A band of 101 steps 0.03 a place: #50 (8.53) and #52 (8.47) both print 8.5.
    mockReadRanked.mockResolvedValue(rankingOf({ loved: 101 }, { 'pitch-black': 50, allied: 52 }));
    const view = await renderWithProviders(
      <RankSessionScreen medium="movies" start="backlog" onExit={jest.fn()} />,
    );

    await likeIt(view, 'Pitch Black');
    await likeIt(view, 'Allied');

    await waitFor(() => expect(view.getAllByTestId('ranked-summary-row')).toHaveLength(2));
    expect(rowText(view)).toEqual([
      'Pitch Black · #50 in Movies · 8.5',
      'Allied · #52 in Movies · 8.5',
    ]);
  });

  it('Keep ranking and Done again reads again, and moves the earlier title', async () => {
    serve({
      ranking_backlog: [queue([HEAT, ALLIED]), queue([ALLIED]), queue([ALLIED])],
      rank_backlog_start: [landed(4, 9.1), landed(4, 9.2)],
    });
    mockReadRanked.mockResolvedValueOnce(rankingOf({ loved: 11 }, { heat: 4 }));
    mockReadRanked.mockResolvedValueOnce(rankingOf({ loved: 12 }, { allied: 4, heat: 5 }));
    const view = await renderWithProviders(
      <RankSessionScreen medium="movies" start="backlog" onExit={jest.fn()} />,
    );

    await likeIt(view, 'Heat');
    await waitFor(() => expect(view.getByLabelText('Done')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Done'));
    await waitFor(() => expect(view.getByText('#4 in Movies')).toBeTruthy());
    expect(rowText(view)).toEqual(['Heat · #4 in Movies · 9.1']);

    await fireEvent.press(view.getByRole('button', { name: 'Keep ranking' }));
    await likeIt(view, 'Allied');
    await waitFor(() => expect(view.getByLabelText('Done')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Done'));

    await waitFor(() => expect(view.getByText('2 titles ranked')).toBeTruthy());
    await waitFor(() => expect(view.getByText('#5 in Movies')).toBeTruthy());
    expect(rowText(view)).toEqual(['Heat · #5 in Movies · 8.9', 'Allied · #4 in Movies · 9.2']);
    expect(mockReadRanked).toHaveBeenCalledTimes(2);
  });

  /**
   * **Back at the same count, read again** (independent review 2). Done, Keep ranking, then
   * Done before the next title finishes returns to the summary with nothing new placed
   * here — but the ranking may have moved (another device, or a placement that committed
   * while its reply was lost), and the first visit's copy must not be reused.
   */
  it('reads again every time the summary opens, even at the same count', async () => {
    serve({
      ranking_backlog: [queue([HEAT, ALLIED]), queue([ALLIED]), queue([ALLIED])],
      rank_backlog_start: [landed(4, 9.1)],
    });
    mockReadRanked.mockResolvedValueOnce(rankingOf({ loved: 11 }, { heat: 4 }));
    // By the second visit Allied was placed above Heat elsewhere.
    mockReadRanked.mockResolvedValueOnce(rankingOf({ loved: 12 }, { allied: 4, heat: 5 }));
    const view = await renderWithProviders(
      <RankSessionScreen medium="movies" start="backlog" onExit={jest.fn()} />,
    );

    await likeIt(view, 'Heat');
    await waitFor(() => expect(view.getByLabelText('Done')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Done'));
    await waitFor(() => expect(view.getByText('#4 in Movies')).toBeTruthy());

    await fireEvent.press(view.getByRole('button', { name: 'Keep ranking' }));
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    // Done again before Allied is answered: the same count, one title.
    await fireEvent.press(view.getByLabelText('Done'));

    await waitFor(() => expect(view.getByText('#5 in Movies')).toBeTruthy());
    expect(rowText(view)).toEqual(['Heat · #5 in Movies · 8.9']);
    expect(mockReadRanked).toHaveBeenCalledTimes(2);
  });

  it('holds the numbers back while the read is out, rather than showing the snapshots', async () => {
    serve({
      ranking_backlog: [queue([PITCH_BLACK, ALLIED]), queue([ALLIED]), queue([])],
      rank_backlog_start: [landed(9, 8.9), landed(9, 8.9)],
      refine_candidates: [{ status: 'empty', candidates: [], cta: { show: false } }],
    });
    let answer: (rows: unknown) => void = () => {};
    mockReadRanked.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const view = await renderWithProviders(
      <RankSessionScreen medium="movies" start="backlog" onExit={jest.fn()} />,
    );

    await likeIt(view, 'Pitch Black');
    await likeIt(view, 'Allied');

    await waitFor(() => expect(view.getByTestId('ranked-summary-settling')).toBeTruthy());
    expect(view.getByText('2 titles ranked')).toBeTruthy();
    expect(view.queryByText(/in Movies/)).toBeNull();
    expect(view.queryByLabelText(/out of 10/)).toBeNull();
    // Done does not wait for the read.
    expect(view.getByRole('button', { name: 'Done' })).toBeTruthy();

    answer(rankingOf({ loved: 23 }, { allied: 9, 'pitch-black': 10 }));
    await waitFor(() => expect(view.getByText('#10 in Movies')).toBeTruthy());
    expect(view.queryByTestId('ranked-summary-settling')).toBeNull();
  });

  it('a failed read shows the titles without numbers, and Try again settles them', async () => {
    serve({
      ranking_backlog: [queue([PITCH_BLACK, ALLIED]), queue([ALLIED]), queue([])],
      rank_backlog_start: [landed(9, 8.9), landed(9, 8.9)],
      refine_candidates: [{ status: 'empty', candidates: [], cta: { show: false } }],
    });
    mockReadRanked.mockRejectedValueOnce(new Error('offline'));
    mockReadRanked.mockResolvedValueOnce(rankingOf({ loved: 23 }, { allied: 9, 'pitch-black': 10 }));
    const view = await renderWithProviders(
      <RankSessionScreen medium="movies" start="backlog" onExit={jest.fn()} />,
    );

    await likeIt(view, 'Pitch Black');
    await likeIt(view, 'Allied');

    await waitFor(() => expect(view.getByTestId('ranked-summary-retry')).toBeTruthy());
    expect(view.getAllByTestId('ranked-summary-row')).toHaveLength(2);
    expect(view.queryByText(/in Movies/)).toBeNull();
    expect(view.queryByLabelText(/out of 10/)).toBeNull();

    await fireEvent.press(view.getByTestId('ranked-summary-retry'));
    await waitFor(() => expect(view.getByText('#10 in Movies')).toBeTruthy());
    expect(view.queryByTestId('ranked-summary-retry')).toBeNull();
  });

  it('a torn read is read again, and never shown as two titles at one position', async () => {
    serve({
      ranking_backlog: [queue([PITCH_BLACK, ALLIED]), queue([ALLIED]), queue([])],
      rank_backlog_start: [landed(9, 8.9), landed(9, 8.9)],
      refine_candidates: [{ status: 'empty', candidates: [], cta: { show: false } }],
    });
    // Page one before a move elsewhere, page two after it: both titles at #9.
    const torn = rankingOf({ loved: 23 }, { allied: 9, 'pitch-black': 10 }).map((row) =>
      row.mediaItemId === 'pitch-black' ? { ...row, position: 9 } : row,
    );
    mockReadRanked.mockResolvedValueOnce(torn);
    mockReadRanked.mockResolvedValueOnce(rankingOf({ loved: 23 }, { allied: 9, 'pitch-black': 10 }));
    const view = await renderWithProviders(
      <RankSessionScreen medium="movies" start="backlog" onExit={jest.fn()} />,
    );

    await likeIt(view, 'Pitch Black');
    await likeIt(view, 'Allied');

    await waitFor(() => expect(view.getAllByTestId('ranked-summary-row')).toHaveLength(2));
    expect(rowText(view)).toEqual([
      'Pitch Black · #10 in Movies · 8.8',
      'Allied · #9 in Movies · 8.9',
    ]);
    expect(mockReadRanked).toHaveBeenCalledTimes(2);
  });

  it('TV seasons read the season ranking and say "in TV"', async () => {
    const season = (id: string, title: string) => ({ ...target(id, title), kind: 'season' });
    serve({
      ranking_backlog: [
        queue([season('s1', 'Severance, S1'), season('s2', 'Severance, S2')]),
        queue([season('s2', 'Severance, S2')]),
        queue([]),
      ],
      rank_backlog_start: [
        landed(2, 9.5, { category: 'tv_seasons' }),
        landed(2, 9.5, { category: 'tv_seasons' }),
      ],
      refine_candidates: [{ status: 'empty', candidates: [], cta: { show: false } }],
    });
    mockReadRanked.mockResolvedValue(rankingOf({ loved: 7 }, { s2: 2, s1: 3 }));
    const view = await renderWithProviders(
      <RankSessionScreen medium="tv_seasons" start="backlog" onExit={jest.fn()} />,
    );

    await likeIt(view, 'Severance, S1');
    await likeIt(view, 'Severance, S2');

    await waitFor(() => expect(view.getAllByTestId('ranked-summary-row')).toHaveLength(2));
    expect(rowText(view)).toEqual(['Severance, S1 · #3 in TV · 9.0', 'Severance, S2 · #2 in TV · 9.5']);
    expect(mockReadRanked).toHaveBeenCalledWith('user-1', 'tv_seasons');
  });
});

describe('the Refine summary (re-ranking titles already ranked)', () => {
  const candidate = (id: string, title: string, position: number) => ({
    media_item_id: id,
    title,
    poster_path: null,
    kind: 'movie',
    position,
    resume: false,
    reason: 'never_compared',
    last_confirmed_at: null,
    confirmed_size: null,
  });

  it('a later move in the round shifts an earlier one, and the summary follows it', async () => {
    serve({
      refine_candidates: [
        { status: 'ready', candidates: [candidate('heat', 'Heat', 21)] },
        { status: 'ready', candidates: [candidate('ronin', 'Ronin', 30)] },
        { status: 'nothing_waiting', candidates: [] },
      ],
      refine_start: [comparing('pivot-1'), comparing('pivot-2')],
      rank_answer: [
        // Heat moves up to #15; then Ronin moves up past it to #12, so Heat is #16.
        landed(15, 8.8, { movement: { outcome: 'moved', from_position: 21, kind: 'refine' } }),
        landed(12, 9.1, { movement: { outcome: 'moved', from_position: 30, kind: 'refine' } }),
      ],
    });
    mockReadRanked.mockResolvedValue(rankingOf({ loved: 36 }, { ronin: 12, heat: 16 }));
    const view = await renderWithProviders(<RefineScreen medium="movies" onExit={jest.fn()} />);

    await waitFor(() => expect(view.getByLabelText('Choose Heat')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Choose Heat'));
    await waitFor(() => expect(view.getByLabelText('Choose Ronin')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Choose Ronin'));

    await waitFor(() => expect(view.getByText('2 titles checked')).toBeTruthy());
    await waitFor(() => expect(view.getAllByTestId('ranked-summary-row')).toHaveLength(2));
    expect(rowText(view)).toEqual(['Heat · #16 in Movies · 8.7', 'Ronin · #12 in Movies · 9.1']);
    expect(view.queryByText('#15 in Movies')).toBeNull();
  });
});
