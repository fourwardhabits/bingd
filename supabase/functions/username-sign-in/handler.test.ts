// deno-lint-ignore-file require-await -- the fakes implement async interfaces, and most of
// them have nothing to wait for.

/**
 * The handler, with every dependency faked. What the database decides — which names
 * resolve, the limits, expiry, attempts, single use — is pinned by
 * supabase/tests/username-sign-in.test.mjs against the real migration, and end to end by
 * local-stack.test.ts against a real GoTrue. What is pinned here is what the handler
 * itself owes: one answer for every send, one answer for every failed verify, the same
 * time for both, GoTrue called the right way, and nothing personal in a log line.
 *
 * Run with:
 *   npx deno test --config supabase/functions/username-sign-in/deno.json --allow-read \
 *     supabase/functions/username-sign-in
 */

import { assert, assertEquals, assertMatch, assertNotEquals } from '@std/assert';

import {
  type Auth,
  type BeginOutcome,
  errorClass,
  goTrueAuth,
  type SendOutcome,
  type Session,
  type Store,
} from './adapters.ts';
import { hmacHex, newChallengeId, normaliseUsername, sha256Hex } from './crypto.ts';
import { clientIp, createHandler, type Deps, type LogEvent } from './handler.ts';
import { CHALLENGE_ID_PATTERN, COPY, SQL_LIMITS, TIMING } from './limits.ts';

const KEY = 'k'.repeat(48);
const EMAIL = 'alice.private@example.test';
const RELAY = 'xyz123@privaterelay.appleid.com';
const IP = '203.0.113.77';
const USER = '11111111-2222-3333-4444-555555555555';

const SESSION: Session = {
  access_token: 'access.token.value',
  refresh_token: 'refresh-token-value',
  expires_in: 3600,
  expires_at: 1_900_000_000,
  token_type: 'bearer',
};

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Harness {
  handler: (req: Request) => Promise<Response>;
  logs: LogEvent[];
  sent: string[];
  verified: Array<[string, string]>;
  revoked: string[];
  finished: Array<{ challengeHash: string; userId: string }>;
  background: Promise<unknown>[];
  storeCalls: number;
}

