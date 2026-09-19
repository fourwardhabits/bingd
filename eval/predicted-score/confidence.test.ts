import { ABSTENTION, MIN_CALIBRATION } from './config';
import { calibrationHalf, conformalQuantile, gate, userGate, type Scored } from './confidence';
import { listOf, rank } from './fixtures';
import { insertionTruth, libraryView } from './geometry';
import type { ModelName, Prediction } from './models';
import type { Task } from './tasks';

/** A task whose training list is exactly `total` titles, `outside` of them below the top band. */
function taskWith(total: number, outside: number, u = 'reader'): Task {
  const train = libraryView(
    listOf(u, 'L'.repeat(total - outside) + 'F'.repeat(outside), 'a', 1),
  );
  const target = { ...rank(u, 'target', 'loved', 1, 0), p: 0.5 };
  return {
    mode: 'P2',
    u,
    c: 'movies',
    target,
    train,
    otherCategory: [],
    asOf: null,
    hidden: new Set(['target']),
    group: `${u}|g`,
    fold: 0,
    truth: insertionTruth(target, train),
    flags: {
      replacedHint: false,
      asOfMayMissRows: false,
      noPlacementEvidence: false,
      firstInBand: false,
    },
  };
}

const prediction = (over: Partial<Prediction> = {}): Prediction => ({
  probs: { loved: 0.8, fine: 0.15, not_for_me: 0.05 },
  qByBucket: { loved: 0.5, fine: 0.5, not_for_me: 0.5 },
  bucket: 'loved',
  q: 0.5,
  score: 8.5,
  display: 8.5,
  overall: 0.3,
  maxProb: 0.8,
  weight: 4,
  evidence: { communityRaters: 3, neighbours: 3, contentNeighbours: 5 },
  components: [],
  ...over,
});

const scored = (
  task: Task,
  over: Partial<Prediction> = {},
  model: ModelName = 'M4',
): Scored => ({
  task,
  model,
  prediction: prediction(over),
  baseline: prediction(),
  support: 3,
});

/** The reader under test, and people guaranteed to be in the other calibration half. */
const READER = 'reader';
const otherHalfUsers = (count: number, sameHalf = false): string[] => {
  const out: string[] = [];
  for (let i = 0; out.length < count; i += 1) {
    const u = `cal${i}`;
    if ((calibrationHalf(u) === calibrationHalf(READER)) === sameHalf) out.push(u);
  }
  return out;
};

/**
 * Calibration rows with a known residual. Truth is pinned at 5 and the prediction at
 * 5 + residual, both exactly representable, so every interval is known to the last bit.
 */
function calibration(
  residual: number,
  options: { sameHalf?: boolean; over?: Partial<Prediction> } = {},
): Scored[] {
  return otherHalfUsers(MIN_CALIBRATION + 5, options.sameHalf).map((u) => {
    const task = taskWith(20, 3, u);
    return scored(
      { ...task, truth: { ...task.truth, score: 5 } },
      { ...options.over, score: 5 + residual },
    );
  });
}

const last = <T>(xs: readonly T[]): T => xs[xs.length - 1]!;

describe('the user gate', () => {
  it('passes at exactly the minimum list and the minimum outside the top band', () => {
    expect(
      userGate(taskWith(ABSTENTION.minTrain, ABSTENTION.minOutsideLoved), ABSTENTION),
    ).toBe(true);
  });

  it('fails one title short of either', () => {
    expect(
      userGate(taskWith(ABSTENTION.minTrain - 1, ABSTENTION.minOutsideLoved), ABSTENTION),
    ).toBe(false);
    expect(
      userGate(taskWith(ABSTENTION.minTrain, ABSTENTION.minOutsideLoved - 1), ABSTENTION),
    ).toBe(false);
  });
});

