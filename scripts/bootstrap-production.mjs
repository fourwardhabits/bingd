#!/usr/bin/env node
/**
 * The step between "the migrations have been replayed" and "this is a Bingd environment".
 *
 *   node scripts/bootstrap-production.mjs                 # report only, changes nothing
 *   node scripts/bootstrap-production.mjs --apply
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A STEP AT ALL, RATHER THAN A MIGRATION THAT JUST DOES IT
 *
 * `20260817001300` seeds `app_config['env.name'] = 'nonprod'`, and every reader of that key
 * defaults to `'nonprod'` when it is missing. So **a production project replayed from zero
 * comes up believing it is nonprod**, and `create_invite_link` stamps that belief onto every
 * token it mints — which PRD §17 then uses to decide that the token does not belong to this
 * environment.
 *
 * The seed is not edited to fix that. It has already run on the friend-Beta project; editing
 * it now would mean the two databases disagree about what they replayed, and the disagreement
 * would be invisible until something depended on it. An explicit step after the replay is the
 * cheaper half of that trade, and this is it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT AN NPM SCRIPT
 *
 * `package.json`'s `scripts` object is a `@expo/fingerprint` input. Adding a key to it moves
 * every lane's runtime version, including `beta`, and a beta whose fingerprint moved stops
 * receiving over-the-air updates with a redistribution as the only fix. The same reason
 * `push-sender`'s Deno checks are spelled out inline in `.github/workflows/ci.yml`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REFUSES
 *
 * It holds a service-role key and posts it to whatever `SUPABASE_URL` says, so the guard is on
 * the **parsed host** and not on the string — `url.includes(ref)` passes for
 * `https://<ref>.example.com`, which is a hostname anybody can register. Same finding, same
 * shape of fix, as `two-user-acceptance.mjs`.
 *
 * Beyond that it refuses to guess. `--target` has to be named and has to agree with what
 * `config/production-lane.cjs` says the project is; naming production and being pointed at
 * nonprod is a refusal rather than a warning, because the whole point of this file is that
 * getting the environment wrong is the failure being prevented.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { supabaseProjectRef } = require('../config/backends.cjs');
const { environmentForRef } = require('../config/production-lane.cjs');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const target = argv.includes('--target') ? argv[argv.indexOf('--target') + 1] : null;

if (!target || !['production', 'nonprod'].includes(target)) {
  console.error(
    'usage: node scripts/bootstrap-production.mjs --target <production|nonprod> [--apply]\n\n' +
      '  --target is required and is not inferred. It is checked against what\n' +
      '  config/production-lane.cjs says the project behind SUPABASE_URL is, so naming one\n' +
      '  and being pointed at the other is a refusal rather than a surprise.\n\n' +
      '  Without --apply this reports what it would do and changes nothing.\n',
  );
  process.exit(2);
}

/** What the database has to end up calling itself. `set_environment_name`'s vocabulary. */
const wanted = target === 'production' ? 'prod' : 'nonprod';

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** Minimal .env reader, matching `refresh-trending.mjs`. Ambient environment wins. */
async function loadEnvFile(name) {
  let text;
  try {
    text = await readFile(join(root, name), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key]) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, '').trim();
  }
}

await loadEnvFile('.env.local');
await loadEnvFile('.env');

const url = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (in .env.local, which is git-ignored).\n' +
      'For production these are the PRODUCTION project\'s, and they do not belong in .env —\n' +
      'see docs/release/production-environment.md.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The guard, on the parsed host
// ---------------------------------------------------------------------------

const ref = supabaseProjectRef(url);
const declared = ref === null ? null : environmentForRef(ref);

if (declared === null) {
  console.error(
    `Refusing: ${url} is not a Supabase project this repository declares.\n\n` +
      '  A service-role key is about to be posted to that host. REF_ENVIRONMENTS in\n' +
      '  config/production-lane.cjs is the list of projects that may receive one, and a\n' +
      '  project is added there in the same reviewed change that adds it to\n' +
      '  config/backends.cjs.\n',
  );
  process.exit(1);
}

if (declared !== wanted) {
  console.error(
    `Refusing: --target ${target} means the ${wanted} database, and ${ref} is declared ${declared}.\n\n` +
      '  One of the two is wrong and this script is not the place to decide which.\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// PostgREST, as service_role
// ---------------------------------------------------------------------------

const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  'Content-Type': 'application/json',
};

async function rpc(name, args = {}) {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(args),
  });
  const body = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* not json */
  }
  return { ok: res.ok, status: res.status, body, parsed };
}

async function upsertConfig(key, value) {
  const res = await fetch(`${url}/rest/v1/app_config?on_conflict=key`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ key, value, updated_at: new Date().toISOString() }]),
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

// ---------------------------------------------------------------------------

const steps = [];
const problems = [];
const note = (text) => steps.push(text);

/**
 * Set when the schema turns out not to have been replayed, so the remaining steps are skipped
 * rather than each failing separately with the same cause.
 *
 * A flag rather than `process.exit`, because a hard exit while a `fetch` agent is still open
 * aborts libuv on Windows — which looks like this script crashing and is not.
 */
let replayed = true;

console.log(`\nBootstrapping ${ref} as the ${wanted} database${apply ? '' : '   (dry run)'}\n`);

// ---------------------------------------------------------------------------
// 1. Has the schema been replayed at all?
// ---------------------------------------------------------------------------

