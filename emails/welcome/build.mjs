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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');

const copy = JSON.parse(await readFile(join(here, 'copy.json'), 'utf8'));
const targets = JSON.parse(await readFile(join(here, 'targets.json'), 'utf8'));

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
 * The build still produces every file, because the preview is the thing being reviewed
 * tomorrow and blocking it on an address would help nobody. `send-test.mjs` is where the
 * refusal bites.
 */
if (!copy.footer?.postalAddress) {
  warnings.push(
    'footer.postalAddress is null. The preview renders with a visible placeholder and ' +
      'send-test.mjs will refuse a real send. See copy.json $footerComment.',
  );
}

const UNSUBSCRIBE_TOKEN = '{{unsubscribeUrl}}';

// ---------------------------------------------------------------------------
// The HTML
// ---------------------------------------------------------------------------

/**
 * A button.
 *
 * Padding on the `<a>` **and** a background on the `<td>` behind it. Outlook ignores
 * padding on an anchor and paints the cell; everything else paints the anchor and gives
 * the whole rectangle a tap target. Doing only one of the two produces a button that is
 * a bare blue link in Outlook or a 20px-tall tap target on a phone.
 */
const button = ({ href, label, kind = 'primary' }) => {
  const fill = kind === 'primary' ? C.maroon : C.paper;
  const ink = kind === 'primary' ? C.inverse : C.maroon;

  /**
   * The dark class goes on the **table**, so the rule can reach both the cell's
   * background and the anchor's colour. It was on neither: `.dk-fill` and
   * `.dk-outline` were written in the stylesheet and never emitted, which meant that
   * in Apple Mail's dark mode the card inverted around two buttons that kept their
   * inline near-white `bgcolor` and sat on it as white slabs.
   */
  const dark = kind === 'primary' ? 'dk-fill' : 'dk-outline';

  /**
   * Padding on the cell as well as on the anchor, and a width on the table.
   *
   * Word's rendering engine, which is what Outlook on Windows uses, ignores
   * `display:inline-block` and `min-height` on an anchor, so a button whose whole shape
   * lives on the `<a>` collapses toward text height there. Stating it on the `<td>`
   * too costs nothing and is what Outlook actually paints.
   *
   * The `width` is the other half, and it is why the media query used to do nothing: a
   * table with no width shrink-fits to its content under auto-layout, so making the
   * anchor a block widened a box that was already exactly label-width. `btn-wrap` is
   * what the media query widens.
   */
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btn-wrap ${dark}" style="border-collapse:separate;">
                        <tr>
                          <td class="btn" align="center" bgcolor="${fill}" style="background-color:${fill};border:1px solid ${C.maroon};border-radius:6px;padding:2px;">
                            <a href="${esc(href)}" style="display:inline-block;min-height:24px;padding:11px 20px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:${ink};text-decoration:none;">${esc(label)}</a>
                          </td>
                        </tr>
                      </table>`;
};

const card = (item, index) => {
  const destination = target(item.target);
  if (!destination) return '';

  const instruction = item.instruction
    ? `<p style="margin:10px 0 0;font-family:${FONT};font-size:13px;line-height:19px;color:${C.tertiary};" class="dk-tertiary">${esc(item.instruction)}</p>`
    : '';

  return `
              <tr>
                <td style="padding:0 0 12px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.parchment}" style="background-color:${C.parchment};border:1px solid ${C.hairline};border-radius:10px;" class="dk-raised">
                    <tr>
                      <td style="padding:20px 20px 18px;">
                        <p style="margin:0;font-family:${SERIF};font-size:19px;line-height:24px;color:${C.ink};" class="dk-text">${esc(item.title)}</p>
                        <p style="margin:8px 0 16px;font-family:${FONT};font-size:15px;line-height:23px;color:${C.secondary};" class="dk-secondary">${esc(item.body)}</p>
                        ${button({ href: destination.url, label: item.action, kind: index === 0 ? 'primary' : 'secondary' })}
                        ${instruction}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>`;
};

const signoffLink = (() => {
  const spec = copy.note?.signoffLink;
  if (!spec) return '';
  const destination = target(spec.target);
  if (!destination) return '';
  return `<br /><a href="${esc(destination.url)}" style="font-family:${FONT};font-size:14px;color:${C.maroon};text-decoration:underline;" class="dk-accent">${esc(spec.label)}</a>`;
})();

const paragraphs = copy.note.paragraphs
  .map(
    (text) =>
      `<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:26px;color:${C.ink};" class="dk-text">${esc(text)}</p>`,
  )
  .join('\n                      ');

