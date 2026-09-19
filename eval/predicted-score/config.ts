/**
 * Everything the predicted-score evaluation decides with, fixed before any real snapshot is
 * read.
 *
 * Source: the predicted-score feasibility study (2026-09-19) §6a and §10. These numbers are
 * **pre-registered**. They are not tuned against any evaluation set, and the report says so.
 * Changing one after a real run has been read is exactly the failure pre-registration exists
 * to prevent. So if a number here moves, the commit that moves it says why, and it says so
 * without reference to a result.
 *
 * The threshold sweep in the report *varies* the abstention thresholds to show how coverage
 * responds. It is descriptive. The verdict always uses `ABSTENTION` as written here.
 */

export type Transfer = 'bucket' | 'quantile';

/** How a model turns evidence into a prediction. One object per configuration. */
export type ModelConfig = {
  /**
   * How another person's opinion is carried into the reader's list.
   *
   * `bucket`: their bucket and within-band quantile, as they are.
   * `quantile`: their overall position quantile, placed at the same quantile of the reader's
   * current geometry. A generous rater's "liked it" then lands where the reader's own
   * equivalent sits, which is the "adjusted to you" in M1's name.
   */
  transfer: Transfer;
  /** Pseudo-count strength of the reader's own bucket shares (the M0 prior). */
  priorStrength: number;
  /** Pseudo-count pulling each bucket's q toward the band middle. */
  qPriorStrength: number;
  /** M3: minimum similarity for one of the reader's titles to count as a neighbour. */
  contentTau: number;
  /** M3: at most this many of the reader's own titles are used. */
  contentK: number;
  /** M3: weight of one of the reader's own Letterboxd stars, relative to a ranking. */
  ownStarWeight: number;
  /** M4: weights of the three evidence families when they are pooled. */
  hybrid: { community: number; neighbours: number; content: number };
};

export const PRIMARY_CONFIG: ModelConfig = {
  transfer: 'quantile',
  priorStrength: 1.5,
  qPriorStrength: 1,
  contentTau: 0.35,
  contentK: 10,
  ownStarWeight: 0.5,
  hybrid: { community: 0.5, neighbours: 1, content: 1 },
};

/**
 * The sensitivity grid, at most twelve configurations of M4, all of them reported.
 *
 * Robustness is judged on the grid as a whole: at least half of it must beat M0. The primary
 * configuration is inside the grid, so nobody can pick the best cell and call it the result.
 */
export const SENSITIVITY_GRID: readonly ModelConfig[] = (
  ['bucket', 'quantile'] as const
).flatMap((transfer) =>
  [0.75, 1.5, 3].flatMap((priorStrength) =>
    [0.25, 0.35].map((contentTau) => ({
      ...PRIMARY_CONFIG,
      transfer,
      priorStrength,
      contentTau,
    })),
  ),
);

/** M3's similarity weights. They sum to 1, so a similarity is on 0–1. */
export const CONTENT_WEIGHTS = {
  genres: 0.3,
  language: 0.1,
  year: 0.1,
  similarLink: 0.2,
  sibling: 0.3,
} as const;

/** Years at which the year term has decayed to 1/e. */
export const YEAR_SCALE = 8;

/** Taste Match, mirrored from `taste_match` (20260827001000) and `app_config`. */
export const TASTE_MATCH = {
  minCommon: 5,
  shrinkPrior: 5,
  /** The stranger baseline. A match at or below it carries no weight. */
  stranger: 50,
} as const;

/** The abstention rule (study §6a). Every threshold can be varied, and none is tuned. */
export type Abstention = {
  minTrain: number;
  minOutsideLoved: number;
  minCommunityRaters: number;
  minNeighbours: number;
  minContentNeighbours: number;
  minProb: number;
  /** Width of the 80% interval, in display points. */
  maxWidth: number;
  /** M4: component predictions further apart than this abstain as `disagreement`. */
  maxDisagreement: number;
};

export const ABSTENTION: Abstention = {
  minTrain: 20,
  minOutsideLoved: 3,
  minCommunityRaters: 3,
  minNeighbours: 3,
  minContentNeighbours: 5,
  minProb: 0.7,
  maxWidth: 2.5,
  maxDisagreement: 3,
};

/**
 * v1 would show predictions on Movies only, so only Movies decide the verdict. TV seasons are
 * evaluated under the same rule and reported for information.
 */
export const VERDICT_CATEGORY = 'movies' as const;

/** Nominal coverage of the prediction interval. */
export const INTERVAL_LEVEL = 0.8;

/**
 * Evidence tiers for the interval, by total evidence weight. Residuals are pooled inside a
 * tier because a prediction resting on twelve people should not borrow the spread of one
 * resting on nobody.
 */
export const EVIDENCE_TIER_EDGES = [1, 3, 6] as const;

/**
 * Confidence bands for the interval, by the most-likely-bucket probability. Crossed with the
 * evidence tiers to make the calibration cells. The same edges band the "does confidence mean
 * anything" table.
 */
export const CONFIDENCE_BAND_EDGES = [0.6, 0.7, 0.8, 0.9] as const;

/** Fewer residuals than this in a tier and the interval falls back to the whole fold. */
export const MIN_CALIBRATION = 20;

/** P2: folds per user and category, stratified by bucket. */
export const HOLDOUT_FOLDS = 5;

/** Libraries smaller than this are not split in P2. There is nothing to hold out from. */
export const MIN_LIBRARY_FOR_HOLDOUT = 6;

/**
 * P1: comparisons more than this long before a ranking's `created_at` mean the title was in
 * the list earlier, so its `created_at` was reset by a re-placement (or by an abandoned
 * attempt). The window is generous because a ranking session is server state that can be
 * resumed.
 */
export const SESSION_WINDOW_HOURS = 24;

export const BOOTSTRAP = { resamples: 1000, seed: 20260919 } as const;

/** Seeds for fold assignment. Changing one reshuffles every fold, so do not. */
export const SEEDS = {
  holdout: 'p2-holdout-v1',
  calibrationFold: 'conformal-fold-v1',
} as const;

/** Any report cell drawn from fewer people than this is suppressed. */
export const MIN_USERS_PER_CELL = 3;

/** Study §10. Every one of these must hold on P2 Movies for the primary M4. */
export const THRESHOLDS = {
  minEvaluableUsers: 15,
  minShown: 300,
  maxMae: 1.2,
  minRelativeImprovement: 0.2,
  minBucketAccuracy: 0.75,
  minBucketAccuracyGain: 0.1,
  maxSevereMissRate: 0.02,
  maxLargeErrorRate: 0.05,
  largeError: 3,
  minPairwiseAccuracy: 0.65,
  pairwiseMinGap: 1,
  minMedianSpearman: 0.35,
  intervalCoverage: [0.75, 0.85] as const,
  minUsersBeatingM0: 2 / 3,
  minGridBeatingM0: 0.5,
  minCoverage: 0.25,
} as const;

/**
 * Whether P1 may gate the verdict. **It may not, today.**
 *
 * `rankings.created_at` is reset by every correction until T0 (open PR #118) lands. A manual
 * `rank_reorder` leaves no record. Undo leaves answered comparisons in the table. So a
 * temporal replay reconstructs a past that did not quite happen. Flip this only when
 * `ranking_placements` (watch-history-and-ranking-calibration.md §E) exists and the export
 * reads placements from it. At that point P1 becomes the preferred gate, because it is the
 * only mode that simulates deployment.
 */
export const P1_CAN_GATE = false;
