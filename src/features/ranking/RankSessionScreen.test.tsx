import { fireEvent, waitFor, within } from '@testing-library/react-native';
import { Dimensions, StyleSheet } from 'react-native';

import { rankingOf } from '@/test-utils/ranked-standing';
import { renderWithProviders } from '@/test-utils/render';

import { askPosterWidth, RankSessionScreen } from './RankSessionScreen';

/**
 * The ranking session's backlog source (unified Backlog + Refine, 2026-09-21). The server
 * owns the queue, its order and every placement, so what is asserted is the conversation
 * with it — which calls go out, with which arguments — and what the reader is shown. One
 * press per test (the RNTL double-press trap).
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

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({
  ...jest.requireActual('@/lib/analytics'),
  track: (...a: unknown[]) => mockTrack(...a),
}));

/**
 * **The summary's numbers come from a fresh read of the ranking** (QA corrections,
 * 2026-11-06), not from the placement's own answer. Each test says what the ranking is.
 */
const mockReadRanked = jest.fn();
jest.mock('@/features/collection/use-collection', () => ({
  ...jest.requireActual('@/features/collection/use-collection'),
  readRankedCollection: (...a: unknown[]) => mockReadRanked(...a),
}));

const UNTOUCHED = {
  media_item_id: 'heat',
  title: 'Heat',
  poster_path: null,
  kind: 'movie',
  bucket: null,
  resume: false,
};
/** A bucket chosen in bingd and a session left open: an incomplete native placement. */
const INCOMPLETE = {
  ...UNTOUCHED,
  media_item_id: 'ronin',
  title: 'Ronin',
  bucket: 'fine',
  resume: true,
};

const queue = (targets: unknown[], extra: Record<string, unknown> = {}) => ({
  status: targets.length ? 'ready' : 'empty',
  total: 2,
  remaining: targets.length,
  targets,
  checkpoint_every: 10,
  ...extra,
});

const comparing = {
  done: false,
  session_id: 'session-1',
  pivot: 'pivot-1',
  pivot_card: { id: 'pivot-1', kind: 'movie', title: 'Collateral', poster_path: null },
  resumed: false,
};

const placed = {
  done: true,
  position: 4,
  category: 'movies',
  bucket: 'fine',
  score: 6.2,
  movement: { outcome: 'placed', from_position: null, kind: 'import' },
};

/** Routes each RPC by name to a queue of answers; the last one repeats. */
function serve(answers: Record<string, unknown[]>) {
  mockRpc.mockImplementation((fn: string) => {
    const q = answers[fn];
    const next = q && q.length > 1 ? q.shift() : q?.[0];
    return Promise.resolve({ data: next ?? null, error: null });
  });
}

const callsTo = (fn: string) => mockRpc.mock.calls.filter((c) => c[0] === fn);

const open = async (start: 'backlog' | 'refine' = 'backlog') => {
  const onExit = jest.fn();
  const view = await renderWithProviders(
    <RankSessionScreen medium="movies" start={start} onExit={onExit} />,
  );
  return { ...view, onExit };
};

beforeEach(() => {
  mockRpc.mockReset();
  mockTrack.mockReset();
  // Heat second of six in It was fine, under two in I liked it: #4, 6.2 — the same
  // standing the `placed` fixture reports, so a one-title sitting reads as it did.
  mockReadRanked.mockReset();
  mockReadRanked.mockResolvedValue(rankingOf({ loved: 2, fine: 6 }, { heat: 4 }));
});

it('asks "How was it?" first for a title with no bingd opinion, and opens nothing yet', async () => {
  serve({ ranking_backlog: [queue([UNTOUCHED])] });
  const view = await open();

  await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
  expect(view.getByText('Heat')).toBeTruthy();
  expect(view.getByTestId('backlog-progress').props.children).toBe('0 of 2 ranked');
  expect(callsTo('rank_backlog_start')).toHaveLength(0);
});

it('the answer to "How was it?" opens the placement in that bucket', async () => {
  serve({ ranking_backlog: [queue([UNTOUCHED])], rank_backlog_start: [comparing] });
  const view = await open();

  await waitFor(() => expect(view.getByLabelText('It was fine')).toBeTruthy());
  await fireEvent.press(view.getByLabelText('It was fine'));

  await waitFor(() => expect(view.getByLabelText('Choose Heat')).toBeTruthy());
  expect(callsTo('rank_backlog_start')[0][1]).toMatchObject({
    p_media_item_id: 'heat',
    p_bucket: 'fine',
  });
});

