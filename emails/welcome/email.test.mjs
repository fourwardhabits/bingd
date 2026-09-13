import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
 * holds the message itself to what the product actually does:
 *
 *   1. **The committed email is the one the copy renders.** A copy edit without a rebuild
 *      fails here, as well as at send time.
 *   2. **Every link lands.** Each href is a verified target on a path the app claims, or
 *      the unsubscribe; the text part carries the same links.
 *   3. **Every instruction names a control that exists.** "Tap Profile, then Invite
 *      friends" is checked against the source files that render those labels.
 *   4. **The brand rules and the compliance lines are there.**
 *   5. **The test send cannot reach a user list.** It never reads a database.
 */

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

const read = (path) => readFile(join(repo, path), 'utf8');
const lf = (text) => text.replace(/\r\n/g, '\n');

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

  // Render the committed copy somewhere else, with the committed build script.
  fresh = await mkdtemp(join(tmpdir(), 'welcome-render-'));
  for (const file of ['build.mjs', 'copy.json', 'targets.json']) {
    await writeFile(join(fresh, file), await readFile(join(here, file), 'utf8'));
  }
  await execFileAsync(process.execPath, [join(fresh, 'build.mjs')]);
});

after(async () => {
  if (fresh) await rm(fresh, { recursive: true, force: true });
});

describe('welcome email: the committed render', () => {
  for (const file of ['welcome.html', 'welcome.txt', 'welcome-dark.html', 'manifest.json']) {
    it(`dist/${file} is exactly what copy.json renders to today`, async () => {
      const committed = lf(await readFile(join(here, 'dist', file), 'utf8'));
      const rendered = lf(await readFile(join(fresh, 'dist', file), 'utf8'));
      assert.equal(committed, rendered, `run node emails/welcome/build.mjs and commit dist/${file}`);
    });
  }

  it('carries no images, fits under Gmail’s clipping limit, and keeps its dark and mobile rules', () => {
    assert.doesNotMatch(html, /<img\b/i);
    assert.ok(html.length < 102_000, `${html.length} bytes`);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
    assert.match(html, /<meta name="color-scheme" content="light dark" \/>/);
    assert.match(html, /@media \(prefers-color-scheme: dark\)/);
    assert.match(html, /@media only screen and \(max-width: 620px\)/);
  });
});

describe('welcome email: every link lands', () => {
  const hrefs = () => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

  it('uses only verified targets and the unsubscribe token', () => {
    const allowed = new Set([...Object.values(targets.targets).map((t) => t.url), '{{unsubscribeUrl}}']);
    for (const href of hrefs()) assert.ok(allowed.has(href), `unverified link ${href}`);
    assert.ok(hrefs().includes('{{unsubscribeUrl}}'), 'the footer has no unsubscribe link');
  });

  it('points every link at a path web/deep-links.config.json claims, so it opens the app', async () => {
    const { appPaths } = JSON.parse(await read('web/deep-links.config.json'));
    const claimed = appPaths.map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('*', '[^/]+')}$`));
    for (const href of hrefs().filter((h) => h.startsWith('https://'))) {
      const url = new URL(href);
      assert.equal(url.host, 'bingd.app', href);
      assert.ok(claimed.some((re) => re.test(url.pathname)), `${url.pathname} is not an app path`);
    }
  });

  it('gives the plain-text reader every link the HTML reader gets', () => {
    for (const href of hrefs()) assert.ok(text.includes(href), `text part is missing ${href}`);
  });

  it('never claims a D destination', () => {
    for (const name of [copy.postscript?.target, ...copy.cards.items.map((i) => i.target)].filter(Boolean)) {
      assert.notEqual(targets.targets[name].classification, 'D', name);
    }
  });
});

describe('welcome email: every instruction names a control that exists', () => {
  it('each card is a link or an instruction, and each instruction is defined', () => {
    for (const item of copy.cards.items) {
      assert.ok(Boolean(item.target) !== Boolean(item.where), item.title);
      if (item.where) assert.ok(targets.instructions[item.where], item.where);
    }
  });

  it('finds every label an instruction sends the reader to, in the file that renders it', async () => {
    for (const [name, instruction] of Object.entries(targets.instructions)) {
      for (const { label, file } of instruction.evidence) {
        const source = await read(file);
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const quoted = new RegExp(`['"\`]${escaped}['"\`]|>\\s*${escaped}\\s*<`);
        assert.match(source, quoted, `${name}: "${label}" is no longer rendered by ${file}`);
      }
    }
  });

  it('says in the card exactly the labels the evidence checks', () => {
    for (const item of copy.cards.items.filter((i) => i.where)) {
      for (const label of targets.instructions[item.where].path) {
        assert.ok(item.body.includes(label), `"${item.title}" does not mention ${label}`);
      }
    }
  });
});

