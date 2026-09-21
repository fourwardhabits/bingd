/**
 * The Watch History + Lists cutover: one transaction, one gate, one flag flip.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, WHICH IS NOT "db push WAS INCONVENIENT"
 *
 * `20261003000100` (T1) changes what `user_media.watched_on` means: it becomes a cache of
 * the latest KNOWN date, so an imported diary date can move it backwards. The monthly
 * leaderboard reads that cache with a `coalesce(watched_on, created_at)` fallback until
 * `leaderboard.monthly_from_events` is true. **Between those two moments there is a
 * window** in which a native undated row loses its monthly credit if an import arrives
 * with an older diary date for it (PR #193's own §M note). Under the flag the contract
 * holds structurally; with the flag off and T1 applied, it does not.
 *
 * The founder's instruction for this release was therefore: do not leave production in
 * that transitional state. So the apply and the flip are **one operation**, and this tool
 * is what makes that a mechanism rather than a promise:
 *
 *   - all six files applied in ONE transaction, with their history rows,
 *   - `set constraints all immediate`, so T1's deferred placeholder trigger has fired,
 *   - both invariant asserts run,
 *   - the §D.7 cache-move enumeration and the §M.5 repoint diff computed,
 *   - an automated direction gate that ABORTS the whole thing on a wrong-way delta,
 *   - and the flag flipped, all before COMMIT.
 *
 * Nothing observes T1 without the board flag, because nothing observes anything until the
 * commit. If any step raises, the database is exactly where it started — which the
 * Supabase CLI cannot give you: it splits each file into statements and runs them outside
 * a transaction (`apply-staging-migrations.mjs` records that at length), so a failure
 * halfway through T1's backfill would leave the window open with no way back.
 *
 * ---------------------------------------------------------------------------
 * THE TWO FLAGS ARE NOT THE SAME DECISION
 *
 * `leaderboard.monthly_from_events` needs **no client change**, and leaving it false is
 * the window above. It flips with the tranche, and `--flags board` is the default.
 *
 * `goals.count_watch_events` is an ordering constraint against the client (§M.2): the
 * OTA's goal query reads `watch_events` unconditionally, so the honest sequence is
 * tranche → OTA → goals flag, each immediately after the last. **That is still one
 * release operation**, and the middle step is a publish rather than a statement, which is
 * why this tool has a `--only-flags` mode for the third step:
 *
 *     node scripts/ops/watch-history-cutover.mjs --target staging  --rehearse
 *     node scripts/ops/watch-history-cutover.mjs --target staging  --apply
 *     ... publish the OTA on that lane ...
 *     node scripts/ops/watch-history-cutover.mjs --target staging  --only-flags --flags goals --apply
 *
 * `--flags none` is refused unless `--allow-window` is also given, so the transitional
 * state cannot be reached by forgetting an argument. The rollback for either flag is
 * `--only-flags --flags <which> --off --apply`, which is one statement.
 *
 * ---------------------------------------------------------------------------
 * HOW IT TALKS TO THE DATABASE
 *
 * Through the authenticated Supabase CLI, because this machine has no direct Postgres URL
 * for either project and `--project-ref` needs no password. `db query` only honours
 * `--linked`, so the target is a scratch workdir linked to that ref
 * (`bingd-staging-reachable-by-project-ref`): pass `--workdir <dir>` for one that is
 * already linked, or let this create and link one. It prints the project ref and the
 * database's own answer to `environment_name()` and refuses if they disagree with
 * `--target`.
 *
 *   node scripts/ops/watch-history-cutover.mjs --target staging               # plan only
 *   node scripts/ops/watch-history-cutover.mjs --target staging --rehearse    # + rolled back
 *   node scripts/ops/watch-history-cutover.mjs --target production --apply
 *
 * `--per-file` applies each file in its own transaction instead of all six in one, for the
 * case where the Management API refuses the bundle's size. It is strictly weaker — a
 * failure then leaves earlier files applied — and it still flips the flag in the last
 * transaction, so the window stays closed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PRODUCTION_REF, STAGING_REF, REF_NAMES } = require('../../config/backends.cjs');

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const option = (name, fallback = null) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};

const die = (message) => {
  console.error(`\nREFUSING: ${message}`);
  process.exit(1);
};

/** The files this cutover is for, in application order. */
const FILES = [
  '20261003000100_a_watch_that_knows_when_it_was.sql',
  '20261004000100_a_placement_that_remembers_where_it_came_from.sql',
  '20261005000100_a_watch_you_can_log_again.sql',
  '20261006000100_a_year_counted_from_the_watches.sql',
  '20261010000100_a_list_is_a_set_of_titles_you_chose.sql',
  '20261011000100_a_position_two_devices_agree_on.sql',
];