it('an incomplete placement goes straight back into its comparisons, never asked again', async () => {
  serve({ ranking_backlog: [queue([INCOMPLETE])], rank_backlog_start: [comparing] });
  const view = await open();

  await waitFor(() => expect(view.getByLabelText('Choose Ronin')).toBeTruthy());
  expect(view.queryByText('How was it?')).toBeNull();
  // null: the server resumes the session in the bucket already chosen, with its answers.
  expect(callsTo('rank_backlog_start')[0][1]).toMatchObject({
    p_media_item_id: 'ronin',
    p_bucket: null,
  });
});

it('a placement counts toward the fixed total and deals the next title', async () => {
  serve({
    ranking_backlog: [queue([INCOMPLETE]), queue([UNTOUCHED], { total: 1 })],
    rank_backlog_start: [placed],
  });
  const view = await open();

  await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
  // The total is the one read when the sitting began, not the shrinking one.
  expect(view.getByTestId('backlog-progress').props.children).toBe('1 of 2 ranked');
  expect(callsTo('ranking_backlog')).toHaveLength(2);
  expect(mockTrack).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'ranking_completed',
      props: expect.objectContaining({ mode: 'backlog', surface: 'collection' }),
    }),
  );
});

it('pauses softly at the checkpoint with Keep going and Done', async () => {
  serve({
    ranking_backlog: [queue([INCOMPLETE], { checkpoint_every: 1 })],
    rank_backlog_start: [placed],
  });
  const view = await open();

  await waitFor(() => expect(view.getByText('1 title ranked.')).toBeTruthy());
  expect(view.getByRole('button', { name: 'Keep going' })).toBeTruthy();
  expect(view.getByRole('button', { name: 'Done' })).toBeTruthy();
});

it('Skip lasts for the sitting: the next read carries it', async () => {
  serve({ ranking_backlog: [queue([UNTOUCHED]), queue([])] });
  const view = await open();

  await waitFor(() => expect(view.getByLabelText('Skip Heat')).toBeTruthy());
  await fireEvent.press(view.getByLabelText('Skip Heat'));

  await waitFor(() => expect(callsTo('ranking_backlog')).toHaveLength(2));
  expect(callsTo('ranking_backlog')[1][1]).toMatchObject({ p_skip: ['heat'] });
});

it('caught up, it offers Refine only when the server says the batch is worth it', async () => {
  serve({
    ranking_backlog: [queue([])],
    refine_candidates: [
      {
        status: 'ready',
        candidates: [{ media_item_id: 'x', title: 'X', position: 3, reason: 'crossed' }],
        cta: { show: true, count: 3, strong: 3, qualifying: 5 },
      },
    ],
  });
  const view = await open();

  await waitFor(() => expect(view.getByText('You’re caught up.')).toBeTruthy());
  expect(view.getByText('Refine a few rankings?')).toBeTruthy();
  expect(view.getByRole('button', { name: 'Keep going' })).toBeTruthy();
});

it('caught up with no strong batch: just Done, and it never moves on by itself', async () => {
  serve({
    ranking_backlog: [queue([])],
    refine_candidates: [{ status: 'ready', candidates: [], cta: { show: false } }],
  });
  const view = await open();

  await waitFor(() => expect(view.getByText('You’re caught up.')).toBeTruthy());
  expect(view.queryByText('Refine a few rankings?')).toBeNull();
  expect(callsTo('refine_start')).toHaveLength(0);
});

/**
 * **Done with nothing placed is the old Close** (founder addendum, 2026-09-24): it leaves,
 * and it does not manufacture a summary of zero titles. The placement left mid-comparison
 * is still not cancelled, so + / Rank resumes it — the property this test has always been
 * about, now reached through the control that replaced the glyph.
 */
it('Done with nothing placed leaves, and keeps a placement left mid-comparison', async () => {
  serve({ ranking_backlog: [queue([INCOMPLETE])], rank_backlog_start: [comparing] });
  const view = await open();

  await waitFor(() => expect(view.getByLabelText('Choose Ronin')).toBeTruthy());
  expect(view.queryByLabelText('Close')).toBeNull();

  await fireEvent.press(view.getByLabelText('Done'));

  expect(view.onExit).toHaveBeenCalled();
  expect(view.queryByTestId('ranked-summary-scroll')).toBeNull();
  expect(callsTo('rank_cancel')).toHaveLength(0);
  expect(mockTrack).toHaveBeenCalledWith({
    name: 'backlog_session_ended',
    props: { placed: 0, skipped: 0, ended_by: 'done', medium: 'movies' },
  });
});

it('start=refine opens Refine directly', async () => {
  serve({ refine_candidates: [{ status: 'nothing_waiting', candidates: [] }] });
  const view = await open('refine');

  await waitFor(() => expect(view.getByText('Nothing needs a look right now')).toBeTruthy());
  expect(callsTo('ranking_backlog')).toHaveLength(0);
});