function harness(
  opts: {
    send?: () => Promise<SendOutcome> | SendOutcome;
    begin?: () => Promise<BeginOutcome> | BeginOutcome;
    finish?: boolean;
    verifyCode?: Auth['verifyCode'];
    sendCode?: Auth['sendCode'];
    hashKey?: string;
    timing?: Deps['timing'];
    realClock?: boolean;
  } = {},
): Harness {
  const h: Harness = {
    handler: undefined as never,
    logs: [],
    sent: [],
    verified: [],
    revoked: [],
    finished: [],
    background: [],
    storeCalls: 0,
  };
  const store: Store = {
    send: async () => {
      h.storeCalls++;
      return (await opts.send?.()) ?? { outcome: 'miss' };
    },
    verifyBegin: async () => {
      h.storeCalls++;
      return (await opts.begin?.()) ?? { outcome: 'invalid' };
    },
    verifyFinish: async (args) => {
      h.finished.push(args);
      return opts.finish ?? true;
    },
  };
  const auth: Auth = {
    sendCode:
      opts.sendCode ??
      (async (email) => {
        h.sent.push(email);
        return { ok: true };
      }),
    verifyCode:
      opts.verifyCode ??
      (async (email, token) => {
        h.verified.push([email, token]);
        return token === '123456'
          ? { ok: true, session: SESSION, userId: USER }
          : { ok: false, code: 'otp_expired' };
      }),
    revoke: async (t) => {
      h.revoked.push(t);
    },
  };
  h.handler = createHandler({
    store,
    auth,
    hashKey: 'hashKey' in opts ? opts.hashKey : KEY,
    log: (e) => h.logs.push(e),
    waitUntil: (p) => {
      h.background.push(p);
    },
    now: () => performance.now(),
    // Fake clocks skip the padding entirely unless a test is measuring it.
    sleep: opts.realClock ? delay : async () => {},
    random: () => 0.5,
    timing: opts.timing,
  });
  return h;
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://local/username-sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `${IP}, 10.0.0.1`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const sendReq = (identifier: unknown = 'alice') => post({ action: 'send', identifier });
const verifyReq = (challengeId: string, code: string) => post({ action: 'verify', challengeId, code });

const shapeOf = async (res: Response) => {
  const body = await res.json();
  return { status: res.status, keys: Object.keys(body).sort(), message: body.message, body };
};

// ---------------------------------------------------------------------------
// send: one answer
// ---------------------------------------------------------------------------

const SEND_CASES: Array<[string, () => SendOutcome | Promise<SendOutcome>]> = [
  ['hit', () => ({ outcome: 'send', email: EMAIL })],
  ['Apple relay hit', () => ({ outcome: 'send', email: RELAY })],
  ['miss', () => ({ outcome: 'miss' })],
  ['unconfirmed (a miss to the database)', () => ({ outcome: 'miss' })],
  ['banned (a miss to the database)', () => ({ outcome: 'miss' })],
  ['cooldown', () => ({ outcome: 'cooldown' })],
  ['limited', () => ({ outcome: 'limited' })],
  [
    'store failure',
    () => {
      throw new Error('boom');
    },
  ],
];

Deno.test('send: every outcome is the same status, body shape and sentence', async () => {
  const seen = [];
  for (const [label, outcome] of SEND_CASES) {
    const h = harness({ send: outcome });
    const res = await h.handler(sendReq());
    const shape = await shapeOf(res);
    assertEquals(shape.status, 200, label);
    assertEquals(shape.keys, ['challengeId', 'message'], label);
    assertEquals(shape.message, COPY.sent, label);
    assertMatch(shape.body.challengeId, CHALLENGE_ID_PATTERN, label);
    assertEquals(res.headers.get('cache-control'), 'no-store', label);
    const text = JSON.stringify(shape.body);
    assert(!text.includes(EMAIL) && !text.includes(RELAY) && !text.includes(USER), label);
    seen.push(shape.body.challengeId);
  }
  assertEquals(new Set(seen).size, seen.length, 'challenge ids must never repeat');
});

Deno.test('send: only a hit asks GoTrue for a code, and the response does not wait for it', async () => {
  let release!: () => void;
  const stuck = new Promise<void>((r) => (release = r));
  const calls: string[] = [];
  const h = harness({
    send: () => ({ outcome: 'send', email: EMAIL }),
    sendCode: async (email) => {
      calls.push(email);
      await stuck; // GoTrue + SMTP, arbitrarily slow
      return { ok: true };
    },
  });
  const res = await h.handler(sendReq());
  assertEquals(res.status, 200, 'answered while the send is still in flight');
  assertEquals(calls, [EMAIL]);
  assertEquals(h.background.length, 1, 'the send is handed to waitUntil');
  release();
  await Promise.all(h.background);
  assert(h.logs.some((l) => l.action === 'send_dispatch' && l.outcome === 'sent'));

  for (const outcome of ['miss', 'cooldown', 'limited'] as const) {
    const m = harness({ send: () => ({ outcome }) });
    await m.handler(sendReq());
    assertEquals(m.sent, [], `${outcome} must not send`);
    assertEquals(m.background.length, 0, `${outcome} must not schedule anything`);
  }
});

Deno.test('send: the identifier is normalised and malformed ones never reach the lookup as names', async () => {
  const seen: Array<string | null> = [];
  const store: Store = {
    send: async ({ username }) => {
      seen.push(username);
      return { outcome: 'miss' };
    },
    verifyBegin: async () => ({ outcome: 'invalid' }),
    verifyFinish: async () => false,
  };
  const handler = createHandler({
    store,
    auth: { sendCode: async () => ({ ok: true }), verifyCode: async () => ({ ok: false, code: 'x' }), revoke: async () => {} },
    hashKey: KEY,
    log: () => {},
    waitUntil: () => {},
    now: () => 0,
    sleep: async () => {},
    random: () => 0,
  });
  for (const id of ['  Alice_01 ', 'ab', 'alice@example.test', 'x'.repeat(65), 'drop table;']) {
    assertEquals((await handler(sendReq(id))).status, 200);
  }
  assertEquals(seen, ['alice_01', null, null, null, null]);
});

Deno.test('send: a non-string identifier or a bad body is a shape error, not an account answer', async () => {
  const h = harness();
  for (const req of [sendReq(42), sendReq(null), post('{nope'), post([1, 2]), post({ action: 'other' })]) {
    const res = await h.handler(req);
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, 'bad_request');
  }
  assertEquals(h.storeCalls, 0);
  const big = await h.handler(post({ action: 'send', identifier: 'a'.repeat(4000) }));
  assertEquals(big.status, 400, 'an oversized body is refused before any work');
});

