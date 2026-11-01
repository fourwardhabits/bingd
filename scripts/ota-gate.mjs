#!/usr/bin/env node
/**
 * The gate in front of `.eas/workflows/ota-*.yml`, run on EAS before the publish job.
 *
 * The publish moved off the laptop, so `scripts/release.mjs` no longer stands in front of it.
 * Its checks move here rather than being lost: a clean tree, a commit on `main`, and the
 * release gate on this exact commit. Required CI is added, and so is the native check: the
 * cloud fingerprint has to belong to a store build.
 *
 * **Unknown is not permission.** As in `release.mjs`, a GitHub read that fails is a refusal.
 * Anything this script cannot prove is a problem, on the production lane.
 *
 * It reads public GitHub data with no token, so no credential has to be added to EAS. EAS
 * machines can share an unauthenticated rate limit; a refusal for that reason names the
 * status and is safe to run again.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REPO = 'fourwardhabits/bingd';

/** What each lane treats as fatal. Everything else it still checks is printed as a note. */
const LANES = {
  production: { platforms: ['android', 'ios'], releaseChecks: true },
  preview: { platforms: ['android'], releaseChecks: false },
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
 * Pure apart from what it is handed, so every refusal has a test. `git` is the checkout on the
 * EAS machine; `env` is the job's environment.
 */
export async function evaluate({ env, git, fetchImpl }) {
  const lane = LANES[env.OTA_LANE];
  if (!lane) return { fatal: [`Unknown lane: ${env.OTA_LANE}`], notes: [] };

  const fatal = [];
  const notes = [];
  const sha = env.OTA_SHA ?? '';

  if (!/^[0-9a-f]{40}$/.test(sha)) {
    return { fatal: [`sha must be a full commit hash, got "${sha}"`], notes };
  }

  // Started from anything but `--ref <sha>`, these disagree, and the code is not the approved
  // commit. A local upload of a dirty tree is caught by the status check under it.
  if (env.OTA_RUN_SHA !== sha) fatal.push(`The run is on "${env.OTA_RUN_SHA}", not ${sha}.`);

  try {
    const head = git('rev-parse', 'HEAD');
    if (head !== sha) fatal.push(`The checkout is ${head}, not ${sha}.`);
    const dirty = git('status', '--porcelain');
    if (dirty) fatal.push(`The checkout is not clean:\n${dirty}`);
  } catch (error) {
    fatal.push(`Could not read the checkout: ${String(error.message ?? error).split('\n')[0]}`);
  }

  for (const platform of ['android', 'ios']) {
    const key = platform.toUpperCase();
    const runtime = env[`OTA_${key}_RUNTIME`];
    const build = env[`OTA_${key}_BUILD`];
    const problem = !runtime
      ? `${platform}: the cloud fingerprint produced nothing.`
      : !build
        ? `${platform}: no ${env.OTA_LANE} build has runtime ${runtime}. Anything native has changed, and that needs a binary, not an update.`
        : null;
    if (!problem) console.log(`${platform}: runtime ${runtime} is build ${build}`);
    else if (lane.platforms.includes(platform)) fatal.push(problem);
    else notes.push(problem);
  }

  const release = lane.releaseChecks ? fatal : notes;
  try {
    const { status } = await readJson(fetchImpl, `/compare/main...${sha}`);
    if (status !== 'identical' && status !== 'behind') {
      release.push(`${sha} is not on main: compare says "${status}".`);
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { fatal, notes } = await evaluate({
    env: process.env,
    git: (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim(),
    fetchImpl: fetch,
  });
  for (const note of notes) console.log(`note: ${note}`);
  if (fatal.length) {
    console.error(`\nRefusing to publish the ${process.env.OTA_LANE} lane.\n`);
    for (const problem of fatal) console.error(`  - ${problem}\n`);
    process.exit(1);
  }
  console.log(`\n${process.env.OTA_LANE}: gate passed for ${process.env.OTA_SHA}`);
}
