/**
 * Does the Lists privacy suite actually hold anything up?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * `lists-security.test.mjs` is twenty-five green assertions, and green proves
 * nothing on its own: a suite that passes against a *weakened* schema is a suite
 * that was agreeing with the code rather than checking it. The only way to know is
 * to break the gates one at a time and require the suite to notice.
 *
 * ---------------------------------------------------------------------------
 * THE FIRST VERSION OF THIS FILE WAS A FALSE PROOF, AND THIS IS WHY IT IS NOT NOW
 *
 * It copied `supabase/` into a temporary directory and ran the suite there. A copy
 * outside the repository has no `node_modules` above it, so `@electric-sql/pglite`
 * did not resolve and **the suite crashed on import for every mutant** — which this
 * file then counted as "DETECTED". It reported 14/14 twice. The unmutated suite
 * failed from the same copy, which nobody had checked.
 *
 * Two changes close that for good:
 *
 *   1. **A control run, which must pass, before any mutant is tried.** A mutant only
 *      means something relative to a suite that is green without it. If the control
 *      is not green, the check aborts and says so, rather than reporting catches it
 *      did not make.
 *   2. **A detection has to be a real test failure**, not any non-zero exit. The
 *      child's output must show the suite ran (`ℹ tests N` with N > 0) and that at
 *      least one test failed. A crash before the first test is reported as INVALID.
 *
 * ---------------------------------------------------------------------------
 * HOW A MUTANT IS APPLIED
 *
 * **In place, in the real tree**, so module resolution is exactly the suite's own.
 * The migration is tracked, so the file is verified against `git show HEAD:` before
 * the first edit, restored from memory after every mutant, restored again on any
 * exit or interrupt, and verified against HEAD once more at the end. A run that is
 * killed mid-mutant still leaves `git checkout -- <file>` as a complete remedy.
 *
 * Run: `node supabase/tests/lists-mutation-check.mjs`
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const MIGRATION = 'supabase/migrations/20261010000100_a_list_is_a_set_of_titles_you_chose.sql';
const SUITE = 'supabase/tests/lists-security.test.mjs';
const path = join(root, MIGRATION);

/** Each defect is a *plausible* weakening — the kind a later change makes meaning well. */
const DEFECTS = [
  {
    name: 'private lists become readable (the predicate stops refusing private)',
    find: "      when l.visibility = 'private' then false\n",
    replace: '',
  },
  {
    name: 'a moderation hide stops hiding',
    find: '      when l.hidden_at is not null then false\n',
    replace: '',
  },
  {
    name: 'a suspended owner’s lists stay readable',
    find: "      when (select p.status from profiles p where p.id = l.owner_id) <> 'active' then false\n",
    replace: '',
  },
  {
    name: 'blocks stop hiding a list',
    find: '      when p_viewer is not null and blocked_between(p_viewer, l.owner_id) then false\n',
    replace: '',
  },
  {
    name: 'public stops checking the profile (a private owner’s public list leaks)',
    find: '      else can_view_profile(p_viewer, l.owner_id)\n',
    replace: '      else true\n',
  },
  {
    name: 'the select policy admits link, so link lists become enumerable',
    find: "    or (visibility = 'public' and hidden_at is null and can_i_view(owner_id))",
    replace: "    or (visibility in ('public', 'link') and can_i_view(owner_id))",
  },
  {
    name: 'profile_lists returns every visibility, so the shelf leaks private lists',
    find: "     and l.visibility = 'public'\n     and l.hidden_at is null\n     and can_view_profile(auth.uid(), p_owner_id)",
    replace: '     and can_view_profile(auth.uid(), p_owner_id)',
  },
  {
    name: 'owner-only writes stop checking the owner',
    find: '  select * into v_list from lists where id = p_list_id and owner_id = auth.uid();',
    replace: '  select * into v_list from lists where id = p_list_id;',
  },
  {
    name: 'list_preview names a private-profile owner in the unfurl',
    find: "         (select case when p.visibility = 'public' and p.status = 'active'\n                      then '@' || p.username::text end",
    replace: "         (select case when true\n                      then '@' || p.username::text end",
  },
  {
    name: 'the anon owner block gains the owner id',
    find: "              'id',              case when auth.uid() is not null then p.id end,",
    replace: "              'id',              p.id,",
  },
  {
    name: 'record_list_open counts a list anon cannot read',
    find: '  if not _list_readable(p_list_id, null) then\n    return;\n  end if;',
    replace: '  if false then\n    return;\n  end if;',
  },
  {
    name: 'a hidden list’s visibility becomes editable again',
    find: "  if v_list.hidden_at is not null\n     and p_visibility is not null\n     and p_visibility <> v_list.visibility then\n    return jsonb_build_object('status', 'hidden');\n  end if;",
    replace: '',
  },
  /**
   * **Replaced after the corrected run exposed the original as an equivalent mutant.**
   *
   * The first version flipped `when p_viewer is null then false` to `true`. It SURVIVED,
   * and not because the suite was weak: every caller guards `auth.uid() is null` *before*
   * calling `_viewer_has_seen` (`list_items_page` returns null for anon, the writers refuse
   * a null session, `list_viewer_progress` filters it out), so that branch is unreachable
   * and flipping it changes nothing observable. An undetectable mutant is not a gap in the
   * tests; it is a mutant that does not test what its name says.
   *
   * What the name means is *somebody else's watch state leaks into the reader's seen
   * marks*. That is this: drop the viewer from the movie lookup, so any account's
   * `user_media` row counts as the caller having seen it.
   */
  {
    name: 'seen reads another account’s collection, not the caller’s',
    find: '           where um.user_id = p_viewer and um.media_item_id = m.id',
    replace: '           where um.media_item_id = m.id',
  },
  {
    name: '_list_readable becomes callable by clients',
    find: 'revoke execute on function _list_readable(uuid, uuid) from public, anon, authenticated;',
    replace: 'grant execute on function _list_readable(uuid, uuid) to anon, authenticated;',
  },
];

