/**
 * End to end against a **local** Supabase stack: the real migration on real Postgres,
 * real PostgREST, real GoTrue, and the stack's Mailpit catching every email. The handler
 * runs in-process with its real adapters, so everything except `Deno.serve` is the code
 * that would deploy.
 *
 * Skipped unless USERNAME_SIGN_IN_LOCAL_STACK=1, and refuses outright to run against any
 * host but localhost — it creates users and reads their mail. Keys come from the
 * environment only (`supabase status -o env`); nothing is committed.
 *
 *   npx supabase start                       # local stack, from a checkout
 *   eval "$(npx supabase status -o env | sed 's/^/export /')"
 *   USERNAME_SIGN_IN_LOCAL_STACK=1 SUPABASE_URL=$API_URL SUPABASE_ANON_KEY=$ANON_KEY \
 *     SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY MAILPIT_URL=$MAILPIT_URL \
 *     npx deno test --config supabase/functions/username-sign-in/deno.json \
 *       --allow-net --allow-env --allow-read supabase/functions/username-sign-in
 *
 * The local email templates must carry `{{ .Token }}` (the CLI's default magic-link
 * template does not): point `[auth.email.template.magic_link]` at
 * supabase/auth-templates/magic-link.html in the stack's config. See the design doc §8.
 */

import { assert, assertEquals, assertMatch } from '@std/assert';
import { createClient } from '@supabase/supabase-js';

import { goTrueAuth, sqlStore } from './adapters.ts';
import { createHandler, type LogEvent } from './handler.ts';
import { COPY, TIMING } from './limits.ts';

const env = (k: string) => Deno.env.get(k) ?? '';
const enabled = env('USERNAME_SIGN_IN_LOCAL_STACK') === '1';

const URL_ = env('SUPABASE_URL');
const MAILPIT = env('MAILPIT_URL') || 'http://127.0.0.1:54324';

if (enabled) {
  for (const u of [URL_, MAILPIT]) {
    const host = new URL(u).hostname;
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new Error(`local-stack.test.ts refuses to run against ${host}: local stack only`);
    }
  }
}

const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const admin = enabled ? createClient(URL_, env('SUPABASE_SERVICE_ROLE_KEY'), opts) : (null as never);
const anon = enabled ? createClient(URL_, env('SUPABASE_ANON_KEY'), opts) : (null as never);

const HASH_KEY = crypto.randomUUID() + crypto.randomUUID();
const logs: string[] = [];
const background: Promise<unknown>[] = [];

function makeHandler(timing = { sendFloorMs: 150, verifyFloorMs: 150, jitterMs: 0 }) {
  return createHandler({
    store: sqlStore(admin),
    auth: goTrueAuth(anon.auth, admin.auth.admin),
    hashKey: HASH_KEY,
    log: (e: LogEvent) => logs.push(JSON.stringify(e)),
    waitUntil: (p) => {
      background.push(p);
    },
    now: () => performance.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    random: () => Math.random(),
    timing,
  });
}

const run = Math.random().toString(36).slice(2, 8);
let n = 0;
const uniq = (p: string) => `${p}_${run}_${++n}`.slice(0, 24);
const ipSeq = () => `198.51.100.${(++n % 250) + 1}`;

/** Everything personal a test touched, for the final log sweep. */
const touched: string[] = [];

