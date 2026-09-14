import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';

import {
  DEFAULT_FROM,
  DEFAULT_REPLY_TO,
  greetingFor,
  inviteUrlFor,
  personalise,
  resendPayload,
  unsubscribeFor,
} from './envelope.mjs';

/**
 * The welcome email as a reader receives it, 2026-09-13.
 *
 * Run: `node --test emails/welcome/email.test.mjs` (CI runs it beside `test:web`).
 *
 * The SQL and the worker are proven in `supabase/tests/welcome-email.test.mjs`. This file
 * holds the message itself:
 *
 *   1. **The founder's letter is locked.** Its words are hashed; an edit fails here until
 *      the hash is changed on purpose, in the same commit, by somebody who meant to.
 *   2. **The committed email is the one the copy renders.**
 *   3. **Every link lands.** The recipient's own invite link and the founder's profile, on
 *      paths the app claims, in both parts.
 *   4. **Every product label is one the app renders.** Group Picks, For you.
 *   5. **It is a letter.** No images, no buttons, and bold only on the three feature labels.
 *   6. **The test send cannot reach a user list.**
 */

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

/**
 * The founder's approved letter (greeting, paragraphs, sign-off), locked 2026-09-13.
 * Changing a word of it changes this hash. Do not update it to make a test pass: update it
 * because the founder changed his letter.
 */
const LOCKED_LETTER = 'd0c279751c6ad7ee18f788a0c684fc75101dc3aacd946588cb465fa8d6e2b3d3';

const read = (path) => readFile(join(repo, path), 'utf8');
const lf = (text) => text.replace(/\r\n/g, '\n');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let copy;
let targets;
let html;
let text;
let fresh;

before(async () => {
  copy = JSON.parse(await readFile(join(here, 'copy.json'), 'utf8'));
  targets = JSON.parse(await readFile(join(here, 'targets.json'), 'utf8'));
  html = lf(await readFile(join(here, 'dist', 'welcome.html'), 'utf8'));
  text = lf(await readFile(join(here, 'dist', 'welcome.txt'), 'utf8'));

  fresh = await mkdtemp(join(tmpdir(), 'welcome-render-'));
  for (const file of ['build.mjs', 'copy.json', 'targets.json']) {
    await writeFile(join(fresh, file), await readFile(join(here, file), 'utf8'));
  }
  await execFileAsync(process.execPath, [join(fresh, 'build.mjs')]);
});

after(async () => {
  if (fresh) await rm(fresh, { recursive: true, force: true });
});

describe('welcome email: the founder letter', () => {
  it('is exactly the letter the founder approved', () => {
    const { greeting, paragraphs, signoff } = copy.letter;
    const hash = createHash('sha256').update(JSON.stringify({ greeting, paragraphs, signoff })).digest('hex');
    assert.equal(hash, LOCKED_LETTER, 'the founder letter changed. If he changed it, update LOCKED_LETTER in the same commit.');
    assert.equal(copy.letter.status, 'APPROVED');
  });

  it('bolds the three feature labels and nothing else', () => {
    const bold = [...html.matchAll(/<strong[^>]*>([^<]+)<\/strong>/g)].map((m) => m[1]);
    assert.deepEqual(bold, ['Post-watch Ranking:', 'Pre-vetted Watchlist:', 'Smooth Planning:']);
    assert.equal((html.match(/<b>|font-weight:\s*(bold|[5-9]00)/g) ?? []).length, 3, 'no other bold or semibold text, links included');
  });

  it('is a letter: no images, no buttons, no cards', () => {
    assert.doesNotMatch(html, /<img\b/i);
    assert.doesNotMatch(html, /btn-wrap|class="btn"|dk-raised|dk-fill|dk-outline/);
  });

  it('keeps the plain-text part as bingd, with the feature labels as plain text', () => {
    assert.match(text, /^\{\{greeting\}\}\n\nThanks for giving bingd a shot\./);
    assert.match(text, /\nPost-watch Ranking: Instead of picking a number/);
    assert.doesNotMatch(text, /\*\*/);
    assert.match(text, /\nHappy binging,\nSuraj\n/);
  });
});

