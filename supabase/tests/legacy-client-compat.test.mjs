import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestDb, createTestDbBefore } from './harness.mjs';

/**
 * Do the clients already on phones still work against the new schema?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SCHEMA TEST AND NOT A CLIENT TEST
 *
 * The Android vc12 binary and the current iOS production build are **installed on
 * real devices** and will not be updated by this release — an OTA cannot reach vc12
 * at all, and both keep calling the RPCs they shipped with. Watch History T1–T4
 * redefines a lot of the ranking and logging family, and a redefinition that
 * renamed one argument would break every one of those phones with a PGRST202 the
 * moment the migration reached production, with no client change to blame.
 *
 * So the check is: take every `supabase.rpc('name', { p_x, p_y })` call **as it
 * exists on `origin/main`** — which is what those builds run — and require that the
 * merged schema still has a function of that name accepting exactly those argument
 * names. PostgREST resolves an RPC by name and named arguments, so that is precisely
 * the contract an installed client holds.
 *
 * Read from `origin/main` with `git show` rather than from the working tree, because
 * the working tree is the *new* client and would of course agree with the new schema.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

/**
 * `origin/main` must exist before anything is read from it, and in CI it does not.
 *
 * `actions/checkout` clones at depth 1 with only the ref being built, so `origin/main` is
 * "not a valid object name" there — and this suite, green on every developer machine, was
 * red in release gate run 35562734407 for that reason alone. It fetches exactly that one
 * ref when it is missing, and **fails loudly if it cannot**: skipping would turn the one
 * check that installed clients keep working into a check that silently never runs where
 * it matters most.
 */
function ensureOriginMain() {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}'], {
      cwd: root,
      stdio: 'ignore',
    });
  } catch {
    execFileSync(
      'git',
      ['fetch', '--no-tags', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      { cwd: root, stdio: 'ignore' },
    );
  }
}

/** Every file under src/ and app/ as it stood at one ref. */
function clientSourcesAt(ref) {
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, '--', 'src', 'app'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f));

  return files.map((f) => ({
    file: f,
    text: execFileSync('git', ['show', `${ref}:${f}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }),
  }));
}

/** Every file under src/ and app/ as it stood on origin/main. */
function legacyClientSources() {
  ensureOriginMain();
  return clientSourcesAt('origin/main');
}

/**
 * **The binaries people actually have**, by the commit each was built from.
 *
 * `origin/main` is a good proxy for "the shipped client" only while main and production
 * move together, and on 2026-09-23 they stopped: Watch History + Lists merged the night
 * before its cutover. From then on the honest question is about these commits, because
 * they are what is on the phones while the migrations go in.
 *
 * **Update this table whenever a binary ships**, and delete a row when its build is no
 * longer installable — an entry that is wrong is worse than no entry, because it is the
 * one that gets believed at 3am.
 */
const SHIPPED = [
  { what: 'iOS 1.0.0 (7), App Store', commit: 'ba14bd06d8ae3db7ff1e6d62f70a66d2badd3d01' },
  { what: 'Android 1.0.1 (12), Play', commit: '6d2f8455458afabc42d1cfd0a0bd68f5bd2ae343' },
];

/**
 * Makes a shipped commit readable, in CI as well as on a developer machine.
 *
 * `actions/checkout` clones at depth 1, so these commits are absent there —
 * `ensureOriginMain` above fetches `main` the same way and hits the same wall one commit
 * deeper. Both entries in `SHIPPED` are ancestors of `main`, so **deepening that history
 * is what reaches them**; fetching the bare object is not, because a shallow fetch of an
 * arbitrary sha is a different permission and it failed in release gate run 35824023061.
 *
 * It deepens progressively rather than unshallowing outright: the first step is usually
 * enough and the whole history of this repository is not needed to read two files.
 * **Never skips.** A check that silently does not run is worse than one that is red, and
 * this is the check a production cutover leans on.
 */
function ensureCommit(sha) {
  const have = () => {
    try {
      execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  if (have()) return;

  ensureOriginMain();
  for (const depth of ['--deepen=500', '--deepen=2000', '--unshallow']) {
    try {
      execFileSync(
        'git',
        ['fetch', '--no-tags', depth, 'origin', '+refs/heads/main:refs/remotes/origin/main'],
        { cwd: root, stdio: 'ignore' },
      );
    } catch {
      // `--unshallow` on a complete clone is an error, and so is deepening one. Either
      // way the next `have()` is the answer.
    }
    if (have()) return;
  }
  throw new Error(
    `${sha} is not readable here. It is meant to be an ancestor of main — if a binary was ` +
      `built from a branch that never merged, put its sha in SHIPPED only once it has.`,
  );
}

/**
 * `supabase.rpc('name', { a: …, b: … })` → { name, args }.
 *
 * Deliberately simple and deliberately conservative: it reads the argument *keys* of
 * an object literal passed inline, which is how every call site in this client is
 * written. A call it cannot parse is reported rather than skipped, so a clever call
 * site cannot quietly fall out of the check.
 */
function rpcCalls(sources) {
  const calls = [];
  const head = /supabase\s*\.rpc\(\s*'([a-z_0-9]+)'\s*(,)?/g;

  for (const { file, text: raw } of sources) {
    /**
     * Comments are stripped first. The first version of this parser read the object
     * literal with `[^}]*` and reported `public_scores(p_media_item_ids)` as broken —
     * a comment line sat between `{` and `p_user_ids:`, and the argument simply was
     * not seen. The check then looked like it had found a regression in a function
     * that had not changed since it reached production.
     */
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    for (const m of text.matchAll(head)) {
      const name = m[1];
      if (!m[2]) {
        calls.push({ file, name, args: [] });
        continue;
      }
      // A balanced-brace read of the argument object, so an array literal or a nested
      // object inside it does not end the read early.
      let i = text.indexOf('{', m.index + m[0].length);
      if (i < 0) continue;
      let depth = 0;
      let j = i;
      for (; j < text.length; j += 1) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const body = text.slice(i + 1, j);

      // Top-level keys only: blank out anything nested before reading them.
      let flat = '';
      let d = 0;
      for (const ch of body) {
        if (ch === '{' || ch === '[' || ch === '(') d += 1;
        if (d === 0) flat += ch;
        if (ch === '}' || ch === ']' || ch === ')') d -= 1;
      }
      const keys = [...flat.matchAll(/(?:^|,)\s*([a-zA-Z_][a-zA-Z_0-9]*)\s*(?=[:,]|$)/g)].map(
        (k) => k[1],
      );
      calls.push({ file, name, args: [...new Set(keys)] });
    }
  }
  return { calls };
}

/** Every overload of every public function, as { name → [{ inputs, required }] }. */
async function signatures(db) {
  const { rows } = await db.sql(
    `select p.proname as name,
            coalesce(p.proargnames, '{}') as argnames,
            p.pronargs as nargs,
            p.pronargdefaults as ndefaults
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'`,
  );
  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.name)) byName.set(r.name, []);
    // Input arguments only: `proargnames` includes OUT/TABLE columns after the inputs.
    byName.get(r.name).push({
      inputs: r.argnames.slice(0, r.nargs),
      required: r.nargs - r.ndefaults,
    });
  }
  return byName;
}

