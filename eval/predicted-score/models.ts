/**
 * The five candidate models of the feasibility study, all stated in the same space.
 *
 * **A prediction is a bucket distribution plus a within-band insertion quantile q.** It is
 * never a score. The score is projected from the point prediction once, at the end, through
 * the app's own band ranges (`geometry.projectScore`), and it is only ever read for display
 * and for the display-unit metrics.
 *
 * The point prediction is the **median bucket**, the band where the cumulative probability
 * from the top first reaches one half, together with that band's q. The buckets are ordered,
 * so the median is the honest centre. A mean across buckets is not: halfway between a 9.0
 * and a 2.0 is a "fine" 5.5 that no evidence proposed.
 *
 *   M0  the reader's own bucket shares, q = 0.5. The baseline, never shown.
 *   M1  public raters of the title, carried into the reader's geometry, over the M0 prior.
 *   M2  viewable raters weighted by Taste Match with the reader, over the M0 prior.
 *   M3  the reader's own titles most like this one, over the M0 prior.
 *   M4  M1, M2 and M3 pooled by evidence weight, over the M0 prior.
 */

import type { BandSizes, Bucket } from '@/features/collection/score';

import type { ModelConfig } from './config';
import {
  communitySamples,
  contentSamples,
  neighbourSamples,
  type EvidenceCache,
  type Sample,
} from './evidence';
import { BUCKET_ORDER, displayScore, overallOf, projectScore, totalOf } from './geometry';
import type { Task } from './tasks';

export const MODELS = ['M0', 'M1', 'M2', 'M3', 'M4'] as const;
export type ModelName = (typeof MODELS)[number];

export const MODEL_LABEL: Record<ModelName, string> = {
  M0: 'M0 user prior (baseline)',
  M1: 'M1 community, adjusted to you',
  M2: 'M2 Taste-Match neighbours',
  M3: 'M3 your own similar titles',
  M4: 'M4 hybrid',
};

export type Evidence = {
  /** Public raters of the target (M1's support). */
  communityRaters: number;
  /** Viewable raters with a Taste Match above the stranger baseline (M2's support). */
  neighbours: number;
  /** The reader's own titles above the similarity threshold (M3's support). */
  contentNeighbours: number;
};

export type Prediction = {
  probs: Record<Bucket, number>;
  qByBucket: Record<Bucket, number>;
  bucket: Bucket;
  q: number;
  /** Continuous, display units. Projected from bucket and q, never predicted directly. */
  score: number;
  /** One decimal. For display, and for the rounded MAE reported beside the real one. */
  display: number;
  /** The same point, as an overall insertion quantile of the reader's list. */
  overall: number;
  maxProb: number;
  /** Total non-prior evidence weight. */
  weight: number;
  evidence: Evidence;
  /** M4 only: the scores of the components that had enough evidence of their own. */
  components: number[];
};

/**
 * Pool evidence over the reader's own bucket shares.
 *
 *   P(b) = (Σ w over samples in b + k·share_b) / (Σ w + k)
 *   q_b  = (Σ w·q over samples in b + k0·½) / (Σ w in b + k0)
 *
 * With no samples this is exactly M0. Returns null when the reader has no list to have
 * shares of, which the abstention rule reports as `user_history`.
 */
