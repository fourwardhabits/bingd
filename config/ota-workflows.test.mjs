import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { REPO, evaluate } from '../scripts/ota-gate.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eas = JSON.parse(readFileSync(join(root, 'eas.json'), 'utf8'));

const read = (lane) => readFileSync(join(root, `.eas/workflows/ota-${lane}.yml`), 'utf8');

const withoutComments = (yaml) =>
  yaml
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

/** One top-level `jobs:` entry, as text. A parser would be a dependency for four greps. */
function job(yaml, name) {
  const body = yaml.slice(yaml.indexOf('\njobs:\n'));
  const match = body.match(new RegExp(`\\n  ${name}:\\n((?:    .*\\n|\\s*\\n|\\s*#.*\\n)*)`));
  assert.ok(match, `no job named ${name}`);
  return match[1];
}

const SHA = 'a'.repeat(40);

const passing = {
  OTA_LANE: 'production',
  OTA_SHA: SHA,
  OTA_RUN_SHA: SHA,
  OTA_ANDROID_RUNTIME: 'android-runtime',
  OTA_IOS_RUNTIME: 'ios-runtime',
  OTA_ANDROID_BUILD: 'android-build',
  OTA_IOS_BUILD: 'ios-build',
};

const run = (overrides = {}) => ({
  head_sha: SHA,
  head_repository: { full_name: REPO },
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://example.invalid/run',
  ...overrides,
});

const github =
  ({
    compare = 'identical',
    ci = [run()],
    gate = [run({ event: 'workflow_dispatch' })],
  } = {}) =>
  async (url) => {
    const json = url.includes('/compare/')
      ? { status: compare }
      : { workflow_runs: url.includes('/ci.yml/') ? ci : gate };
    return { ok: true, json: async () => json };
  };

const cleanGit = (...args) => (args[0] === 'rev-parse' ? SHA : '');

const gate = (env = {}, { git = cleanGit, fetchImpl = github() } = {}) =>
  evaluate({ env: { ...passing, ...env }, git, fetchImpl });

