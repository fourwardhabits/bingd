#!/usr/bin/env node
/**
 * Sends the rendered welcome email to ONE address you name, through Resend.
 *
 *   node emails/welcome/build.mjs
 *   RESEND_API_KEY=re_xxx node emails/welcome/send-test.mjs --to you@example.com
 *   RESEND_API_KEY=re_xxx node emails/welcome/send-test.mjs --to you@example.com --send
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS WILL NOT DO
 * ---------------------------------------------------------------------------
 *
 *   - **It has no default recipient.** Not a constant, not an environment variable, not
 *     the git config email. A send script that knows who to mail when nobody told it is
 *     one typo away from mailing somebody real, and the address in a repository is
 *     always the one that is out of date.
 *   - **It refuses more than one recipient**, and refuses a comma, a semicolon or a
 *     `bcc` anywhere in the arguments. This is a test harness. Anything that looks like
 *     a list is a mistake.
 *   - **It does not send unless you pass `--send`.** Without it you get a dry run that
 *     prints the exact envelope and stops. The default for a thing that cannot be
 *     recalled is to not do it.
 *   - **It is not the automation.** It sends one message, now, because you asked. See
 *     `automation/README.md` for the scheduled job, which is deliberately not wired up.
 *
 * ---------------------------------------------------------------------------
 * THE KEY
 * ---------------------------------------------------------------------------
 *
 * `RESEND_API_KEY` is read from the environment and never from a file, and this script
 * writes it nowhere. The Resend account currently holds exactly one key, named
 * `Supabase`, whose secret was shown once at creation and is in the Supabase SMTP
 * settings. **Do not go looking for it and do not reuse it.** Make a second key in the
 * Resend dashboard, call it something like `welcome-email-test`, and paste it on the
 * command line for the one run. A key that only ever exists in a shell session is a key
 * that cannot leak from this repository.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at > -1 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : null;
};
const has = (name) => argv.includes(name);

const die = (...lines) => {
  console.error('');
  for (const line of lines) console.error(line);
  console.error('');
  process.exit(1);
};

// ---------------------------------------------------------------------------
// The recipient
// ---------------------------------------------------------------------------

const to = flag('--to');

if (!to) {
  die(
    'No recipient. Pass one:',
    '',
    '  RESEND_API_KEY=re_xxx node emails/welcome/send-test.mjs --to you@example.com',
    '',
    'There is deliberately no default. Nothing in this repository knows which address',
    'you actually read, and a script that guessed would eventually guess wrong at the',
    'one moment that matters.',
  );
}

if (/[,;]/.test(to) || argv.some((a) => /^--(cc|bcc)$/.test(a))) {
  die(
    `Refusing "${to}".`,
    '',
    'This sends one message to one address. A list, a cc or a bcc here is a mistake,',
    'and the kind that is only noticed afterwards.',
  );
}

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) die(`"${to}" is not an email address.`);

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/**
 * The From address, and the one real constraint on it tonight.
 *
 * Resend has exactly one verified domain: `auth.bingd.app`, added 2026-08-21 for the
 * Supabase SMTP relay that sends the sign-in codes. **`bingd.app` itself is not in
 * Resend**, so `suraj@bingd.app` cannot send until somebody adds the domain and its DNS
 * records, which is a founder decision and a DNS change and is not happening from here.
 *
 * So the default below is the address that works today and is wrong for the real thing:
 * `auth.` in the From line of a personal note reads like a password reset. It is fine
 * for a test, where the only question is whether the message renders.
 *
 * For the real send, add `bingd.app` to Resend and use
 * `Suraj from bingd. <suraj@bingd.app>`. See automation/README.md.
 */
const from = flag('--from') ?? 'Suraj from bingd. <suraj@auth.bingd.app>';

/**
 * Reply-To, which is the entire point of this email.
 *
 * Defaults to the From address rather than to anything clever, and prints what it used,
 * because a Reply-To pointing at a mailbox nobody opens is the failure this email cannot
 * survive: it asks four times for a reply. The release docs still record
 * `hello@bingd.app` and `support@bingd.app` as unconfirmed for *receiving*, so neither
 * is a safe default.
 */
const replyTo = flag('--reply-to') ?? from.replace(/^.*<|>.*$/g, '');

const apiKey = process.env.RESEND_API_KEY;

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

let html;
let text;
try {
  html = await readFile(join(dist, 'welcome.html'), 'utf8');
  text = await readFile(join(dist, 'welcome.txt'), 'utf8');
} catch {
  die('Nothing rendered yet. Run `node emails/welcome/build.mjs` first.');
}

