/**
 * Does the deployed project accept the callback this app actually sends?
 *
 * ===========================================================================
 * WHY THIS EXISTS
 *
 * On 2026-09-10 the founder signed in with Google from TestFlight, authenticated
 * successfully, and was left in the auth sheet on `https://bingd.app` with no session and
 * no error anywhere. The cause is a GoTrue behaviour that `docs/architecture/auth.md`
 * asserted the opposite of:
 *
 *   > an unregistered value is refused by Supabase before the provider is ever contacted
 *
 * It is not refused. **GoTrue substitutes `site_url` for a `redirect_to` it cannot use**
 * and contacts the provider anyway. Probed against production:
 *
 *   redirect_to=bingd://auth/callback    -> bingd://auth/callback#...    honoured
 *   redirect_to=https://evil.example.com -> https://bingd.app#...        substituted
 *   redirect_to omitted                  -> https://bingd.app#...        substituted
 *
 * So a wrong or missing redirect is a *successful* sign-in that ends on the marketing
 * site. There is no failed request to find in a log and no error for the client to show.
 *
 * `methods.ts` now builds the callback from the app's own declared scheme and refuses to
 * start the flow if it cannot, and `methods.oauth.test.ts` pins that. But the client half
 * being right proves nothing about the project half: **URL configuration is console
 * state**, exactly like the email templates in `check-auth-config.mjs`. It does not travel
 * with a deploy and it is not in any pull request's diff. This is the half that reads the
 * project back.
 *
 * ---------------------------------------------------------------------------
 * IT NEEDS NO DATABASE PASSWORD AND IGNORES THE LINK
 *
 * `supabase config diff --project-ref <ref>` authenticates with the CLI's own token and
 * reports the remote `[auth]` block, whichever project `supabase/.temp` is linked to. So
 * this can check staging and production from a machine linked to either.
 *
 *   node scripts/check-oauth-redirects.mjs                    # production
 *   node scripts/check-oauth-redirects.mjs --target staging
 *
 * Deliberately **not** an npm script: `package.json`'s `scripts` block is a fingerprint
 * source and editing it moves the runtime version of published binaries
 * (`config/push.cjs`). Same reasoning as `check-auth-config.mjs`.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE PRINTS A SECRET
 *
 * It reads two configuration values — the redirect allow-list and the site URL — and
 * never triggers an email or an OAuth flow, so no code and no token is ever in reach.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { PRODUCTION_REF, STAGING_REF } = require('../config/backends.cjs');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const targetArg = process.argv.includes('--target')
  ? process.argv[process.argv.indexOf('--target') + 1]
  : 'production';
const ref = targetArg === 'staging' ? STAGING_REF : PRODUCTION_REF;
if (targetArg !== 'staging' && targetArg !== 'production') {
  console.error(`Unknown --target ${targetArg}. Use "staging" or "production".`);
  process.exit(1);
}

/**
 * The callbacks the three variants send, derived from `app.config.ts` rather than listed.
 *
 * A literal list here would be a second place to change a scheme, and the whole failure
 * this guards against is two places disagreeing about one value.
 */
/**
 * Only the `variants` table, which is the one that declares a URL scheme the binary
 * registers. `app.config.ts` also contains `{ scheme: 'https', host: 'bingd.app' }`
 * entries — those are Android intent filters for Universal Links and are a different
 * meaning of the same word. Anchoring on `bundleId` on the same line is what separates
 * them: a variant has one, an intent filter does not.
 */
const appConfig = readFileSync(join(root, 'app.config.ts'), 'utf8');
const schemes = [...appConfig.matchAll(/bundleId:\s*'[^']+',\s*scheme:\s*'([a-z][a-z0-9+.-]*)'/g)]
  .map((m) => m[1]);
const unique = [...new Set(schemes)];

if (unique.length === 0) {
  console.error('Could not read any scheme out of app.config.ts. Refusing to guess.');
  process.exit(1);
}

console.log(`OAuth redirect configuration — project ${ref} (${targetArg})\n`);
console.log(`  schemes declared in app.config.ts   ${unique.join(', ')}`);

let remote;
try {
  const out = execFileSync(
    'npx',
    ['--yes', 'supabase@latest', 'config', 'diff', '--project-ref', ref],
    { encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'pipe'], shell: true },
  );
  const start = out.indexOf('{');
  if (start < 0) throw new Error(`no JSON in the CLI output: ${out.slice(0, 200)}`);
  remote = JSON.parse(out.slice(start));
} catch (e) {
  console.error('\nCould not read the remote config. Is the Supabase CLI logged in?');
  console.error(String(e?.stderr ?? '').slice(0, 300));
  console.error(String(e?.message ?? e).slice(0, 300));
  process.exit(2);
}

