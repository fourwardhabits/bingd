/**
 * Fills the seed catalogue in from TMDB, by draining `tmdb_enrich_due` through the
 * adapter one batch at a time.
 *
 * The Wikidata seed is ~570 films and series with correct titles, correct years and
 * no artwork whatsoever, which makes every screen in the app impossible to judge.
 * This is what turns it into something that looks like the product.
 *
 * It calls the deployed Edge Function rather than TMDB. That is not indirection for
 * its own sake: AD-8 makes the adapter the sole holder of the key, and a maintenance
 * script with its own copy of the credential would be a second holder, on a laptop,
 * outside the deployment that rotates it.
 *
 *   npm run catalogue:enrich            # posters, overviews, credits, seasons
 *   npm run catalogue:enrich -- --refresh   # re-fetch rows past the retention window
 *   npm run catalogue:enrich -- --limit 25 --batches 4
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Put them in .env.local, which is
 * git-ignored — deliberately not .env, which holds only values that are safe in a
 * client bundle and is copied from a committed example.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Minimal .env reader. Not worth a dependency for two keys read by one script. */
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

function parseArgs(argv) {
  const options = { action: 'enrich', limit: 50, batches: Infinity };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--refresh') options.action = 'refresh';
    else if (arg === '--limit') options.limit = Number(argv[++i]);
    else if (arg === '--batches') options.batches = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error('--limit must be between 1 and 100');
  }
  return options;
}

async function main() {
  await loadEnvFile('.env.local');
  await loadEnvFile('.env');

  const url = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error(
      'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (in .env.local, which is git-ignored).\n' +
        'The service role key is in the Supabase dashboard under Project Settings > API.',
    );
    process.exit(1);
  }

  const options = parseArgs(process.argv.slice(2));
  const endpoint = new URL('/functions/v1/tmdb-adapter', url);

  console.log(`${options.action} against ${url}, ${options.limit} per batch\n`);

  const started = Date.now();
  let batches = 0;
  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  while (batches < options.batches) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: options.action, limit: options.limit }),
    });

    const body = await response.json().catch(() => null);

    if (!response.ok) {
      console.error(`\nHTTP ${response.status}:`, body?.error?.message ?? '(no body)');
      process.exit(1);
    }

    batches += 1;
    enriched += body.enriched ?? 0;
    skipped += body.skipped ?? 0;
    failed += body.failures?.length ?? 0;

    const remaining = body.remaining;
    console.log(
      `batch ${batches}: ${body.enriched} enriched, ${body.skipped} skipped, ` +
        `${body.failures?.length ?? 0} failed` +
        (remaining === undefined ? '' : ` — ${remaining} to go`),
    );

    for (const failure of (body.failures ?? []).slice(0, 3)) {
      console.log(`    ${failure.id}: ${failure.error}`);
    }

    // Nothing was offered, so the view is empty and another round would ask again.
    if (!body.attempted) break;

    // Every row in the batch failed. Continuing would walk the whole backlog
    // producing the same error, which is worth stopping on rather than logging
    // six hundred times — an expired key looks exactly like this.
    if (body.attempted > 0 && body.enriched === 0 && body.skipped === 0) {
      console.error('\nEvery row in this batch failed. Stopping.');
      process.exit(1);
    }
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\n${enriched} enriched, ${skipped} skipped, ${failed} failed in ${batches} batches (${seconds}s)`,
  );
}

await main();
