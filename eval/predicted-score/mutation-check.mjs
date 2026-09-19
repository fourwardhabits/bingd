/**
 * The mutation check for the predicted-score harness.
 *
 *   node eval/predicted-score/mutation-check.mjs
 *
 * Deliberately not a test file, matching `web/mutation-check.mjs` and
 * `supabase/tests/concurrency/mutation-check.mjs`. A green suite proves the harness agrees
 * with itself. It does not prove the suite would notice a leak. So each protection the
 * report's honesty rests on is removed here, one at a time, and the named tests must go red.
 *
 * Success is read from Jest's **exit status**, never from its output. Jest prints its summary
 * to stderr, and a script that captured stdout alone once scored surviving mutants as killed.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const file = (name) => join(here, name);

const MUTANTS = [
  {
    name: 'insertion quantile divided by the post-insert band size',
    file: file('geometry.ts'),
    apply: (s) =>
      s.replace(
        'const q = bandSize === 0 ? 0 : (rank - 1) / bandSize;',
        'const q = (rank - 1) / (bandSize + 1);',
      ),
    tests: ['geometry'],
  },
  {
    // Two layers stop this: the explicit `row.t < asOf` check, and the as-of view, which does
    // not contain the later row at all. Removing either alone changes nothing, so both go.
    name: 'P1: another person’s later ranking of the title admitted (both as-of layers removed)',
    file: file('evidence.ts'),
    apply: (s) =>
      s
        .replace('    if (task.asOf !== null && !(row.t < task.asOf)) continue;\n', '')
        .replace(
          'const op = cache.viewOf(row.u, task.c, task.asOf).opinions.get(row.m);',
          'const op = cache.viewOf(row.u, task.c, null).opinions.get(row.m);',
        ),
    tests: ['leakage'],
  },
  {
    name: 'P1: another person’s list read as it stands now, not as it stood then',
    file: file('evidence.ts'),
    apply: (s) => s.replace('      count = lo;', '      count = timeline.rows.length;'),
    tests: ['leakage'],
  },
  {
    name: 'P1: a follow approved after the replayed moment admitted',
    file: file('evidence.ts'),
    apply: (s) => s.replace('(asOf === null || approvedAt < asOf)', 'true'),
    tests: ['leakage'],
  },
  {
    name: 'P1: the reader’s training includes titles placed after the target',
    file: file('tasks.ts'),
    apply: (s) =>
      s.replace(
        'const prior = ordered.slice(0, k);',
        'const prior = ordered.filter((r) => r !== target);',
      ),
    tests: ['leakage'],
  },
  {
    name: 'the reader counted among the raters of their own title',
    file: file('evidence.ts'),
    apply: (s) =>
      s
        .replace('  if (u === v) return false;\n', '')
        .replace('    if (row.u === task.u) continue;\n', ''),
    tests: ['leakage'],
  },
  {
    name: 'P2: Taste Match reads the reader’s whole list, held-out fold included',
    file: file('evidence.ts'),
    apply: (s) =>
      s.replace(
        'for (const [m, op] of task.train.opinions) scores.set(m, op.score);',
        'for (const [m, op] of libraryView(this.ds.library.get(`${task.u}|${task.c}`) ?? []).opinions) scores.set(m, op.score);',
      ),
    tests: ['leakage'],
  },
  {
    name: 'P2: the held-out fold left in the training view',
    file: file('tasks.ts'),
    apply: (s) =>
      s.replace(
        'const train = libraryView(rows.filter((r) => !hidden.has(r.m)));',
        'const train = libraryView(rows);',
      ),
    tests: ['leakage'],
  },
  {
    name: 'a star imported after the replayed moment used',
    file: file('evidence.ts'),
    apply: (s) =>
      s.replace('      if (task.asOf !== null && !(star.t < task.asOf)) continue;\n', ''),
    tests: ['leakage'],
  },
  {
    // The target is always hidden too, so the hidden-title guard also stops its star. Both go.
    name: 'the target’s own star used as evidence (target and hidden guards removed)',
    file: file('evidence.ts'),
    apply: (s) =>
      s.replace(
        '        star.m === task.target.m ||\n        task.hidden.has(star.m) ||\n',
        '',
      ),
    tests: ['leakage'],
  },
  {
    name: 'M0’s q moved off the band middle',
    file: file('models.ts'),
    apply: (s) => s.replace('config.qPriorStrength * 0.5)', 'config.qPriorStrength * 0.4)'),
    tests: ['models'],
  },
  {
    name: 'an interval sized from the reader’s own half',
    file: file('confidence.ts'),
    apply: (s) => s.replace('const other = x.half === 0 ? 1 : 0;', 'const other = x.half;'),
    tests: ['confidence'],
  },
  {
    name: 'the bootstrap unseeded',
    file: file('metrics.ts'),
    apply: (s) => s.replace('const random = mulberry32(seed);', 'const random = Math.random;'),
    tests: ['metrics'],
  },
  {
    name: 'P1 allowed to gate while its labels are contaminated',
    file: file('config.ts'),
    apply: (s) =>
      s.replace('export const P1_CAN_GATE = false;', 'export const P1_CAN_GATE = true;'),
    tests: ['report'],
  },
  {
    name: 'P1: a label flagged for a re-placed title first compared after it (first-comparison time ignored)',
    file: file('tasks.ts'),
    apply: (s) => s.replace('(r.cmp_first === null || r.cmp_first < target.t)', 'true'),
    tests: ['leakage'],
  },
];

const results = [];
for (const mutant of MUTANTS) {
  const original = readFileSync(mutant.file, 'utf8');
  // Patterns are written with LF. A CRLF checkout is normalised before mutating and the
  // original bytes are restored afterwards, so the check behaves the same on either.
  const normalised = original.replace(/\r\n/g, '\n');
  const mutated = mutant.apply(normalised);
  if (mutated === normalised) {
    results.push([`${mutant.name} — MUTANT DID NOT APPLY`, false]);
    continue;
  }
  try {
    writeFileSync(mutant.file, mutated);
    const run = spawnSync(
      'npx',
      ['jest', ...mutant.tests.map((t) => `eval/predicted-score/${t}.test.ts`), '--silent'],
      { cwd: root, stdio: 'pipe', shell: true },
    );
    results.push([mutant.name, run.status !== 0]);
  } finally {
    writeFileSync(mutant.file, original);
  }
}

let ok = true;
for (const [name, killed] of results) {
  console.log(`${killed ? 'killed  ' : 'SURVIVED'}  ${name}`);
  if (!killed) ok = false;
}
console.log(ok ? `\nAll ${results.length} mutants killed.` : '\nAt least one mutant survived.');
process.exit(ok ? 0 : 1);
