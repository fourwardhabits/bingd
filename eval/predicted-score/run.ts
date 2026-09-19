/**
 * One evaluation, end to end: tasks → evidence → five models → gates → metrics → verdict.
 *
 * The result holds aggregates only. `Gated` rows (which do carry keys) never leave this file:
 * everything returned is a count, a rate or an interval.
 */

import {
  ABSTENTION,
  MIN_USERS_PER_CELL,
  P1_CAN_GATE,
  PRIMARY_CONFIG,
  SENSITIVITY_GRID,
  THRESHOLDS,
  VERDICT_CATEGORY,
  type Abstention,
  type ModelConfig,
} from './config';
import {
  ABSTAIN_REASONS,
  gate,
  type AbstainReason,
  type Gated,
  type Scored,
} from './confidence';
import { EvidenceCache } from './evidence';
import {
  computeMetrics,
  maeByConfidence,
  monotoneNonIncreasing,
  type Metrics,
} from './metrics';
import { gatherEvidence, MODELS, predict, type ModelName } from './models';
import type { Category, Dataset } from './snapshot';
import { holdoutTasks, replayTasks, type Mode, type Task } from './tasks';

const CATEGORIES: readonly Category[] = ['movies', 'tv_seasons'];

export type ModelResult = {
  tasks: number;
  userGated: number;
  eligible: number;
  shown: number;
  /** Shown as a share of the predictions that passed the user gate. */
  coverage: number | null;
  usersShown: number;
  abstentions: Record<AbstainReason, number>;
  /** Over shown predictions. For M0, which is never shown, over every user-gated one. */
  metrics: Metrics;
  /** Over every user-gated prediction, shown or not. */
  gatedMetrics: Metrics;
  confidence: { from: number; n: number; mae: number | null }[];
  monotone: boolean | null;
};

export type SegmentRow = {
  label: string;
  tasks: number;
  users: number;
  suppressed: boolean;
  userGated: number;
  shown: number;
  maeShown: number | null;
  baselineMaeShown: number | null;
  maeGated: number | null;
  baselineMaeGated: number | null;
};

export type Segment = { title: string; rows: SegmentRow[] };

export type CategoryResult = {
  tasks: number;
  users: number;
  evaluableUsers: number;
  models: Record<ModelName, ModelResult>;
  segments: Segment[];
};

export type LabelQuality = {
  tasks: number;
  replacedHint: number;
  asOfMayMissRows: number;
  noPlacementEvidence: number;
  firstInBand: number;
  clean: number;
  /** Primary M4 over shown predictions, on every label and on clean-looking labels only. */
  maeAll: number | null;
  maeClean: number | null;
  shownAll: number;
  shownClean: number;
};

export type ModeResult = {
  mode: Mode;
  categories: Record<Category, CategoryResult>;
  labelQuality: Record<Category, LabelQuality>;
};

export type GridRow = {
  config: ModelConfig;
  primary: boolean;
  shown: number;
  coverage: number | null;
  mae: number | null;
  baselineMae: number | null;
  improvement: number | null;
};

export type SweepRow = {
  parameter: string;
  value: number;
  shown: number;
  coverage: number | null;
  mae: number | null;
  severe: number | null;
};

export type CheckStatus = 'PASS' | 'FAIL' | 'UNKNOWN';
export type Check = {
  name: string;
  requirement: string;
  observed: string;
  status: CheckStatus;
};

export type ModeVerdict = {
  sampleSufficient: boolean;
  checks: Check[];
  /** P2: PASS / FAIL / INSUFFICIENT. P1: CONSISTENT / INCONSISTENT / INSUFFICIENT, never PASS. */
  outcome: 'PASS' | 'FAIL' | 'INSUFFICIENT' | 'CONSISTENT' | 'INCONSISTENT';
};

export type FinalVerdict = 'PASS FOR SHADOW MODE' | 'FAIL' | 'INSUFFICIENT';

export type Census = {
  users: number;
  activePublic: number;
  private: number;
  suspended: number;
  importers: number;
  starsIncluded: boolean;
  follows: number;
  byCategory: Record<
    Category,
    {
      raters: number;
      rankings: number;
      titles: number;
      titlesWith3PublicRaters: number;
      perRater: Record<string, number>;
    }
  >;
};

export type EvaluationResult = {
  census: Census;
  P1: ModeResult;
  P2: ModeResult;
  grid: GridRow[];
  sweep: SweepRow[];
  verdicts: { P1: ModeVerdict; P2: ModeVerdict };
  final: FinalVerdict;
  p1CanGate: boolean;
};

