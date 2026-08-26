/**
 * Push-drain acceptance, against a deployed project.
 *
 *   node supabase/tests/push-drain-acceptance.mjs            # health only, read-only
 *   node supabase/tests/push-drain-acceptance.mjs --probe    # also enqueues one real push
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * On 2026-08-26 the drain was dead for twenty hours and every observable said otherwise:
 * `bingd-push-drain` had 1,221 consecutive `succeeded` runs, `push_drain_status()`
 * reported an active job and a configured base URL, and `net._http_response` was empty
 * because `vault.secrets` had never held anything. The one input that was missing was the
 * one input nothing checked.
 *
 * `push-drain.test.mjs` is the half of the fix that runs in CI, in PGlite, with no Vault
 * and no cron. This is the other half: the same question asked of a real project, where
 * the extensions exist and the secret either does or does not.
 *
 * ---------------------------------------------------------------------------
 * IT IS NOT AN npm SCRIPT, DELIBERATELY
 *
 * `package.json`'s `scripts` block is an `@expo/fingerprint` input, so adding a line to it
 * moves every lane's runtime version and strands the published friend beta on a build that
 * stops receiving over-the-air updates. Spelled out as a path here and in
 * `docs/release/push-operations.md`, the same way push-sender's deno commands are spelled
 * out inline in CI.
 *
 * ---------------------------------------------------------------------------
 * NO SECRET IS READ, PRINTED, OR COMPARED
 *
 * The service-role key is used as a bearer token to call one `service_role`-only RPC and
 * is never logged. What comes back about the Vault is a boolean.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadEnv(file) {
  const out = {};
  try {
    for (const line of readFileSync(join(root, file), 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* absent is the same as empty here */
  }
  return out;
}

const env = { ...loadEnv('.env'), ...loadEnv('.env.local'), ...process.env };
const url = env.SUPABASE_URL || env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const probe = process.argv.includes('--probe');

if (!url || !serviceKey) {
  console.error(
    'Needs SUPABASE_URL (or EXPO_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.\n' +
      'They live in .env / .env.local, which are git-ignored. Nothing here may be committed.',
  );
  process.exitCode = 2;
  throw new Error('missing credentials');
}

