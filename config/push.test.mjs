import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import push from './push.cjs';

const {
  LANES,
  GOOGLE_SERVICES_ENV,
  declaresPushNatively,
  apnsEnvironmentFor,
  googleServicesFileFor,
  notificationPluginProps,
} = push;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/**
 * The native push rule, tested directly.
 *
 * This file exists for the reason `backends.test.mjs` exists: the rule runs inside Expo's
 * config resolver, which no test can import, so every claim about it would otherwise be a
 * claim about source somebody had read. What it decides is whether a production binary
 * can receive a notification, and — through the fingerprint runtime policy — whether the
 * friend beta's published binary keeps receiving over-the-air updates at all.
 *
 * The second half is why the integration tests below resolve the real config rather than
 * only exercising the exported functions. The dangerous change to this feature is not a
 * wrong value; it is a *right* value that leaks into a lane it was not meant for.
 */

/** A `google-services.json` on disk, so a test can name a path that really exists. */
const placeholderSecret = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bingd-push-'));
  const file = join(dir, 'google-services.json');
  writeFileSync(file, JSON.stringify({ project_info: { project_id: 'placeholder' } }));
  return file;
};

/** Never true, so the production branch cannot be rescued by a file this machine has. */
const noLocalFile = () => false;

describe('apnsEnvironmentFor', () => {
  it('names production and nothing else', () => {
    assert.equal(apnsEnvironmentFor('production'), 'production');
    for (const lane of ['development', 'preview', 'beta']) {
      assert.equal(apnsEnvironmentFor(lane), null, lane);
    }
  });

  /**
   * A resolution with no lane is somebody's laptop, and a laptop declares nothing.
   * `BINGD_LANE` is unset for `expo start`, for CI, and for a bare config read.
   */
  it('declares nothing for a resolution with no lane', () => {
    assert.equal(apnsEnvironmentFor(undefined), null);
  });
});

describe('notificationPluginProps', () => {
  /**
   * The assertion that matters is `deepEqual` rather than a check on `mode`: an
   * unconfigured lane has to produce the *same object* the config produced before push
   * existed. `{ color, mode: 'development' }` would build an identical binary and a
   * different fingerprint, which strands every tester on their last update.
   */
  it('is exactly { color } for every lane that does not configure push', () => {
    for (const lane of ['development', 'preview', 'beta', undefined]) {
      const props = notificationPluginProps(lane, { color: '#773744' });
      assert.deepEqual(props, { color: '#773744' }, String(lane));
      assert.equal('mode' in props, false, `${lane} must not name mode at all`);
    }
  });

  it('adds production APNs for the production lane', () => {
    assert.deepEqual(notificationPluginProps('production', { color: '#773744' }), {
      color: '#773744',
      mode: 'production',
    });
  });
});

describe('googleServicesFileFor', () => {
  it('takes the EAS file secret for production', () => {
    assert.equal(
      googleServicesFileFor('production', { env: { [GOOGLE_SERVICES_ENV]: '/eas/secret.json' } }),
      '/eas/secret.json',
    );
  });

  it('falls back to the git-ignored local file for a production build from a laptop', () => {
    assert.equal(
      googleServicesFileFor('production', { env: {}, exists: () => true }),
      './google-services.json',
    );
  });

  /**
   * The refusal is the point of the whole module. A production build with no FCM
   * configuration installs, signs in, and cannot receive a notification — and the only
   * way to find that out is to ship it.
   */
  it('refuses a production build with no Android push configuration', () => {
    assert.throws(
      () => googleServicesFileFor('production', { env: {}, exists: noLocalFile }),
      (e) => {
        assert.match(e.message, /google-services\.json/);
        assert.match(e.message, /GOOGLE_SERVICES_JSON/);
        // The message has to say what happens if it did not refuse, or somebody
        // reads it as an obstacle and looks for the way round.
        assert.match(e.message, /silently cannot receive a notification/);
        return true;
      },
    );
  });

  it('lets development opt in through the environment', () => {
    assert.equal(
      googleServicesFileFor('development', { env: { [GOOGLE_SERVICES_ENV]: '/eas/dev.json' } }),
      '/eas/dev.json',
    );
  });

  /**
   * Deliberately no disk fallback for development. An opt-in that fires because a file
   * was downloaded is not an opt-in, and the lane's fingerprint would then depend on the
   * contents of a directory rather than on a decision somebody made.
   */
  it('does not opt development in merely because the file is on disk', () => {
    assert.equal(googleServicesFileFor('development', { env: {}, exists: () => true }), null);
  });

  it('never configures preview, beta, or a lane-less resolution', () => {
    for (const lane of ['preview', 'beta', undefined]) {
      assert.equal(
        googleServicesFileFor(lane, {
          env: { [GOOGLE_SERVICES_ENV]: '/eas/secret.json' },
          exists: () => true,
        }),
        null,
        String(lane),
      );
    }
  });
});

/**
 * `declaresPushNatively` is restated inline in `app.config.ts`, because answering "may
 * this module be loaded at all" cannot come from the module — see the fingerprint note in
 * `push.cjs`. The duplication is a seam, so this is the test that watches it.
 *
 * It is asserted as an *invariant over the other two functions* rather than by matching
 * the source text of `app.config.ts`, which would pass on a comment and fail on a
 * reformat.
 */
