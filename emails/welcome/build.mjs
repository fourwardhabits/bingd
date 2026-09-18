#!/usr/bin/env node
/**
 * Renders the welcome email from `copy.json` and `targets.json`.
 *
 * Run: `node emails/welcome/build.mjs`
 *
 * Writes three files into `dist/`:
 *
 *   welcome.html   the email, ready to send
 *   welcome.txt    the plain-text alternative, generated from the same copy
 *   preview.html   what to open in a browser: the email at three widths, plus every
 *                  destination spelled out and everything still waiting on a decision
 *   artifact.html  the same review page with no document scaffolding, for publishing
 *                  somewhere the founder can open it from a phone
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SCRIPT AND NOT REACT EMAIL
 * ---------------------------------------------------------------------------
 *
 * React Email is the right answer for a project with a dozen templates, a design system
 * to share between them and people who will never open the HTML. This project has one
 * email, no email framework, no React DOM build, and a client that is React Native.
 * Adding `@react-email/components`, a renderer and a build step for a single message
 * would be more moving parts than the message.
 *
 * `web/build.mjs` already establishes the shape: one dependency-free Node script that
 * writes static files, with the reasoning in comments beside the decisions. This is that
 * again. If a second and third email ever exist, that is the moment React Email starts
 * paying for itself, and the copy would survive the port because it is in JSON already.
 *
 * ---------------------------------------------------------------------------
 * THE RULES THE MARKUP IS WRITTEN UNDER
 * ---------------------------------------------------------------------------
 *
 *   - **Tables, not divs.** Outlook on Windows renders with Word, which has no flexbox,
 *     no grid and unreliable margins. Every layout element here is a table with
 *     `role="presentation"` so screen readers skip the scaffolding.
 *   - **Inline styles carry everything that matters.** The `<style>` block holds only
 *     the media query and the dark-mode overrides, both of which are enhancements. Any
 *     client that drops the block still gets a correct light email.
 *   - **No images at all.** Not the wordmark, not an icon, not a tracking pixel. Roughly
 *     half of recipients have images off by default, so an image-based header is a
 *     header half of them never see. The wordmark is text in a serif stack, which is
 *     what it is in the product anyway.
 *   - **Every background is stated.** A transparent cell inherits whatever a dark-mode
 *     client paints behind it, which is how dark text ends up on a dark ground.
 *   - **Tap targets are at least 44px.**
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');

const copyRaw = await readFile(join(here, 'copy.json'), 'utf8');
const targetsRaw = await readFile(join(here, 'targets.json'), 'utf8');
const copy = JSON.parse(copyRaw);
const targets = JSON.parse(targetsRaw);

const problems = [];
const warnings = [];

/**
 * A destination, by name, refusing anything that is not real.
 *
 * The whole point of `targets.json` is that this function can say no. A card naming a
 * target that does not exist, or one classified `D`, stops the build rather than
 * shipping a button that goes nowhere.
 */
const target = (name) => {
  const entry = targets.targets?.[name];
  if (!entry) {
    problems.push(`copy.json names the target "${name}", which targets.json does not define.`);
    return null;
  }
  if (entry.classification === 'D') {
    problems.push(
      `the target "${name}" is classified D, which means there is nothing behind it. ` +
        'Remove the card or change the classification with the evidence that justifies it.',
    );
    return null;
  }
  if (!/^https:\/\/[a-z0-9.-]+\//i.test(entry.url)) {
    problems.push(`the target "${name}" has url "${entry.url}", which is not an absolute https URL.`);
    return null;
  }
  return entry;
};

// ---------------------------------------------------------------------------
// Brand
//
// Copied from src/ui/tokens/color.ts via docs/product/brand.md. The dark variants are
// this file's own and exist nowhere else in the project, because the product is
// light-only: userInterfaceStyle is pinned to light and Midnight is reserved and unused.
// An email does not get that luxury, so these are chosen here and named for what they
// are rather than pretending to be tokens the app has.
// ---------------------------------------------------------------------------

const C = {
  paper: '#FBF8F4',
  parchment: '#F5EBDD',
  maroon: '#773744',
  ink: '#242326',
  secondary: '#5F5A56',
  tertiary: '#6E6862',
  hairline: '#E6DCCC',
  inverse: '#F5EBDD',
};

/**
 * Dark mode, for the clients that ask rather than the ones that invert.
 *
 * Three behaviours, and only one of them is addressable:
 *
 *   - **Apple Mail, iOS Mail** honour `prefers-color-scheme`, so the block below is for
 *     them and they get a deliberate dark palette that keeps the warmth.
 *   - **Gmail** ignores it and force-inverts instead. Nothing here changes that, so the
 *     light palette is chosen to invert acceptably: a warm near-white ground becomes a
 *     warm near-black, and Maroon is dark enough that Gmail lifts it to a readable
 *     rose rather than leaving it muddy.
 *   - **Outlook on Windows** does neither and renders the inline styles, so it stays
 *     light. That is correct and not a bug.
 *
 * `#B98C97` rather than Maroon on a dark ground. Measured, because the first version of
 * this comment guessed and guessed generously in both directions:
 *
 *   `#773744` on `#1C1917`   **2.01:1**  fails at any size
 *   `#B98C97` on `#1C1917`   **6.05:1**  passes AA and AAA for body text
 *   `#B98C97` on `#262120`   **5.50:1**  the raised card, which is where accents sit
 *   `#773744` on `#FBF8F4`   **8.22:1**  the light theme, comfortably AAA
 *
 * The number that matters is the third: accents sit on the raised card rather than on
 * the ground, so 5.50 is the real one and it is the one that was not stated.
 */
const DARK = {
  ground: '#14110F',
  card: '#1C1917',
  raised: '#262120',
  text: '#EFE6DA',
  secondary: '#C3B8AA',
  tertiary: '#A2988C',
  accent: '#B98C97',
  hairline: '#3A332F',
};

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const SERIF = "Georgia, 'Times New Roman', 'DM Serif Display', serif";

