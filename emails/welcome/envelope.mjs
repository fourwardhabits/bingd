/**
 * The one definition of what a welcome email actually is on the wire.
 *
 * `send-test.mjs` and `automation/send-welcome.mjs` both build their Resend request here,
 * so a test send is the real envelope with a test recipient, not a second implementation
 * that happens to look similar. A test that proves a different code path proves nothing
 * about the send that matters.
 *
 * No dependencies and no I/O except `loadTemplate`.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Bumped only when the email changes enough that somebody who got v1 should be able to
 * get v2. It is part of the automation's idempotency key, so bumping it is a deliberate
 * decision and never a side effect of a copy edit.
 */
export const TEMPLATE_VERSION = 'v1';

/**
 * The envelope the founder chose: replies go to him.
 *
 * `suraj@bingd.app` is received by Cloudflare Email Routing on the root domain. It can
 * be a Reply-To today. It can only be a From once `bingd.app` itself is verified in
 * Resend, which today has `auth.bingd.app` alone; until then `send-test.mjs --from`
 * takes an `@auth.bingd.app` address for a test.
 */
export const DEFAULT_FROM = 'Suraj from bingd <suraj@bingd.app>';
export const DEFAULT_REPLY_TO = 'suraj@bingd.app';

/**
 * THE POSTAL ADDRESS IS A RUNTIME SECRET, NOT COPY.
 *
 * A commercial email has to carry a physical mailing address, and the founder's is his
 * home. It was `copy.json` `footer.postalAddress` until 2026-09-17; it is now read from
 * the environment at send time, because a value committed to `copy.json` is a home
 * address in the git history of a public-facing repository for ever, and rewriting
 * history is not a remedy anybody should have to reach for.
 *
 * The rendered files in `dist/` therefore carry `{{postalAddress}}` exactly as they carry
 * `{{greeting}}`, and `personalise` refuses to return a message with a token left in it.
 * That is what makes "a placeholder cannot be sent" a property of the code rather than a
 * thing to remember: there is no placeholder to leak, only a token that fails loudly.
 */
export const POSTAL_ADDRESS_ENV = 'WELCOME_POSTAL_ADDRESS';

/**
 * Anything that looks like the old placeholder, or like somebody testing the pipe rather
 * than filling it in. Checked so that a secret set to "TODO" fails the same way an unset
 * one does, rather than mailing the word TODO to every new account.
 */
const PLACEHOLDER = /\[|\]|FOUNDER TO SUPPLY|POSTAL ADDRESS|TODO|TBD|FIXME|XXXX/i;

/**
 * The address to print in the footer, read from `env` and normalised to one line.
 *
 * **Fails closed.** Missing, blank, whitespace-only, too short to be an address, or
 * placeholder-shaped all throw, and every caller treats that as a refusal to send rather
 * than as a footer to omit — an email that drops the address is the one that breaks the
 * rule the address is there to satisfy.
 *
 * Whitespace is collapsed rather than rejected: a GitHub secret pasted from an address
 * label arrives with newlines and a trailing one, and a footer is a single line. The
 * **message never names the value**, only the variable, so a bad secret can be diagnosed
 * from a log without the log containing somebody's home address.
 */
export const postalAddressFrom = (env) => {
  const raw = env?.[POSTAL_ADDRESS_ENV];
  if (raw === undefined || raw === null) {
    throw new Error(`${POSTAL_ADDRESS_ENV} is not set. A commercial email needs a physical mailing address.`);
  }
  const line = String(raw).replace(/\s+/g, ' ').trim();
  if (line === '') {
    throw new Error(`${POSTAL_ADDRESS_ENV} is blank. A commercial email needs a physical mailing address.`);
  }
  if (line.length < 10 || !/\p{L}/u.test(line)) {
    throw new Error(`${POSTAL_ADDRESS_ENV} is too short to be a mailing address.`);
  }
  if (PLACEHOLDER.test(line)) {
    throw new Error(`${POSTAL_ADDRESS_ENV} still looks like a placeholder rather than an address.`);
  }
  return line;
};

/**
 * HTML-escapes a value going into a text node of the message.
 *
 * The postal address is the one part of the letter that arrives from outside the
 * repository, so it is the one part that could carry `<` or `&` — a building name with an
 * ampersand is ordinary, not an attack — and an unescaped `&` alone is already invalid
 * HTML. Quotes are escaped too, which costs nothing and means this is still correct if a
 * later footer puts the value in an attribute.
 */
export const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const ADDRESS = /^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$/;

/** A bare address, or a display name with the address in angle brackets. */
export const addressOf = (value) => {
  const match = /<([^<>]+)>\s*$/.exec(String(value ?? ''));
  return (match ? match[1] : String(value ?? '')).trim();
};