Deno.test('send: the IP and identifier reach the store only as keyed hashes', async () => {
  let args: Parameters<Store['send']>[0] | undefined;
  const handler = createHandler({
    store: {
      send: async (a) => {
        args = a;
        return { outcome: 'miss' };
      },
      verifyBegin: async () => ({ outcome: 'invalid' }),
      verifyFinish: async () => false,
    },
    auth: { sendCode: async () => ({ ok: true }), verifyCode: async () => ({ ok: false, code: 'x' }), revoke: async () => {} },
    hashKey: KEY,
    log: () => {},
    waitUntil: () => {},
    now: () => 0,
    sleep: async () => {},
    random: () => 0,
  });
  const res = await handler(sendReq('Alice'));
  const { challengeId } = await res.json();
  assert(args);
  assertEquals(args.ipHash, await hmacHex(KEY, 'ip', IP));
  assertEquals(args.identifierHash, await hmacHex(KEY, 'id', 'alice'));
  assertEquals(args.challengeHash, await sha256Hex(challengeId));
  assertNotEquals(args.ipHash, await sha256Hex(IP), 'unkeyed would be reversible');
  for (const h of [args.ipHash, args.identifierHash, args.challengeHash]) assertMatch(h, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// verify: one failure
// ---------------------------------------------------------------------------

const CHALLENGE = newChallengeId();

Deno.test('verify: decoy, unknown, expired, used, locked and wrong code are one answer', async () => {
  const answers: Array<[string, Awaited<ReturnType<typeof shapeOf>>]> = [];
  // Every database refusal is `invalid` by the time it reaches the handler.
  for (const label of ['decoy', 'unknown', 'expired', 'used', 'locked', 'banned since']) {
    const h = harness({ begin: () => ({ outcome: 'invalid' }) });
    answers.push([label, await shapeOf(await h.handler(verifyReq(CHALLENGE, '000000')))]);
    assertEquals(h.verified, [], `${label} must not reach GoTrue`);
  }
  // A real challenge with a wrong code, and with GoTrue's own refusals.
  for (const code of ['otp_expired', 'over_request_rate_limit', 'over_email_send_rate_limit']) {
    const h = harness({
      begin: () => ({ outcome: 'check', email: EMAIL, user_id: USER }),
      verifyCode: async () => ({ ok: false, code }),
    });
    answers.push([`gotrue ${code}`, await shapeOf(await h.handler(verifyReq(CHALLENGE, '000000')))]);
  }
  // Malformed input is the same answer too, and costs no attempt.
  for (const [id, code] of [
    ['short', '123456'],
    [CHALLENGE, '12345'],
    [CHALLENGE, 'abcdef'],
  ]) {
    const h = harness({ begin: () => ({ outcome: 'check', email: EMAIL, user_id: USER }) });
    answers.push([`malformed ${id.length}/${code}`, await shapeOf(await h.handler(verifyReq(id, code)))]);
    assertEquals(h.storeCalls, 0, 'a malformed request spends no attempt');
  }
  for (const [label, a] of answers) {
    assertEquals(
      { status: a.status, keys: a.keys, body: a.body },
      { status: 400, keys: ['error', 'message'], body: { error: 'invalid_code', message: COPY.invalid } },
      String(label),
    );
  }
});

Deno.test('verify: the right code returns the session tokens and nothing else, once', async () => {
  const h = harness({ begin: () => ({ outcome: 'check', email: EMAIL, user_id: USER }) });
  const res = await h.handler(verifyReq(CHALLENGE, '123456'));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, { session: SESSION });
  assertEquals(h.verified, [[EMAIL, '123456']]);
  assertEquals(h.finished, [{ challengeHash: await sha256Hex(CHALLENGE), userId: USER }]);
  assert(!JSON.stringify(body).includes(EMAIL));
});

Deno.test('verify: a session that cannot be finished is revoked and never returned', async () => {
  for (const [label, opts] of [
    ['already consumed by a parallel request', { finish: false }],
    [
      'GoTrue signed in a different account',
      { verifyCode: async () => ({ ok: true as const, session: SESSION, userId: 'someone-else' }) },
    ],
  ] as const) {
    const h = harness({ begin: () => ({ outcome: 'check', email: EMAIL, user_id: USER }), ...opts });
    const res = await h.handler(verifyReq(CHALLENGE, '123456'));
    assertEquals(res.status, 400, label);
    assertEquals((await res.json()).error, 'invalid_code', label);
    assertEquals(h.revoked, [SESSION.access_token], label);
  }
});

Deno.test('verify: the per-IP limit is its own answer, and the only other one', async () => {
  const h = harness({ begin: () => ({ outcome: 'limited' }) });
  const res = await h.handler(verifyReq(CHALLENGE, '123456'));
  assertEquals(res.status, 429);
  assertEquals(await res.json(), { error: 'rate_limited', message: COPY.limited });
  assertEquals(h.verified, []);
});

Deno.test('a missing or short hash key fails closed, identically', async () => {
  for (const hashKey of [undefined, '', 'short']) {
    const h = harness({ hashKey, send: () => ({ outcome: 'send', email: EMAIL }) });
    for (const req of [sendReq(), verifyReq(CHALLENGE, '123456')]) {
      const res = await h.handler(req);
      assertEquals(res.status, 503);
      assertEquals((await res.json()).error, 'unavailable');
    }
    assertEquals(h.storeCalls, 0);
    assertEquals(h.sent, []);
  }
});

Deno.test('only POST and OPTIONS', async () => {
  const h = harness();
  assertEquals((await h.handler(new Request('http://local/', { method: 'OPTIONS' }))).status, 204);
  assertEquals((await h.handler(new Request('http://local/', { method: 'GET' }))).status, 405);
});

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

async function timed(h: Harness, req: () => Request, n: number) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await h.handler(req());
    out.push(performance.now() - t0);
  }
  return out;
}

