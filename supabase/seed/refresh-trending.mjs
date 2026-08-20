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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