describe('welcome email: the committed render', () => {
  for (const file of ['welcome.html', 'welcome.txt', 'welcome-dark.html', 'manifest.json']) {
    it(`dist/${file} is exactly what copy.json renders to today`, async () => {
      const committed = lf(await readFile(join(here, 'dist', file), 'utf8'));
      const rendered = lf(await readFile(join(fresh, 'dist', file), 'utf8'));
      assert.equal(committed, rendered, `run node emails/welcome/build.mjs and commit dist/${file}`);
    });
  }

  it('fits under Gmail’s clipping limit and keeps its dark and mobile rules', () => {
    assert.ok(html.length < 102_000, `${html.length} bytes`);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
    assert.match(html, /<meta name="color-scheme" content="light dark" \/>/);
    assert.match(html, /@media \(prefers-color-scheme: dark\)/);
    assert.match(html, /@media only screen and \(max-width: 620px\)/);
  });
});

describe('welcome email: every link lands', () => {
  const hrefs = () => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

  it('carries exactly the invite link, the founder profile and the unsubscribe', () => {
    assert.deepEqual(hrefs().sort(), ['https://bingd.app/i/{{inviteToken}}', 'https://bingd.app/u/saisurajkan', '{{unsubscribeUrl}}'].sort());
  });

  it('links "invite link" to the invite and "follow me on bingd" to the founder profile', () => {
    assert.match(html, /<a href="https:\/\/bingd\.app\/i\/\{\{inviteToken\}\}"[^>]*>invite link<\/a>/);
    assert.match(html, /<a href="https:\/\/bingd\.app\/u\/saisurajkan"[^>]*>follow me on bingd<\/a>/);
  });

  it('uses the same invite URL shape the app shares', async () => {
    const source = await read('src/features/recommendations/use-recommend.ts');
    assert.match(source, /`https:\/\/bingd\.app\/i\/\$\{token\}`/, 'use-recommend.ts no longer builds bingd.app/i/<token>');
    assert.equal(inviteUrlFor('0123456789abcdef0123456789abcdef'), 'https://bingd.app/i/0123456789abcdef0123456789abcdef');
    assert.throws(() => inviteUrlFor(null));
    assert.throws(() => inviteUrlFor('not-a-token'));
  });

  it('points every link at a path web/deep-links.config.json claims, so it opens the app', async () => {
    const { appPaths } = JSON.parse(await read('web/deep-links.config.json'));
    const claimed = appPaths.map((p) => new RegExp(`^${escapeRe(p).replace('\\*', '[^/]+')}$`));
    for (const href of hrefs().filter((h) => h.startsWith('https://'))) {
      const url = new URL(href.replace('{{inviteToken}}', '0'.repeat(32)));
      assert.equal(url.host, 'bingd.app', href);
      assert.ok(claimed.some((re) => re.test(url.pathname)), `${url.pathname} is not an app path`);
    }
  });

  it('gives the plain-text reader every link the HTML reader gets', () => {
    for (const href of hrefs()) assert.ok(text.includes(href), `text part is missing ${href}`);
  });

  it('never claims a D destination', () => {
    for (const t of Object.values(targets.targets)) assert.notEqual(t.classification, 'D');
  });
});

describe('welcome email: product labels', () => {
  it('names only labels the app renders, and names them exactly', async () => {
    const letter = JSON.stringify(copy.letter.paragraphs);
    for (const { label, file } of targets.labels) {
      const source = await read(file);
      assert.match(source, new RegExp(`['"\`]${escapeRe(label)}['"\`]|>\\s*${escapeRe(label)}\\s*<`), `${file} no longer renders "${label}"`);
      assert.ok(letter.includes(label), `the letter does not say "${label}"`);
    }
    assert.doesNotMatch(letter, /Group Watch|For You\b/, 'a label the app does not use');
  });
});

describe('welcome email: brand and compliance', () => {
  it('writes the name as the brand does, in everything a reader sees', () => {
    const all = JSON.stringify([copy.subject, copy.preheader, copy.letter, copy.footer]);
    assert.doesNotMatch(all, /\bBingd\b|\bBINGD\b|bingd\.\./);
    assert.doesNotMatch(all, /taste match/i);
  });

  it('keeps the rules for the lines that are not the founder’s letter', () => {
    for (const s of [copy.subject.chosen, ...copy.subject.alternatives, copy.preheader.chosen, ...Object.values(copy.footer)]) {
      if (typeof s !== 'string') continue;
      assert.doesNotMatch(s, /!|—/, `exclamation mark or em dash: ${s}`);
    }
  });

  it('names the sender, carries a postal address line and an unsubscribe in both parts', () => {
    assert.ok(html.includes(copy.footer.signature) && text.includes(copy.footer.signature));
    const postal = copy.footer.postalAddress ?? '[POSTAL ADDRESS - FOUNDER TO SUPPLY]';
    assert.ok(html.includes(postal) && text.includes(postal));
    assert.match(text, /Unsubscribe: \{\{unsubscribeUrl\}\}/);
  });

  it('invites a reply', () => {
    assert.match(copy.preheader.chosen, /reply/i);
    assert.match(text, /hit reply to this email/);
  });
});

