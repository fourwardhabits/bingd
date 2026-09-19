/**
 * The report, as markdown. Aggregates only: no keys, no hashes, no titles, no per-user rows.
 * A segment drawn from fewer than `MIN_USERS_PER_CELL` people prints as suppressed.
 */

import { ABSTENTION, MIN_USERS_PER_CELL, PRIMARY_CONFIG, THRESHOLDS } from './config';
import { ABSTAIN_REASONS } from './confidence';
import { MODEL_LABEL, MODELS } from './models';
import type { CategoryResult, EvaluationResult, ModeResult, ModeVerdict } from './run';
import type { Category } from './snapshot';

const f = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : v.toFixed(d);
const p = (v: number | null | undefined) =>
  v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`;
const ci = (x: { low: number; high: number } | null) =>
  x ? `[${f(x.low)}, ${f(x.high)}]` : 'n/a';

const table = (head: string[], rows: string[][]) =>
  [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');

const CATEGORY_LABEL: Record<Category, string> = { movies: 'Movies', tv_seasons: 'TV seasons' };

function modelsTable(cat: CategoryResult): string {
  return table(
    [
      'Model',
      'User-gated',
      'Shown',
      'Coverage',
      'MAE',
      'MAE (1 dp)',
      'M0 MAE, same rows',
      'Δ MAE 95% CI',
      'Bucket acc.',
      'M0 bucket acc.',
      'Severe',
      `≥${THRESHOLDS.largeError} pts`,
      'q err (bucket right)',
      'Quantile err',
      'Spearman (median)',
      'Pairwise',
      'P@3 liked (base)',
      'ECE',
      'Interval cov.',
    ],
    MODELS.map((name) => {
      const r = cat.models[name];
      const m = r.metrics;
      return [
        MODEL_LABEL[name] + (name === 'M0' ? ' ¹' : ''),
        `${r.userGated}`,
        name === 'M0' ? '—' : `${r.shown}`,
        name === 'M0' ? '—' : p(r.coverage),
        f(m.mae),
        f(m.maeDisplay),
        name === 'M0' ? '—' : f(m.baselineMae),
        name === 'M0' ? '—' : ci(m.maeDiffCi),
        p(m.bucketAccuracy),
        name === 'M0' ? '—' : p(m.baselineBucketAccuracy),
        p(m.severeMissRate),
        p(m.largeErrorRate),
        f(m.qErrorWhenBucketRight),
        f(m.quantileError),
        `${f(m.medianSpearman)} (${m.spearmanGroups})`,
        `${f(m.pairwiseAccuracy)} (${m.pairs})`,
        `${f(m.precisionAt3)} (${f(m.precisionAt3Base)})`,
        f(m.ece, 3),
        name === 'M0' ? '—' : `${p(m.intervalCoverage)} (${m.intervalN})`,
      ];
    }),
  );
}

function abstentionTable(cat: CategoryResult): string {
  return table(
    ['Model', 'Tasks', ...ABSTAIN_REASONS, 'shown'],
    MODELS.filter((m) => m !== 'M0').map((name) => {
      const r = cat.models[name];
      return [
        name,
        `${r.tasks}`,
        ...ABSTAIN_REASONS.map((reason) => `${r.abstentions[reason]}`),
        `${r.shown}`,
      ];
    }),
  );
}

function confidenceTable(cat: CategoryResult): string {
  const m4 = cat.models.M4;
  return (
    table(
      ['Most-likely-bucket probability', 'Eligible predictions', 'MAE'],
      m4.confidence.map((b, i, all) => [
        i === 0 ? `< ${all[1]?.from ?? 0.6}` : `${b.from}–${all[i + 1]?.from ?? 1}`,
        `${b.n}`,
        f(b.mae),
      ]),
    ) +
    `\n\nNon-increasing across bands with ≥ 20: **${m4.monotone === null ? 'too few bands to say' : m4.monotone ? 'yes' : 'no'}**.`
  );
}

function confusionTable(cat: CategoryResult): string {
  const c = cat.models.M4.metrics.confusion;
  const label = {
    loved: 'I liked it',
    fine: 'It was fine',
    not_for_me: 'I didn’t like it',
  } as const;
  return table(
    ['Truth ↓ / M4 predicted →', label.loved, label.fine, label.not_for_me],
    (['loved', 'fine', 'not_for_me'] as const).map((t) => [
      label[t],
      `${c[t].loved}`,
      `${c[t].fine}`,
      `${c[t].not_for_me}`,
    ]),
  );
}

function segmentsBlock(cat: CategoryResult): string {
  return cat.segments
    .map(
      (s) =>
        `**${s.title}**\n\n` +
        table(
          [
            'Segment',
            'Tasks',
            'Users',
            'User-gated',
            'Shown',
            'M4 MAE (shown)',
            'M0 MAE (same)',
            'M4 MAE (all gated)',
            'M0 MAE (all gated)',
          ],
          s.rows.map((r) =>
            r.suppressed
              ? [
                  r.label,
                  `${r.tasks}`,
                  `<${MIN_USERS_PER_CELL}`,
                  '—',
                  '—',
                  'suppressed',
                  '—',
                  '—',
                  '—',
                ]
              : [
                  r.label,
                  `${r.tasks}`,
                  `${r.users}`,
                  `${r.userGated}`,
                  `${r.shown}`,
                  f(r.maeShown),
                  f(r.baselineMaeShown),
                  f(r.maeGated),
                  f(r.baselineMaeGated),
                ],
          ),
        ),
    )
    .join('\n\n');
}

function checksBlock(v: ModeVerdict): string {
  return table(
    ['Check', 'Required', 'Observed', 'Status'],
    v.checks.map((c) => [c.name, c.requirement, c.observed, c.status]),
  );
}

function modeBlock(
  mode: ModeResult,
  verdict: ModeVerdict,
  heading: string,
  intro: string,
): string {
  const parts = [`## ${heading}`, intro];
  const movies = mode.categories.movies;
  parts.push(
    `### Pre-registered checks — Movies, primary M4\n\nOutcome: **${verdict.outcome}**${mode.mode === 'P1' ? ' (advisory: P1 cannot gate while its labels are contaminated)' : ''}. Sample sufficient: **${verdict.sampleSufficient ? 'yes' : 'no'}**.\n\n${checksBlock(verdict)}`,
  );
  if (mode.mode === 'P1') {
    const lines = (['movies', 'tv_seasons'] as const).map((c) => {
      const q = mode.labelQuality[c];
      return [
        CATEGORY_LABEL[c],
        `${q.tasks}`,
        `${q.replacedHint} (${p(q.tasks ? q.replacedHint / q.tasks : null)})`,
        `${q.asOfMayMissRows} (${p(q.tasks ? q.asOfMayMissRows / q.tasks : null)})`,
        `${q.noPlacementEvidence} (${p(q.tasks ? q.noPlacementEvidence / q.tasks : null)})`,
        `${q.clean} (${p(q.tasks ? q.clean / q.tasks : null)})`,
        `${f(q.maeAll)} (${q.shownAll})`,
        `${f(q.maeClean)} (${q.shownClean})`,
      ];
    });
    parts.push(
      '### Label quality: the contamination this mode carries\n\n' +
        table(
          [
            'Category',
            'Labels',
            'Re-placed: `created_at` was reset',
            'Replayed without a re-placed title that was already in the list',
            'Placed into a non-empty band with no comparison recorded',
            'None of these',
            'M4 MAE, all shown (n)',
            'M4 MAE, clean-looking shown (n)',
          ],
          lines,
        ) +
        '\n\nNot detectable at all: a manual `rank_reorder` leaves no record, so a label can be wrong with no flag set. Undo leaves answered comparisons behind, so comparison counts overstate placement evidence.',
    );
  }
  parts.push(
    `### Models — Movies\n\n${modelsTable(movies)}\n\n¹ M0 is the baseline and is never shown; its row is over every user-gated prediction. Every other model's M0 column is M0 on that model's own shown rows.`,
  );
  parts.push(`### Abstentions — Movies\n\n${abstentionTable(movies)}`);
  parts.push(`### Does confidence mean anything? — Movies, M4\n\n${confidenceTable(movies)}`);
  parts.push(`### Bucket confusion — Movies, M4 shown\n\n${confusionTable(movies)}`);
  parts.push(`### Segments — Movies, M4 against M0\n\n${segmentsBlock(movies)}`);
  parts.push(
    `### TV seasons — information only, not in v1 scope\n\n${modelsTable(mode.categories.tv_seasons)}\n\n${segmentsBlock(mode.categories.tv_seasons)}`,
  );
  return parts.join('\n\n');
}

