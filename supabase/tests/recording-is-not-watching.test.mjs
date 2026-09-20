import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * **Recording time is never watch time** — the epic's one sentence, as a repository test
 * (§O.2, §D.0).
 *
 * ---------------------------------------------------------------------------
 * WHY A GREP AND NOT A BEHAVIOUR TEST
 *
 * Every other assertion in this suite tests a reader that exists. This one tests the
 * readers that do not exist yet, and that is the whole point: the defect it guards
 * against was introduced **deliberately**, by a considered change, with a comment
 * explaining itself.
 *
 * `20260903000100` added `coalesce(watched_on, created_at)` to the monthly leaderboard
 * because five of twelve accounts had no dates at all, and it was a reasonable thing to
 * do at the time. It then quietly decided which month a watch belonged to for a year,
 * credited undated imports to the month an import ran (§C.3.5), and was invisible to
 * every functional test because the numbers it produced were plausible.
 *
 * A behaviour test can only fail for a reader somebody remembered to write one for. This
 * fails for the next person who reaches for the same shortcut, wherever they reach for
 * it, and it fails at the line.
 *
 * ---------------------------------------------------------------------------
 * THE TWO RULES
 *
 *   1. **No expression may coalesce a watch date with a recording time.** Not
 *      `coalesce(watched_on, created_at)`, not `?? recordedAt`, not in SQL and not in
 *      TypeScript.
 *   2. **No reader may treat a null watch date as "not watched".** Seen is the
 *      collection row's existence (§D.0); a null date means the timing is unknown, and
 *      it has never meant anything else.
 *
 * The one instance of rule 1 that existed is removed by T4 (`20261006000100`), and the
 * **legacy branch it kept behind a flag is the one allowance** — named explicitly below,
 * so that turning the flag into a deletion also deletes the exemption.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.expo',
  'dist',
  'build',
  'coverage',
  '.claude',
  'ios',
  'android',
  '02 Screenshots',
  '00 Brand SVGs',
]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * The version this rule begins at.
 *
 * **An applied migration is history and cannot be edited** — that is the project's
 * standing rule, and it is the reason this test has a floor rather than an exemption
 * list the length of the backlog. `20260903000100` introduced the fallback and
 * `20260917000100` carried it forward; both ran on staging and production long ago, and
 * a test that fails on them is a test that can never pass and will be deleted by the
 * first person it inconveniences.
 *
 * So the rule governs **the code that runs today and everything written from here on**:
 * all of `src/` and `app/`, and every migration at or after T1. That is exactly the set
 * a rule can actually hold, and the fallback those two files introduced is removed by
 * `20261006000100` — which is above the floor and therefore governed.
 */
const FLOOR = '20261003000100';

/**
 * The files this rule governs.
 *
 * **Tests are excluded and docs are excluded**, for opposite reasons. A test may
 * legitimately construct the forbidden shape in order to assert that it is refused, and
 * a document may quote it in order to explain why it is forbidden — this file does both.
 */
const GOVERNED = (path) => {
  const rel = relative(repoRoot, path).replace(/\\/g, '/');
  if (rel.includes('/tests/') || rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) {
    return false;
  }
  if (rel.startsWith('docs/')) return false;
  if (rel.startsWith('supabase/migrations/')) {
    return rel.slice('supabase/migrations/'.length, 'supabase/migrations/'.length + 14) >= FLOOR;
  }
  return rel.startsWith('src/') || rel.startsWith('app/');
};

/**
 * The one allowance, and it is a whole file rather than a line.
 *
 * `20261006000100` keeps the pre-epic monthly branch verbatim behind
 * `leaderboard.monthly_from_events`, so that the repoint's rollback is a statement
 * rather than a migration written at speed (§M.6). The coalesce lives in the branch that
 * is read while the flag is off.
 *
 * **Deleting that branch deletes this exemption**, which is the intended sequence: once
 * the flag has been true in production for long enough to trust, the legacy arm goes and
 * this list goes back to being empty.
 */
