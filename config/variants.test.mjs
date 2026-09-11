/**
 * Three apps on one home screen, and the two things a staging build must not take with it.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 *
 * The preview lane has had its own bundle identifier and its own scheme since the first
 * build, so "they are separate apps" was true, and was taken to mean the separation was
 * finished. Two things had never been separated:
 *
 *   1. **The icon.** Both apps drew `assets/brand/icon.png`. Installed side by side they
 *      were one picture and one word apart, and a founder reporting a bug from the wrong
 *      one costs an evening that looks like a real defect the whole way through.
 *
 *   2. **The domain.** `associatedDomains` and the Android intent filter named
 *      `bingd.app` unconditionally, so a staging build asserted the marketing domain as
 *      loudly as the shipped app. Neither claim can actually win — Apple's AASA names
 *      `app.bingd` and `assetlinks.json` pins the production package and its signing
 *      certificate — but that is a property of two files on a web server rather than of
 *      this project, and it is the wrong thing to be leaning on.
 *
 * ---------------------------------------------------------------------------
 * THE HALF THAT MATTERS MOST IS THE HALF THAT MUST NOT MOVE
 *
 * `beta` builds the **production** variant: the same `app.bingd` package as the closed
 * test and the App Store release, by necessity rather than by choice. So every assertion
 * here is made twice, once for production and once for beta, and they must agree. A
 * change that quietly dropped beta's deep links would fail nothing at build time and
 * would simply stop `bingd.app/u/...` opening the app for every closed tester.
 *
 * The resolved config is also the fingerprint's `expoConfig` source, and the assets it
 * names are its `expoConfigExternalFile` sources. Production resolving identically is
 * therefore the same statement as production's runtime version not moving — confirmed
 * separately by recomputing the hash, because a test asserting fields is not a proof
 * about a hash of everything.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { PRODUCTION_REF, STAGING_REF } = require('./backends.cjs');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const urlFor = (ref) => 'https://' + ref + '.supabase.co';

const RESOLVE = [
  "const { getConfig } = require('@expo/config');",
  "const { exp } = getConfig(process.argv[1], { skipSDKVersionRequirement: true, isPublicConfig: true });",
  'process.stdout.write(JSON.stringify(exp));',
].join('\n');

/**
 * Resolves the project's real Expo config for one lane, in a child process.
 *
 * The same technique `config/push.test.mjs` uses, for the same two reasons: `@expo/config`
 * caches a resolved config per project root, so four lanes in one process would be one
 * answer four times, and `app.config.ts` reads `process.env` at module scope.
 */
function envFor(lane) {
  const variant = lane === 'beta' ? 'production' : lane;
  return {
    ...process.env,
    APP_VARIANT: variant,
    BINGD_LANE: lane,
    // The lane's own backend, so `config/backends.cjs` is satisfied rather than bypassed.
    EXPO_PUBLIC_SUPABASE_URL: urlFor(variant === 'production' ? PRODUCTION_REF : STAGING_REF),
    EXPO_PUBLIC_SUPABASE_ANON_KEY: 'ci',
    // Push is native and the store lanes declare it; without this their resolution
    // refuses. Never read for its contents here, only for its presence.
    GOOGLE_SERVICES_JSON:
      lane === 'beta' || lane === 'production' ? './google-services.json' : '',
  };
}

function resolveConfig(lane) {
  const run = spawnSync(process.execPath, ['-e', RESOLVE, root], {
    encoding: 'utf8',
    cwd: root,
    maxBuffer: 1e8,
    env: envFor(lane),
  });

  assert.equal(run.status, 0, 'resolving the ' + lane + ' lane failed:\n' + run.stderr + run.stdout);
  return JSON.parse(run.stdout);
}

const IDENTITY = {
  development: { name: 'bingd dev', id: 'app.bingd.dev', scheme: 'bingd-dev' },
  preview: { name: 'bingd preview', id: 'app.bingd.preview', scheme: 'bingd-preview' },
  beta: { name: 'bingd', id: 'app.bingd', scheme: 'bingd' },
  production: { name: 'bingd', id: 'app.bingd', scheme: 'bingd' },
};