describe('declaresPushNatively agrees with what the module actually produces', () => {
  for (const env of [{}, { [GOOGLE_SERVICES_ENV]: '/eas/secret.json' }]) {
    const withSecret = Boolean(env[GOOGLE_SERVICES_ENV]);

    for (const lane of [...LANES, undefined]) {
      it(`${lane ?? 'no lane'}${withSecret ? ' with the secret set' : ''}`, () => {
        const declared = declaresPushNatively(lane, env);

        if (declared) {
          // Production with no credential throws rather than returning, which is still
          // "this lane declares push" — the declaration is what makes the absence fatal.
          const file = () => googleServicesFileFor(lane, { env, exists: noLocalFile });
          if (lane === 'production' && !withSecret) assert.throws(file);
          else assert.ok(file() || apnsEnvironmentFor(lane));
          return;
        }

        assert.equal(googleServicesFileFor(lane, { env, exists: noLocalFile }), null);
        assert.equal(apnsEnvironmentFor(lane), null);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// The resolved config, which is the artefact a build is actually made from
// ---------------------------------------------------------------------------

/**
 * Resolves the project's real Expo config for one lane, in a child process.
 *
 * A child process rather than an import, for two reasons that both bite: `@expo/config`
 * caches a resolved config per project root, so four lanes in one process would be one
 * answer four times; and `app.config.ts` reads `process.env` at module scope, so the
 * variables have to be set before it loads.
 */
function resolveConfig(lane, { variant, env = {} } = {}) {
  const script = `
    const { getConfig } = require('@expo/config');
    const { exp } = getConfig(process.argv[1], { skipSDKVersionRequirement: true, isPublicConfig: true });
    const plugin = (exp.plugins || []).find((p) => Array.isArray(p) && p[0] === 'expo-notifications');
    process.stdout.write(JSON.stringify({
      plugin: plugin ? plugin[1] : null,
      googleServicesFile: exp.android && exp.android.googleServicesFile || null,
    }));
  `;

  const run = spawnSync(process.execPath, ['-e', script, root], {
    encoding: 'utf8',
    cwd: root,
    env: {
      ...process.env,
      APP_VARIANT: variant ?? (lane === 'beta' ? 'production' : (lane ?? 'development')),
      BINGD_LANE: lane ?? '',
      // Cleared unless a case sets it, so a developer machine that happens to export one
      // cannot quietly change what this suite is asserting.
      [GOOGLE_SERVICES_ENV]: '',
      ...env,
    },
  });

  if (run.status !== 0) return { failed: true, message: `${run.stderr}${run.stdout}` };
  return { failed: false, ...JSON.parse(run.stdout) };
}

describe('the resolved config, per lane', () => {
  /**
   * The load-bearing assertion of this whole tranche.
   *
   * The friend beta runs on a published binary whose runtime version is a fingerprint of
   * the resolved config. If either of these two values appears on the beta lane, that
   * binary stops being offered updates — silently, with no symptom until somebody asks
   * why a fix never arrived, and no fix short of redistributing a build.
   *
   * Asserted **with the secret set**, because the realistic accident is not somebody
   * editing this rule: it is the founder configuring `GOOGLE_SERVICES_JSON` for the
   * production build and every other lane quietly inheriting it.
   */
  for (const lane of ['preview', 'beta']) {
    it(`${lane} declares no push configuration, even with the secret set`, () => {
      const secret = placeholderSecret();
      const config = resolveConfig(lane, { env: { [GOOGLE_SERVICES_ENV]: secret } });

      assert.equal(config.failed, false, config.message);
      assert.deepEqual(config.plugin, { color: '#773744' });
      assert.equal(config.googleServicesFile, null);
    });
  }

  it('development is untouched until it opts in, and then takes only FCM', () => {
    const bare = resolveConfig('development');
    assert.equal(bare.failed, false, bare.message);
    assert.deepEqual(bare.plugin, { color: '#773744' });
    assert.equal(bare.googleServicesFile, null);

    const secret = placeholderSecret();
    const opted = resolveConfig('development', { env: { [GOOGLE_SERVICES_ENV]: secret } });
    assert.equal(opted.failed, false, opted.message);
    assert.equal(opted.googleServicesFile, secret);
    // Sandbox APNs is correct for an internally distributed build, and one .p8 auth key
    // serves both environments — so iOS needs nothing here.
    assert.deepEqual(opted.plugin, { color: '#773744' });
  });

  it('production takes production APNs and the FCM file', () => {
    const secret = placeholderSecret();
    const config = resolveConfig('production', { env: { [GOOGLE_SERVICES_ENV]: secret } });

    assert.equal(config.failed, false, config.message);
    assert.deepEqual(config.plugin, { color: '#773744', mode: 'production' });
    assert.equal(config.googleServicesFile, secret);
  });

  it('production refuses to resolve at all without Android push configuration', () => {
    const config = resolveConfig('production');
    assert.equal(config.failed, true, 'a production config resolved with no FCM file');
    assert.match(config.message, /google-services\.json/);
  });

  /**
   * A lane-less resolution is `expo start`, CI, and every editor plugin that reads the
   * config. It must not demand a credential from a machine that has never seen Firebase.
   */
  it('resolves with no lane at all and asks for nothing', () => {
    const config = resolveConfig(undefined);
    assert.equal(config.failed, false, config.message);
    assert.deepEqual(config.plugin, { color: '#773744' });
    assert.equal(config.googleServicesFile, null);
  });
});
