/**
 * The request handler, with every effect injected so it can be tested without a network.
 * `index.ts` wires the real dependencies; nothing else lives there.
 *
 * Read docs/architecture/username-sign-in.md first. The two properties everything here
 * serves:
 *
 *   1. **A send says nothing.** Hit, miss, unconfirmed, banned, limited, cooldown and a
 *      database failure all return the same status, the same body shape and the same
 *      sentence, after the same padded delay. The GoTrue send — the one step whose cost
 *      depends on the account existing — runs *after* the response, via `waitUntil`.
 *
 *   2. **A verify says one thing.** Success returns a session; every failure that could
 *      depend on the account (wrong code, expired, used, superseded, locked, decoy, banned
 *      since) is one status and one sentence, also padded. The per-IP limit is the only
 *      other answer, and it depends only on the caller.
 */

import type { Auth, Store } from './adapters.ts';
import { hmacHex, newChallengeId, normaliseUsername, sha256Hex } from './crypto.ts';
import {
  COPY,
  CHALLENGE_ID_PATTERN,
  MAX_BODY_BYTES,
  MAX_IDENTIFIER_LENGTH,
  MIN_HASH_KEY_LENGTH,
  TIMING,
} from './limits.ts';

/**
 * What may be logged: an action, an outcome class, a GoTrue error class, and a short
 * prefix of a *hash*. Never an identifier, an address, a code, a challenge id or an IP.
 * The type is the first guard; `handler.test.ts` spies on every line as the second.
 */
export interface LogEvent {
  fn: 'username-sign-in';
  action: 'send' | 'send_dispatch' | 'verify' | 'config';
  outcome: string;
  ref?: string;
  late_ms?: number;
}

