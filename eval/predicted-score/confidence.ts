/**
 * The abstention rule: when a prediction may be shown, and when it must say "no reliable
 * prediction yet".
 *
 * A confident wrong number is worse than no number. So a prediction is shown only when all of
 * these hold, and otherwise it abstains with the first reason that failed:
 *
 *   user_history   the reader has enough of a list, and enough of it outside the top band,
 *                  for their own geometry to mean something;
 *   title_support  the model's own evidence family clears its minimum (M0 never does);
 *   disagreement   M4's components, where more than one can speak, roughly agree;
 *   uncertain      the most likely bucket is likely enough, and the 80% interval is narrow.
 *
 * **The interval is cross-conformal by user, and Mondrian by confidence.** Users are split
 * into two halves by a seeded hash. A prediction for someone in one half gets an interval from
 * the absolute errors observed in the *other* half, in the same cell: the same confidence band
 * and evidence tier, falling back to the band alone and then to the whole half when a cell
 * holds fewer than `MIN_CALIBRATION`. No person's own errors ever size their own interval, and
 * nothing is fitted to the rows being judged.
 */

import {
  CONFIDENCE_BAND_EDGES,
  EVIDENCE_TIER_EDGES,
  INTERVAL_LEVEL,
  MIN_CALIBRATION,
  SEEDS,
  type Abstention,
} from './config';
import { hasEvidence, type ModelName, type Prediction } from './models';
import { unitHash } from './random';
import type { Task } from './tasks';

export type AbstainReason = 'user_history' | 'title_support' | 'disagreement' | 'uncertain';

export const ABSTAIN_REASONS: readonly AbstainReason[] = [
  'user_history',
  'title_support',
  'disagreement',
  'uncertain',
];

/** One model's prediction for one task, with everything the gates and metrics need. */
export type Scored = {
  task: Task;
  model: ModelName;
  prediction: Prediction | null;
  /** M0 on the same task: every improvement is measured against it on the same rows. */
  baseline: Prediction | null;
  /** Public raters of the target at the task's moment. A segment, not an input. */
  support: number;
};

export type Gated = Scored & {
  userGate: boolean;
  /** Passed the user and evidence gates: the population the interval applies to. */
  eligible: boolean;
  tier: number;
  interval: readonly [number, number] | null;
  width: number;
  shown: boolean;
  reason: AbstainReason | null;
};

export const tierOf = (weight: number): number => {
  let tier = 0;
  for (const edge of EVIDENCE_TIER_EDGES) if (weight >= edge) tier += 1;
  return tier;
};

/** Which confidence band a most-likely-bucket probability falls in, by `CONFIDENCE_BAND_EDGES`. */
export const confidenceBandOf = (maxProb: number): number => {
  let band = 0;
  for (const edge of CONFIDENCE_BAND_EDGES) if (maxProb >= edge) band += 1;
  return band;
};

export const calibrationHalf = (u: string): 0 | 1 =>
  unitHash(`${SEEDS.calibrationFold}|${u}`) < 0.5 ? 0 : 1;

/**
 * The split-conformal quantile: the ⌈(n+1)·level⌉-th smallest residual. Infinite when there
 * are too few residuals to support the level, so the interval is honest about it.
 */
export function conformalQuantile(
  residuals: readonly number[],
  level = INTERVAL_LEVEL,
): number {
  const n = residuals.length;
  if (n === 0) return Infinity;
  const index = Math.ceil((n + 1) * level) - 1;
  if (index >= n) return Infinity;
  return [...residuals].sort((a, b) => a - b)[index]!;
}

export function userGate(task: Task, rule: Abstention): boolean {
  const sizes = task.train.sizes;
  return (
    task.train.total >= rule.minTrain && sizes.fine + sizes.not_for_me >= rule.minOutsideLoved
  );
}

/**
 * Gate a set of predictions from one model, one mode and one category.
 *
 * Callers pass exactly that slice: residuals must come from the same model, the same mode
 * and the same category as the prediction they size, or the interval borrows another
 * question's errors.
 */
export function gate(slice: readonly Scored[], rule: Abstention): Gated[] {
  const staged = slice.map((s) => {
    const p = s.prediction;
    const passesUser = p !== null && userGate(s.task, rule);
    const passesEvidence = passesUser && p !== null && hasEvidence(s.model, p.evidence, rule);
    return {
      scored: s,
      userGate: passesUser,
      eligible: passesEvidence,
      tier: p ? tierOf(p.weight) : 0,
      band: p ? confidenceBandOf(p.maxProb) : 0,
      residual: p ? Math.abs(p.score - s.task.truth.score) : Infinity,
      half: calibrationHalf(s.task.u),
    };
  });

  // Mondrian cells: confidence band × evidence tier, then confidence band alone, then the
  // whole half. A prediction that is 95% sure of its bucket must not borrow the spread of one
  // that is 50% sure, or the interval says nothing about the prediction it is attached to.
  const cellsOf = (x: (typeof staged)[number]) => [
    `${x.half}|${x.band}|${x.tier}`,
    `${x.half}|${x.band}|all`,
    `${x.half}|all`,
  ];
  const pools = new Map<string, number[]>();
  for (const x of staged) {
    if (!x.eligible) continue;
    for (const key of cellsOf(x)) {
      const list = pools.get(key) ?? [];
      list.push(x.residual);
      pools.set(key, list);
    }
  }

  return staged.map((x): Gated => {
    const p = x.scored.prediction;
    const base = { ...x.scored, userGate: x.userGate, eligible: x.eligible, tier: x.tier };
    if (!p || !x.userGate) {
      return { ...base, interval: null, width: Infinity, shown: false, reason: 'user_history' };
    }
    const other = x.half === 0 ? 1 : 0;
    const pool =
      cellsOf({ ...x, half: other })
        .map((key) => pools.get(key) ?? [])
        .find((list) => list.length >= MIN_CALIBRATION) ?? [];
    const half = pool.length >= MIN_CALIBRATION ? conformalQuantile(pool) : Infinity;
    const interval = [Math.max(0, p.score - half), Math.min(10, p.score + half)] as const;
    const width = interval[1] - interval[0];

    let reason: AbstainReason | null = null;
    if (!x.eligible) reason = 'title_support';
    else if (
      x.scored.model === 'M4' &&
      p.components.length >= 2 &&
      Math.max(...p.components) - Math.min(...p.components) > rule.maxDisagreement
    ) {
      reason = 'disagreement';
    } else if (p.maxProb < rule.minProb || width > rule.maxWidth) reason = 'uncertain';

    return { ...base, interval, width, shown: reason === null, reason };
  });
}
