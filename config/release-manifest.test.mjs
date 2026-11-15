import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { checkManifest, fromEasUpdates, liveUpdates } from '../scripts/release-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { LANE_BACKENDS, STAGING_REF, PRODUCTION_REF } = require('./backends.cjs');
const lanes = JSON.parse(readFileSync(join(root, 'eas.json'), 'utf8')).build;

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const RT = { android: '1'.repeat(40), ios: '2'.repeat(40) };
const live = {
  preview: {
    android: { runtime: RT.android, version: '1.1.0 (11)' },
    ios: { runtime: RT.ios, version: '1.1.0 (9)' },
  },
};
const ctx = { live, backends: LANE_BACKENDS, lanes };

const uuid = (n) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const entry = (platform, over = {}) => ({
  updateId: uuid(platform === 'android' ? 1 : 2),
  groupId: uuid(3),
  runtimeVersion: RT[platform],
  gitCommitHash: SHA,
  ...over,
});
const published = (over = {}) => ({
  lane: 'preview',
  channel: 'preview',
  gitSha: SHA,
  status: 'published',
  backend: { ref: STAGING_REF },
  platforms: { android: entry('android'), ios: entry('ios') },
  ...over,
});

const fatal = (manifest, context = ctx) => checkManifest(manifest, context).fatal;