const cards = copy.cards.items.map(card).join('');

const postal = copy.footer.postalAddress ?? '[POSTAL ADDRESS - FOUNDER TO SUPPLY]';

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
        /* A button only as wide as its label is a small target at arm's length on a
           moving train. The width has to be on the table: under auto-layout a table
           with no width shrink-fits to its content, so widening only the anchor
           widens a box that is already exactly label-width. */
        .btn-wrap { width: 100% !important; }
        .btn a { display: block !important; text-align: center !important; }
      }

      /* Apple Mail and iOS Mail. Gmail ignores all of this and inverts on its own;
         see DARK in build.mjs for why the light palette is chosen to survive that. */
      @media (prefers-color-scheme: dark) {
        .dk-ground { background-color: ${DARK.ground} !important; }
        .dk-card { background-color: ${DARK.card} !important; border-color: ${DARK.hairline} !important; }
        .dk-raised { background-color: ${DARK.raised} !important; border-color: ${DARK.hairline} !important; }
        .dk-text, .dk-text * { color: ${DARK.text} !important; }
        .dk-secondary, .dk-secondary * { color: ${DARK.secondary} !important; }
        .dk-tertiary, .dk-tertiary * { color: ${DARK.tertiary} !important; }
        .dk-accent, .dk-accent * { color: ${DARK.accent} !important; }
        .dk-rule { border-color: ${DARK.hairline} !important; }
        /* The one filled button keeps a filled look rather than becoming a dark
           rectangle with dark text in it. */
        .dk-fill, .dk-fill td { background-color: ${DARK.accent} !important; border-color: ${DARK.accent} !important; }
        .dk-fill a { color: ${DARK.ground} !important; }
        .dk-outline td { background-color: ${DARK.raised} !important; border-color: ${DARK.accent} !important; }
        .dk-outline a { color: ${DARK.accent} !important; }
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

            <!-- The note. This is the email; everything under it is secondary. -->
            <tr>
              <td class="gutter" style="padding:26px 36px 6px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td>
                      <p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:26px;color:${C.ink};" class="dk-text">${esc(copy.note.greeting)}</p>
                      ${paragraphs}
                      <p style="margin:26px 0 0;font-family:${FONT};font-size:16px;line-height:26px;color:${C.ink};" class="dk-text">${copy.note.signoff.map(esc).join('<br />')}${signoffLink}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td class="gutter" style="padding:30px 36px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr><td style="border-top:1px solid ${C.hairline};font-size:0;line-height:0;" class="dk-rule">&nbsp;</td></tr>
                </table>
              </td>
            </tr>

            <!-- Three actions. Stacked at every width, deliberately: three columns at
                 600px gives each card about 170px, which turns every title into two
                 lines and every button into a word and a half. A column layout that
                 only works on a desktop is a column layout for the minority. -->
            <tr>
              <td class="gutter" style="padding:24px 36px 4px;">
                <p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:24px;color:${C.ink};" class="dk-text">${esc(copy.cards.intro)}</p>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cards}
                </table>

                <!-- The reply ask, one more time, where a skimmer's eye stops. It was in
                     the preheader and in the note's last paragraph, which are the top of
                     the email and about 700px down a phone; somebody who scrolled
                     straight to the buttons met it nowhere. -->
                <p style="margin:18px 0 0;font-family:${FONT};font-size:15px;line-height:24px;color:${C.secondary};" class="dk-secondary">${esc(copy.closer)}</p>
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
                      <p style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.tertiary};" class="dk-tertiary">${esc(postal)}</p>
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

const textCards = copy.cards.items
  .map((item) => {
    const destination = target(item.target);
    if (!destination) return '';
    const instruction = item.instruction ? `\n${wrap(item.instruction)}` : '';
    return `\n${item.title.toUpperCase()}\n${wrap(item.body)}${instruction}\n${destination.url}\n`;
  })
  .join('');

const signoffTextLink = (() => {
  const spec = copy.note?.signoffLink;
  if (!spec) return '';
  const destination = target(spec.target);
  return destination ? `\n${spec.label}: ${destination.url}` : '';
})();

