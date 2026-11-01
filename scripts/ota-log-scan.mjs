#!/usr/bin/env node
/**
 * Whether an EAS workflow run's logs hold anything that looks like a secret.
 *
 *   node scripts/ota-log-scan.mjs <workflow run id>
 *
 * **It prints names and counts, never a matching line.** Reading these logs with a grep put
 * the start of a live SENTRY_AUTH_TOKEN into an agent session on 2026-11-01, because the
 * variable was plain text in EAS and EAS prints plain text variables at the top of every job.
 *
 * The EXPO_PUBLIC_* values are in the bundle by design, so they are not looked for.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const VALUES = {
  'Sentry token': /sntrys_/g,
  'Google API key': /AIza[0-9A-Za-z_-]{20,}/g,
  'google-services.json contents': /mobilesdk_app_id|oauth_client/g,
  'private key': /PRIVATE KEY/g,
  'Supabase secret key': /sb_secret_|service_role/g,
};

/** EAS lists a job's variables as NAME=value, and writes ******** for a secret one. */
const UNMASKED = /\b(SENTRY_AUTH_TOKEN|EXPO_TOKEN)=(?!\*+\s*$)\S/gm;

/** Names and counts only. Nothing here can carry a value out of the log. */
export function scan(text) {
  const found = {};
  for (const [name, pattern] of Object.entries(VALUES)) {
    const count = text.match(pattern)?.length ?? 0;
    if (count) found[name] = count;
  }
  const unmasked = text.match(UNMASKED)?.length ?? 0;
  if (unmasked) found['unmasked token variable'] = unmasked;
  return found;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [run] = process.argv.slice(2);
  if (!run) {
    console.error('usage: node scripts/ota-log-scan.mjs <workflow run id>');
    process.exit(2);
  }
  const eas = (...args) =>
    execFileSync('eas', args, {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

  const { jobs } = JSON.parse(eas('workflow:view', run, '--json'));
  let dirty = false;
  for (const job of jobs) {
    const found = scan(eas('workflow:logs', job.id, '--all-steps'));
    const names = Object.keys(found);
    dirty ||= names.length > 0;
    console.log(`${job.key}: ${names.length ? JSON.stringify(found) : 'clean'}`);
  }
  if (dirty) {
    console.error('\nDo not read these logs. Treat what they name as exposed.');
    process.exit(1);
  }
}
