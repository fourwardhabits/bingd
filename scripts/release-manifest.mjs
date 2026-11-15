#!/usr/bin/env node
/**
 * One release, both platforms, one commit — and a file that says so.
 *
 *   node scripts/release-manifest.mjs check <manifest.json>
 *   node scripts/release-manifest.mjs live <lane> [--expect <manifest.json>]
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (parity audit, 2026-11-15)
 *
 * Preview is one EAS channel, but an update is published per platform. `eas update
 * --platform ios` replaces what iOS Preview runs and leaves Android's alone, so the two
 * phones can run different commits on the same channel with nothing anywhere saying so.
 * That happened during the 2026-11-14/15 selective QA: Android Preview stayed on the
 * broad staging integration while the iPhone ran the selective production candidate, and
 * the founder's observations about "Android vs iOS" were in fact about two commits.
 *
 * Nothing checked it because nothing recorded it. `ota-preview.yml` publishes Android
 * only, `config/live-runtimes.json` lists no iOS Preview binary, and the update IDs that
 * were recorded lived in PR comments.
 *
 * So a release is a manifest: one JSON file naming the commit, the lane, the backend, and
 * for EACH platform the update, its group, its runtime and the commit EAS says it was built
 * from. `check` refuses a manifest that is mixed-commit, one-platform without a written
 * exception, on a runtime that is not the recorded binary's, or on a backend its lane may
 * not use. `live` reads what EAS is actually serving on a branch and runs the same checks.
 *
 * **Unknown is not parity.** As in `ota-gate.mjs`, anything this cannot prove is a
 * problem, not a note.
 * ---------------------------------------------------------------------------
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export const PLATFORMS = ['android', 'ios'];

/** A candidate is built and gated but not published, so it carries no update IDs yet. */
export const STATUSES = ['candidate', 'published', 'verified', 'rolled-back'];

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUNTIME = /^[0-9a-f]{40}$/;

/**
 * The only shape of exception this accepts: one platform, published alone, on purpose.
 * Every field is required, because an exception nobody can attribute or date is the
 * accident this file exists to catch, with a label on it.
 */
function exceptionProblems(exception, lane) {
  const problems = [];
  if (exception.type !== 'isolated-platform') {
    problems.push(`exception.type must be "isolated-platform", got "${exception.type}"`);
  }
  if (!PLATFORMS.includes(exception.platform)) {
    problems.push(`exception.platform must be android or ios, got "${exception.platform}"`);
  }
  for (const field of ['reason', 'approvedBy', 'expires']) {
    if (typeof exception[field] !== 'string' || !exception[field].trim()) {
      problems.push(`exception.${field} is required`);
    }
  }
  if (lane === 'production' || lane === 'beta') {
    problems.push(`${lane} takes no isolated-platform exception: other people install it`);
  }
  return problems;
}

/**
 * Pure: everything it needs is handed to it, so every refusal has a test.
 *
 * `live` is `config/live-runtimes.json`; `backends` is `config/backends.cjs`'s
 * `LANE_BACKENDS`; `lanes` is `eas.json`'s `build`.
 */
export function checkManifest(manifest, { live, backends, lanes }) {
  const fatal = [];
  const notes = [];

  const { lane, gitSha, status } = manifest ?? {};
  if (!lanes[lane]) fatal.push(`Unknown lane "${lane}"`);
  if (!SHA.test(gitSha ?? '')) fatal.push(`gitSha must be a full commit hash, got "${gitSha}"`);
  if (!STATUSES.includes(status)) fatal.push(`status must be one of ${STATUSES.join(', ')}`);
  if (lanes[lane] && manifest.channel !== lanes[lane].channel) {
    fatal.push(`channel "${manifest.channel}" is not ${lane}'s channel "${lanes[lane].channel}"`);
  }

  // The backend the lane may use. The same rule `app.config.ts` enforces at build time,
  // checked again here because a manifest is also a claim about which database QA hit.
  const ref = manifest?.backend?.ref;
  if (!ref) fatal.push('backend.ref is required');
  else if (backends[lane] && !backends[lane].includes(ref)) {
    fatal.push(`backend ${ref} is not allowed on ${lane} (config/backends.cjs)`);
  }

  const exception = manifest?.exception ?? null;
  if (exception) {
    for (const problem of exceptionProblems(exception, lane)) fatal.push(problem);
  }

  const published = status === 'published' || status === 'verified';
  const platforms = manifest?.platforms ?? {};
  const present = PLATFORMS.filter((platform) => platforms[platform]?.updateId);

  if (published) {
    const missing = PLATFORMS.filter((platform) => !present.includes(platform));
    const excused = exception && missing.length === 1 && missing[0] !== exception.platform;
    if (missing.length && !excused) {
      fatal.push(
        `one-platform: no ${missing.join(' or ')} update. A normal release publishes both ` +
          'from one commit; an isolated platform needs a written exception.',
      );
    }
  }

  for (const platform of PLATFORMS) {
    const entry = platforms[platform];
    if (!entry) {
      if (!published) fatal.push(`platforms.${platform} is required, even on a candidate`);
      continue;
    }
    const binary = live?.[lane]?.[platform];

    // The runtime the update targets, and the binary that runtime belongs to.
    if (!RUNTIME.test(entry.runtimeVersion ?? '')) {
      fatal.push(`${platform}: runtimeVersion must be a full fingerprint hash`);
    } else if (!binary) {
      fatal.push(
        `${platform}: config/live-runtimes.json lists no ${lane} binary, so nothing proves ` +
          'this update reaches an installed app. Record the binary first.',
      );
    } else if (entry.runtimeVersion !== binary.runtime) {
      fatal.push(
        `${platform}: runtime ${entry.runtimeVersion.slice(0, 8)} is not the recorded ${lane} ` +
          `binary ${binary.version} (${binary.runtime.slice(0, 8)}). That needs a binary, not an update.`,
      );
    }

    if (!published && !entry.updateId) continue;

    if (!UUID.test(entry.updateId ?? '')) fatal.push(`${platform}: updateId must be a full UUID`);
    if (!UUID.test(entry.groupId ?? '')) fatal.push(`${platform}: groupId must be a full UUID`);
    // Mixed-commit: what EAS says each platform's update was built from.
    if (entry.gitCommitHash !== gitSha) {
      fatal.push(
        `mixed-commit: ${platform} was published from ${String(entry.gitCommitHash).slice(0, 8)}, ` +
          `not ${String(gitSha).slice(0, 8)}`,
      );
    }
  }

  const [android, ios] = PLATFORMS.map((platform) => platforms[platform]);
  if (android?.groupId && ios?.groupId && android.groupId !== ios.groupId) {
    notes.push(
      'The two platforms are in different update groups, so they were two publishes. Parity ' +
        'then rests on the commit check above; one `--platform all` publish is one group.',
    );
  }

  const verification = manifest?.verification ?? {};
  if (status === 'verified') {
    for (const field of ['ci', 'releaseGate', 'androidDevice', 'iosDevice']) {
      if (verification[field] !== 'passed') {
        fatal.push(`verified needs verification.${field} = "passed", got "${verification[field]}"`);
      }
    }
  }
  if (verification.codexReviewedCommit && verification.codexReviewedCommit !== gitSha) {
    notes.push(
      `Codex reviewed ${verification.codexReviewedCommit.slice(0, 8)}, not this commit.`,
    );
  }

  return { fatal, notes };
}

