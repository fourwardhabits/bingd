#!/usr/bin/env node
/**
 * The gates in front of `.eas/workflows/ota-*.yml`, run on EAS.
 *
 *   node scripts/ota-gate.mjs preflight   before anything can read a production variable
 *   node scripts/ota-gate.mjs runtimes    after the cloud fingerprint, before the publish
 *
 * The publish moved off the laptop, so `scripts/release.mjs` no longer stands in front of it.
 * Its checks move here rather than being lost: a clean tree, a commit on `main`, and the
 * release gate on this exact commit. Required CI is added, and so is the native check: the
 * cloud fingerprint has to be the runtime of the live binary, in `config/live-runtimes.json`.
 *
 * **Two stages, because the fingerprint job runs the commit.** It installs dependencies and
 * evaluates `app.config.ts` in the production environment, so an unreviewed ref would be running
 * with production credentials before a single gate at the end could refuse it. `release.mjs`
 * admits a commit before invoking EAS for the same reason. Preflight runs in `development`.
 *
 * `config/live-runtimes.json` is read from the checkout, so it is the reviewed copy at this
 * exact commit. EAS's `get-build` job was tried first and returned nothing for this project, and
 * "a build exists" is a weaker claim than "this is the binary in the stores" anyway.
 *
 * **Unknown is not permission.** As in `release.mjs`, a GitHub read that fails is a refusal.
 * Anything this script cannot prove is a problem, on the production lane.
 *
 * It reads public GitHub data with no token, so no credential has to be added to EAS. EAS
 * machines can share an unauthenticated rate limit; a refusal for that reason names the
 * status and is safe to run again.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = 'fourwardhabits/bingd';

/**
 * What each lane treats as fatal. Everything else it still checks is printed as a note.
 *
 * `production-check` is `ota-production-check.yml`, which reads production runtimes for a
 * reviewed pull request head before the founder decides. It runs with production variables, so
 * it needs CI and the release gate, and it cannot need `main`, because the commit is not there
 * yet. It has no publish job.
 */
const LANES = {
  production: { platforms: ['android', 'ios'], releaseChecks: true, onMain: true },
  'production-check': { platforms: [], releaseChecks: true, onMain: false },
  preview: { platforms: ['android'], releaseChecks: false, onMain: true },
};

/** Which runs can stand for a commit. A fork's pull request can carry any head SHA. */
const RUNS = [
  { name: 'CI', file: 'ci.yml', events: ['pull_request', 'push'] },
  { name: 'Release gate', file: 'release-gate.yml', events: ['workflow_dispatch', 'push'] },
];

async function readJson(fetchImpl, path) {
  const response = await fetchImpl(`https://api.github.com/repos/${REPO}${path}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'bingd-ota-gate' },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`);
  return response.json();
}

async function runProblem(fetchImpl, { name, file, events }, sha) {
  const { workflow_runs: runs } = await readJson(
    fetchImpl,
    `/actions/workflows/${file}/runs?head_sha=${sha}&per_page=30`,
  );
  const own = runs.filter(
    (run) =>
      run.head_sha === sha &&
      run.head_repository?.full_name === REPO &&
      events.includes(run.event),
  );
  if (own.some((run) => run.status === 'completed' && run.conclusion === 'success'))
    return null;
  if (own.some((run) => run.status !== 'completed')) return `${name} is still running.`;
  return own.length
    ? `${name} did not pass: ${own[0].conclusion}, ${own[0].html_url}`
    : `No ${name} run exists for this commit.`;
}

/**
 * The checkout is the proof of what this run holds. `github.sha` cannot be: Expo documents it
 * as empty on an `eas workflow:run`, and it was on the runs measured here.
 */
function identityProblems(sha, git) {
  if (!/^[0-9a-f]{40}$/.test(sha)) return [`sha must be a full commit hash, got "${sha}"`];
  const problems = [];
  try {
    const head = git('rev-parse', 'HEAD');
    if (head !== sha) problems.push(`The checkout is ${head}, not ${sha}.`);
    const dirty = git('status', '--porcelain');
    if (dirty) problems.push(`The checkout is not clean:\n${dirty}`);
  } catch (error) {
    problems.push(
      `Could not read the checkout: ${String(error.message ?? error).split('\n')[0]}`,
    );
  }
  return problems;
}

/**
 * Both stages are pure apart from what they are handed, so every refusal has a test. `git` is
 * the checkout on the EAS machine, `env` is the job's environment, and `live` is
 * `config/live-runtimes.json`.
 */
export async function preflight({ env, git, fetchImpl }) {
  const lane = LANES[env.OTA_LANE];
  if (!lane) return { fatal: [`Unknown lane: ${env.OTA_LANE}`], notes: [] };

  const sha = env.OTA_SHA ?? '';
  const fatal = identityProblems(sha, git);
  const notes = [];
  if (!/^[0-9a-f]{40}$/.test(sha)) return { fatal, notes };

  const release = lane.releaseChecks ? fatal : notes;
  try {
    if (lane.onMain) {
      const { status } = await readJson(fetchImpl, `/compare/main...${sha}`);
      if (status !== 'identical' && status !== 'behind') {
        release.push(`${sha} is not on main: compare says "${status}".`);
      }
    }
    for (const run of RUNS) {
      const problem = await runProblem(fetchImpl, run, sha);
      if (problem) release.push(problem);
    }
  } catch (error) {
    release.push(`Could not read GitHub, so nothing there counts as passed: ${error.message}`);
  }

  return { fatal, notes };
}

export async function runtimes({ env, git, live }) {
  const lane = LANES[env.OTA_LANE];
  if (!lane) return { fatal: [`Unknown lane: ${env.OTA_LANE}`], notes: [] };

  const fatal = identityProblems(env.OTA_SHA ?? '', git);
  const notes = [];

  for (const platform of ['android', 'ios']) {
    const runtime = env[`OTA_${platform.toUpperCase()}_RUNTIME`];
    const binary = live[env.OTA_LANE]?.[platform];
    const problem = !runtime
      ? `${platform}: the cloud fingerprint produced nothing.`
      : !binary
        ? `${platform}: config/live-runtimes.json lists no ${env.OTA_LANE} binary.`
        : runtime !== binary.runtime
          ? `${platform}: runtime ${runtime} is not the live ${binary.version}, ${binary.runtime}. Something native changed, and that needs a binary, not an update.`
          : null;
    if (!problem) console.log(`${platform}: runtime ${runtime} is ${binary.version}`);
    else if (lane.platforms.includes(platform)) fatal.push(problem);
    else notes.push(problem);
  }

  return { fatal, notes };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stage = process.argv[2];
  const stages = { preflight, runtimes };
  if (!Object.hasOwn(stages, stage)) {
    console.error('usage: node scripts/ota-gate.mjs <preflight|runtimes>');
    process.exit(2);
  }
  const { fatal, notes } = await stages[stage]({
    env: process.env,
    git: (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim(),
    fetchImpl: fetch,
    live: JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '../config/live-runtimes.json'),
        'utf8',
      ),
    ),
  });
  for (const note of notes) console.log(`note: ${note}`);
  if (fatal.length) {
    console.error(`\nRefusing at ${stage} on the ${process.env.OTA_LANE} lane.\n`);
    for (const problem of fatal) console.error(`  - ${problem}\n`);
    process.exit(1);
  }
  console.log(`\n${process.env.OTA_LANE}: ${stage} passed for ${process.env.OTA_SHA}`);
}