const FAST = { sendFloorMs: 120, verifyFloorMs: 160, jitterMs: 0 };
const TOLERANCE_MS = 25;

Deno.test('timing: a hit, a miss, an unconfirmed and a banned send take the same time', async () => {
  // A hit's lookup is made slower than a miss's, and its GoTrue send far slower than the
  // floor: neither may show.
  const variants: Array<[string, Harness]> = [
    ['hit', harness({
      realClock: true,
      timing: FAST,
      send: async () => (await delay(15), { outcome: 'send', email: EMAIL }),
      sendCode: async () => (await delay(400), { ok: true }),
    })],
    ['miss', harness({ realClock: true, timing: FAST, send: async () => (await delay(2), { outcome: 'miss' }) })],
    ['unconfirmed', harness({ realClock: true, timing: FAST, send: async () => (await delay(5), { outcome: 'miss' }) })],
    ['banned', harness({ realClock: true, timing: FAST, send: async () => (await delay(5), { outcome: 'miss' }) })],
    ['limited', harness({ realClock: true, timing: FAST, send: () => ({ outcome: 'limited' }) })],
  ];
  const stats = [];
  for (const [label, h] of variants) {
    const xs = await timed(h, () => sendReq(), 12);
    stats.push({ label, p50: quantile(xs, 0.5), p95: quantile(xs, 0.95) });
  }
  const base = stats[0];
  for (const s of stats) {
    assert(s.p50 >= FAST.sendFloorMs - 1, `${s.label} answered before the floor: ${s.p50}`);
    assert(Math.abs(s.p50 - base.p50) < TOLERANCE_MS, `p50 ${s.label} ${s.p50} vs hit ${base.p50}`);
    assert(Math.abs(s.p95 - base.p95) < TOLERANCE_MS, `p95 ${s.label} ${s.p95} vs hit ${base.p95}`);
  }
});