const copy = JSON.parse(await readFile(join(here, 'copy.json'), 'utf8'));
const targets = JSON.parse(await readFile(join(here, 'targets.json'), 'utf8'));

/**
 * The per-recipient substitutions, filled here with obvious test values.
 *
 * The real job fills the same three from the recipient's row. They are left as tokens in
 * the rendered files on purpose: a template that is already personalised for somebody is
 * a template that will be sent to everybody as that somebody.
 *
 * `{{handle}}` is the recipient's own handle, which is how the second card opens the app
 * on a page belonging to them. `preview` here is a handle that certainly does not exist,
 * so a test send lands on the generic fallback rather than on a stranger's profile.
 */
const substitutions = {
  '{{greeting}}': flag('--greeting') ?? 'Hi,',
  '{{handle}}': flag('--handle') ?? 'preview',
  '{{unsubscribeUrl}}': 'https://bingd.app/#unsubscribe-not-built-yet',
};

const fill = (body) =>
  Object.entries(substitutions).reduce(
    (acc, [token, value]) => acc.split(token).join(value),
    body,
  );

html = fill(html);
text = fill(text);

/** A test is labelled as one, in the one place nobody can miss. */
const subject = `[TEST] ${copy.subject.chosen}`;

const warnings = [];
if (!copy.footer.postalAddress) {
  warnings.push(
    'footer.postalAddress is still null, so the footer shows a bracketed placeholder. ' +
      'Fine for a test. Not fine for a real send: a commercial email needs a physical ' +
      'mailing address.',
  );
}
if (html.includes('{{')) warnings.push('the HTML still contains an unfilled {{token}}.');
if (!/auth\.bingd\.app|@bingd\.app/.test(from)) {
  warnings.push(`From is "${from}", which is not a bingd. domain. Resend will refuse it.`);
}
if (/^no-?reply@/i.test(replyTo)) {
  warnings.push('Reply-To is a no-reply address, which defeats the entire email.');
}

console.log('');
console.log('  To           ', to);
console.log('  From         ', from);
console.log('  Reply-To     ', replyTo);
console.log('  Subject      ', subject);
console.log('  HTML         ', `${(html.length / 1024).toFixed(1)}KB`);
console.log('  Text         ', `${(text.length / 1024).toFixed(1)}KB`);
console.log('  Links        ');
for (const [name, t] of Object.entries(targets.targets)) {
  console.log(`    ${t.classification}  ${name.padEnd(16)} ${fill(t.url)}`);
}

for (const warning of warnings) console.log(`\n  ! ${warning}`);

if (!has('--send')) {
  console.log('');
  console.log('  DRY RUN. Nothing was sent.');
  console.log('  Add --send to actually send it, with RESEND_API_KEY set.');
  console.log('');
  process.exit(0);
}

if (!apiKey) {
  die(
    'RESEND_API_KEY is not set.',
    '',
    'Make a key in the Resend dashboard (do not reuse the one named `Supabase`, which',
    'belongs to the auth relay), then:',
    '',
    '  RESEND_API_KEY=re_xxx node emails/welcome/send-test.mjs --to you@example.com --send',
  );
}

/**
 * `Idempotency-Key` is Resend's own guard against a retried request becoming a second
 * email. It matters more in the scheduled job than it does here, and it costs one header.
 */
const response = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': `welcome-test-${to}-${new Date().toISOString().slice(0, 13)}`,
  },
  body: JSON.stringify({
    from,
    to: [to],
    reply_to: replyTo,
    subject,
    html,
    text,
  }),
});

const body = await response.json().catch(() => null);

if (!response.ok) {
  die(
    `Resend refused the send: ${response.status}`,
    JSON.stringify(body, null, 2),
    '',
    response.status === 403 || /domain/i.test(JSON.stringify(body ?? {}))
      ? 'A domain error here almost certainly means the From address is not on a verified ' +
        'domain. Resend has only auth.bingd.app today.'
      : '',
  );
}

console.log('');
console.log(`  SENT. id ${body?.id}`);
console.log('');
console.log('  Check, in this order:');
console.log('    1. Does the From line read like a person rather than a system?');
console.log('    2. Hit reply. Does it address the mailbox you meant?');
console.log('    3. Read it on a phone. Do the three buttons reach a thumb?');
console.log('    4. Turn the phone to dark mode and open it again.');
console.log('    5. Tap all three buttons on a phone that HAS bingd. installed.');
console.log('       Card one should open the app on my profile. Card three should open');
console.log('       the app on the title. Card two opens the app on your own profile.');
console.log('');
