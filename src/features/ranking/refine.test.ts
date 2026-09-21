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
  refinePlacementLine,
  ROUND_ANSWERS,
  ROUND_TARGETS,
  type RefinedTitle,
} from './refine';
import { isQuiet, REFINE_QUIET_DAYS } from './use-refine';

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
      reasonLine(
        {
          reason: 'placed_long_ago',
          lastConfirmedAt: '2025-03-04T00:00:00Z',
          confirmedSize: null,
        },
        'movies',
      ),
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
    expect(lines[1]).toBe('Last placed Mar 2025');
    for (const line of lines) expect(line).not.toMatch(/%|confiden|accura/i);
  });
});

describe('the entry rests after a sitting', () => {
  it(`is quiet for ${REFINE_QUIET_DAYS} days`, () => {
    const now = Date.parse('2026-09-20T12:00:00Z');
    expect(isQuiet(null, now)).toBe(false);
    expect(isQuiet('2026-09-19T12:00:00Z', now)).toBe(true);
    expect(isQuiet('2026-09-12T11:00:00Z', now)).toBe(false);
    expect(isQuiet('garbage', now)).toBe(false);
  });
});

describe('refinePlacementLine (Watch History)', () => {
  it('says what the refine did, never "Still" for a move', () => {
    expect(refinePlacementLine({ outcome: 'unchanged', position: 21, fromPosition: 21 })).toBe(
      'Refined · Still #21',
    );
    expect(refinePlacementLine({ outcome: 'moved', position: 15, fromPosition: 21 })).toBe(
      'Refined · Moved from #21 → #15',
    );
    expect(refinePlacementLine({ outcome: 'kept', position: 57, fromPosition: 57 })).toBe(
      'Refined · Kept at #57',
    );
  });

  it('is labelled as a refine, not as a watch', () => {
    const line = refinePlacementLine({ outcome: 'moved', position: 3, fromPosition: 9 });
    expect(line.startsWith('Refined · ')).toBe(true);
    expect(line).not.toMatch(/watch/i);
  });
});
