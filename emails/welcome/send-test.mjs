#!/usr/bin/env node
/**
 * Sends the rendered welcome email to ONE address you name, through Resend.
 *
 *   node emails/welcome/build.mjs
 *   node emails/welcome/send-test.mjs --to you@example.com                      (dry run)
 *   RESEND_API_KEY=re_xxx node emails/welcome/send-test.mjs --to you@example.com --send
 *
 * Options: --from "Name <address>"  --reply-to <address>  --greeting "Hi Ada,"
 *          --out <dir>  writes the exact request body as JSON and the personalised HTML
 *          and text beside it, so every header, URL and both parts can be read before
 *          anything is sent.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS WILL NOT DO
 * ---------------------------------------------------------------------------
 *
 *   - **It has no default recipient,** and it cannot find one. It does not read a
 *     database, does not import a Supabase client and does not look at SUPABASE_* in the
 *     environment. The only address it can mail is the one typed after `--to`, and
 *     `email.test.mjs` fails if this file ever grows a way to read a user list.
 *   - **One recipient per run.** A comma, a semicolon, a second `--to`, `--cc` or `--bcc`
 *     is refused. For a second inbox, run it a second time.
 *   - **Nothing is sent without `--send`.**
 *   - **It is not the automation.** It writes no ledger row. See `automation/README.md`.
 *
 * ---------------------------------------------------------------------------
 * THE ENVELOPE
 * ---------------------------------------------------------------------------
 *
 * The request body comes from `envelope.mjs`, the same function the automation uses, so a
 * test send is the real message with a test recipient and `[TEST]` on the subject.
 *
 * From defaults to `Suraj from bingd. <suraj@bingd.app>`, which Resend refuses until
 * `bingd.app` is verified there. Until then, test with
 * `--from "Suraj from bingd. <suraj@auth.bingd.app>"`: the only verified domain today.
 * Reply-To stays `suraj@bingd.app` either way, which is the thing to test.
 *
 * `RESEND_API_KEY` is read from the environment only and written nowhere. Make a key for
 * this email; never reuse the one named `Supabase`, which relays every sign-in code.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_FROM,
  DEFAULT_REPLY_TO,
  addressOf,
  isAddress,
  loadTemplate,
  personalise,
  resendPayload,
  sendViaResend,
  unsubscribeFor,
} from './envelope.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

const die = (...lines) => {
  console.error(['', ...lines, ''].join('\n'));
  process.exit(1);
};

const known = new Set(['--to', '--from', '--reply-to', '--greeting', '--out', '--send']);
for (const arg of argv) {
  if (/^--(cc|bcc)$/.test(arg)) die(`Refusing ${arg}. This sends one message to one address.`);
  if (arg.startsWith('--') && !known.has(arg)) die(`Unknown option ${arg}.`);
}

const flag = (name) => {
  const at = argv.indexOf(name);
  return at > -1 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : null;
};

// ---------------------------------------------------------------------------
// The recipient
// ---------------------------------------------------------------------------

if (argv.filter((a) => a === '--to').length > 1) {
  die('One --to per run. For a second inbox, run the command again.');
}

const to = flag('--to');
if (!to) {
  die(
    'No recipient. Pass one:',
    '',
    '  node emails/welcome/send-test.mjs --to you@example.com',
    '',
    'There is deliberately no default. Nothing in this repository knows which address you',
    'actually read, and a script that guessed would eventually guess wrong.',
  );
}
if (/[,;<>\s]/.test(to) || !isAddress(to)) die(`Refusing "${to}". Pass exactly one plain address.`);

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

const from = flag('--from') ?? DEFAULT_FROM;
const replyTo = flag('--reply-to') ?? DEFAULT_REPLY_TO;

let template;
try {
  template = await loadTemplate(here);
} catch {
  die('Nothing rendered yet. Run `node emails/welcome/build.mjs` first.');
}
const { copy } = template;

const unsubscribeUrl = unsubscribeFor(replyTo);
const values = { greeting: flag('--greeting') ?? 'Hi,', handle: 'preview', unsubscribeUrl };

let payload;
try {
  payload = resendPayload({
    from,
    replyTo,
    to,
    subject: `[TEST] ${copy.subject.chosen}`,
    html: personalise(template.html, values),
    text: personalise(template.text, values),
    unsubscribeUrl,
  });
} catch (error) {
  die(error.message);
}

const links = [...new Set([...payload.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]))];

const warnings = [];
if (!copy.footer.postalAddress) warnings.push('footer.postalAddress is null: the footer shows a placeholder. Fine for a test.');
if (copy.note.status !== 'APPROVED') warnings.push(`note.status is "${copy.note.status}": the automation would refuse this copy.`);
if (!/@(auth\.)?bingd\.app$/i.test(addressOf(from))) warnings.push(`From "${from}" is not on a bingd. domain; Resend will refuse it.`);
if (/@bingd\.app$/i.test(addressOf(from))) {
  warnings.push('From is @bingd.app, which Resend refuses until bingd.app is verified there. If it does, retry with --from "Suraj from bingd. <suraj@auth.bingd.app>".');
}

console.log('');
console.log('  To          ', payload.to[0]);
console.log('  From        ', payload.from);
console.log('  Reply-To    ', payload.reply_to);
console.log('  Subject     ', payload.subject);
console.log('  Headers     ', JSON.stringify(payload.headers));
console.log('  HTML        ', `${(payload.html.length / 1024).toFixed(1)}KB, ${(payload.html.match(/<img\b/gi) ?? []).length} images`);
console.log('  Text        ', `${(payload.text.length / 1024).toFixed(1)}KB`);
console.log('  Links');
for (const link of links) console.log(`     ${link}`);
for (const warning of warnings) console.log(`\n  ! ${warning}`);

const out = flag('--out');
if (out) {
  const dir = resolve(out);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'request.json'), `${JSON.stringify(payload, null, 2)}\n`);
  await writeFile(join(dir, 'message.html'), payload.html);
  await writeFile(join(dir, 'message.txt'), payload.text);
  console.log(`\n  Wrote request.json, message.html and message.txt to ${dir}`);
}

if (!argv.includes('--send')) {
  console.log('\n  DRY RUN. Nothing was sent. Add --send, with RESEND_API_KEY set, to send it.\n');
  process.exit(0);
}

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  die(
    'RESEND_API_KEY is not set.',
    '',
    'Make a key in the Resend dashboard for this email (never reuse the one named Supabase):',
    '',
    '  RESEND_API_KEY=re_xxx node emails/welcome/send-test.mjs --to you@example.com --send',
  );
}

/**
 * The idempotency key includes a hash of the exact request. Resend holds a key for 24
 * hours and refuses the same key with a different body, so a key of recipient-and-hour
 * made "edit the copy, send again" fail for the rest of the hour. Now an identical
 * request is deduplicated and an edited one is a new message.
 */
