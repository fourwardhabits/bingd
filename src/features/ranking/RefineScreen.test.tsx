import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { RefineScreen } from './RefineScreen';

/**
 * Refine's screen (T5). The server owns selection and every ranking change, so what is
 * asserted here is the conversation with it: which calls go out, in which order, with
 * which arguments, and what the reader is told about each answer. One press per test —
 * see the RNTL double-press trap.
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

const mockWritePref = jest.fn(() => Promise.resolve());
jest.mock('@/lib/prefs', () => ({
  readPref: () => Promise.resolve(null),
  writePref: (...a: unknown[]) => mockWritePref(...(a as [])),
}));

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({
  ...jest.requireActual('@/lib/analytics'),
  track: (...a: unknown[]) => mockTrack(...a),
}));

const HEAT = {
  media_item_id: 'heat',
  title: 'Heat',
  poster_path: null,
  kind: 'movie',
  position: 21,
  resume: false,
  reason: 'never_compared',
  last_confirmed_at: null,
  confirmed_size: null,
};

const comparing = {
  done: false,
  session_id: 'session-1',
  pivot: 'pivot-1',
  pivot_card: { id: 'pivot-1', kind: 'movie', title: 'Collateral', poster_path: null },
  resumed: false,
};

/** Routes each RPC by name to a queue of answers. */
function serve(answers: Record<string, unknown[]>) {
  mockRpc.mockImplementation((fn: string) => {
    const queue = answers[fn];
    const next = queue?.length ? queue.shift() : undefined;
    if (next instanceof Error) return Promise.resolve({ data: null, error: next });
    return Promise.resolve({ data: next ?? null, error: null });
  });
}

const callsTo = (fn: string) => mockRpc.mock.calls.filter((c) => c[0] === fn);

beforeEach(() => {
  mockRpc.mockReset();
  mockTrack.mockReset();
  mockWritePref.mockClear();
});

/**
 * Refine looks like the backlog now (founder polish, 2026-09-22): the header, the progress
 * count and the ordinary pairwise question. The evidence that chose the title is still
 * carried — `refine_target_outcome` reports it — but the reader is not shown a case for it.
 */
it('opens straight into the comparison, with a count and no explanatory block', async () => {
  serve({
    refine_candidates: [
      { status: 'ready', candidates: [HEAT], cta: { show: true, count: 4, strong: 9 } },
    ],
    refine_start: [comparing],
  });
  const view = await renderWithProviders(<RefineScreen medium="movies" onExit={jest.fn()} />);

  await waitFor(() => expect(view.getByText('Which did you like more?')).toBeTruthy());
  expect(view.getByText('Refine · Movies')).toBeTruthy();
  // The batch the server offered, held for the round.
  expect(view.getByTestId('refine-progress').props.children).toBe('0 of 4 refined');
  expect(view.queryByText('Is this still in the right place?')).toBeNull();
  expect(view.queryByText('#21 in Movies')).toBeNull();
  expect(view.queryByText('Never compared with the titles around it')).toBeNull();

  const [, candidateArgs] = callsTo('refine_candidates')[0];
  expect(candidateArgs).toMatchObject({ p_category: 'movies', p_limit: 1, p_recent: [] });
  const [, startArgs] = callsTo('refine_start')[0];
  expect(startArgs).toMatchObject({ p_media_item_id: 'heat' });
  expect(startArgs).toHaveProperty('p_operation_id');
});

