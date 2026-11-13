import { ENGINES, type EngineWeights } from '../rank';

import type { Variant } from './pipeline';

/**
 * The evaluation's configuration, versioned so a result can be traced to exactly what ran.
 *
 * Bump `EVAL_CONFIG_VERSION` whenever a variant, a metric or a default here changes. The world
 * has its own version (`WORLD_VERSION`); a report names both, plus the seed.
 */
export const EVAL_CONFIG_VERSION = 'rec-eval-config-2026-11-13.1';

const base = {
  languageAnchors: true,
  catalogue: true,
  collaborativeSource: false,
  collaborativeTerm: false,
  negativeEvidence: true,
} as const;

/** Scale every weight but one so the set still sums to one. */
export function withWeight(
  weights: EngineWeights,
  key: keyof EngineWeights,
  value: number,
): EngineWeights {
  const rest = 1 - weights[key];
  const scale = rest > 0 ? (1 - value) / rest : 0;
  const out = { ...weights };
  for (const k of Object.keys(out) as (keyof EngineWeights)[]) {
    out[k] = k === key ? value : weights[k] * scale;
  }
  return out;
}

const metadata = ENGINES.v2_metadata.weights;
const hybrid = ENGINES.v2_hybrid.weights;

export const ENGINE_VARIANTS: Variant[] = [
  {
    id: 'v1',
    label: 'V1 (shipping)',
    group: 'engine',
    engine: 'v1',
    languageAnchors: false,
    catalogue: false,
    collaborativeSource: false,
    collaborativeTerm: false,
    negativeEvidence: true,
  },
  {
    id: 'v2_metadata',
    label: 'V2 metadata (A1)',
    group: 'engine',
    engine: 'v2',
    weights: metadata,
    ...base,
  },
  {
    id: 'v2_hybrid',
    label: 'V2 hybrid (A2)',
    group: 'engine',
    engine: 'v2',
    weights: hybrid,
    ...base,
    collaborativeSource: true,
    collaborativeTerm: true,
  },
];

export const ABLATIONS: Variant[] = [
  {
    id: 'v2m-no-language-anchors',
    label: 'V2 metadata − language anchors',
    group: 'ablation',
    engine: 'v2',
    weights: metadata,
    ...base,
    languageAnchors: false,
  },
  {
    id: 'v2m-no-catalogue',
    label: 'V2 metadata − catalogue fill',
    group: 'ablation',
    engine: 'v2',
    weights: metadata,
    ...base,
    catalogue: false,
  },
  {
    id: 'v2m-no-era',
    label: 'V2 metadata − era term',
    group: 'ablation',
    engine: 'v2',
    weights: withWeight(metadata, 'era', 0),
    ...base,
  },
  {
    id: 'v2m-no-negatives',
    label: 'V2 metadata − negative evidence',
    group: 'ablation',
    engine: 'v2',
    weights: metadata,
    ...base,
    negativeEvidence: false,
  },
  {
    id: 'v2h-source-only',
    label: 'V2 hybrid, collaborative source only (no term)',
    group: 'ablation',
    engine: 'v2',
    weights: withWeight(hybrid, 'collaborative', 0),
    ...base,
    collaborativeSource: true,
  },
  {
    id: 'v2h-term-only',
    label: 'V2 hybrid, collaborative term only (no source)',
    group: 'ablation',
    engine: 'v2',
    weights: hybrid,
    ...base,
    collaborativeTerm: true,
  },
];

export const SWEEPS: Variant[] = [
  ...[0.05, 0.1, 0.25, 0.35].map((value): Variant => ({
    id: `v2h-collab-${value}`,
    label: `V2 hybrid, collaborative weight ${value}`,
    group: 'sweep',
    engine: 'v2',
    weights: withWeight(hybrid, 'collaborative', value),
    ...base,
    collaborativeSource: true,
    collaborativeTerm: true,
  })),
  ...[0.05, 0.2].map((value): Variant => ({
    id: `v2m-language-${value}`,
    label: `V2 metadata, language weight ${value}`,
    group: 'sweep',
    engine: 'v2',
    weights: withWeight(metadata, 'language', value),
    ...base,
  })),
  ...[0.14].map((value): Variant => ({
    id: `v2m-era-${value}`,
    label: `V2 metadata, era weight ${value}`,
    group: 'sweep',
    engine: 'v2',
    weights: withWeight(metadata, 'era', value),
    ...base,
  })),
];

/**
 * Diagnostics (reconcile, 2026-11-13). **Not shipped configurations**: each moves one thing to
 * attribute a regression the 2026-11-11 run reported.
 *
 * - `v1-no-social` / `v2m-plus-social`: V2 removes the follow-graph source by design (following
 *   alone is not evidence about taste). If V1 without it falls to V2's pool recall, and V2 with
 *   it climbs to V1's, the pool-recall gap is that decision, not a defect.
 * - `v2m-no-catalogue-no-social`: V2's sources reduced to V1's minus social (anchors, trending).
 * - `v2m-pre-ws5`: V2 metadata with the pre-reconcile profile (whole-show rankings ignored). The
 *   same as V2 metadata on the film wall; the reference for the TV whole-show slice.
 */
export const DIAGNOSTICS: Variant[] = [
  {
    ...ENGINE_VARIANTS[0]!,
    id: 'v1-no-social',
    label: 'V1 − social source',
    group: 'diagnostic',
    social: false,
  },
  {
    id: 'v2m-plus-social',
    label: 'V2 metadata + social source',
    group: 'diagnostic',
    engine: 'v2',
    weights: metadata,
    ...base,
    social: true,
  },
  {
    id: 'v2m-no-catalogue-no-social',
    label: 'V2 metadata − catalogue (V1 sources − social)',
    group: 'diagnostic',
    engine: 'v2',
    weights: metadata,
    ...base,
    catalogue: false,
  },
];

/** The TV whole-show evaluation: the engines plus the pre-reconcile profile as reference. */
export const TV_VARIANTS: Variant[] = [
  ...ENGINE_VARIANTS,
  {
    id: 'v2m-pre-ws5',
    label: 'V2 metadata, pre-reconcile profile (shows ignored)',
    group: 'diagnostic',
    engine: 'v2',
    weights: metadata,
    ...base,
    showsInProfile: false,
  },
];

export const ALL_VARIANTS: Variant[] = [
  ...ENGINE_VARIANTS,
  ...ABLATIONS,
  ...SWEEPS,
  ...DIAGNOSTICS,
];

/** Seeds averaged per reader: anchor rotation and the draw both vary across launches. */
export const LAUNCH_SEEDS = [11, 23, 37] as const;
