import {
  atCheckpoint,
  MAX_ROUNDS,
  markShown,
  mayContinue,
  newSitting,
  nextRound,
  parseCandidates,
  reasonLine,
  recordFinished,
  ROUND_ANSWERS,
  ROUND_TARGETS,
  type RefinedTitle,
} from './refine';
import { isSnoozed } from './use-refine';
import { atBacklogCheckpoint, backlogProgress, parseBacklog } from './backlog';

jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn() } }));

const titled = (
  id: string,
  answers = 2,
  outcome: 'moved' | 'unchanged' | 'kept' = 'unchanged',
) =>
  ({
    mediaItemId: id,
    title: id,
    position: 10,
    movement: { outcome, fromPosition: outcome === 'moved' ? 14 : 10 },
    answers,
  }) satisfies RefinedTitle;

describe('a sitting is finite', () => {
  it('checkpoints after five titles', () => {
    let s = newSitting();
    for (let i = 0; i < ROUND_TARGETS - 1; i += 1) s = recordFinished(s, titled(`t${i}`));
    expect(atCheckpoint(s)).toBe(false);
    s = recordFinished(s, titled('t4'));
    expect(atCheckpoint(s)).toBe(true);
  });

  it('checkpoints after twelve answers, checked when a title finishes', () => {
    let s = newSitting();
    s = recordFinished(s, titled('a', 7, 'moved'));
    expect(atCheckpoint(s)).toBe(false);
    s = recordFinished(s, titled('b', ROUND_ANSWERS - 7));
    expect(atCheckpoint(s)).toBe(true);
    expect(s.totals).toEqual({ targets: 2, moved: 1, answers: ROUND_ANSWERS });
  });

  it('offers more for three rounds, then Done only', () => {
    let s = newSitting();
    for (let round = 1; round < MAX_ROUNDS; round += 1) {
      expect(mayContinue(s)).toBe(true);
      s = nextRound(s);
    }
    expect(s.round).toBe(MAX_ROUNDS);
    expect(mayContinue(s)).toBe(false);
  });

  it('a new round clears the checkpoint but remembers every title shown', () => {
    let s = newSitting();
    s = recordFinished(s, titled('a'));
    s = markShown(s, 'skipped-by-undo');
    s = nextRound(s);
    expect(s.finished).toEqual([]);
    expect(s.answers).toBe(0);
    expect(s.shown).toEqual(['a', 'skipped-by-undo']);
    expect(s.totals.targets).toBe(1);
  });

  it('never lists a title twice in `shown`', () => {
    const s = markShown(markShown(newSitting(), 'x'), 'x');
    expect(s.shown).toEqual(['x']);
  });
});

describe('parseCandidates', () => {
  it('reads the server shape', () => {
    const parsed = parseCandidates({
      status: 'ready',
      candidates: [
        {
          media_item_id: 'm1',
          title: 'Heat',
          poster_path: '/p.jpg',
          kind: 'movie',
          position: 18,
          resume: false,
          reason: 'grown',
          last_confirmed_at: '2025-03-01T00:00:00Z',
          confirmed_size: 34,
        },
      ],
    });
    expect(parsed.status).toBe('ready');
    expect(parsed.targets[0]).toMatchObject({
      mediaItemId: 'm1',
      position: 18,
      reason: 'grown',
      confirmedSize: 34,
    });
  });

  it('reads anything unknown as disabled, and an empty ready as nothing waiting', () => {
    expect(parseCandidates(null).status).toBe('disabled');
    expect(parseCandidates({ status: 'from-the-future' }).status).toBe('disabled');
    expect(parseCandidates({ status: 'ready', candidates: [] }).status).toBe('nothing_waiting');
  });

  it('coerces an unknown reason to the neutral one rather than dropping the title', () => {
    const parsed = parseCandidates({
      status: 'ready',
      candidates: [{ media_item_id: 'm', title: 'T', position: 3, reason: 'new-word' }],
    });
    expect(parsed.targets[0]?.reason).toBe('neighbours');
  });
});