/**
 * What EAS returns for an update, reduced to the manifest's fields. Tolerant of the two
 * shapes `eas update:list --json` and `eas update:view --json` use, because neither is
 * a documented contract; a field it cannot find stays undefined and `checkManifest` says so.
 */
export function fromEasUpdates(updates) {
  const list = Array.isArray(updates) ? updates : (updates?.currentPage ?? updates?.updates ?? []);
  const latest = {};
  for (const update of list) {
    const platform = update.platform;
    if (!PLATFORMS.includes(platform)) continue;
    const at = Date.parse(update.createdAt ?? 0) || 0;
    if (!latest[platform] || at > latest[platform].at) {
      latest[platform] = {
        at,
        entry: {
          updateId: update.id,
          groupId: update.group ?? update.groupId,
          runtimeVersion: update.runtimeVersion,
          gitCommitHash: update.gitCommitHash ?? update.commit,
          createdAt: update.createdAt,
          message: update.message,
        },
      };
    }
  }
  return Object.fromEntries(Object.entries(latest).map(([platform, { entry }]) => [platform, entry]));
}

function context() {
  const eas = JSON.parse(readFileSync(join(root, 'eas.json'), 'utf8'));
  const live = JSON.parse(readFileSync(join(root, 'config/live-runtimes.json'), 'utf8'));
  const { LANE_BACKENDS } = require(join(root, 'config/backends.cjs'));
  return { lanes: eas.build, live, backends: LANE_BACKENDS };
}

function report({ fatal, notes }, what) {
  for (const note of notes) console.log(`note: ${note}`);
  if (fatal.length) {
    console.error(`\nNot one release: ${what}\n`);
    for (const problem of fatal) console.error(`  - ${problem}\n`);
    return 1;
  }
  console.log(`\nok: ${what}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, arg, ...rest] = process.argv.slice(2);
  const ctx = context();

  if (command === 'check' && arg) {
    const manifest = JSON.parse(readFileSync(arg, 'utf8'));
    process.exit(report(checkManifest(manifest, ctx), arg));
  }

  if (command === 'live' && ctx.lanes[arg]) {
    // Read-only. Needs `eas login`; publishes and changes nothing.
    const raw = execFileSync(
      'eas',
      ['update:list', '--branch', ctx.lanes[arg].channel, '--json', '--non-interactive', '--limit', '25'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const platforms = fromEasUpdates(JSON.parse(raw));
    const expectAt = rest.indexOf('--expect');
    const expected = expectAt >= 0 ? JSON.parse(readFileSync(rest[expectAt + 1], 'utf8')) : null;
    const shas = [...new Set(Object.values(platforms).map((entry) => entry.gitCommitHash))];
    const manifest = {
      ...(expected ?? {}),
      lane: arg,
      channel: ctx.lanes[arg].channel,
      gitSha: expected?.gitSha ?? (shas.length === 1 ? shas[0] : `mixed:${shas.join(',')}`),
      status: expected?.status ?? 'published',
      backend: expected?.backend ?? { ref: ctx.backends[arg]?.[0] },
      platforms,
    };
    console.log(JSON.stringify(manifest, null, 2));
    process.exit(report(checkManifest(manifest, ctx), `${arg} as EAS serves it`));
  }

  console.error(
    'usage: node scripts/release-manifest.mjs check <manifest.json>\n' +
      '       node scripts/release-manifest.mjs live <lane> [--expect <manifest.json>]',
  );
  process.exit(2);
}