/** HTML-escapes a value from the copy file. */
const esc = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Word-wraps a paragraph for the plain-text part. */
const wrap = (text, width = 72) => {
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && `${line} ${word}`.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out.join('\n');
};

// ---------------------------------------------------------------------------
// Founder inputs the build will not invent
// ---------------------------------------------------------------------------

/**
 * The postal address, which is a legal requirement rather than a design element.
 *
 * This email asks the reader to invite somebody and to try a feature. Under CAN-SPAM's
 * primary-purpose test that is enough promotional content to read as commercial however
 * warmly it is written, and a commercial message needs a physical mailing address and a
 * working opt-out. The cheap, uncontested treatment is to give it both and stop arguing
 * about which bucket it belongs in.
 *
 * **Not invented, and the build says so loudly.** There is no company here: the operator
 * is a natural person, so this is a home address or a PO box and it is the founder's
 * decision which. A plausible-looking placeholder in a compliance field is worse than an
 * empty one, because it reads as done.
 *
 * **It is a runtime secret, and this build never sees it** (2026-09-17). It used to live
 * in `copy.json`, which would have put the operator's home address in git history for
 * ever. The sendable files carry `{{postalAddress}}`, filled from the
 * `WELCOME_POSTAL_ADDRESS` environment variable at send time and HTML-escaped there;
 * `personalise` refuses to return a message with the token still in it, so there is no
 * placeholder that can reach a reader. The review pages below fill it with an obviously
 * fake sample, so the footer still *looks* like the footer.
 */

const UNSUBSCRIBE_TOKEN = '{{unsubscribeUrl}}';

// ---------------------------------------------------------------------------
// The HTML
// ---------------------------------------------------------------------------

/**
 * One paragraph of the letter.
 *
 * A string is plain text. An array is pieces: a string, `{ bold }` (emphasis the approved
 * copy asks for; the 2026-09-18 letter asks for none), or `{ link, target }` (an inline link whose
 * destination must be verified in targets.json). No buttons and no cards: this is a
 * letter, and the founder asked for it to look like one.
 */
const piecesOf = (paragraph) => (Array.isArray(paragraph) ? paragraph : [paragraph]);

const paragraphHtml = (paragraph) =>
  piecesOf(paragraph)
    .map((piece) => {
      if (typeof piece === 'string') return esc(piece);
      /**
       * MAROON, BECAUSE THAT IS THE SITE'S LABEL DEVICE.
       *
       * bingd.app marks every section with a small maroon label above it (`.kicker`:
       * maroon, 600, uppercase, letterspaced). It is the page's most repeated brand
       * gesture, and the letter had no maroon in its body at all — only the masthead and
       * the two links — which is why it read as correctly-coloured but anonymous.
       *
       * Translated rather than copied: **sentence case, inline, no letterspacing**. The
       * site's kicker sits on its own line above a heading; uppercasing three labels inside
       * a personal letter would turn it into the feature grid the founder asked this not to
       * be. The colour is the part that carries the brand; the shouting is not.
       *
       * A label cannot be mistaken for a link: links here are underlined and these are not,
       * which is the same distinction the site makes.
       */
      if (piece.bold) return `<strong style="font-weight:700;color:${C.maroon};" class="dk-label">${esc(piece.bold)}</strong>`;
      if (piece.link) {
        const destination = target(piece.target);
        return destination
          ? `<a href="${esc(destination.url)}" style="color:${C.maroon};text-decoration:underline;" class="dk-accent">${esc(piece.link)}</a>`
          : esc(piece.link);
      }
      problems.push(`a paragraph piece is neither text, bold nor a link: ${JSON.stringify(piece)}`);
      return '';
    })
    .join('');

/** The same paragraph for the plain-text part: bold is just text, a link carries its URL. */
const paragraphText = (paragraph) =>
  piecesOf(paragraph)
    .map((piece) => {
      if (typeof piece === 'string') return piece;
      if (piece.bold) return piece.bold;
      const url = targets.targets?.[piece.target]?.url;
      return url ? `${piece.link} (${url})` : piece.link;
    })
    .join('');

const paragraphs = copy.letter.paragraphs
  .map(
    (paragraph) =>
      `<p style="margin:0 0 18px;font-family:${FONT};font-size:16px;line-height:26px;color:${C.ink};" class="dk-text">${paragraphHtml(paragraph)}</p>`,
  )
  .join('\n                      ');

/**
 * The greeting stays a token in dist/, because it depends on the recipient: the worker
 * fills `{{greeting}}` from `copy.letter.greeting` and the display name (envelope.mjs).
 */
const GREETING_TOKEN = '{{greeting}}';

/**
 * Stays a token in dist/ for the same reason `{{greeting}}` does, and one more: it is a
 * secret. Escaped at fill time (`escapeHtml` in envelope.mjs), not here — this build has
 * nothing to escape.
 */
const POSTAL_TOKEN = '{{postalAddress}}';

