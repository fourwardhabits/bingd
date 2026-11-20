import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { REPO, preflight, runtimes } from '../scripts/ota-gate.mjs';
import { scan, scanRun } from '../scripts/ota-log-scan.mjs';

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

/** What production has applied, by `config/production-migrations.json`, and a commit that agrees. */
const record = {
  head: '20261130000400',
  count: 2,
  recordedAt: '2026-11-20T00:00:00Z',
  evidence: 'docs/release/example.md',
  versions: ['20261130000300', '20261130000400'],
};
const recorded = [
  'supabase/migrations/20261130000300_a_welcome.sql',
  'supabase/migrations/20261130000400_a_history.sql',
];
const readRecord = () => record;

const cleanGit = (...args) =>
  args[0] === 'rev-parse' ? SHA : args[0] === 'ls-tree' ? recorded.join('\n') : '';
/** A clean checkout of SHA whose supabase/migrations/ holds `paths`. */
const gitWith =
  (paths) =>
  (...args) =>
    args[0] === 'ls-tree' ? paths.join('\n') : cleanGit(...args);

/** Both stages, as a publish runs them. */
const gate = async (env = {}, { git = cleanGit, fetchImpl = github(), ...rest } = {}) => {
  const deps = {
    env: { ...passing, ...env },
    git,
    fetchImpl,
    live,
    readRecord: rest.readRecord ?? readRecord,
  };
  const [first, second] = [await preflight(deps), await runtimes(deps)];
  return {
    fatal: [...first.fatal, ...second.fatal],
    notes: [...first.notes, ...second.notes],
  };
};

