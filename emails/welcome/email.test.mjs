import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  escapeHtml,
  personalise,
  postalAddressFrom,
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
 *   4. **Every product label is one the app renders.** targets.json lists them; the
 *      2026-09-18 letter names none.
 *   5. **It is a letter.** No images, no buttons, and no bold: the approved copy asks for none.
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
// The founder's letter, revised 2026-09-18 after he read the real staging send in Gmail.
const LOCKED_LETTER = 'acef1efc973b3e79364c8a4717ea2318047be6f42628761594926b529152e8e5';

const read = (path) => readFile(join(repo, path), 'utf8');

/**
 * Every TypeScript source file under a directory, recursively.
 *
 * Used to ask what the *client bundle* contains, so the answer has to come from walking
 * the tree rather than from a list somebody maintains: a file added next week is the one
 * that matters.
 */
const sourceFiles = async (dir) => {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
};
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

  it('bolds nothing, because the approved letter asks for no emphasis', () => {
    // The 2026-09-13 letter had three bold feature labels; the 2026-09-18 one has none. A
    // bold or semibold run appearing now is emphasis nobody approved.
    const bold = [...html.matchAll(/<strong[^>]*>([^<]+)<\/strong>/g)].map((m) => m[1]);
    assert.deepEqual(bold, []);
    assert.equal((html.match(/<b>|font-weight:\s*(bold|[5-9]00)/g) ?? []).length, 0, 'no bold or semibold text, links included');
  });

  it('is a letter: no images, no buttons, no cards', () => {
    assert.doesNotMatch(html, /<img\b/i);
    assert.doesNotMatch(html, /btn-wrap|class="btn"|dk-raised|dk-fill|dk-outline/);
  });

  it('keeps the plain-text part as the approved letter reads', () => {
    assert.match(text, /^\{\{greeting\}\}\n\nThanks for giving bingd a shot!/);
    // Whitespace-tolerant, because the text part is word-wrapped at 72 columns.
    assert.match(text, /\nThe app was inspired by my experience using Beli,\s+which changed the way\s+I enjoyed\s+restaurants\./);
    assert.match(text, /See where your latest movie lands in your rankings,/);
    assert.match(text, /\nI built bingd because I think movies and TV are missing that same loop,/);
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

  /**
   * 680px ON DESKTOP, FLUID BELOW IT, AND OUTLOOK HELD TO 680 BY ITS OWN TABLE.
   *
   * The founder read the real send in Gmail and found 600 narrow. The shell is therefore
   * `width:100%; max-width:680px`, never a fixed pixel width (which is what would overflow
   * a phone) and never a viewport percentage (which Gmail and Outlook do not honour the
   * same way). Outlook on Windows ignores max-width entirely, so it alone is given a fixed
   * 680 table inside conditional comments every other client skips.
   */
  it('is 680px wide on desktop, fluid below it, with an Outlook ghost table', () => {
    const shell = html.match(/<table[^>]*class="shell[^"]*"[^>]*>/)?.[0];
    assert.ok(shell, 'the shell table is where this test expects it');
    assert.match(shell, /width="100%"/);
    assert.match(shell, /max-width:680px/);
    assert.doesNotMatch(shell, /(?<!max-)width:\s*\d+px;|width="\d+"(?!%)/, 'a fixed pixel width would overflow a phone');
    assert.doesNotMatch(html, /\d+vw/, 'a viewport-relative width');

    // The ghost table opens immediately before the shell and closes immediately after it.
    const open = html.indexOf('<!--[if mso]><table role="presentation" width="680"');
    const close = html.indexOf('<!--[if mso]></td></tr></table><![endif]-->');
    const at = html.indexOf(shell);
    assert.ok(open > -1 && close > -1, 'the Outlook ghost table is missing');
    assert.ok(open < at && at < close, 'the ghost table does not wrap the shell');
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
  /**
   * THE APPROVED SUBJECT, PINNED TO THE CHARACTER.
   *
   * Founder-written and approved on 2026-09-18, replacing "I built bingd. Tell me what you
   * think." It has a comma after the name and no closing punctuation, both deliberate: a
   * well-meant "fix" to either is a subject nobody approved.
   *
   * `supabase/tests/welcome-email.test.mjs` asserts the same string on the *sent payload*.
   * It is asserted here as well, and that is deliberate rather than duplicated: this file is
   * the workflow's first step, so a subject edited without approval stops the job before it
   * claims anybody, rather than after.
   */
  it('carries the approved subject, to the character', () => {
    assert.equal(copy.subject.chosen, 'Welcome to bingd, let me know what you think');
    assert.deepEqual(copy.subject.alternatives, [], 'the retired candidate subjects came back');
  });

  /**
   * The brand rule as the design system states it (`docs/design/design-system.md`, "How the
   * product name is written"): the plain-text name is `bingd`, the wordmark is `bingd.`, and
   * **sentence punctuation is ordinary punctuation**.
   *
   * The distinguishing test is what follows the period. A capital letter or the end of the
   * string means the sentence ended; a lower-case word means the period was being treated as
   * part of the name. So "I built bingd. Tell me" is right and "bingd. is a movie app" is
   * not, and one regex separates them without banning the form outright.
   */
  it('lets a sentence end after the name, and never treats the period as part of it', () => {
    const readerText = [
      copy.subject.chosen,
      ...copy.subject.alternatives,
      copy.preheader.chosen,
      JSON.stringify(copy.letter),
      copy.footer.signature,
      copy.footer.reason,
    ].join('\n');

    // `bingd.` followed by a lower-case letter: the period did not end anything.
    assert.doesNotMatch(
      readerText,
      /\bbingd\.\s+\p{Ll}/u,
      'a period after the name is being treated as part of the name',
    );

    // And the rule itself is checked in both directions against fixed examples, so the
    // assertion above cannot pass by way of a pattern that matches nothing. It used to
    // lean on the old subject for the permitted half; the 2026-09-18 copy retired it.
    const branded = /\bbingd\.\s+\p{Ll}/u;
    for (const ok of ['I built bingd. Tell me what you think.', 'Welcome to bingd.', 'Try bingd today.']) {
      assert.doesNotMatch(ok, branded, `the rule rejects ordinary punctuation: ${ok}`);
    }
    for (const bad of ['bingd. is a movie and TV app.', 'I use bingd. with my friends.']) {
      assert.match(bad, branded, `the rule misses a branded period: ${bad}`);
    }

    // The masthead is the wordmark and keeps its period; it is not a sentence.
    assert.equal(copy.masthead, 'bingd.');
  });

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
    // The address itself is a runtime secret, so what ships is the token. That it is
    // *filled*, and filled safely, is the suite below.
    assert.ok(html.includes('{{postalAddress}}'), 'the HTML part carries the postal token');
    assert.ok(text.includes('{{postalAddress}}'), 'the text part carries the postal token');
    assert.equal('postalAddress' in copy.footer, false, 'no address may live in copy.json');
    assert.match(text, /Unsubscribe: \{\{unsubscribeUrl\}\}/);
  });

  it('invites a reply', () => {
    assert.match(copy.preheader.chosen, /reply/i);
    assert.match(text, /reply to this email\.\s+It comes straight to me\./);
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
    // Every token the sendable files carry, including the postal address, which is filled
    // from WELCOME_POSTAL_ADDRESS at send time. Adding a token to dist/ without teaching
    // both senders to fill it should fail here, and this line is what makes it.
    const values = { greeting: 'Hey,', inviteToken: '0'.repeat(32), unsubscribeUrl: 'mailto:x@y.co', postalAddress: '1 Example Street, Sampleton EX1 2MP' };
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

/**
 * THE POSTAL ADDRESS, WHICH ARRIVES FROM OUTSIDE THE REPOSITORY.
 *
 * It is the operator's home address, so it is a GitHub Actions secret
 * (`WELCOME_POSTAL_ADDRESS`) read at send time rather than a line in `copy.json`. That
 * buys privacy and costs the one guarantee a committed value had for free: that there is
 * something to print. These tests are that guarantee put back.
 *
 * The refusal is deliberately *before* anything is claimed — proven over the real SQL in
 * `supabase/tests/welcome-email.test.mjs` — so a missing secret costs nobody their one
 * chance at the note. Here the question is narrower and purely about the value: which
 * values are refused, which is accepted, and what happens to a hostile one.
 */
describe('welcome email: the postal address is a runtime secret', () => {
  it('refuses to produce an address when the secret is missing', () => {
    // Not set at all: the shape a fresh repository, or a forgotten secret, actually has.
    assert.throws(() => postalAddressFrom({}), /WELCOME_POSTAL_ADDRESS is not set/);
    assert.throws(() => postalAddressFrom({ WELCOME_POSTAL_ADDRESS: undefined }), /is not set/);
    assert.throws(() => postalAddressFrom({ WELCOME_POSTAL_ADDRESS: null }), /is not set/);
  });

  it('refuses a blank or whitespace-only secret, which is what a mis-paste leaves', () => {
    assert.throws(() => postalAddressFrom({ WELCOME_POSTAL_ADDRESS: '' }), /is blank/);
    assert.throws(() => postalAddressFrom({ WELCOME_POSTAL_ADDRESS: '   ' }), /is blank/);
    // A secret set from an empty file is a newline, not an empty string.
    assert.throws(() => postalAddressFrom({ WELCOME_POSTAL_ADDRESS: '\n' }), /is blank/);
    // And a value that is only shaped like an answer.
    assert.throws(() => postalAddressFrom({ WELCOME_POSTAL_ADDRESS: 'TODO' }), /too short|placeholder/);
    assert.throws(
      () => postalAddressFrom({ WELCOME_POSTAL_ADDRESS: '[POSTAL ADDRESS - FOUNDER TO SUPPLY]' }),
      /placeholder/,
    );
  });

  it('never names the value in the message it throws, only the variable', () => {
    // A refusal is logged by the worker and by CI. It must be able to say what is wrong
    // without putting somebody's home address in a build log.
    const secret = '221B Baker Street, London NW1 6XE';
    try {
      postalAddressFrom({ WELCOME_POSTAL_ADDRESS: `${secret} TODO` });
      assert.fail('expected a refusal');
    } catch (error) {
      assert.equal(error.message.includes('Baker Street'), false, 'the message leaks the value');
      assert.match(error.message, /WELCOME_POSTAL_ADDRESS/);
    }
  });

  it('accepts a real address and renders it into both parts of the message', () => {
    const supplied = '221B Baker Street, London NW1 6XE';
    const postalAddress = postalAddressFrom({ WELCOME_POSTAL_ADDRESS: supplied });
    assert.equal(postalAddress, supplied);

    const values = {
      greeting: 'Hey Suraj,',
      inviteToken: '0'.repeat(32),
      unsubscribeUrl: unsubscribeFor(DEFAULT_REPLY_TO),
    };
    const filledHtml = personalise(html, { ...values, postalAddress: escapeHtml(postalAddress) });
    const filledText = personalise(text, { ...values, postalAddress });

    assert.ok(filledHtml.includes(supplied), 'the HTML footer shows the supplied address');
    assert.ok(filledText.includes(supplied), 'the text footer shows the supplied address');
    // `personalise` already refuses a leftover token, so reaching here is the proof that
    // nothing was left unfilled; assert it anyway, because this is the token that matters.
    assert.equal(filledHtml.includes('{{postalAddress}}'), false);
    assert.equal(filledText.includes('{{postalAddress}}'), false);
  });

  it('escapes the supplied value in the HTML part and leaves the text part alone', () => {
    // An ampersand in a building name is ordinary, not an attack, and unescaped it is
    // already invalid HTML. The angle brackets are the hostile case: this value arrives
    // from outside the repository, so it is the one part of the letter that could inject.
    const nasty = 'Suite <script>alert(1)</script> & Co, 5 Test Road, Testville TS1 2AB';
    const postalAddress = postalAddressFrom({ WELCOME_POSTAL_ADDRESS: nasty });
    const values = {
      greeting: 'Hey Suraj,',
      inviteToken: '0'.repeat(32),
      unsubscribeUrl: unsubscribeFor(DEFAULT_REPLY_TO),
    };

    const filledHtml = personalise(html, { ...values, postalAddress: escapeHtml(postalAddress) });
    assert.equal(filledHtml.includes('<script>'), false, 'a tag reached the HTML part');
    assert.match(filledHtml, /&lt;script&gt;/, 'the tag is shown as text');
    assert.match(filledHtml, /Test Road/, 'the address itself still reads');
    assert.match(filledHtml, /&amp; Co/, 'the ampersand is escaped rather than dropped');

    // The plain-text part must NOT be escaped, or the reader sees &amp; in their inbox.
    const filledText = personalise(text, { ...values, postalAddress });
    assert.match(filledText, /& Co/, 'the text part keeps a literal ampersand');
    assert.equal(filledText.includes('&amp;'), false, 'the text part was HTML-escaped by mistake');
  });
});

/**
 * WHERE THE TWO SECRETS MAY APPEAR, AND WHERE THEY MAY NOT.
 *
 * Two secrets reach this email: the restricted Resend key and the postal address. Both are
 * wired correctly today, and "correctly today" is the state that decays — a debug line
 * added during an incident, a second workflow copied from this one, a helper that reads
 * `process.env` in the app. None of those would fail any other test in this repository.
 *
 * These assertions are therefore about the *shape of the wiring* rather than behaviour:
 * which credential is named, how it enters the job, and where it may not appear at all.
 */
describe('welcome email: the secrets are wired where they cannot leak', () => {
  let workflow;
  let workflowLines;

  before(async () => {
    workflow = await read('.github/workflows/welcome-email.yml');
    workflowLines = workflow.split(/\r?\n/);
  });

  it('takes its Resend key from RESEND_API_KEY_WELCOME and names no other credential', () => {
    // The account that sends this note also relays every sign-in code, under the key named
    // Supabase. Reusing that key here would mean one revocation, or one Resend-side
    // suppression, locking people out of the app. The worker reads a generically named
    // RESEND_API_KEY; what this pins is where the workflow fills it from.
    assert.match(workflow, /RESEND_API_KEY:\s*\$\{\{\s*secrets\.RESEND_API_KEY_WELCOME\s*\}\}/);

    const named = [...new Set([...workflow.matchAll(/secrets\.(RESEND[A-Z0-9_]*)/g)].map((m) => m[1]))];
    assert.deepEqual(named, ['RESEND_API_KEY_WELCOME'], 'another Resend credential is named here');
  });

  it('takes the postal address from the secret of that name', () => {
    assert.match(workflow, /WELCOME_POSTAL_ADDRESS:\s*\$\{\{\s*secrets\.WELCOME_POSTAL_ADDRESS\s*\}\}/);
  });

  it('lets every secret in through env: and never through the shell', () => {
    // The leak that actually happens: `${{ secrets.X }}` written inside a `run:` body rather
    // than under `env:`. GitHub substitutes it before the shell sees it, so the literal
    // becomes part of the command text — which xtrace, or a shell error quoting the line,
    // will print. Under `env:` the value is never part of the script.
    //
    // Asserted as: every line that mentions a secret is a `NAME: ${{ ... }}` mapping.
    const secretLines = workflowLines.filter((l) => l.includes('secrets.'));
    assert.ok(secretLines.length >= 3, 'expected the job to take several secrets');
    for (const line of secretLines) {
      assert.match(
        line,
        /^\s{2,}[A-Z][A-Z0-9_]*:\s*\$\{\{/,
        `a secret appears somewhere other than an env: mapping: ${line.trim().slice(0, 60)}`,
      );
    }

    // And nothing turns tracing on or dumps the environment.
    assert.doesNotMatch(workflow, /set\s+-[a-z]*x[a-z]*\b/, 'xtrace prints every expanded line');
    assert.doesNotMatch(workflow, /\benv\s*\|/, 'the environment is piped somewhere');
  });

  /**
   * HOURLY, AND A SCHEDULED RUN IS ALWAYS `send` ON `production`.
   *
   * Enabled 2026-09-18 after the founder confirmed Apple private email relay. The trap this
   * guards: a scheduled run has no `github.event.inputs`, and the original expressions fell
   * through to NONPROD and to an empty MODE (which the worker treats as a send) — a staging
   * worker every hour and a production that never sends, with every run green.
   *
   * GitHub's `&&`, `||` and `==` behave like JavaScript's for these string operands, so the
   * workflow's own expressions are evaluated here for each kind of trigger rather than
   * compared as text.
   */
  it('runs hourly at :23, and a scheduled run is a send on production', () => {
    const active = workflowLines.filter((l) => /^\s*schedule:/.test(l));
    assert.equal(active.length, 1, 'exactly one active schedule');
    const crons = [...workflow.matchAll(/^\s*-\s*cron:\s*'([^']+)'/gm)].map((m) => m[1]);
    assert.deepEqual(crons, ['23 * * * *'], 'the cadence changed');
    assert.match(workflow, /workflow_dispatch:/, 'the manual path for staging QA is gone');

    const expr = (name) => {
      const m = workflow.match(new RegExp(`^\\s*${name}:\\s*\\$\\{\\{(.+)\\}\\}\\s*$`, 'm'));
      assert.ok(m, `${name} is not a single \${{ }} expression`);
      return m[1];
    };
    const evaluate = (source, event, inputs) =>
      new Function(
        'ev', 'inp',
        `return ${source.replace(/github\.event_name/g, 'ev').replace(/github\.event\.inputs\.(\w+)/g, 'inp.$1')
          .replace(/secrets\.(\w+)/g, "'$1'")}`,
      )(event, inputs);

    const url = expr('SUPABASE_URL');
    const key = expr('SUPABASE_SERVICE_ROLE_KEY');
    const mode = expr('MODE');
    const cases = [
      ['schedule', {}, 'SUPABASE_URL_PRODUCTION', 'SUPABASE_SERVICE_ROLE_KEY_PRODUCTION', 'send'],
      ['workflow_dispatch', { target: 'nonprod', mode: 'dry-run' }, 'SUPABASE_URL_NONPROD', 'SUPABASE_SERVICE_ROLE_KEY_NONPROD', 'dry-run'],
      ['workflow_dispatch', { target: 'nonprod', mode: 'send' }, 'SUPABASE_URL_NONPROD', 'SUPABASE_SERVICE_ROLE_KEY_NONPROD', 'send'],
      ['workflow_dispatch', { target: 'production', mode: 'dry-run' }, 'SUPABASE_URL_PRODUCTION', 'SUPABASE_SERVICE_ROLE_KEY_PRODUCTION', 'dry-run'],
    ];
    for (const [event, inputs, wantUrl, wantKey, wantMode] of cases) {
      const label = `${event} ${JSON.stringify(inputs)}`;
      assert.equal(evaluate(url, event, inputs), wantUrl, `${label}: wrong project URL`);
      assert.equal(evaluate(key, event, inputs), wantKey, `${label}: wrong service key`);
      assert.equal(evaluate(mode, event, inputs), wantMode, `${label}: wrong mode`);
    }

    // The URL and the key must never disagree about which project a run is for.
    assert.equal(url.replace(/SUPABASE_URL_/g, 'X_'), key.replace(/SUPABASE_SERVICE_ROLE_KEY_/g, 'X_'), 'URL and key choose differently');
  });

  it('keeps both secrets out of anything that ships to a phone', async () => {
    // `emails/` is authoring-time and CI-only. `app/` and `src/` go into a client bundle,
    // where an environment variable is neither secret nor available.
    const shipped = (await Promise.all(['app', 'src'].map((d) => sourceFiles(join(repo, d))))).flat();
    assert.ok(shipped.length > 100, 'the client source walk found almost nothing; the test is lying');
    for (const file of shipped) {
      const body = await readFile(file, 'utf8');
      for (const name of ['WELCOME_POSTAL_ADDRESS', 'RESEND_API_KEY']) {
        assert.equal(body.includes(name), false, `${file} references ${name}`);
      }
    }
  });

  it('never passes the address or the key to a log call', async () => {
    // The other way a secret escapes. Both of these scripts log a great deal, and the
    // refusal messages deliberately name the *variable* rather than the value.
    for (const file of ['automation/send-welcome.mjs', 'send-test.mjs']) {
      const source = await readFile(join(here, file), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const calls = [...code.matchAll(/(?:\blog|console\.[a-z]+|\bdie)\(([^\n]*)/g)].map((m) => m[1]);
      for (const call of calls) {
        // `postalAddressFrom` and `POSTAL_ADDRESS_ENV` are the names, not the value.
        assert.doesNotMatch(
          call,
          /\bpostalAddress\b(?!From)/,
          `${file} logs the postal address: ${call.slice(0, 70)}`,
        );
        assert.doesNotMatch(call, /\bresendKey\b/, `${file} logs the Resend key: ${call.slice(0, 70)}`);
      }
    }
  });
});
