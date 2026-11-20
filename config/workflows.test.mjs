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

  it('keeps every staging secret behind the nonprod environment', () => {
    for (const { name, text } of workflows) {
      for (const job of jobsOf(text)) {
        if (!/secrets\.\w*_NONPROD/.test(job)) continue;
        assert.match(job, /^ {4}environment:.*nonprod/m, `${name} reads a staging secret outside it`);
      }
    }
  });

  it('runs no job with a secret outside an environment', () => {
    let held = 0;
    for (const { name, text } of workflows) {
      for (const job of jobsOf(text)) {
        if (!job.includes('secrets.')) continue;
        held += 1;
        assert.match(job, /^ {4}environment:/m, `${name} holds a secret with no environment`);
      }
    }
    assert.ok(held > 0, 'the scan found no job with a secret, so it is not reading these files');
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

  it('gives every workflow a read-only job token', () => {
    // Security register 2026-11-20, B-3. Without a `permissions:` block a job's GITHUB_TOKEN
    // gets the repository default, which is a setting nobody reviews, and ci.yml runs `npm ci`
    // (every dependency's install scripts) beside it. Read-only at the top of each file; a
    // job that one day needs more says so in its own block, in review.
    for (const { name, text } of workflows) {
      const block = text.match(/^permissions:\n((?: {2}.*\n)+)/m);
      assert.ok(block, `${name} has no top-level permissions block`);
      const grants = [...block[1].matchAll(/^ {2}([a-z-]+):\s*(\S+)/gm)];
      assert.ok(grants.length > 0, `${name}: the permissions block is empty`);
      for (const [, scope, level] of grants) {
        assert.ok(['read', 'none'].includes(level), `${name} grants ${scope}: ${level}`);
      }
    }
    for (const { name, text } of workflows) {
      for (const job of jobsOf(text)) {
        assert.doesNotMatch(job, /:\s*write\b/, `${name}: a job asks for a write scope`);
      }
    }
  });

  /**
   * Only `main`'s copy of a workflow runs with a secret (security register 2026-11-20, B-2).
   *
   * The `production` and `nonprod` Environments are restricted to `main` in the repository
   * settings, which this repository cannot test. A token that may dispatch workflows can name
   * any branch or tag as the ref, so each job that holds a secret also refuses, in its own
   * `if:`, to run anywhere but `main`. The expressions are evaluated here, the way the welcome
   * test evaluates its own, rather than compared as text.
   */
  it('runs a job that holds a secret only on main', () => {
    const conditionOf = (job) => {
      const lines = job.split('\n');
      const at = lines.findIndex((l) => /^ {4}if:/.test(l));
      if (at < 0) return null;
      const head = lines[at].replace(/^ {4}if:\s*/, '');
      if (head !== '>-') return head.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
      const rest = [];
      for (const l of lines.slice(at + 1)) {
        if (!/^ {6}/.test(l)) break;
        rest.push(l.trim());
      }
      return rest.join(' ');
    };
    const evaluate = (source, ctx) =>
      new Function(
        'ctx', 'contains', 'fromJSON',
        `return ${source
          .replace(/github\.ref\b/g, 'ctx.ref')
          .replace(/github\.event_name/g, 'ctx.event')
          .replace(/github\.event\.inputs\.(\w+)/g, 'ctx.inputs.$1')
          .replace(/vars\.(\w+)/g, 'ctx.vars.$1')};`,
      )(ctx, (list, item) => list.includes(item), (s) => JSON.parse(s));

    const triggers = [
      ['schedule', {}],
      ...['nonprod', 'production', 'both'].flatMap((target) =>
        ['dry-run', 'send'].map((mode) => ['workflow_dispatch', { target, mode, canary: 'false' }])),
    ];
    let held = 0;
    for (const { name, text } of workflows) {
      for (const job of jobsOf(text)) {
        if (!job.includes('secrets.')) continue;
        held += 1;
        const label = `${name} ${job.match(/^ {2}([\w-]+):/)?.[1]}`;
        const condition = conditionOf(job);
        assert.ok(condition, `${label} holds a secret and has no if:`);
        const vars = { BINGD_PRODUCTION_TRENDING: 'true' };
        for (const ref of ['refs/heads/feature/x', 'refs/heads/main-copy', 'refs/tags/v1', 'refs/pull/1/merge']) {
          for (const [event, inputs] of triggers) {
            assert.equal(Boolean(evaluate(condition, { ref, event, inputs, vars })), false,
              `${label} runs on ${ref} for ${event} ${JSON.stringify(inputs)}`);
          }
        }
        // And the guard has not switched the job off where it belongs.
        const onMain = triggers.some(([event, inputs]) =>
          Boolean(evaluate(condition, { ref: 'refs/heads/main', event, inputs, vars })));
        assert.ok(onMain, `${label} no longer runs on main at all`);
      }
    }
    assert.ok(held >= 3, 'the scan found too few jobs with a secret, so it is not reading these files');
  });
});

describe('the welcome job', () => {
  const text = readFileSync(join(workflowsDir, 'welcome-email.yml'), 'utf8');

  it('takes no address and no account id as a dispatch input', () => {
    // The repository is public: a dispatch input, and every value the job's env block
    // names, is printed in a log anybody can read. The canary is resolved by the worker
    // from welcome.canary_addresses instead (--canary-from-allowlist).
    const inputs = text.slice(text.indexOf('    inputs:'), text.indexOf('\nconcurrency:'));
    const names = [...inputs.matchAll(/^ {6}([a-z_]+):\n/gm)].map(([, name]) => name);
    assert.deepEqual(names.sort(), ['canary', 'mode', 'target']);
    assert.doesNotMatch(inputs, /type:\s*string/, 'a free-text input could carry an address');
  });

  it('reads the canary account only from masked Environment secrets', () => {
    const used = [...text.matchAll(/github\.event\.inputs\.([a-z_]+)/g)].map(([, name]) => name);
    assert.ok(used.length > 0, 'the scan found no input use, so it is not reading this file');
    for (const name of used) assert.ok(['canary', 'mode', 'target'].includes(name), name);
    assert.match(text, /CANARY_USER: \$\{\{ github\.event\.inputs\.canary == 'true' && secrets\.WELCOME_CANARY_USER \|\| '' \}\}/);
    assert.match(text, /CANARY_EMAIL: \$\{\{ github\.event\.inputs\.canary == 'true' && secrets\.WELCOME_CANARY_EMAIL \|\| '' \}\}/);
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