const html = `<!DOCTYPE html>
<html lang="en" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <!-- Stops iOS shrinking the whole email to fit, which it does to anything it decides
         is too wide and which turns 16px body copy into 11px. -->
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="format-detection" content="telephone=no,address=no,email=no,date=no" />
    <!-- Tells a client this email has a dark treatment of its own, so Apple Mail uses the
         media query below instead of inverting. -->
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <title>${esc(copy.subject.chosen)}</title>
    <!--[if mso]>
      <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
    <![endif]-->
    <style>
      /* Enhancements only. Every client that drops this block still gets a correct
         light email, because everything structural is inline. */

      body { margin: 0 !important; padding: 0 !important; width: 100% !important; }
      table { border-collapse: collapse; }
      img { border: 0; outline: none; text-decoration: none; }
      a { color: ${C.maroon}; }

      /* Under 600px the shell stops being a card and becomes the page: the outer
         padding and the border are what make a narrow phone feel cramped. */
      @media only screen and (max-width: 620px) {
        .shell { width: 100% !important; border-radius: 0 !important; border-left: 0 !important; border-right: 0 !important; }
        .gutter { padding-left: 22px !important; padding-right: 22px !important; }
        .pad-top { padding-top: 28px !important; }
      }

      /* Apple Mail and iOS Mail. Gmail ignores all of this and inverts on its own;
         see DARK in build.mjs for why the light palette is chosen to survive that. */
      @media (prefers-color-scheme: dark) {
        .dk-ground { background-color: ${DARK.ground} !important; }
        .dk-card { background-color: ${DARK.card} !important; border-color: ${DARK.hairline} !important; }
        .dk-text, .dk-text * { color: ${DARK.text} !important; }
        .dk-tertiary, .dk-tertiary * { color: ${DARK.tertiary} !important; }
        .dk-accent, .dk-accent * { color: ${DARK.accent} !important; }
        /* (0,2,0) beats the paragraph own .dk-text * rule at (0,1,1), which would otherwise
           repaint the label back to body colour and lose the accent in dark mode. */
        .dk-text .dk-label, .dk-label { color: ${DARK.accent} !important; }
        .dk-rule { border-color: ${DARK.hairline} !important; }
      }
    </style>
  </head>

  <body style="margin:0;padding:0;background-color:${C.parchment};" bgcolor="${C.parchment}" class="dk-ground">
    <!-- The grey line the inbox shows after the subject. Hidden in the body itself, and
         padded with zero-width joiners so a client cannot pull the next sentence of the
         email in after it and truncate mid-word. -->
    <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">
      ${esc(copy.preheader.chosen)}
      &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847;
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.parchment}" style="background-color:${C.parchment};" class="dk-ground">
      <tr>
        <td align="center" style="padding:32px 12px 40px;">

          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.paper}" class="shell dk-card" style="width:600px;max-width:600px;background-color:${C.paper};border:1px solid ${C.hairline};border-radius:14px;">

            <!-- Masthead. Text, not an image: roughly half of recipients have images off
                 by default, and a wordmark they cannot see is not a wordmark. -->
            <tr>
              <td class="gutter pad-top" style="padding:30px 36px 0;">
                <p style="margin:0;font-family:${SERIF};font-size:26px;line-height:30px;color:${C.maroon};" class="dk-accent">${esc(copy.masthead)}</p>
              </td>
            </tr>

            <!-- The letter. The founder's own words, in his order, and nothing under it but
                 the footer. -->
            <tr>
              <td class="gutter" style="padding:26px 36px 6px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td>
                      <p style="margin:0 0 18px;font-family:${FONT};font-size:16px;line-height:26px;color:${C.ink};" class="dk-text">${GREETING_TOKEN}</p>
                      ${paragraphs}
                      <p style="margin:28px 0 0;font-family:${SERIF};font-size:19px;line-height:28px;color:${C.ink};" class="dk-text">${copy.letter.signoff.map(esc).join('<br />')}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer. Four lines, no navigation, no icons, no second logo. -->
            <tr>
              <td class="gutter" style="padding:20px 36px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr><td style="border-top:1px solid ${C.hairline};font-size:0;line-height:0;padding-bottom:18px;" class="dk-rule">&nbsp;</td></tr>
                  <tr>
                    <td>
                      <p style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.tertiary};" class="dk-tertiary">${esc(copy.footer.signature)}</p>
                      <p style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.tertiary};" class="dk-tertiary">${POSTAL_TOKEN}</p>
                      <p style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.tertiary};" class="dk-tertiary">${esc(copy.footer.reason)}</p>
                      <p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.tertiary};" class="dk-tertiary"><a href="${UNSUBSCRIBE_TOKEN}" style="color:${C.tertiary};text-decoration:underline;" class="dk-tertiary">${esc(copy.footer.unsubscribeLabel)}</a></p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

          </table>

        </td>
      </tr>
    </table>
  </body>
</html>
`;

/**
 * The same email with its dark rules forced on.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * Dark mode is where email designs break, and it is the one thing about this email
 * nobody could look at. An iframe inherits the colour scheme of the page holding it,
 * not the system's, so the preview cannot show it; and seeing it for real meant
 * switching the whole operating system to dark and opening `welcome.html` in Safari.
 * A review step that costs a settings change is a review step that does not happen.
 *
 * **One token is swapped and nothing else.** `@media (prefers-color-scheme: dark)`
 * becomes `@media all`, so every rule inside fires unconditionally and the braces stay
 * balanced. That means this file is not a mock-up of the dark treatment: it is the dark
 * treatment, the same bytes, with the condition removed.
 *
 * **It is a preview and is never sent.** `send-test.mjs` and the worker both read
 * `welcome.html`. Sending this one would give every recipient the dark palette
 * regardless of their setting.
 *
 * What it still cannot show you is Gmail, which ignores the block entirely and runs its
 * own inversion over the light palette. Nothing outside Gmail can render that.
 */
const dark = html
  .replace('@media (prefers-color-scheme: dark) {', '@media all {')
  .replace(
    '<title>',
    '<!-- FORCED DARK PREVIEW. Generated by build.mjs; never sent. See welcome.html. -->\n    <title>',
  );

// ---------------------------------------------------------------------------
// The plain-text alternative
//
// Generated from the same `copy.json`, never written by hand. A hand-maintained text
// part is a text part that stops matching the HTML on the second edit, and it is the
// half nobody proofreads because it is the half nobody looks at.
//
// It is not an afterthought either: a message with no text part is a spam signal, some
// people read mail in plain text on purpose, and it is what a screen reader gets from a
// client set to prefer it.
// ---------------------------------------------------------------------------

const text = `${GREETING_TOKEN}

${copy.letter.paragraphs.map((p) => wrap(paragraphText(p))).join('\n\n')}

${copy.letter.signoff.join('\n')}

${'-'.repeat(72)}

${copy.footer.signature}
${POSTAL_TOKEN}
${wrap(copy.footer.reason)}

${copy.footer.unsubscribeLabel}: ${UNSUBSCRIBE_TOKEN}
`;

