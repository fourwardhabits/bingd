/**
 * The lane, and the one question it answers that the variant cannot.
 *
 * Independent review 28 found the diagnostics block in Settings gated on
 * `variant !== 'production'`. That reads correctly and is wrong for exactly one lane:
 * **Beta builds the production variant** — a bundle identifier cannot change between a
 * TestFlight build and the App Store release that replaces it — while talking to the
 * nonproduction backend. So the gate hid the version, channel, runtime and backend from
 * the friend beta, which is the one audience running a store-identity binary against a
 * test database and the one audience placed to notice if that were wrong.
 *
 * Every case below is a build that exists or is about to. The module reads its
 * configuration once at import, so each test re-imports it under a fresh mock.
 */

type Extra = Record<string, unknown>;

/**
 * Staging, and it has to be.
 *
 * This fixture named the production project while most cases below describe a preview or
 * development build — a combination the module now refuses outright, because it is the
 * accident worth refusing. The fixture was describing builds that must never exist.
 */
const BASE: Extra = {
  supabaseUrl: 'https://fjxhcbowoxuzulwirzyr.supabase.co',
  supabaseAnonKey: 'anon-key-for-tests',
};

const PRODUCTION_URL = 'https://abheeqyjzekiowkztfxv.supabase.co';

function loadEnv(extra: Extra) {
  let loaded!: typeof import('./env');
  jest.isolateModules(() => {
    jest.doMock('expo-constants', () => ({
      __esModule: true,
      default: { expoConfig: { extra } },
    }));
    // `require` rather than `import`: the module reads its configuration at import time
    // and throws on a bad one, so each case has to load it *after* its own mock is in
    // place. A static import is hoisted above the mock and would load it once.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require('./env');
  });
  return loaded;
}

afterEach(() => {
  jest.resetModules();
  jest.dontMock('expo-constants');
});

describe('the release lane', () => {
  it('is the lane the build declared', () => {
    for (const lane of ['development', 'preview', 'beta', 'production'] as const) {
      const variant = lane === 'beta' ? 'production' : lane;
      expect(loadEnv({ ...BASE, variant, lane }).lane).toBe(lane);
    }
  });

  it('falls back to the variant when no lane was declared', () => {
    // Not an EAS build — somebody's own machine, where there is no lane. The variant is
    // the closest true answer rather than a guess.
    expect(loadEnv({ ...BASE, variant: 'preview' }).lane).toBe('preview');
    expect(loadEnv({ ...BASE, variant: 'development' }).lane).toBe('development');
  });

  it('refuses a lane that is not a lane', () => {
    // The typo case. `"BINGD_LANE": "previev"` must fail at startup rather than
    // resolving to something plausible.
    expect(() => loadEnv({ ...BASE, variant: 'preview', lane: 'previev' })).toThrow(
      /Invalid app configuration/,
    );
  });
});

describe('isRelease — the gate on everything a tester needs and the public does not', () => {
  it('is false for a Beta build, which carries the production variant', () => {
    /**
     * The whole finding, as one assertion. Both fields say `production` about the
     * *identity*; only the lane says anything about who is holding the phone.
     */
    const beta = loadEnv({ ...BASE, variant: 'production', lane: 'beta' });
    expect(beta.env.variant).toBe('production');
    expect(beta.isProduction).toBe(true);
    expect(beta.isRelease).toBe(false);
  });

  it('is false for development and preview', () => {
    expect(loadEnv({ ...BASE, variant: 'development', lane: 'development' }).isRelease).toBe(false);
    expect(loadEnv({ ...BASE, variant: 'preview', lane: 'preview' }).isRelease).toBe(false);
  });

  it('is true only for a real production lane', () => {
    expect(loadEnv({ ...BASE, variant: 'production', lane: 'production' }).isRelease).toBe(true);
  });

  it('treats an undeclared lane on a production variant as a release', () => {
    // The conservative direction. With no lane there is no evidence anybody is testing,
    // and showing a fingerprint to a member of the public is the mistake worth avoiding.
    expect(loadEnv({ ...BASE, variant: 'production' }).isRelease).toBe(true);
  });
});