/** The head every one of these expects to find, and nothing else. */
const EXPECTED_HEAD = '20261002000100';

const FLAGS = {
  board: ['leaderboard.monthly_from_events'],
  goals: ['goals.count_watch_events'],
  all: ['leaderboard.monthly_from_events', 'goals.count_watch_events'],
  none: [],
};

const target = option('--target');
if (!['staging', 'production'].includes(target)) {
  die('pass --target staging or --target production. There is no default.');
}
const ref = target === 'production' ? PRODUCTION_REF : STAGING_REF;
const expectedEnv = target === 'production' ? 'prod' : 'nonprod';

const which = option('--flags', 'board');
if (!(which in FLAGS)) die(`--flags must be one of ${Object.keys(FLAGS).join(', ')}`);
if (which === 'none' && !has('--allow-window')) {
  die(
    'applying T1 without flipping leaderboard.monthly_from_events leaves the mixed-semantics\n' +
      '  window this tool exists to close (an import can take a native row off the monthly\n' +
      '  board). Pass --flags board (the default) or --flags all. If you really mean to leave\n' +
      '  it open, say so with --allow-window.',
  );
}
const flagKeys = FLAGS[which];
const flagValue = has('--off') ? 'false' : 'true';

const mode = has('--apply') ? 'apply' : has('--rehearse') ? 'rehearse' : 'plan';
const onlyFlags = has('--only-flags');
const perFile = has('--per-file');
if (onlyFlags && flagKeys.length === 0) die('--only-flags needs --flags board, goals or all.');

// ---------------------------------------------------------------------------
// The CLI, and the scratch link it needs
// ---------------------------------------------------------------------------

const cli = (argv, { cwd } = {}) =>
  execFileSync('npx', ['supabase@latest', ...argv], {
    encoding: 'utf8',
    shell: true,
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

let workdir = option('--workdir');
if (!workdir) {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), `bingd-cutover-${target}-`));
  cli(['link', '--project-ref', ref, '--workdir', workdir]);
}
const linked = fs
  .readFileSync(path.join(workdir, 'supabase', '.temp', 'project-ref'), 'utf8')
  .trim();
if (linked !== ref) die(`--workdir is linked to ${linked}, not ${ref}. Refusing to guess.`);

/**
 * One statement, or one bundle, through `db query`.
 *
 * The CLI prints JSON with a boundary wrapper and a warning about untrusted data; the rows
 * are what this wants. A bundle with several statements returns the last result set, which
 * is why every mode below finishes with exactly one `select` of one JSON column.
 */
const query = (sql) => {
  const file = path.join(workdir, `q-${Date.now()}.sql`);
  fs.writeFileSync(file, sql);
  try {
    const out = cli(['db', 'query', '--linked', '--workdir', workdir, '-f', file], {
      cwd: workdir,
    });
    const at = out.indexOf('{');
    if (at < 0) throw new Error(`no JSON in the CLI's answer: ${out.slice(0, 400)}`);
    const parsed = JSON.parse(out.slice(at));
    if (parsed._tag === 'Error') throw new Error(parsed.error?.message ?? out);
    return parsed.rows ?? [];
  } finally {
    fs.rmSync(file, { force: true });
  }
};

// ---------------------------------------------------------------------------
// Preflight, read-only
// ---------------------------------------------------------------------------

const versions = FILES.map((f) => f.slice(0, 14));
const versionList = versions.map((v) => `'${v}'`).join(', ');

const before = query(`
  select jsonb_build_object(
    'env',      environment_name(),
    'applied',  (select count(*) from supabase_migrations.schema_migrations),
    'head',     (select max(version) from supabase_migrations.schema_migrations),
    'present',  (select coalesce(jsonb_agg(version order by version), '[]'::jsonb)
                   from supabase_migrations.schema_migrations
                  where version in (${versionList})),
    'flags',    (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
                   from app_config
                  where key in ('goals.count_watch_events', 'leaderboard.monthly_from_events'))
  ) as r
`)[0].r;

