#!/usr/bin/env node
/**
 * Activate the invitations the 2026-09-11 bar change left behind.
 *
 *   node scripts/backfill-invite-activation.mjs --target nonprod            # report only
 *   node scripts/backfill-invite-activation.mjs --target nonprod --apply
 *   node scripts/backfill-invite-activation.mjs --target prod --apply --yes-write-to-production
 *
 * Reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the environment and nowhere
 * else — never `.env`, and nothing here writes a key to disk. The intended invocation
 * pulls the key into the child process only:
 *
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=$(npx supabase projects api-keys --project-ref <ref> \
 *       --output json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>\
 *       console.log(JSON.parse(s).find(k=>k.name==='service_role').api_key))") \
 *   node scripts/backfill-invite-activation.mjs --target nonprod
 *
 * ---------------------------------------------------------------------------
 * WHY A BACKFILL EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * `20260916000100` lowered `invite.activation_rankings` from ten to five — the completed
 * *Your First Five*. That migration changes the rule and nothing else: `activated_at` is
 * written by `_maybe_activate_invite`, which runs only from `_rank_finalize`, so an
 * invitee who is *already* past five and has `activated_at is null` stays that way until
 * they rank again. For somebody who finished onboarding last week and has not opened the
 * app since, "until they rank again" means never, and their inviter is never credited for
 * a person who genuinely arrived.
 *
 * This closes that, once, for the population that existed when the rule changed.
 *
 * ---------------------------------------------------------------------------
 * WHY A DIRECT UPDATE AND NOT A CALL TO `_maybe_activate_invite`
 * ---------------------------------------------------------------------------
 *
 * Calling the shipped function is the obvious move and it is the wrong one, for two
 * reasons that are both about honesty rather than convenience.
 *
 * **1. It would stamp `now()`.** `activated_at` is a historical fact — *when did this
 * person arrive* — and it is the left-hand side of every invite→activation latency figure
 * anybody will ever compute, including PRD §28's 24-hour bound. Writing `now()` says that
 * everyone in the backlog arrived at 03:00 on the night an operator ran a script. This
 * script instead stamps the moment they actually qualified: the later of their fifth
 * ranking and their redemption, because an attribution cannot activate before it exists.
 * That is the only timestamp that is true of the person rather than of the script.
 *
 * **2. It would file `invite_activated`.** That row is a message between two people about
 * something that just happened, and it is push-eligible (`20260831000100`). Sending it now
 * makes an inviter's phone buzz about a friend who finished onboarding last Tuesday. PRD
 * §15's rule is one notice per fact, and this fact is already cold. So the backfill files
 * nothing, and the inviters are told — if the founder wants them told — by a person.
 *
 * Neither reason says the function is wrong. It is exactly right for the ranking that
 * crosses the bar live, which is what it was written for.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE UPDATE STILL SETS OFF, AND IT IS NOT NOTHING
 * ---------------------------------------------------------------------------
 *
 * `award_on_invite_activation` (`20260828000100`, unchanged since) is
 *
 *   after update of activated_at on invite_attributions
 *   for each row when (new.activated_at is not null and old.activated_at is null)
 *
 * so **a plain UPDATE fires it**, exactly as the live path does. It calls
 * `_maybe_award_unlocks(inviter, ['invite-instigator'])`, which walks 3 / 15 / 50
 * ascending and, for any tier the inviter's activated count now reaches:
 *
 *   - inserts `award_unlocks (user_id, award_key, tier_key, value_at_unlock)` — the count
 *     at the moment of crossing, frozen and never re-derived;
 *   - because `invite-instigator` is a **social** track, posts a public `award_earned`
 *     feed event;
 *   - files the inviter an `award_earned` congratulations notification; and
 *   - sets `announced = true`.
 *
 * The last two are worth reading twice. `announced` does **not** stay false. False is the
 * column default and the shape `20260828000100`'s own rollout backfill inserted directly
 * and deliberately, so that pre-existing progress produced no social event — but anything
 * that goes *through* `_maybe_award_unlocks` announces immediately. A backfilled
 * activation that crosses a tier is therefore a public feed post and a push, today, for an
 * achievement that became true days ago.
 *
 * That is usually fine — the person really did bring three people — but it is a decision
 * rather than a side effect, so this script **reports every tier that would cross before
 * it writes anything**. If the founder wants the credit without the celebration, insert
 * the ledger row first with `announced = false`: `_maybe_award_unlocks` sees the row
 * exists and `continue`s past that tier, announcing nothing.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENCY
 * ---------------------------------------------------------------------------
 *
 * Every write is `PATCH ...?invitee_id=eq.X&activated_at=is.null`. The guard is in the
 * filter, so a second run matches zero rows, fires no trigger and writes nothing — and two
 * copies of this script running at once cannot both win a row, because the second UPDATE
 * blocks on the first's row lock and re-evaluates `activated_at is null` on release, which
 * is the same argument `_maybe_activate_invite` makes for itself.
 *
 * Even a forced re-run could not double-announce: `award_unlocks` is keyed on
 * (user_id, award_key, tier_key), and both the feed event and the congratulations carry
 * partial unique indexes written `on conflict do nothing`.
 *
 * It is also self-limiting in the right direction. The bar is read from `app_config`
 * rather than hardcoded, so running this *before* the migration is applied uses the old
 * ten and finds nobody — a no-op, not a wrong answer.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { supabaseProjectRef, REF_NAMES } = require('../config/backends.cjs');
const { environmentForRef } = require('../config/production-lane.cjs');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The same write as one statement, for an operator who would rather paste it into the SQL
 * editor. Read from the file rather than duplicated here, and the file is what
 * `supabase/tests/invite-activation-backfill.test.mjs` runs — two spellings of one write
 * that drift apart are worse than either alone.
 */