export const isAddress = (value) => ADDRESS.test(addressOf(value));

/** The first word of a display name, when it looks like a name; otherwise null. */
export const firstNameOf = (displayName) => {
  const first = String(displayName ?? '').trim().split(/\s+/)[0] ?? '';
  return /^[\p{L}][\p{L}'’-]{1,23}$/u.test(first) ? first : null;
};

/**
 * The founder's greeting (`copy.letter.greeting`, "Hey {{firstName}},") for one recipient.
 *
 * With no usable first name the name and the space before it go, so it reads "Hey,". It
 * never falls back to the handle: "Hey saisurajkan," is the exact tell that nobody wrote
 * this, in an email whose whole claim is that somebody did.
 */
export const greetingFor = (displayName, template = 'Hey {{firstName}},') => {
  const first = firstNameOf(displayName);
  return first ? template.split('{{firstName}}').join(first) : template.replace(/\s*\{\{firstName\}\}/, '');
};

/**
 * A personal invite token as `create_invite_link` mints it: a uuid with the dashes removed
 * (src/features/invite/pending.ts). Anything else is not a link the resolver will accept.
 */
export const INVITE_TOKEN = /^[0-9a-f]{32}$/;
export const inviteUrlFor = (token) => {
  if (!INVITE_TOKEN.test(String(token ?? ''))) throw new Error('the recipient has no valid personal invite token');
  return `https://bingd.app/i/${token}`;
};

/**
 * The unsubscribe, as a `mailto:` to the Reply-To mailbox.
 *
 * Honest for v1: the mailbox is one the founder reads by definition, and what turns the
 * email into "never mail this address" is a row in `email_suppressions`. Gmail and Apple
 * Mail surface their own control from the `List-Unsubscribe` header built below.
 */
export const unsubscribeFor = (replyTo) =>
  `mailto:${addressOf(replyTo)}?subject=${encodeURIComponent('Unsubscribe')}`;

/** The rendered files `build.mjs` wrote, and the copy they came from. */
export const loadTemplate = async (root = here) => {
  const [html, text, copyRaw] = await Promise.all([
    readFile(join(root, 'dist', 'welcome.html'), 'utf8'),
    readFile(join(root, 'dist', 'welcome.txt'), 'utf8'),
    readFile(join(root, 'copy.json'), 'utf8'),
  ]);
  return { html, text, copy: JSON.parse(copyRaw) };
};

/**
 * Fills the per-recipient tokens and refuses to return anything with a token left in it.
 *
 * The rendered files keep their tokens on purpose: a template already personalised for
 * somebody is a template that gets sent to everybody as that somebody.
 */
export const personalise = (body, values) => {
  let out = body;
  for (const [name, value] of Object.entries(values)) {
    out = out.split(`{{${name}}}`).join(String(value));
  }
  const left = out.match(/\{\{[a-zA-Z]+\}\}/);
  if (left) throw new Error(`the email still contains ${left[0]} after personalisation`);
  return out;
};

/**
 * The Resend `POST /emails` body.
 *
 * `List-Unsubscribe` carries the mailto. **No `List-Unsubscribe-Post`**: RFC 8058
 * one-click is defined over HTTPS POST, pairing it with a mailto is invalid, and a
 * receiver may discard both rather than fall back. Add it in the commit that adds an
 * HTTPS endpoint, which is conditional here so that commit is a one-line change.
 */
export const resendPayload = ({ from, replyTo, to, subject, html, text, unsubscribeUrl }) => {
  for (const [label, value] of [['From', from], ['Reply-To', replyTo], ['To', to]]) {
    if (!isAddress(value)) throw new Error(`${label} "${value}" is not a single email address`);
  }
  if (/^no-?reply@/i.test(addressOf(replyTo))) {
    throw new Error('Reply-To is a no-reply address, which defeats the entire email');
  }
  return {
    from,
    to: [addressOf(to)],
    reply_to: addressOf(replyTo),
    subject,
    html,
    text,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      ...(unsubscribeUrl.startsWith('https://')
        ? { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
        : {}),
    },
  };
};

/**
 * Sends one payload. Returns `{ ok, status, id, body }` and never throws for an HTTP
 * refusal; a network failure or timeout comes back as `status: 0`.
 */
export const sendViaResend = async ({ fetch: fetchImpl = fetch, apiKey, idempotencyKey, payload, timeoutMs = 20_000 }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return { ok: response.ok && Boolean(body?.id), status: response.status, id: body?.id ?? null, body };
  } catch (error) {
    return { ok: false, status: 0, id: null, body: { error: String(error?.message ?? error) } };
  } finally {
    clearTimeout(timer);
  }
};
