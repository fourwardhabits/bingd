import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * What may run beside a production credential (security audit 2026-11-01, M-6).
 *
 * The service-role key bypasses every row policy and this repository is public, so these
 * are properties of the files rather than habits. Read as text, because the failure being
 * guarded is somebody adding one ordinary-looking line.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = join(root, '.github', 'workflows');
const workflows = readdirSync(workflowsDir)
  .filter((name) => name.endsWith('.yml'))
  .map((name) => ({ name, text: readFileSync(join(workflowsDir, name), 'utf8') }));

/** The job blocks of a workflow, split on the two-space keys under `jobs:`. */
const jobsOf = (text) => {
  const body = text.slice(text.indexOf('\njobs:'));
  return body.split(/\n(?= {2}[a-z][\w-]*:\n)/).slice(1);
};

describe('GitHub Actions', () => {
  it('pins every action to a commit', () => {
    for (const { name, text } of workflows) {
      for (const [, action] of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
        assert.match(action, /@[0-9a-f]{40}$/, `${name}: ${action} is not pinned to a commit`);
      }
    }
  });

  it('runs no package install in a job that holds a secret', () => {
    // Install scripts execute third-party code, and a step can hand the next one anything
    // through GITHUB_ENV, so this has to hold for the whole job and not only the step.
    for (const { name, text } of workflows) {
      for (const job of jobsOf(text)) {
        if (!job.includes('secrets.')) continue;
        assert.doesNotMatch(job, /\bnpm (ci|i|install)\b|\byarn\b|\bpnpm\b/, `${name} installs beside a secret`);
        assert.doesNotMatch(job, /cache:\s*npm/, `${name} restores a shared cache beside a secret`);
      }
    }
  });

  it('keeps every production secret behind the production environment', () => {
    for (const { name, text } of workflows) {
      for (const job of jobsOf(text)) {
        if (!/secrets\.\w*_PRODUCTION/.test(job)) continue;
        assert.match(job, /^ {4}environment:.*production/m, `${name} reads a production secret outside it`);
      }
    }
  });

  it('leaves no job token on disk where a secret is in reach', () => {
    for (const { name, text } of workflows) {
      for (const job of jobsOf(text)) {
        if (!job.includes('secrets.')) continue;
        assert.match(job, /persist-credentials:\s*false/, `${name} keeps its checkout credentials`);
      }
    }
  });

  it('has no trigger that hands a fork this repository’s secrets', () => {
    for (const { name, text } of workflows) {
      assert.doesNotMatch(text, /pull_request_target|workflow_run/, name);
    }
  });
});

describe('the trending job', () => {
  it('needs nothing that an install would provide', () => {
    // The reason `npm ci` could go. A package import here would fail at runtime on the first
    // scheduled run, so this says so on the pull request instead.
    const script = readFileSync(join(root, 'supabase', 'seed', 'refresh-trending.mjs'), 'utf8');
    const imports = [...script.matchAll(/^import .* from '([^']+)';$/gm)].map(([, from]) => from);
    const requires = [...script.matchAll(/\brequire\('([^']+)'\)/g)].map(([, from]) => from);

    assert.ok(imports.length > 0, 'the import scan found nothing, so it is not reading this file');
    for (const from of imports) assert.match(from, /^node:/, from);
    for (const from of requires) assert.match(from, /^\.\.\/\.\.\/config\//, from);
  });

  it('reads config files that need nothing either', () => {
    for (const file of ['backends.cjs', 'production-lane.cjs']) {
      const source = readFileSync(join(root, 'config', file), 'utf8');
      for (const [, from] of source.matchAll(/\brequire\('([^']+)'\)/g)) {
        assert.match(from, /^\.\/|^node:/, `${file} requires ${from}`);
      }
    }
  });
});