describe('reasonLine', () => {
  it('says what the evidence is, never a confidence number', () => {
    const lines = [
      reasonLine({ reason: 'grown', lastConfirmedAt: null, confirmedSize: 34 }, 'movies'),
      reasonLine({ reason: 'crossed', lastConfirmedAt: null, confirmedSize: null }, 'movies'),
      reasonLine(
        { reason: 'never_compared', lastConfirmedAt: null, confirmedSize: null },
        'tv_seasons',
      ),
      reasonLine(
        { reason: 'contradicted', lastConfirmedAt: null, confirmedSize: null },
        'movies',
      ),
    ];
    expect(lines[0]).toBe('Last placed when you had 34 movies');
    expect(lines[1]).toBe('Titles near it have moved past it since');
    for (const line of lines) expect(line).not.toMatch(/%|confiden|accura/i);
  });
});

describe('age is never a reason (founder, 2026-09-21)', () => {
  it('an old placed_long_ago from a stale backend reads as the neutral reason', () => {
    const parsed = parseCandidates({
      status: 'ready',
      candidates: [{ media_item_id: 'm', title: 'T', position: 3, reason: 'placed_long_ago' }],
    });
    expect(parsed.targets[0]?.reason).toBe('neighbours');
  });
});

describe('the card block and the placement total', () => {
  it('reads the server answer, and why the batch qualified', () => {
    const parsed = parseCandidates({
      status: 'ready',
      candidates: [
        {
          media_item_id: 'm1',
          title: 'Heat',
          position: 4,
          reason: 'crossed',
          signals: { gap: false, contradicted: false, crossed: true, strong: true },
        },
      ],
      placements_total: 41,
      cta: { show: true, count: 4, qualifying: 9, strong: 4, resurface_after: 3 },
    });
    expect(parsed.cta).toEqual({
      show: true,
      count: 4,
      qualifying: 9,
      strong: 4,
      resurfaceAfter: 3,
    });
    expect(parsed.placementsTotal).toBe(41);
    expect(parsed.targets[0]?.signals).toEqual({
      gap: false,
      contradicted: false,
      crossed: true,
      strong: true,
    });
  });

  it('never invites onto an empty or refused sitting', () => {
    expect(parseCandidates({ status: 'rested', cta: { show: true } }).cta.show).toBe(false);
    expect(parseCandidates({ status: 'ready', candidates: [], cta: { show: true } }).cta.show).toBe(
      false,
    );
    expect(parseCandidates(null).cta.show).toBe(false);
  });
});

describe('Not now is lifted by activity, never by time', () => {
  const pref = { dismissedAt: '2020-01-01T00:00:00Z', placementsAtDismissal: 40 };

  it('holds until enough new placements, however long ago it was', () => {
    expect(isSnoozed(pref, 40, 3)).toBe(true);
    expect(isSnoozed(pref, 42, 3)).toBe(true);
    expect(isSnoozed(pref, 43, 3)).toBe(false);
  });

  it('with no Not now stored, nothing is snoozed', () => {
    expect(isSnoozed(null, 0, 3)).toBe(false);
  });
});

describe('the backlog', () => {
  it('reads the server shape; a stored bucket skips How was it?', () => {
    const b = parseBacklog({
      status: 'ready',
      total: 18,
      remaining: 17,
      checkpoint_every: 10,
      targets: [
        { media_item_id: 'a', title: 'A', kind: 'movie', bucket: 'not_for_me', resume: true },
        { media_item_id: 'b', title: 'B', kind: 'season', bucket: null, resume: false },
      ],
    });
    expect(b).toMatchObject({ status: 'ready', total: 18, remaining: 17, checkpointEvery: 10 });
    expect(b.targets[0]).toMatchObject({ bucket: 'notForMe', resume: true, kind: 'movie' });
    expect(b.targets[1]).toMatchObject({ bucket: null, kind: 'season' });
  });

  it('reads anything unknown as disabled, and an empty ready as empty', () => {
    expect(parseBacklog(null).status).toBe('disabled');
    expect(parseBacklog({ status: 'ready', targets: [] }).status).toBe('empty');
  });

  it('checkpoints softly every ten placed, and counts toward a fixed total', () => {
    expect([1, 9, 10, 11, 20].map((n) => atBacklogCheckpoint(n, 10))).toEqual([
      false,
      false,
      true,
      false,
      true,
    ]);
    expect(atBacklogCheckpoint(0, 10)).toBe(false);
    expect(backlogProgress(7, 18)).toBe('7 of 18 ranked');
  });
});