const reasonsOf = (rows: readonly Gated[]) => {
  const out = Object.fromEntries(ABSTAIN_REASONS.map((r) => [r, 0])) as Record<
    AbstainReason,
    number
  >;
  for (const r of rows) if (r.reason) out[r.reason] += 1;
  return out;
};

const rankGroupFor = (mode: Mode) => (row: Gated) =>
  mode === 'P2' ? row.task.group : `${row.task.u}|${row.task.c}`;

/** Score every task under every model, with the primary configuration. */
function scoreTasks(
  cache: EvidenceCache,
  tasks: readonly Task[],
  config: ModelConfig,
  models: readonly ModelName[],
): Scored[] {
  const out: Scored[] = [];
  for (const task of tasks) {
    const ev = gatherEvidence(cache, task, config);
    const baseline = predict('M0', task, ev, config, ABSTENTION);
    for (const model of models) {
      out.push({
        task,
        model,
        prediction: model === 'M0' ? baseline : predict(model, task, ev, config, ABSTENTION),
        baseline,
        support: ev.evidence.communityRaters,
      });
    }
  }
  return out;
}

function modelResult(gated: readonly Gated[], model: ModelName, mode: Mode): ModelResult {
  const userGated = gated.filter((g) => g.userGate);
  const shown = gated.filter((g) => g.shown);
  const rankGroup = rankGroupFor(mode);
  const confidence = maeByConfidence(gated.filter((g) => g.eligible));
  return {
    tasks: gated.length,
    userGated: userGated.length,
    eligible: gated.filter((g) => g.eligible).length,
    shown: shown.length,
    coverage: userGated.length === 0 ? null : shown.length / userGated.length,
    usersShown: new Set(shown.map((g) => g.task.u)).size,
    abstentions: reasonsOf(gated),
    metrics: computeMetrics(model === 'M0' ? userGated : shown, { rankGroup }),
    gatedMetrics: computeMetrics(userGated, { rankGroup, bootstrap: false }),
    confidence,
    monotone: monotoneNonIncreasing(confidence),
  };
}

const band = (value: number, edges: readonly number[], labels: readonly string[]) => {
  let i = 0;
  while (i < edges.length && value >= edges[i]!) i += 1;
  return labels[i]!;
};

