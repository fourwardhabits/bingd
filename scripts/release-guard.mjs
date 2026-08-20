#!/usr/bin/env node
/**
 * Refuses to build or update the Beta lane from a tree that is not releasable.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS HONESTLY NOT
 *
 * Independent review 28 raised a BLOCKER against the sentence *"Development work cannot
 * reach a Preview or Beta phone"*, and it was right. Channels stop a **development-channel
 * update** from reaching a Beta build. They do nothing whatever about somebody running
 * `eas update --branch beta` from a half-finished checkout, which is the way unfinished
 * code actually reaches a friend's phone.
 *
 * **This does not make that impossible and nothing in a repository can.** `eas` is a
 * command anybody can type. What it does is make the documented path refuse, so that
 * publishing an unreviewed tree to friend testers becomes a deliberate act — somebody
 * bypassing a check that told them why — rather than a Tuesday afternoon.
 *
 * That distinction is the whole claim, and the documents now say exactly that instead of
 * "cannot".
 * ---------------------------------------------------------------------------
 *
 *   npm run build:beta -- --platform android
 *   npm run update:beta -- --message "what changed"
 *
 * Three checks, in increasing order of what they cost to satisfy:
 *
 *   1. The working tree is clean. An `eas update` publishes the files on disk, so an
 *      uncommitted experiment ships and nothing records what was in it.
 *   2. HEAD is on `main` or a `release/*` branch. Not a proof of review — a proof that
 *      somebody chose this branch for release.
 *   3. The release gate passed for **this exact commit**. Not for the branch, not for a
 *      recent run: `gh run list --commit <sha>`. A gate that passed two commits ago is a
 *      gate that did not run on what is about to ship.
 *
 * Check 3 needs the GitHub CLI and a pushed commit. Where it cannot run it says so and
 * refuses, rather than passing quietly — an unverifiable gate reported as green is worse
 * than no gate, and this file exists because of a finding about exactly that shape of
 * claim.
 */
import { execFileSync } from 'node:child_process';

const WORKFLOW = 'release-gate.yml';
const RELEASABLE = /^(main|release\/.+)$/;

const problems = [];
const notes = [];

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

// ---------------------------------------------------------------------------
// 1. A clean tree
// ---------------------------------------------------------------------------

const dirty = git('status', '--porcelain', '--untracked-files=no');
if (dirty) {
  problems.push(
    'The working tree has uncommitted changes:\n' +
      dirty
        .split('\n')
        .map((line) => `      ${line}`)
        .join('\n') +
      '\n    `eas update` publishes what is on disk. Commit or stash first.',
  );
}

// ---------------------------------------------------------------------------
// 2. A branch somebody chose for release
// ---------------------------------------------------------------------------

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const sha = git('rev-parse', 'HEAD');

if (!RELEASABLE.test(branch)) {
  problems.push(
    `HEAD is on "${branch}". The Beta lane is released from "main" or "release/*".\n` +
      '    This is not a review gate — it is a check that somebody chose this branch.',
  );
}

// ---------------------------------------------------------------------------
// 3. The release gate, on this exact commit
// ---------------------------------------------------------------------------

let gateVerdict = null;
try {
  const raw = execFileSync(
    'gh',
    ['run', 'list', '--workflow', WORKFLOW, '--commit', sha, '--limit', '10', '--json', 'conclusion,status,url'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const runs = JSON.parse(raw);
  const success = runs.find((r) => r.status === 'completed' && r.conclusion === 'success');
  if (success) {
    gateVerdict = `passed — ${success.url}`;
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
        `    Push the commit, then: gh workflow run ${WORKFLOW} --ref ${branch}`,
    );
  }
} catch (error) {
  // The GitHub CLI is missing, unauthenticated, or the commit is not pushed. Every one of
  // those means the gate's result is unknown, and unknown is not permission.
  problems.push(
    'Could not read the release gate from GitHub, so it cannot be treated as passed.\n' +
      `    ${String(error.message ?? error).split('\n')[0]}\n` +
      '    Push the commit and authenticate `gh`, or run the suite locally and see\n' +
      '    docs/release/safe-update-runbook.md §6 for what that is.',
  );
}

// ---------------------------------------------------------------------------

if (problems.length === 0) {
  notes.push(`branch      ${branch}`);
  notes.push(`commit      ${sha.slice(0, 12)}`);
  notes.push(`release gate ${gateVerdict}`);
  console.log('\nBeta release checks passed.\n');
  for (const note of notes) console.log(`  ${note}`);
  console.log('');
  process.exit(0);
}

console.error('\nRefusing to touch the Beta lane. Friend testers install what this publishes.\n');
for (const problem of problems) console.error(`  - ${problem}\n`);
console.error(
  '  Preview is the lane for trying things: `eas build --profile preview`,\n' +
    '  `eas update --branch preview --environment preview`. Nobody but the founder\n' +
    '  receives those.\n',
);
process.exit(1);