/**
 * **The denominator is fixed when the sitting starts** (founder QA, 2026-09-22: "0 of 19"
 * became "0 of 18" after a skip). Skipping removes a title from what is left to deal —
 * `remaining` — and must never move the number the reader is counting toward. The server
 * keeps `total` stable across a skip (`ranking-backlog.test.mjs`); this pins the screen
 * against a shrinking one whatever the reason, including a title ranked on another device
 * mid-sitting.
 */
it('a skip never moves the denominator, even if the server total shrinks', async () => {
  serve({
    ranking_backlog: [
      queue([UNTOUCHED], { total: 19, remaining: 19 }),
      queue([{ ...UNTOUCHED, media_item_id: 'ronin', title: 'Ronin' }], {
        total: 18,
        remaining: 18,
      }),
    ],
  });
  const view = await open();

  await waitFor(() => expect(view.getByLabelText('Skip Heat')).toBeTruthy());
  expect(view.getByTestId('backlog-progress').props.children).toBe('0 of 19 ranked');

  await fireEvent.press(view.getByLabelText('Skip Heat'));

  await waitFor(() => expect(view.getByText('Ronin')).toBeTruthy());
  expect(view.getByTestId('backlog-progress').props.children).toBe('0 of 19 ranked');
  expect(callsTo('ranking_backlog')[1][1]).toMatchObject({ p_skip: ['heat'] });
});

/** The bucket screen is one state of the same flow, so the target's poster stays on it. */
it('shows the target poster on How was it?', async () => {
  serve({ ranking_backlog: [queue([{ ...UNTOUCHED, poster_path: '/heat.jpg' }])] });
  const view = await open();

  await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
  expect(view.getByTestId('backlog-ask-poster')).toBeTruthy();
});

/**
 * **A poster the size of the comparison's** (founder, QA corrections, 2026-11-06): about
 * one and a half times the old fixed 88pt, giving way to a short screen or large text so
 * the choices below it stay on screen.
 */
describe('the "How was it?" poster', () => {
  it('is about 1.45–1.5× the old 88pt on ordinary phones', () => {
    expect(askPosterWidth({ width: 320, height: 640 })).toBe(128);
    expect(askPosterWidth({ width: 360, height: 780 })).toBe(132);
    expect(askPosterWidth({ width: 412, height: 915 })).toBe(132);
    for (const [width, height] of [
      [320, 640],
      [360, 780],
      [412, 915],
    ]) {
      const ratio = askPosterWidth({ width, height }) / 88;
      expect(ratio).toBeGreaterThanOrEqual(1.4);
      expect(ratio).toBeLessThanOrEqual(1.5);
    }
  });

  it('gives way to a short screen, but never below the old size at ordinary text', () => {
    expect(askPosterWidth({ width: 360, height: 560 })).toBe(112);
    expect(askPosterWidth({ width: 320, height: 400 })).toBe(88);
  });

  it('scales down with larger system text so the choices keep their place', () => {
    expect(askPosterWidth({ width: 360, height: 780, fontScale: 1.3 })).toBe(120);
    expect(askPosterWidth({ width: 360, height: 780, fontScale: 2 })).toBe(78);
    // At the largest sizes on a small phone it may go to poster.sm rather than the floor.
    expect(askPosterWidth({ width: 320, height: 568, fontScale: 2 })).toBe(56);
  });

  it('draws at that width, 2:3, between the question and the title, buckets and Skip below', async () => {
    serve({ ranking_backlog: [queue([{ ...UNTOUCHED, poster_path: '/heat.jpg' }])] });
    const view = await open();
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());

    const box = view.getByTestId('backlog-ask-poster');
    const frame = StyleSheet.flatten((box.children[0] as { props: { style: unknown } }).props.style);
    const { width, height, fontScale } = Dimensions.get('window');
    expect(frame.width).toBe(askPosterWidth({ width, height, fontScale }));
    expect(frame.aspectRatio).toBe(2 / 3);
    expect(frame.height).toBeUndefined();

    // The title stays under the poster, inside the same block; the order down the screen
    // is question, poster, title, choices, Skip title.
    expect(within(box).getByText('Heat')).toBeTruthy();
    const tree = JSON.stringify(view.toJSON());
    const at = ['"How was it?"', '"Heat"', '"I liked it"', '"Skip title"'].map((text) =>
      tree.indexOf(text),
    );
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(view.getByTestId('backlog-bucket-choices')).toBeTruthy();
  });

  it('is the same for a TV season', async () => {
    serve({
      ranking_backlog: [
        queue([{ ...UNTOUCHED, kind: 'season', title: 'Severance, S1', poster_path: '/s.jpg' }]),
      ],
    });
    const onExit = jest.fn();
    const view = await renderWithProviders(
      <RankSessionScreen medium="tv_seasons" start="backlog" onExit={onExit} />,
    );
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    const box = view.getByTestId('backlog-ask-poster');
    const frame = StyleSheet.flatten((box.children[0] as { props: { style: unknown } }).props.style);
    const { width, height, fontScale } = Dimensions.get('window');
    expect(frame.width).toBe(askPosterWidth({ width, height, fontScale }));
  });
});