// ---------------------------------------------------------------------------
// The file is only ever touched from a verified-clean state, and always put back
// ---------------------------------------------------------------------------

const head = execFileSync('git', ['show', `HEAD:${MIGRATION}`], { cwd: root, encoding: 'utf8' });
const onDisk = readFileSync(path, 'utf8');
const norm = (s) => s.replace(/\r\n/g, '\n');

if (norm(onDisk) !== norm(head)) {
  console.error(`${MIGRATION} differs from HEAD. Refusing to mutate a file that is already edited.`);
  process.exit(2);
}

// Written back exactly as it was on disk, line endings included.
const restore = () => writeFileSync(path, onDisk);
for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) {
  process.on(sig, (e) => {
    restore();
    if (sig === 'uncaughtException') {
      console.error(e);
      process.exit(1);
    }
    if (sig !== 'exit') process.exit(130);
  });
}

/**
 * Runs the suite once and classifies the result.
 *
 * `pass` and `fail` are node:test's own summary lines. A run with **zero tests** is
 * not a pass and not a detection — it is the import crash that made the first version
 * of this file lie, and it is reported as its own thing.
 */
function runSuite() {
  const r = spawnSync(process.execPath, ['--test', SUITE], {
    cwd: root,
    encoding: 'utf8',
    timeout: 600_000,
  });
  const out = `${r.stdout}\n${r.stderr}`;
  const n = (label) => Number((out.match(new RegExp(`ℹ ${label} (\\d+)`)) ?? [])[1] ?? 0);
  return { tests: n('tests'), pass: n('pass'), fail: n('fail'), out };
}

// ---------------------------------------------------------------------------
// Control, then the mutants
// ---------------------------------------------------------------------------

console.log(`${DEFECTS.length} defects, against ${SUITE}\n`);

const control = runSuite();
if (control.tests === 0 || control.fail > 0) {
  console.error(
    `CONTROL FAILED — the unmutated suite is not green (${control.pass} pass, ${control.fail} fail, ` +
      `${control.tests} tests). No mutant result would mean anything.\n\n${control.out.slice(-1500)}`,
  );
  process.exit(1);
}
console.log(`CONTROL   ${control.pass}/${control.tests} green without any mutant\n`);

let survived = 0;
let invalid = 0;

try {
  for (const defect of DEFECTS) {
    const source = norm(onDisk);
    if (!source.includes(defect.find)) {
      console.log(`STALE     ${defect.name} — anchor not found`);
      survived += 1;
      continue;
    }

    writeFileSync(path, source.replace(defect.find, defect.replace));
    let result;
    try {
      result = runSuite();
    } finally {
      restore();
    }

    if (result.tests === 0) {
      console.log(`INVALID   ${defect.name} — the suite ran no tests (a crash, not a catch)`);
      invalid += 1;
    } else if (result.fail > 0) {
      console.log(`DETECTED  ${defect.name}  (${result.fail} of ${result.tests} failed)`);
    } else {
      console.log(`SURVIVED  ${defect.name}`);
      survived += 1;
    }
  }
} finally {
  restore();
}

// The file must be exactly as it was when the run started.
if (norm(readFileSync(path, 'utf8')) !== norm(head)) {
  console.error(`\n${MIGRATION} was not restored. Run: git checkout -- ${MIGRATION}`);
  process.exit(1);
}

const caught = DEFECTS.length - survived - invalid;
console.log(`\n${caught} / ${DEFECTS.length} defects detected`);
if (survived > 0 || invalid > 0) {
  console.error(
    `\n${survived} survived and ${invalid} were invalid. A survivor means the suite agrees with ` +
      'the schema rather than checking it; an invalid run proves nothing either way.',
  );
  process.exit(1);
}