const LANES = ['development', 'preview', 'beta', 'production'];
const STORE = ['production', 'beta'];
const STAGING = ['preview', 'development'];

describe('identity, per lane', () => {
  for (const lane of LANES) {
    it(lane + ' is ' + IDENTITY[lane].id, () => {
      const exp = resolveConfig(lane);
      assert.equal(exp.name, IDENTITY[lane].name);
      assert.equal(exp.scheme, IDENTITY[lane].scheme);
      assert.equal(exp.ios.bundleIdentifier, IDENTITY[lane].id);
      assert.equal(exp.android.package, IDENTITY[lane].id);
    });
  }
});

describe('the icon says which app this is before it is opened', () => {
  it('production and beta draw the shipped mark on Paper', () => {
    for (const lane of STORE) {
      const exp = resolveConfig(lane);
      assert.equal(exp.icon, './assets/brand/icon.png');
      assert.equal(exp.android.adaptiveIcon.foregroundImage, './assets/brand/icon-adaptive.png');
      assert.equal(exp.android.adaptiveIcon.backgroundColor, '#FBF8F4');
    }
  });

  it('preview and development draw the plum one', () => {
    for (const lane of STAGING) {
      const exp = resolveConfig(lane);
      assert.equal(exp.icon, './assets/brand/icon-preview.png');
      assert.equal(
        exp.android.adaptiveIcon.foregroundImage,
        './assets/brand/icon-adaptive-preview.png',
      );
      assert.equal(exp.android.adaptiveIcon.backgroundColor, '#773744');
    }
  });

  it('every icon the config names is a file that is actually there', () => {
    // A missing asset does not fail a config resolution. It fails a build, ten minutes in.
    for (const lane of LANES) {
      const exp = resolveConfig(lane);
      for (const asset of [exp.icon, exp.android.adaptiveIcon.foregroundImage]) {
        assert.ok(existsSync(join(root, asset)), lane + ' names ' + asset + ', which is not there');
      }
    }
  });
});

describe('only the shipped app claims bingd.app', () => {
  it('production and beta keep the universal links they have today', () => {
    for (const lane of STORE) {
      const exp = resolveConfig(lane);
      assert.deepEqual(exp.ios.associatedDomains, ['applinks:bingd.app']);

      const [filter] = exp.android.intentFilters;
      assert.equal(filter.autoVerify, true);
      assert.deepEqual(
        filter.data.map((d) => d.pathPrefix),
        ['/u/', '/lists/', '/title/', '/i/'],
      );
      assert.ok(filter.data.every((d) => d.host === 'bingd.app'));
    }
  });

  it('preview and development assert nothing about the domain at all', () => {
    for (const lane of STAGING) {
      const exp = resolveConfig(lane);
      // Absent rather than empty: an empty `associatedDomains` still writes the entitlement.
      assert.equal(exp.ios.associatedDomains, undefined);
      assert.equal(exp.android.intentFilters, undefined);
    }
  });
});

describe('the backend each lane carries into its bundle', () => {
  /**
   * The rule itself lives in `config/backends.cjs` and is tested there. What is worth
   * asserting from this side is that the config actually *carries* the URL, because
   * `extra.supabaseUrl` is what `src/lib/env.ts` reads at runtime and now refuses on.
   */
  it('preview carries staging and never production', () => {
    const exp = resolveConfig('preview');
    assert.match(exp.extra.supabaseUrl, new RegExp(STAGING_REF));
    assert.doesNotMatch(exp.extra.supabaseUrl, new RegExp(PRODUCTION_REF));
  });

  it('refuses to resolve a preview lane pointed at production', () => {
    const run = spawnSync(process.execPath, ['-e', RESOLVE, root], {
      encoding: 'utf8',
      cwd: root,
      env: { ...envFor('preview'), EXPO_PUBLIC_SUPABASE_URL: urlFor(PRODUCTION_REF) },
    });
    assert.notEqual(run.status, 0, 'a preview build pointed at production must not resolve');
    assert.match(run.stderr + run.stdout, /may not use/);
  });
});