// ---------------------------------------------------------------------------
// The preview
//
// What the founder opens. Not the email: a page *about* the email, holding it at three
// widths in iframes, with the draft warning, every destination written out, and the
// decisions still outstanding. Opening `welcome.html` directly shows the email at
// whatever width the window happens to be and answers none of the questions that
// actually need answering before a send.
// ---------------------------------------------------------------------------

/**
 * Each subject option as an inbox row.
 *
 * A subject line is never read on its own. It is read in a list, next to a sender name,
 * with as much of the preheader as the row has space for, and it is read in about a
 * second against nine other rows. Judging one as a sentence in a config file is judging
 * it in the one context nobody sees it in.
 *
 * The sender name is the other half and is usually the half that decides an open, which
 * is why it is rendered here rather than described. `Suraj from bingd` reads as a
 * person; `bingd.` reads as a service.
 *
 * Deliberately not pixel-faithful to any one client. It is the shape they share: bold
 * sender, bold subject, the preheader trailing in grey and truncated by the width.
 */
const FROM_NAME = 'Suraj from bingd';

const inboxRow = (subject, note) => `
        <li class="row">
          <span class="from">${esc(FROM_NAME)}</span>
          <span class="line"><b>${esc(subject)}</b><span class="pre"> &mdash; ${esc(copy.preheader.chosen)}</span></span>
          ${note ? `<span class="tag">${esc(note)}</span>` : ''}
        </li>`;

const inboxRows = [
  inboxRow(copy.subject.chosen, 'recommended'),
  ...copy.subject.alternatives.map((alternative) => inboxRow(alternative, '')),
].join('');

