/**
 * Does the deployed project actually send a code?
 *
 * `config/auth-templates.test.mjs` asserts what the templates in this repository say.
 * This asserts what the project in front of us is configured with, which is the half
 * that was wrong: the client has always called `signInWithOtp`, the repo now says the
 * email should carry `{{ .Token }}`, and a friend-beta tester still received a
 * confirmation link — because nothing had ever read the project back.
 *
 *   node scripts/check-auth-config.mjs           # read-only
 *   node scripts/check-auth-config.mjs --apply   # write the canonical templates
 *
 * Deliberately **not** an npm script. `package.json`'s `scripts` block is a fingerprint
 * source, and editing it moves the runtime version of the published friend-beta binary,
 * which would stop that binary receiving over-the-air updates (`config/push.cjs`). It is
 * named in the bootstrap and release runbooks instead.
 *
 * ---------------------------------------------------------------------------
 * TWO LEVELS OF ANSWER, AND IT NEVER PRETENDS TO THE HIGHER ONE
 *
 * With no `SUPABASE_ACCESS_TOKEN` it can still read GoTrue's public `/auth/v1/settings`
 * with the anon key, which proves whether email sign-in is enabled and whether a new
 * address is routed through **Confirm signup** — genuinely useful, and not the question.
 * It then exits 2 and prints the dashboard path, rather than exiting 0 and letting a
 * green line stand in for a check that did not happen.
 *
 * With a token it reads `/v1/projects/{ref}/config/auth` and compares the keys the
 * manifest names.
 *
 * ---------------------------------------------------------------------------
 * WHY `--apply` SENDS A PARTIAL PATCH
 *
 * `supabase config push` sends a whole `[auth]` block and reverts every field it does
 * not mention — **including the Apple and Google client secrets**, which is how a fix to
 * one thing takes out two working sign-in methods. `docs/architecture/auth.md` records
 * that being learned the hard way. This sends exactly the keys in `templates.json` and
 * nothing else.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE PRINTS A SECRET
 *
 * Not the access token, not the anon key, not the service key, and not a one-time code:
 * this reads configuration and never triggers an email, so no OTP is ever in reach. The
 * only project-identifying thing printed is the ref, which is in the URL of every
 * request the app makes.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { supabaseProjectRef } = require('../config/backends.cjs');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const templatesDir = join(root, 'supabase', 'auth-templates');

const APPLY = process.argv.includes('--apply');

/**
 * Every exit goes through here rather than through `process.exit`.
 *
 * `process.exit()` tears the process down while undici still holds an open socket, and
 * on Windows that is not a tidy early return — it aborts with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and an exit status of 127.
 * Anything reading the status would see a crash rather than the verdict this script had
 * already printed, which is the one thing a drift check must never do. Throwing to the
 * bottom of the file and setting `exitCode` lets the loop drain and exits with the
 * number that was meant.
 */
class Done extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

const done = (code) => {
  throw new Done(code);
};

// ---------------------------------------------------------------------------
// What this repository says the answer should be
// ---------------------------------------------------------------------------

const manifest = JSON.parse(readFileSync(join(templatesDir, 'templates.json'), 'utf8'));

/** The canonical value for every Management API key the manifest names. */
const wanted = new Map();
for (const [key, value] of Object.entries(manifest.settings)) {
  if (key !== '//') wanted.set(key, value);
}
for (const entry of manifest.templates) {
  wanted.set(entry.subjectKey, entry.subject);
  wanted.set(entry.bodyKey, readFileSync(join(templatesDir, entry.bodyFile), 'utf8'));
}

function loadEnv() {
  const out = {};
  try {
    for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) out[match[1]] = match[2];
    }
  } catch {
    // No .env is a fine state for a machine that only ever runs the local suite.
  }
  return out;
}

/** A body differing only by trailing whitespace is not drift. */
const same = (a, b) =>
  typeof a === 'string' && typeof b === 'string' ? a.trim() === b.trim() : a === b;