export interface Deps {
  store: Store;
  auth: Auth;
  hashKey: string | undefined;
  log: (event: LogEvent) => void;
  /** Keeps the GoTrue send alive after the response. `EdgeRuntime.waitUntil` in production. */
  waitUntil: (work: Promise<unknown>) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  timing?: { sendFloorMs: number; verifyFloorMs: number; jitterMs: number };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/**
 * The caller's address, for the per-IP limits only, and only ever hashed.
 *
 * `cf-connecting-ip` first because Cloudflare overwrites it; then the first
 * `x-forwarded-for` hop. **Which of these the Supabase edge sets, and whether a client can
 * spoof it, is a staging QA item** (docs §5). If it is spoofable the per-IP limits become
 * per-request; the per-identifier and per-account limits, which are the ones protecting a
 * specific person, do not depend on it.
 */
export function clientIp(req: Request): string {
  const cf = req.headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const xff = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return xff || 'unknown';
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  const timing = deps.timing ?? TIMING;

  /** Holds the response until `started + floor + jitter`, and reports a blown floor. */
  const pad = async (started: number, floorMs: number, action: LogEvent['action']) => {
    const target = started + floorMs + deps.random() * timing.jitterMs;
    const remaining = target - deps.now();
    if (remaining > 0) await deps.sleep(remaining);
    else if (deps.now() - started > floorMs) {
      // The work took longer than the floor, so this response's timing is no longer
      // uniform. Logged so the floor can be raised; the response still goes out.
      deps.log({
        fn: 'username-sign-in',
        action,
        outcome: 'floor_exceeded',
        late_ms: Math.round(deps.now() - started - floorMs),
      });
    }
  };

  const ref = (hash: string) => hash.slice(0, 12);

  async function send(req: Request, body: Record<string, unknown>, key: string, started: number) {
    const raw = body.identifier;
    if (typeof raw !== 'string') return json(400, { error: 'bad_request', message: COPY.badRequest });

    // Everything below runs for every request, hit or miss, in the same order.
    const bounded = raw.slice(0, MAX_IDENTIFIER_LENGTH);
    const username = raw.length > MAX_IDENTIFIER_LENGTH ? null : normaliseUsername(bounded);
    const challengeId = newChallengeId();
    const [challengeHash, identifierHash, ipHash] = await Promise.all([
      sha256Hex(challengeId),
      hmacHex(key, 'id', username ?? bounded.trim().toLowerCase()),
      hmacHex(key, 'ip', clientIp(req)),
    ]);

    let outcome: string;
    try {
      const result = await deps.store.send({ username, identifierHash, ipHash, challengeHash });
      outcome = result.outcome;
      if (result.outcome === 'send') {
        const email = result.email;
        // After the response, so its latency — SMTP included — is not in the response's.
        deps.waitUntil(
          deps.auth
            .sendCode(email)
            .then((r) => (r.ok ? 'sent' : `gotrue_${r.code}`))
            .catch(() => 'gotrue_threw')
            .then((o) =>
              deps.log({ fn: 'username-sign-in', action: 'send_dispatch', outcome: o, ref: ref(challengeHash) }),
            ),
        );
      }
    } catch {
      // A failed lookup is answered like everything else: the alternative is an error
      // that some names could provoke and others could not.
      outcome = 'store_error';
    }

    deps.log({ fn: 'username-sign-in', action: 'send', outcome, ref: ref(challengeHash) });
    await pad(started, timing.sendFloorMs, 'send');
    return json(200, { challengeId, message: COPY.sent });
  }

  async function verify(req: Request, body: Record<string, unknown>, key: string, started: number) {
    const { challengeId, code } = body;
    if (typeof challengeId !== 'string' || typeof code !== 'string') {
      return json(400, { error: 'bad_request', message: COPY.badRequest });
    }

    const invalid = async (outcome: string, challengeHash?: string) => {
      deps.log({ fn: 'username-sign-in', action: 'verify', outcome, ref: challengeHash && ref(challengeHash) });
      await pad(started, timing.verifyFloorMs, 'verify');
      return json(400, { error: 'invalid_code', message: COPY.invalid });
    };

    // Shape checks cost no attempt and touch no row, but are padded like everything else.
    if (!CHALLENGE_ID_PATTERN.test(challengeId) || !/^\d{6}$/.test(code)) return invalid('malformed');

    const [challengeHash, ipHash] = await Promise.all([
      sha256Hex(challengeId),
      hmacHex(key, 'ip', clientIp(req)),
    ]);

    let begun;
    try {
      begun = await deps.store.verifyBegin({ challengeHash, ipHash });
    } catch {
      return invalid('store_error', challengeHash);
    }

    if (begun.outcome === 'limited') {
      deps.log({ fn: 'username-sign-in', action: 'verify', outcome: 'limited', ref: ref(challengeHash) });
      await pad(started, timing.verifyFloorMs, 'verify');
      return json(429, { error: 'rate_limited', message: COPY.limited });
    }
    if (begun.outcome !== 'check') return invalid('invalid', challengeHash);

    let checked;
    try {
      checked = await deps.auth.verifyCode(begun.email, code);
    } catch {
      return invalid('gotrue_threw', challengeHash);
    }
    // GoTrue's own refusals, rate limits included, are folded into the one answer: a
    // decoy never reaches GoTrue, so any GoTrue-specific answer would mark a real account.
    if (!checked.ok) return invalid(`gotrue_${checked.code}`, challengeHash);

    // Defence in depth. Both should be impossible; either means a session exists that
    // must not leave this function.
    let finished = false;
    try {
      finished =
        checked.userId === begun.user_id &&
        (await deps.store.verifyFinish({ challengeHash, userId: begun.user_id }));
    } catch {
      finished = false;
    }
    if (!finished) {
      await deps.auth.revoke(checked.session.access_token);
      return invalid('finish_refused', challengeHash);
    }

    deps.log({ fn: 'username-sign-in', action: 'verify', outcome: 'ok', ref: ref(challengeHash) });
    await pad(started, timing.verifyFloorMs, 'verify');
    return json(200, { session: checked.session });
  }

  return async (req: Request) => {
    const started = deps.now();
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed', message: COPY.badRequest });

    const key = deps.hashKey;
    if (!key || key.length < MIN_HASH_KEY_LENGTH) {
      // Fails closed, and identically for everyone: a configuration error is not an
      // account-dependent answer.
      deps.log({ fn: 'username-sign-in', action: 'config', outcome: 'missing_hash_key' });
      return json(503, { error: 'unavailable', message: COPY.unavailable });
    }

    const body = await readBody(req);
    if (!body) return json(400, { error: 'bad_request', message: COPY.badRequest });

    if (body.action === 'send') return send(req, body, key, started);
    if (body.action === 'verify') return verify(req, body, key, started);
    return json(400, { error: 'bad_request', message: COPY.badRequest });
  };
}
