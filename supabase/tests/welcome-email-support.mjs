import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What the welcome-email suites need beyond the shared harness.
 *
 * Until the automation is switched on, the welcome SQL lives at
 * `emails/welcome/automation/welcome_email.sql`, outside `supabase/migrations/`, so no
 * `db push` can pick it up and neither harness applies it. The suites apply it on top of
 * every real migration, which proves it against the schema it will be applied to.
 *
 * The activation commit moves it into `supabase/migrations/` under a timestamp whose name
 * ends `_a_welcome_note_sent_once.sql`. From then on the harnesses apply it themselves,
 * `welcomeSqlToApply()` returns nothing, and every suite keeps passing without an edit.
 */

const here = dirname(fileURLToPath(import.meta.url));
const staged = join(here, '..', '..', 'emails', 'welcome', 'automation', 'welcome_email.sql');
const migrations = join(here, '..', 'migrations');

const exists = (path) => access(path).then(() => true, () => false);

/** Where the SQL is today, and whether it is already a migration. */
async function locate() {
  if (await exists(staged)) return { path: staged, migrated: false };
  const file = (await readdir(migrations)).find((f) => f.endsWith('_a_welcome_note_sent_once.sql'));
  if (!file) throw new Error('welcome_email.sql is neither staged in emails/welcome/automation nor in supabase/migrations');
  return { path: join(migrations, file), migrated: true };
}

/** The SQL text, wherever it lives. For tests that read the source itself. */
export const welcomeSource = async () => readFile((await locate()).path, 'utf8');

/** The SQL a suite must apply: all of it while staged, nothing once it is a migration. */
export const welcomeSqlToApply = async () => {
  const { path, migrated } = await locate();
  return migrated ? '' : readFile(path, 'utf8');
};

/**
 * The GoTrue columns the claim reads, which both harnesses' one-column `auth.users` shim
 * lacks. Names and types as Supabase Auth defines them; no migration in this repository
 * had read them before. `if not exists`, so a harness that later grows them is unaffected.
 */
export const AUTH_COLUMNS_SQL = `
  alter table auth.users
    add column if not exists email              varchar(255),
    add column if not exists email_confirmed_at timestamptz,
    add column if not exists banned_until       timestamptz,
    add column if not exists deleted_at         timestamptz,
    add column if not exists is_anonymous       boolean not null default false;
`;

/** Opens the cohort window: delivery on, and the cutoff a week back. */
export const OPEN_COHORT_SQL = `
  update app_config set value = 'true'::jsonb where key = 'welcome.delivery_enabled';
  update app_config set value = to_jsonb((now() - interval '7 days')::text) where key = 'welcome.start_after';
`;