describe('welcome email: brand and compliance', () => {
  const readerStrings = () => [
    copy.subject.chosen,
    ...copy.subject.alternatives,
    copy.preheader.chosen,
    ...copy.preheader.alternatives,
    ...copy.note.paragraphs,
    ...copy.note.signoff,
    copy.postscript?.text,
    copy.postscript?.action,
    copy.cards.intro,
    ...copy.cards.items.flatMap((i) => [i.title, i.body, i.action]),
    copy.closer,
    ...Object.values(copy.footer),
  ].filter((s) => typeof s === 'string');

  it('keeps the brand rules', () => {
    for (const s of readerStrings()) {
      assert.doesNotMatch(s, /!/, `exclamation mark: ${s}`);
      assert.doesNotMatch(s, /—/, `em dash: ${s}`);
      assert.doesNotMatch(s, /\bBingd\b|\bBINGD\b|bingd\.\./, `the name is bingd.: ${s}`);
      assert.doesNotMatch(s, /\brat(e|ed|ing|ings)\b/i, `Rank, never rate: ${s}`);
      assert.doesNotMatch(s, /taste match/i, `the label is Match: ${s}`);
    }
  });

  it('names the sender, carries a postal address line and an unsubscribe in both parts', () => {
    assert.match(html, /bingd\. is made by Suraj Kandukuri\./);
    assert.match(text, /bingd\. is made by Suraj Kandukuri\./);
    const postal = copy.footer.postalAddress ?? '[POSTAL ADDRESS - FOUNDER TO SUPPLY]';
    assert.ok(html.includes(postal) && text.includes(postal));
    assert.match(text, /Unsubscribe: \{\{unsubscribeUrl\}\}/);
  });

  it('asks for a reply in the preheader, the note and the closer', () => {
    assert.match(copy.preheader.chosen, /reply/i);
    assert.match(copy.note.paragraphs.at(-1), /reply/i);
    assert.match(copy.closer, /repl/i);
  });
});

describe('welcome email: the envelope', () => {
  it('replies to suraj@bingd.app from a person, never from a no-reply address', () => {
    assert.equal(DEFAULT_REPLY_TO, 'suraj@bingd.app');
    assert.equal(DEFAULT_FROM, 'Suraj from bingd. <suraj@bingd.app>');
    assert.throws(() =>
      resendPayload({ from: DEFAULT_FROM, replyTo: 'no-reply@auth.bingd.app', to: 'a@b.co', subject: 's', html: 'h', text: 't', unsubscribeUrl: 'mailto:x@y.co' }),
    );
  });

  it('builds List-Unsubscribe from the mailto, without the one-click header a mailto cannot honour', () => {
    const unsubscribeUrl = unsubscribeFor(DEFAULT_REPLY_TO);
    const payload = resendPayload({ from: DEFAULT_FROM, replyTo: DEFAULT_REPLY_TO, to: 'a@b.co', subject: 's', html: 'h', text: 't', unsubscribeUrl });
    assert.equal(unsubscribeUrl, 'mailto:suraj@bingd.app?subject=Unsubscribe');
    assert.deepEqual(payload.headers, { 'List-Unsubscribe': '<mailto:suraj@bingd.app?subject=Unsubscribe>' });
    assert.deepEqual(payload.to, ['a@b.co']);
  });

  it('refuses a list of recipients', () => {
    for (const to of ['a@b.co, c@d.co', 'a@b.co;c@d.co', '']) {
      assert.throws(() => resendPayload({ from: DEFAULT_FROM, replyTo: DEFAULT_REPLY_TO, to, subject: 's', html: 'h', text: 't', unsubscribeUrl: 'mailto:x@y.co' }), to);
    }
  });

  it('fills every token and refuses to return a message with one left', () => {
    const values = { greeting: 'Hi,', handle: 'x', unsubscribeUrl: 'mailto:x@y.co' };
    assert.doesNotMatch(personalise(html, values), /\{\{/);
    assert.doesNotMatch(personalise(text, values), /\{\{/);
    assert.throws(() => personalise('{{greeting}} {{surprise}}', { greeting: 'Hi,' }), /surprise/);
  });

  it('greets by first name only when it looks like one, and never by handle', () => {
    assert.equal(greetingFor('Ada Lovelace'), 'Hi Ada,');
    assert.equal(greetingFor('Zoë'), 'Hi Zoë,');
    assert.equal(greetingFor('saisurajkan_99'), 'Hi,');
    assert.equal(greetingFor('🎬 fan'), 'Hi,');
    assert.equal(greetingFor(''), 'Hi,');
    assert.equal(greetingFor(null), 'Hi,');
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

  it('refuses a second recipient, a list and a bcc at the command line', async () => {
    const script = join(here, 'send-test.mjs');
    for (const args of [['--to', 'a@b.co,c@d.co'], ['--to', 'a@b.co', '--to', 'c@d.co'], ['--to', 'a@b.co', '--bcc', 'c@d.co'], []]) {
      await assert.rejects(execFileAsync(process.execPath, [script, ...args], { env: { ...process.env, RESEND_API_KEY: '' } }), args.join(' '));
    }
  });
});
