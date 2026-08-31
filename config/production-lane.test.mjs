import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const { LANE_BACKENDS, REF_NAMES } = require('./backends.cjs');
const {
  REF_ENVIRONMENTS,
  productionRef,
  environmentForRef,
  assertProductionBackend,
} = require('./production-lane.cjs');

/** A present anon key, so a test about the URL is about the URL. */
const KEY = 'sb_publishable_test';

const throws = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};

// ---------------------------------------------------------------------------

describe('assertProductionBackend', () => {
  /**
   * **The hole, asserted first, because everything else here is a refinement of it.**
   *
   * `assertBackendIsAllowed` returns early on a URL it cannot parse as a Supabase project,
   * which is right for CI and for a laptop and which means an *absent* variable passed too.
   * The production EAS environment holds zero variables today, so "no URL at all" is the
   * exact state a first production build would be attempted in — and it was the one state
   * nothing refused.
   */
  it('refuses a production build with no Supabase URL at all', () => {
    for (const missing of [undefined, '', null]) {
      const error = throws(() => assertProductionBackend(missing, KEY));
      assert.ok(error, `${JSON.stringify(missing)} produced a buildable production config`);
      assert.match(error.message, /must be built against a Supabase project/);
    }
  });

  /**
   * And the same bug one field along, which the first version of this rule had. Two variables,
   * set in the same dashboard in the same sitting, forgotten the same way — and a URL with no
   * key is a build that resolves, signs, submits, and throws `Invalid app configuration` from
   * `src/lib/env.ts` on somebody's phone.
   */
  it('refuses a production build with no anon key', () => {
    const url = `https://${LANE_BACKENDS.production[0]}.supabase.co`;
    for (const missing of [undefined, '', '   ', null, 42]) {
      const error = throws(() => assertProductionBackend(url, missing));
      assert.ok(error, `${JSON.stringify(missing)} was accepted as an anon key`);
      assert.match(error.message, /EXPO_PUBLIC_SUPABASE_ANON_KEY/);
    }
  });

  it('refuses a URL that is not a Supabase project', () => {
    for (const bad of [
      'https://ci.invalid',
      'http://127.0.0.1:54321',
      'not a url',
      // The userinfo smuggle `supabaseProjectRef` was written against, checked here too so
      // the two files cannot drift on it.
      'https://abheeqyjzekiowkztfxv.supabase.co@evil.example',
    ]) {
      assert.ok(throws(() => assertProductionBackend(bad, KEY)), `${bad} was accepted`);
    }
  });

  /**
   * The cross-lane swap, from the production side.
   *
   * **Rewritten 2026-08-31**, when the populated friend-Beta project was promoted to
   * production and the empty one became staging. The literal ref this used to name is
   * production's now, so naming it here asserted the opposite of the rule. The rule is
   * that a production build refuses the *non-production* project, whichever that is, and
   * says which project by name so the message is actionable.
   */
  it('refuses the nonproduction project', () => {
    const staging = LANE_BACKENDS.beta[0];
    const error = throws(() => assertProductionBackend(`https://${staging}.supabase.co`, KEY));
    assert.ok(error, 'a production build resolved against the staging project');
    assert.match(error.message, new RegExp(REF_NAMES[staging]));
  });

  it('refuses every project that is not in the production lane', () => {
    for (const ref of Object.keys(REF_ENVIRONMENTS)) {
      if (LANE_BACKENDS.production.includes(ref)) continue;
      assert.ok(
        throws(() => assertProductionBackend(`https://${ref}.supabase.co`, KEY)),
        `${ref} was accepted by the production lane`,
      );
    }
  });

  /**
   * And the positive case, which is skipped while there is no production project rather
   * than asserted against a made-up ref. A test that passes against a fixture proves the
   * fixture.
   */
  it('accepts the production project once there is one', (t) => {
    const ref = productionRef();
    if (ref === null) {
      t.skip('no production Supabase project yet — LANE_BACKENDS.production is empty');
      return;
    }
    assert.equal(throws(() => assertProductionBackend(`https://${ref}.supabase.co`, KEY)), null);
  });
});

// ---------------------------------------------------------------------------

describe('the three places a project ref has to be named', () => {
  /**
   * A ref is twenty characters of nothing and it goes in three files' worth of places:
   * the lane that may use it, the human name for the error message, and the environment the
   * database must claim to be. Adding it to one and forgetting another is the ordinary
   * mistake, and each omission fails somewhere different and later.
   */
  it('every allowlisted ref has a name and an environment', () => {
    for (const [lane, refs] of Object.entries(LANE_BACKENDS)) {
      for (const ref of refs) {
        assert.ok(REF_NAMES[ref], `${ref} (${lane}) has no entry in REF_NAMES`);
        assert.ok(
          REF_ENVIRONMENTS[ref],
          `${ref} (${lane}) has no entry in REF_ENVIRONMENTS, so remote-smoke cannot check ` +
            'that the database agrees about which environment it is',
        );
      }
    }
  });

  it('names only the two environments the database knows about', () => {
    for (const [ref, env] of Object.entries(REF_ENVIRONMENTS)) {
      assert.ok(
        env === 'prod' || env === 'nonprod',
        `${ref} claims environment "${env}", which set_environment_name would refuse`,
      );
    }
  });

  /**
   * The property that makes a swap impossible rather than unlikely: exactly one project may
   * be `prod`, and it is the production lane's, and no other lane may name it.
   */
  it('keeps the production environment to the production lane', () => {
    const prod = Object.entries(REF_ENVIRONMENTS)
      .filter(([, env]) => env === 'prod')
      .map(([ref]) => ref);

    assert.ok(prod.length <= 1, `more than one project claims to be production: ${prod.join(', ')}`);

    for (const ref of prod) {
      assert.deepEqual(
        LANE_BACKENDS.production,
        [ref],
        'the production project is not the production lane\'s only backend',
      );
      for (const [lane, refs] of Object.entries(LANE_BACKENDS)) {
        if (lane === 'production') continue;
        assert.ok(!refs.includes(ref), `the ${lane} lane may use the production project`);
      }
    }

    // And the mirror: the production lane may not hold a project that says it is nonprod.
    for (const ref of LANE_BACKENDS.production) {
      assert.equal(
        environmentForRef(ref),
        'prod',
        `the production lane holds ${ref}, which REF_ENVIRONMENTS says is not production`,
      );
    }
  });
});