async function main() {
  const env = { ...loadEnv(), ...process.env };
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    console.error('Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY.');
    done(1);
  }

  const ref = supabaseProjectRef(url);
  if (!ref) {
    console.error('EXPO_PUBLIC_SUPABASE_URL is not a Supabase project URL.');
    done(1);
  }

  console.log(`\nAuth email configuration — project ${ref}\n`);

  // -------------------------------------------------------------------------
  // The half that needs no credential
  // -------------------------------------------------------------------------

  const settings = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: anonKey } })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);

  if (!settings) {
    console.error('Could not read /auth/v1/settings. Is the project reachable?');
    done(1);
  }

  const emailEnabled = settings.external?.email === true;
  console.log(`  email sign-in enabled      ${emailEnabled ? 'yes' : 'NO'}`);
  console.log(`  signups allowed            ${settings.disable_signup ? 'NO' : 'yes'}`);
  console.log(`  mailer_autoconfirm         ${settings.mailer_autoconfirm}`);

  if (settings.mailer_autoconfirm === false) {
    // Not a fault. It is what routes a brand-new address through **Confirm signup**
    // rather than **Magic Link**, which is why both templates have to be right — and it
    // is exactly the case the tester was in.
    console.log(
      '    -> a new address is sent the "Confirm signup" template, not "Magic Link".\n' +
        '       Both must carry the code. Fixing only one leaves every new user stranded.',
    );
  }

  if (!emailEnabled) {
    console.error('\nFAIL: email sign-in is disabled on this project; sendEmailCode cannot work.');
    done(1);
  }

  // -------------------------------------------------------------------------
  // The half that does
  // -------------------------------------------------------------------------

  const token = env.SUPABASE_ACCESS_TOKEN;

  if (!token) {
    console.log(
      [
        '',
        '  templates                  NOT VERIFIED — no SUPABASE_ACCESS_TOKEN',
        '',
        'The public settings endpoint does not expose email templates, so this cannot say',
        'whether the deployed emails carry a code or a link. Two ways to answer it:',
        '',
        '  · set a personal access token and run this again:',
        '      $env:SUPABASE_ACCESS_TOKEN = "<token from supabase.com/dashboard/account/tokens>"',
        '      node scripts/check-auth-config.mjs',
        '',
        `  · or read it in the dashboard, for project ${ref}:`,
        '      Authentication -> Emails -> "Confirm signup"  — body must contain {{ .Token }}',
        '      Authentication -> Emails -> "Magic Link"      — body must contain {{ .Token }}',
        '      Authentication -> Sign In / Providers -> Email — OTP length 6, expiry 600s',
        '',
        '    Neither body may contain {{ .ConfirmationURL }}. That is the magic link, and it',
        '    is what a tester receives instead of a code.',
        '',
        'If the dashboard refuses to save a template, the project is on the free tier with',
        'the built-in email sender, and templates cannot be edited at all until custom SMTP',
        'is configured. See supabase/auth-templates/README.md.',
      ].join('\n'),
    );
    done(2);
  }

  const api = async (method, body) => {
    const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { ok: response.ok, status: response.status, body: parsed, text };
  };

  const live = await api('GET');

  if (!live.ok) {
    // The message is printed because it is the diagnosis. The free-tier refusal names
    // itself, and no token or credential appears in it.
    console.error(`\nFAIL: could not read the auth config (HTTP ${live.status}).`);
    console.error(live.body?.message ?? live.text.slice(0, 400));
    done(1);
  }

  const drift = [];
  for (const [key, value] of wanted) {
    if (!same(live.body?.[key], value)) drift.push(key);
  }

  const describe = (key) => {
    const actual = live.body?.[key];
    if (typeof actual !== 'string') return `        deployed: ${JSON.stringify(actual)}`;
    if (key.endsWith('_content')) {
      const hasToken = /\{\{\s*\.Token\s*\}\}/.test(actual);
      const hasUrl = /ConfirmationURL/.test(actual);
      return `        deployed: ${hasToken ? 'has {{ .Token }}' : 'NO CODE'}${
        hasUrl ? ', has {{ .ConfirmationURL }} — THIS IS THE MAGIC LINK' : ''
      }`;
    }
    return `        deployed: ${JSON.stringify(actual)}`;
  };

  console.log('');
  for (const [key] of wanted) {
    const ok = !drift.includes(key);
    console.log(`  ${ok ? 'ok   ' : 'DRIFT'}  ${key}`);
    if (!ok) console.log(describe(key));
  }

  if (drift.length === 0) {
    console.log('\nThe deployed project matches supabase/auth-templates/. Email sign-in sends a code.\n');
    done(0);
  }

  if (!APPLY) {
    console.error(
      `\nFAIL: ${drift.length} key(s) differ from supabase/auth-templates/.` +
        '\nRe-run with --apply to write the canonical values (a partial PATCH; nothing else is touched).\n',
    );
    done(1);
  }

  // -------------------------------------------------------------------------
  // Applying
  // -------------------------------------------------------------------------

  const patch = {};
  for (const key of drift) patch[key] = wanted.get(key);

  const written = await api('PATCH', patch);

  if (!written.ok) {
    console.error(`\nFAIL: could not write the auth config (HTTP ${written.status}).`);
    console.error(written.body?.message ?? written.text.slice(0, 400));
    if (/free tier|default email provider|custom SMTP/i.test(written.text)) {
      console.error(
        '\nThis is the plan-and-provider restriction, not a bad request: Supabase refuses\n' +
          'template edits entirely while a project uses the built-in email sender on the free\n' +
          'tier. Configure custom SMTP first — Authentication -> Emails -> SMTP Settings.\n' +
          'See supabase/auth-templates/README.md.\n',
      );
    }
    done(1);
  }

  console.log(`\nApplied ${drift.length} key(s). Re-reading to confirm…`);

  const after = await api('GET');
  const remaining = [...wanted].filter(([key, value]) => !same(after.body?.[key], value));

  if (remaining.length) {
    console.error(`FAIL: ${remaining.length} key(s) still differ after the write.\n`);
    done(1);
  }

  console.log('Confirmed. Email sign-in now sends a code.\n');
  console.log(
    'This is configuration, not code: it is not in the pull request and it does not travel\n' +
      'with a deploy. A new project starts from the default templates again.\n',
  );
}

try {
  await main();
  process.exitCode = 0;
} catch (error) {
  if (error instanceof Done) {
    process.exitCode = error.code;
  } else {
    console.error('\nThe check itself failed:', error?.message ?? error);
    process.exitCode = 1;
  }
}
