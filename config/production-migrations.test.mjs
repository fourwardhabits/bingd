import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  RECORD,
  migrationCheck,
  migrationPaths,
  readCommittedRecord,
  recordProblems,
} from '../scripts/production-migrations.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/**
 * **No test compares the record with `supabase/migrations/` on this commit.** A migration
 * merges to main before it is applied to production, by design: the apply runs from a clean
 * checkout of the merged commit. A test holding the two equal would fail CI on main for every
 * migration from its merge to its recorded apply, or push applies ahead of review. The
 * comparison is made where it matters, by `scripts/ota-gate.mjs` before a production publish,
 * and by `node scripts/production-migrations.mjs check` when the coordinator records an apply.
 */
describe('config/production-migrations.json', () => {
  const record = readCommittedRecord();

  it('is a consistent record: every version once, ascending, with its head and count', () => {
    assert.deepEqual(recordProblems(record), []);
  });

  it('names the release record that says how it was read', () => {
    assert.match(record.evidence, /^docs\/release\/.+\.md$/);
    assert.ok(!Number.isNaN(Date.parse(record.recordedAt)), record.recordedAt);
  });

  it('is written the way `write` writes it, so a regenerated record diffs cleanly', () => {
    const text = readFileSync(join(root, RECORD), 'utf8');
    assert.equal(text, `${JSON.stringify(record, null, 2)}\n`);
    assert.deepEqual(Object.keys(record), [
      'head',
      'count',
      'recordedAt',
      'evidence',
      'versions',
    ]);
  });
});

describe('the migrations on this commit', () => {
  it('each have a readable version, used once', () => {
    const paths = migrationPaths(git);
    const versions = paths.map((path) => path.match(/\/(\d{14})_/)?.[1] ?? path).sort();
    const self = {
      head: versions.at(-1),
      count: versions.length,
      recordedAt: 'now',
      evidence: 'docs/release/x.md',
      versions,
    };
    assert.deepEqual(migrationCheck(paths, self), { problems: [], notes: [] });
  });
});

describe('the migration check', () => {
  const base = {
    head: '20261130000400',
    count: 2,
    recordedAt: '2026-11-20T00:00:00Z',
    evidence: 'docs/release/x.md',
    versions: ['20261130000300', '20261130000400'],
  };
  const paths = (...versions) => versions.map((v) => `supabase/migrations/${v}_m.sql`);

  it('passes exactly the recorded set', () => {
    const result = migrationCheck(paths('20261130000300', '20261130000400'), base);
    assert.deepEqual(result, { problems: [], notes: [] });
  });

  it('refuses any version the record lacks, above or below the head', () => {
    const above = migrationCheck(
      paths('20261130000300', '20261130000400', '20261201000100'),
      base,
    );
    assert.match(above.problems.join(), /20261201000100_m\.sql \(newer than/);
    const below = migrationCheck(
      paths('20261130000100', '20261130000300', '20261130000400'),
      base,
    );
    assert.match(below.problems.join(), /20261130000100_m\.sql \(older than .* not applied\)/);
  });

  it('judges nothing against a record it cannot trust', () => {
    const cases = [
      [{ ...base, versions: ['2026113000040'], head: '2026113000040', count: 1 }, /14 digits/],
      [{ ...base, versions: ['20261130000400', '20261130000400'] }, /once each/],
      [{ ...base, evidence: '' }, /no "evidence"/],
      [{ ...base, recordedAt: undefined }, /no "recordedAt"/],
      [[], /no "versions" list/],
    ];
    for (const [record, expected] of cases) {
      const { problems } = migrationCheck(paths('20261130000300', '20261130000400'), record);
      assert.match(problems.join(), expected);
    }
  });

  it('shortens a long list of recorded versions with no file', () => {
    const versions = Array.from(
      { length: 12 },
      (_, i) => `202611300004${String(i).padStart(2, '0')}`,
    );
    const record = { ...base, versions, head: versions.at(-1), count: 12 };
    const { problems, notes } = migrationCheck(paths(versions[0]), record);
    assert.deepEqual(problems, []);
    assert.match(notes.join(), /lists 11 version\(s\).*and 1 more/);
  });
});

describe('scripts/release.mjs', () => {
  it('runs the same check on the lanes that read the production database', () => {
    const source = readFileSync(join(root, 'scripts/release.mjs'), 'utf8');
    const guarded = source.slice(source.indexOf('if (GUARDED.has(lane)) {'));
    const check = guarded.indexOf(
      'commitMigrationCheck({ git, readRecord: readCommittedRecord })',
    );
    assert.ok(check > 0, 'the guarded block does not check migrations');
    assert.ok(
      check < guarded.indexOf('if (problems.length)'),
      'it checks after it has decided',
    );
    assert.match(
      guarded.slice(check, check + 200),
      /problems\.push\(\.\.\.database\.problems\)/,
    );
  });
});