const ALLOWED = new Set(['supabase/migrations/20261006000100_a_year_counted_from_the_watches.sql']);

/** Where a watch date is coalesced with something that is not one. */
const COALESCED_WITH_RECORDING = [
  // `coalesce(um.watched_on, (um.created_at at time zone 'UTC')::date)` and every
  // spelling of it: any coalesce whose first argument is a watch date and whose second
  // mentions a recording column.
  /coalesce\s*\(\s*[\w.]*watched_on\b[^)]*\b(created_at|recorded_at|updated_at|imported_at|now\s*\(\s*\))/i,
  // The TypeScript shapes.
  /\bwatchedOn\s*\?\?\s*[\w.]*(createdAt|recordedAt|updatedAt)/,
  /\bwatched_on\s*\|\|\s*[\w.]*(created_at|recorded_at)/,
];

/** Where a null watch date is read as "not watched". */
const NULL_MEANS_UNWATCHED = [
  // `watched_on is null` next to a word that means unwatched. Deliberately narrow: the
  // expression itself is ordinary and correct — it is the CLAIM beside it that is wrong.
  /watched_on\s+is\s+null[^\n]{0,60}\b(not_watched|unwatched|not_seen|unseen)\b/i,
  /\b(notWatched|unwatched|notSeen|unseen)\b[^\n]{0,60}watchedOn\s*===?\s*null/,
];

describe('recording is not watching (§D.0, §O.2)', () => {
  it('no reader fills a null watch date from a recording time', async () => {
    const offenders = [];

    for await (const path of walk(repoRoot)) {
      if (!GOVERNED(path)) continue;
      const rel = relative(repoRoot, path).replace(/\\/g, '/');
      if (ALLOWED.has(rel)) continue;

      const text = await readFile(path, 'utf8');
      const lines = text.split(/\r?\n/);

      lines.forEach((line, index) => {
        // A comment explaining the rule is not a violation of it. Every match below is
        // in executable text, so the comment prefixes are stripped first.
        const code = line.replace(/^\s*(--|\/\/|\*)\s?.*$/, '');
        if (!code.trim()) return;

        for (const pattern of COALESCED_WITH_RECORDING) {
          if (pattern.test(code)) offenders.push(`${rel}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    assert.deepEqual(
      offenders,
      [],
      'A watch date and a recording time are different facts (§D.0). Use the watch date, ' +
        'or exclude the row: nothing may substitute one for the other. If a metric ' +
        'genuinely wants engagement, read a recording time and say so in its name.',
    );
  });

  it('no reader treats a null watch date as "not watched"', async () => {
    const offenders = [];

    for await (const path of walk(repoRoot)) {
      if (!GOVERNED(path)) continue;
      const rel = relative(repoRoot, path).replace(/\\/g, '/');

      const text = await readFile(path, 'utf8');
      const lines = text.split(/\r?\n/);

      lines.forEach((line, index) => {
        const code = line.replace(/^\s*(--|\/\/|\*)\s?.*$/, '');
        if (!code.trim()) return;

        for (const pattern of NULL_MEANS_UNWATCHED) {
          if (pattern.test(code)) offenders.push(`${rel}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    assert.deepEqual(
      offenders,
      [],
      'Seen is the user_media row existing (§D.0). A null watched_on means the timing is ' +
        'unknown and has never meant "not watched".',
    );
  });

  it('the allowance is exactly one file, and it is the flagged legacy branch', async () => {
    // A guard on the guard. An exemption list that grows is a rule that has stopped
    // being one, and this is the assertion that makes adding to it a deliberate act
    // somebody has to justify in a diff.
    assert.equal(ALLOWED.size, 1);
    const [only] = [...ALLOWED];
    const text = await readFile(join(repoRoot, only), 'utf8');
    assert.ok(
      text.includes('leaderboard.monthly_from_events'),
      'the allowance exists because that file keeps the pre-epic branch behind a flag',
    );
    assert.ok(
      text.includes('watched_month_events'),
      'and because it also contains the replacement that makes the flag worth having',
    );
  });
});
