#!/usr/bin/env node
/**
 * The scheduled welcome-email worker. NOT ENABLED, and it will tell you so.
 *
 *   node emails/welcome/automation/send-welcome.mjs --dry-run
 *   node emails/welcome/automation/send-welcome.mjs
 *
 * Nothing schedules this. There is no workflow file and no cron entry, the migration
 * beside it has not been applied, and `welcome.delivery_enabled` does not exist yet — so
 * a real run today exits at the first gate having read one config row and written
 * nothing. See README.md.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER OF THE GATES IS THE DESIGN
 * ---------------------------------------------------------------------------
 *
 *   1. Is delivery enabled? If not, stop. **Before claiming anything**, so a disabled
 *      run leaves every eligible account still eligible. Hold, do not drop.
 *   2. Who is eligible? Created at or after `welcome.start_after`, at least
 *      `welcome.delay_hours` ago, has no ledger row.
 *   3. Claim, one at a time, with `on conflict do nothing`. No row back, no send.
 *   4. Send with an idempotency key, so a retry of a claim cannot duplicate.
 *   5. Record the outcome.
 *
 * Step 1 before step 3 is the whole point. A worker that claims first and then checks
 * whether it is allowed to send has consumed the people it declined to mail, and turning
 * the flag back on reaches nobody.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');

const DRY = process.argv.includes('--dry-run');

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const resendKey = process.env.RESEND_API_KEY;

/**
 * The envelope. Every one of these is a founder decision that has not been made, and the
 * worker refuses rather than guessing at any of them.
 *
 * `FROM` cannot be `@bingd.app` until that domain is added to Resend: the only verified
 * domain today is `auth.bingd.app`. `REPLY_TO` is the reason this email exists and is
 * useless pointing at a mailbox nobody opens.
 */
const FROM = process.env.WELCOME_FROM ?? null;
const REPLY_TO = process.env.WELCOME_REPLY_TO ?? null;
const UNSUBSCRIBE_MAILTO = process.env.WELCOME_UNSUBSCRIBE ?? null;

const stop = (reason) => {
  console.log(`\n  Not sending: ${reason}\n`);
  process.exit(0);
};

if (!url || !serviceKey) stop('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set.');
if (!DRY && !resendKey) stop('RESEND_API_KEY is not set.');
if (!DRY && (!FROM || !REPLY_TO || !UNSUBSCRIBE_MAILTO)) {
  stop(
    'WELCOME_FROM, WELCOME_REPLY_TO and WELCOME_UNSUBSCRIBE must all be set. ' +
      'None of them has a safe default: the From address needs a verified domain, the ' +
      'Reply-To needs a mailbox somebody reads, and an unsubscribe that goes nowhere is ' +
      'worse than none.',
  );
}

const rest = (path, init = {}) =>
  fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

// ---------------------------------------------------------------------------
// Gate 1 — is delivery enabled at all
// ---------------------------------------------------------------------------

const config = async (key, fallback) => {
  const response = await rest(`app_config?key=eq.${key}&select=value`);
  if (!response.ok) return fallback;
  const rows = await response.json();
  return rows.length ? rows[0].value : fallback;
};

/**
 * Default `false`, and it matters that the default is here as well as in the migration.
 * A missing row must read as off. The opposite mistake — a missing row reading as on —
 * turns a failed migration into a send.
 */
const enabled = await config('welcome.delivery_enabled', false);
if (enabled !== true) {
  stop(
    'welcome.delivery_enabled is not true. Nothing was claimed, so everybody eligible ' +
      'now is still eligible when it is turned on.',
  );
}

const startAfter = await config('welcome.start_after', '2099-01-01T00:00:00Z');
const delayHours = await config('welcome.delay_hours', 36);
const maxPerRun = await config('welcome.max_per_run', 25);

const cutoff = new Date(Date.now() - Number(delayHours) * 3600_000).toISOString();

// ---------------------------------------------------------------------------
// Gate 2 — who is eligible
//
// Deliberately two reads rather than one clever join. PostgREST can express "not in a
// subquery" only awkwardly, and a wrong `not.in` silently selects *more* people, which
// is the single worst direction for a bug in this file to point.
// ---------------------------------------------------------------------------

const claimedResponse = await rest('welcome_emails?select=user_id');
if (!claimedResponse.ok) {
  stop(
    `welcome_emails could not be read (${claimedResponse.status}). The migration in this ` +
      'directory has probably not been applied. Without the ledger there is no ' +
      'idempotency, so this refuses to send rather than sending blind.',
  );
}
const already = new Set((await claimedResponse.json()).map((r) => r.user_id));