/**
 * `config diff` reports **differences**, not state, and the distinction is the whole
 * correctness of this script.
 *
 * A key absent from `changes` means local and remote agree about it — not that remote
 * has nothing. This originally read `changes.find(...)?.remote ?? []`, which turned
 * "they agree" into "the allow-list is empty" and would have reported a correctly
 * configured project as every-callback-MISSING and exited 1. Today the key is always
 * reported because `supabase/config.toml` declares no `[auth]` block and the CLI's
 * default differs from production — but that is a fact about the config file, and adding
 * the URLs to it would have silently inverted this check.
 *
 * So an absent key is `undefined` and is reported as *unknown*, exiting 2. Same rule
 * `check-auth-config.mjs` follows: never exit 0 — or 1 — on a check that did not happen.
 */
const change = (path) => remote.changes?.find((c) => c.path.join('.') === path);

const allowedChange = change('auth.additional_redirect_urls');
const siteUrl = change('auth.site_url')?.remote ?? '(not reported)';

if (!allowedChange) {
  console.error(
    '\nCould not determine the redirect allow-list: `config diff` reported no difference\n' +
      'for auth.additional_redirect_urls, which means local and remote agree rather than\n' +
      'that remote is empty. This script reads a diff and cannot tell those apart, so it\n' +
      'is refusing to guess. Read it directly at:\n\n' +
      `  https://supabase.com/dashboard/project/${ref}/auth/url-configuration\n`,
  );
  process.exit(2);
}

const allowed = Array.isArray(allowedChange.remote) ? allowedChange.remote : [];

console.log(`  site_url (the silent fallback)      ${siteUrl}`);
console.log(`  redirect URLs registered            ${allowed.length}\n`);

/**
 * GoTrue matches with globs, so `bingd://**` covers `bingd://auth/callback`.
 *
 * One pass with a callback rather than a sentinel round trip. The sentinel version used
 * a raw NUL as the placeholder for `**`, which made git class this file as **binary** —
 * `Bin 0 -> 6594 bytes` in its own first diff — so it could never be reviewed or diffed
 * again. Caught by an independent review; there is no sentinel here to get wrong.
 */
const covers = (pattern, url) => {
  const expr = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*|\*/g, (m) => (m === '**' ? '.*' : '[^/]*'));
  return new RegExp(`^${expr}$`).test(url);
};

/**
 * Expo Go's callback is checked too, and it was not in the first version of this.
 *
 * `resolveOAuthRedirect` trusts and sends `createURL`'s answer when
 * `executionEnvironment` is `storeClient`, which is Expo Go — and `expo-linking`
 * resolves the scheme to `exp` there, so the value really is
 * `exp://<host>/--/auth/callback`. That callback is registered in Supabase, but nothing
 * checked it: the script derived its list from the three `bundleId`/`scheme` variants in
 * `app.config.ts`, none of which describes Expo Go. So a developer could hit exactly the
 * strand-on-bingd.app failure this whole change exists to prevent while this printed
 * "Every variant callback is registered" and exited 0. An independent review caught it.
 *
 * The host is unknowable — it is whatever machine is running the dev server — so the
 * probe is a representative address, and what it is really asking is whether a wildcard
 * `exp:` pattern is present at all.
 */
const CALLBACKS = [
  ...unique.map((scheme) => ({ label: `${scheme}://auth/callback`, probe: `${scheme}://auth/callback` })),
  {
    label: 'exp://<dev-server>/--/auth/callback  (Expo Go)',
    probe: 'exp://192.168.1.5:8081/--/auth/callback',
  },
];

const problems = [];
for (const { label, probe } of CALLBACKS) {
  const by = allowed.filter((p) => covers(p, probe));
  if (by.length === 0) {
    problems.push(label);
    console.log(`  MISSING  ${label}`);
  } else {
    console.log(`  ok       ${label}  (matched by ${by.join(', ')})`);
  }
}

if (problems.length > 0) {
  console.error(
    `\nRefusing: ${problems.length} callback(s) are not registered. Google sign-in will\n` +
      `NOT fail for them — GoTrue will substitute ${siteUrl} and the user will finish\n` +
      `authentication on the website with no session. Add them at:\n\n` +
      `  https://supabase.com/dashboard/project/${ref}/auth/url-configuration\n`,
  );
  process.exit(1);
}

console.log('\nEvery variant callback is registered.');