export type ReportSource =
  { kind: 'synthetic'; name: string } | { kind: 'snapshot'; exportedDay: string };

export function renderReport(
  result: EvaluationResult,
  source: ReportSource,
  generatedDay: string,
): string {
  const c = result.census;
  const sourceLine =
    source.kind === 'synthetic'
      ? `**SYNTHETIC DATA (${source.name}).** Generated by \`synthetic.ts\`. Nothing here describes bingd's users.`
      : `Snapshot exported ${source.exportedDay} (pseudonymised, aggregate-only report).`;

  const waits =
    'A user-facing Predicted Score still waits for **(1) a sufficient cohort and sample**, **(2) clean placement-history labels** ' +
    '(T0 landed and `ranking_placements` recording every placement, so P1 can gate), and **(3) a prospective shadow-mode check** against titles people rank after a prediction was logged.';

  const verdictExplain: Record<EvaluationResult['final'], string> = {
    INSUFFICIENT:
      'The cohort is too small to decide. This is the expected outcome at current scale and is not a failure of the harness or the models. Re-run at the growth trigger.',
    FAIL: 'The sample is large enough and at least one pre-registered check failed on P2.',
    'PASS FOR SHADOW MODE':
      'P2 passed every pre-registered check. This admits **shadow mode only**: compute and log predictions nobody sees, and compare them with rankings made later.',
  };

  const census = [
    `- Accounts with rankings: ${c.users} (public and active ${c.activePublic}, private ${c.private}, suspended ${c.suspended}); Letterboxd importers ${c.importers}; own stars included: ${c.starsIncluded ? 'yes' : 'no'}; approved follows between them: ${c.follows}.`,
    '',
    table(
      [
        'Category',
        'Raters',
        'Rankings',
        'Titles',
        'Titles with ≥3 public raters',
        'Raters by list size',
      ],
      (['movies', 'tv_seasons'] as const).map((cat) => {
        const x = c.byCategory[cat];
        return [
          CATEGORY_LABEL[cat],
          `${x.raters}`,
          `${x.rankings}`,
          `${x.titles}`,
          `${x.titlesWith3PublicRaters}`,
          Object.entries(x.perRater)
            .map(([k, v]) => `${k}: ${v}`)
            .join(' · '),
        ];
      }),
    ),
  ].join('\n');

  const grid =
    result.grid.length === 0
      ? '_Not run._'
      : table(
          [
            'Transfer',
            'Prior strength',
            'Content τ',
            'Primary',
            'Shown',
            'Coverage',
            'MAE',
            'M0 MAE (same)',
            'Improvement',
          ],
          result.grid.map((g) => [
            g.config.transfer,
            `${g.config.priorStrength}`,
            `${g.config.contentTau}`,
            g.primary ? '✓' : '',
            `${g.shown}`,
            p(g.coverage),
            f(g.mae),
            f(g.baselineMae),
            p(g.improvement),
          ]),
        );

  const sweep =
    result.sweep.length === 0
      ? '_Not run._'
      : table(
          [
            'Threshold varied (others at default)',
            'Value',
            'Shown',
            'Coverage',
            'MAE',
            'Severe',
          ],
          result.sweep.map((s) => [
            s.parameter,
            Number.isFinite(s.value)
              ? `${s.value}${s.value === (ABSTENTION as Record<string, unknown>)[s.parameter] ? ' (default)' : ''}`
              : '∞',
            `${s.shown}`,
            p(s.coverage),
            f(s.mae),
            p(s.severe),
          ]),
        );

  return [
    '# Predicted score — offline evaluation',
    sourceLine,
    `Generated ${generatedDay}. Planning evidence only: nothing here is shown to anybody, and no prediction is stored.`,
    `## Verdict: ${result.final}`,
    verdictExplain[result.final],
    [
      `- P2 current-library holdout (decides today): **${result.verdicts.P2.outcome}**`,
      `- P1 temporal replay (advisory, cannot gate): **${result.verdicts.P1.outcome}**`,
    ].join('\n'),
    waits,
    '## Read this first: two modes, and why P2 decides today',
    "**P1 TEMPORAL — NOISY CURRENTLY.** Each ranking is predicted from the list as it stood just before its `rankings.created_at`, with everyone else's evidence cut at the same moment. That is the only mode that simulates deployment, but its labels are not clean yet. Every correction resets `created_at` until T0 lands, a manual `rank_reorder` leaves no record, and Undo leaves answered comparisons in the table. So P1 is reported with its contamination counted. **It cannot produce a pass.**",
    "**P2 HOLDOUT — MODEL COMPARISON.** A bucket-stratified fifth of each current list is held out and predicted from the rest. This leaks the future (other people's later rankings, the reader's later taste) and is **not** a deployment simulation. But the current order is the reader's current opinion, so its labels are reliable, and at current maturity it is the primary model-comparison signal.",
    'Once placement history exists (`ranking_placements`, watch-history-and-ranking-calibration.md §E), P1 becomes the preferred gate (`P1_CAN_GATE` in `config.ts`).',
    '## Data census',
    census,
    modeBlock(
      result.P2,
      result.verdicts.P2,
      'P2 HOLDOUT — MODEL COMPARISON',
      "Truth is the insertion quantile of each held-out title among the same-band titles left in the list, projected through `scoreFor`. Other people's evidence is their current list; the reader's held-out fold is excluded from every aggregate, including their own side of Taste Match.",
    ),
    modeBlock(
      result.P1,
      result.verdicts.P1,
      'P1 TEMPORAL — NOISY CURRENTLY',
      'Truth is where each title landed among the titles already in the list at its `created_at`. **Treat every number in this section as noisy**: the label-quality table says how much of it rests on a reset `created_at`.',
    ),
    '## Sensitivity grid — P2 Movies, M4',
    'Pre-registered, all reported. Robustness asks that at least half beat M0. The primary configuration is marked.',
    grid,
    '## Threshold sweep — descriptive only',
    'How coverage and error respond when one threshold moves. The verdict never reads this. Thresholds are pre-registered in `config.ts` and are not tuned against any evaluation set. Choosing a threshold from this table would be tuning on the same data.',
    sweep,
    '## Method',
    [
      "- **Target.** Bucket probabilities plus the within-band insertion quantile q. The display score is projected from the point prediction (median bucket, its q) through the app's own `BAND_RANGE`. The one-decimal number is display only; MAE is reported unrounded, with the rounded MAE beside it.",
      "- **Models.** M0 own bucket shares with q = ½. M1 public raters (`community_score`'s population). M2 viewable raters (`can_view_profile`'s population) weighted by Taste Match above 50, which mirrors `taste_match` exactly. M3 the reader's own similar titles, plus their own Letterboxd stars when the snapshot includes them. Stars are never used for anyone else. M4 pools all three. All pool over the M0 prior.",
      `- **Primary configuration.** transfer ${PRIMARY_CONFIG.transfer}, prior strength ${PRIMARY_CONFIG.priorStrength}, content τ ${PRIMARY_CONFIG.contentTau}, k ${PRIMARY_CONFIG.contentK}.`,
      `- **Abstention (pre-registered).** ≥ ${ABSTENTION.minTrain} ranked in the category with ≥ ${ABSTENTION.minOutsideLoved} outside the top band; the model's own evidence at its minimum (community ≥ ${ABSTENTION.minCommunityRaters}, neighbours ≥ ${ABSTENTION.minNeighbours}, own similar titles ≥ ${ABSTENTION.minContentNeighbours}); M4 components within ${ABSTENTION.maxDisagreement} points; most likely bucket ≥ ${ABSTENTION.minProb}; 80% interval ≤ ${ABSTENTION.maxWidth} points.`,
      "- **Intervals.** Cross-conformal by user and Mondrian by confidence. Each prediction's interval comes from the other half of users' errors in the same confidence band and evidence tier, falling back to the band and then the whole half when a cell is thin. Nobody's own errors size their own interval.",
      '- **P1 label flags.** A ranking with comparisons more than 24 hours before its `created_at` was re-placed, so its `created_at` was reset. Any earlier label whose moment falls after that title’s first comparison was replayed without a title that was already in the list.',
      '- **Bootstrap.** 1,000 resamples of users, seeded.',
      '- **Not measurable offline.** Coverage on real title-page traffic, because opens are not recorded (the coverage here is over user-gated held-out titles). Anchoring, meaning whether a shown number pulls the ranking toward itself. Titles nobody has watched, because the evaluation can only use titles people chose to watch and rank.',
    ].join('\n'),
  ].join('\n\n');
}