describe('one release, both platforms, one commit', () => {
  it('accepts both platforms from one commit on the recorded runtimes', () => {
    assert.deepEqual(fatal(published()), []);
  });

  it('refuses a mixed-commit publish', () => {
    const problems = fatal(
      published({ platforms: { android: entry('android'), ios: entry('ios', { gitCommitHash: OTHER }) } }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^mixed-commit: ios was published from bbbbbbbb/);
  });

  it('refuses a one-platform publish without an exception', () => {
    const problems = fatal(published({ platforms: { ios: entry('ios') } }));
    assert.ok(problems.some((p) => /^one-platform: no android update/.test(p)), problems);
  });

  it('accepts an isolated platform only with a complete, attributable exception', () => {
    const exception = {
      type: 'isolated-platform',
      platform: 'ios',
      reason: 'selective production smoke on iPhone',
      approvedBy: 'founder',
      expires: '2026-11-16',
    };
    assert.deepEqual(fatal(published({ platforms: { ios: entry('ios') }, exception })), []);
    const unsigned = { ...exception, approvedBy: '' };
    assert.ok(
      fatal(published({ platforms: { ios: entry('ios') }, exception: unsigned })).some((p) =>
        /approvedBy is required/.test(p),
      ),
    );
    // The exception names the platform that went alone, not the one left behind.
    assert.ok(
      fatal(published({ platforms: { ios: entry('ios') }, exception: { ...exception, platform: 'android' } }))
        .some((p) => /^one-platform/.test(p)),
    );
  });

  it('takes no exception on lanes other people install', () => {
    const manifest = published({
      lane: 'production',
      channel: 'production',
      backend: { ref: PRODUCTION_REF },
      exception: { type: 'isolated-platform', platform: 'ios', reason: 'x', approvedBy: 'y', expires: 'z' },
    });
    assert.ok(fatal(manifest).some((p) => /production takes no isolated-platform exception/.test(p)));
  });

  it('refuses a runtime that is not the recorded binary, and a lane with no recorded binary', () => {
    const drifted = published({
      platforms: { android: entry('android', { runtimeVersion: '9'.repeat(40) }), ios: entry('ios') },
    });
    assert.ok(fatal(drifted).some((p) => /android: runtime 99999999 is not the recorded preview binary/.test(p)));

    const noIos = { ...ctx, live: { preview: { android: live.preview.android } } };
    assert.ok(
      fatal(published(), noIos).some((p) => /ios: config\/live-runtimes.json lists no preview binary/.test(p)),
    );
  });

  it('refuses a backend the lane may not use, and a channel that is not the lane’s', () => {
    assert.ok(fatal(published({ backend: { ref: PRODUCTION_REF } })).some((p) => /not allowed on preview/.test(p)));
    assert.ok(fatal(published({ channel: 'production' })).some((p) => /is not preview's channel/.test(p)));
  });

  it('lets a candidate carry no update IDs, but not no platform', () => {
    const candidate = published({
      status: 'candidate',
      platforms: {
        android: { runtimeVersion: RT.android },
        ios: { runtimeVersion: RT.ios },
      },
    });
    assert.deepEqual(fatal(candidate), []);
    assert.ok(
      fatal({ ...candidate, platforms: { android: candidate.platforms.android } }).some((p) =>
        /platforms.ios is required/.test(p),
      ),
    );
  });

  it('notes two update groups, and needs every verification to call it verified', () => {
    const twoGroups = published({
      platforms: { android: entry('android'), ios: entry('ios', { groupId: uuid(4) }) },
    });
    assert.deepEqual(fatal(twoGroups), []);
    assert.ok(checkManifest(twoGroups, ctx).notes.some((n) => /different update groups/.test(n)));

    const verified = published({ status: 'verified', verification: { ci: 'passed', releaseGate: 'passed' } });
    assert.ok(fatal(verified).some((p) => /verification.iosDevice/.test(p)));
  });
});

describe('reading what EAS serves', () => {
  /**
   * Recorded shapes, from eas-cli's own formatters (Codex P1 on #307): `update:list --json`
   * prints group summaries (`getUpdateGroupDescriptionsWithBranch`) under `currentPage`;
   * `update:view --json` prints individual updates (`getUpdateJsonInfosForUpdates`).
   */
  const groupSummary = (group, platforms) => ({
    branch: 'preview',
    message: '"staging" (1 hour ago by founder)',
    runtimeVersion: RT.android,
    isRollBackToEmbedded: false,
    group,
    platforms,
  });
  const update = (id, group, platform, commit, createdAt) => ({
    id,
    createdAt,
    group,
    branch: 'preview',
    message: 'staging',
    runtimeVersion: RT[platform],
    platform,
    manifestPermalink: `https://u.expo.dev/update/${id}`,
    isRollBackToEmbedded: false,
    gitCommitHash: commit,
  });

  /** A fake `eas`: the newest group per platform, then that group's updates. */
  const easServing = ({ newest, groups }) => {
    const calls = [];
    const run = (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'update:list') {
        const platform = args[args.indexOf('--platform') + 1];
        const group = newest[platform];
        return JSON.stringify({
          name: 'preview',
          currentPage: group ? [groupSummary(group, groups[group].map((u) => u.platform).join(', '))] : [],
        });
      }
      if (args[0] === 'update:view') return JSON.stringify(groups[args[1]]);
      throw new Error(`unexpected eas ${args.join(' ')}`);
    };
    return { run, calls };
  };

  it('finds both platforms in one group from one commit, and passes', () => {
    const g = uuid(3);
    const { run, calls } = easServing({
      newest: { android: g, ios: g },
      groups: {
        [g]: [
          update(uuid(1), g, 'android', SHA, '2026-11-15T13:00:00Z'),
          update(uuid(2), g, 'ios', SHA, '2026-11-15T13:00:00Z'),
        ],
      },
    });
    const platforms = liveUpdates(run, 'preview');
    assert.deepEqual(Object.keys(platforms).sort(), ['android', 'ios']);
    assert.equal(platforms.ios.updateId, uuid(2));
    assert.deepEqual(fatal(published({ platforms })), []);
    assert.ok(calls.includes(`update:list --branch preview --platform android --limit 1 --json --non-interactive`));
    assert.ok(calls.includes(`update:view ${g} --json --non-interactive`));
  });

  it('catches an iOS-only publish of another commit on top of a shared one', () => {
    const shared = uuid(3);
    const iosOnly = uuid(4);
    const { run } = easServing({
      newest: { android: shared, ios: iosOnly },
      groups: {
        [shared]: [
          update(uuid(1), shared, 'android', SHA, '2026-11-14T13:10:00Z'),
          update(uuid(2), shared, 'ios', SHA, '2026-11-14T13:10:00Z'),
        ],
        [iosOnly]: [update(uuid(5), iosOnly, 'ios', OTHER, '2026-11-15T07:00:00Z')],
      },
    });
    const platforms = liveUpdates(run, 'preview');
    assert.equal(platforms.ios.gitCommitHash, OTHER);
    const problems = fatal(published({ platforms }));
    assert.ok(problems.some((p) => /^mixed-commit: ios was published from bbbbbbbb/.test(p)), problems);
  });

  it('reports a platform with nothing on the branch as one-platform', () => {
    const g = uuid(3);
    const { run } = easServing({
      newest: { android: g },
      groups: { [g]: [update(uuid(1), g, 'android', SHA, '2026-11-15T13:00:00Z')] },
    });
    const problems = fatal(published({ platforms: liveUpdates(run, 'preview') }));
    assert.ok(problems.some((p) => /^one-platform: no ios update/.test(p)), problems);
  });

  it('takes nothing from a group summary, which carries no update, platform or commit', () => {
    assert.deepEqual(fromEasUpdates({ currentPage: [groupSummary(uuid(3), 'android, ios')] }), {});
  });
});

describe('the manifests in the repository', () => {
  const dir = join(root, 'docs/release/manifests');
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.json'))) {
    it(`${name} is well-formed for its status`, () => {
      const manifest = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const real = JSON.parse(readFileSync(join(root, 'config/live-runtimes.json'), 'utf8'));
      const { fatal: problems } = checkManifest(manifest, { ...ctx, live: real });
      // A recorded manifest may document a known gap; it must say so in `knownProblems`,
      // word for word, so a new problem is never absorbed silently.
      assert.deepEqual(problems, manifest.knownProblems ?? []);
    });
  }
});