/** Whether PostgREST could resolve this named-argument call against these overloads. */
const resolves = (byName, call) =>
  (byName.get(call.name) ?? []).some(
    (o) =>
      call.args.every((a) => o.inputs.includes(a)) &&
      o.inputs.slice(0, o.required).every((a) => call.args.includes(a)),
  );

/**
 * The first migration **production has not run**. Everything from here on is the tranche
 * under test, and `before_` is therefore the schema of the live database.
 *
 * **It is no longer the same thing as "the last migration on `origin/main`", and that is
 * deliberate** (2026-09-23). Watch History + Lists merged to `main` the night before its
 * production cutover, so for one window `main`'s client calls RPCs the live database does
 * not have yet. That window is exactly what this file exists to measure, and the marker
 * moves when the migrations are applied — not when they are merged.
 */
const FIRST_NEW = '20261003000100_a_watch_that_knows_when_it_was.sql';

let merged;
let before_;

before(async () => {
  merged = await createTestDb();
  before_ = await createTestDbBefore(FIRST_NEW);
});

after(async () => {
  await merged?.close();
  await before_?.close();
});

describe('installed clients against the merged schema', () => {
  /**
   * **Differential, and that is the whole design.**
   *
   * A call is a regression only if it resolves against **main's** schema and does not
   * resolve against the **merged** one. Measuring it that way means a parser that
   * misreads some call site — which the first version of this test did, four times —
   * cannot manufacture a break: a misread call fails identically on both sides and
   * cancels out. What survives is exactly "this worked in production yesterday and
   * will not after the migration", which is the question being asked.
   */
  it('no RPC the shipped client calls stops resolving after the new migrations', async () => {
    const { calls } = rpcCalls(legacyClientSources());
    assert.ok(calls.length > 40, `expected the client's RPC surface, found ${calls.length} calls`);

    const [was, now] = [await signatures(before_), await signatures(merged)];

    const regressions = calls
      .filter((call) => resolves(was, call) && !resolves(now, call))
      .map(
        (call) =>
          `${call.name}(${call.args.join(', ')}) resolved on main and does not now ` +
          `(have: ${(now.get(call.name) ?? []).map((o) => `[${o.inputs.join(',')}]`).join(' ') || 'nothing'}) ` +
          `— ${call.file}`,
      );

    assert.deepEqual(
      [...new Set(regressions)],
      [],
      `An installed client would break against the merged schema:\n  ${regressions.join('\n  ')}`,
    );
  });

  it('the parser resolves nearly every call the live schema defines', async () => {
    /**
     * A differential over a parser that resolves nothing would pass vacuously, so the
     * `was` side has to be known good. What is measured is the parser, and the parser's
     * job is reading argument lists — so the population is the calls whose function the
     * live schema **has**. A call to something that does not exist there yet is not a
     * misread; it is a client ahead of the database, which is the next assertion.
     *
     * Measuring it the other way is how this test read 81% on 2026-09-23: Watch History
     * + Lists had merged to `main` the night before its production cutover, so a fifth
     * of main's calls named functions the live database had never heard of. Nothing was
     * wrong with the parser and nothing was wrong with the migrations.
     */
    const { calls } = rpcCalls(legacyClientSources());
    const was = await signatures(before_);
    const known = calls.filter((c) => was.has(c.name));
    const unresolved = known.filter((c) => !resolves(was, c));
    const share = 1 - unresolved.length / known.length;
    assert.ok(
      share > 0.9,
      `only ${(share * 100).toFixed(0)}% of the calls the live schema defines resolve — ` +
        `the parser is too weak for the differential to mean anything:\n  ` +
        unresolved.map((c) => `${c.name}(${c.args.join(',')})`).join('\n  '),
    );
  });

  it('every RPC main calls but the live schema lacks is one the pending migrations add', async () => {
    /**
     * The deployment gap, stated rather than left to be discovered.
     *
     * `main` may run ahead of the live database — it does between a merge and its
     * cutover — but only ever by functions **these migrations create**. A name that is
     * in neither is a call to something that exists nowhere, which is a defect whichever
     * way round the deployment is.
     */
    const { calls } = rpcCalls(legacyClientSources());
    const [was, now] = [await signatures(before_), await signatures(merged)];
    const missing = [...new Set(calls.filter((c) => !was.has(c.name)).map((c) => c.name))];
    const nowhere = missing.filter((name) => !now.has(name));
    assert.deepEqual(
      nowhere,
      [],
      `main calls RPCs that exist neither in the live schema nor after the migrations:\n  ` +
        nowhere.join('\n  '),
    );
  });

  /**
   * The same differential, asked of the binaries in the field rather than of `main`.
   *
   * This is the question phase 1 of a cutover turns on: the migrations land hours or days
   * before the new store build does, so every phone keeps calling the schema with the
   * bundle it already has. A call that resolved yesterday and does not resolve after the
   * push is a screen that breaks for somebody who did nothing.
   */
  for (const { what, commit } of SHIPPED) {
    it(`${what} keeps every RPC it calls`, async () => {
      ensureCommit(commit);
      const { calls } = rpcCalls(clientSourcesAt(commit));
      assert.ok(calls.length > 40, `expected ${what}'s RPC surface, found ${calls.length}`);

      const [was, now] = [await signatures(before_), await signatures(merged)];
      const regressions = [
        ...new Set(
          calls
            .filter((call) => resolves(was, call) && !resolves(now, call))
            .map((call) => `${call.name}(${call.args.join(', ')}) — ${call.file}`),
        ),
      ];

      assert.deepEqual(
        regressions,
        [],
        `${what} would break against the migrated schema:\n  ${regressions.join('\n  ')}`,
      );
    });
  }

  it('no relation the shipped client reads directly disappears', async () => {
    const tables = new Set();
    for (const { text } of legacyClientSources()) {
      for (const m of text.matchAll(/\.from\(\s*'([a-z_]+)'\s*\)/g)) tables.add(m[1]);
    }
    assert.ok(tables.size > 5, `expected several direct table reads, found ${tables.size}`);

    const relations = async (db) =>
      new Set(
        (
          await db.sql(
            `select table_name as n from information_schema.tables where table_schema = 'public'
              union
             select table_name from information_schema.views where table_schema = 'public'`,
          )
        ).rows.map((r) => r.n),
      );
    const [was, now] = [await relations(before_), await relations(merged)];

    const lost = [...tables].filter((name) => was.has(name) && !now.has(name));
    assert.deepEqual(lost, [], 'a relation the shipped client reads was dropped');
  });
});
