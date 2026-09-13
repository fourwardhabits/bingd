#!/usr/bin/env node
/**
 * The welcome-email worker. NOT ENABLED: nothing schedules it, and no database has its
 * functions until `welcome_email.sql` is applied.
 *
 *   node emails/welcome/automation/send-welcome.mjs --dry-run
 *   node emails/welcome/automation/send-welcome.mjs --dry-run --canary <user-id> --canary-email <address>
 *   node emails/welcome/automation/send-welcome.mjs --canary <user-id> --canary-email <address>
 *   node emails/welcome/automation/send-welcome.mjs
 *
 * Environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and for anything but a dry run
 * RESEND_API_KEY. WELCOME_FROM and WELCOME_REPLY_TO override the envelope in
 * `../envelope.mjs` and are normally left unset.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE GUARANTEES LIVE
 * ---------------------------------------------------------------------------
 *
 * Not here. Every rule that decides who gets mailed is in SQL, in `welcome_email.sql`,
 * where it is tested against every real migration and against a real PostgreSQL with two
 * connections racing:
 *
 *   welcome_email_preview   who a claim would take, taking nobody. The dry run.
 *   welcome_email_claim     the switch, the signup window, the eligibility rules, the
 *                           suppression list, the exactly-once claim and the bounded retry.
 *   welcome_email_record    the outcome, for exactly the attempt that was claimed.
 *
 * This file asks the database who it owns, sends each of them one request with an
 * idempotency key, and records what Resend said. A bug here can fail to send. It cannot
 * choose a second recipient, because it never chooses anybody.
 *
 * ---------------------------------------------------------------------------
 * THE CANARY
 * ---------------------------------------------------------------------------
 *
 * `--canary <user-id> --canary-email <address>` runs the real claim, the real send and
 * the real record for exactly one account, and only if that account's confirmed address
 * is exactly the address given. Both halves are checked inside SQL, before any claim. It
 * ignores `welcome.delivery_enabled` and the signup window and nothing else, which is
 * what lets it prove the automation on a founder test account without switching the
 * automation on for anybody.
 *
 * Run it twice. The first run sends one message and records it; the second finds the
 * ledger row and sends nothing. That is the proof.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_FROM,
  DEFAULT_REPLY_TO,
  TEMPLATE_VERSION,
  greetingFor,
  inviteUrlFor,
  isAddress,
  loadTemplate,
  personalise,
  resendPayload,
  sendViaResend,
  unsubscribeFor,
} from '../envelope.mjs';

const welcomeRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The key Resend deduplicates on: one per person per template version. */
export const idempotencyKeyFor = (userId) => `welcome-${TEMPLATE_VERSION}-${userId}`;

const parseArgs = (argv) => {
  const known = new Set(['--dry-run', '--canary', '--canary-email', '--limit']);
  for (const arg of argv) {
    if (arg.startsWith('--') && !known.has(arg)) throw new Error(`unknown argument ${arg}`);
  }
  const value = (name) => {
    const at = argv.indexOf(name);
    return at > -1 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : null;
  };
  return {
    dryRun: argv.includes('--dry-run'),
    canary: argv.includes('--canary') || argv.includes('--canary-email'),
    canaryUser: value('--canary'),
    canaryEmail: value('--canary-email'),
    limit: value('--limit'),
  };
};

/** Line endings normalised, as in build.mjs: a Windows checkout and CI must agree. */
const sha256 = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

/**
 * Proof that `dist/` was rendered from the `copy.json` on disk. Without it, a copy edit
 * nobody rebuilt would send the previous words while every review read the new ones.
 */