const candidatesResponse = await rest(
  `profiles?select=id,username,display_name,created_at` +
    `&created_at=gte.${encodeURIComponent(startAfter)}` +
    `&created_at=lte.${encodeURIComponent(cutoff)}` +
    `&status=eq.active` +
    `&order=created_at.asc&limit=${Number(maxPerRun) * 4}`,
);
if (!candidatesResponse.ok) stop(`profiles could not be read (${candidatesResponse.status}).`);

const candidates = (await candidatesResponse.json())
  .filter((row) => !already.has(row.id))
  .slice(0, Number(maxPerRun));

console.log(`\n  eligible: ${candidates.length}  (start_after ${startAfter}, delay ${delayHours}h)`);

if (candidates.length === 0) stop('nobody is eligible.');

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

const copy = JSON.parse(await readFile(join(here, '..', 'copy.json'), 'utf8'));
const htmlTemplate = await readFile(join(dist, 'welcome.html'), 'utf8');
const textTemplate = await readFile(join(dist, 'welcome.txt'), 'utf8');

if (!copy.footer.postalAddress && !DRY) {
  stop(
    'footer.postalAddress is null. A commercial email needs a physical mailing address, ' +
      'and this one asks the reader to invite a friend, which is enough to be one.',
  );
}

/**
 * `Hi <name>,` when the display name's first word looks like a name, `Hi,` otherwise.
 *
 * It never falls back to the handle. `Hi saisurajkan,` is worse than no name at all: it
 * is the exact tell that nobody wrote this, in an email whose entire claim is that
 * somebody did.
 */
const greeting = (displayName) => {
  const first = String(displayName ?? '').trim().split(/\s+/)[0] ?? '';
  return /^[\p{L}][\p{L}'’-]{1,23}$/u.test(first) ? `Hi ${first},` : 'Hi,';
};

// ---------------------------------------------------------------------------
// Gates 3 to 5 — claim, send, record
// ---------------------------------------------------------------------------

let sent = 0;
let skipped = 0;
let failed = 0;

for (const person of candidates) {
  // The address lives on auth.users, which PostgREST does not expose. The real worker
  // reads it through a SECURITY DEFINER function that returns exactly (id, email) for a
  // set of ids and nothing else, so the service role never carries a general read over
  // the auth schema. That function is part of step 3 in README.md and is not written
  // yet, which is one of the reasons this file cannot send today.
  const address = null;

  if (DRY) {
    console.log(`  would mail  ${person.username.padEnd(20)} ${greeting(person.display_name)}`);
    continue;
  }

  if (!address) {
    await rest('welcome_emails', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify({ user_id: person.id, status: 'no_address' }),
    });
    skipped += 1;
    continue;
  }

  // 3. Claim. `resolution=ignore-duplicates` is PostgREST's `on conflict do nothing`;
  //    `return=representation` is what tells us whether we got it.
  const claim = await rest('welcome_emails', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ user_id: person.id, status: 'claimed' }),
  });
  const claimed = claim.ok ? await claim.json() : [];
  if (claimed.length === 0) {
    skipped += 1;
    continue;
  }

  // 4. Send. The idempotency key is per user and per template version, so a retry of
  //    this claim cannot become a second message, and a genuinely new template later
  //    would not be blocked by an old key.
  const html = htmlTemplate
    .split('{{greeting}}')
    .join(greeting(person.display_name))
    .split('{{handle}}')
    .join(person.username)
    .split('{{unsubscribeUrl}}')
    .join(UNSUBSCRIBE_MAILTO);

  const text = textTemplate
    .split('{{greeting}}')
    .join(greeting(person.display_name))
    .split('{{handle}}')
    .join(person.username)
    .split('{{unsubscribeUrl}}')
    .join(UNSUBSCRIBE_MAILTO);

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `welcome-v1-${person.id}`,
    },
    body: JSON.stringify({
      from: FROM,
      to: [address],
      reply_to: REPLY_TO,
      subject: copy.subject.chosen,
      html,
      text,
      headers: {
        // What gives Gmail and Apple Mail their own one-tap unsubscribe control. Without
        // these the footer link is the only route, and a reader who cannot find it uses
        // the spam button instead, which costs the sending domain rather than the list.
        'List-Unsubscribe': `<${UNSUBSCRIBE_MAILTO}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });

  // 5. Record.
  const body = await response.json().catch(() => null);
  await rest(`welcome_emails?user_id=eq.${person.id}`, {
    method: 'PATCH',
    body: JSON.stringify(
      response.ok
        ? { status: 'sent', resend_id: body?.id, sent_at: new Date().toISOString() }
        : {
            status: 'failed',
            failed_reason: `${response.status} ${JSON.stringify(body ?? {}).slice(0, 300)}`,
          },
    ),
  });

  if (response.ok) sent += 1;
  else failed += 1;
}

console.log(`\n  sent ${sent}  skipped ${skipped}  failed ${failed}\n`);
