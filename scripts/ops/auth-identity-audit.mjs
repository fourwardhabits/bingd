#!/usr/bin/env node
/**
 * Could one verified email end up with two bingd profiles? (founder, 2026-09-22)
 *
 *   node scripts/ops/auth-identity-audit.mjs --project-ref fjxhcbowoxuzulwirzyr
 *   node scripts/ops/auth-identity-audit.mjs --project-ref abheeqyjzekiowkztfxv   # production
 *
 * **Read-only.** It runs four SELECTs through `supabase db query` and writes nothing, so it
 * is safe against production and is the only way to answer this question there: Google is
 * enabled on production and NOT on staging, so the linking path cannot be exercised on
 * staging at all.
 *
 * What it reports, and why each number matters:
 *
 *   duplicate emails            two `auth.users` rows sharing an address. Supabase links a
 *                               new provider identity into the existing user when the
 *                               address is verified on both sides; a row here means that
 *                               did not happen and two accounts exist for one person.
 *   users with 2+ identities    the linking that DID happen. Zero means nobody has yet
 *                               signed in with both email and Google, so the mechanism is
 *                               unproven by data rather than known good.
 *   unconfirmed users           the risk population. An account whose email was never
 *                               confirmed is the one case where a later Google sign-in on
 *                               the same address may not link.
 *   profiles without a user     a profile whose account is gone: nothing should produce it.
 *
 * A non-zero duplicate-email or orphan count is a defect to investigate, not a threshold.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const at = args.indexOf('--project-ref');
const ref = at >= 0 ? args[at + 1] : null;
if (!ref) {
  console.error('Usage: auth-identity-audit.mjs --project-ref <ref>');
  process.exit(2);
}

const SQL = `
select environment_name() as env,
       (select count(*) from auth.users) as users,
       (select count(*) from profiles) as profiles,
       (select count(*) from (select lower(email) e from auth.users where email is not null
                               group by 1 having count(*) > 1) d) as duplicate_emails,
       (select count(*) from (select user_id from auth.identities group by 1 having count(*) > 1) m)
         as users_with_multiple_identities,
       (select count(*) from auth.users where email_confirmed_at is null) as unconfirmed_users,
       (select count(*) from profiles p where not exists
          (select 1 from auth.users u where u.id = p.id)) as profiles_without_a_user;
`;

// `db query` only takes --linked, so the ref is bound by linking a scratch directory. It
// writes nothing but its own .temp, and never a password.
const dir = mkdtempSync(join(tmpdir(), 'bingd-auth-audit-'));
writeFileSync(join(dir, 'audit.sql'), SQL);
const cli = (...rest) =>
  execFileSync('npx', ['supabase@latest', ...rest], { encoding: 'utf8', shell: true });

cli('link', '--project-ref', ref, '--workdir', dir);
const out = cli('db', 'query', '--linked', '--workdir', dir, '-f', join(dir, 'audit.sql'));
const row = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)).rows[0];

console.log(`\nauth identity audit — ${row.env} (${ref})\n`);
for (const [key, value] of Object.entries(row)) {
  if (key === 'env') continue;
  console.log(`  ${key.replace(/_/g, ' ').padEnd(32)} ${value}`);
}
const bad = Number(row.duplicate_emails) + Number(row.profiles_without_a_user);
console.log(
  bad === 0
    ? '\nNo split accounts: every address maps to one user, and every profile has one.\n'
    : '\nSPLIT ACCOUNTS PRESENT — investigate before touching identity settings.\n',
);
process.exit(bad === 0 ? 0 : 1);