const assertFreshBuild = async (root) => {
  const [manifest, copy, targets] = await Promise.all([
    readFile(join(root, 'dist', 'manifest.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'copy.json'), 'utf8'),
    readFile(join(root, 'targets.json'), 'utf8'),
  ]);
  if (manifest.copy !== sha256(copy) || manifest.targets !== sha256(targets)) {
    throw new Error('dist/ is stale: copy.json or targets.json changed since the last build. Run node emails/welcome/build.mjs');
  }
};

/**
 * One run. Returns a summary whose `code` is the process exit code.
 *
 * Everything the outside world supplies is a parameter, so
 * `supabase/tests/welcome-email.test.mjs` runs this exact function against the real SQL
 * with a recorded Resend.
 */
export async function run({
  argv = [],
  env = {},
  fetch: fetchImpl = fetch,
  log = console.log,
  root = welcomeRoot,
  pauseMs = 600,
} = {}) {
  const summary = { mode: null, claimed: 0, sent: 0, failed: 0, unrecorded: 0, code: 0 };
  const stop = (message, code = 0) => {
    log(`\n  ${code === 0 ? 'Not sending' : 'Refusing'}: ${message}\n`);
    return { ...summary, code, reason: message };
  };

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    return stop(error.message, 2);
  }

  const { canary } = args;
  summary.mode = `${args.dryRun ? 'dry-run' : 'send'}${canary ? ' canary' : ''}`;

  if (canary && !(UUID.test(args.canaryUser ?? '') && isAddress(args.canaryEmail ?? ''))) {
    return stop("a canary needs both --canary <account uuid> and --canary-email <that account's address>.", 2);
  }

  const url = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return stop('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set.', 2);

  const limit = args.limit === null ? null : Number(args.limit);
  if (limit !== null && !(Number.isInteger(limit) && limit >= 0)) return stop(`--limit ${args.limit} is not a count.`, 2);

  const rpc = async (name, body) => {
    const response = await fetchImpl(new URL(`/rest/v1/rpc/${name}`, url), {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`${name} answered ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`);
    }
    return payload;
  };

  const scope = {
    p_limit: canary ? 1 : limit,
    p_canary_user: canary ? args.canaryUser : null,
    p_canary_email: canary ? args.canaryEmail.toLowerCase() : null,
  };

  // -------------------------------------------------------------------------
  // Dry run: the preview, which claims nobody and needs no Resend key.
  // -------------------------------------------------------------------------

  if (args.dryRun) {
    let preview;
    try {
      preview = await rpc('welcome_email_preview', scope);
    } catch (error) {
      return stop(`${error.message}. A 404 means welcome_email.sql is not applied to this project.`, 1);
    }
    const ignored = canary ? '   (a canary ignores this)' : '';
    log('');
    log(`  delivery_enabled  ${preview.delivery_enabled}${ignored}`);
    log(`  start_after       ${preview.start_after}${ignored}`);
    log(`  window            ${preview.delay_hours}h to ${preview.max_age_hours}h after signup, at most ${preview.max_per_run} per run`);
    log(`  would claim       ${preview.candidates.length}`);
    log(`  held, no invite   ${preview.waiting_for_invite_link}   (eligible, but no personal invite link yet)`);
    for (const c of preview.candidates) {
      log(`    ${c.suppressed ? 'suppressed ' : '           '}@${c.username}  signed up ${c.signed_up_at}`);
    }
    log('\n  DRY RUN. Nothing was claimed and nothing was sent.\n');
    return { ...summary, wouldClaim: preview.candidates.length, preview };
  }

  // -------------------------------------------------------------------------
  // A real run. Everything that can refuse, refuses before a claim.
  // -------------------------------------------------------------------------

  const resendKey = env.RESEND_API_KEY;
  if (!resendKey) return stop('RESEND_API_KEY is not set.', 2);

  const from = env.WELCOME_FROM || DEFAULT_FROM;
  const replyTo = env.WELCOME_REPLY_TO || DEFAULT_REPLY_TO;
  if (!isAddress(from) || !isAddress(replyTo)) return stop(`From "${from}" or Reply-To "${replyTo}" is not an address.`, 2);

  let template;
  try {
    await assertFreshBuild(root);
    template = await loadTemplate(root);
  } catch (error) {
    return stop(error.message, 1);
  }
  const { copy } = template;

  /**
   * The founder's approval gate, for the cohort. A canary goes to a test inbox and may
   * carry unapproved copy and a placeholder address; nobody else's email may.
   */
  const ready = Boolean(copy.footer?.postalAddress) && copy.letter?.status === 'APPROVED';
  if (!canary && !copy.footer?.postalAddress) {
    return stop('footer.postalAddress in copy.json is null. A commercial email needs a physical mailing address.', 1);
  }
  if (!canary && copy.letter?.status !== 'APPROVED') {
    return stop(`letter.status in copy.json is "${copy.letter?.status}". The founder approves the copy by setting it to "APPROVED".`, 1);
  }
  if (canary && !ready) {
    log('  ! canary: the copy is a draft or has no postal address. Allowed for a test inbox, refused for the cohort.');
  }

  let owned;
  try {
    owned = await rpc('welcome_email_claim', scope);
  } catch (error) {
    return stop(`${error.message}. Nothing was claimed.`, 1);
  }

  /**
   * The SQL already confines a canary to one account. This is a second lock on the same
   * door: if anybody else came back, send to nobody.
   */
  if (
    canary &&
    owned.some((row) => row.recipient_id !== args.canaryUser || row.recipient_email !== args.canaryEmail.toLowerCase())
  ) {
    return stop('the claim returned an account other than the canary. Nothing was sent. Read welcome_emails before running again.', 1);
  }

  summary.claimed = owned.length;
  log(`\n  ${summary.mode}: claimed ${owned.length}`);

  const unsubscribeUrl = unsubscribeFor(replyTo);

  for (const [index, person] of owned.entries()) {
    if (index > 0 && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));

    let outcome;
    try {
      /**
       * The recipient's own invite link, as the claim read it: never minted here. The
       * claim only returns people who have one, so a missing or malformed token is a
       * defect, and it fails this send (recorded, retried) rather than sending a letter
       * whose "here's your invite link" points nowhere.
       */
      inviteUrlFor(person.invite_token);
      const values = {
        greeting: greetingFor(person.display_name, copy.letter.greeting),
        inviteToken: person.invite_token,
        unsubscribeUrl,
      };
      outcome = await sendViaResend({
        fetch: fetchImpl,
        apiKey: resendKey,
        idempotencyKey: idempotencyKeyFor(person.recipient_id),
        payload: resendPayload({
          from,
          replyTo,
          to: person.recipient_email,
          subject: copy.subject.chosen,
          html: personalise(template.html, values),
          text: personalise(template.text, values),
          unsubscribeUrl,
        }),
      });
    } catch (error) {
      outcome = { ok: false, status: 0, id: null, body: { error: error.message } };
    }

    let recorded = false;
    try {
      recorded = await rpc(
        'welcome_email_record',
        outcome.ok
          ? { p_user: person.recipient_id, p_attempt: person.attempt, p_outcome: 'sent', p_resend_id: outcome.id }
          : {
              p_user: person.recipient_id,
              p_attempt: person.attempt,
              p_outcome: 'failed',
              p_reason: `${outcome.status} ${JSON.stringify(outcome.body ?? {})}`,
            },
      );
    } catch (error) {
      log(`  ! could not record @${person.username}: ${error.message}`);
    }

    if (outcome.ok) summary.sent += 1;
    else summary.failed += 1;

    /**
     * Unrecorded means the row is still `claimed`, and a claimed row is never retried,
     * because it could be a message that went out. That is the at-most-once side of the
     * trade, and it is reported rather than silent.
     */
    if (recorded !== true) summary.unrecorded += 1;

    log(
      `  ${outcome.ok ? 'sent  ' : 'FAILED'} @${person.username} attempt ${person.attempt}` +
        (outcome.ok ? ` resend ${outcome.id}` : ` status ${outcome.status}`) +
        (recorded === true ? '' : '  NOT RECORDED: stays claimed, never retried'),
    );
  }

  log(`\n  sent ${summary.sent}  failed ${summary.failed}  unrecorded ${summary.unrecorded}\n`);
  summary.code = summary.failed > 0 || summary.unrecorded > 0 ? 1 : 0;
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ argv: process.argv.slice(2), env: process.env });
  process.exit(result.code);
}
