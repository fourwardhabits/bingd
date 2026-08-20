#!/usr/bin/env node
/**
 * The only supported way to build or publish a lane.
 *
 *   npm run build:preview  -- --platform android
 *   npm run update:preview -- --message "what changed"
 *   npm run build:beta     -- --platform android
 *   npm run update:beta    -- --message "what changed"
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN A DOCUMENTED `eas` COMMAND
 *
 * **`eas update` does not read a build profile.** It takes `--branch` and
 * `--environment`, and an EAS *environment* holds only the four `EXPO_PUBLIC_*`
 * variables — not `APP_VARIANT`, not `BINGD_LANE`, which live in `eas.json` under
 * `build.<profile>.env`.
 *
 * Independent review 28b found what that means, and the consequence is worse than the
 * backend question it was raised under. An `eas update --branch beta --environment
 * preview` resolves `app.config.ts` with **no `APP_VARIANT` at all**, which defaults to
 * `development` — so the update manifest published to friend testers would carry
 * `extra.variant: 'development'` and no lane. `Constants.expoConfig` is read from the
 * manifest, so every device taking that update would decide it was a development build:
 * environment badge on, `isProduction` false, the lane gone, and the backend check
 * downgraded to development permissions.
 *
 * The native side would be unchanged and correct, which is exactly what makes it hard to
 * see from the outside.
 *
 * So the lane is supplied here, read from `eas.json`, for builds and updates alike — one
 * place, taken from the file that defines the lanes rather than retyped.
 * ---------------------------------------------------------------------------
 *
 * The Beta and Production lanes additionally have to pass three checks first. They do not
 * make it impossible to publish unreviewed work to friend testers — **`eas` is a command
 * anybody can type** — they make it a deliberate act rather than a Tuesday afternoon.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eas = JSON.parse(readFileSync(join(root, 'eas.json'), 'utf8'));

const [action, lane, ...passthrough] = process.argv.slice(2);

if (!['build', 'update'].includes(action) || !eas.build[lane]) {
  console.error('usage: node scripts/release.mjs <build|update> <lane> [eas flags...]');
  process.exit(2);
}

const profile = eas.build[lane];
const GUARDED = new Set(['beta', 'production']);

// ---------------------------------------------------------------------------
// Nothing passed through may redefine the lane
// ---------------------------------------------------------------------------

/**
 * **An allowlist, and it started life as a denylist.**
 *
 * Two consecutive reviews found two different holes in the denylist version, which is the
 * argument for this shape rather than for a longer list:
 *
 *   - **28c:** `npm run update:preview -- --branch beta` published Preview code to the
 *     Beta branch past the Beta gate. The trusted options were assembled before
 *     `...passthrough` and `eas` takes the last occurrence of a flag, so appending one
 *     silently won.
 *   - **28d:** `npm run update:beta -- --input-dir <export> --skip-bundler` gated the
 *     current checkout and then published a bundle produced somewhere else entirely. The
 *     config is not resolved during such an invocation at all, so neither the lane nor the
 *     backend rule runs on what actually ships.
 *
 * A denylist has to anticipate every flag that moves what is published; an allowlist has to
 * anticipate every flag that does not. Only the second list is one this project can keep
 * correct, and being wrong about it costs a refusal rather than a silent bypass.
 *
 * Adding a flag here is a deliberate act: ask whether it changes **what is published, where
 * it goes, or which gate ran**. If it does, it does not belong here.
 */
const ALLOWED_PASSTHROUGH = new Set([
  // Which platform. Chooses nothing about content or destination.
  '--platform',
  '-p',
  // Annotation and output shape.
  '--message',
  '-m',
  '--json',
  '--non-interactive',
  '--verbose-logs',
  '--build-logger-level',
  '--help',
  '-h',
  // Waiting behaviour, and build-cache and credential handling. None of these decides
  // what goes into the artifact or where it is sent.
  '--wait',
  '--no-wait',
  '--clear-cache',
  '--freeze-credentials',
  '--refresh-ad-hoc-provisioning-profile',
]);

const rejected = passthrough.filter((arg) => {
  if (!arg.startsWith('-')) return false; // a value for the flag before it
  const flag = arg.split('=')[0];
  return !ALLOWED_PASSTHROUGH.has(flag);
});

