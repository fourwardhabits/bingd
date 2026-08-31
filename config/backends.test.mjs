import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import backends from './backends.cjs';

const { LANE_BACKENDS, supabaseProjectRef, assertBackendIsAllowed } = backends;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const NONPROD = 'https://abheeqyjzekiowkztfxv.supabase.co';

/**
 * The lane-to-backend rule, tested directly.
 *
 * This file exists because independent review 28 raised a BLOCKER that was really two
 * findings wearing one coat: the rule was wrong, *and* it was written somewhere nothing
 * could exercise it. It lived inside `app.config.ts`, which is loaded by Expo's config
 * resolver and cannot be imported by a test, so every claim about it was a claim about
 * source somebody had read.
 *
 * What it decides is which database a shipped binary talks to, and the failure mode has
 * no symptom: the app signs in and shows an empty collection.
 */

describe('supabaseProjectRef', () => {
  it('reads the ref out of a Supabase URL', () => {
    assert.equal(supabaseProjectRef(NONPROD), 'abheeqyjzekiowkztfxv');
    assert.equal(supabaseProjectRef(`${NONPROD}/`), 'abheeqyjzekiowkztfxv');
    assert.equal(supabaseProjectRef('https://ABHEEQYJZEKIOWKZTFXV.supabase.co'), 'abheeqyjzekiowkztfxv');
  });

  it('is not fooled by a URL that merely contains one', () => {
    /**
     * The whole reason this parses rather than pattern-matches. Every string below
     * contains `abheeqyjzekiowkztfxv.supabase.co` and none of them is that host, and a
     * regex written in a hurry says yes to all of them.
     */
    const impostors = [
      'https://evil.example/?x=abheeqyjzekiowkztfxv.supabase.co',
      'https://evil.example/abheeqyjzekiowkztfxv.supabase.co',
      'https://evil.example#abheeqyjzekiowkztfxv.supabase.co',
      'https://abheeqyjzekiowkztfxv.supabase.co.evil.example',
      'https://abheeqyjzekiowkztfxv.supabase.co@evil.example',
      'https://user:abheeqyjzekiowkztfxv.supabase.co@evil.example',
    ];
    for (const url of impostors) {
      assert.notEqual(
        supabaseProjectRef(url),
        'abheeqyjzekiowkztfxv',
        `${url} was read as the nonprod project`,
      );
    }
  });

  it('refuses anything that is not an https Supabase host', () => {
    for (const url of [
      undefined,
      null,
      '',
      'not a url',
      'http://abheeqyjzekiowkztfxv.supabase.co', // plain HTTP
      'https://ci.invalid',
      'http://127.0.0.1:54321',
      'https://supabase.co', // no ref at all
      'https://a.b.supabase.co', // a ref cannot contain a dot
    ]) {
      assert.equal(supabaseProjectRef(url), null, `${url} produced a ref`);
    }
  });

  it('rejects a URL carrying userinfo even when the host is genuinely ours', () => {
    // `https://someone@abheeqyjzekiowkztfxv.supabase.co` really does have our hostname.
    // It is still refused: nothing in this project produces such a URL, so its presence
    // means the value came from somewhere unexpected.
    assert.equal(supabaseProjectRef(`https://someone@abheeqyjzekiowkztfxv.supabase.co`), null);
  });
});