it('an answer that moves it says exactly where from and to, privately', async () => {
  serve({
    refine_candidates: [{ status: 'ready', candidates: [HEAT] }],
    refine_start: [comparing],
    rank_answer: [
      {
        done: true,
        position: 15,
        category: 'movies',
        bucket: 'loved',
        score: 8.8,
        adjustable: false,
        activated: false,
        movement: { outcome: 'moved', from_position: 21, kind: 'refine' },
      },
    ],
  });
  const view = await renderWithProviders(<RefineScreen medium="movies" onExit={jest.fn()} />);
  await waitFor(() => expect(view.getByLabelText('Choose Heat')).toBeTruthy());

  await fireEvent.press(view.getByLabelText('Choose Heat'));

  await waitFor(() => expect(view.getByText('Moved from #21 → #15')).toBeTruthy());
  expect(view.getByLabelText('Moved up')).toBeTruthy();
  const [, answerArgs] = callsTo('rank_answer')[0];
  expect(answerArgs).toMatchObject({ p_session_id: 'session-1', p_winner: 'heat' });
  expect(mockTrack).toHaveBeenCalledWith({
    name: 'refine_target_outcome',
    props: {
      outcome: 'moved',
      reason: 'never_compared',
      comparisons: 1,
      medium: 'movies',
      // The fixture carries no signals, so each is false: they are the server's, never guessed.
      signal_gap: false,
      signal_contradicted: false,
      signal_crossed: false,
      signal_strong: false,
    },
  });
});

it('a confirmed title reads Still #N', async () => {
  serve({
    refine_candidates: [{ status: 'ready', candidates: [HEAT] }],
    refine_start: [comparing],
    rank_answer: [
      {
        done: true,
        position: 21,
        category: 'movies',
        bucket: 'loved',
        score: 8.1,
        movement: { outcome: 'unchanged', from_position: 21, kind: 'refine' },
      },
    ],
  });
  const view = await renderWithProviders(<RefineScreen medium="movies" onExit={jest.fn()} />);
  await waitFor(() => expect(view.getByLabelText('Choose Collateral')).toBeTruthy());
  await fireEvent.press(view.getByLabelText('Choose Collateral'));
  await waitFor(() => expect(view.getByText('Still #21')).toBeTruthy());
});

it('Close mid-comparison cancels the provisional session and leaves', async () => {
  serve({
    refine_candidates: [{ status: 'ready', candidates: [HEAT] }],
    refine_start: [comparing],
    rank_cancel: [{ done: true, cancelled: true }],
  });
  const onExit = jest.fn();
  const view = await renderWithProviders(<RefineScreen medium="movies" onExit={onExit} />);
  await waitFor(() => expect(view.getByText('Which did you like more?')).toBeTruthy());

  await fireEvent.press(view.getByLabelText('Close'));

  await waitFor(() => expect(onExit).toHaveBeenCalled());
  expect(callsTo('rank_cancel')[0][1]).toEqual({ p_session_id: 'session-1' });
  expect(mockTrack).toHaveBeenCalledWith({
    name: 'refine_session_ended',
    props: { targets: 0, moved: 0, comparisons: 0, ended_by: 'close', medium: 'movies' },
  });
  // Nothing finished, so the entry is not rested.
  expect(mockWritePref).not.toHaveBeenCalled();
});

/**
 * The title skip is the backlog's, in the backlog's words (founder, 2026-09-22). It leaves
 * the title for this sitting and cancels its provisional session — it does not snooze it
 * for 180 days, and `refine_snooze` is no longer called from anywhere in the flow.
 */
it('"Skip title (left)" leaves it for the sitting and never snoozes it', async () => {
  serve({
    refine_candidates: [
      { status: 'ready', candidates: [HEAT] },
      { status: 'nothing_waiting', candidates: [] },
    ],
    refine_start: [comparing],
    rank_cancel: [{ done: true, cancelled: true }],
  });
  const view = await renderWithProviders(<RefineScreen medium="movies" onExit={jest.fn()} />);
  await waitFor(() => expect(view.getByText('Skip title (left)')).toBeTruthy());

  await fireEvent.press(view.getByText('Skip title (left)'));

  await waitFor(() => expect(view.getByText('Nothing needs a look right now')).toBeTruthy());
  expect(callsTo('refine_snooze')).toHaveLength(0);
  expect(callsTo('rank_cancel')[0][1]).toEqual({ p_session_id: 'session-1' });
  expect(callsTo('refine_candidates')[1][1]).toMatchObject({ p_recent: ['heat'] });
});

/**
 * No per-title result page (founder, 2026-09-22): a later target in the same round can move
 * this one again, so the count goes up and the next target opens. The checkpoint at the end
 * of the round still lists what moved.
 */
