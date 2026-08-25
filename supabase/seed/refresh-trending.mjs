/**
 * Refreshes the four `provider_list_cache` trending lists through the adapter.
 *
 *   npm run trending:refresh
 *
 * The Feed's Trending shelf reads that table directly and never calls TMDB, which is
 * what keeps a tab switch off the provider quota (api.md §`tmdb-adapter`). The cost of
 * that split is that something has to fill the table, and until Bingd has a scheduler
 * that something is this command — the same position `catalogue:enrich` occupies for
 * enrichment, and it borrows that script's shape deliberately.
 *
 * The TTL is six hours, so a shelf that has not been refreshed within the day is
 * stale-but-shown, and one not refreshed within the week disappears
 * (`src/features/trending/trending.ts`). Running this on a cron on the operator's side
 * is the intended arrangement; running it by hand before looking at a build is the
 * current one.
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local, which is
 * git-ignored. `trending` is a service_role action for the reason enrich and refresh
 * are: it spends four provider requests and eighty upserts per call.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { supabaseProjectRef } = require('../../config/backends.cjs');
const { environmentForRef } = require('../../config/production-lane.cjs');

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Minimal .env reader, matching `backfill-tmdb.mjs`. */
async function loadEnvFile(name) {
  let text;
  try {
    text = await readFile(join(root, name), 'utf8');
  } catch {
    return;
  }

  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key]) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, '').trim();
  }
}

async function main() {
  await loadEnvFile('.env.local');
  await loadEnvFile('.env');

  const url = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error(
      'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (in .env.local, which is git-ignored).',
    );
    process.exit(1);
  }

  /**
   * Which project this is about to spend a service-role key on.
   *
   * Added when this became a scheduled job. By hand it was a founder typing a URL they had
   * just looked at; on a schedule it is two secrets in a settings page, and the failure that
   * matters is not a typo — it is the **production** secret paired with the **nonprod** URL,
   * which refreshes the wrong project's shelf every night and looks like a green run.
   *
   * The guard is on the parsed host rather than on the string, for the reason
   * `two-user-acceptance.mjs` records: `url.includes(ref)` says yes to
   * `https://<ref>.example.com`, and the next thing that happens is a service-role key
   * arriving at a hostname anybody can register.
   */
  const ref = supabaseProjectRef(url);
  const environment = ref === null ? null : environmentForRef(ref);

  if (environment === null) {
    console.error(
      `Refusing: ${url} is not a Supabase project this repository declares.\n` +
        '  REF_ENVIRONMENTS in config/production-lane.cjs is the list of projects that may\n' +
        '  receive a service-role key.',
    );
    process.exit(1);
  }

  // Optional, because `npm run trending:refresh` by hand has always been one argument-free
  // command and there is no reason to break that. The scheduled workflow always passes it,
  // which is where the mistake it catches actually happens.
  const wanted = process.argv.includes('--target')
    ? process.argv[process.argv.indexOf('--target') + 1]
    : null;

  if (wanted !== null) {
    const expected = wanted === 'production' ? 'prod' : wanted === 'nonprod' ? 'nonprod' : null;
    if (expected === null) {
      console.error(`--target must be production or nonprod, not "${wanted}".`);
      process.exit(1);
    }
    if (expected !== environment) {
      console.error(
        `Refusing: --target ${wanted} means the ${expected} database, and ${ref} is declared ` +
          `${environment}. The URL and the key in this run do not describe the same project.`,
      );
      process.exit(1);
    }
  }

  console.log(`Refreshing trending on ${ref} (${environment})`);

  const response = await fetch(new URL('/functions/v1/tmdb-adapter', url), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'trending' }),
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    console.error(`HTTP ${response.status}:`, body?.error?.message ?? '(no body)');
    process.exit(1);
  }

  for (const [listKey, count] of Object.entries(body.written ?? {})) {
    console.log(`${listKey}: ${count} titles`);
  }

  // A list that failed keeps its previous payload, so this is a warning rather than a
  // failure — three fresh lists and one stale one is the outcome the adapter chose on
  // purpose. It is still worth exiting non-zero so a cron notices.
  if (body.failed?.length) {
    console.error(`\nfailed: ${body.failed.join(', ')}`);
    process.exit(1);
  }

  console.log('\nAll four lists refreshed.');
}

await main();
