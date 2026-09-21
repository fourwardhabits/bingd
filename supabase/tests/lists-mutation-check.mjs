/**
 * Does the Lists privacy suite actually hold anything up?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * `lists-security.test.mjs` is twenty-five green assertions, and green proves
 * nothing on its own: a suite that passes against a *weakened* schema is a suite
 * that was agreeing with the code rather than checking it. The only way to know
 * is to break the gates one at a time and require the suite to notice.
 *
 * Same shape as `web/mutation-check.mjs` and
 * `supabase/tests/concurrency/mutation-check.mjs`: each defect is a string edit
 * to the migration, applied to a scratch copy of the tree, with the suite run
 * against it. A defect nothing catches is reported as SURVIVED and is a hole in
 * the tests, not in the schema.
 *
 * Run: `node supabase/tests/lists-mutation-check.mjs`
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const MIGRATION = 'supabase/migrations/20261010000100_a_list_is_a_set_of_titles_you_chose.sql';
const SUITE = 'supabase/tests/lists-security.test.mjs';

/**
 * Each defect is a *plausible* weakening rather than a random edit — the kind of
 * thing a later change might do while meaning well, which is the class a suite
 * has to survive.
 */
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
  {
    name: 'seen is computed for a viewer that is not the caller',
    find: '    when p_viewer is null then false',
    replace: '    when p_viewer is null then true',
  },
  {
    name: '_list_readable becomes callable by clients',
    find: 'revoke execute on function _list_readable(uuid, uuid) from public, anon, authenticated;',
    replace: 'grant execute on function _list_readable(uuid, uuid) to anon, authenticated;',
  },
];

const scratch = mkdtempSync(join(tmpdir(), 'bingd-lists-mutants-'));
let survived = 0;

process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

console.log(`${DEFECTS.length} defects, against ${SUITE}\n`);

for (const defect of DEFECTS) {
  const dir = join(scratch, String(DEFECTS.indexOf(defect)));
  // Only what the suite needs: the migrations and the tests. Copying the whole
  // tree would drag node_modules in.
  cpSync(join(root, 'supabase'), join(dir, 'supabase'), { recursive: true });

  const path = join(dir, MIGRATION);
  /**
   * Normalised to LF before matching.
   *
   * The working tree is checked out with CRLF on Windows, so every anchor below —
   * written with `\n` like the migration source — missed, and nine defects reported
   * "the migration moved" when nothing had. A stale-anchor report that is really a
   * line-ending mismatch is worse than no report: it says the tests are fine.
   */
  const original = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

  if (!original.includes(defect.find)) {
    console.log(`SKIPPED   ${defect.name}`);
    console.log(`          anchor not found — the migration moved, so this defect is stale.`);
    survived += 1;
    continue;
  }

  writeFileSync(path, original.replace(defect.find, defect.replace));

  let caught = false;
  try {
    execFileSync(
      process.execPath,
      ['--test', join(dir, SUITE)],
      { cwd: root, stdio: 'pipe', encoding: 'utf8', timeout: 300_000 },
    );
  } catch {
    caught = true;
  }

  console.log(`${caught ? 'DETECTED' : 'SURVIVED'}  ${defect.name}`);
  if (!caught) survived += 1;
}

console.log(`\n${DEFECTS.length - survived} / ${DEFECTS.length} defects detected`);
if (survived > 0) {
  console.error(
    '\nA surviving defect means the suite agrees with the schema rather than checking it.',
  );
  process.exit(1);
}
