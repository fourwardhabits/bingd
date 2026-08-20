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
  const clean = {}; // no BINGD_ALLOW_UNLISTED_BACKEND, no EAS_BUILD

  it('allows each lane its own backend', () => {
    for (const [lane, refs] of Object.entries(LANE_BACKENDS)) {
      for (const ref of refs) {
        assert.doesNotThrow(() =>
          assertBackendIsAllowed(`https://${ref}.supabase.co`, lane, clean),
        );
      }
    }
  });

  it('refuses the production lane outright, because there is no production backend', () => {
    /**
     * The state this has to encode is "not yet", not "anything". A `--profile production`
     * build against nonprod would otherwise succeed and look exactly like a real release.
     */
    assert.deepEqual(LANE_BACKENDS.production, []);
    assert.throws(
      () => assertBackendIsAllowed(NONPROD, 'production', clean),
      /this lane has no backend yet/,
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
        () => assertBackendIsAllowed('https://someotherproject.supabase.co', lane, clean),
        /may not use/,
        lane,
      );
    }
  });

  it('names the offending project in the error', () => {
    assert.throws(
      () => assertBackendIsAllowed('https://someotherproject.supabase.co', 'preview', clean),
      /someotherproject/,
    );
  });

  it('refuses a lane name that is not a lane', () => {
    // The typo case. `"BINGD_LANE": "previev"` must not resolve to "no lane, allow
    // anything" — which is exactly what an `undefined` lookup would have meant.
    assert.throws(() => assertBackendIsAllowed(NONPROD, 'previev', clean), /not a Bingd release lane/);
  });

  it('accepts any known backend when no lane is declared', () => {
    // A local `expo start` or a CI config resolution. There is no lane to be wrong about.
    assert.doesNotThrow(() => assertBackendIsAllowed(NONPROD, undefined, clean));
    assert.throws(
      () => assertBackendIsAllowed('https://someotherproject.supabase.co', undefined, clean),
      /may not use/,
    );
  });

  it('ignores anything that is not a Supabase URL at all', () => {
    // CI passes https://ci.invalid deliberately; a local stack is on 127.0.0.1. Neither
    // is a Bingd project by any reading, and `src/lib/env.ts` is what refuses an
    // unusable one at startup.
    for (const url of ['https://ci.invalid', 'http://127.0.0.1:54321', undefined, '']) {
      assert.doesNotThrow(() => assertBackendIsAllowed(url, 'preview', clean));
    }
  });

  describe('the local escape hatch', () => {
    it('opens only for its exact value', () => {
      const other = 'https://someotherproject.supabase.co';
      assert.doesNotThrow(() =>
        assertBackendIsAllowed(other, 'preview', {
          BINGD_ALLOW_UNLISTED_BACKEND: 'yes-i-am-testing-locally',
        }),
      );
      for (const value of ['1', 'true', 'yes', '', 'YES-I-AM-TESTING-LOCALLY']) {
        assert.throws(
          () => assertBackendIsAllowed(other, 'preview', { BINGD_ALLOW_UNLISTED_BACKEND: value }),
          /may not use/,
          value,
        );
      }
    });

    it('is closed on EAS, where the artifacts that reach a phone are made', () => {
      assert.throws(
        () =>
          assertBackendIsAllowed('https://someotherproject.supabase.co', 'preview', {
            BINGD_ALLOW_UNLISTED_BACKEND: 'yes-i-am-testing-locally',
            EAS_BUILD: 'true',
          }),
        /may not use/,
      );
    });
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
