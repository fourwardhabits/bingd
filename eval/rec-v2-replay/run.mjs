/**
 * The Recommendation V2 real-history replay, started by the coordinator.
 *
 *   REC_V2_REPLAY_EXPORT=/path/outside/the/repo/replay.json node eval/rec-v2-replay/run.mjs
 *   node eval/rec-v2-replay/run.mjs --synthetic          (the full-size synthetic export)
 *
 * Optional: REC_V2_REPLAY_OUT=/path/outside/the/repo writes the Markdown report there too.
 *
 * The replay lives in `replay.test.ts` behind `REC_V2_REPLAY=1`, the same pattern as
 * `eval/predicted-score/run-report.mjs`, so it runs the real TypeScript through the project's
 * own Jest transform. This file checks the paths and starts it.
 *
 * **Refuses an export or output path inside the repository**, gitignored or not: an export is
 * pseudonymous, not anonymous, and has no business near a commit. Prints aggregates only.
 * Deliberately not an `npm run` script: `package.json` scripts move the Expo fingerprint.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const synthetic = process.argv.includes('--synthetic');

const insideRepo = (path) => {
  const real = existsSync(path) ? realpathSync(path) : resolve(path);
  const rel = relative(realpathSync(root), real);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const env = { ...process.env, REC_V2_REPLAY: '1' };
delete env.REC_V2_REPLAY_SYNTHETIC;
if (synthetic) {
  env.REC_V2_REPLAY_SYNTHETIC = '1';
  delete env.REC_V2_REPLAY_EXPORT;
} else {
  const path = process.env.REC_V2_REPLAY_EXPORT;
  if (!path) {
    console.error(
      'Set REC_V2_REPLAY_EXPORT to the export file (outside the repository), or pass --synthetic.',
    );
    process.exit(2);
  }
  if (!existsSync(path)) {
    console.error(`No export at ${path}`);
    process.exit(2);
  }
  if (insideRepo(path)) {
    console.error(
      'Refusing an export inside the repository. Move it outside the repository and delete it after the run.',
    );
    process.exit(2);
  }
  env.REC_V2_REPLAY_EXPORT = resolve(path);
}
if (process.env.REC_V2_REPLAY_OUT && insideRepo(process.env.REC_V2_REPLAY_OUT)) {
  console.error('Refusing REC_V2_REPLAY_OUT inside the repository.');
  process.exit(2);
}

const result = spawnSync(
  'npx',
  [
    'jest',
    join('eval', 'rec-v2-replay', 'replay.test.ts'),
    '-t',
    'replays an export',
    '--runInBand',
  ],
  // Nothing interpolated from input: paths travel in the environment, never on the command line.
  { cwd: root, stdio: 'inherit', shell: true, env },
);
process.exit(result.status ?? 1);