/** Founder QA, 2026-09-22: the two escapes must read as different acts on the pair screen. */
it('names the title skip by its side on the comparison, and plainly on the bucket screen', async () => {
  serve({ ranking_backlog: [queue([UNTOUCHED])], rank_backlog_start: [comparing] });
  const view = await open();

  await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
  expect(view.getByText('Skip title')).toBeTruthy();

  await fireEvent.press(view.getByLabelText('It was fine'));

  await waitFor(() => expect(view.getByText('Skip title (left)')).toBeTruthy());
  expect(view.getByText("Can't decide")).toBeTruthy();
  expect(view.queryByText('Too tough')).toBeNull();
});

/**
 * **The payoff** (founder addendum, 2026-09-24).
 *
 * A reader with four hundred unranked titles should not have to empty the queue to see
 * what they just did. Done ends the sitting and shows it — and shows **only** what this
 * sitting actually placed, which is the constraint every case below is really about.
 */
describe('the completion summary', () => {
  it('Done mid-sitting summarises what was placed, and offers to carry on', async () => {
    serve({
      ranking_backlog: [queue([UNTOUCHED, INCOMPLETE], { checkpoint_every: 99 })],
      rank_backlog_start: [placed],
    });
    const view = await open();

    // One placement lands from the bucket tap, then Done.
    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('It was fine'));
    await waitFor(() => expect(view.getByLabelText('Done')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Done'));

    await waitFor(() => expect(view.getByText('1 title ranked')).toBeTruthy());
    // The canonical label, the score badge, and nothing about movement or watching.
    expect(view.getByText('#4 in Movies')).toBeTruthy();
    expect(view.getByLabelText('6.2 out of 10, It was fine')).toBeTruthy();
    expect(view.queryByText(/→/)).toBeNull();
    expect(view.queryByText(/Still #/)).toBeNull();
    // The queue is not finished, so it says so by offering to continue it.
    expect(view.getByRole('button', { name: 'Keep ranking' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(view.queryByText('You’re caught up.')).toBeNull();
  });

  it('lists only completed titles — never a skipped one', async () => {
    serve({
      ranking_backlog: [
        queue([UNTOUCHED, INCOMPLETE], { checkpoint_every: 99 }),
        queue([INCOMPLETE], { checkpoint_every: 99 }),
      ],
      // Ronin resumes into its comparison rather than landing, so it stays incomplete.
      rank_backlog_start: [comparing],
    });
    const view = await open();

    await waitFor(() => expect(view.getByLabelText('Skip Heat')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Skip Heat'));

    // Heat was skipped and Ronin never finished, so Done has nothing to show and leaves.
    await waitFor(() => expect(view.getByLabelText('Choose Ronin')).toBeTruthy());
    expect(view.queryByText('Heat')).toBeNull();
    expect(view.queryByTestId('ranked-summary-scroll')).toBeNull();
  });

  it('a natural finish uses the same summary, with no helper sentence', async () => {
    serve({
      ranking_backlog: [queue([UNTOUCHED], { checkpoint_every: 99 }), queue([])],
      rank_backlog_start: [placed],
      refine_candidates: [{ status: 'ready', candidates: [{}], cta: { show: true } }],
    });
    const view = await open();

    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('It was fine'));

    // The queue empties by itself: the same component, the same heading and rows.
    await waitFor(() => expect(view.getByText('1 title ranked')).toBeTruthy());
    expect(view.getByTestId('ranked-summary-scroll')).toBeTruthy();
    expect(view.getByText('#4 in Movies')).toBeTruthy();
    /**
     * **No helper sentence** (founder, 2026-09-25). "You're caught up." restated what the
     * heading and the rows already said. That there is nothing left is expressed by the
     * action that is absent, not by a line of prose.
     */
    expect(view.queryByText('You’re caught up.')).toBeNull();
    expect(view.queryByRole('button', { name: 'Keep ranking' })).toBeNull();
    expect(view.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('the rows scroll, so a long sitting cannot bury the actions', async () => {
    serve({
      ranking_backlog: [queue([UNTOUCHED], { checkpoint_every: 99 }), queue([])],
      rank_backlog_start: [placed],
    });
    const view = await open();

    await waitFor(() => expect(view.getByText('How was it?')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('It was fine'));

    await waitFor(() => expect(view.getByTestId('ranked-summary-scroll')).toBeTruthy());
    // The actions are siblings of the scroll view rather than children of it.
    expect(view.getByTestId('ranked-summary-scroll')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(view.getAllByTestId('ranked-summary-row')).toHaveLength(1);
  });
});