const EQUIVALENT_SQL = readFileSync(
  join(root, 'supabase', 'backfills', 'invite-activation-2026-09-11.sql'),
  'utf8',
);

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const productionAcknowledged = argv.includes('--yes-write-to-production');
const target = argv.includes('--target') ? argv[argv.indexOf('--target') + 1] : null;

const USAGE =
  'usage: node scripts/backfill-invite-activation.mjs --target <prod|nonprod> [--apply]\n\n' +
  '  --target is required and is never inferred. It is checked against what\n' +
  '  config/production-lane.cjs says the project behind SUPABASE_URL actually is, so\n' +
  '  naming one and being pointed at the other is a refusal rather than a surprise.\n\n' +
  '  Without --apply this reports exactly what it would write and changes nothing.\n' +
  '  Writing to production additionally requires --yes-write-to-production.\n';

if (!target || !['prod', 'nonprod'].includes(target)) {
  console.error(USAGE);
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n\n' + USAGE);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The guard, on the parsed host rather than on the string
//
// `bootstrap-production.mjs`'s rule, for its reason: `url.includes(ref)` passes for
// `https://<ref>.example.com`, a hostname anybody can register, and this process is
// holding a service-role key it is about to post somewhere.
// ---------------------------------------------------------------------------

const ref = supabaseProjectRef(url);
if (ref === null) {
  console.error(`SUPABASE_URL is not a Supabase project URL: ${url}`);
  process.exit(1);
}

const environment = environmentForRef(ref);
if (environment === null) {
  console.error(`The project ${ref} is not one this repository knows about.`);
  process.exit(1);
}

if (environment !== target) {
  console.error(
    `--target ${target} was named, but ${ref} (${REF_NAMES[ref] ?? 'unnamed'}) is the ` +
      `${environment} project. Refusing.`,
  );
  process.exit(1);
}

if (environment === 'prod' && apply && !productionAcknowledged) {
  console.error(
    'This would write to PRODUCTION. Re-run with --yes-write-to-production if that is\n' +
      'what you mean. The only undo is the rollback statement this script prints.',
  );
  process.exit(1);
}

console.log('---------------------------------------------------------------');
console.log(`  project     ${ref} (${REF_NAMES[ref] ?? 'unnamed'})`);
console.log(`  environment ${environment}`);
console.log(`  url         ${url}`);
console.log(`  mode        ${apply ? 'APPLY — this WILL write' : 'report only, writes nothing'}`);
console.log('---------------------------------------------------------------\n');

// ---------------------------------------------------------------------------
// PostgREST, with the service key
//
// Deliberately not a definer RPC that runs arbitrary SQL. A one-off operator task is not
// worth a permanent hole in the schema, and every read and write below is expressible as
// an ordinary request.
// ---------------------------------------------------------------------------

const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  'Content-Type': 'application/json',
};

