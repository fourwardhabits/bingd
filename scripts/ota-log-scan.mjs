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

/**
 * Every job in a run, as lines safe to print, and whether all of them were read and clean.
 *
 * **A failure prints a fixed sentence and never the error.** `execFileSync` puts captured
 * stdout on what it throws, and stdout here is the log, so an uncaught failure would print the
 * very thing this file exists to keep off a screen. An empty log is a failure too: nothing was
 * read, which is not the same as clean.
 */
export function scanRun(run, eas) {
  const lines = [];
  let ok = true;
  let jobs;
  try {
    ({ jobs } = JSON.parse(eas('workflow:view', run, '--json')));
  } catch {
    return { lines: ['Could not read the run. No log was scanned.'], ok: false };
  }
  for (const job of jobs) {
    let log = '';
    try {
      log = eas('workflow:logs', job.id, '--all-steps');
    } catch {
      log = '';
    }
    if (!log.trim()) {
      ok = false;
      lines.push(`${job.key}: NOT SCANNED, no log could be read`);
      continue;
    }
    const found = scan(log);
    const dirty = Object.keys(found).length > 0;
    ok &&= !dirty;
    lines.push(`${job.key}: ${dirty ? JSON.stringify(found) : 'clean'}`);
  }
  return { lines, ok };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [run] = process.argv.slice(2);
  if (!/^[0-9a-f-]{36}$/.test(run ?? '')) {
    console.error('usage: node scripts/ota-log-scan.mjs <workflow run id>');
    process.exit(2);
  }
  const { lines, ok } = scanRun(run, (...args) =>
    execFileSync('eas', args, {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
  for (const line of lines) console.log(line);
  if (!ok) {
    console.error('Not clean. Do not read these logs. Treat what they name as exposed.');
    process.exit(1);
  }
}