describe('abstention boundaries', () => {
  const reader = taskWith(20, 3, READER);

  it('shows a prediction that clears every gate', () => {
    const g = last(gate([...calibration(0.5), scored(reader)], ABSTENTION));
    expect(g.reason).toBeNull();
    expect(g.shown).toBe(true);
    expect(g.width).toBe(1);
  });

  it('abstains user_history first, whatever else is true', () => {
    const g = last(
      gate(
        [...calibration(0.5), scored(taskWith(ABSTENTION.minTrain - 1, 3, READER))],
        ABSTENTION,
      ),
    );
    expect(g.reason).toBe('user_history');
  });

  it('abstains title_support one rater, neighbour or similar title short', () => {
    const short = {
      communityRaters: ABSTENTION.minCommunityRaters - 1,
      neighbours: ABSTENTION.minNeighbours - 1,
      contentNeighbours: ABSTENTION.minContentNeighbours - 1,
    };
    expect(
      last(gate([...calibration(0.5), scored(reader, { evidence: short })], ABSTENTION)).reason,
    ).toBe('title_support');
    for (const [model, key, min] of [
      ['M1', 'communityRaters', ABSTENTION.minCommunityRaters],
      ['M2', 'neighbours', ABSTENTION.minNeighbours],
      ['M3', 'contentNeighbours', ABSTENTION.minContentNeighbours],
    ] as const) {
      const cal = calibration(0.5).map((s) => ({ ...s, model }));
      const at = last(
        gate(
          [...cal, scored(reader, { evidence: { ...short, [key]: min } }, model)],
          ABSTENTION,
        ),
      );
      expect(at.reason).toBeNull();
      const under = last(
        gate([...cal, scored(reader, { evidence: short }, model)], ABSTENTION),
      );
      expect(under.reason).toBe('title_support');
    }
  });

  it('M0 never clears the evidence gate, by definition', () => {
    expect(last(gate([scored(reader, {}, 'M0')], ABSTENTION)).reason).toBe('title_support');
  });

  it('abstains uncertain just under the probability floor, and not at it', () => {
    const at = last(
      gate([...calibration(0.5), scored(reader, { maxProb: ABSTENTION.minProb })], ABSTENTION),
    );
    expect(at.reason).toBeNull();
    const under = last(
      gate(
        [...calibration(0.5), scored(reader, { maxProb: ABSTENTION.minProb - 0.001 })],
        ABSTENTION,
      ),
    );
    expect(under.reason).toBe('uncertain');
  });

  it('abstains uncertain when the interval is wider than allowed, and not when it is exactly that wide', () => {
    const exact = last(
      gate([...calibration(ABSTENTION.maxWidth / 2), scored(reader)], ABSTENTION),
    );
    expect(exact.width).toBe(ABSTENTION.maxWidth);
    expect(exact.reason).toBeNull();
    const wide = last(
      gate([...calibration(ABSTENTION.maxWidth / 2 + 0.125), scored(reader)], ABSTENTION),
    );
    expect(wide.reason).toBe('uncertain');
  });

  it('abstains uncertain with no calibration at all, rather than inventing an interval', () => {
    const g = last(gate([scored(reader)], ABSTENTION));
    expect(g.width).toBe(10);
    expect(g.reason).toBe('uncertain');
  });

  it('abstains disagreement when M4’s components are further apart than allowed', () => {
    const apart = last(
      gate(
        [
          ...calibration(0.5),
          scored(reader, { components: [9.5, 9.5 - ABSTENTION.maxDisagreement - 0.125] }),
        ],
        ABSTENTION,
      ),
    );
    expect(apart.reason).toBe('disagreement');
    const close = last(
      gate(
        [
          ...calibration(0.5),
          scored(reader, { components: [9.5, 9.5 - ABSTENTION.maxDisagreement] }),
        ],
        ABSTENTION,
      ),
    );
    expect(close.reason).toBeNull();
  });
});

describe('the cross-conformal interval', () => {
  it('uses the ⌈(n+1)·level⌉-th smallest residual, and is infinite when n cannot support it', () => {
    expect(conformalQuantile([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])).toBe(9);
    expect(conformalQuantile([1, 2, 3])).toBe(Infinity);
    expect(conformalQuantile([])).toBe(Infinity);
  });

  it('never sizes a person’s interval from their own half', () => {
    const reader = taskWith(20, 3, READER);
    // The reader's own half is full of enormous errors. The other half is exact to 0.25.
    const g = last(
      gate(
        [...calibration(4, { sameHalf: true }), ...calibration(0.25), scored(reader)],
        ABSTENTION,
      ),
    );
    expect(g.width).toBe(0.5);
  });

  it('prefers the reader’s own confidence band over the whole half', () => {
    const reader = taskWith(20, 3, READER);
    const confident = calibration(0.25, { over: { maxProb: 0.95 } });
    const unsure = calibration(3, { over: { maxProb: 0.55 } });
    const sure = last(
      gate([...confident, ...unsure, scored(reader, { maxProb: 0.95, score: 5 })], ABSTENTION),
    );
    expect(sure.width).toBe(0.5);
    const wobbly = last(
      gate([...confident, ...unsure, scored(reader, { maxProb: 0.55, score: 5 })], ABSTENTION),
    );
    expect(wobbly.width).toBe(6);
  });
});