Deno.test('timing: a decoy and a real challenge with a wrong code take the same time', async () => {
  const decoy = harness({ realClock: true, timing: FAST, begin: async () => (await delay(2), { outcome: 'invalid' }) });
  const real = harness({
    realClock: true,
    timing: FAST,
    begin: async () => (await delay(3), { outcome: 'check', email: EMAIL, user_id: USER }),
    verifyCode: async () => (await delay(60), { ok: false, code: 'otp_expired' }),
  });
  const a = await timed(decoy, () => verifyReq(CHALLENGE, '000000'), 12);
  const b = await timed(real, () => verifyReq(CHALLENGE, '000000'), 12);
  assert(Math.abs(quantile(a, 0.5) - quantile(b, 0.5)) < TOLERANCE_MS, `p50 ${quantile(a, 0.5)} vs ${quantile(b, 0.5)}`);
  assert(Math.abs(quantile(a, 0.95) - quantile(b, 0.95)) < TOLERANCE_MS, `p95 ${quantile(a, 0.95)} vs ${quantile(b, 0.95)}`);
});

Deno.test('timing: jitter is added on top of the floor, never subtracted', async () => {
  const sleeps: number[] = [];
  let clock = 0;
  const handler = createHandler({
    store: { send: async () => ({ outcome: 'miss' }), verifyBegin: async () => ({ outcome: 'invalid' }), verifyFinish: async () => false },
    auth: { sendCode: async () => ({ ok: true }), verifyCode: async () => ({ ok: false, code: 'x' }), revoke: async () => {} },
    hashKey: KEY,
    log: () => {},
    waitUntil: () => {},
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.999,
  });
  await handler(sendReq());
  assertEquals(Math.round(sleeps[0]), Math.round(TIMING.sendFloorMs + 0.999 * TIMING.jitterMs));
  clock = 0;
  await handler(verifyReq(CHALLENGE, '000000'));
  assertEquals(Math.round(sleeps[1]), Math.round(TIMING.verifyFloorMs + 0.999 * TIMING.jitterMs));
});

Deno.test('timing: a blown floor is logged as a number, not hidden', async () => {
  let clock = 0;
  const logs: LogEvent[] = [];
  const handler = createHandler({
    store: {
      send: async () => {
        clock += 5000;
        return { outcome: 'miss' };
      },
      verifyBegin: async () => ({ outcome: 'invalid' }),
      verifyFinish: async () => false,
    },
    auth: { sendCode: async () => ({ ok: true }), verifyCode: async () => ({ ok: false, code: 'x' }), revoke: async () => {} },
    hashKey: KEY,
    log: (e) => logs.push(e),
    waitUntil: () => {},
    now: () => clock,
    sleep: async () => {},
    random: () => 0,
  });
  await handler(sendReq());
  assert(logs.some((l) => l.outcome === 'floor_exceeded' && l.late_ms === 5000 - TIMING.sendFloorMs));
});

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

