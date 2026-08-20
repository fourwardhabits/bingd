import { buildReleaseContext, releaseTags, resetReleaseContext, type ReleaseSources } from './release';

jest.mock('expo-application', () => ({
  nativeApplicationVersion: '0.1.0',
  nativeBuildVersion: '7',
}));

jest.mock('expo-updates', () => ({
  runtimeVersion: 'fingerprint-abc',
  channel: 'preview',
  updateId: null,
  isEmbeddedLaunch: true,
  isEnabled: true,
}));

/**
 * The four builds the founder has to be able to tell apart, and the two rules that
 * separate them.
 *
 * Every field here is read from a native module that answers differently in each of the
 * four, and two of those answers are counter-intuitive enough to be worth a test rather
 * than a comment: a development build has **no EAS channel**, and a development build
 * reports **`isEmbeddedLaunch: true`** because there is no update to have launched from.
 * Both would file a founder's dev client under the same label as a fresh TestFlight
 * install if the rules were written the obvious way round.
 */

const sources = (overrides: Partial<ReleaseSources> = {}): ReleaseSources => ({
  variant: 'preview',
  platform: 'android',
  appVersion: '0.1.0',
  buildNumber: '7',
  runtimeVersion: 'fingerprint-abc',
  channel: 'preview',
  updateId: null,
  isEmbeddedLaunch: true,
  isDev: false,
  ...overrides,
});

describe('buildReleaseContext', () => {
  it('carries the whole build identity', () => {
    expect(buildReleaseContext(sources())).toEqual({
      environment: 'preview',
      platform: 'android',
      app_version: '0.1.0',
      build_number: '7',
      runtime_version: 'fingerprint-abc',
      eas_channel: 'preview',
      eas_update_id: null,
      build_kind: 'embedded',
    });
  });

  describe('build_kind', () => {
    it('calls a packager-served build a dev client even though its launch is embedded', () => {
      // The whole point. `isEmbeddedLaunch` is true here and must not win: a dev client
      // has no update, so "embedded" is technically true and analytically useless.
      const context = buildReleaseContext(
        sources({ variant: 'development', isDev: true, isEmbeddedLaunch: true, channel: null }),
      );

      expect(context.build_kind).toBe('dev_client');
      // And the channel really is absent on a development build — EAS does not pin one,
      // so this is the field that cannot be used to identify it.
      expect(context.eas_channel).toBeNull();
    });

    it('calls a fresh install embedded', () => {
      expect(buildReleaseContext(sources({ isEmbeddedLaunch: true })).build_kind).toBe('embedded');
    });

    it('calls a downloaded update ota, and keeps the update id that names it', () => {
      const context = buildReleaseContext(
        sources({ isEmbeddedLaunch: false, updateId: 'update-42' }),
      );

      expect(context.build_kind).toBe('ota');
      expect(context.eas_update_id).toBe('update-42');
    });
  });

  describe('absent values', () => {
    it('normalises an empty string to null', () => {
      // expo-application answers '' rather than null on some Android configurations, and
      // an empty string is worse than an absent one: it groups, so a chart draws a bar
      // for it and somebody asks what that build was.
      const context = buildReleaseContext(
        sources({ appVersion: '', buildNumber: '   ', runtimeVersion: undefined }),
      );

      expect(context.app_version).toBeNull();
      expect(context.build_number).toBeNull();
      expect(context.runtime_version).toBeNull();
    });
  });

  it('separates the four builds the beta will be running at once', () => {
    const androidDev = buildReleaseContext(
      sources({ variant: 'development', platform: 'android', isDev: true, channel: null }),
    );
    const iosDev = buildReleaseContext(
      sources({ variant: 'development', platform: 'ios', isDev: true, channel: null }),
    );
    const preview = buildReleaseContext(sources({ variant: 'preview', channel: 'preview' }));
    const testFlight = buildReleaseContext(
      sources({ variant: 'production', platform: 'ios', channel: 'production' }),
    );

    const label = (c: ReturnType<typeof buildReleaseContext>) =>
      [c.environment, c.platform, c.build_kind, c.eas_channel].join('/');

    expect(new Set([androidDev, iosDev, preview, testFlight].map(label)).size).toBe(4);
  });
});

/**
 * What Sentry is told, which is the same facts and nothing more.
 *
 * The two properties worth a test are what is **present** and what is **absent**: an
 * absent field must not become the string "null" in a tag, and no tag may carry a
 * credential. The DSN and the PostHog key both sit in the same `extra` block this reads
 * its variant from, so "it is only the fields we listed" is a claim worth checking rather
 * than asserting.
 */
describe('releaseTags', () => {
  beforeEach(resetReleaseContext);

  it('carries the fields that separate one build from another', () => {
    expect(releaseTags()).toMatchObject({
      environment: 'preview',
      app_version: '0.1.0',
      build_number: '7',
      runtime_version: 'fingerprint-abc',
      eas_channel: 'preview',
    });
  });

  it('omits a field rather than tagging it null', () => {
    // `updateId` is null in the mock above — this build is running its own bundle.
    expect(releaseTags()).not.toHaveProperty('eas_update_id');
  });

  it('carries no secret', () => {
    const values = Object.values(releaseTags()).join(' ');
    for (const secret of ['phc_', 'sentry.io', 'supabase', 'anon', 'service_role', 'Bearer']) {
      expect(values).not.toContain(secret);
    }
  });

  it('sets no release or dist of its own', () => {
    // Those belong to the Sentry Expo plugin, which sets them at build time from the
    // native project — and they are what the uploaded source maps are keyed to.
    // Overriding them from a runtime read is how a symbolicated stack becomes minified.
    expect(releaseTags()).not.toHaveProperty('release');
    expect(releaseTags()).not.toHaveProperty('dist');
  });
});