describe('the OTA workflows', () => {
  for (const lane of ['preview', 'production']) {
    const yaml = read(lane);
    const profile = eas.build[lane];

    it(`${lane}: can only be started by hand`, () => {
      const on = yaml.slice(yaml.indexOf('\non:\n'), yaml.indexOf('\nconcurrency:\n'));
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

    it(`${lane}: admits the commit before anything reads a ${lane} variable`, () => {
      assert.doesNotMatch(job(yaml, 'preflight'), /needs:/);
      assert.match(job(yaml, 'preflight'), /environment: development\n/);
      assert.match(job(yaml, 'preflight'), /node scripts\/ota-gate\.mjs preflight\n/);
      assert.match(job(yaml, 'preflight'), new RegExp(`OTA_LANE: ${lane}\\n`));
      assert.match(job(yaml, 'fingerprint'), /needs: \[preflight\]/);
    });

    it(`${lane}: publishes only behind the runtime check`, () => {
      assert.match(job(yaml, 'publish'), /needs: \[runtimes\]/);
      assert.match(job(yaml, 'runtimes'), /needs: \[fingerprint\]/);
      assert.match(job(yaml, 'runtimes'), /environment: development\n/);
      assert.match(job(yaml, 'runtimes'), /node scripts\/ota-gate\.mjs runtimes\n/);
      assert.match(job(yaml, 'runtimes'), new RegExp(`OTA_LANE: ${lane}\\n`));
    });

    it(`${lane}: publishes one run at a time, across every commit`, () => {
      assert.match(
        yaml,
        new RegExp(
          `\\nconcurrency:\\n {2}group: ota-${lane}\\n {2}cancel_in_progress: false\\n`,
        ),
      );
    });

    it(`${lane}: the gate is handed both of the job's hashes`, () => {
      const body = job(yaml, 'runtimes');
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

  /**
   * Production publishes Android and iOS together (founder, 2026-11-07, after Android
   * Preview QA passed): `all`, written out in one publish job, so both platforms land as one
   * update group or neither does. Preview stays Android, because no iOS Preview binary is
   * listed for this runtime. Each platform is a fixed value in the file, like the branch, so
   * nothing typed at dispatch can narrow or widen it.
   */
  it('production publishes Android and iOS from one job, fixed in the file', () => {
    const yaml = read('production');
    const publish = job(yaml, 'publish');
    assert.match(publish, /\n {6}platform: all\n/);
    assert.doesNotMatch(publish, /\n {6}platform: (?:android|ios)\n/);
    assert.equal(withoutComments(yaml).match(/\n {4}type: update\n/g)?.length, 1);
  });

  it('production refuses to publish either platform unless both runtimes are live', async () => {
    assert.deepEqual((await gate()).fatal, []);
    for (const name of ['ANDROID', 'IOS']) {
      for (const value of ['', 'new']) {
        const { fatal } = await gate({ [`OTA_${name}_RUNTIME`]: value });
        assert.equal(fatal.length, 1, `${name}=${value || '(none)'} must refuse`);
      }
    }
  });

  it('preview publishes Android only, fixed in the file', () => {
    const publish = job(read('preview'), 'publish');
    assert.match(publish, /\n {6}platform: android\n/);
    assert.doesNotMatch(publish, /\n {6}platform: (?:ios|all)\n/);
  });

  it('the two differ only in the lane and the publish platform, once the comments are gone', () => {
    const normal = (lane, platform) => {
      const yaml = withoutComments(read(lane));
      assert.match(yaml, new RegExp(`\\n {6}platform: ${platform}\\n`));
      return yaml
        .replaceAll(lane, 'LANE')
        .replace(`\n      platform: ${platform}\n`, '\n      platform: PLATFORM\n');
    };
    assert.equal(normal('production', 'all'), normal('preview', 'android'));
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
    assert.doesNotMatch(yaml, /type: update|eas update/);
    assert.deepEqual(yaml.match(/^ {2}[a-z_]+:$/gm).slice(1), [
      '  preflight:',
      '  fingerprint:',
      '  runtimes:',
    ]);
  });

  it('the production check holds both runtimes exactly as a publish would', () => {
    const runtimes = (lane) => job(withoutComments(read(lane)), 'runtimes').trim();
    assert.equal(runtimes('production-check'), runtimes('production'));
  });

  it('pins every file that would otherwise hash differently on an EAS checkout', () => {
    const paths = [
      '.gitignore',
      'config/backends.cjs',
      'config/production-lane.cjs',
      'config/push.cjs',
      'eas.json',
    ];
    const attributes = execFileSync('git', ['check-attr', 'eol', '--', ...paths], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.deepEqual(
      attributes.trim().split('\n'),
      paths.map((path) => `${path}: eol: crlf`),
    );
  });

  it('the production check admits the commit before it reads a production variable', () => {
    const yaml = read('production-check');
    assert.doesNotMatch(job(yaml, 'preflight'), /needs:/);
    assert.match(job(yaml, 'preflight'), /environment: development\n/);
    assert.match(job(yaml, 'preflight'), /OTA_LANE: production-check\n/);
    assert.match(job(yaml, 'preflight'), /node scripts\/ota-gate\.mjs preflight\n/);
  });

  it('the production check hashes what the publish would ship', () => {
    const fingerprint = (lane) => job(withoutComments(read(lane)), 'fingerprint').trim();
    assert.equal(fingerprint('production-check'), fingerprint('production'));
  });

  it('commits no secret, and no store of one', () => {
    for (const lane of ['preview', 'production', 'production-check']) {
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

  it('refuses an unadmitted commit with no fingerprint in hand', async () => {
    const env = { OTA_LANE: 'production', OTA_SHA: SHA };
    const fetchImpl = github({ compare: 'diverged' });
    const { fatal } = await preflight({ env, git: cleanGit, fetchImpl, readRecord });
    assert.match(fatal.join(), /not on main/);
  });

  it('admits a good commit with no fingerprint in hand', async () => {
    const env = { OTA_LANE: 'production', OTA_SHA: SHA };
    const result = await preflight({ env, git: cleanGit, fetchImpl: github(), readRecord });
    assert.deepEqual(result, { fatal: [], notes: [] });
  });

  describe('on the production check, which reads a reviewed head before it merges', () => {
    const env = { OTA_LANE: 'production-check', OTA_SHA: SHA };
    const check = (fetchImpl, git = cleanGit) => preflight({ env, git, fetchImpl, readRecord });

    it('does not need main', async () => {
      const fetchImpl = github({ compare: 'ahead' });
      assert.deepEqual(await check(fetchImpl), { fatal: [], notes: [] });
    });

    it('still refuses without CI or the release gate', async () => {
      assert.match((await check(github({ ci: [] }))).fatal.join(), /No CI run/);
      assert.match((await check(github({ gate: [] }))).fatal.join(), /No Release gate run/);
    });

    it('still refuses another commit or a dirty tree', async () => {
      const elsewhere = () => 'b'.repeat(40);
      assert.match((await check(github(), elsewhere)).fatal.join(), /The checkout is b+/);
      const dirty = (...a) => (a[0] === 'rev-parse' ? SHA : '?? new.ts');
      assert.match((await check(github(), dirty)).fatal.join(), /not clean/);
    });

    it('still refuses when GitHub cannot be read', async () => {
      const fetchImpl = async () => ({ ok: false, status: 403 });
      assert.match((await check(fetchImpl)).fatal.join(), /Could not read GitHub/);
    });
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

describe('the OTA gate, on the database', () => {
  const newer = 'supabase/migrations/20261201000100_follow_story_engagement.sql';
  const older = 'supabase/migrations/20261129000900_a_late_arrival.sql';

  it('passes a commit whose migrations are exactly the ones production has applied', async () => {
    assert.deepEqual(await gate({}, { git: gitWith(recorded) }), { fatal: [], notes: [] });
  });

  it('reads the migrations of the commit being published', async () => {
    const calls = [];
    const git = (...args) => (calls.push(args), cleanGit(...args));
    await preflight({ env: passing, git, fetchImpl: github(), readRecord });
    assert.deepEqual(
      calls.find((args) => args[0] === 'ls-tree'),
      ['ls-tree', '--name-only', SHA, '--', 'supabase/migrations/'],
    );
  });

  it('refuses a migration newer than production, naming it and what to do', async () => {
    const { fatal } = await gate({}, { git: gitWith([...recorded, newer]) });
    assert.equal(fatal.length, 1);
    assert.match(fatal[0], /20261201000100_follow_story_engagement\.sql/);
    assert.match(fatal[0], /newer than production's head 20261130000400/);
    assert.match(
      fatal[0],
      /Apply it to production, record it in config\/production-migrations/,
    );
  });

  it('refuses a migration that sorts below the head but was never applied', async () => {
    const { fatal } = await gate({}, { git: gitWith([older, ...recorded]) });
    assert.match(
      fatal.join(),
      /20261129000900_a_late_arrival\.sql \(older than .*not applied\)/,
    );
  });

  it('names every unapplied migration at once', async () => {
    const { fatal } = await gate({}, { git: gitWith([older, ...recorded, newer]) });
    assert.match(fatal.join(), /these 2 migrations/);
  });

  const refusals = [
    ['a record that cannot be read', { readRecord: () => JSON.parse('{') }, /Could not read/],
    [
      'a record whose head is not its last version',
      { readRecord: () => ({ ...record, head: '20261201000100' }) },
      /says head 20261201000100/,
    ],
    [
      'a record whose count disagrees',
      { readRecord: () => ({ ...record, count: 3 }) },
      /says count 3/,
    ],
    [
      'a record out of order',
      { readRecord: () => ({ ...record, versions: [...record.versions].reverse() }) },
      /ascending order/,
    ],
    ['no record at all', { readRecord: () => null }, /no "versions" list/],
    [
      'a migration whose version cannot be read',
      { git: gitWith([...recorded, 'supabase/migrations/later.sql']) },
      /later\.sql is not named/,
    ],
    [
      'two files with one version',
      { git: gitWith([...recorded, 'supabase/migrations/20261130000400_again.sql']) },
      /Version 20261130000400 is used by/,
    ],
    ['an empty migrations directory', { git: gitWith([]) }, /is empty/],
    [
      'a commit whose migrations cannot be listed',
      {
        git: (...args) => {
          if (args[0] === 'ls-tree') throw new Error('not a tree');
          return cleanGit(...args);
        },
      },
      /Could not list supabase\/migrations\/: not a tree/,
    ],
  ];

  for (const [name, deps, expected] of refusals) {
    it(`refuses ${name}`, async () => {
      assert.match((await gate({}, deps)).fatal.join('\n'), expected);
    });
  }

  it('notes, without refusing, a recorded version this commit has no file for', async () => {
    const { fatal, notes } = await gate({}, { git: gitWith(recorded.slice(1)) });
    assert.deepEqual(fatal, []);
    assert.match(
      notes.join(),
      /lists 1 version\(s\) with no file at this commit: 20261130000300/,
    );
  });

  it('the production check reports an unapplied migration rather than refusing', async () => {
    const env = { OTA_LANE: 'production-check', OTA_SHA: SHA };
    const git = gitWith([...recorded, newer]);
    const { fatal, notes } = await preflight({ env, git, fetchImpl: github(), readRecord });
    assert.deepEqual(fatal, []);
    assert.match(notes.join(), /Production has not applied this migration/);
  });

  it('Preview does not compare against production, whose head it does not run on', async () => {
    const unreadable = () => {
      throw new Error('should not be read');
    };
    const result = await gate(
      { OTA_LANE: 'preview' },
      { git: gitWith([...recorded, newer]), readRecord: unreadable },
    );
    assert.deepEqual(result.fatal, []);
    assert.doesNotMatch(result.notes.join(), /migration|production-migrations/);
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

  describe('over a whole run', () => {
    const view = JSON.stringify({ jobs: [{ id: 'job-id', key: 'publish' }] });
    const fake = 'sntrys_fake_secret_value';

    const eas = (log) => (command) => (command === 'workflow:view' ? view : log());

    it('calls a read, non-empty log clean', () => {
      const result = scanRun(
        'run',
        eas(() => 'EXPO_TOKEN=********\n'),
      );
      assert.deepEqual(result, { lines: ['publish: clean'], ok: true });
    });

    it('fails, naming only what it found', () => {
      const { lines, ok } = scanRun(
        'run',
        eas(() => `SENTRY_AUTH_TOKEN=${fake}\n`),
      );
      assert.equal(ok, false);
      assert.doesNotMatch(lines.join(), /fake_secret/);
    });

    it('does not repeat a failed command, whose error carries the log', () => {
      const failing = () => {
        throw Object.assign(new Error(`Command failed\n${fake}`), { stdout: fake });
      };
      const { lines, ok } = scanRun('run', eas(failing));
      assert.equal(ok, false);
      assert.deepEqual(lines, ['publish: NOT SCANNED, no log could be read']);
    });

    it('does not repeat a failed view either', () => {
      const failing = () => {
        throw new Error(fake);
      };
      const { lines, ok } = scanRun('run', failing);
      assert.equal(ok, false);
      assert.doesNotMatch(lines.join(), /fake_secret/);
    });

    it('does not call an empty log clean', () => {
      const { lines, ok } = scanRun(
        'run',
        eas(() => '  \n'),
      );
      assert.equal(ok, false);
      assert.deepEqual(lines, ['publish: NOT SCANNED, no log could be read']);
    });
  });
});