Deno.test('logs carry no identifier, address, code, challenge id or IP', async () => {
  const lines: string[] = [];
  const secrets = [EMAIL, RELAY, IP, '123456', '000000', 'alice_logged', USER, SESSION.access_token];
  const scenarios: Array<[Parameters<typeof harness>[0], Request | ((id: string) => Request)]> = [
    [{ send: () => ({ outcome: 'send', email: EMAIL }) }, sendReq('Alice_Logged')],
    [{ send: () => ({ outcome: 'send', email: RELAY }), sendCode: async () => ({ ok: false, code: 'over_email_send_rate_limit' }) }, sendReq('alice_logged')],
    [{ send: () => ({ outcome: 'miss' }) }, sendReq('alice_logged')],
    [{ send: () => { throw new Error(`${EMAIL} alice_logged`); } }, sendReq('alice_logged')],
    [{ begin: () => ({ outcome: 'check', email: EMAIL, user_id: USER }) }, verifyReq(CHALLENGE, '123456')],
    [{ begin: () => ({ outcome: 'check', email: EMAIL, user_id: USER }) }, verifyReq(CHALLENGE, '000000')],
    [{ begin: () => ({ outcome: 'check', email: EMAIL, user_id: USER }), finish: false }, verifyReq(CHALLENGE, '123456')],
    [{ begin: () => ({ outcome: 'invalid' }) }, verifyReq(CHALLENGE, '000000')],
    [{ begin: () => ({ outcome: 'limited' }) }, verifyReq(CHALLENGE, '000000')],
    [{ hashKey: undefined }, sendReq('alice_logged')],
  ];
  const ids: string[] = [CHALLENGE];
  for (const [opts, req] of scenarios) {
    const h = harness(opts);
    const res = await h.handler(req as Request);
    if (res.status === 200) {
      const body = await res.json();
      if (body.challengeId) ids.push(body.challengeId);
    }
    await Promise.all(h.background);
    for (const l of h.logs) lines.push(JSON.stringify(l));
  }
  assert(lines.length >= scenarios.length, 'every scenario logs at least its outcome');
  for (const line of lines) {
    for (const s of [...secrets, ...ids]) {
      assert(!line.toLowerCase().includes(s.toLowerCase()), `log leaked ${s}: ${line}`);
    }
    const keys = Object.keys(JSON.parse(line));
    for (const k of keys) assert(['fn', 'action', 'outcome', 'ref', 'late_ms'].includes(k), `unexpected log key ${k}`);
  }
});

// ---------------------------------------------------------------------------
// The GoTrue adapter
// ---------------------------------------------------------------------------

Deno.test('GoTrue: a code is always requested with shouldCreateUser false', async () => {
  const calls: unknown[] = [];
  const auth = goTrueAuth(
    {
      signInWithOtp: async (args) => {
        calls.push(args);
        return { error: null };
      },
      verifyOtp: async () => ({ data: { session: null, user: null }, error: null }),
    },
    { signOut: async () => ({}) },
  );
  assertEquals(await auth.sendCode(EMAIL), { ok: true });
  assertEquals(await auth.sendCode(RELAY), { ok: true });
  assertEquals(calls, [
    { email: EMAIL, options: { shouldCreateUser: false } },
    { email: RELAY, options: { shouldCreateUser: false } },
  ]);
});

Deno.test('GoTrue: verify uses type email and returns only the token fields', async () => {
  const calls: unknown[] = [];
  const auth = goTrueAuth(
    {
      signInWithOtp: async () => ({ error: null }),
      verifyOtp: async (args) => {
        calls.push(args);
        return {
          data: {
            session: { ...SESSION, user: { id: USER, email: EMAIL } } as Session & { user: { id: string } },
            user: { id: USER },
          },
          error: null,
        };
      },
    },
    { signOut: async () => ({}) },
  );
  const r = await auth.verifyCode(EMAIL, '123456');
  assertEquals(calls, [{ email: EMAIL, token: '123456', type: 'email' }]);
  assertEquals(r, { ok: true, userId: USER, session: SESSION });
  assert(!JSON.stringify(r).includes(EMAIL));
});

