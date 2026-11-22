/**
 * username-sign-in — sign in to an existing account with its username and an email code.
 *
 * ===========================================================================
 * NOT DEPLOYED. The client constant `USERNAME_SIGN_IN_ENABLED` is false and nothing calls
 * this. Deployment is a founder-approved checklist (docs/architecture/username-sign-in.md
 * §9): staging SMTP → migration → this function → QA → production → an OTA flipping the
 * constant. Rollback at any step is the constant staying false; removing the function is
 * the second step and the migration's tables are inert without it.
 * ===========================================================================
 *
 * POST { action: "send", identifier }          → 200 { challengeId, message }   always
 * POST { action: "verify", challengeId, code } → 200 { session } | 400 invalid_code
 *                                                | 429 rate_limited
 *
 * Called with the anon key, before there is a session. `verify_jwt = true` in config.toml
 * only proves the caller holds the anon key; nothing here trusts a claim from it.
 *
 * Secrets:
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY — injected by the platform.
 *   USERNAME_SIGN_IN_HASH_KEY — ≥ 32 random characters, set per project, keys the HMAC of
 *     identifiers and IPs in `auth_username_attempts`. Missing or short → every request is
 *     a 503, identically. Rotating it resets the hourly counters and nothing else.
 */

import { createClient } from '@supabase/supabase-js';

import { goTrueAuth, sqlStore } from './adapters.ts';
import { createHandler, type LogEvent } from './handler.ts';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const admin = createClient(url, serviceKey, options);
const anon = createClient(url, anonKey, options);

type EdgeRuntimeGlobal = { waitUntil?: (p: Promise<unknown>) => void };
const edge = (globalThis as { EdgeRuntime?: EdgeRuntimeGlobal }).EdgeRuntime;

const handler = createHandler({
  store: sqlStore(admin),
  auth: goTrueAuth(anon.auth, admin.auth.admin),
  hashKey: Deno.env.get('USERNAME_SIGN_IN_HASH_KEY'),
  log: (event: LogEvent) => console.log(JSON.stringify(event)),
  waitUntil: (work) => {
    if (edge?.waitUntil) edge.waitUntil(work);
    else void work.catch(() => {});
  },
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32,
});

Deno.serve(handler);