if (rejected.length) {
  console.error(
    `\nRefusing: ${rejected.join(' ')} is not passed through by this script.\n\n` +
      '  The lane is the first argument, and it decides the profile, the branch, the\n' +
      '  environment, BINGD_LANE and APP_VARIANT together. Flags are allowlisted rather\n' +
      '  than denied one by one because two review rounds found two different ways past a\n' +
      '  denylist: `--branch beta` on the preview script, and `--input-dir` with\n' +
      '  `--skip-bundler`, which publishes a bundle built somewhere else after gating the\n' +
      '  code here.\n\n' +
      '  Use the script for the lane you mean — npm run build:beta, npm run update:beta —\n' +
      '  or, if the flag genuinely changes nothing about what is published or where it\n' +
      '  goes, add it to ALLOWED_PASSTHROUGH in scripts/release.mjs with a reason.\n',
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The gate, for the lanes other people install
// ---------------------------------------------------------------------------

if (GUARDED.has(lane)) {
  const problems = [];
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

  /**
   * **Untracked files are included, and their exclusion was a finding.**
   *
   * This ran `--untracked-files=no` for one round. Review 28b: Metro bundles whatever
   * tracked code imports, tracked or not — so a new untracked module that a committed file
   * already imports ships to friend testers while the guard reports a clean tree. The
   * default is the correct setting, and `.gitignore` still excludes everything genuinely
   * uninteresting.
   */
  const dirty = git('status', '--porcelain');
  if (dirty) {
    problems.push(
      'The working tree is not clean:\n' +
        dirty
          .split('\n')
          .map((line) => `      ${line}`)
          .join('\n') +
        '\n    Metro bundles what is on disk, including an untracked file that committed\n' +
        '    code imports. Commit it, stash it, or add it to .gitignore.',
    );
  }

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const sha = git('rev-parse', 'HEAD');

  if (!/^(main|release\/.+)$/.test(branch)) {
    problems.push(
      'HEAD is on "' +
        branch +
        '". This lane is released from "main" or "release/*".\n' +
        '    Not a review gate — a check that somebody chose this branch.',
    );
  }

  // The release gate, on this exact commit. Not "recently", not "on this branch": a gate
  // that passed two commits ago did not run on what is about to ship.
  let gate = null;
  try {
    const runs = JSON.parse(
      execFileSync(
        'gh',
        [
          'run',
          'list',
          '--workflow',
          'release-gate.yml',
          '--commit',
          sha,
          '--limit',
          '10',
          '--json',
          'conclusion,status,url',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
    const passed = runs.find((r) => r.status === 'completed' && r.conclusion === 'success');
    if (passed) {
      gate = passed.url;
    } else if (runs.some((r) => r.status !== 'completed')) {
      problems.push(`The release gate is still running for ${sha.slice(0, 8)}. Wait for it.`);
    } else if (runs.length) {
      problems.push(
        `The release gate did not pass for ${sha.slice(0, 8)}: ${runs[0].conclusion}\n` +
          `    ${runs[0].url}`,
      );
    } else {
      problems.push(
        `No release-gate run exists for ${sha.slice(0, 8)}.\n` +
          `    Push the commit, then: gh workflow run release-gate.yml --ref ${branch}`,
      );
    }
  } catch (error) {
    // gh missing, unauthenticated, or the commit not pushed. Every one of those means the
    // gate's result is unknown, and unknown is not permission.
    problems.push(
      'Could not read the release gate from GitHub, so it cannot be treated as passed.\n' +
        `    ${String(error.message ?? error).split('\n')[0]}\n` +
        '    Push the commit and authenticate `gh`. See docs/release/safe-update-runbook.md section 6.',
    );
  }

  if (problems.length) {
    console.error(
      `\nRefusing to ${action} the ${lane} lane. Other people install what this publishes.\n`,
    );
    for (const problem of problems) console.error(`  - ${problem}\n`);
    console.error(
      '  Preview is the lane for trying things:\n' +
        '    npm run build:preview  -- --platform android\n' +
        '    npm run update:preview -- --message "..."\n' +
        '  Nobody but the founder receives those.\n',
    );
    process.exit(1);
  }

  console.log(`\n${lane}: tree clean, branch ${branch}, release gate passed\n  ${gate}\n`);
}

// ---------------------------------------------------------------------------
// Run it, with the lane supplied
// ---------------------------------------------------------------------------

const args =
  action === 'build'
    ? ['build', '--profile', lane, ...passthrough]
    : [
        'update',
        '--branch',
        profile.channel,
        '--environment',
        profile.environment,
        ...passthrough,
      ];

/**
 * Two variables, and only two.
 *
 * Everything else the app needs — the Supabase URL, the anon key, the Sentry DSN, the
 * PostHog token — comes from the EAS environment named on the profile. That is the
 * division this script is careful about: **it supplies identity, never credentials.** A
 * secret passed through here would be a secret in a process listing and in a shell
 * history.
 */
const env = {
  ...process.env,
  BINGD_LANE: lane,
  APP_VARIANT: profile.env.APP_VARIANT,
};

console.log(`eas ${args.join(' ')}   (BINGD_LANE=${lane}, APP_VARIANT=${env.APP_VARIANT})\n`);

const result = spawnSync('eas', args, {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