describe('the environment badge is a different question, and stays on the variant', () => {
  it('is off for a Beta build, which must look like the store build it is', () => {
    // Deliberately *not* moved to the lane. The badge exists so three variants can sit on
    // one home screen and be told apart (client.md §8); a friend tester has one Bingd and
    // a coloured strip across their screen is noise, not diagnostics.
    expect(loadEnv({ ...BASE, variant: 'production', lane: 'beta' }).showEnvironmentBadge).toBe(
      false,
    );
    expect(loadEnv({ ...BASE, variant: 'preview', lane: 'preview' }).showEnvironmentBadge).toBe(
      true,
    );
  });
});

/**
 * The invariant the founder asked for in as many words: a preview build MUST fail early
 * if its configured backend resolves to the production project.
 *
 * `config/backends.cjs` refuses this wherever the Expo config resolves, which covers both
 * `eas build` and `eas update`. This is the runtime half, and the two failures are not
 * interchangeable: the build-time one is a red log, and this one is the only thing standing
 * between a mistyped dashboard variable and a Beta-badged app writing real rows.
 */
describe('a staging build pointed at production refuses to start', () => {
  it('throws for a preview build and names the project', () => {
    expect(() =>
      loadEnv({ ...BASE, supabaseUrl: PRODUCTION_URL, variant: 'preview', lane: 'preview' }),
    ).toThrow(/bingd-production/);
  });

  it('throws for a development build too', () => {
    expect(() =>
      loadEnv({
        ...BASE,
        supabaseUrl: PRODUCTION_URL,
        variant: 'development',
        lane: 'development',
      }),
    ).toThrow(/must never talk to the production/);
  });

  /**
   * Beta is the case that makes this rule keyed on the variant rather than the lane. It
   * carries the production identity and uses production on purpose, and breaking that
   * would move every closed tester to an empty database with no symptom at all.
   */
  it('allows beta, which is the production variant using production deliberately', () => {
    const beta = loadEnv({
      ...BASE,
      supabaseUrl: PRODUCTION_URL,
      variant: 'production',
      lane: 'beta',
    });
    expect(beta.env.supabaseUrl).toBe(PRODUCTION_URL);
    expect(beta.isRelease).toBe(false);
  });

  it('allows a preview build against staging, which is the whole point of the lane', () => {
    expect(loadEnv({ ...BASE, variant: 'preview', lane: 'preview' }).env.supabaseUrl).toMatch(
      /fjxhcbowoxuzulwirzyr/,
    );
  });

  /**
   * A host that merely *contains* the ref is not the ref. The rule parses the URL rather
   * than matching a substring, and this is the case that tells the two apart.
   */
  it('is not fooled by a hostile URL that only mentions the project', () => {
    expect(() =>
      loadEnv({
        ...BASE,
        supabaseUrl: 'https://evil.example/?x=abheeqyjzekiowkztfxv.supabase.co',
        variant: 'preview',
      }),
    ).not.toThrow();
  });

  /**
   * The seam this arrangement creates, asserted rather than trusted: the ref is restated
   * in `env.ts` instead of imported from the build-time module, so something has to hold
   * the two together.
   */
  it('names the same production project config/backends.cjs does', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PRODUCTION_REF, supabaseProjectRef } = require('../../config/backends.cjs');
    expect(PRODUCTION_URL).toBe(`https://${PRODUCTION_REF}.supabase.co`);
    expect(supabaseProjectRef(PRODUCTION_URL)).toBe(PRODUCTION_REF);
  });
});

describe('a build with no usable backend fails at startup', () => {
  it('throws rather than producing a confusing network error on the first query', () => {
    expect(() => loadEnv({ variant: 'production', lane: 'production' })).toThrow(
      /Invalid app configuration/,
    );
    expect(() => loadEnv({ ...BASE, supabaseUrl: 'not-a-url', variant: 'preview' })).toThrow(
      /supabaseUrl/,
    );
  });
});