describe('the OTA workflows', () => {
  for (const lane of ['preview', 'production']) {
    const yaml = read(lane);
    const profile = eas.build[lane];

    it(`${lane}: can only be started by hand`, () => {
      const on = yaml.slice(yaml.indexOf('\non:\n'), yaml.indexOf('\njobs:\n'));
      assert.match(on, /^\non:\n {2}workflow_dispatch:\n/);
      assert.deepEqual(on.match(/^ {2}[a-z_]+:/gm), ['  workflow_dispatch:']);
    });

    it(`${lane}: names the destination itself, agreeing with eas.json`, () => {
      const publish = job(yaml, 'publish');
      assert.match(publish, new RegExp(`\\n      branch: ${profile.channel}\\n`));
      assert.doesNotMatch(publish, /\b(branch|channel|platform):.*\$\{\{/);
      assert.doesNotMatch(yaml, /\$\{\{ inputs\.(?!sha |message )/);
    });

    for (const name of ['fingerprint', 'publish']) {
      it(`${lane}: ${name} resolves the lane the way a build does`, () => {
        const body = job(yaml, name);
        assert.match(body, new RegExp(`environment: ${profile.environment}\\n`));
        assert.match(body, new RegExp(`APP_VARIANT: ${profile.env.APP_VARIANT}\\n`));
        assert.match(body, new RegExp(`BINGD_LANE: ${profile.env.BINGD_LANE}\\n`));
      });
    }

    it(`${lane}: publishes only behind the gate`, () => {
      assert.match(job(yaml, 'publish'), /needs: \[gate\]/);
      assert.match(job(yaml, 'gate'), /node scripts\/ota-gate\.mjs/);
      assert.match(job(yaml, 'gate'), new RegExp(`OTA_LANE: ${lane}\\n`));
    });

    it(`${lane}: looks the fingerprint up on that lane's own builds`, () => {
      for (const name of ['android_build', 'ios_build']) {
        assert.match(job(yaml, name), new RegExp(`profile: ${lane}\\n`));
        assert.match(
          job(yaml, name),
          new RegExp(`distribution: ${profile.distribution}\\n`, 'i'),
        );
      }
    });
  }

  it('the two differ only in the lane, once the comments are gone', () => {
    const normal = (lane, distribution) =>
      withoutComments(read(lane))
        .replaceAll(lane, 'LANE')
        .replaceAll(distribution, 'DISTRIBUTION');
    assert.equal(normal('production', 'store'), normal('preview', 'internal'));
  });

  it('the production check can only be started by hand, and cannot publish', () => {
    const yaml = withoutComments(read('production-check'));
    assert.deepEqual(
      yaml
        .slice(yaml.indexOf('\non:\n'))
        .match(/^ {2}[a-z_]+:/gm)
        .slice(0, 1),
      ['  workflow_dispatch:'],
    );
    assert.doesNotMatch(yaml, /\b(push|schedule|pull_request):/);
    assert.doesNotMatch(yaml, /type: update|eas update|\bsteps:/);
  });

  it('the production check hashes what the publish would ship', () => {
    const fingerprint = (lane) => job(withoutComments(read(lane)), 'fingerprint').trim();
    assert.equal(fingerprint('production-check'), fingerprint('production'));
  });

  it('the production gate job holds no production variables', () => {
    assert.match(job(read('production'), 'gate'), /environment: development\n/);
  });

  it('commits no secret, and no store of one', () => {
    for (const lane of ['preview', 'production']) {
      assert.doesNotMatch(
        withoutComments(read(lane)),
        /GOOGLE_SERVICES|SENTRY_AUTH|EXPO_TOKEN|secrets\./,
      );
    }
  });
});

describe('the OTA gate', () => {
  it('passes a commit with everything in place', async () => {
    assert.deepEqual(await gate(), { fatal: [], notes: [] });
  });

  it('accepts a commit behind main, which is how a merged PR head looks', async () => {
    assert.deepEqual((await gate({}, { fetchImpl: github({ compare: 'behind' }) })).fatal, []);
  });

  it('accepts the pull_request CI run that main requires', async () => {
    const fetchImpl = github({ ci: [run({ event: 'pull_request' })] });
    assert.deepEqual((await gate({}, { fetchImpl })).fatal, []);
  });

  const refusals = [
    ['a short sha', { env: { OTA_SHA: 'aaaaaaa' } }, /full commit hash/],
    ['a run on another commit', { env: { OTA_RUN_SHA: 'b'.repeat(40) } }, /The run is on/],
    ['a run with no commit', { env: { OTA_RUN_SHA: '' } }, /The run is on/],
    ['another checkout', { git: () => 'b'.repeat(40) }, /The checkout is b+, not/],
    [
      'a dirty checkout',
      { git: (...a) => (a[0] === 'rev-parse' ? SHA : ' M src/a.ts') },
      /not clean/,
    ],
    [
      'an unreadable checkout',
      {
        git: () => {
          throw new Error('no git');
        },
      },
      /Could not read the checkout/,
    ],
    ['no Android fingerprint', { env: { OTA_ANDROID_RUNTIME: '' } }, /android: the cloud/],
    ['no Android store build', { env: { OTA_ANDROID_BUILD: '' } }, /android: no production/],
    ['no iOS store build', { env: { OTA_IOS_BUILD: '' } }, /ios: no production/],
    ['a commit off main', { fetchImpl: github({ compare: 'ahead' }) }, /not on main/],
    ['a diverged commit', { fetchImpl: github({ compare: 'diverged' }) }, /not on main/],
    [
      'failed CI',
      { fetchImpl: github({ ci: [run({ conclusion: 'failure' })] }) },
      /CI did not/,
    ],
    ['no CI', { fetchImpl: github({ ci: [] }) }, /No CI run/],
    [
      'a running gate',
      { fetchImpl: github({ gate: [run({ status: 'in_progress', conclusion: null })] }) },
      /still running/,
    ],
    [
      'a failed gate',
      {
        fetchImpl: github({
          gate: [run({ event: 'workflow_dispatch', conclusion: 'failure' })],
        }),
      },
      /Release gate did not pass/,
    ],
    ['no gate', { fetchImpl: github({ gate: [] }) }, /No Release gate run/],
    [
      'a gate run for another commit',
      { fetchImpl: github({ gate: [run({ head_sha: 'b'.repeat(40) })] }) },
      /No Release gate run/,
    ],
    [
      "a fork's green run",
      {
        fetchImpl: github({
          ci: [run({ event: 'pull_request', head_repository: { full_name: 'x/bingd' } })],
        }),
      },
      /No CI run/,
    ],
    [
      'a gate-looking run from a pull request',
      { fetchImpl: github({ gate: [run({ event: 'pull_request' })] }) },
      /No Release gate run/,
    ],
    [
      'GitHub refusing the read',
      { fetchImpl: async () => ({ ok: false, status: 403 }) },
      /Could not read GitHub.*403/,
    ],
    [
      'GitHub being unreachable',
      {
        fetchImpl: async () => {
          throw new Error('offline');
        },
      },
      /Could not read GitHub.*offline/,
    ],
  ];

  for (const [name, { env, ...deps }, expected] of refusals) {
    it(`refuses ${name}`, async () => {
      const { fatal } = await gate(env, deps);
      assert.match(fatal.join('\n'), expected);
    });
  }

  it('refuses a lane it does not know', async () => {
    assert.match((await gate({ OTA_LANE: 'beta' })).fatal.join(), /Unknown lane/);
  });

  describe('on Preview, where unreleased work belongs', () => {
    const preview = { OTA_LANE: 'preview' };

    it('reports the release checks rather than refusing on them', async () => {
      const fetchImpl = github({ compare: 'ahead', ci: [], gate: [] });
      const { fatal, notes } = await gate(preview, { fetchImpl });
      assert.deepEqual(fatal, []);
      assert.equal(notes.length, 3);
    });

    it('still reports an unreachable GitHub without refusing', async () => {
      const fetchImpl = async () => ({ ok: false, status: 403 });
      const { fatal, notes } = await gate(preview, { fetchImpl });
      assert.deepEqual(fatal, []);
      assert.match(notes.join(), /Could not read GitHub/);
    });

    it('reports no iOS build rather than refusing', async () => {
      const { fatal, notes } = await gate({ ...preview, OTA_IOS_BUILD: '' });
      assert.deepEqual(fatal, []);
      assert.match(notes.join(), /ios: no preview build/);
    });

    it('still refuses no Android build, wrong code and a dirty tree', async () => {
      assert.match(
        (await gate({ ...preview, OTA_ANDROID_BUILD: '' })).fatal.join(),
        /android: no preview build/,
      );
      assert.match(
        (await gate({ ...preview, OTA_RUN_SHA: 'b'.repeat(40) })).fatal.join(),
        /The run is on/,
      );
      const git = (...a) => (a[0] === 'rev-parse' ? SHA : '?? new.ts');
      assert.match((await gate(preview, { git })).fatal.join(), /not clean/);
    });
  });
});