export function aggregate(
  samples: readonly Sample[],
  sizes: BandSizes,
  config: Pick<ModelConfig, 'priorStrength' | 'qPriorStrength'>,
  evidence: Evidence,
): Prediction | null {
  const total = totalOf(sizes);
  if (total === 0) return null;
  const mass: Record<Bucket, number> = { loved: 0, fine: 0, not_for_me: 0 };
  const qMass: Record<Bucket, number> = { loved: 0, fine: 0, not_for_me: 0 };
  let weight = 0;
  for (const s of samples) {
    if (!(s.w > 0)) continue;
    mass[s.bucket] += s.w;
    qMass[s.bucket] += s.w * s.q;
    weight += s.w;
  }
  const k = config.priorStrength;
  const denominator = weight + k;
  const probs = {} as Record<Bucket, number>;
  const qByBucket = {} as Record<Bucket, number>;
  for (const b of BUCKET_ORDER) {
    probs[b] = (mass[b] + k * (sizes[b] / total)) / denominator;
    qByBucket[b] = (qMass[b] + config.qPriorStrength * 0.5) / (mass[b] + config.qPriorStrength);
  }

  let cumulative = 0;
  let bucket: Bucket = 'not_for_me';
  for (const b of BUCKET_ORDER) {
    cumulative += probs[b];
    if (cumulative >= 0.5 - 1e-12) {
      bucket = b;
      break;
    }
  }
  const q = qByBucket[bucket];
  return {
    probs,
    qByBucket,
    bucket,
    q,
    score: projectScore(bucket, q),
    display: displayScore(bucket, q),
    overall: overallOf(bucket, q, sizes),
    maxProb: Math.max(probs.loved, probs.fine, probs.not_for_me),
    weight,
    evidence,
    components: [],
  };
}

/** Everything a task's models read, computed once per task and configuration. */
export type TaskEvidence = {
  community: Sample[];
  neighbours: Sample[];
  content: Sample[];
  evidence: Evidence;
};

export function gatherEvidence(
  cache: EvidenceCache,
  task: Task,
  config: ModelConfig,
): TaskEvidence {
  const community = communitySamples(cache, task, config);
  const neighbours = neighbourSamples(cache, task, config);
  const content = contentSamples(cache, task, config);
  return {
    community,
    neighbours,
    content: content.samples,
    evidence: {
      communityRaters: community.length,
      neighbours: neighbours.length,
      contentNeighbours: content.neighbours,
    },
  };
}

const scaled = (samples: readonly Sample[], factor: number): Sample[] =>
  samples.map((s) => ({ ...s, w: s.w * factor }));

/** The minimum evidence each family needs before it may speak on its own. */
export type EvidenceMinimums = {
  minCommunityRaters: number;
  minNeighbours: number;
  minContentNeighbours: number;
};

export function predict(
  model: ModelName,
  task: Task,
  ev: TaskEvidence,
  config: ModelConfig,
  minimums: EvidenceMinimums,
): Prediction | null {
  const sizes = task.train.sizes;
  switch (model) {
    case 'M0':
      return aggregate([], sizes, { priorStrength: 1, qPriorStrength: 1 }, ev.evidence);
    case 'M1':
      return aggregate(ev.community, sizes, config, ev.evidence);
    case 'M2':
      return aggregate(ev.neighbours, sizes, config, ev.evidence);
    case 'M3':
      return aggregate(ev.content, sizes, config, ev.evidence);
    case 'M4': {
      const pooled = [
        ...scaled(ev.community, config.hybrid.community),
        ...scaled(ev.neighbours, config.hybrid.neighbours),
        ...scaled(ev.content, config.hybrid.content),
      ];
      const prediction = aggregate(pooled, sizes, config, ev.evidence);
      if (!prediction) return null;
      const components: number[] = [];
      const e = ev.evidence;
      if (e.communityRaters >= minimums.minCommunityRaters) {
        const p = aggregate(ev.community, sizes, config, e);
        if (p) components.push(p.score);
      }
      if (e.neighbours >= minimums.minNeighbours) {
        const p = aggregate(ev.neighbours, sizes, config, e);
        if (p) components.push(p.score);
      }
      if (e.contentNeighbours >= minimums.minContentNeighbours) {
        const p = aggregate(ev.content, sizes, config, e);
        if (p) components.push(p.score);
      }
      return { ...prediction, components };
    }
  }
}

/** Whether the model's own evidence family clears its minimum. M0 has none, by definition. */
export function hasEvidence(
  model: ModelName,
  e: Evidence,
  minimums: EvidenceMinimums,
): boolean {
  const community = e.communityRaters >= minimums.minCommunityRaters;
  const neighbours = e.neighbours >= minimums.minNeighbours;
  const content = e.contentNeighbours >= minimums.minContentNeighbours;
  switch (model) {
    case 'M0':
      return false;
    case 'M1':
      return community;
    case 'M2':
      return neighbours;
    case 'M3':
      return content;
    case 'M4':
      return community || neighbours || content;
  }
}