describe('assertBackendIsAllowed', () => {
  it('allows each lane its own backend', () => {
    for (const [lane, refs] of Object.entries(LANE_BACKENDS)) {
      for (const ref of refs) {
        assert.doesNotThrow(() => assertBackendIsAllowed(`https://${ref}.supabase.co`, lane));
      }
    }
  });

  it('gives the production lane exactly one backend, and it is not nonprod', () => {
    /**
     * **This test used to assert the opposite**, and the assertion it made was
     * `LANE_BACKENDS.production` is empty — "not yet", so that a `--profile production`
     * build against nonprod could not succeed and look exactly like a real release.
     *
     * `bingd-production` was created on 2026-08-31 and its ref went into the three places
     * `production-lane.test.mjs` holds together. So the "not yet" half is spent, and what
     * replaces it is the half that was always the point: the production lane names **one**
     * project, and pointing it at nonprod is still a refusal rather than a warning.
     *
     * The ref is not written literally here. `production-lane.test.mjs` is where the three
     * declarations are required to agree; duplicating the string into a fourth place would
     * be one more thing to edit on the day it changes.
     */
    assert.equal(LANE_BACKENDS.production.length, 1);
    assert.notEqual(LANE_BACKENDS.production[0], NONPROD);
    assert.throws(
      () => assertBackendIsAllowed(NONPROD, 'production'),
      /production/,
      'a production build pointed at nonprod is the failure this allowlist exists for',
    );
  });

  it('refuses a cross-lane swap once a second project exists', () => {
    /**
     * Review 28's second BLOCKER, as a test rather than a promise. The allowlist used to
     * be one flat set, so the day a production ref was added, *every* lane could use it —
     * a Beta build on production, a Production build on nonprod, neither failing.
     *
     * Simulated rather than waited for: the mapping is copied, a production ref is added
     * to the production lane only, and the swap in both directions is required to throw.
     */
    const withProduction = { ...LANE_BACKENDS, production: ['prodprojectrefxxxxx'] };
    const check = (url, lane) => {
      const ref = supabaseProjectRef(url);
      if (!withProduction[lane].includes(ref)) throw new Error('refused');
    };

    assert.throws(() => check('https://prodprojectrefxxxxx.supabase.co', 'beta'));
    assert.throws(() => check(NONPROD, 'production'));
    assert.doesNotThrow(() => check(NONPROD, 'beta'));
    assert.doesNotThrow(() => check('https://prodprojectrefxxxxx.supabase.co', 'production'));
  });

  it('refuses an unknown project on any lane', () => {
    for (const lane of Object.keys(LANE_BACKENDS)) {
      assert.throws(
        () => assertBackendIsAllowed('https://someotherproject.supabase.co', lane),
        /may not use/,
        lane,
      );
    }
  });

  it('names the offending project in the error', () => {
    assert.throws(
      () => assertBackendIsAllowed('https://someotherproject.supabase.co', 'preview'),
      /someotherproject/,
    );
  });

  it('refuses a lane name that is not a lane', () => {
    // The typo case. `"BINGD_LANE": "previev"` must not resolve to "no lane, allow
    // anything" — which is exactly what an `undefined` lookup would have meant.
    assert.throws(() => assertBackendIsAllowed(NONPROD, 'previev'), /not a Bingd release lane/);
  });

  it('gives an undeclared lane the development lane, not the union of every lane', () => {
    /**
     * Review 28b, as a test. The fallback used to be the union of all four lanes, which
     * is safe only while there is exactly one backend — and it is a trap that springs
     * later. The day a production ref is added, a lane-less resolution (a bare
     * `eas update`, which supplies no `BINGD_LANE` because it does not read a build
     * profile) could compile production credentials and publish them to any channel.
     */
    assert.doesNotThrow(() => assertBackendIsAllowed(NONPROD, undefined));
    assert.throws(
      () => assertBackendIsAllowed('https://someotherproject.supabase.co', undefined),
      /development permissions/,
    );

    // Stated positively so the intent survives a refactor: the fallback IS the
    // development lane, not something that happens to equal it today.
    const withProduction = { ...LANE_BACKENDS, production: ['prodprojectrefxxxxx'] };
    assert.ok(
      !withProduction.development.includes('prodprojectrefxxxxx'),
      'a lane-less resolution must never inherit a production ref',
    );
  });

  it('has no escape hatch', () => {
    /**
     * There was one, for exactly one round: `BINGD_ALLOW_UNLISTED_BACKEND`, refused when
     * `EAS_BUILD=true`. Review 28b found that **`eas update` does not set `EAS_BUILD`** —
     * it resolves the config on a laptop and compiles the URL into the bundle it
     * publishes — so the variable meant to close the hatch for shipped artifacts was
     * never set on the path that ships them.
     *
     * Asserted rather than merely deleted, so that reintroducing it is a red test rather
     * than a plausible-looking convenience.
     */
    const source = readFileSync(join(here, 'backends.cjs'), 'utf8');
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /process\.env/, 'the rule reads no environment variable of its own');
    assert.doesNotMatch(code, /ALLOW_UNLISTED/);

    // And behaviourally, with both variables the old hatch used set to the values that
    // used to open it. Static and dynamic, because "the string is gone" and "the
    // behaviour is gone" are different claims and only the second one matters.
    const restore = {
      BINGD_ALLOW_UNLISTED_BACKEND: process.env.BINGD_ALLOW_UNLISTED_BACKEND,
      EAS_BUILD: process.env.EAS_BUILD,
    };
    try {
      process.env.BINGD_ALLOW_UNLISTED_BACKEND = 'yes-i-am-testing-locally';
      process.env.EAS_BUILD = 'false';
      assert.throws(
        () => assertBackendIsAllowed('https://someotherproject.supabase.co', 'beta'),
        /may not use/,
      );
    } finally {
      for (const [key, value] of Object.entries(restore)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('ignores anything that is not a Supabase URL at all', () => {
    // CI passes https://ci.invalid deliberately; a local stack is on 127.0.0.1. Neither
    // is a Bingd project by any reading, and `src/lib/env.ts` is what refuses an
    // unusable one at startup.
    for (const url of ['https://ci.invalid', 'http://127.0.0.1:54321', undefined, '']) {
      assert.doesNotThrow(() => assertBackendIsAllowed(url, 'preview'));
    }
  });
});

describe('the release scripts, which are the only supported way to publish', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  it('routes every build and update through the lane-supplying wrapper', () => {
    /**
     * The other half of review 28b's first Blocker. `eas update` takes `--branch` and
     * `--environment`; an EAS *environment* holds only the four `EXPO_PUBLIC_*` variables.
     * `APP_VARIANT` and `BINGD_LANE` live in the build profile's `env`, which `eas update`
     * never reads — so a documented bare `eas update --branch beta` resolves the config
     * with **no variant at all**, defaults to `development`, and publishes a manifest that
     * tells every friend tester's device it is a development build.
     *
     * `scripts/release.mjs` supplies both, read from `eas.json`. These assertions exist so
     * that "just call eas directly" cannot quietly come back as a script.
     */
    for (const [name, lane] of [
      ['build:preview', 'preview'],
      ['update:preview', 'preview'],
      ['build:beta', 'beta'],
      ['update:beta', 'beta'],
    ]) {
      const script = pkg.scripts[name];
      assert.ok(script, `${name} is missing`);
      assert.match(script, /scripts\/release\.mjs/, `${name} does not go through the wrapper`);
      assert.match(script, new RegExp(`\\b${lane}\\b`), `${name} does not name its lane`);
    }
  });

  it('publishes no lane by a bare eas command', () => {
    for (const [name, script] of Object.entries(pkg.scripts)) {
      if (/(^|[^-\w])eas\s+(build|update)\b/.test(script)) {
        assert.fail(`${name} calls eas ${script} directly instead of scripts/release.mjs`);
      }
    }
  });

  it('refuses every flag that could move what is published, or where', () => {
    /**
     * Two review rounds found two different ways past a denylist here, which is why the
     * implementation is an allowlist and why this test asserts *that shape* rather than a
     * list of known-bad flags.
     *
     *   - **28c:** `--branch beta` on the preview script published Preview code to the
     *     Beta branch past the Beta gate — `eas` takes the last occurrence of a flag and
     *     the trusted options were assembled first.
     *   - **28d:** `--input-dir <export> --skip-bundler` gated the code here and published
     *     a bundle produced somewhere else, with the config never resolved at all — so
     *     neither the lane nor the backend rule ran on what actually shipped.
     *
     * The last case in the list is the point: an **invented** flag is refused too. That is
     * the property a denylist cannot have.
     */
    const mustRefuse = [
      ['--branch', 'beta'],
      ['--branch=beta'],
      ['--profile', 'beta'],
      ['--profile=beta'],
      ['--environment', 'production'],
      ['--environment=production'],
      ['--channel', 'beta'],
      ['-e', 'beta'],
      ['-e=beta'],
      ['--auto-submit'],
      ['-s'],
      ['--auto-submit-with-profile', 'beta'],
      ['--auto-submit-with-profile=beta'],
      ['--input-dir', 'some-export'],
      ['--input-dir=some-export'],
      ['--skip-bundler'],
      ['--auto'],
      ['--local'],
      ['--what-to-test', 'anything'],
      ['--republish'],
      ['--group', 'some-group-id'],
      // Changes which phones may install the artifact, by rewriting the provisioning
      // profile to cover every device registered to the team. Review 28e.
      ['--refresh-ad-hoc-provisioning-profile'],
      ['--a-flag-invented-after-this-test-was-written'],
    ];

    for (const form of mustRefuse) {
      const run = spawnSync(
        process.execPath,
        [join(root, 'scripts', 'release.mjs'), 'update', 'preview', ...form],
        { encoding: 'utf8' },
      );
      assert.notEqual(run.status, 0, `${form.join(' ')} was accepted`);
      assert.match(run.stderr, /is not passed through/, form.join(' '));
    }
  });

  it('passes the harmless flags through, in the invocation it actually composes', () => {
    /**
     * The other half, and the earlier version of this assertion was worth nothing: it
     * checked only that the refusal message was absent, which is also true when `eas` is
     * missing or dies immediately.
     *
     * The script prints the exact argument vector before spawning, so that line is what is
     * asserted — it proves the trusted options are present *and* that the passthrough
     * reached the invocation, without depending on `eas` being installed or reachable.
     */
    const run = spawnSync(
      process.execPath,
      [
        join(root, 'scripts', 'release.mjs'),
        'update',
        'preview',
        '--platform',
        'android',
        '--json',
        '--non-interactive',
        '--help',
      ],
      { encoding: 'utf8' },
    );

    assert.doesNotMatch(run.stderr, /is not passed through/);
    assert.match(
      run.stdout,
      /eas update --branch preview --environment preview --platform android --json --non-interactive --help/,
    );
    assert.match(run.stdout, /BINGD_LANE=preview, APP_VARIANT=preview/);
  });
});

describe('the lanes this file knows about, and the ones eas.json builds', () => {
  const eas = JSON.parse(readFileSync(join(root, 'eas.json'), 'utf8'));
  const profiles = Object.entries(eas.build).filter(([name]) => name !== 'base');

  it('has one entry per build profile, and no more', () => {
    /**
     * The drift this prevents: a fifth profile added to `eas.json` with a `BINGD_LANE`
     * this file has never heard of. `assertBackendIsAllowed` would throw on it — which is
     * safe — but the failure would arrive ten minutes into an EAS build rather than here.
     */
    assert.deepEqual(
      Object.keys(LANE_BACKENDS).sort(),
      profiles.map(([name]) => name).sort(),
    );
  });

  it('gives every profile an explicit lane, environment and channel', () => {
    const environments = new Set(['development', 'preview', 'production']);
    const channels = new Set();

    for (const [name, profile] of profiles) {
      assert.equal(profile.env?.BINGD_LANE, name, `${name} does not declare its own lane`);
      assert.ok(
        environments.has(profile.environment),
        `${name} names environment "${profile.environment}", which EAS does not have`,
      );
      assert.ok(profile.channel, `${name} has no channel`);
      assert.ok(!channels.has(profile.channel), `${profile.channel} is claimed by two profiles`);
      channels.add(profile.channel);
    }
  });

  it('keeps every non-production lane off any future production backend', () => {
    /**
     * Stated as an invariant rather than as a review comment, so that adding a production
     * ref to the wrong line fails here. `production` is the only lane permitted to grow a
     * second entry, and the day it does, the three lanes below must still hold nothing
     * but nonprod.
     */
    for (const lane of ['development', 'preview', 'beta']) {
      assert.deepEqual(
        LANE_BACKENDS[lane],
        ['abheeqyjzekiowkztfxv'],
        `${lane} may only ever reach bingd-nonprod`,
      );
    }
  });

  it('has a beta profile that builds the production variant against a nonproduction backend', () => {
    // The lane's whole reason for existing, asserted rather than explained. If somebody
    // "tidies" beta to APP_VARIANT=beta, testers cannot upgrade to the store release.
    const beta = eas.build.beta;
    assert.equal(beta.env.APP_VARIANT, 'production');
    assert.equal(beta.environment, 'preview');
    assert.equal(beta.channel, 'beta');
    assert.deepEqual(LANE_BACKENDS.beta, ['abheeqyjzekiowkztfxv']);
  });
});