// ---------------------------------------------------------------------------

describe('the native surface this rule was written around', () => {
  /**
   * **This is the reason the file exists, and it is a test rather than a comment because a
   * comment does not fail.**
   *
   * `config/backends.cjs` is required at the top of `app.config.ts`, so `@expo/fingerprint`
   * hashes its contents for every lane. Moving beta's hash strands every friend tester on a
   * binary that will never see another over-the-air update — silently, with a redistribution
   * as the only fix. Putting this rule in `backends.cjs` was measured to do exactly that.
   *
   * So the require has to stay inside the `lane === 'production'` branch. This asserts the
   * shape rather than the fingerprint, because a fingerprint assertion needs a clean
   * worktree and several minutes; what it can cheaply guarantee is that nobody has tidied
   * the require up to the top of the file, which is the one edit that would undo it.
   */
  it('is required lazily, from inside the production branch', () => {
    const source = readFileSync(join(root, 'app.config.ts'), 'utf8');

    const topLevel = source.slice(0, source.indexOf('const variant'));
    assert.ok(
      !topLevel.includes('production-lane.cjs'),
      'config/production-lane.cjs is required at the top of app.config.ts. That puts it in ' +
        'every lane\'s fingerprint, including beta, and strands the friend beta. Keep it ' +
        'inside the `lane === \'production\'` branch — see config/push.cjs for the same rule.',
    );

    assert.match(
      source,
      /if \(lane === 'production'\) \{[\s\S]{0,400}?require\('\.\/config\/production-lane\.cjs'\)/,
      'the production backend rule is no longer guarded by `lane === "production"`',
    );
  });
});

// ---------------------------------------------------------------------------

describe('a production build, resolved the way EAS resolves it', () => {
  const resolve = (env) =>
    execFileSync('npx', ['expo', 'config', '--type', 'public', '--json'], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        EAS_BUILD: 'true',
        APP_VARIANT: 'production',
        EXPO_PUBLIC_SUPABASE_ANON_KEY: 'ci',
        ...env,
      },
    });

  /**
   * End to end through Expo's own resolver, because every earlier version of a rule like
   * this was correct as a function and inert as a build gate. `assertProductionBackend`
   * passing its unit tests says nothing about whether `app.config.ts` calls it.
   */
  it('refuses when the production EAS environment has no Supabase URL', () => {
    /**
     * **Empty string, not `undefined`** — and the difference is a real one this test was
     * getting away with by accident until 2026-08-31.
     *
     * `resolve` spreads over `process.env` and runs `expo config` in the project root, so
     * deleting the variable lets Expo's dotenv fill it back in from a founder's local
     * `.env`. That used to still throw, because `.env` held the NON-production project and
     * production refused it — the right answer for the wrong reason. After the promotion
     * `.env` holds production's own URL, so the fallback resolved cleanly and the test
     * failed while the rule it names was still correct.
     *
     * An empty string is present-but-blank: dotenv skips a key already in `process.env`,
     * so this asserts the absence of a URL rather than the absence of a variable, and it
     * no longer depends on what is in anybody's `.env`.
     */
    const error = throws(() =>
      resolve({ BINGD_LANE: 'production', EXPO_PUBLIC_SUPABASE_URL: '' }),
    );
    assert.ok(error, 'a production config resolved with no backend at all');
  });

  it('refuses when a production build is pointed at the staging project', () => {
    // Derived, not literal: the two projects swapped roles on 2026-08-31, and a test that
    // named the old one would now be asserting that production refuses *itself*.
    const error = throws(() =>
      resolve({
        BINGD_LANE: 'production',
        EXPO_PUBLIC_SUPABASE_URL: `https://${LANE_BACKENDS.beta[0]}.supabase.co`,
      }),
    );
    assert.ok(error, 'a production config resolved against the staging project');
  });

  /**
   * The control. Without it the two refusals above pass just as well against an
   * `app.config.ts` that throws for every input.
   *
   * The FCM file is supplied because beta is a store-distributed lane now and
   * `config/push.cjs` requires one — the control has to fail for the *backend* reason or
   * not at all, so beta's own credential is held constant rather than left missing. It is
   * named explicitly rather than inherited from `process.env`, so a machine that happens
   * to export `GOOGLE_SERVICES_JSON` cannot change what this asserts.
   */
  it('still resolves the beta lane against its own backend', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bingd-lane-'));
    const googleServices = join(dir, 'google-services.json');
    writeFileSync(googleServices, JSON.stringify({ project_info: { project_id: 'placeholder' } }));

    const out = resolve({
      BINGD_LANE: 'beta',
      EXPO_PUBLIC_SUPABASE_URL: `https://${LANE_BACKENDS.beta[0]}.supabase.co`,
      GOOGLE_SERVICES_JSON: googleServices,
    });
    const config = JSON.parse(out);
    assert.equal(config.extra.lane, 'beta');
    assert.equal(config.extra.variant, 'production');
  });
});