function segmentsFor(ds: Dataset, gated: readonly Gated[], mode: Mode, c: Category): Segment[] {
  const exportedAt = ds.snapshot.exported_at;
  const pops = [...new Set(gated.map((g) => g.task.target.m))]
    .map((m) => ds.media.get(m)?.popularity)
    .filter((p): p is number => p !== null && p !== undefined)
    .sort((a, b) => a - b);
  const cut1 = pops[Math.floor(pops.length / 3)] ?? Infinity;
  const cut2 = pops[Math.floor((2 * pops.length) / 3)] ?? Infinity;
  const DAY = 86_400_000_000;

  const dims: { title: string; order: string[]; of: (g: Gated) => string }[] = [
    {
      title: 'Training list size (titles the reader had ranked)',
      order: ['1–4', '5–9', '10–19', '20–49', '50+'],
      of: (g) =>
        band(g.task.train.total, [5, 10, 20, 50], ['1–4', '5–9', '10–19', '20–49', '50+']),
    },
    {
      title: 'Public raters of the title at the time',
      order: ['0', '1–2', '3–4', '5+'],
      of: (g) => band(g.support, [1, 3, 5], ['0', '1–2', '3–4', '5+']),
    },
    {
      title: 'Popularity (terciles of titles in this table)',
      order: ['low', 'mid', 'high', 'unknown'],
      of: (g) => {
        const p = ds.media.get(g.task.target.m)?.popularity;
        if (p === null || p === undefined) return 'unknown';
        return p < cut1 ? 'low' : p < cut2 ? 'mid' : 'high';
      },
    },
    {
      title: 'Letterboxd importer',
      order: ['importer', 'not an importer'],
      of: (g) =>
        (ds.users.get(g.task.u)?.imported_titles ?? 0) > 0 ? 'importer' : 'not an importer',
    },
    {
      title: 'Ranking age at export',
      order: ['<7 days', '7–30 days', '30–90 days', '90+ days'],
      of: (g) =>
        band(
          (exportedAt - g.task.target.t) / DAY,
          [7, 30, 90],
          ['<7 days', '7–30 days', '30–90 days', '90+ days'],
        ),
    },
    {
      title:
        'Placement evidence (comparisons in the session window; Undo leftovers inflate this)',
      order: ['first in its band', 'none recorded', '1–3', '4+'],
      of: (g) =>
        g.task.flags.firstInBand
          ? 'first in its band'
          : g.task.target.cmp_window === 0
            ? 'none recorded'
            : g.task.target.cmp_window <= 3
              ? '1–3'
              : '4+',
    },
  ];
  if (mode === 'P1') {
    dims.push({
      title: 'P1 label flag',
      order: [
        'clean-looking',
        're-placed (created_at reset)',
        'earlier list was missing a title',
      ],
      of: (g) =>
        g.task.flags.replacedHint
          ? 're-placed (created_at reset)'
          : g.task.flags.asOfMayMissRows
            ? 'earlier list was missing a title'
            : 'clean-looking',
    });
  }

  const mae = (rows: readonly Gated[], pick: 'prediction' | 'baseline') =>
    rows.length === 0
      ? null
      : rows.reduce((s, r) => s + Math.abs(r[pick]!.score - r.task.truth.score), 0) /
        rows.length;

  return dims.map((dim) => ({
    title: dim.title,
    rows: dim.order.map((label) => {
      const rows = gated.filter((g) => g.task.c === c && dim.of(g) === label);
      const users = new Set(rows.map((r) => r.task.u)).size;
      const userGated = rows.filter((r) => r.userGate && r.prediction && r.baseline);
      const shown = rows.filter((r) => r.shown && r.prediction && r.baseline);
      const suppressed = users > 0 && users < MIN_USERS_PER_CELL;
      return {
        label,
        tasks: rows.length,
        users,
        suppressed,
        userGated: userGated.length,
        shown: shown.length,
        maeShown: suppressed ? null : mae(shown, 'prediction'),
        baselineMaeShown: suppressed ? null : mae(shown, 'baseline'),
        maeGated: suppressed ? null : mae(userGated, 'prediction'),
        baselineMaeGated: suppressed ? null : mae(userGated, 'baseline'),
      };
    }),
  }));
}

function labelQuality(gated: readonly Gated[]): LabelQuality {
  const tasks = [
    ...new Map(gated.map((g) => [`${g.task.group}|${g.task.target.m}`, g.task])).values(),
  ];
  const clean = (t: Task) =>
    !t.flags.replacedHint && !t.flags.asOfMayMissRows && !t.flags.noPlacementEvidence;
  const shown = gated.filter((g) => g.shown);
  const shownClean = shown.filter((g) => clean(g.task));
  const mae = (rows: readonly Gated[]) =>
    rows.length === 0
      ? null
      : rows.reduce((s, r) => s + Math.abs(r.prediction!.score - r.task.truth.score), 0) /
        rows.length;
  return {
    tasks: tasks.length,
    replacedHint: tasks.filter((t) => t.flags.replacedHint).length,
    asOfMayMissRows: tasks.filter((t) => t.flags.asOfMayMissRows).length,
    noPlacementEvidence: tasks.filter((t) => t.flags.noPlacementEvidence).length,
    firstInBand: tasks.filter((t) => t.flags.firstInBand).length,
    clean: tasks.filter(clean).length,
    maeAll: mae(shown),
    maeClean: mae(shownClean),
    shownAll: shown.length,
    shownClean: shownClean.length,
  };
}

function evaluateMode(
  ds: Dataset,
  cache: EvidenceCache,
  mode: Mode,
): { result: ModeResult; gatedM4Movies: Gated[]; scoredM4Movies: Scored[] } {
  const tasks = mode === 'P2' ? holdoutTasks(ds, CATEGORIES) : replayTasks(ds, CATEGORIES);
  const scored = scoreTasks(cache, tasks, PRIMARY_CONFIG, MODELS);
  const categories = {} as Record<Category, CategoryResult>;
  const quality = {} as Record<Category, LabelQuality>;
  let gatedM4Movies: Gated[] = [];
  let scoredM4Movies: Scored[] = [];

  for (const c of CATEGORIES) {
    const models = {} as Record<ModelName, ModelResult>;
    let gatedM4: Gated[] = [];
    for (const model of MODELS) {
      const slice = scored.filter((s) => s.model === model && s.task.c === c);
      const gated = gate(slice, ABSTENTION);
      models[model] = modelResult(gated, model, mode);
      if (model === 'M4') {
        gatedM4 = gated;
        if (c === VERDICT_CATEGORY) {
          gatedM4Movies = gated;
          scoredM4Movies = slice;
        }
      }
    }
    const inCategory = tasks.filter((t) => t.c === c);
    categories[c] = {
      tasks: inCategory.length,
      users: new Set(inCategory.map((t) => t.u)).size,
      evaluableUsers: new Set(gatedM4.filter((g) => g.userGate).map((g) => g.task.u)).size,
      models,
      segments: segmentsFor(ds, gatedM4, mode, c),
    };
    quality[c] = labelQuality(gatedM4);
  }
  return { result: { mode, categories, labelQuality: quality }, gatedM4Movies, scoredM4Movies };
}