console.log(`target   : ${ref} (${REF_NAMES[ref] ?? target})`);
console.log(`env      : ${before.env}`);
console.log(`applied  : ${before.applied}, head ${before.head}`);
console.log(`flags    : ${JSON.stringify(before.flags)}`);
console.log(`mode     : ${mode}${onlyFlags ? ' (flags only)' : ''}${perFile ? ' per-file' : ''}`);
console.log(`will set : ${flagKeys.length ? `${flagKeys.join(', ')} = ${flagValue}` : 'no flag'}\n`);

if (before.env !== expectedEnv) {
  die(`the database says environment_name() = ${before.env}, which is not ${target}.`);
}

const already = new Set(before.present);
const pending = onlyFlags ? [] : FILES.filter((f) => !already.has(f.slice(0, 14)));

if (!onlyFlags) {
  if (already.size && pending.length) {
    console.log(`note: ${[...already].join(', ')} already applied; applying the rest.`);
  }
  if (!pending.length) {
    console.log('every file is already applied. Use --only-flags to flip a flag alone.');
    if (mode !== 'plan' && flagKeys.length === 0) process.exit(0);
  }
  if (pending.length === FILES.length && before.head !== EXPECTED_HEAD) {
    die(
      `the head is ${before.head}, not ${EXPECTED_HEAD}. These files were reviewed against ` +
        `${EXPECTED_HEAD}; re-read both projects' heads before renumbering anything.`,
    );
  }
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

const root = path.resolve(path.join(import.meta.dirname, '..', '..'));
const sqlFor = (file) => {
  const body = fs.readFileSync(path.join(root, 'supabase', 'migrations', file), 'utf8');
  const version = file.slice(0, 14);
  const name = file.slice(15).replace(/\.sql$/, '');
  return `
-- ======================= ${file} =======================
${body}
insert into supabase_migrations.schema_migrations (version, name)
values ('${version}', '${name}')
on conflict (version) do nothing;
`;
};

/**
 * The gate, inside the transaction.
 *
 * §M.5 says goals RISE and the monthly board FALLS, and §D.7 says the only cached dates
 * the backfill moves are native rows whose diary holds a later date. A delta the other way
 * is not a thing this repoint can legitimately produce, so it aborts the transaction
 * rather than printing a warning somebody reads afterwards.
 */
const GATE = `
set constraints all immediate;

select assert_watch_history_valid();
select assert_placements_valid();

do $gate$
declare
  v_wrong   integer;
  v_unex    integer;
begin
  select count(*) into v_wrong from watch_history_repoint_diff()
   where (metric like 'goal:%' and delta < 0)
      or (metric = 'board:titles' and delta > 0);

  select count(*) into v_unex
    from user_media um
    join media_items m on m.id = um.media_item_id
   where rankable_category(m.kind) is not null
     and um.source = 'in_app'
     and um.watched_on is not null
     and exists (select 1 from watch_events we
                  where we.user_id = um.user_id and we.media_item_id = um.media_item_id
                    and we.basis = 'unattributed' and we.watched_on < um.watched_on)
     and not exists (select 1 from watch_events we
                      where we.user_id = um.user_id and we.media_item_id = um.media_item_id
                        and we.basis = 'diary' and we.watched_on = um.watched_on);

  if v_wrong > 0 and not ${has('--accept-surprises')} then
    raise exception 'GATE: % repoint change(s) move the opposite way to §M.5. Nothing applied.', v_wrong;
  end if;
  if v_unex > 0 and not ${has('--accept-surprises')} then
    raise exception 'GATE: % cached date(s) moved with no authoritative diary date behind them (§D.7). Nothing applied.', v_unex;
  end if;
end
$gate$;
`;

const flagSql = flagKeys.length
  ? `
update app_config set value = '${flagValue}'::jsonb, updated_at = now()
 where key in (${flagKeys.map((k) => `'${k}'`).join(', ')});
`
  : '';

/** One row, one JSON column: the whole record of what the transaction saw. */
const REPORT = `
select jsonb_build_object(
  'env',        environment_name(),
  'applied',    (select count(*) from supabase_migrations.schema_migrations),
  'head',       (select max(version) from supabase_migrations.schema_migrations),
  'flags',      (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from app_config
                  where key in ('goals.count_watch_events','leaderboard.monthly_from_events')),
  'watch_events',      (select count(*) from watch_events),
  'placements',        (select count(*) from ranking_placements),
  'undated_events',    (select count(*) from watch_events where watched_on is null),
  'diary_events',      (select count(*) from watch_events where basis = 'diary'),
  'repoint',    (select coalesce(jsonb_agg(to_jsonb(d) order by d.user_id, d.metric), '[]'::jsonb)
                   from watch_history_repoint_diff() d),
  'cache_moved', (select coalesce(jsonb_agg(jsonb_build_object(
                     'user_id', um.user_id, 'titles', count(*),
                     'explained', count(*) filter (where exists (
                        select 1 from watch_events we
                         where we.user_id = um.user_id and we.media_item_id = um.media_item_id
                           and we.basis = 'diary' and we.watched_on = um.watched_on)))), '[]'::jsonb)
                   from user_media um
                   join media_items m on m.id = um.media_item_id
                  where rankable_category(m.kind) is not null
                    and um.source = 'in_app' and um.watched_on is not null
                    and exists (select 1 from watch_events we
                                 where we.user_id = um.user_id and we.media_item_id = um.media_item_id
                                   and we.basis = 'unattributed' and we.watched_on < um.watched_on)
                  group by um.user_id)
) as r;
`;

if (mode === 'plan') {
  const bytes = pending.reduce((n, f) => n + sqlFor(f).length, 0);
  console.log(`would apply ${pending.length} file(s), ${(bytes / 1024).toFixed(0)}KB of SQL:`);
  for (const f of pending) console.log(`  ${f}`);
  console.log(`\nthen: the gate, then ${flagKeys.length ? flagKeys.join(' + ') : 'no flag'}.`);
  console.log('\nRun --rehearse next (applies and rolls back, printing the diff), then --apply.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// rehearse / apply
// ---------------------------------------------------------------------------

const closing = mode === 'apply' ? 'commit;' : 'rollback;';

const run = (label, sql) => {
  const started = Date.now();
  const rows = query(sql);
  console.log(`  ${label} — ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return rows;
};

let report;
if (perFile && !onlyFlags) {
  for (const file of pending) {
    run(file, `begin;\n${sqlFor(file)}\nselect 1 as r;\n${mode === 'apply' ? 'commit;' : 'rollback;'}`);
  }
  report = run('gate + flags', `begin;\n${GATE}${flagSql}${REPORT}${closing}`)[0]?.r;
} else {
  const body = onlyFlags ? flagSql : `${pending.map(sqlFor).join('\n')}${GATE}${flagSql}`;
  report = run(
    onlyFlags ? 'flags' : `${pending.length} file(s) + gate + flags`,
    `begin;\n${body}${REPORT}${closing}`,
  )[0]?.r;
}

console.log(`\n${mode === 'apply' ? 'COMMITTED' : 'ROLLED BACK'} — as the transaction saw it:`);
console.log(`  env            : ${report.env}`);
console.log(`  applied        : ${report.applied}, head ${report.head}`);
console.log(`  flags          : ${JSON.stringify(report.flags)}`);
console.log(
  `  watch_events   : ${report.watch_events} (${report.undated_events} undated, ${report.diary_events} diary)`,
);
console.log(`  placements     : ${report.placements}`);

console.log(`\n§D.7  cached dates moved by the backfill: ${report.cache_moved.length} account(s)`);
for (const row of report.cache_moved) {
  const flag = Number(row.titles) === Number(row.explained) ? ' ' : '!';
  console.log(`  ${flag} ${row.user_id}  ${row.titles} title(s), ${row.explained} explained by a diary date`);
}

console.log(`\n§M.5  T4 repoint: ${report.repoint.length} change(s)`);
for (const row of report.repoint) {
  console.log(
    `    ${row.user_id}  ${row.metric} ${row.period}  ${row.before_count} → ${row.after_count} (${
      row.delta > 0 ? '+' : ''
    }${row.delta})`,
  );
}
if (!report.repoint.length) console.log('    none — the repoint is invisible on this backend.');

if (mode === 'rehearse') {
  console.log(
    '\nNothing was kept. Read the two lists above, then re-run with --apply.\n' +
      'The gate that just passed runs again inside the applying transaction.',
  );
} else {
  console.log(
    '\nNext: publish the client update on this lane, then flip the goal flag with\n' +
      `  node scripts/ops/watch-history-cutover.mjs --target ${target} --only-flags --flags goals --apply\n` +
      'Rollback for either flag is the same command with --off.',
  );
}