{
  const current = await rpc('environment_name');
  if (!current.ok || typeof current.parsed !== 'string') {
    replayed = false;
    problems.push(
      `environment_name() did not answer — ${current.status} ${current.body.slice(0, 300)}\n` +
        '    That function arrives with 20260826000100. Replay the migrations first:\n' +
        `      supabase link --project-ref ${ref}\n` +
        '      supabase db push',
    );
  } else if (current.parsed === wanted) {
    note(`environment: already ${wanted}`);
  } else if (!apply) {
    note(`environment: ${current.parsed} → ${wanted}   (would change)`);
  } else {
    const set = await rpc('set_environment_name', { p_name: wanted });
    if (!set.ok) {
      // The refusal that matters: a database with people in it may not be renamed, because
      // every invite token it has already minted carries the old name.
      problems.push(`set_environment_name: ${set.status} ${set.body.slice(0, 400)}`);
    } else {
      note(`environment: ${current.parsed} → ${set.parsed?.environment ?? wanted}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Where the Edge Functions live, for the push drain
//
// Not a secret — it is the project's own public URL — and deliberately not in the Vault, so
// that everything in the Vault is a credential.
// ---------------------------------------------------------------------------

const functionsBase = `${url.replace(/\/+$/, '')}/functions/v1`;

if (!replayed) {
  note('functions.base_url: skipped, the schema has not been replayed');
} else if (!apply) {
  note(`functions.base_url: would set to ${functionsBase}`);
} else {
  const res = await upsertConfig('functions.base_url', functionsBase);
  if (!res.ok) problems.push(`functions.base_url: ${res.status} ${res.body.slice(0, 300)}`);
  else note(`functions.base_url: ${functionsBase}`);
}

// ---------------------------------------------------------------------------
// 3. The drain schedule
//
// Best-effort in `20260826000300` — it runs during the replay, when pg_cron and pg_net may
// not be enabled yet. This is the deterministic second attempt, and the one whose failure is
// reported rather than noticed in a migration log.
// ---------------------------------------------------------------------------

if (!replayed) {
  note('push drain: skipped, the schema has not been replayed');
} else if (!apply) {
  note('push drain: would call schedule_push_drain()');
} else {
  const scheduled = await rpc('schedule_push_drain', {});
  if (!scheduled.ok) {
    problems.push(
      `schedule_push_drain: ${scheduled.status} ${scheduled.body.slice(0, 300)}\n` +
        '    Enable pg_cron and pg_net first (Supabase dashboard → Database → Extensions),\n' +
        '    then run this again. Until it is scheduled, push is delivered only when a\n' +
        '    client happens to nudge the sender.',
    );
  } else {
    note(`push drain: scheduled (job ${scheduled.parsed?.jobid}, ${scheduled.parsed?.schedule})`);
  }
}

// ---------------------------------------------------------------------------
// 4. What it looks like now
// ---------------------------------------------------------------------------

if (replayed) {
  const status = await rpc('push_drain_status', {});
  if (status.ok && status.parsed) {
    const s = status.parsed;
    note(
      `status: environment=${s.environment} job=${s.job ? `#${s.job.jobid} ${s.job.schedule}` : 'none'} ` +
        `queued=${s.queued} base_url_set=${s.base_url_set}` +
        ('vault_secret_set' in s ? ` vault_secret_set=${s.vault_secret_set}` : '') +
        ('healthy' in s ? ` healthy=${s.healthy}` : ''),
    );

    /**
     * **The Vault secret is now visible from here, as a boolean, and it is a problem
     * rather than a reminder.**
     *
     * It used to be neither: this block printed a hint if the drain had not run yet, and
     * `push_drain_status()` had no field for the secret at all. On 2026-08-26 that combination
     * let the drain sit dead for twenty hours behind 1,221 `succeeded` cron runs. Since
     * `20260826000700` the status function answers `healthy` and names what is wrong, so a
     * bootstrap that leaves the pipeline unable to send says so in the exit code.
     *
     * Still not *writable* from here, deliberately: a script that could install a
     * service-role key is a script that has to be trusted with where it puts it.
     */
    if ('healthy' in s) {
      const named = Array.isArray(s.problems) ? s.problems : [];

      /**
       * The one problem this script is allowed to downgrade, because it is the only caller
       * that knows the job was scheduled seconds ago.
       *
       * `push_drain_status()` calls a job with no run record unhealthy — review 46, and it
       * is right: a scheduler that has never executed has demonstrated nothing, and a
       * permanently null `last_run` means pg_cron is installed in the wrong database. But
       * for the first minute after `schedule_push_drain()` it is simply true and about to
       * stop being true, and failing the bootstrap on it would teach whoever runs this to
       * ignore its exit code.
       */
      const justScheduled = named.length === 1 && named[0] === 'last_run_missing';
      if (justScheduled) {
        note(
          'the drain has not run yet — pg_cron fires at the top of the next minute.\n' +
            '          Confirm with: node supabase/tests/push-drain-acceptance.mjs',
        );
      } else if (s.healthy !== true) {
        problems.push(
          `the push drain cannot send: ${named.join(', ') || 'unknown'}.\n` +
            (named.includes('vault_service_role_key_missing')
              ? "    Store the key in the SQL editor: select vault.create_secret('<service-role key>', 'service_role_key');\n"
              : '') +
            '    See docs/release/push-operations.md. Verify with' +
            ' node supabase/tests/push-drain-acceptance.mjs',
        );
      }
    } else {
      problems.push(
        'push_drain_status() predates 20260826000700 and cannot report the Vault secret,' +
          ' so it cannot tell you whether push works. Replay migrations before trusting it.',
      );
    }
  }
}

// ---------------------------------------------------------------------------

for (const step of steps) console.log(`  ${step}`);

if (problems.length) {
  console.error('\nProblems:\n');
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exitCode = 1;
} else {
  console.log(
    apply
      ? '\nDone. Verify from the outside: node supabase/tests/remote-smoke.mjs\n'
      : '\nNothing was changed. Re-run with --apply.\n',
  );
}