async function get(path, extra = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: { ...headers, ...extra } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${text}`);
  return { rows: text ? JSON.parse(text) : [], range: res.headers.get('content-range') };
}

async function patch(path, body) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PATCH ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : [];
}

/** How many rankings an account has, from the exact count PostgREST will compute for us. */
async function rankingCount(userId) {
  const { range } = await get(`rankings?select=user_id&user_id=eq.${userId}&limit=1`, {
    Prefer: 'count=exact',
  });
  return Number((range ?? '*/0').split('/')[1] ?? 0);
}

/** The `n`-th ranking's `created_at`, oldest first — the moment the bar was reached. */
async function nthRankingAt(userId, n) {
  const { rows } = await get(
    `rankings?select=created_at,media_item_id&user_id=eq.${userId}` +
      `&order=created_at.asc,media_item_id.asc&offset=${n - 1}&limit=1`,
  );
  return rows[0]?.created_at ?? null;
}

const short = (id) => (typeof id === 'string' ? id.slice(0, 8) : String(id));
const later = (a, b) => (new Date(a) >= new Date(b) ? a : b);

async function main() {
  // ---------------------------------------------------------------------------
  // The bar, from the database rather than from this file
  // ---------------------------------------------------------------------------
  const { rows: config } = await get(
    `app_config?select=value&key=eq.invite.activation_rankings`,
  );
  const bar = config.length ? Number(config[0].value) : 5;
  console.log(`Bar: ${bar} ranked titles (app_config['invite.activation_rankings'])\n`);

  // ---------------------------------------------------------------------------
  // Who qualifies
  // ---------------------------------------------------------------------------
  const { rows: pending } = await get(
    'invite_attributions?select=invitee_id,inviter_id,accepted_at,activated_at' +
      '&accepted_at=not.is.null&activated_at=is.null',
  );

  const qualified = [];
  for (const row of pending) {
    const count = await rankingCount(row.invitee_id);
    if (count < bar) continue;
    const reachedAt = await nthRankingAt(row.invitee_id, bar);
    // `greatest(the bar-th ranking, accepted_at)`, and both halves are necessary. The
    // ranking alone is wrong for the ordinary "redeemed after ranking" case that
    // `20260819000500` calls out as the reason the count is `>=` and not `=`: the fifth
    // ranking predates the attribution, and stamping it would record somebody activating
    // an invitation they had not yet accepted.
    qualified.push({ ...row, rankings: count, qualifiedAt: later(reachedAt, row.accepted_at) });
  }
  qualified.sort((a, b) => new Date(a.qualifiedAt) - new Date(b.qualifiedAt));

  console.log(`${pending.length} unactivated attribution(s); ${qualified.length} qualify.\n`);

  if (qualified.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  for (const row of qualified) {
    console.log(
      `  invitee ${short(row.invitee_id)}  inviter ${short(row.inviter_id)}  ` +
        `${row.rankings} rankings  ->  activated_at ${row.qualifiedAt}`,
    );
  }

  // ---------------------------------------------------------------------------
  // What the award trigger would then do — printed BEFORE anything is written
  // ---------------------------------------------------------------------------
  const { rows: tiers } = await get(
    'award_tiers?select=tier_key,tier_index,threshold&award_key=eq.invite-instigator' +
      '&order=tier_index.asc',
  );

  console.log('\nInvite Instigator, before and after:\n');
  const inviters = [...new Set(qualified.map((row) => row.inviter_id))].filter(Boolean);
  for (const inviter of inviters) {
    const { range } = await get(
      `invite_attributions?select=invitee_id&inviter_id=eq.${inviter}` +
        `&activated_at=not.is.null&limit=1`,
      { Prefer: 'count=exact' },
    );
    const before = Number((range ?? '*/0').split('/')[1] ?? 0);
    const after = before + qualified.filter((row) => row.inviter_id === inviter).length;

    const { rows: held } = await get(
      `award_unlocks?select=tier_key&user_id=eq.${inviter}&award_key=eq.invite-instigator`,
    );
    const heldKeys = new Set(held.map((row) => row.tier_key));
    const crossing = tiers
      .filter((t) => t.threshold > before && t.threshold <= after && !heldKeys.has(t.tier_key))
      .map((t) => t.tier_key);

    console.log(
      `  inviter ${short(inviter)}  ${before} -> ${after}  ` +
        (crossing.length
          ? `CROSSES ${crossing.join(', ')} — a PUBLIC feed post and a push, today`
          : 'no tier crossed, nothing is announced'),
    );
  }

  if (!apply) {
    console.log('\nReport only. Re-run with --apply to write.');
    console.log('\nThe equivalent single statement, for the SQL editor:\n');
    console.log(EQUIVALENT_SQL);
    return;
  }

  // ---------------------------------------------------------------------------
  // The write, one guarded row at a time
  // ---------------------------------------------------------------------------
  console.log('\nWriting…\n');
  const written = [];
  for (const row of qualified) {
    const result = await patch(
      `invite_attributions?invitee_id=eq.${row.invitee_id}&activated_at=is.null`,
      { activated_at: row.qualifiedAt },
    );
    if (result.length === 0) {
      console.log(`  invitee ${short(row.invitee_id)}  already activated by somebody else, skipped`);
      continue;
    }
    written.push(result[0]);
    console.log(`  invitee ${short(row.invitee_id)}  activated_at ${result[0].activated_at}`);
  }

  console.log(`\nWrote ${written.length} row(s).`);
  if (written.length === 0) return;

  console.log('\nRollback — this reverses the activations and nothing else:\n');
  console.log('  update invite_attributions set activated_at = null');
  console.log(`   where invitee_id in (${written.map((r) => `'${r.invitee_id}'`).join(', ')});`);
  console.log('\n  -- Only if the report above said a tier crossed, also remove what announced it:');
  console.log("  -- delete from notifications where type = 'award_earned'");
  console.log("  --   and payload ->> 'award' = 'invite-instigator' and recipient_id = '<inviter>';");
  console.log("  -- delete from feed_events   where type = 'award_earned'");
  console.log("  --   and payload ->> 'award' = 'invite-instigator' and actor_id = '<inviter>';");
  console.log("  -- delete from award_unlocks where award_key = 'invite-instigator'");
  console.log("  --   and user_id = '<inviter>' and tier_key = '<tier>';");
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
