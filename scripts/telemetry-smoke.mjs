#!/usr/bin/env node
/**
 * One controlled event to PostHog and one controlled error to Sentry, from the command
 * line, against the credentials in `.env`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN A BUTTON IN THE APP
 *
 * "Installed" is not "verified". A DSN in a config file, an SDK in `package.json` and a
 * green build tell you nothing about whether an event reaches a project you can open —
 * a revoked key, a wrong host, a project deleted last month and a typo all look exactly
 * like a working integration from inside the app.
 *
 * The obvious way to check is a test button on a settings screen. That is the thing this
 * script exists instead of: a crash button ships, gets forgotten, and is then found by a
 * tester. Operator tooling has no such failure mode — it is not in the bundle, it cannot
 * be pressed by anybody who was not already at a terminal in this repository, and it can
 * refuse to run against production, which a screen inside the app cannot.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES AND DOES NOT PROVE
 *
 * It proves **the ingest endpoint accepted the payload**: the key is live, the host is
 * right, the project exists. It does **not** prove the event is visible in the project's
 * UI — both services accept over HTTP and process asynchronously, and neither the
 * PostHog project token nor the Sentry DSN can read anything back. That last step is a
 * human opening the dashboard, and this script prints where to look.
 *
 *   node scripts/telemetry-smoke.mjs
 *
 * Refuses to run when APP_VARIANT is production.
 */

import { readFileSync } from 'node:fs';

const RUN_ID = process.argv[2] ?? `smoke-${process.pid}`;

/**
 * Values are unquoted, because `.env` files are written both ways.
 *
 * `APP_VARIANT="production"` is ordinary dotenv syntax, and a naive reader compares the
 * string `"production"` — with the quotes — against `production`, decides they differ,
 * and cheerfully runs against the production project. Independent review 24 found exactly
 * that hole in the first version of this script.
 */
const unquote = (raw) => {
  const value = raw.trim();
  const quoted = /^(['"])(.*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
};

function readEnvFile(file) {
  let text;
  try {
    text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) out[match[1]] = unquote(match[2]);
  }
  return out;
}

const ENV_FILES = ['.env.local', '.env'];
const parsed = ENV_FILES.map(readEnvFile);

// Later files win for *values* — `.env` over `.env.local`, and the process environment over
// both — so a one-off run against another project does not need any file edited. It
// deliberately does **not** win for the safety check below.
const files = Object.assign({}, ...parsed);
const env = { ...files, ...process.env };

const VARIANTS = ['development', 'preview', 'production'];

/**
 * The refusal reads **every** label independently, before any of them is merged away.
 *
 * Merging first and checking afterwards is the hole independent review 24b found, and it
 * is a good one: `.env.local` can hold production credentials and `APP_VARIANT=production`
 * while `.env` says `development`, and the merge keeps only the second label — so the
 * script would send real events to the production project and call them development. The
 * same shape applies to a process-level `APP_VARIANT=development` over a production `.env`.
 *
 * So each source is asked on its own terms. **Any** of them naming production stops the
 * run, because a label and the keys beside it travel together and there is no reading of
 * "one file says production" that makes this safe to continue.
 */
const declared = [...parsed.map((file) => file.APP_VARIANT), process.env.APP_VARIANT].filter(
  Boolean,
);
const unknown = declared.filter((value) => !VARIANTS.includes(value));

if (unknown.length) {
  console.error(
    `Refusing to run: APP_VARIANT is ${unknown.map((v) => JSON.stringify(v)).join(' / ')}, which is not one of ${VARIANTS.join(', ')}. An unrecognised variant is a misconfiguration, not a default.`,
  );
  process.exit(2);
}

if (declared.includes('production')) {
  console.error(
    'Refusing to run: production is named by APP_VARIANT in the process environment, in .env or in .env.local. This writes real events; point it at a development or preview configuration.',
  );
  process.exit(2);
}

const variant = env.APP_VARIANT ?? 'development';

/** The same shape `src/lib/release.ts` attaches in the app, so the two are comparable. */
const release = {
  environment: variant,
  platform: 'node_smoke_test',
  app_version: '0.1.0',
  build_kind: 'operator_script',
};

async function posthog() {
  const key = env.EXPO_PUBLIC_POSTHOG_KEY;
  const host = env.EXPO_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';
  if (!key) return { service: 'PostHog', status: 'not configured (EXPO_PUBLIC_POSTHOG_KEY is empty)' };

  const response = await fetch(`${host.replace(/\/$/, '')}/i/v0/e/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      event: 'telemetry_smoke_test',
      // Deliberately not a real user id. This event must not attach itself to anybody's
      // account, and a per-run id keeps repeated checks distinguishable.
      distinct_id: `telemetry-smoke/${RUN_ID}`,
      properties: { ...release, run_id: RUN_ID },
      timestamp: new Date().toISOString(),
    }),
  });

  return {
    service: 'PostHog',
    status: `HTTP ${response.status}`,
    ok: response.ok,
    body: (await response.text()).slice(0, 200),
    lookFor: `event "telemetry_smoke_test", distinct_id "telemetry-smoke/${RUN_ID}" in Activity`,
  };
}

async function sentry() {
  const dsn = env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) return { service: 'Sentry', status: 'not configured (EXPO_PUBLIC_SENTRY_DSN is empty)' };

  // https://<publicKey>@<host>/<projectId>
  const url = new URL(dsn);
  const projectId = url.pathname.replace(/^\//, '');
  const publicKey = url.username;
  const endpoint = `${url.protocol}//${url.host}/api/${projectId}/store/`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sentry-auth': [
        'Sentry sentry_version=7',
        'sentry_client=bingd-telemetry-smoke/1.0',
        `sentry_key=${publicKey}`,
      ].join(', '),
    },
    body: JSON.stringify({
      // `error` rather than a crash: this is a handled, non-fatal report, which is what
      // an operator check should be. Nothing here is a real exception from the app.
      level: 'info',
      logger: 'telemetry-smoke',
      platform: 'node',
      environment: variant,
      message: { formatted: `Bingd telemetry smoke test (${RUN_ID})` },
      tags: { ...release, run_id: RUN_ID },
      timestamp: new Date().toISOString(),
    }),
  });

  return {
    service: 'Sentry',
    status: `HTTP ${response.status}`,
    ok: response.ok,
    body: (await response.text()).slice(0, 200),
    lookFor: `issue "Bingd telemetry smoke test (${RUN_ID})", environment "${variant}"`,
  };
}

const results = await Promise.all([posthog(), sentry()]);

for (const result of results) {
  console.log(`\n${result.service}: ${result.status}`);
  if (result.body) console.log(`  response: ${result.body}`);
  if (result.lookFor) console.log(`  now open the project and look for: ${result.lookFor}`);
}

console.log(
  '\nAccepted by the ingest endpoint is not the same as visible in the project. The line above is the check a human still has to make.',
);

/**
 * `exitCode` rather than `process.exit()`.
 *
 * `fetch` leaves a keep-alive socket open, and forcing the process down on top of one
 * trips a libuv assertion on Windows — which turns a successful check into exit 127 and
 * a scary line of C. Setting the code and letting the loop drain is the fix.
 */
process.exitCode = results.some((r) => r.ok === false) ? 1 : 0;