const escAttr = (value) => esc(value).replace(/'/g, '&#39;');

/**
 * Every destination the email uses, links and in-app instructions together, as one list.
 * Both review pages render these rows, so neither can describe a card the email no longer
 * has.
 */
const usedTargets = new Set(
  // `typeof` first: a string has a legacy `.link()` method, so `'text'.link` is truthy.
  copy.letter.paragraphs.flatMap((p) => piecesOf(p)).filter((piece) => typeof piece === 'object' && piece.link).map((piece) => piece.target),
);

const destinationRows = [
  ...Object.entries(targets.targets)
    .filter(([name]) => usedTargets.has(name))
    .map(([name, t]) => ({
      name,
      classification: t.classification,
      where: `<a href="${escAttr(t.url)}">${esc(t.url)}</a>`,
      evidence: `${esc(t.deepLink)} <b>Without the app:</b> ${esc(t.webFallback)}${t.noToken ? ` <b>No token:</b> ${esc(t.noToken)}` : ''}`,
    })),
  ...(targets.labels ?? []).map((l) => ({
    name: l.label,
    classification: 'label',
    where: `Rendered by <code>${esc(l.file)}</code>`,
    evidence: esc(l.note),
  })),
];

const targetRows = destinationRows
  .map(
    (r) => `
      <tr>
        <td><code>${esc(r.name)}</code></td>
        <td><span class="cls cls-${esc(r.classification)}">${esc(r.classification)}</span></td>
        <td>${r.where}</td>
        <td>${r.evidence}</td>
      </tr>`,
  )
  .join('');

/** The same rows as `targetRows`, with the destination set in the mono face. */
const artifactRows = destinationRows
  .map(
    (r) => `
          <tr>
            <td><code>${esc(r.name)}</code></td>
            <td><span class="cls cls-${esc(r.classification)}">${esc(r.classification)}</span></td>
            <td class="mono">${r.where}</td>
            <td>${r.evidence}</td>
          </tr>`,
  )
  .join('');

/**
 * What still stands between this email and a real send, computed from the files rather
 * than written as prose, so it cannot go on saying "not set" after somebody set it.
 */
const decisions = [
  {
    title: 'The subject.',
    body: `Founder-approved 2026-09-18: "${esc(copy.subject.chosen)}". One subject, no alternatives, shown as an inbox row above.`,
  },
  {
    title: 'Postal address.',
    body:
      'Supplied at send time from the <code>WELCOME_POSTAL_ADDRESS</code> GitHub Actions secret, never from this repository. The footer above shows an obviously fake sample. A send refuses, before claiming anybody, while that secret is missing, blank or placeholder-shaped. A commercial email carries a physical mailing address; there is no company here, so it is one you are willing to publish.',
  },
  {
    title: 'Send from bingd.app.',
    body: 'Replies go to <code>suraj@bingd.app</code>. <em>Sending</em> as that address needs <code>bingd.app</code> added and verified in Resend (DKIM, the <code>send</code> subdomain, DMARC). Until then a test send uses <code>--from "Suraj from bingd &lt;suraj@auth.bingd.app&gt;"</code>.',
  },
  {
    title: 'A Resend key of its own.',
    body: 'Sending access, restricted to <code>bingd.app</code>. Never the key named <code>Supabase</code>: that one relays every sign-in code.',
  },

];

const decisionItems = (tag) =>
  decisions.map((d) => `<li>${tag ? '<div>' : ''}<b>${d.title}</b> <span>${d.body}</span>${tag ? '</div>' : ''}</li>`).join('\n        ');

/**
 * The review pages show the email as a recipient reads it, so the per-recipient tokens are
 * filled with visible sample values. Only here: dist/welcome.html keeps its tokens.
 */
const SAMPLE = {
  '{{greeting}}': 'Hey Suraj,',
  '{{inviteToken}}': '0123456789abcdef0123456789abcdef',
  '{{unsubscribeUrl}}': 'mailto:suraj@bingd.app?subject=Unsubscribe',
  // Obviously not a real address, on purpose: these pages are committed.
  '{{postalAddress}}': '1 Example Street, Sampleton EX1 2MP',
};
const sampled = (body) => Object.entries(SAMPLE).reduce((out, [token, value]) => out.split(token).join(value), body);
const srcdoc = escAttr(sampled(html));
const darkSrcdoc = escAttr(sampled(dark));

const preview = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>bingd. welcome email &mdash; preview</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        background: #e9e2d6;
        color: #242326;
        font: 15px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      .page { max-width: 1180px; margin: 0 auto; padding: 28px 20px 64px; }
      h1 { font-family: Georgia, serif; font-weight: 400; font-size: 30px; margin: 0 0 4px; color: #773744; }
      h2 { font-family: Georgia, serif; font-weight: 400; font-size: 21px; margin: 36px 0 10px; }
      .sub { margin: 0 0 24px; color: #5f5a56; }
      .draft {
        background: #fff4d6;
        border: 1px solid #d4a64c;
        border-radius: 10px;
        padding: 14px 18px;
        margin: 0 0 24px;
      }
      .draft b { color: #8a6512; }
      .frames { display: flex; gap: 20px; align-items: flex-start; overflow-x: auto; padding-bottom: 8px; }
      .frame { background: #fff; border: 1px solid #cdc3b4; border-radius: 12px; overflow: hidden; flex: 0 0 auto; }
      .frame figcaption {
        font-size: 12px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: #6e6862;
        padding: 9px 12px;
        border-bottom: 1px solid #e6dccc;
        background: #f7f2ea;
      }
      iframe { display: block; border: 0; background: #f5ebdd; }
      figure { margin: 0; }
      ol.inbox { list-style: none; margin: 0 0 10px; padding: 0; border: 1px solid #cdc3b4; border-radius: 8px; overflow: hidden; background: #fbf8f4; }
      ol.inbox li { display: grid; grid-template-columns: 10rem 1fr auto; gap: 12px; align-items: baseline; padding: 12px 14px; border-bottom: 1px solid #e6dccc; }
      ol.inbox li:last-child { border-bottom: 0; }
      ol.inbox .from { font-weight: 600; }
      ol.inbox .line { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      ol.inbox .pre { color: #8a827a; font-weight: 400; }
      ol.inbox .tag { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #2f5334; background: #d8e6d9; border-radius: 4px; padding: 2px 6px; }

      table.meta { border-collapse: collapse; width: 100%; font-size: 13px; background: #fbf8f4; }
      table.meta th, table.meta td { border: 1px solid #e0d6c6; padding: 8px 10px; text-align: left; vertical-align: top; }
      table.meta th { background: #f5ebdd; font-weight: 600; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: #f0e8dc; padding: 1px 5px; border-radius: 4px; }
      .cls { display: inline-block; min-width: 1.4em; text-align: center; font-weight: 700; border-radius: 4px; padding: 1px 6px; }
      .cls-A, .cls-I { background: #d8e6d9; color: #2f5334; }
      .cls-B { background: #f3e6c9; color: #6d5117; }
      .cls-C { background: #f3e6c9; color: #6d5117; }
      .cls-D { background: #f0d7d7; color: #7a2f2f; }
      ul { margin: 8px 0 0; padding-left: 20px; }
      li { margin-bottom: 8px; }
      .pair { display: grid; gap: 20px; }
      @media (min-width: 820px) { .pair { grid-template-columns: 1fr 1fr; } }
      pre { background: #fbf8f4; border: 1px solid #e0d6c6; border-radius: 8px; padding: 14px; overflow-x: auto; font-size: 12.5px; line-height: 1.55; }
      .warn { color: #7a2f2f; }
    </style>
  </head>
  <body>
    <div class="page">
      <h1>bingd. welcome email</h1>
      <p class="sub">
        Rendered from <code>emails/welcome/copy.json</code> on ${new Date().toISOString().slice(0, 10)}.
        Edit that file, run <code>node emails/welcome/build.mjs</code>, refresh this page.
      </p>

      <div class="draft">
        <p style="margin:0 0 6px"><b>FOUNDER COPY &middot; NOT SENT.</b></p>
        <p style="margin:0">
          The letter is the founder&rsquo;s own, locked on 2026-09-13. Nothing is sent to anybody
          until the postal address is set, a test send has been approved, and the automation
          is switched on. See the list at the bottom.
        </p>
      </div>

      <h2>How it renders</h2>
      <div class="frames">
        <figure class="frame">
          <figcaption>iPhone &mdash; 390px</figcaption>
          <iframe srcdoc='${srcdoc}' width="390" height="900" title="The welcome email at 390 pixels wide"></iframe>
        </figure>
        <figure class="frame">
          <figcaption>Narrow phone &mdash; 320px</figcaption>
          <iframe srcdoc='${srcdoc}' width="320" height="900" title="The welcome email at 320 pixels wide"></iframe>
        </figure>
        <figure class="frame">
          <figcaption>Desktop &mdash; 680px</figcaption>
          <iframe srcdoc='${srcdoc}' width="680" height="900" title="The welcome email at 680 pixels wide"></iframe>
        </figure>
        <figure class="frame">
          <figcaption>Dark &mdash; Apple Mail</figcaption>
          <iframe srcdoc='${darkSrcdoc}' width="390" height="900" style="background:#14110F" title="The welcome email with its dark rules forced on"></iframe>
        </figure>
      </div>
      <p class="sub" style="margin-top:14px">
        The fourth frame is the real dark treatment with its media query forced on, so it
        is the same bytes Apple Mail would render rather than a mock-up of them. Gmail is
        the one thing no preview can show: it ignores that block and runs its own
        inversion over the light palette, which is what the light palette is chosen to
        survive.
      </p>

      <h2>In an inbox</h2>
      <ol class="inbox">${inboxRows}
      </ol>
      <p class="sub">A subject is only ever read in a list, beside a sender name.</p>

      <h2>Subject and preheader</h2>
      <div class="pair">
        <div>
          <table class="meta">
            <tr><th>Subject &mdash; chosen</th><td>${esc(copy.subject.chosen)}</td></tr>
            ${copy.subject.alternatives.map((s) => `<tr><th>Alternative</th><td>${esc(s)}</td></tr>`).join('')}
          </table>
        </div>
        <div>
          <table class="meta">
            <tr><th>Preheader &mdash; chosen</th><td>${esc(copy.preheader.chosen)}</td></tr>
            ${copy.preheader.alternatives.map((s) => `<tr><th>Alternative</th><td>${esc(s)}</td></tr>`).join('')}
          </table>
        </div>
      </div>

      <h2>Where every link and instruction goes</h2>
      <table class="meta">
        <tr><th>Name</th><th>Class</th><th>Destination</th><th>What receives it</th></tr>
        ${targetRows}
      </table>
      <p class="sub" style="margin-top:12px">
        <b>A</b> directly deep-linkable &middot; <b>I</b> an instruction inside the app,
        with no link, whose labels are checked against the app&rsquo;s source &middot;
        <b>D</b> not currently practical, and refused by the build.
        <code>targets.json</code> carries the reasoning for each destination.
      </p>

      <h2>Plain text</h2>
      <pre>${esc(text)}</pre>

      <h2>Still to decide</h2>
      <ul>
        ${decisionItems(false)}
      </ul>
    </div>
  </body>
</html>
`;

// ---------------------------------------------------------------------------
// The hosted preview
//
// The same review page as `preview.html`, in the shape the Artifact host wants: no
// doctype, no <html>, no <head>, no <body>, because it supplies those. Generated from
// the same `copy.json` and `targets.json` as everything else, so there is no second
// place for the copy to drift to.
//
// It exists because the local file is a local file. The founder reads mail on a phone,
// and a review page that can only be opened on the machine that built it cannot be
// looked at next to the thing it is reviewing.
// ---------------------------------------------------------------------------

const artifact = `<title>Welcome Email Review</title>
<style>
  /* Two colour worlds on one page, deliberately. The console chrome is a cool
     sage-biased neutral; the email specimen inside it is bingd.'s warm parchment. The
     contrast is the point: it keeps the thing under review reading as a specimen rather
     than as more page. Sage and Maroon are both brand colours, so the chrome is related
     to the product without impersonating it. */
  :root {
    color-scheme: light;
    --ground: #ecefeb;
    --surface: #fafbf9;
    --sunken: #e3e7e2;
    --ink: #1d2321;
    --muted: #5a635e;
    --faint: #838d87;
    --hairline: #d3dad4;
    --accent: #773744;
    --accent-soft: #f3e4e7;
    --warn: #7d5c12;
    --warn-soft: #f8eed3;
    --warn-edge: #d9bb6e;
    --ok: #385f41;
    --ok-soft: #dfeae0;
    --shadow: rgba(29, 35, 33, 0.1);
  }

  @media (prefers-color-scheme: dark) {
    :root:not([data-theme='light']) {
      color-scheme: dark;
      --ground: #111614;
      --surface: #19201d;
      --sunken: #212927;
      --ink: #e7ece8;
      --muted: #9ca7a0;
      --faint: #77817b;
      --hairline: #2b3330;
      --accent: #c98a97;
      --accent-soft: #2e2124;
      --warn: #e0bd6a;
      --warn-soft: #2b2415;
      --warn-edge: #5c4a1d;
      --ok: #8fbd98;
      --ok-soft: #1b2a1e;
      --shadow: rgba(0, 0, 0, 0.4);
    }
  }

  :root[data-theme='dark'] {
    color-scheme: dark;
    --ground: #111614;
    --surface: #19201d;
    --sunken: #212927;
    --ink: #e7ece8;
    --muted: #9ca7a0;
    --faint: #77817b;
    --hairline: #2b3330;
    --accent: #c98a97;
    --accent-soft: #2e2124;
    --warn: #e0bd6a;
    --warn-soft: #2b2415;
    --warn-edge: #5c4a1d;
    --ok: #8fbd98;
    --ok-soft: #1b2a1e;
    --shadow: rgba(0, 0, 0, 0.4);
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 15px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }

  .page { max-width: 1200px; margin: 0 auto; padding: 40px 24px 80px; }

  h1, h2 {
    font-family: Fraunces, Georgia, serif;
    font-weight: 600;
    font-variation-settings: 'SOFT' 20, 'WONK' 1;
    letter-spacing: -0.01em;
    text-wrap: balance;
    margin: 0;
  }

  h1 { font-size: clamp(2rem, 5vw, 2.75rem); line-height: 1.08; }
  h2 { font-size: 1.35rem; line-height: 1.2; margin-bottom: 14px; }

  p { margin: 0; }
  a { color: var(--accent); }

  .eyebrow {
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--faint);
    margin-bottom: 10px;
  }

  .sub { color: var(--muted); max-width: 62ch; margin-top: 10px; }

  code, .mono {
    font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.82em;
  }
  code { background: var(--sunken); padding: 2px 6px; border-radius: 4px; }

  section { margin-top: 52px; }

  /* ------------------------------------------------------------------ notice */

  .notice {
    margin-top: 28px;
    background: var(--warn-soft);
    border: 1px solid var(--warn-edge);
    border-left: 4px solid var(--warn);
    border-radius: 8px;
    padding: 16px 20px;
  }
  .notice b { color: var(--warn); letter-spacing: 0.04em; }
  .notice p + p { margin-top: 8px; }

  /* --------------------------------------------------------------- specimens */

  .rail { display: flex; gap: 22px; overflow-x: auto; padding: 4px 4px 14px; }

  figure {
    margin: 0;
    flex: 0 0 auto;
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 10px 28px var(--shadow);
  }

  figcaption {
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--faint);
    padding: 11px 14px;
    border-bottom: 1px solid var(--hairline);
    background: var(--sunken);
  }

  iframe { display: block; border: 0; background: #f5ebdd; }

  /* ------------------------------------------------------------------ tables */

  .scroller { overflow-x: auto; border: 1px solid var(--hairline); border-radius: 10px; background: var(--surface); }

  table { border-collapse: collapse; width: 100%; min-width: 640px; font-size: 0.875rem; }
  th, td { text-align: left; vertical-align: top; padding: 12px 14px; border-bottom: 1px solid var(--hairline); }
  th { background: var(--sunken); font-weight: 600; font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); }
  tbody tr:last-child td { border-bottom: 0; }

  /* A classification is a state, so it reads as a chip rather than as a letter. */
  .cls {
    display: inline-block;
    min-width: 1.6rem;
    text-align: center;
    font-family: 'IBM Plex Mono', monospace;
    font-weight: 600;
    font-size: 0.78rem;
    border-radius: 4px;
    padding: 2px 7px;
  }
  .cls-A, .cls-I { background: var(--ok-soft); color: var(--ok); }
  .cls-B, .cls-C { background: var(--warn-soft); color: var(--warn); }
  .cls-D { background: var(--accent-soft); color: var(--accent); }

  /* ------------------------------------------------------------------ blocks */

  .stack { display: grid; gap: 14px; }
  @media (min-width: 780px) { .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; } }

  .panel {
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 10px;
    padding: 18px 20px;
  }
  .panel .label { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--faint); }
  .panel .value { margin-top: 6px; font-size: 1.0625rem; }
  .panel .alt { margin-top: 10px; color: var(--muted); font-size: 0.9rem; }

  pre {
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 10px;
    padding: 18px;
    overflow-x: auto;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.78rem;
    line-height: 1.65;
    margin: 0;
    color: var(--muted);
  }

  /* A decision list is a checklist, and the marker says whose decision it is. */
  ol.decisions { list-style: none; counter-reset: d; margin: 0; padding: 0; display: grid; gap: 14px; }
  ol.decisions li {
    counter-increment: d;
    display: grid;
    grid-template-columns: 1.9rem 1fr;
    gap: 14px;
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 10px;
    padding: 16px 18px;
  }
  ol.decisions li::before {
    content: counter(d);
    font-family: 'IBM Plex Mono', monospace;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-soft);
    border-radius: 6px;
    height: 1.9rem;
    display: grid;
    place-items: center;
    font-size: 0.85rem;
  }
  ol.decisions b { display: block; margin-bottom: 3px; }
  ol.decisions span { color: var(--muted); font-size: 0.9rem; }

  /* The inbox mock. A list, because that is what it is. */
  ol.inbox { list-style: none; margin: 0; padding: 0; border: 1px solid var(--hairline); border-radius: 10px; overflow: hidden; background: var(--surface); }
  ol.inbox .row {
    display: grid;
    grid-template-columns: 11rem 1fr auto;
    gap: 14px;
    align-items: baseline;
    padding: 14px 16px;
    border-bottom: 1px solid var(--hairline);
  }
  ol.inbox .row:last-child { border-bottom: 0; }
  ol.inbox .from { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  ol.inbox .line { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  ol.inbox .pre { color: var(--faint); font-weight: 400; }
  ol.inbox .tag {
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ok);
    background: var(--ok-soft);
    border-radius: 4px;
    padding: 2px 7px;
    white-space: nowrap;
  }
  @media (max-width: 640px) {
    ol.inbox .row { grid-template-columns: 1fr; gap: 4px; }
    ol.inbox .tag { justify-self: start; }
  }

  .foot { margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--hairline); color: var(--faint); font-size: 0.8rem; }
</style>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
  rel="stylesheet"
/>

<div class="page">
  <p class="eyebrow">bingd. &middot; lifecycle</p>
  <h1>The welcome email, before anyone gets it</h1>
  <p class="sub">
    Rendered from <code>emails/welcome/copy.json</code> on ${new Date().toISOString().slice(0, 10)}.
    Nothing has been sent. The automation is written and switched off. Edit the copy file,
    run <code>node emails/welcome/build.mjs</code>, and this page rebuilds with it.
  </p>

  <div class="notice">
    <p><b>FOUNDER COPY &middot; NOT SENT</b></p>
    <p>
      The letter is the founder&rsquo;s own, locked on 2026-09-13.
    </p>
    <p>
      Nobody is mailed until the postal address is set, a real test send has been approved,
      and the automation is switched on, which are separate decisions. The list at the
      bottom says where each one stands.
    </p>
  </div>

  <section>
    <h2>How it renders</h2>
    <p class="sub" style="margin-bottom:20px">
      The real HTML, in three frames. Scroll inside any of them.
    </p>
    <div class="rail">
      <figure>
        <figcaption>iPhone &middot; 390px</figcaption>
        <iframe srcdoc='${srcdoc}' width="390" height="880" title="The welcome email rendered at 390 pixels wide"></iframe>
      </figure>
      <figure>
        <figcaption>Narrow &middot; 320px</figcaption>
        <iframe srcdoc='${srcdoc}' width="320" height="880" title="The welcome email rendered at 320 pixels wide"></iframe>
      </figure>
      <figure>
        <figcaption>Desktop &middot; 680px</figcaption>
        <iframe srcdoc='${srcdoc}' width="680" height="880" title="The welcome email rendered at 680 pixels wide"></iframe>
      </figure>
      <figure>
        <figcaption>Dark &middot; Apple Mail</figcaption>
        <iframe srcdoc='${darkSrcdoc}' width="390" height="880" style="background:#14110F" title="The welcome email with its dark rules forced on"></iframe>
      </figure>
    </div>
    <p class="sub" style="margin-top:16px">
      The fourth frame is the real dark treatment with its media query forced on, so it is
      the same bytes Apple Mail would render rather than a mock-up of them. Gmail is the
      one thing no preview can show: it ignores that block entirely and runs its own
      inversion over the light palette, which is what the light palette is chosen to
      survive.
    </p>
  </section>

  <section>
    <h2>In an inbox</h2>
    <p class="sub" style="margin-bottom:18px">
      A subject line is only ever read in a list, beside a sender name, with the
      preheader trailing off the end of the row. The sender name is the half that
      usually decides the open.
    </p>
    <ol class="inbox">${inboxRows}
    </ol>
    <p class="sub" style="margin-top:14px">
      <code>Suraj from bingd</code> reads as a person. <code>bingd.</code> reads as a
      service, and this email's whole claim is that a person wrote it.
    </p>
  </section>

  <section>
    <h2>Subject and preheader</h2>
    <div class="cols">
      <div class="stack">
        <div class="panel">
          <p class="label">Subject &middot; recommended</p>
          <p class="value">${esc(copy.subject.chosen)}</p>
          <p class="alt">It says what the note is and asks for a reply in the same line, so
          replying reads as the expected response rather than an extra step.</p>
        </div>
        ${copy.subject.alternatives
          .map(
            (s) =>
              `<div class="panel"><p class="label">Alternative</p><p class="value">${esc(s)}</p></div>`,
          )
          .join('')}
      </div>
      <div class="stack">
        <div class="panel">
          <p class="label">Preheader &middot; recommended</p>
          <p class="value">${esc(copy.preheader.chosen)}</p>
          <p class="alt">The grey line after the subject. Second of three places the reply
          invitation appears before anybody scrolls.</p>
        </div>
        ${copy.preheader.alternatives
          .map(
            (s) =>
              `<div class="panel"><p class="label">Alternative</p><p class="value">${esc(s)}</p></div>`,
          )
          .join('')}
      </div>
    </div>
  </section>

  <section>
    <h2>Where every link and instruction goes</h2>
    <p class="sub" style="margin-bottom:18px">
      <span class="cls cls-A">A</span> directly deep-linkable &nbsp;
      <span class="cls cls-I">I</span> an instruction inside the app, with no link, whose
      labels are checked against the app&rsquo;s source &nbsp;
      <span class="cls cls-D">D</span> not currently practical, and refused by the build.
    </p>
    <div class="scroller">
      <table>
        <thead>
          <tr><th>Card</th><th>Class</th><th>Destination</th><th>What receives it</th></tr>
        </thead>
        <tbody>${artifactRows}</tbody>
      </table>
    </div>
    <p class="sub" style="margin-top:16px">
      Both destinations are inline links inside one sentence of the letter: the
      recipient&rsquo;s own invite link, and the founder&rsquo;s profile. There are no buttons
      and no in-app instructions.
    </p>
  </section>

  <section>
    <h2>Plain text</h2>
    <p class="sub" style="margin-bottom:18px">
      Generated from the same copy, never hand-maintained. A message with no text part is
      a spam signal, and a hand-written one stops matching the HTML on the second edit.
    </p>
    <pre>${esc(text)}</pre>
  </section>

  <section>
    <h2>Still yours to decide</h2>
    <ol class="decisions">
      ${decisionItems(true)}
    </ol>
  </section>

  <p class="foot">
    Not sent to anybody. Automation written and disabled. One email, one copy file, and
    every link and instruction in it checked against the app.
  </p>
</div>
`;

// ---------------------------------------------------------------------------

if (problems.length > 0) {
  console.error('\nCannot render the welcome email:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  process.exit(1);
}

await mkdir(dist, { recursive: true });
await writeFile(join(dist, 'welcome.html'), html);
await writeFile(join(dist, 'welcome-dark.html'), dark);
await writeFile(join(dist, 'welcome.txt'), text);
await writeFile(join(dist, 'preview.html'), preview);
await writeFile(join(dist, 'artifact.html'), artifact);

/**
 * What dist/ was rendered from. The worker refuses to send when these no longer match the
 * files on disk, so an edit nobody rebuilt cannot go out as the previous words.
 */
// Line endings normalised: a Windows checkout has CRLF and CI has LF, and the same file
// must hash the same in both or the worker would call every CI build stale.
const sha256 = (value) => createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');
await writeFile(
  join(dist, 'manifest.json'),
  `${JSON.stringify({ copy: sha256(copyRaw), targets: sha256(targetsRaw) }, null, 2)}\n`,
);

const words = copy.letter.paragraphs.map(paragraphText).join(' ').split(/\s+/).length;

console.log(`Rendered ${dist}`);
console.log(`  welcome.html   ${(html.length / 1024).toFixed(1)}KB`);
console.log(`  welcome-dark.html  the same email, dark rules forced on. Preview only.`);
console.log(`  welcome.txt    ${(text.length / 1024).toFixed(1)}KB`);
console.log(`  preview.html   open this one`);
console.log('  artifact.html  the same review page, shaped for the Artifact host');
console.log('');
console.log(`  subject        ${copy.subject.chosen}`);
console.log(`  letter         ${words} words, ${copy.letter.status}`);
console.log(`  links          ${[...usedTargets].join(', ')}`
);


/**
 * Gmail clips a message over roughly 102KB and shows a "View entire message" link,
 * which cuts the footer off exactly where the unsubscribe lives.
 */
for (const rule of ['.dk-card', '.dk-text', '.dk-accent']) {
  if (!html.includes(`class="`) || !html.includes(rule)) {
    warnings.push(`the dark-mode rule ${rule} is not in the output.`);
  }
}

/**
 * A dark class that is defined and never emitted is the defect an independent review
 * found: `.dk-fill` and `.dk-outline` sat in the stylesheet for a day while the button
 * factory wrote only `class="btn"`, so in Apple Mail's dark mode two buttons stayed
 * near-white on a dark card. The stylesheet and the markup have to agree.
 */
for (const cls of ['dk-card', 'dk-text', 'dk-tertiary', 'dk-accent', 'dk-rule', 'dk-ground']) {
  const declared = html.includes(`.${cls}`);
  const used = new RegExp(`class="[^"]*\\b${cls}\\b`).test(html);
  if (declared && !used) warnings.push(`.${cls} is styled but never put on an element.`);
  if (used && !declared) warnings.push(`.${cls} is on an element but never styled.`);
}

if (html.length > 102_000) {
  warnings.push(`welcome.html is ${(html.length / 1024).toFixed(0)}KB; Gmail clips past 102KB.`);
}

if (warnings.length > 0) {
  console.log('');
  for (const warning of warnings) console.log(`  ! ${warning}`);
}