const text = `${copy.note.greeting}

${copy.note.paragraphs.map((p) => wrap(p)).join('\n\n')}

${copy.note.signoff.join('\n')}${signoffTextLink}

${'-'.repeat(72)}

${copy.cards.intro}
${textCards}
${wrap(copy.closer)}

${'-'.repeat(72)}

${copy.footer.signature}
${postal}
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

const escAttr = (value) => esc(value).replace(/'/g, '&#39;');

const targetRows = Object.entries(targets.targets)
  .map(
    ([name, t]) => `
      <tr>
        <td><code>${esc(name)}</code></td>
        <td><span class="cls cls-${esc(t.classification)}">${esc(t.classification)}</span></td>
        <td><a href="${escAttr(t.url)}">${esc(t.url)}</a></td>
        <td>${esc(t.deepLink)}</td>
      </tr>`,
  )
  .join('');

/** The same rows as `targetRows`, with the classification rendered as a chip. */
const artifactRows = Object.entries(targets.targets)
  .map(
    ([name, t]) => `
          <tr>
            <td><code>${esc(name)}</code></td>
            <td><span class="cls cls-${esc(t.classification)}">${esc(t.classification)}</span></td>
            <td class="mono"><a href="${escAttr(t.url)}">${esc(t.url)}</a></td>
            <td>${esc(t.deepLink)}</td>
          </tr>`,
  )
  .join('');

const srcdoc = escAttr(html);

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
      table.meta { border-collapse: collapse; width: 100%; font-size: 13px; background: #fbf8f4; }
      table.meta th, table.meta td { border: 1px solid #e0d6c6; padding: 8px 10px; text-align: left; vertical-align: top; }
      table.meta th { background: #f5ebdd; font-weight: 600; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: #f0e8dc; padding: 1px 5px; border-radius: 4px; }
      .cls { display: inline-block; min-width: 1.4em; text-align: center; font-weight: 700; border-radius: 4px; padding: 1px 6px; }
      .cls-A { background: #d8e6d9; color: #2f5334; }
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
        <p style="margin:0 0 6px"><b>DRAFT &mdash; FOUNDER TO EDIT.</b></p>
        <p style="margin:0">
          The founder&rsquo;s note is a draft. It claims to be from a specific person and it
          should sound like him rather than like a good impression of him. Everything else
          on this page can ship as written. Two things are still blocking a real send:
          the postal address, and which mailbox <code>Reply-To</code> points at.
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
      </div>
      <p class="sub" style="margin-top:14px">
        Dark mode is not shown here, because an iframe inherits this page&rsquo;s colour
        scheme rather than the system one. To see it: switch the operating system to dark,
        then open <code>dist/welcome.html</code> directly in Safari, which honours
        <code>prefers-color-scheme</code> the way Apple Mail does. Gmail ignores the dark
        block entirely and inverts on its own, which the light palette is chosen to
        survive.
      </p>

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

      <h2>Where every button actually goes</h2>
      <table class="meta">
        <tr><th>Name</th><th>Class</th><th>Destination</th><th>What receives it</th></tr>
        ${targetRows}
      </table>
      <p class="sub" style="margin-top:12px">
        <b>A</b> directly deep-linkable &middot; <b>B</b> opens the app, with an
        instruction for the last step &middot; <b>C</b> needs a per-recipient link
        &middot; <b>D</b> not currently practical, and refused by the build.
        Group Picks is D and is why it is a sentence in the note rather than a fourth
        card; <code>targets.json</code> carries the reasoning.
      </p>

      <h2>Plain text</h2>
      <pre>${esc(text)}</pre>

      <h2>Still to decide</h2>
      <ul>
        <li><b>The note.</b> Rewrite it in your own voice. Keep the last paragraph: the
        reply invitation is the reason this email exists.</li>
        <li><b>Postal address.</b> ${copy.footer.postalAddress ? `Set to <code>${esc(copy.footer.postalAddress)}</code>.` : '<span class="warn">Not set. A commercial email needs one, and there is no company, so it is a home address or a PO box and that is your call.</span>'}</li>
        <li><b>From and Reply-To.</b> Resend has one verified domain,
        <code>auth.bingd.app</code>, so <code>suraj@bingd.app</code> cannot send until
        <code>bingd.app</code> is added there. Reply-To needs no verification but does
        need a mailbox somebody reads, and the release docs still record
        <code>hello@bingd.app</code> as unconfirmed.</li>
        <li><b>The third card&rsquo;s title.</b> It is set to The Wolf of Wall Street
        because your bio already makes the joke. Swap it for whatever you are actually
        watching: open the title in bingd., tap Share, paste the link.</li>
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
  .cls-A { background: var(--ok-soft); color: var(--ok); }
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
    <p><b>DRAFT &mdash; FOUNDER TO EDIT</b></p>
    <p>
      The note below is a draft. It claims to be from a specific person, and it should
      sound like him rather than like a good impression of him. Everything else here can
      ship as written.
    </p>
    <p>
      Two things block a real send, and neither is code: the postal address a commercial
      email has to carry, and which mailbox <code>Reply-To</code> points at.
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
    </div>
    <p class="sub" style="margin-top:16px">
      Dark mode is not shown here: an iframe inherits this page&rsquo;s colour scheme, not
      the system one. To see it, switch the OS to dark and open
      <code>dist/welcome.html</code> in Safari, which honours
      <code>prefers-color-scheme</code> the way Apple Mail does. Gmail ignores that block
      and inverts on its own, which the light palette is chosen to survive.
    </p>
  </section>

  <section>
    <h2>Subject and preheader</h2>
    <div class="cols">
      <div class="stack">
        <div class="panel">
          <p class="label">Subject &middot; recommended</p>
          <p class="value">${esc(copy.subject.chosen)}</p>
          <p class="alt">It asks a question, which is the one thing a subject line can do
          that makes replying feel like the obvious response rather than an extra step.</p>
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
    <h2>Where every button actually goes</h2>
    <p class="sub" style="margin-bottom:18px">
      <span class="cls cls-A">A</span> directly deep-linkable &nbsp;
      <span class="cls cls-B">B</span> opens the app, with an instruction for the last step
      &nbsp; <span class="cls cls-D">D</span> not currently practical, and refused by the
      build. Every row below was checked against the repository, and the two marked so were
      checked against the production database.
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
      Group Picks is <span class="cls cls-D">D</span> and is why it is a sentence in the
      note rather than a fourth card: it has no route, no deep link, and it refuses to do
      anything until the reader follows somebody. A card for it would land on an empty
      state, on exactly the accounts most likely to hit one.
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
      <li>
        <div>
          <b>Rewrite the note.</b>
          <span>Keep the last paragraph. The reply invitation is the reason the email
          exists; everything else in it is replaceable.</span>
        </div>
      </li>
      <li>
        <div>
          <b>Postal address.</b>
          <span>${
            copy.footer.postalAddress
              ? `Set to ${esc(copy.footer.postalAddress)}.`
              : 'Not set. This email asks the reader to invite somebody, which is enough promotional content to read as commercial, and a commercial email carries a physical mailing address. There is no company, so it is a home address or a PO box, and that is your call rather than a default.'
          }</span>
        </div>
      </li>
      <li>
        <div>
          <b>From and Reply-To.</b>
          <span>Resend has one verified domain, <code>auth.bingd.app</code>, so
          <code>suraj@bingd.app</code> cannot send until <code>bingd.app</code> is added
          there. Reply-To needs no verification, but it does need a mailbox somebody reads,
          and the release docs still record <code>hello@bingd.app</code> as unconfirmed for
          receiving.</span>
        </div>
      </li>
      <li>
        <div>
          <b>The third card&rsquo;s title.</b>
          <span>Set to The Wolf of Wall Street, because your bio already makes the joke and
          it is your number one at 10.0. Swap it for whatever you are actually watching:
          open the title in bingd., tap Share, paste the link.</span>
        </div>
      </li>
    </ol>
  </section>

  <p class="foot">
    Not sent to anybody. Automation written and disabled. One email, one copy file, three
    destinations, all of them real.
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
await writeFile(join(dist, 'welcome.txt'), text);
await writeFile(join(dist, 'preview.html'), preview);
await writeFile(join(dist, 'artifact.html'), artifact);

const words = copy.note.paragraphs.join(' ').split(/\s+/).length;

console.log(`Rendered ${dist}`);
console.log(`  welcome.html   ${(html.length / 1024).toFixed(1)}KB`);
console.log(`  welcome.txt    ${(text.length / 1024).toFixed(1)}KB`);
console.log(`  preview.html   open this one`);
console.log('  artifact.html  the same review page, shaped for the Artifact host');
console.log('');
console.log(`  subject        ${copy.subject.chosen}`);
console.log(`  note           ${words} words (target 150-225)`);
console.log(
  `  cards          ${copy.cards.items.map((i) => `${i.title} [${targets.targets[i.target]?.classification}]`).join(' | ')}`,
);

if (words < 150 || words > 225) {
  warnings.push(`the founder note is ${words} words; the brief asks for 150 to 225.`);
}

/**
 * Gmail clips a message over roughly 102KB and shows a "View entire message" link,
 * which cuts the footer off exactly where the unsubscribe lives.
 */
if (html.length > 102_000) {
  warnings.push(`welcome.html is ${(html.length / 1024).toFixed(0)}KB; Gmail clips past 102KB.`);
}

if (warnings.length > 0) {
  console.log('');
  for (const warning of warnings) console.log(`  ! ${warning}`);
}