describe('welcome email: the envelope', () => {
  it('replies to suraj@bingd.app from a person, never from a no-reply address', () => {
    assert.equal(DEFAULT_REPLY_TO, 'suraj@bingd.app');
    assert.equal(DEFAULT_FROM, 'Suraj from bingd <suraj@bingd.app>');
    assert.throws(() =>
      resendPayload({ from: DEFAULT_FROM, replyTo: 'no-reply@auth.bingd.app', to: 'a@b.co', subject: 's', html: 'h', text: 't', unsubscribeUrl: 'mailto:x@y.co' }),
    );
  });

  it('builds List-Unsubscribe from the mailto, without the one-click header a mailto cannot honour', () => {
    const unsubscribeUrl = unsubscribeFor(DEFAULT_REPLY_TO);
    const payload = resendPayload({ from: DEFAULT_FROM, replyTo: DEFAULT_REPLY_TO, to: 'a@b.co', subject: 's', html: 'h', text: 't', unsubscribeUrl });
    assert.equal(unsubscribeUrl, 'mailto:suraj@bingd.app?subject=Unsubscribe');
    assert.deepEqual(payload.headers, { 'List-Unsubscribe': '<mailto:suraj@bingd.app?subject=Unsubscribe>' });
  });

  it('refuses a list of recipients', () => {
    for (const to of ['a@b.co, c@d.co', 'a@b.co;c@d.co', '']) {
      assert.throws(() => resendPayload({ from: DEFAULT_FROM, replyTo: DEFAULT_REPLY_TO, to, subject: 's', html: 'h', text: 't', unsubscribeUrl: 'mailto:x@y.co' }), to);
    }
  });

  it('fills every token and refuses to return a message with one left', () => {
    const values = { greeting: 'Hey,', inviteToken: '0'.repeat(32), unsubscribeUrl: 'mailto:x@y.co' };
    assert.doesNotMatch(personalise(html, values), /\{\{/);
    assert.doesNotMatch(personalise(text, values), /\{\{/);
    assert.throws(() => personalise('{{greeting}} {{surprise}}', { greeting: 'Hey,' }), /surprise/);
  });

  it('greets by first name only when it looks like one, and never by handle', () => {
    const template = copy.letter.greeting;
    assert.equal(greetingFor('Ada Lovelace', template), 'Hey Ada,');
    assert.equal(greetingFor('Zoë', template), 'Hey Zoë,');
    assert.equal(greetingFor('saisurajkan_99', template), 'Hey,');
    assert.equal(greetingFor('🎬 fan', template), 'Hey,');
    assert.equal(greetingFor('', template), 'Hey,');
    assert.equal(greetingFor(null, template), 'Hey,');
  });
});

describe('welcome email: the test send cannot reach anybody it was not given', () => {
  it('never reads a database or a user list', async () => {
    const source = await readFile(join(here, 'send-test.mjs'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /process\.env\.SUPABASE|@supabase\/|createClient|\/rest\/v1|\bpg\b|postgres:|welcome_email_(claim|preview)/);
  });

  it('never chooses a recipient in the worker either: it only sends to what the claim returns', async () => {
    const source = await readFile(join(here, 'automation', 'send-welcome.mjs'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\/rest\/v1\/(?!rpc\/)/, 'the worker reads a table directly');
    assert.deepEqual(
      [...new Set([...code.matchAll(/rpc\(\s*'([a-z_]+)'/g)].map((m) => m[1]))].sort(),
      ['welcome_email_claim', 'welcome_email_preview', 'welcome_email_record'],
    );
  });

  it('refuses a second recipient, a list, a bcc, and a real send without an invite link', async () => {
    const script = join(here, 'send-test.mjs');
    for (const args of [
      ['--to', 'a@b.co,c@d.co'],
      ['--to', 'a@b.co', '--to', 'c@d.co'],
      ['--to', 'a@b.co', '--bcc', 'c@d.co'],
      ['--to', 'a@b.co', '--send'],
      ['--to', 'a@b.co', '--invite-url', 'https://bingd.app/i/nope'],
      [],
    ]) {
      await assert.rejects(execFileAsync(process.execPath, [script, ...args], { env: { ...process.env, RESEND_API_KEY: '' } }), args.join(' '));
    }
  });
});