const fmt = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined ? 'n/a' : v.toFixed(digits);
const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`;

/** The pre-registered checks of study §10, on one mode's Movies result for the primary M4. */
export function checksFor(
  category: CategoryResult,
  grid: readonly GridRow[] | null,
): { sample: boolean; checks: Check[] } {
  const m = category.models.M4;
  const x = m.metrics;
  const T = THRESHOLDS;
  const check = (
    name: string,
    requirement: string,
    observed: string,
    ok: boolean | null,
  ): Check => ({
    name,
    requirement,
    observed,
    status: ok === null ? 'UNKNOWN' : ok ? 'PASS' : 'FAIL',
  });
  const known = <V>(v: V | null | undefined, test: (v: V) => boolean) =>
    v === null || v === undefined ? null : test(v);
  const sample = category.evaluableUsers >= T.minEvaluableUsers && m.shown >= T.minShown;
  const gain =
    x.bucketAccuracy !== null && x.baselineBucketAccuracy !== null
      ? x.bucketAccuracy - x.baselineBucketAccuracy
      : null;
  const gridBeating =
    grid && grid.length > 0
      ? grid.filter((g) => (g.improvement ?? -1) > 0).length / grid.length
      : null;

  const checks: Check[] = [
    check(
      'Evaluable users',
      `≥ ${T.minEvaluableUsers}`,
      `${category.evaluableUsers}`,
      category.evaluableUsers >= T.minEvaluableUsers,
    ),
    check('Shown predictions', `≥ ${T.minShown}`, `${m.shown}`, m.shown >= T.minShown),
    check(
      'Score MAE (display units, unrounded)',
      `≤ ${T.maxMae}`,
      fmt(x.mae),
      known(x.mae, (v) => v <= T.maxMae),
    ),
    check(
      'Improvement over M0, same rows',
      `≥ ${pct(T.minRelativeImprovement)}, and the 95% CI of (MAE − M0 MAE) below 0`,
      `${pct(x.relativeImprovement)}; CI ${x.maeDiffCi ? `[${fmt(x.maeDiffCi.low)}, ${fmt(x.maeDiffCi.high)}]` : 'n/a'}`,
      x.relativeImprovement === null || !x.maeDiffCi
        ? null
        : x.relativeImprovement >= T.minRelativeImprovement && x.maeDiffCi.high < 0,
    ),
    check(
      'Bucket accuracy',
      `≥ ${pct(T.minBucketAccuracy)}`,
      pct(x.bucketAccuracy),
      known(x.bucketAccuracy, (v) => v >= T.minBucketAccuracy),
    ),
    check(
      'Bucket accuracy gain over M0',
      `≥ ${fmt(T.minBucketAccuracyGain * 100, 0)} points`,
      gain === null ? 'n/a' : `${(gain * 100).toFixed(1)} points`,
      known(gain, (v) => v >= T.minBucketAccuracyGain),
    ),
    check(
      'Severe misses (liked ↔ didn’t like)',
      `≤ ${pct(T.maxSevereMissRate)}`,
      pct(x.severeMissRate),
      known(x.severeMissRate, (v) => v <= T.maxSevereMissRate),
    ),
    check(
      `Errors of ${T.largeError}+ points`,
      `≤ ${pct(T.maxLargeErrorRate)}`,
      pct(x.largeErrorRate),
      known(x.largeErrorRate, (v) => v <= T.maxLargeErrorRate),
    ),
    check(
      'Pairwise accuracy (pairs ≥ 1.0 apart)',
      `≥ ${T.minPairwiseAccuracy}`,
      `${fmt(x.pairwiseAccuracy)} over ${x.pairs} pairs`,
      known(x.pairwiseAccuracy, (v) => v >= T.minPairwiseAccuracy),
    ),
    check(
      'Median per-list Spearman',
      `≥ ${T.minMedianSpearman}`,
      `${fmt(x.medianSpearman)} over ${x.spearmanGroups} lists`,
      known(x.medianSpearman, (v) => v >= T.minMedianSpearman),
    ),
    check(
      '80% interval coverage',
      `${pct(T.intervalCoverage[0])}–${pct(T.intervalCoverage[1])}`,
      `${pct(x.intervalCoverage)} over ${x.intervalN}`,
      known(
        x.intervalCoverage,
        (v) => v >= T.intervalCoverage[0] && v <= T.intervalCoverage[1],
      ),
    ),
    check(
      'MAE falls as confidence rises',
      'non-increasing across bands of ≥ 20',
      m.monotone === null ? 'too few bands' : m.monotone ? 'yes' : 'no',
      m.monotone,
    ),
    check(
      'Users beating M0',
      `≥ ${pct(T.minUsersBeatingM0)}`,
      `${pct(x.usersBeatingBaseline)} of ${x.usersCompared}`,
      known(x.usersBeatingBaseline, (v) => v >= T.minUsersBeatingM0),
    ),
    check(
      'Coverage (shown / user-gated)',
      `≥ ${pct(T.minCoverage)}`,
      pct(m.coverage),
      known(m.coverage, (v) => v >= T.minCoverage),
    ),
  ];
  if (grid) {
    checks.push(
      check(
        'Sensitivity grid beating M0',
        `≥ ${pct(T.minGridBeatingM0)} of ${grid.length} configurations`,
        pct(gridBeating),
        known(gridBeating, (v) => v >= T.minGridBeatingM0),
      ),
    );
  }
  return { sample, checks };
}

export function verdictFor(
  mode: Mode,
  category: CategoryResult,
  grid: readonly GridRow[] | null,
): ModeVerdict {
  const { sample, checks } = checksFor(category, grid);
  const failed = checks.some((c) => c.status === 'FAIL');
  const unknown = checks.some((c) => c.status === 'UNKNOWN');
  if (mode === 'P1' && !P1_CAN_GATE) {
    return {
      sampleSufficient: sample,
      checks,
      outcome: !sample || unknown ? 'INSUFFICIENT' : failed ? 'INCONSISTENT' : 'CONSISTENT',
    };
  }
  return {
    sampleSufficient: sample,
    checks,
    outcome: !sample || unknown ? 'INSUFFICIENT' : failed ? 'FAIL' : 'PASS',
  };
}

/**
 * The final word. P2 decides at current maturity. P1 cannot produce a pass while its labels
 * are contaminated (`P1_CAN_GATE`), and even a pass only admits **shadow mode**: computing and
 * logging predictions no reader sees.
 */
export function finalVerdict(p2: ModeVerdict, p1: ModeVerdict): FinalVerdict {
  if (P1_CAN_GATE) {
    if (p1.outcome === 'INSUFFICIENT' || p2.outcome === 'INSUFFICIENT') return 'INSUFFICIENT';
    if (p1.outcome !== 'PASS' || p2.outcome !== 'PASS') return 'FAIL';
    return 'PASS FOR SHADOW MODE';
  }
  if (p2.outcome === 'INSUFFICIENT') return 'INSUFFICIENT';
  if (p2.outcome === 'FAIL') return 'FAIL';
  return 'PASS FOR SHADOW MODE';
}

function runGrid(ds: Dataset, cache: EvidenceCache): GridRow[] {
  const tasks = holdoutTasks(ds, [VERDICT_CATEGORY]);
  return SENSITIVITY_GRID.map((config) => {
    const gated = gate(scoreTasks(cache, tasks, config, ['M4']), ABSTENTION);
    const shown = gated.filter((g) => g.shown);
    const userGated = gated.filter((g) => g.userGate);
    const m = computeMetrics(shown, { bootstrap: false });
    return {
      config,
      primary:
        config.transfer === PRIMARY_CONFIG.transfer &&
        config.priorStrength === PRIMARY_CONFIG.priorStrength &&
        config.contentTau === PRIMARY_CONFIG.contentTau,
      shown: shown.length,
      coverage: userGated.length === 0 ? null : shown.length / userGated.length,
      mae: m.mae,
      baselineMae: m.baselineMae,
      improvement: m.relativeImprovement,
    };
  });
}

/** Descriptive only: how coverage and error respond as one threshold moves. Never the verdict. */
function runSweep(scored: readonly Scored[]): SweepRow[] {
  const variations: { parameter: string; key: keyof Abstention; values: number[] }[] = [
    { parameter: 'minProb', key: 'minProb', values: [0.5, 0.6, 0.7, 0.8, 0.9] },
    { parameter: 'maxWidth', key: 'maxWidth', values: [1.5, 2, 2.5, 3, 4, Infinity] },
    { parameter: 'minTrain', key: 'minTrain', values: [5, 10, 20, 30] },
    { parameter: 'minContentNeighbours', key: 'minContentNeighbours', values: [3, 5, 8] },
  ];
  const rows: SweepRow[] = [];
  for (const v of variations) {
    for (const value of v.values) {
      const gated = gate(scored, { ...ABSTENTION, [v.key]: value });
      const shown = gated.filter((g) => g.shown);
      const userGated = gated.filter((g) => g.userGate);
      const m = computeMetrics(shown, { bootstrap: false });
      rows.push({
        parameter: v.parameter,
        value,
        shown: shown.length,
        coverage: userGated.length === 0 ? null : shown.length / userGated.length,
        mae: m.mae,
        severe: m.severeMissRate,
      });
    }
  }
  return rows;
}

function census(ds: Dataset): Census {
  const users = [...ds.users.values()];
  const byCategory = {} as Census['byCategory'];
  for (const c of CATEGORIES) {
    const rows = ds.snapshot.rankings.filter((r) => r.c === c);
    const perRaterCounts = new Map<string, number>();
    for (const r of rows) perRaterCounts.set(r.u, (perRaterCounts.get(r.u) ?? 0) + 1);
    // "exactly 5", not "5": JavaScript orders integer-like keys first, whatever the literal says.
    const perRater: Record<string, number> = {
      '1–4': 0,
      'exactly 5': 0,
      '6–9': 0,
      '10–19': 0,
      '20–49': 0,
      '50–99': 0,
      '100+': 0,
    };
    for (const n of perRaterCounts.values()) {
      const key =
        n < 5
          ? '1–4'
          : n === 5
            ? 'exactly 5'
            : n < 10
              ? '6–9'
              : n < 20
                ? '10–19'
                : n < 50
                  ? '20–49'
                  : n < 100
                    ? '50–99'
                    : '100+';
      perRater[key] = (perRater[key] ?? 0) + 1;
    }
    const titles = new Map<string, number>();
    for (const r of rows) {
      const u = ds.users.get(r.u);
      if (u?.visibility === 'public' && u.status === 'active')
        titles.set(r.m, (titles.get(r.m) ?? 0) + 1);
    }
    byCategory[c] = {
      raters: perRaterCounts.size,
      rankings: rows.length,
      titles: new Set(rows.map((r) => r.m)).size,
      titlesWith3PublicRaters: [...titles.values()].filter((n) => n >= 3).length,
      perRater,
    };
  }
  return {
    users: users.length,
    activePublic: users.filter((u) => u.visibility === 'public' && u.status === 'active')
      .length,
    private: users.filter((u) => u.visibility === 'private').length,
    suspended: users.filter((u) => u.status === 'suspended').length,
    importers: users.filter((u) => u.imported_titles > 0).length,
    starsIncluded: ds.snapshot.includes_letterboxd_stars,
    follows: ds.snapshot.follows.length,
    byCategory,
  };
}

export function runEvaluation(
  ds: Dataset,
  options: { grid?: boolean; sweep?: boolean } = {},
): EvaluationResult {
  const cache = new EvidenceCache(ds);
  const p2 = evaluateMode(ds, cache, 'P2');
  const p1 = evaluateMode(ds, cache, 'P1');
  const grid = options.grid === false ? [] : runGrid(ds, cache);
  const sweep = options.sweep === false ? [] : runSweep(p2.scoredM4Movies);
  const v2 = verdictFor(
    'P2',
    p2.result.categories[VERDICT_CATEGORY],
    grid.length > 0 ? grid : null,
  );
  const v1 = verdictFor('P1', p1.result.categories[VERDICT_CATEGORY], null);
  return {
    census: census(ds),
    P1: p1.result,
    P2: p2.result,
    grid,
    sweep,
    verdicts: { P1: v1, P2: v2 },
    final: finalVerdict(v2, v1),
    p1CanGate: P1_CAN_GATE,
  };
}