async function makeAccount(opts: { username?: string; email?: string; confirmed?: boolean; ban?: string } = {}) {
  const username = opts.username ?? uniq('u');
  const email = opts.email ?? `${username}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: opts.confirmed ?? true,
    ...(opts.ban ? { ban_duration: opts.ban } : {}),
  });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  const { error: pe } = await admin.from('profiles').insert({ id: data.user.id, username, display_name: username });
  if (pe) throw new Error(`profile: ${pe.message}`);
  touched.push(username, email, data.user.id);
  return { id: data.user.id, username, email };
}

async function mailTo(email: string): Promise<Array<{ ID: string }>> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
  return (await res.json()).messages ?? [];
}

async function mailCount(): Promise<number> {
  return (await (await fetch(`${MAILPIT}/api/v1/messages?limit=1`)).json()).total;
}

async function codeFor(email: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const msgs = await mailTo(email);
    if (msgs.length) {
      const m = await (await fetch(`${MAILPIT}/api/v1/message/${msgs[0].ID}`)).json();
      const code = /\b(\d{6})\b/.exec(m.Text ?? '')?.[1];
      if (code) {
        touched.push(code);
        return code;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no code arrived');
}

const settle = async () => {
  await Promise.all(background.splice(0));
  await new Promise((r) => setTimeout(r, 400)); // SMTP to Mailpit
};

const req = (body: unknown, ip = ipSeq()) =>
  new Request('http://local/username-sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });

async function send(handler: (r: Request) => Promise<Response>, identifier: string, ip?: string) {
  const res = await handler(req({ action: 'send', identifier }, ip));
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(Object.keys(body).sort(), ['challengeId', 'message']);
  assertEquals(body.message, COPY.sent);
  touched.push(body.challengeId);
  return body.challengeId as string;
}

async function verify(handler: (r: Request) => Promise<Response>, challengeId: string, code: string) {
  const res = await handler(req({ action: 'verify', challengeId, code }));
  return { status: res.status, body: await res.json() };
}

const INVALID = { status: 400, body: { error: 'invalid_code', message: COPY.invalid } };

const t = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name: `local stack: ${name}`, ignore: !enabled, sanitizeOps: false, sanitizeResources: false, fn });

t('a username signs in: code to the account email, session for the account', async () => {
  const h = makeHandler();
  const a = await makeAccount();
  const challengeId = await send(h, `  ${a.username.toUpperCase()} `);
  await settle();
  const code = await codeFor(a.email);
  const r = await verify(h, challengeId, code);
  assertEquals(r.status, 200);
  assertEquals(Object.keys(r.body), ['session']);
  assert(!JSON.stringify(r.body).includes(a.email), 'the response carries no address');
  const { data } = await anon.auth.getUser(r.body.session.access_token);
  assertEquals(data.user?.id, a.id);
  touched.push(r.body.session.access_token, r.body.session.refresh_token);
});

t('an unknown username: same answer, no email anywhere, no account created', async () => {
  const h = makeHandler();
  const before = await mailCount();
  const { data: u0 } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const name = uniq('nobody');
  touched.push(name);
  const challengeId = await send(h, name);
  await settle();
  assertEquals(await mailCount(), before, 'an unknown name sent mail');
  const { data: u1 } = await admin.auth.admin.listUsers({ perPage: 1000 });
  assertEquals(u1.users.length, u0.users.length, 'an unknown name created an account');
  assertEquals(await verify(h, challengeId, '123456'), INVALID, 'a decoy verified');
});

t('unconfirmed and banned accounts: same answer, no email', async () => {
  const h = makeHandler();
  const unconfirmed = await makeAccount({ confirmed: false });
  const banned = await makeAccount({ ban: '24h' });
  for (const a of [unconfirmed, banned]) await send(h, a.username);
  await settle();
  assertEquals((await mailTo(unconfirmed.email)).length, 0);
  assertEquals((await mailTo(banned.email)).length, 0);
});

t('a renamed account: the old name is dead, the new one works', async () => {
  const h = makeHandler();
  const a = await makeAccount();
  const renamed = uniq('renamed');
  touched.push(renamed);
  const { error } = await admin.from('profiles').update({ username: renamed }).eq('id', a.id);
  assert(!error, error?.message);
  await send(h, a.username);
  await settle();
  assertEquals((await mailTo(a.email)).length, 0, 'the released name sent a code');
  const challengeId = await send(h, renamed);
  await settle();
  assertEquals((await verify(h, challengeId, await codeFor(a.email))).status, 200);
});

t('an Apple private-relay account receives its code at the relay address', async () => {
  const h = makeHandler();
  const username = uniq('relay');
  const a = await makeAccount({ username, email: `${username}.x9@privaterelay.appleid.com` });
  const challengeId = await send(h, a.username);
  await settle();
  assertEquals((await verify(h, challengeId, await codeFor(a.email))).status, 200);
});

t('five wrong codes lock the challenge; the right code then fails too', async () => {
  const h = makeHandler();
  const a = await makeAccount();
  const challengeId = await send(h, a.username);
  await settle();
  const code = await codeFor(a.email);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assertEquals(await verify(h, challengeId, wrong), INVALID);
  assertEquals(await verify(h, challengeId, code), INVALID, 'locked');
});

t('a challenge is single use', async () => {
  const h = makeHandler();
  const a = await makeAccount();
  const challengeId = await send(h, a.username);
  await settle();
  const code = await codeFor(a.email);
  assertEquals((await verify(h, challengeId, code)).status, 200);
  assertEquals(await verify(h, challengeId, code), INVALID);
});

t('repeated sends for one name: one email, then the limit, all with the same answer', async () => {
  const h = makeHandler();
  const a = await makeAccount();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await send(h, a.username));
  await settle();
  assertEquals((await mailTo(a.email)).length, 1, 'guessing became mail-bombing');
  // The latest challenge inside the cooldown still verifies the code that was sent.
  const code = await codeFor(a.email);
  assertEquals(await verify(h, ids[4], code), INVALID, 'a limited send has no challenge');
  assertEquals((await verify(h, ids[2], code)).status, 200, 'the cooldown challenge shares the code');
});

t('ten sends per IP, then a real name from that IP sends nothing', async () => {
  const h = makeHandler();
  const ip = '203.0.113.200';
  for (let i = 0; i < 10; i++) await send(h, uniq('ipflood'), ip);
  const a = await makeAccount();
  await send(h, a.username, ip);
  await settle();
  assertEquals((await mailTo(a.email)).length, 0);
});

t('timing at the real floors: hit, miss, unconfirmed and banned are indistinguishable', async () => {
  // Real floors, no jitter, so a systematic difference cannot hide in the noise.
  const h = makeHandler({ ...TIMING, jitterMs: 0 });
  const kinds = {
    hit: async () => (await makeAccount()).username,
    miss: () => Promise.resolve(uniq('miss')),
    unconfirmed: async () => (await makeAccount({ confirmed: false })).username,
    banned: async () => (await makeAccount({ ban: '24h' })).username,
  };
  const stats: Record<string, { p50: number; p95: number }> = {};
  for (const [kind, name] of Object.entries(kinds)) {
    const xs: number[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await name();
      const t0 = performance.now();
      await send(h, id);
      xs.push(performance.now() - t0);
    }
    xs.sort((a, b) => a - b);
    stats[kind] = { p50: xs[Math.floor(xs.length / 2)], p95: xs[xs.length - 1] };
  }
  await settle();
  console.log(JSON.stringify(stats));
  for (const [kind, s] of Object.entries(stats)) {
    assert(s.p50 >= TIMING.sendFloorMs, `${kind} beat the floor`);
    assert(Math.abs(s.p50 - stats.hit.p50) < 60, `${kind} p50 ${s.p50} vs hit ${stats.hit.p50}`);
    assert(Math.abs(s.p95 - stats.hit.p95) < 80, `${kind} p95 ${s.p95} vs hit ${stats.hit.p95}`);
  }
  assert(!logs.some((l) => l.includes('floor_exceeded')), 'the floor was too low for the local stack');
});

t('no log line names anybody', async () => {
  await settle();
  assert(logs.length > 20);
  for (const line of logs) {
    for (const s of touched) assert(!line.toLowerCase().includes(s.toLowerCase()), `leak: ${line}`);
  }
  for (const line of logs) assertMatch(line, /^\{"fn":"username-sign-in","action":"[a-z_]+","outcome":"[a-z_]+"/);
});