const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
const result = await sendViaResend({ apiKey, idempotencyKey: `welcome-test-${digest}`, payload });

if (!result.ok) {
  die(
    `Resend refused the send: ${result.status}`,
    JSON.stringify(result.body, null, 2),
    '',
    /domain/i.test(JSON.stringify(result.body ?? {}))
      ? 'A domain error means the From address is not on a verified domain. Resend has only auth.bingd.app today.'
      : '',
  );
}

console.log(`\n  SENT. Resend id ${result.id}\n`);
console.log('  Check, on a phone and on a desktop:');
console.log('    1. From reads as a person. Reply-To, when you hit reply, is suraj@bingd.app.');
console.log('    2. Reply from THIS inbox. The reply should arrive where suraj@bingd.app forwards.');
console.log('       (Not from the same Gmail that suraj@bingd.app forwards to: Gmail hides a');
console.log('       message that loops back to its own sender.)');
console.log('    3. Light and dark mode. Mobile width: the Follow me button spans the card.');
console.log('    4. With bingd. installed: Open my profile opens the app on the profile;');
console.log('       See it on bingd. opens the title. Without it: the web page, with install.');
console.log('    5. Unsubscribe opens a new email to suraj@bingd.app with subject Unsubscribe.');
console.log('    6. Gmail: Show original, and check the text part and List-Unsubscribe.');
console.log('');
