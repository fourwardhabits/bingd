/**
 * Writes the predicted-score evaluation report into `.agent-workflow/eval/` (gitignored).
 *
 *   node eval/predicted-score/run-report.mjs --synthetic                   (rich cohort)
 *   node eval/predicted-score/run-report.mjs --synthetic production-like   (sparse, like today)
 *   node eval/predicted-score/run-report.mjs --snapshot .agent-workflow/eval/snapshot-2026-09-20.json
 *
 * The evaluation itself lives in `report.test.ts` behind `BINGD_REPORTS=1`, the same pattern
 * `scripts/recommendation-report.mjs` uses, so it runs the real TypeScript through the
 * project's own Jest transform. This file only checks the arguments and starts it.
 *
 * Refuses a snapshot anywhere git could pick it up. A snapshot belongs in the gitignored
 * `.agent-workflow/` or outside the repository entirely.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const at = args.indexOf('--snapshot');
const synthetic = args.includes('--synthetic');

if ((at === -1) === !synthetic) {
  console.error('Usage: run-report.mjs --synthetic | --snapshot <path to the export>');
  process.exit(2);
}

const env = { ...process.env, BINGD_REPORTS: '1' };
delete env.PREDICTED_SCORE_SNAPSHOT;
delete env.PREDICTED_SCORE_SYNTHETIC;
if (synthetic && args[args.indexOf('--synthetic') + 1] === 'production-like') {
  env.PREDICTED_SCORE_SYNTHETIC = 'production-like';
}

if (at !== -1) {
  const path = resolve(args[at + 1] ?? '');
  if (!existsSync(path)) {
    console.error(`No snapshot at ${path}`);
    process.exit(2);
  }
  const inside = relative(root, path);
  // relative() across drives on Windows returns an absolute path: that is outside the repo.
  const inRepo = !inside.startsWith('..') && !isAbsolute(inside);
  if (inRepo && !inside.startsWith(`.agent-workflow${sep}`)) {
    console.error(
      `Refusing ${inside}: a snapshot inside the repository must live under .agent-workflow/ (gitignored), or outside the repository.`,
    );
    process.exit(2);
  }
  env.PREDICTED_SCORE_SNAPSHOT = path;
}

const result = spawnSync(
  'npx',
  [
    'jest',
    join('eval', 'predicted-score', 'report.test.ts'),
    '-t',
    'writes the report',
    '--runInBand',
  ],
  // `shell: true` for Windows, where npx is a .cmd. Nothing here is interpolated from input:
  // the snapshot path travels in the environment, never on the command line.
  { cwd: root, stdio: 'inherit', shell: true, env },
);

process.exit(result.status ?? 1);