let failures = 0;
const report = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const rpc = async (name, args = {}, token = serviceKey) => {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: token,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

console.log(`\npush drain acceptance — ${new URL(url).host}\n`);

// ---------------------------------------------------------------------------
// 1. The health readout
// ---------------------------------------------------------------------------

const status = await rpc('push_drain_status');
if (status.status !== 200 || !status.body || typeof status.body !== 'object') {
  report('push_drain_status() answers', false, `${status.status} ${JSON.stringify(status.body)}`);
  process.exitCode = 1;
  throw new Error('push_drain_status() did not answer');
}
const s = status.body;
report('push_drain_status() answers', true, `environment=${s.environment}`);

/**
 * The fields `20260826000700` added. Their **absence** is a failure rather than a skip:
 * an acceptance script that quietly downgraded to the old, weaker check on a project that
 * has not had the migration applied is precisely the shape of the bug being fixed.
 */
const hasNewShape =
  'healthy' in s &&
  'vault_secret_set' in s &&
  'problems' in s &&
  'vault_available' in s &&
  // Review 46c: without this, a project running an earlier build of the status function
  // satisfied the gate and then passed an acceptance run that never asked about the
  // transport at all.
  'pg_net_available' in s;
report(
  'the project has 20260826000700 (healthy / vault_secret_set / problems)',
  hasNewShape,
  hasNewShape ? '' : 'apply the migration before trusting any answer below',
);

report('scheduler is installed and active', Boolean(s.job?.active), JSON.stringify(s.job));
report('functions.base_url is set', s.base_url_set === true);

if (hasNewShape) {
  // The transport. `_drain_push_outbox()` ends in `net.http_post`, so a project with
  // pg_net disabled cannot send whatever else is in place — review 46c.
  report('pg_net can be called by the drain', s.pg_net_available === true);
  report('the Vault extension is available', s.vault_available === true);
  // Boolean only. Never a length, never a prefix: both are fingerprints of which key it is.
  report('the Vault holds service_role_key', s.vault_secret_set === true);
  report(
    'nothing is stalled in the outbox',
    Number(s.older_than_15m) === 0,
    `older_than_15m=${s.older_than_15m}, queued=${s.queued}`,
  );
  // A job that has never run has demonstrated nothing, so `null` is a failure here and not
  // a pass — review 46. On a project where the job was scheduled seconds ago, wait a minute
  // and run this again; `bootstrap-production.mjs` is the only caller that gets to treat
  // this as a note, because it is the only one that knows it just installed the job.
  report(
    'the last scheduled run succeeded',
    Boolean(s.last_run) && s.last_run.status === 'succeeded',
    s.last_run ? JSON.stringify(s.last_run) : 'no run recorded — the job has never executed',
  );
  report(
    'healthy',
    s.healthy === true,
    s.healthy === true ? '' : `problems: ${JSON.stringify(s.problems)}`,
  );
}

// ---------------------------------------------------------------------------
// 2. The end-to-end probe, which is the only thing that proves delivery
//
// Health is a statement about configuration. This is a statement about behaviour: one real
// notification, and nobody but the scheduler touches it.
// ---------------------------------------------------------------------------

if (probe) {
  if (!anonKey) {
    report('--probe needs EXPO_PUBLIC_SUPABASE_ANON_KEY', false);
  } else {
    const uuid = () => crypto.randomUUID();
    const stamp = Date.now().toString(36).slice(-6);
    const madeUsers = [];
    const accounts = [];

    const svcGet = async (path) => {
      const res = await fetch(`${url}/rest/v1/${path}`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      return JSON.parse(await res.text());
    };

    const createAccount = async (label) => {
      const email = `bingd_drainprobe_${label}_${stamp}@example.com`;
      const password = `Probe-${uuid()}`;
      const made = await fetch(`${url}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      if (!made.ok) throw new Error(`create ${label}: ${made.status}`);
      const user = await made.json();
      madeUsers.push(user.id);
      const session = await fetch(`${url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const { access_token: token } = await session.json();
      const username = `drainprobe_${label}_${stamp}`.slice(0, 24);
      const profile = await rpc(
        'create_profile',
        { p_username: username, p_display_name: `Probe ${label}`, p_date_of_birth: '1990-01-01' },
        token,
      );
      if (profile.body?.ok !== true) throw new Error(`profile ${label}: ${profile.status}`);
      const account = { id: user.id, token, username };
      accounts.push(account);
      return account;
    };

    try {
      const from = await createAccount('x');
      const to = await createAccount('y');

      // A syntactically valid token that Expo will reject. Delivery is not what is being
      // proved — the claim is — and a fake token keeps this off anybody's real phone.
      const registered = await rpc(
        'register_device_token',
        {
          p_operation_id: uuid(),
          p_token: `ExponentPushToken[drainprobe_${stamp}_notreal]`,
          p_platform: 'android',
        },
        to.token,
      );
      report('a device can register', registered.status === 200, `${registered.status}`);

      await rpc('follow', { p_operation_id: uuid(), p_followee_id: to.id }, from.token);

      const outbox = () =>
        svcGet(`push_outbox?recipient_id=eq.${to.id}&select=notification_id,state,attempts`);
      const enqueued = await outbox();
      report('the notification enqueued a push', enqueued.length === 1, JSON.stringify(enqueued));

      // Up to ~2.5 minutes: the schedule is once a minute and the first tick may be seconds
      // away or fifty-nine. Nothing in this block ever calls push-sender.
      const started = Date.now();
      let drained = false;
      while (Date.now() - started < 150_000) {
        await new Promise((r) => setTimeout(r, 10_000));
        const rows = await outbox();
        if (rows.length === 0 || rows[0].state !== 'pending' || rows[0].attempts > 0) {
          drained = true;
          break;
        }
      }
      report(
        'the scheduler claimed and processed the row on its own',
        drained,
        drained ? `${Math.round((Date.now() - started) / 1000)}s` : 'still pending after 150s',
      );
    } catch (e) {
      report('probe ran', false, String(e.message ?? e));
    } finally {
      for (const account of accounts) {
        await rpc('delete_account', { p_confirmation: account.username }, account.token);
      }
      for (const id of madeUsers) {
        await fetch(`${url}/auth/v1/admin/users/${id}`, {
          method: 'DELETE',
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        });
      }
      const left = await (
        await fetch(`${url}/rest/v1/profiles?select=id&username=like.drainprobe_*`, {
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        })
      ).json();
      report('probe data cleaned up', Array.isArray(left) && left.length === 0);
    }
  }
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} failure(s)`}\n`);
// exitCode rather than exit(): a hard exit while fetch keeps sockets open aborts the
// process on Windows with a libuv assertion, which turns a one-failure run into exit 127
// and makes a gate unreadable.
process.exitCode = failures === 0 ? 0 : 1;