Deno.test('GoTrue: error codes are classified, never echoed as messages', () => {
  assertEquals(errorClass('otp_expired'), 'otp_expired');
  assertEquals(errorClass(`bad ${EMAIL}`), 'unknown');
  assertEquals(errorClass(undefined), 'unknown');
  assertEquals(errorClass('x'.repeat(65)), 'unknown');
});

Deno.test('GoTrue: a failed revoke does not throw', async () => {
  const auth = goTrueAuth(
    { signInWithOtp: async () => ({ error: null }), verifyOtp: async () => ({ data: { session: null, user: null }, error: null }) },
    { signOut: async () => { throw new Error('down'); } },
  );
  await auth.revoke('token');
});

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

Deno.test('normaliseUsername matches create_profile: lower(btrim()), ^[a-z0-9_]{3,24}$', () => {
  assertEquals(normaliseUsername('  Alice_99 '), 'alice_99');
  assertEquals(normaliseUsername('abc'), 'abc');
  assertEquals(normaliseUsername('a'.repeat(24)), 'a'.repeat(24));
  for (const bad of ['ab', 'a'.repeat(25), 'al ice', 'alice!', '@alice', 'alice@x.io', 'ålice', '', 42, null]) {
    assertEquals(normaliseUsername(bad), null, String(bad));
  }
});

Deno.test('challenge ids are 256-bit, url-safe and unique', () => {
  const ids = Array.from({ length: 500 }, newChallengeId);
  for (const id of ids) assertMatch(id, CHALLENGE_ID_PATTERN);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test('clientIp prefers cf-connecting-ip, then the first forwarded hop', () => {
  const req = (h: Record<string, string>) => new Request('http://x/', { headers: h });
  assertEquals(clientIp(req({ 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '1.1.1.1' })), '198.51.100.1');
  assertEquals(clientIp(req({ 'x-forwarded-for': ' 192.0.2.4 , 10.0.0.1' })), '192.0.2.4');
  assertEquals(clientIp(req({})), 'unknown');
});

Deno.test('the limits stated here are the limits the migration enforces', async () => {
  const dir = new URL('../../migrations/', import.meta.url);
  let sql = '';
  for await (const f of Deno.readDir(dir)) {
    if (f.name.startsWith('20261117000100_')) sql = await Deno.readTextFile(new URL(f.name, dir));
  }
  assert(sql, 'migration not found');
  const has = (re: RegExp) => assert(re.test(sql), `migration does not say ${re}`);
  has(new RegExp(`c_ttl\\s+constant interval := interval '${SQL_LIMITS.challengeTtlMinutes} minutes'`));
  has(new RegExp(`c_cooldown\\s+constant interval := interval '${SQL_LIMITS.perAccountCooldownSeconds} seconds'`));
  has(new RegExp(`c_per_identifier constant integer\\s+:= ${SQL_LIMITS.sendsPerIdentifierPerHour};`));
  has(new RegExp(`c_per_ip\\s+constant integer\\s+:= ${SQL_LIMITS.sendsPerIpPerHour};`));
  has(new RegExp(`c_per_ip\\s+constant integer\\s+:= ${SQL_LIMITS.verifiesPerIpPerHour};`));
  has(new RegExp(`c_max_attempts constant integer\\s+:= ${SQL_LIMITS.maxAttempts};`));
  has(new RegExp(`attempts between 0 and ${SQL_LIMITS.maxAttempts}`));
  has(new RegExp(`interval '${SQL_LIMITS.retentionHours} hours'`));
});
