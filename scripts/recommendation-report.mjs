/**
 * Regenerates `.agent-workflow/recommendation-quality.md`.
 *
 *   npm run report:recommendations
 *
 * The measurements live in `src/features/recommendations/quality.test.ts`, because
 * they are assertions first and a report second: every figure in the file is a
 * threshold the suite fails on, and a metric nobody can fail is a metric nobody
 * reads. What this command adds is the *writing*, which is gated behind
 * `BINGD_REPORTS` so that an ordinary `npm test` has no workspace side effect and
 * cannot fail in a read-only sandbox.
 *
 * Deterministic: a seeded PRNG drives everything synthetic, so running this twice
 * produces the same file and the report never churns.
 */

import { spawnSync } from 'node:child_process';

const result = spawnSync(
  'npx',
  ['jest', 'src/features/recommendations/quality', '--forceExit'],
  {
    stdio: 'inherit',
    // `shell: true` for Windows, where npx is a .cmd and spawn will not find it
    // otherwise. Nothing here is interpolated from input.
    shell: true,
    env: { ...process.env, BINGD_REPORTS: '1' },
  },
);

process.exit(result.status ?? 1);
