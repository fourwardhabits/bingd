import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { REPO, evaluate } from '../scripts/ota-gate.mjs';
import { scan } from '../scripts/ota-log-scan.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eas = JSON.parse(readFileSync(join(root, 'eas.json'), 'utf8'));
const liveRuntimes = JSON.parse(readFileSync(join(root, 'config/live-runtimes.json'), 'utf8'));

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
  OTA_ANDROID_RUNTIME: 'android-runtime',
  OTA_IOS_RUNTIME: 'ios-runtime',
};

const live = {
  production: {
    android: { runtime: 'android-runtime', version: '1.1.0 (15)' },
    ios: { runtime: 'ios-runtime', version: '1.1.0 (15)' },
  },
  preview: { android: { runtime: 'android-runtime', version: '1.1.0 (10)' } },
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
  evaluate({ env: { ...passing, ...env }, git, fetchImpl, live });

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

    it(`${lane}: the gate is handed both of the job's hashes`, () => {
      const body = job(yaml, 'gate');
      assert.match(body, /needs: \[fingerprint\]/);
      for (const [name, output] of [
        ['ANDROID', 'android'],
        ['IOS', 'ios'],
      ]) {
        assert.match(
          body,
          new RegExp(
            `OTA_${name}_RUNTIME: \\$\\{\\{ needs\\.fingerprint\\.outputs\\.${output}_fingerprint_hash \\}\\}\\n`,
          ),
        );
      }
    });
  }

  it('the two differ only in the lane, once the comments are gone', () => {
    const normal = (lane) => withoutComments(read(lane)).replaceAll(lane, 'LANE');
    assert.equal(normal('production'), normal('preview'));
  });

  it('names both live store binaries by full runtime', () => {
    for (const platform of ['android', 'ios']) {
      assert.match(liveRuntimes.production[platform].runtime, /^[0-9a-f]{40}$/);
      assert.match(liveRuntimes.production[platform].build, /^[0-9a-f-]{36}$/);
    }
    assert.match(liveRuntimes.preview.android.runtime, /^[0-9a-f]{40}$/);
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
    ['no iOS fingerprint', { env: { OTA_IOS_RUNTIME: '' } }, /ios: the cloud/],
    [
      'a native change on Android',
      { env: { OTA_ANDROID_RUNTIME: 'new' } },
      /android: runtime new/,
    ],
    ['a native change on iOS', { env: { OTA_IOS_RUNTIME: 'new' } }, /ios: runtime new/],
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
      assert.match(notes.join(), /not on main/);
      assert.match(notes.join(), /No CI run/);
      assert.match(notes.join(), /No Release gate run/);
    });

    it('still reports an unreachable GitHub without refusing', async () => {
      const fetchImpl = async () => ({ ok: false, status: 403 });
      const { fatal, notes } = await gate(preview, { fetchImpl });
      assert.deepEqual(fatal, []);
      assert.match(notes.join(), /Could not read GitHub/);
    });

    it('reports no iOS binary rather than refusing', async () => {
      const { fatal, notes } = await gate(preview);
      assert.deepEqual(fatal, []);
      assert.match(notes.join(), /ios: config\/live-runtimes\.json lists no preview binary/);
    });

    it('still refuses another Android runtime, wrong code and a dirty tree', async () => {
      assert.match(
        (await gate({ ...preview, OTA_ANDROID_RUNTIME: 'new' })).fatal.join(),
        /android: runtime new/,
      );
      const elsewhere = () => 'b'.repeat(40);
      assert.match(
        (await gate(preview, { git: elsewhere })).fatal.join(),
        /The checkout is b+/,
      );
      const git = (...a) => (a[0] === 'rev-parse' ? SHA : '?? new.ts');
      assert.match((await gate(preview, { git })).fatal.join(), /not clean/);
    });
  });
});

describe('the log scan', () => {
  it('passes what EAS really prints for masked and file variables', () => {
    const log = [
      'SENTRY_AUTH_TOKEN=********',
      'EXPO_TOKEN=********',
      'GOOGLE_SERVICES_JSON=/home/expo/workingdir/eas-environment-secrets/abc',
      'EXPO_PUBLIC_SUPABASE_URL=https://example.supabase.co',
    ].join('\n');
    assert.deepEqual(scan(log), {});
  });

  it('finds a secret and hands back no part of it', () => {
    const value = 'sntrys_abc123';
    const found = scan(`SENTRY_AUTH_TOKEN=${value}\nAPI AIzaSyA1234567890123456789012345`);
    assert.deepEqual(found, {
      'Sentry token': 1,
      'Google API key': 1,
      'unmasked token variable': 1,
    });
    assert.doesNotMatch(JSON.stringify(found), /abc123|AIza/);
  });

  it('finds the contents of google-services.json', () => {
    assert.deepEqual(scan('"mobilesdk_app_id": "1:2:android:3"'), {
      'google-services.json contents': 1,
    });
  });

  it('finds any unmasked token, whatever it looks like', () => {
    assert.deepEqual(scan('EXPO_TOKEN=abc\n'), { 'unmasked token variable': 1 });
  });
});
