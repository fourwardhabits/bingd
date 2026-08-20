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

const BASE: Extra = {
  supabaseUrl: 'https://abheeqyjzekiowkztfxv.supabase.co',
  supabaseAnonKey: 'anon-key-for-tests',
};

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