it('counts a finished target and deals the next one, with no result page', async () => {
  serve({
    refine_candidates: [
      { status: 'ready', candidates: [HEAT], cta: { show: true, count: 3, strong: 5 } },
      {
        status: 'ready',
        candidates: [{ ...HEAT, media_item_id: 'ronin', title: 'Ronin', position: 9 }],
        cta: { show: true, count: 3, strong: 4 },
      },
    ],
    refine_start: [comparing, comparing],
    rank_answer: [
      {
        done: true,
        position: 15,
        category: 'movies',
        bucket: 'loved',
        score: 8.8,
        movement: { outcome: 'moved', from_position: 21, kind: 'refine' },
      },
    ],
  });
  const view = await renderWithProviders(<RefineScreen medium="movies" onExit={jest.fn()} />);
  await waitFor(() => expect(view.getByLabelText('Choose Heat')).toBeTruthy());

  await fireEvent.press(view.getByLabelText('Choose Heat'));

  await waitFor(() =>
    expect(view.getByTestId('refine-progress').props.children).toBe('1 of 3 refined'),
  );
  expect(view.queryByText('Moved from #21 → #15')).toBeNull();
  expect(view.queryByRole('button', { name: 'Next' })).toBeNull();
  expect(callsTo('refine_candidates')).toHaveLength(2);
});

it('nothing waiting is a finish, not an error', async () => {
  serve({ refine_candidates: [{ status: 'nothing_waiting', candidates: [] }] });
  const onExit = jest.fn();
  const view = await renderWithProviders(<RefineScreen medium="tv_seasons" onExit={onExit} />);
  await waitFor(() => expect(view.getByText('Nothing needs a look right now')).toBeTruthy());
  expect(callsTo('refine_start')).toHaveLength(0);

  await fireEvent.press(view.getByText('Done'));
  expect(onExit).toHaveBeenCalled();
  expect(mockTrack).toHaveBeenCalledWith({
    name: 'refine_session_ended',
    props: { targets: 0, moved: 0, comparisons: 0, ended_by: 'exhausted', medium: 'tv' },
  });
});

it('a small library is told when Refine starts to help', async () => {
  serve({ refine_candidates: [{ status: 'too_small', candidates: [], min_ranked: 20 }] });
  const view = await renderWithProviders(<RefineScreen medium="movies" onExit={jest.fn()} />);
  await waitFor(() =>
    expect(view.getByText('Refining helps once you have ranked 20 movies.')).toBeTruthy(),
  );
});

it('a backend without Refine reads as not available, never as a crash', async () => {
  mockRpc.mockImplementation(() =>
    Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'no such function' } }),
  );
  const view = await renderWithProviders(<RefineScreen medium="movies" onExit={jest.fn()} />);
  await waitFor(() => expect(view.getByText('Not available')).toBeTruthy());
});

it('says nothing that implies precision', async () => {
  serve({
    refine_candidates: [{ status: 'ready', candidates: [HEAT] }],
    refine_start: [comparing],
  });
  const view = await renderWithProviders(<RefineScreen medium="movies" onExit={jest.fn()} />);
  await waitFor(() => expect(view.getByText('Which did you like more?')).toBeTruthy());
  expect(view.queryByText(/%|confiden|accura/i)).toBeNull();
});

it('Undo at a title’s first comparison sets it aside and deals the next', async () => {
  serve({
    refine_candidates: [
      { status: 'ready', candidates: [HEAT] },
      { status: 'nothing_waiting', candidates: [] },
    ],
    refine_start: [comparing],
    rank_back: [{ done: false, cancelled: true }],
  });
  const view = await renderWithProviders(<RefineScreen medium="movies" onExit={jest.fn()} />);
  await waitFor(() => expect(view.getByLabelText('Undo the last comparison')).toBeTruthy());

  await fireEvent.press(view.getByLabelText('Undo the last comparison'));

  await waitFor(() => expect(view.getByText('Nothing needs a look right now')).toBeTruthy());
  expect(callsTo('refine_candidates')[1][1]).toMatchObject({ p_recent: ['heat'] });
});
