/**
 * push-sender — the only thing that delivers a Bingd notification to a phone.
 *
 * ===========================================================================
 * WHAT IT WILL NOT DO, WHICH IS MOST OF THE DESIGN
 *
 * **It takes no input.** Not a recipient, not a title, not a body, not a batch size. The
 * request body is ignored entirely. Everything sent is read from `push_outbox`, whose
 * primary key is a notification id with `on delete cascade` — so a push exists only where
 * a notification row exists, and a caller has nothing to point anywhere.
 *
 * That is worth stating as the *first* thing, because the obvious shape for this function
 * is `POST { userId, title, body }`, and that shape is a way for any signed-in account to
 * send any other account anything.
 *
 * **It cannot bypass a preference.** Not because it checks one, but because a suppressed
 * notification was never written: `_apply_notification_preference` is a before-insert
 * trigger returning null, and the enqueue is an after-insert trigger. There is no second
 * axis and nothing here consults one. See `20260824000300`.
 *
 * ===========================================================================
 * WHO MAY INVOKE IT, AND WHY THAT IS A WEAK GATE ON PURPOSE
 *
 * Any signed-in account, or `service_role`.
 *
 * The gate is weak because it does not need to be strong: the caller chooses nothing.
 * What an invocation *is* is a nudge — "there may be work" — and the reason a signed-in
 * user is allowed to give it is that the person who caused a notification is holding a
 * phone at that moment, which makes their client the cheapest scheduler available. See
 * `src/features/notifications/push.ts`.
 *
 * The cost of the weak gate is that a determined signed-in caller can invoke it in a
 * loop. That buys them a bounded query against an empty queue and nothing else — no
 * output about anybody, no way to cause a send that was not already due. Deliberately not
 * defended against beyond the batch ceiling.
 *
 * `verify_jwt = true` in `supabase/config.toml` is what makes `claimsServiceRole` below
 * safe to trust, exactly as it is for `tmdb-adapter`.
 *
 * ===========================================================================
 * DELIVERY GUARANTEE
 *
 * At least once, bounded at three attempts. `claim_push_batch` leases rows for five
 * minutes with `skip locked`, so a sender that dies between sending and settling will
 * send again when the lease expires. That is the right side to fail on for a
 * notification, and it is stated rather than implied.
 *
 * **Receipts are deliberately not polled.** Expo answers a send with a *ticket*, and the
 * final outcome is a *receipt* fetched later from `/push/getReceipts`. Polling them needs
 * a second scheduled process and a table of ticket ids, which is a queue-processing
 * platform for the one thing receipts add over tickets: catching a token that died
 * between the send and the delivery. Send-time `DeviceNotRegistered` already catches the
 * ordinary case — an uninstall the service already knows about — and the rest is a token
 * that will be caught on its next send instead. Recorded in `deferred-roadmap.md`.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { messagesFor, summarise } from './batch.ts';
import type { PushJob } from './copy.ts';
import { chunk, isDeadToken, isRetryable, sendChunk } from './expo.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/**
 * One invocation's ceiling, and it is not a tuning knob a caller can turn.
 *
 * Fifty notifications is comfortably inside Expo's hundred-message request limit even
 * where several people have two devices, and it bounds what one invocation costs. A
 * backlog larger than this drains over successive invocations, which is what an outbox is
 * for.
 */
const BATCH = 50;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

function adminClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');

  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Reads the `role` claim without verifying the signature, which is safe **only** because
 * `verify_jwt = true` in `supabase/config.toml`. Lifted from `tmdb-adapter`'s
 * `resolveCaller`, with the same warning attached: turning that flag off would make this
 * forgeable, and the symptom would be nothing at all.
 */
function claimsServiceRole(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');

  try {
    return JSON.parse(atob(padded))?.role === 'service_role';
  } catch {
    return false;
  }
}

/** Somebody real, or nobody. The identity is never used for anything but this gate. */
async function isKnownCaller(db: SupabaseClient, req: Request): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;

  if (token === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) return true;
  if (claimsServiceRole(token)) return true;

  // The anon key is itself a valid JWT and resolves to no user, which is what this
  // rejects. `verify_jwt` alone would have let it through.
  const { data, error } = await db.auth.getUser(token);
  return !error && Boolean(data.user);
}

// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let db: SupabaseClient;
  try {
    db = adminClient();
  } catch (e) {
    console.error('push-sender misconfigured:', (e as Error).message);
    return json({ error: 'not configured' }, 500);
  }

  if (!(await isKnownCaller(db, req))) return json({ error: 'unauthorized' }, 401);

  const { data: claimed, error: claimError } = await db.rpc('claim_push_batch', { p_limit: BATCH });
  if (claimError) {
    console.error('claim_push_batch failed:', claimError.message);
    return json({ error: 'could not claim' }, 500);
  }

  const jobs = (claimed ?? []) as PushJob[];
  if (jobs.length === 0) return json({ claimed: 0, sent: 0, failed: 0, revoked: 0 });

  const addressed = messagesFor(jobs);
  if (addressed.length === 0) {
    // Claimed but unsendable. Settled as delivered so the rows leave the queue rather
    // than being retried into the same nothing three times.
    await db.rpc('settle_push_batch', {
      p_results: jobs.map((job) => ({ notification_id: job.notification_id, delivered: true })),
      p_invalid_tokens: null,
    });
    return json({ claimed: jobs.length, sent: 0, failed: 0, revoked: 0 });
  }

  /**
   * Tickets, indexed in step with `addressed`.
   *
   * A chunk that fails as a whole contributes one synthetic retryable outcome per message
   * it contained, so the index alignment holds whatever happened — which is what lets the
   * summary below be written without knowing about chunking at all.
   */
  const outcomes: { retryable: boolean; dead: boolean; message: string | null }[] = [];

  for (const batch of chunk(addressed)) {
    const { tickets, failure } = await sendChunk(batch.map((entry) => entry.message));

    if (failure) {
      // One log line per failed chunk, not per message. It names no token: a token is an
      // operational secret and a function log is not the place for one.
      console.error(`push chunk of ${batch.length} failed: ${failure}`);
      for (let i = 0; i < batch.length; i += 1) {
        outcomes.push({ retryable: true, dead: false, message: failure });
      }
      continue;
    }

    for (const ticket of tickets) {
      outcomes.push({
        retryable: isRetryable(ticket),
        dead: isDeadToken(ticket),
        message: ticket.status === 'error' ? ticket.message : null,
      });
    }
  }

  const { results, deadTokens } = summarise(addressed, (index) => outcomes[index]);

  const { data: settled, error: settleError } = await db.rpc('settle_push_batch', {
    p_results: results,
    p_invalid_tokens: deadTokens.length ? deadTokens : null,
  });

  if (settleError) {
    // The sends happened. Not settling means the lease expires and they are attempted
    // again, which is the at-least-once guarantee doing its job rather than a data loss.
    console.error('settle_push_batch failed:', settleError.message);
    return json({ error: 'sent but not settled' }, 500);
  }

  const failed = results.filter((r) => !r.delivered).length;
  return json({
    claimed: jobs.length,
    sent: results.length - failed,
    failed,
    revoked: (settled as { revoked?: number } | null)?.revoked ?? 0,
  });
});
