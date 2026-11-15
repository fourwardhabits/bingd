#!/usr/bin/env node
/**
 * Deterministic social QA fixture for STAGING (or a local stack). Never production.
 *
 *   node scripts/qa-fixtures/social/fixture.mjs setup    [--dry-run] [--log <path>] [--link-qa-accounts] [--generation N]
 *   node scripts/qa-fixtures/social/fixture.mjs verify   [--log <path>] [--link-qa-accounts] [--generation N]
 *   node scripts/qa-fixtures/social/fixture.mjs teardown [--dry-run] [--log <path>] [--generation N]
 *
 * Environment (the names the sibling acceptance scripts use):
 *   EXPO_PUBLIC_SUPABASE_URL (or SUPABASE_URL)   read first, guarded before anything else
 *   EXPO_PUBLIC_SUPABASE_ANON_KEY                read only after the URL passes
 *   SUPABASE_SERVICE_ROLE_KEY                    read only after environment_name() = nonprod
 *   QA_FIXTURE_PASSWORD                          secret the per-account passwords derive from
 *
 * Exit codes: 0 success, 1 drift or a failed step, 2 refused (guard, ownership, config).
 *
 * README.md beside this file is the operator's guide. The data is in plan.mjs, the guard in
 * guard.mjs, the HTTP layer in client.mjs.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createHttpClient } from './client.mjs';
import { GuardError, classifyTarget, guardTarget } from './guard.mjs';
import { createMutationLog, defaultLogPath } from './mutation-log.mjs';
import {
  FIXTURE_MARKER,
  MARKER_KEY,
  PROTECTED_HANDLES,
  buildPlan,
  expectedCanView,
  expectedFollowStates,
  expectedHelpfulCounts,
  expectedScores,
  externalHandle,
  operationId,
} from './plan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const COMMANDS = ['setup', 'verify', 'teardown'];

export class OwnershipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OwnershipError';
  }
}

export class StepError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StepError';
  }
}

// ---------------------------------------------------------------------------
// Arguments, environment, passwords
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    command: null,
    dryRun: false,
    logPath: undefined,
    linkQaAccounts: false,
    generation: 1,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--link-qa-accounts') args.linkQaAccounts = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--log') {
      args.logPath = argv[i + 1];
      i += 1;
      if (!args.logPath) throw new Error('--log needs a path');
    } else if (arg === '--generation') {
      args.generation = Number(argv[i + 1]);
      i += 1;
      if (!Number.isInteger(args.generation) || args.generation < 1)
        throw new Error('--generation needs a positive integer');
    } else if (!arg.startsWith('-') && args.command === null) args.command = arg;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!args.help && !COMMANDS.includes(args.command)) {
    throw new Error(`command must be one of ${COMMANDS.join(', ')}`);
  }
  if (args.command === 'verify' && args.dryRun)
    throw new Error('verify only reads; --dry-run does not apply');
  if (args.command === 'teardown' && args.linkQaAccounts) {
    throw new Error(
      'teardown never touches QA accounts; deleting the fixture accounts removes every link',
    );
  }
  return args;
}

/** `.env`, then `.env.local`, then the ambient environment: the siblings' precedence. */
function loadEnvFile(name) {
  let text;
  try {
    text = readFileSync(join(ROOT, name), 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

export function defaultEnv() {
  return { ...loadEnvFile('.env'), ...loadEnvFile('.env.local'), ...process.env };
}

/**
 * The password for one fixture account, derived at runtime and never stored or logged.
 * HMAC-SHA256 keyed by QA_FIXTURE_PASSWORD over the marker and the username.
 */
export function derivePassword(secret, username) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new StepError('QA_FIXTURE_PASSWORD must be set and at least 16 characters long');
  }
  const mac = createHmac('sha256', secret)
    .update(`qa-fixture:${FIXTURE_MARKER}:${username}`)
    .digest('base64url');
  return `Qa-${mac.slice(0, 32)}-9z`;
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/** Where the marker was found, or null. app_metadata wins whenever it carries the key. */
export function markerSource(user) {
  if (
    user?.app_metadata &&
    Object.prototype.hasOwnProperty.call(user.app_metadata, MARKER_KEY)
  ) {
    return user.app_metadata[MARKER_KEY] === FIXTURE_MARKER ? 'app_metadata' : null;
  }
  if (user?.user_metadata?.[MARKER_KEY] === FIXTURE_MARKER) return 'user_metadata';
  return null;
}

/**
 * Fixture-owned means the email, the marker AND (once signed in) the username all match.
 * Anything else is somebody else's account, and the run stops before it writes.
 */
export function assertOwnedAuthUser(user, account) {
  if (String(user?.email ?? '').toLowerCase() !== account.email.toLowerCase()) {
    throw new OwnershipError(
      `${account.email}: the auth user's email does not match; refusing to touch it`,
    );
  }
  if (markerSource(user) === null) {
    throw new OwnershipError(
      `${account.email} exists but is not marked ${MARKER_KEY}=${FIXTURE_MARKER}. It is not a fixture ` +
        'account; the fixture never overwrites, signs in as, or deletes it.',
    );
  }
}

export function assertOwnedProfile(profile, account) {
  if (profile && profile.username !== account.username) {
    throw new OwnershipError(
      `${account.email} is marked but its profile is @${profile.username}, not @${account.username}; refusing.`,
    );
  }
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * @param {{ plan: ReturnType<typeof buildPlan>, client: any, log: any, command: string,
 *           dryRun?: boolean, secret?: string, out?: Console }} options
 */
export function createContext({
  plan,
  client,
  log,
  command,
  dryRun = false,
  secret,
  out = console,
}) {
  return {
    plan,
    client,
    log,
    command,
    dryRun,
    secret,
    out,
    sessions: new Map(),
    titles: new Map(),
    handles: new Map(),
    skipped: new Set(),
    problems: [],
    checks: [],
    writes: 0,
    /** Every value that must never reach the log or the console. */
    secrets() {
      const values = [secret];
      for (const s of this.sessions.values()) values.push(s.token, s.password);
      return values.filter(Boolean);
    },
  };
}

const say = (ctx, ...parts) => ctx.out.log(parts.join(' '));

function problem(ctx, entity, message) {
  ctx.problems.push(`${entity}: ${message}`);
  ctx.log.record({
    actor: 'fixture',
    operation: 'check',
    entity,
    result: 'problem',
    detail: message,
  });
  say(ctx, 'PROBLEM ', entity, '-', message);
}

function rpcFailure(name, res) {
  const message =
    res.body?.message ?? (typeof res.body === 'string' ? res.body : JSON.stringify(res.body));
  const error = new StepError(
    `${name} answered ${res.status}: ${String(message).slice(0, 200)}`,
  );
  error.status = res.status;
  error.code = res.body?.code;
  return error;
}

async function rpcRead(ctx, session, name, args) {
  if (session.offline) return null;
  const res = await ctx.client.rpc(session.token, name, args);
  if (res.status < 200 || res.status >= 300) throw rpcFailure(name, res);
  return res.body;
}

async function selectRows(ctx, session, table, query) {
  if (session.offline) return [];
  const res = await ctx.client.select(session.token, table, query);
  if (res.status !== 200 || !Array.isArray(res.body)) throw rpcFailure(`select ${table}`, res);
  return res.body;
}

function resultOf(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.status === 'refused') return `refused:${value.reason ?? 'unknown'}`;
    if (typeof value.status === 'string') return value.status;
    if (value.done === true) return 'done';
  }
  return 'ok';
}

/**
 * Every mutation goes through here: it is logged, it is counted, and under --dry-run it is
 * only logged.
 */
async function write(ctx, { actor, operation, entity }, fn) {
  if (ctx.dryRun) {
    ctx.log.record({ actor, operation, entity, result: 'dry_run' });
    say(ctx, 'would   ', actor.padEnd(18), operation.padEnd(28), entity);
    return { dryRun: true };
  }
  let value;
  try {
    value = await fn();
  } catch (error) {
    ctx.log.record({ actor, operation, entity, result: 'error', detail: error.message });
    throw error;
  }
  ctx.writes += 1;
  const result = resultOf(value);
  ctx.log.record({ actor, operation, entity, result });
  say(ctx, 'write   ', actor.padEnd(18), operation.padEnd(28), entity, `→ ${result}`);
  return value;
}

/** A user-JWT RPC write. Non-2xx throws. */
function rpcWrite(ctx, session, name, args, entity) {
  return write(ctx, { actor: session.username, operation: name, entity }, async () => {
    const res = await ctx.client.rpc(session.token, name, args);
    if (res.status < 200 || res.status >= 300) throw rpcFailure(name, res);
    return res.body;
  });
}

// ---------------------------------------------------------------------------
// Reads, each from one account's own point of view
// ---------------------------------------------------------------------------

async function ownProfile(ctx, s) {
  const rows = await selectRows(ctx, s, 'profiles', {
    columns: ['id', 'username', 'display_name', 'visibility', 'status'],
    eq: { id: s.id },
  });
  return rows[0] ?? null;
}

async function ownUserMedia(ctx, s, mediaId) {
  const rows = await selectRows(ctx, s, 'user_media', {
    columns: [
      'id',
      'media_item_id',
      'bucket',
      'note',
      'note_visibility',
      'note_has_spoilers',
      'note_updated_at',
      'watched_on',
    ],
    eq: { user_id: s.id, media_item_id: mediaId },
  });
  return rows[0] ?? null;
}

async function ownRanking(ctx, s, mediaId) {
  const rows = await selectRows(ctx, s, 'rankings', {
    columns: ['media_item_id', 'bucket', 'position'],
    eq: { user_id: s.id, media_item_id: mediaId },
  });
  return rows[0] ?? null;
}

async function followState(ctx, s, otherId) {
  const rows = await rpcRead(ctx, s, 'follow_state_with', { p_user_ids: [otherId] });
  return rows?.[0] ?? null;
}

async function sentRecommendation(ctx, s, recipientId, mediaId) {
  const rows = await selectRows(ctx, s, 'title_recommendations', {
    columns: ['id', 'recipient_id', 'media_item_id'],
    eq: { sender_id: s.id, recipient_id: recipientId, media_item_id: mediaId },
  });
  return rows[0] ?? null;
}

async function recommendationsToMe(ctx, s) {
  return (await rpcRead(ctx, s, 'recommendations_to_me', { p_limit: 200 })) ?? [];
}

async function recommendationRequests(ctx, s) {
  return (await rpcRead(ctx, s, 'recommendation_requests', { p_limit: 200 })) ?? [];
}

/** Both orders, merged, so a busy title page cannot push a fixture review past the limit. */
async function titleReviews(ctx, s, mediaId) {
  const seen = new Map();
  for (const sort of ['top_desc', 'recent_desc']) {
    const rows =
      (await rpcRead(ctx, s, 'title_reviews_v2', {
        p_media_item_id: mediaId,
        p_sort: sort,
        p_limit: 100,
      })) ?? [];
    for (const row of rows) if (!seen.has(row.id)) seen.set(row.id, row);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

function offlineSession(account) {
  return {
    key: account.key,
    username: account.username,
    id: `<${account.username}>`,
    token: null,
    offline: true,
  };
}

async function signInAs(ctx, account, userId) {
  const password = derivePassword(ctx.secret, account.username);
  const { token, userId: signedIn } = await ctx.client.signIn(account.email, password);
  const session = {
    key: account.key,
    username: account.username,
    id: signedIn ?? userId,
    token,
    password,
  };
  if (userId && session.id !== userId) {
    throw new OwnershipError(
      `${account.email}: signed in as a different user id than the admin lookup returned`,
    );
  }
  ctx.sessions.set(account.key, session);
  return session;
}

/**
 * Phase 1, reads only: every account that exists is proven fixture-owned before the run
 * writes anything at all. Returns what is missing.
 */
async function inspectAccounts(ctx) {
  const state = [];
  for (const account of ctx.plan.accounts) {
    const users = await ctx.client.admin.findUsersByEmail(account.email);
    if (users.length > 1)
      throw new OwnershipError(`${account.email} matches ${users.length} auth users; refusing`);
    const user = users[0] ?? null;
    if (user === null) {
      state.push({ account, user: null, session: null, profile: null });
      continue;
    }
    assertOwnedAuthUser(user, account);
    if (markerSource(user) === 'user_metadata') {
      say(
        ctx,
        'note    ',
        `${account.email} carries the marker in user_metadata only (fallback)`,
      );
    }
    let session;
    try {
      session = await signInAs(ctx, account, user.id);
    } catch (error) {
      if (error instanceof OwnershipError) throw error;
      throw new OwnershipError(
        `${account.email} is marked but does not accept the password derived from QA_FIXTURE_PASSWORD ` +
          `(${error.message}). Refusing rather than resetting it.`,
      );
    }
    const profile = await ownProfile(ctx, session);
    assertOwnedProfile(profile, account);
    state.push({ account, user, session, profile });
  }
  return state;
}

/** A username held by somebody else stops the run before an auth user is created. */
async function assertUsernameNotForeign(ctx, account) {
  const probe = [...ctx.sessions.values()].find((s) => !s.offline);
  if (!probe) return;
  const rows =
    (await rpcRead(ctx, probe, 'search_users', { p_query: account.username, p_limit: 20 })) ??
    [];
  const holder = rows.find((row) => row.username === account.username);
  if (holder) {
    throw new OwnershipError(
      `@${account.username} already belongs to a non-fixture account; refusing`,
    );
  }
}

async function createProfile(ctx, session, account, { rollbackUserId } = {}) {
  try {
    const body = await rpcWrite(
      ctx,
      session,
      'create_profile',
      {
        p_username: account.username,
        p_display_name: account.displayName,
        p_date_of_birth: account.dateOfBirth,
      },
      `account:${account.key}`,
    );
    if (body?.ok !== true)
      throw new StepError(
        `create_profile for ${account.username} answered ${JSON.stringify(body)}`,
      );
  } catch (error) {
    if (error.code === '23505') {
      if (rollbackUserId) {
        // The auth user this run just created, marked and profile-less: removing it is the
        // admin fallback the README allows.
        await write(
          ctx,
          {
            actor: 'service_role',
            operation: 'admin.delete_user',
            entity: `account:${account.key}`,
          },
          () => ctx.client.admin.deleteUser(rollbackUserId),
        );
        ctx.sessions.delete(account.key);
      }
      throw new OwnershipError(
        `@${account.username} is taken or reserved (usernames stay reserved after deletion). ` +
          'Use --generation N+1 for a fresh set.',
      );
    }
    throw error;
  }
}

async function ensureAccounts(ctx) {
  if (ctx.dryRun) {
    for (const account of ctx.plan.accounts) {
      await write(
        ctx,
        {
          actor: 'service_role',
          operation: 'admin.create_user',
          entity: `account:${account.key}`,
        },
        null,
      );
      await write(
        ctx,
        {
          actor: account.username,
          operation: 'create_profile',
          entity: `account:${account.key}`,
        },
        null,
      );
      ctx.sessions.set(account.key, offlineSession(account));
    }
    return;
  }

  const state = await inspectAccounts(ctx);

  for (const { account, user, session, profile } of state) {
    if (user && profile) continue;
    if (user && !profile) {
      await createProfile(ctx, session, account);
      continue;
    }
    await assertUsernameNotForeign(ctx, account);
    const created = await write(
      ctx,
      {
        actor: 'service_role',
        operation: 'admin.create_user',
        entity: `account:${account.key}`,
      },
      () =>
        ctx.client.admin.createUser({
          email: account.email,
          password: derivePassword(ctx.secret, account.username),
          email_confirm: true,
          app_metadata: {
            [MARKER_KEY]: FIXTURE_MARKER,
            qa_fixture_generation: ctx.plan.generation,
          },
          // The fallback marker, read only if app_metadata comes back without the key.
          user_metadata: { [MARKER_KEY]: FIXTURE_MARKER, display_name: account.displayName },
        }),
    );
    if (markerSource(created) === null) {
      throw new OwnershipError(
        `${account.email} was created without the fixture marker; stop and inspect it`,
      );
    }
    const fresh = await signInAs(ctx, account, created.id);
    await createProfile(ctx, fresh, account, { rollbackUserId: created.id });
  }
}

/** Verify and teardown: never create, record what is missing. */
async function attachAccounts(ctx, { required }) {
  const state = await inspectAccounts(ctx);
  for (const { account, user, profile } of state) {
    if (!user) {
      if (required) problem(ctx, `account:${account.key}`, `${account.email} does not exist`);
    } else if (!profile && required) {
      problem(ctx, `account:${account.key}`, `@${account.username} has no profile`);
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Titles and references
// ---------------------------------------------------------------------------

async function resolveTitles(ctx) {
  const probe = [...ctx.sessions.values()][0];
  for (const title of ctx.plan.titles) {
    if (!probe || probe.offline) {
      ctx.titles.set(title.key, `<${title.kind}:${title.tmdbId}>`);
      continue;
    }
    const rows = await selectRows(ctx, probe, 'media_items', {
      columns: ['id', 'kind', 'tmdb_id', 'title', 'release_date'],
      eq: { kind: title.kind, tmdb_id: title.tmdbId },
      limit: 2,
    });
    if (rows.length === 1) {
      ctx.titles.set(title.key, rows[0].id);
    } else {
      ctx.titles.set(title.key, null);
      ctx.log.record({
        actor: probe.username,
        operation: 'resolve_title',
        entity: `title:${title.key}`,
        result: rows.length === 0 ? 'missing' : 'ambiguous',
        detail: `${title.label}; entries for it are skipped`,
      });
      say(
        ctx,
        'skip    ',
        `${title.label} (${title.kind} ${title.tmdbId}) is not in this catalogue; its entries are skipped`,
      );
    }
  }
}

function entryById(ctx, id) {
  return ctx.plan.entries.find((e) => e.id === id);
}

function session(ctx, key) {
  const s = ctx.sessions.get(key);
  if (!s) throw new StepError(`no session for ${key}`);
  return s;
}

/** A fixture key's user id, or a QA handle's id looked up by search (link entries only). */
async function resolveRef(ctx, actorSession, ref) {
  const handle = externalHandle(ref);
  if (handle === null) return session(ctx, ref).id;
  if (!PROTECTED_HANDLES.includes(handle))
    throw new StepError(`@${handle} is not a QA link handle`);
  if (ctx.handles.has(handle)) return ctx.handles.get(handle);
  if (actorSession.offline) {
    ctx.handles.set(handle, `<@${handle}>`);
    return ctx.handles.get(handle);
  }
  const rows =
    (await rpcRead(ctx, actorSession, 'search_users', { p_query: handle, p_limit: 20 })) ?? [];
  const id = rows.find((row) => row.username === handle)?.id ?? null;
  ctx.handles.set(handle, id);
  return id;
}

/** Skipped when a title is missing, or when the review it depends on was skipped. */
function shouldSkip(ctx, entry) {
  const titleKey =
    entry.title ?? (entry.review ? entryById(ctx, entry.review)?.title : undefined);
  const missingTitle = titleKey !== undefined && ctx.titles.get(titleKey) === null;
  const missingReview = entry.review !== undefined && ctx.skipped.has(entry.review);
  if (missingTitle || missingReview) {
    ctx.skipped.add(entry.id);
    ctx.log.record({
      actor: entry.actor,
      operation: entry.type,
      entity: entry.id,
      result: 'skipped_missing_title',
    });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Setup: read, then write only what is missing
// ---------------------------------------------------------------------------

async function rankToCompletion(ctx, s, entry, mediaId) {
  let state = await rpcWrite(
    ctx,
    s,
    'rank_start',
    {
      p_media_item_id: mediaId,
      p_bucket: entry.bucket,
      p_operation_id: entry.operationIds.start,
    },
    entry.id,
  );
  if (ctx.dryRun) {
    await write(
      ctx,
      { actor: s.username, operation: 'rank_answer (until converged)', entity: entry.id },
      null,
    );
    return;
  }
  for (let step = 0; !state?.done; step += 1) {
    if (step > 64) throw new StepError(`${entry.id}: ranking did not converge`);
    if (!state?.session_id || !state?.pivot) {
      throw new StepError(
        `${entry.id}: rank_start/rank_answer returned no comparison (${JSON.stringify(state)})`,
      );
    }
    // Deterministic answers: 'top' wins every comparison, 'bottom' loses every one.
    const winner = entry.placement === 'top' ? mediaId : state.pivot;
    state = await rpcWrite(
      ctx,
      s,
      'rank_answer',
      {
        p_session_id: state.session_id,
        p_winner: winner,
        p_operation_id: operationId(ctx.plan.generation, entry.id, `rank_answer:${step}`),
      },
      entry.id,
    );
  }
}

const SETUP = {
  async visibility(ctx, entry) {
    const s = session(ctx, entry.actor);
    const profile = await ownProfile(ctx, s);
    if (profile?.visibility === entry.visibility) return;
    await rpcWrite(
      ctx,
      s,
      'set_profile_visibility',
      { p_operation_id: entry.operationId, p_visibility: entry.visibility },
      entry.id,
    );
  },

  async ranking(ctx, entry) {
    const s = session(ctx, entry.actor);
    const mediaId = ctx.titles.get(entry.title);
    const ranked = await ownRanking(ctx, s, mediaId);
    if (ranked && ranked.bucket !== entry.bucket) {
      return problem(
        ctx,
        entry.id,
        `ranked ${ranked.bucket}, plan says ${entry.bucket}; not overwriting`,
      );
    }
    if (!ranked) await rankToCompletion(ctx, s, entry, mediaId);

    const row = await ownUserMedia(ctx, s, mediaId);
    if (row?.watched_on === entry.watchedOn) return;
    if (row && row.watched_on != null) {
      return problem(
        ctx,
        entry.id,
        `watched ${row.watched_on}, plan says ${entry.watchedOn}; not overwriting`,
      );
    }
    await rpcWrite(
      ctx,
      s,
      'set_watch_date',
      {
        p_operation_id: entry.operationIds.watchDate,
        p_media_item_id: mediaId,
        p_watched_on: entry.watchedOn,
        p_basis: 'reader',
      },
      entry.id,
    );
  },

  async log(ctx, entry) {
    const s = session(ctx, entry.actor);
    const mediaId = ctx.titles.get(entry.title);
    const row = await ownUserMedia(ctx, s, mediaId);
    if (!row) {
      await rpcWrite(
        ctx,
        s,
        'log_title',
        {
          p_operation_id: entry.operationId,
          p_media_item_id: mediaId,
          p_bucket: entry.bucket,
          p_watched_on: entry.watchedOn,
          p_basis: 'reader',
        },
        entry.id,
      );
      return;
    }
    if (await ownRanking(ctx, s, mediaId))
      return problem(ctx, entry.id, 'ranked, but the plan says watched-unranked');
    if (row.bucket !== entry.bucket || row.watched_on !== entry.watchedOn) {
      problem(
        ctx,
        entry.id,
        `logged ${row.bucket}/${row.watched_on}, plan says ${entry.bucket}/${entry.watchedOn}`,
      );
    }
  },

  async note(ctx, entry) {
    const s = session(ctx, entry.actor);
    const mediaId = ctx.titles.get(entry.title);
    const row = await ownUserMedia(ctx, s, mediaId);
    if (!row && !ctx.dryRun)
      return problem(ctx, entry.id, 'no collection row to attach the note to');
    if (
      row &&
      row.note === entry.text &&
      row.note_visibility === entry.visibility &&
      row.note_has_spoilers === entry.spoilers
    )
      return;
    if (row && row.note != null)
      return problem(ctx, entry.id, 'a different note is already there; not overwriting');
    await rpcWrite(
      ctx,
      s,
      'save_note',
      {
        p_operation_id: entry.operationId,
        p_media_item_id: mediaId,
        p_note: entry.text,
        p_base_updated_at: row?.note_updated_at ?? null,
        p_note_visibility: entry.visibility,
        p_note_spoilers: entry.spoilers,
      },
      entry.id,
    );
  },

  async follow(ctx, entry) {
    const s = session(ctx, entry.actor);
    const targetId = await resolveRef(ctx, s, entry.target);
    if (targetId === null) {
      ctx.log.record({
        actor: s.username,
        operation: 'follow',
        entity: entry.id,
        result: 'skipped_missing_account',
      });
      return say(ctx, 'skip    ', `${entry.target} not found; ${entry.id} skipped`);
    }
    const acceptable = acceptableFollowStates(ctx, entry);
    const state = await followState(ctx, s, targetId);
    if (state?.following == null) {
      const body = await rpcWrite(
        ctx,
        s,
        'follow',
        { p_operation_id: entry.operationId, p_followee_id: targetId },
        entry.id,
      );
      if (!ctx.dryRun && body?.state && !acceptable.includes(body.state)) {
        problem(
          ctx,
          entry.id,
          `follow answered ${body.state}, expected ${acceptable.join('|')}`,
        );
      }
    } else if (!acceptable.includes(state.following)) {
      problem(ctx, entry.id, `follow is ${state.following}, expected ${acceptable.join('|')}`);
    }
  },

  async approve(ctx, entry) {
    const s = session(ctx, entry.actor);
    const requesterId = session(ctx, entry.requester).id;
    const state = await followState(ctx, s, requesterId);
    if (state?.followed_by === 'approved') return;
    if (!ctx.dryRun && state?.followed_by !== 'pending') {
      return problem(ctx, entry.id, `no pending request from ${entry.requester} to approve`);
    }
    await rpcWrite(
      ctx,
      s,
      'respond_follow_request',
      { p_operation_id: entry.operationId, p_requester_id: requesterId, p_approve: true },
      entry.id,
    );
  },

  async recommend(ctx, entry) {
    const s = session(ctx, entry.actor);
    const recipientId = await resolveRef(ctx, s, entry.recipient);
    const mediaId = ctx.titles.get(entry.title);
    if (recipientId === null) {
      ctx.log.record({
        actor: s.username,
        operation: 'recommend_title',
        entity: entry.id,
        result: 'skipped_missing_account',
      });
      return say(ctx, 'skip    ', `${entry.recipient} not found; ${entry.id} skipped`);
    }

    const existing = await sentRecommendation(ctx, s, recipientId, mediaId);
    if (!existing) {
      const body = await rpcWrite(
        ctx,
        s,
        'recommend_title',
        {
          p_operation_id: entry.operationIds.send,
          p_recipient_id: recipientId,
          p_media_item_id: mediaId,
          p_message: entry.message,
        },
        entry.id,
      );
      if (!ctx.dryRun && body?.status === 'refused') {
        if (entry.link)
          return say(
            ctx,
            'skip    ',
            `${entry.id} refused (${body.reason}); QA link left as is`,
          );
        return problem(ctx, entry.id, `recommend_title refused: ${body.reason}`);
      }
      if (
        !ctx.dryRun &&
        !entry.link &&
        body?.status === 'ok' &&
        body.delivered !== (entry.expectedState === 'delivered')
      ) {
        problem(
          ctx,
          entry.id,
          `delivered=${body.delivered}, plan expects ${entry.expectedState}`,
        );
      }
    }

    if (entry.link || entry.expectedState !== 'delivered' || entry.readState === 'unread')
      return;
    const r = session(ctx, entry.recipient);
    const row = (await recommendationsToMe(ctx, r)).find(
      (x) => x.sender_id === s.id && x.media_item_id === mediaId,
    );
    if (!row && !ctx.dryRun)
      return problem(ctx, entry.id, 'recipient does not see the delivered recommendation');
    if (entry.readState === 'opened' && (ctx.dryRun || row.opened_at == null)) {
      await rpcWrite(
        ctx,
        r,
        'mark_recommendation_opened',
        { p_recommendation_id: row?.id ?? '<rec>' },
        entry.id,
      );
    }
    if (
      entry.readState === 'seen' &&
      (ctx.dryRun || (row.seen_at == null && row.opened_at == null))
    ) {
      await rpcWrite(
        ctx,
        r,
        'mark_recommendations_seen',
        { p_operation_id: entry.operationIds.seen, p_ids: [row?.id ?? '<rec>'] },
        entry.id,
      );
    }
  },

  async helpful(ctx, entry) {
    const s = session(ctx, entry.actor);
    const review = entryById(ctx, entry.review);
    const authorId = session(ctx, review.actor).id;
    const mediaId = ctx.titles.get(review.title);
    const row = (await titleReviews(ctx, s, mediaId)).find((x) => x.user_id === authorId);
    if (!row && !ctx.dryRun)
      return problem(ctx, entry.id, `${review.id} is not visible to ${entry.actor}`);
    if (row?.viewer_helpful === true) return;
    await rpcWrite(
      ctx,
      s,
      'set_review_helpful',
      {
        p_operation_id: entry.operationId,
        p_review_id: row?.id ?? '<review>',
        p_helpful: true,
      },
      entry.id,
    );
  },
};

function acceptableFollowStates(ctx, entry) {
  if (entry.link) return ['approved', 'pending'];
  const approvedLater = ctx.plan.entries.some(
    (e) => e.type === 'approve' && e.actor === entry.target && e.requester === entry.actor,
  );
  return approvedLater ? [entry.expectedState, 'approved'] : [entry.expectedState];
}

export async function runSetup(ctx) {
  await ensureAccounts(ctx);
  await resolveTitles(ctx);
  for (const entry of ctx.plan.entries) {
    if (shouldSkip(ctx, entry)) continue;
    try {
      await SETUP[entry.type](ctx, entry);
    } catch (error) {
      if (error instanceof OwnershipError || error instanceof GuardError) throw error;
      problem(ctx, entry.id, error.message);
    }
  }
  return { writes: ctx.writes, problems: ctx.problems, skipped: [...ctx.skipped] };
}

// ---------------------------------------------------------------------------
// Verify: every scenario from the other accounts' points of view
// ---------------------------------------------------------------------------

function check(ctx, name, ok, detail) {
  ctx.checks.push({ name, ok, detail });
  if (!ok) ctx.problems.push(`${name}${detail ? ` — ${detail}` : ''}`);
  say(ctx, ok ? 'pass    ' : 'FAIL    ', name, ok || !detail ? '' : `— ${detail}`);
}

export async function runVerify(ctx) {
  const state = await attachAccounts(ctx, { required: true });
  if (state.some((s) => !s.user || !s.profile)) {
    check(ctx, 'every fixture account exists with its profile', false, 'run setup first');
    return { problems: ctx.problems, checks: ctx.checks };
  }
  const plan = ctx.plan;
  for (const { account, profile } of state) {
    check(
      ctx,
      `@${account.username} has display name "${account.displayName}"`,
      profile.display_name === account.displayName,
      profile.display_name,
    );
    check(
      ctx,
      `@${account.username} is ${account.visibility}`,
      profile.visibility === account.visibility,
      profile.visibility,
    );
  }

  await resolveTitles(ctx);
  for (const entry of plan.entries) shouldSkip(ctx, entry);
  const live = (entry) => !ctx.skipped.has(entry.id);
  const keys = plan.accounts.map((a) => a.key);
  const scores = expectedScores(plan, ctx.skipped);
  const helpful = expectedHelpfulCounts(plan, ctx.skipped);
  const follows = expectedFollowStates(plan);

  // Each author's own collection.
  for (const entry of plan.entries.filter(
    (e) => (e.type === 'ranking' || e.type === 'log') && live(e),
  )) {
    const s = session(ctx, entry.actor);
    const mediaId = ctx.titles.get(entry.title);
    const ranked = await ownRanking(ctx, s, mediaId);
    const row = await ownUserMedia(ctx, s, mediaId);
    if (entry.type === 'ranking') {
      check(
        ctx,
        `${entry.id} is ranked ${entry.bucket}`,
        ranked?.bucket === entry.bucket,
        ranked?.bucket ?? 'not ranked',
      );
    } else {
      check(
        ctx,
        `${entry.id} is logged ${entry.bucket} and unranked`,
        row?.bucket === entry.bucket && !ranked,
        `${row?.bucket} ranked=${Boolean(ranked)}`,
      );
    }
    check(
      ctx,
      `${entry.id} was watched ${entry.watchedOn}`,
      row?.watched_on === entry.watchedOn,
      row?.watched_on ?? 'no date',
    );
  }

  // Reviews and private notes, through title_reviews_v2 as every fixture account.
  const cache = new Map();
  const reviewsAs = async (viewer, mediaId) => {
    const k = `${viewer}:${mediaId}`;
    if (!cache.has(k)) cache.set(k, await titleReviews(ctx, session(ctx, viewer), mediaId));
    return cache.get(k);
  };
  const votedBy = (reviewId, viewer) =>
    plan.entries.some(
      (e) => e.type === 'helpful' && live(e) && e.review === reviewId && e.actor === viewer,
    );

  for (const entry of plan.entries.filter((e) => e.type === 'note' && live(e))) {
    const mediaId = ctx.titles.get(entry.title);
    const authorId = session(ctx, entry.actor).id;
    for (const viewer of keys) {
      const row = (await reviewsAs(viewer, mediaId)).find((x) => x.user_id === authorId);
      if (entry.visibility === 'private') {
        check(
          ctx,
          `${viewer} cannot see private ${entry.id}`,
          row === undefined,
          row ? 'VISIBLE' : '',
        );
        continue;
      }
      const visible = expectedCanView(plan, viewer, entry.actor);
      if (!visible) {
        check(
          ctx,
          `${viewer} cannot see ${entry.id} (private profile, not an approved follower)`,
          row === undefined,
          row ? 'VISIBLE' : '',
        );
        continue;
      }
      if (!row) {
        check(ctx, `${viewer} sees ${entry.id}`, false, 'missing from title_reviews_v2');
        continue;
      }
      const expectedScore = scores[entry.actor]?.[entry.title] ?? null;
      const gotScore = row.score == null ? null : Number(row.score);
      check(
        ctx,
        `${viewer} sees ${entry.id} with score ${expectedScore ?? 'null'}`,
        gotScore === expectedScore,
        String(row.score),
      );
      check(
        ctx,
        `${viewer} sees ${entry.id} text and spoiler flag`,
        row.note === entry.text && row.has_spoilers === entry.spoilers,
        `spoilers=${row.has_spoilers}`,
      );
      check(
        ctx,
        `${viewer} sees ${entry.id} helpful_count ${helpful[entry.id]}`,
        row.helpful_count === helpful[entry.id],
        String(row.helpful_count),
      );
      check(
        ctx,
        `${viewer} viewer_helpful on ${entry.id}`,
        Boolean(row.viewer_helpful) === votedBy(entry.id, viewer),
        String(row.viewer_helpful),
      );
    }
  }

  // Review counts on each title, from each public account's point of view.
  for (const title of plan.titles) {
    const mediaId = ctx.titles.get(title.key);
    if (!mediaId) continue;
    for (const viewer of keys) {
      const expectedMin = plan.entries.filter(
        (e) =>
          e.type === 'note' &&
          live(e) &&
          e.visibility === 'public' &&
          e.title === title.key &&
          expectedCanView(plan, viewer, e.actor),
      ).length;
      const count = await rpcRead(ctx, session(ctx, viewer), 'title_review_count', {
        p_media_item_id: mediaId,
      });
      check(
        ctx,
        `${viewer} counts at least ${expectedMin} reviews on ${title.label}`,
        Number(count) >= expectedMin,
        String(count),
      );
    }
  }

  // Follow states, from both ends.
  for (const [pair, expected] of Object.entries(follows)) {
    const [follower, followee] = pair.split('>');
    const out = await followState(ctx, session(ctx, follower), session(ctx, followee).id);
    const back = await followState(ctx, session(ctx, followee), session(ctx, follower).id);
    check(
      ctx,
      `${follower} → ${followee} is ${expected} (follower's view)`,
      out?.following === expected,
      String(out?.following),
    );
    check(
      ctx,
      `${follower} → ${followee} is ${expected} (followee's view)`,
      back?.followed_by === expected,
      String(back?.followed_by),
    );
  }
  // And the absence of any edge the plan did not make, between fixture accounts.
  for (const a of keys) {
    for (const b of keys) {
      if (a === b || follows[`${a}>${b}`]) continue;
      const out = await followState(ctx, session(ctx, a), session(ctx, b).id);
      check(ctx, `${a} does not follow ${b}`, out?.following == null, String(out?.following));
    }
  }

  // Recommendations: sender has it; recipient sees delivered with the right read state, or
  // pending as a request and not in Sent to You.
  for (const entry of plan.entries.filter(
    (e) => e.type === 'recommend' && !e.link && live(e),
  )) {
    const s = session(ctx, entry.actor);
    const r = session(ctx, entry.recipient);
    const mediaId = ctx.titles.get(entry.title);
    check(
      ctx,
      `${entry.id} exists for the sender`,
      Boolean(await sentRecommendation(ctx, s, r.id, mediaId)),
    );
    const delivered = (await recommendationsToMe(ctx, r)).find(
      (x) => x.sender_id === s.id && x.media_item_id === mediaId,
    );
    const pending = (await recommendationRequests(ctx, r)).find(
      (x) => x.sender_id === s.id && x.media_item_id === mediaId,
    );
    if (entry.expectedState === 'pending') {
      check(
        ctx,
        `${entry.id} is a pending request for the recipient`,
        Boolean(pending) && !delivered,
      );
      continue;
    }
    check(ctx, `${entry.id} is delivered to the recipient`, Boolean(delivered) && !pending);
    if (!delivered) continue;
    const opened = delivered.opened_at != null;
    const seen = delivered.seen_at != null;
    const readOk =
      entry.readState === 'opened'
        ? opened
        : entry.readState === 'seen'
          ? seen && !opened
          : !opened && !seen;
    check(ctx, `${entry.id} is ${entry.readState}`, readOk, `opened=${opened} seen=${seen}`);
  }

  // Links, only when asked; never read as the QA account.
  if (plan.linkQaAccounts) {
    for (const entry of plan.entries.filter((e) => e.link && e.type === 'follow')) {
      const s = session(ctx, entry.actor);
      const id = await resolveRef(ctx, s, entry.target);
      if (id === null) {
        check(ctx, `${entry.id}: ${entry.target} exists`, false, 'not found');
        continue;
      }
      const out = await followState(ctx, s, id);
      check(
        ctx,
        `${entry.id} is approved or pending`,
        ['approved', 'pending'].includes(out?.following),
        String(out?.following),
      );
    }
  }

  return { problems: ctx.problems, checks: ctx.checks };
}

// ---------------------------------------------------------------------------
// Teardown: fixture-owned accounts only, then prove nothing marked remains
// ---------------------------------------------------------------------------

export async function runTeardown(ctx) {
  if (ctx.dryRun) {
    for (const account of ctx.plan.accounts) {
      await write(
        ctx,
        {
          actor: account.username,
          operation: 'delete_account',
          entity: `account:${account.key}`,
        },
        null,
      );
    }
    return { writes: 0, problems: [] };
  }

  // Ownership of every account first. One mismatch stops the run before anything is deleted.
  const state = await attachAccounts(ctx, { required: false });

  for (const { account, user, session: s, profile } of state) {
    if (!user) {
      ctx.log.record({
        actor: 'fixture',
        operation: 'delete_account',
        entity: `account:${account.key}`,
        result: 'absent',
      });
      say(ctx, 'absent  ', account.email);
      continue;
    }
    if (profile) {
      const body = await rpcWrite(
        ctx,
        s,
        'delete_account',
        { p_confirmation: account.username },
        `account:${account.key}`,
      );
      if (!['ok', 'already_applied'].includes(body?.status))
        problem(
          ctx,
          `account:${account.key}`,
          `delete_account answered ${JSON.stringify(body)}`,
        );
    } else {
      // The one admin delete: a marked auth user with no profile, which delete_account
      // treats as mid-signup and leaves alone.
      await write(
        ctx,
        {
          actor: 'service_role',
          operation: 'admin.delete_user',
          entity: `account:${account.key}`,
        },
        () => ctx.client.admin.deleteUser(user.id),
      );
    }
  }

  for (const account of ctx.plan.accounts) {
    const left = await ctx.client.admin.findUsersByEmail(account.email);
    check(ctx, `${account.email} is gone`, left.length === 0, `${left.length} remain`);
  }
  const marked = await ctx.client.admin.listMarkedUsers(MARKER_KEY, FIXTURE_MARKER);
  check(
    ctx,
    `no auth user marked ${MARKER_KEY}=${FIXTURE_MARKER} remains`,
    marked.length === 0,
    marked
      .map((u) => `${u.email} (generation ${u.app_metadata?.qa_fixture_generation ?? '?'})`)
      .join(', '),
  );
  return { writes: ctx.writes, problems: ctx.problems };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: node scripts/qa-fixtures/social/fixture.mjs setup|verify|teardown [--dry-run] [--log <path>] [--link-qa-accounts] [--generation N]`;

function printPlan(plan, out) {
  out.log(
    `plan: marker ${plan.marker}, generation ${plan.generation}, ${plan.entries.length} entries` +
      `${plan.linkQaAccounts ? ', QA links ON' : ', QA links off'}`,
  );
  for (const a of plan.accounts)
    out.log(`  account ${a.key}  @${a.username}  ${a.email}  ${a.visibility}`);
  for (const t of plan.titles) out.log(`  title   ${t.key}  ${t.kind} ${t.tmdbId}  ${t.label}`);
}

/**
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, deps = {}) {
  const {
    env = defaultEnv(),
    fetchImpl,
    out = console,
    makeClient = createHttpClient,
    logSink,
    clock,
  } = deps;

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    out.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    out.log(USAGE);
    return 0;
  }

  // 1. THE GUARD, on the URL alone. No key has been read yet.
  const rawUrl = env.EXPO_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL;
  let target;
  try {
    target =
      args.dryRun && !rawUrl
        ? { kind: 'none', ref: '(no target)', origin: null }
        : classifyTarget(rawUrl);
  } catch (error) {
    out.error(error.message);
    return 2;
  }

  const plan = buildPlan({ generation: args.generation, linkQaAccounts: args.linkQaAccounts });
  const logPath = args.logPath ?? defaultLogPath(args.command, clock ? clock() : new Date());
  let ctx;
  const log = createMutationLog({
    command: args.command,
    target: target.ref,
    path: logPath,
    sink: logSink,
    clock,
    secrets: () => ctx?.secrets() ?? [],
  });

  try {
    if (args.dryRun) {
      // No connection, no keys. Every write is printed as if the target were empty.
      ctx = createContext({
        plan,
        client: null,
        log,
        command: args.command,
        dryRun: true,
        out,
      });
      printPlan(plan, out);
      out.log(`dry run against ${target.ref}: nothing is sent`);
      if (args.command === 'setup') await runSetup(ctx);
      else await runTeardown(ctx);
      out.log(`dry run: ${log.lines.length} log lines${log.path ? ` → ${log.path}` : ''}`);
      return 0;
    }

    // 2. The anon key, and the database's own answer.
    const anonKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!anonKey) {
      out.error('Need EXPO_PUBLIC_SUPABASE_ANON_KEY');
      return 2;
    }
    const probe = makeClient({ origin: target.origin, anonKey, fetchImpl });
    const guarded = await guardTarget(rawUrl, () => probe.environmentName());

    // 3. Only now the service-role key and the fixture secret.
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
    const secret = env.QA_FIXTURE_PASSWORD;
    if (!serviceKey || !secret) {
      out.error('Need SUPABASE_SERVICE_ROLE_KEY and QA_FIXTURE_PASSWORD');
      return 2;
    }
    const client = makeClient({ origin: guarded.origin, anonKey, serviceKey, fetchImpl });
    ctx = createContext({ plan, client, log, command: args.command, secret, out });
    const baseSecrets = ctx.secrets.bind(ctx);
    ctx.secrets = () => [...baseSecrets(), anonKey, serviceKey];

    out.log(
      `${args.command} → ${guarded.kind} ${guarded.ref} (environment_name = ${guarded.environment}); log → ${log.path ?? '(sink)'}`,
    );
    if (args.command === 'setup') await runSetup(ctx);
    else if (args.command === 'verify') await runVerify(ctx);
    else await runTeardown(ctx);

    out.log(`${args.command}: ${ctx.writes} writes, ${ctx.problems.length} problems`);
    return ctx.problems.length === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof GuardError || error instanceof OwnershipError) {
      log.record({
        actor: 'fixture',
        operation: args.command,
        entity: 'run',
        result: 'refused',
        detail: error.message,
      });
      out.error(`REFUSED: ${error.message}`);
      return 2;
    }
    log.record({
      actor: 'fixture',
      operation: args.command,
      entity: 'run',
      result: 'error',
      detail: error.message,
    });
    out.error(`ERROR: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main(process.argv.slice(2));
  // A beat before exiting, for the keep-alive socket reason two-user-acceptance.mjs records.
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.exit(code);
}
