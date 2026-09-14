/**
 * The staging QA cohort: synthetic social accounts that give a fresh preview account's
 * social surfaces something real to show.
 *
 *   node scripts/staging/qa-cohort.mjs seed [--dry-run]
 *   node scripts/staging/qa-cohort.mjs verify
 *   node scripts/staging/qa-cohort.mjs reset
 *
 * STAGING ONLY. The project ref is a constant in this file. There is no flag, no
 * environment variable and no `.env` read that can point it anywhere else. Keys come
 * from the logged-in Supabase CLI at run time and live only in this process's memory.
 * See docs/release/staging-qa-cohort.md for the guarantees and what each surface shows.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  COHORT_MARKER,
  PROBE_MARKER,
  MAX_GENERATION,
  buildPlan,
  operationId,
  summarize,
  predictTasteMatch,
  raterCounts,
} from './qa-cohort-plan.mjs';

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

export const STAGING_REF = 'fjxhcbowoxuzulwirzyr';
export const PRODUCTION_REF = 'abheeqyjzekiowkztfxv';
export const STAGING_HOST = `${STAGING_REF}.supabase.co`;
export const STAGING_URL = `https://${STAGING_HOST}`;

/** Throws unless `url` is exactly the staging project over https. Parsed, not matched. */
export function assertStagingUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Refusing: ${String(url)} is not a URL.`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.host !== STAGING_HOST ||
    parsed.hostname !== STAGING_HOST ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    throw new Error(`Refusing: ${parsed.protocol}//${parsed.host} is not https://${STAGING_HOST}.`);
  }
  if (parsed.href.includes(PRODUCTION_REF)) {
    throw new Error('Refusing: the request names the production project.');
  }
  return parsed;
}

/** The payload of a legacy Supabase JWT key, decoded without verification. */
export function jwtClaims(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Throws unless the key is a legacy JWT for the staging project with the expected role. */
export function assertStagingKey(key, expectedRole) {
  const claims = jwtClaims(key);
  if (!claims) throw new Error(`Refusing: the ${expectedRole} key is not a decodable JWT.`);
  if (claims.ref === PRODUCTION_REF) {
    throw new Error(`Refusing: the ${expectedRole} key belongs to the production project.`);
  }
  if (claims.ref !== STAGING_REF) {
    throw new Error(`Refusing: the ${expectedRole} key is not for ${STAGING_REF}.`);
  }
  if (claims.role !== expectedRole) {
    throw new Error(`Refusing: expected a ${expectedRole} key, got role ${String(claims.role)}.`);
  }
  return claims;
}

/** Throws unless the repo's own lane config still calls the staging ref nonprod. */
export function assertLaneConfig({ LANE_BACKENDS, environmentForRef } = {}) {
  if (!LANE_BACKENDS || !Array.isArray(LANE_BACKENDS.preview) || LANE_BACKENDS.preview[0] !== STAGING_REF) {
    throw new Error(`Refusing: config/backends.cjs preview lane is not ${STAGING_REF}.`);
  }
  if (typeof environmentForRef !== 'function' || environmentForRef(STAGING_REF) !== 'nonprod') {
    throw new Error(`Refusing: config/production-lane.cjs does not declare ${STAGING_REF} nonprod.`);
  }
  if (environmentForRef(PRODUCTION_REF) === 'nonprod') {
    throw new Error('Refusing: the lane config calls production nonprod, so it cannot be trusted.');
  }
}

/** Throws unless environment_name() answered exactly 'nonprod'. */
export function assertEnvironmentAnswer(status, body) {
  if (status !== 200 || body !== 'nonprod') {
    throw new Error(`Refusing: environment_name() answered ${JSON.stringify(body)} (${status}), not nonprod.`);
  }
}

export const COHORT_EMAIL_PATTERN = /^qa-cohort\+([a-z0-9_]{3,30})@example\.com$/;

/**
 * Whether an auth user (with its profile) may be deleted by reset. ALL must hold: the
 * app_metadata marker, the cohort email pattern, and a profile on the same id whose `qa_`
 * username is the name the email carries. Anything else is somebody's account.
 */
export function isResettableCohortAccount(user, profile) {
  if (!user || typeof user !== 'object' || typeof user.id !== 'string') return false;
  const marker = user.app_metadata?.qa_cohort;
  if (marker !== COHORT_MARKER && marker !== PROBE_MARKER) return false;
  const match = typeof user.email === 'string' ? COHORT_EMAIL_PATTERN.exec(user.email) : null;
  if (!match) return false;
  if (!profile || typeof profile.username !== 'string' || profile.id !== user.id) return false;
  if (!profile.username.startsWith('qa_')) return false;
  if (marker === PROBE_MARKER && !match[1].startsWith('probe_')) return false;
  if (marker === COHORT_MARKER && match[1].startsWith('probe_')) return false;
  return profile.username === `qa_${match[1]}`;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function fetchKeysFromCli() {
  // One fixed command string: the ref is this file's constant, nothing is interpolated
  // from input. stderr is discarded, stdout is parsed and never echoed.
  const out = spawnSync(`npx supabase@latest projects api-keys --project-ref ${STAGING_REF} -o json`, {
    shell: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
  });
  if (out.status !== 0 || typeof out.stdout !== 'string') {
    throw new Error('Could not read staging keys from the Supabase CLI (is it logged in?).');
  }
  let list;
  try {
    list = JSON.parse(out.stdout.slice(out.stdout.indexOf('[')));
  } catch {
    throw new Error('The Supabase CLI key listing was not JSON.');
  }
  const pick = (name) => list.find((k) => k.type === 'legacy' && k.name === name)?.api_key;
  const anon = pick('anon');
  const service = pick('service_role');
  if (!anon || !service) throw new Error('The CLI listing has no legacy anon/service_role keys.');
  return { anon, service };
}

/** Every request goes through here, and the host is re-asserted on each one. */
async function stagingFetch(path, init) {
  const target = assertStagingUrl(`${STAGING_URL}${path}`);
  return fetch(target, init);
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const describe = (body) =>
  typeof body === 'string'
    ? body.slice(0, 200)
    : JSON.stringify(body && (body.message || body.msg || body.error_code) ? {
        code: body.code ?? body.error_code, message: body.message ?? body.msg, hint: body.hint,
      } : body)?.slice(0, 300);

export async function connect() {
  const require = createRequire(import.meta.url);
  assertLaneConfig({
    ...require('../../config/backends.cjs'),
    ...require('../../config/production-lane.cjs'),
  });
  assertStagingUrl(STAGING_URL);

  const { anon, service } = fetchKeysFromCli();
  assertStagingKey(anon, 'anon');
  assertStagingKey(service, 'service_role');

  const api = {
    async rest(token, path, init = {}) {
      const res = await stagingFetch(`/rest/v1/${path}`, {
        ...init,
        headers: {
          apikey: anon,
          Authorization: `Bearer ${token ?? anon}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
      return { status: res.status, ok: res.ok, body: await readBody(res) };
    },
    rpc(token, name, args = {}) {
      return api.rest(token, `rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });
    },
    async service(path, init = {}) {
      const res = await stagingFetch(path, {
        ...init,
        headers: {
          apikey: service,
          Authorization: `Bearer ${service}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
      return { status: res.status, ok: res.ok, body: await readBody(res), headers: res.headers };
    },
    /** Service-role GET that must succeed and return an array. */
    async rows(path) {
      const r = await api.service(`/rest/v1/${path}`);
      if (r.status !== 200 || !Array.isArray(r.body)) {
        throw new Error(`read ${path.split('?')[0]} failed: ${r.status} ${describe(r.body)}`);
      }
      return r.body;
    },
    async count(table, filter) {
      const r = await api.service(`/rest/v1/${table}?${filter}&select=*&limit=1`, {
        headers: { Prefer: 'count=exact' },
      });
      const range = r.headers.get('content-range') ?? '';
      const total = Number(range.split('/')[1]);
      if (r.status >= 300 || !Number.isFinite(total)) {
        throw new Error(`count ${table} failed: ${r.status} ${describe(r.body)}`);
      }
      return total;
    },
    async signIn(email, password) {
      const res = await stagingFetch('/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { apikey: anon, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body = await readBody(res);
      if (!res.ok || !body?.access_token) {
        throw new Error(`sign-in failed for ${email}: ${res.status} ${describe(body)}`);
      }
      return body.access_token;
    },
  };

  // The fourth agreement: the database's own name for itself, before any write.
  const env = await api.rpc(null, 'environment_name', {});
  assertEnvironmentAnswer(env.status, env.body);
  return api;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const freshPassword = () => `Qa-${randomBytes(24).toString('base64url')}-9z`;
const inList = (ids) => `in.(${ids.join(',')})`;

/** Resolves every plan title to a media_items row, or throws naming what is missing. */
async function resolveTitles(api, plan) {
  const movieSpecs = plan.titles.filter((t) => t.kind === 'movie');
  const seasonSpecs = plan.titles.filter((t) => t.kind === 'season');
  const seriesSpecs = plan.titles.filter((t) => t.kind === 'series');
  const seriesTmdb = [...new Set([...seasonSpecs, ...seriesSpecs].map((t) => t.tmdbId))];

  const movies = await api.rows(
    `media_items?kind=eq.movie&tmdb_id=${inList(movieSpecs.map((t) => t.tmdbId))}&select=id,tmdb_id,title,poster_path`,
  );
  const series = await api.rows(
    `media_items?kind=eq.series&tmdb_id=${inList(seriesTmdb)}&select=id,tmdb_id,title,poster_path`,
  );
  const seriesByTmdb = new Map(series.map((s) => [s.tmdb_id, s]));
  const parentIds = [...new Set(seasonSpecs.map((t) => seriesByTmdb.get(t.tmdbId)?.id).filter(Boolean))];
  const seasons = parentIds.length
    ? await api.rows(
        `media_items?kind=eq.season&parent_id=${inList(parentIds)}&select=id,parent_id,season_number,title,poster_path`,
      )
    : [];

  const byKey = new Map();
  const missing = [];
  const posterless = [];
  for (const t of plan.titles) {
    let row = null;
    if (t.kind === 'movie') row = movies.find((m) => m.tmdb_id === t.tmdbId);
    if (t.kind === 'series') row = seriesByTmdb.get(t.tmdbId);
    if (t.kind === 'season') {
      const parent = seriesByTmdb.get(t.tmdbId);
      row = parent && seasons.find((s) => s.parent_id === parent.id && s.season_number === t.season);
      if (row) row = { ...row, title: `${parent.title} S${t.season}` };
    }
    if (!row) {
      missing.push(`${t.key} (${t.kind} tmdb ${t.tmdbId}${t.season !== undefined ? ` season ${t.season}` : ''})`);
      continue;
    }
    if (!row.poster_path) posterless.push(t.key);
    byKey.set(t.key, { ...t, id: row.id, title: row.title });
  }
  if (missing.length) {
    throw new Error(
      `The staging catalogue is missing ${missing.length} planned title(s); refusing to seed. ` +
        `This script never calls the TMDB adapter. Missing:\n  ${missing.join('\n  ')}`,
    );
  }
  if (posterless.length) console.log(`note: planned titles without a poster: ${posterless.join(', ')}`);
  const keyById = new Map([...byKey.values()].map((t) => [t.id, t.key]));
  return { byKey, keyById };
}

async function listAuthUsers(api) {
  const all = [];
  for (let page = 1; page < 200; page += 1) {
    const r = await api.service(`/auth/v1/admin/users?page=${page}&per_page=200`);
    if (r.status !== 200) throw new Error(`admin user listing failed: ${r.status} ${describe(r.body)}`);
    const users = Array.isArray(r.body?.users) ? r.body.users : [];
    all.push(...users);
    if (users.length < 200) break;
  }
  return all;
}

async function profilesFor(api, ids) {
  if (!ids.length) return new Map();
  const rows = await api.rows(`profiles?id=${inList(ids)}&select=id,username,display_name,visibility,status`);
  return new Map(rows.map((p) => [p.id, p]));
}

/** Cohort users as they exist now, keyed by plan username. Refuses unmarked look-alikes. */
async function findCohort(api, plan) {
  const users = await listAuthUsers(api);
  const byEmail = new Map(users.map((u) => [String(u.email ?? '').toLowerCase(), u]));
  const found = new Map();
  for (const pu of plan.users) {
    const u = byEmail.get(pu.email);
    if (!u) continue;
    if (u.app_metadata?.qa_cohort !== COHORT_MARKER) {
      throw new Error(`${pu.email} exists without the qa_cohort marker; refusing to touch it.`);
    }
    found.set(pu.username, u);
  }
  const profiles = await profilesFor(api, [...found.values()].map((u) => u.id));
  return { users, found, profiles };
}

/** Throws unless the username is neither in use nor reserved by a deleted profile. */
async function assertNameFree(api, pu) {
  const taken = await api.rows(`profiles?username=eq.${pu.username}&select=id`);
  const reserved = await api.rows(`username_history?username=eq.${pu.username}&select=username`);
  if (taken.length || reserved.length) {
    throw new Error(
      `${pu.username} is ${taken.length ? 'taken' : 'reserved by a deleted profile'}; refusing to create ${pu.email}. ` +
        'A deleted username is reserved for ever, so run reset and let seed pick the next generation.',
    );
  }
}

/**
 * Which generation of the cohort is on staging (see nameTag in the plan). A generation is
 * live when any of its accounts exists with its profile. With none live, seed takes the
 * first generation whose eight emails and usernames are all unused and unreserved.
 */
async function resolveGeneration(api, { forSeed }) {
  const users = await listAuthUsers(api);
  const emails = new Set(users.map((u) => String(u.email ?? '').toLowerCase()));
  const marked = users.filter((u) => u.app_metadata?.qa_cohort === COHORT_MARKER);
  const profiles = await profilesFor(api, marked.map((u) => u.id));
  const live = [];
  for (let g = 1; g <= MAX_GENERATION; g += 1) {
    const plan = buildPlan({ generation: g });
    const hits = plan.users.filter((pu) => {
      const u = marked.find((m) => String(m.email).toLowerCase() === pu.email);
      return u && profiles.get(u.id)?.username === pu.username;
    });
    if (hits.length) live.push({ generation: g, plan });
  }
  if (live.length > 1) {
    throw new Error(`more than one live cohort generation (${live.map((l) => l.generation).join(', ')}); run reset first.`);
  }
  if (live.length === 1) return { plan: live[0].plan, live: true };
  if (!forSeed) return { plan: null, live: false };

  for (let g = 1; g <= MAX_GENERATION; g += 1) {
    const plan = buildPlan({ generation: g });
    if (plan.users.some((pu) => emails.has(pu.email))) continue;
    const names = plan.users.map((pu) => pu.username);
    const taken = await api.rows(`profiles?username=${inList(names)}&select=username`);
    const reserved = await api.rows(`username_history?username=${inList(names)}&select=username`);
    if (!taken.length && !reserved.length) return { plan, live: false };
  }
  throw new Error(`no free cohort generation up to ${MAX_GENERATION}.`);
}

async function snapshotCounts(api, ids) {
  const counts = { cohort_users: ids.length };
  if (!ids.length) {
    for (const k of ['profiles', 'rankings', 'comparisons', 'watchlist', 'follows', 'recommendations', 'feed_events', 'notifications_sent']) counts[k] = 0;
    return counts;
  }
  const f = inList(ids);
  counts.profiles = await api.count('profiles', `id=${f}`);
  counts.rankings = await api.count('rankings', `user_id=${f}`);
  counts.comparisons = await api.count('comparisons', `user_id=${f}`);
  counts.watchlist = await api.count('watchlist', `user_id=${f}`);
  counts.follows = await api.count('follows', `follower_id=${f}`);
  counts.recommendations = await api.count('title_recommendations', `sender_id=${f}`);
  counts.feed_events = await api.count('feed_events', `actor_id=${f}`);
  counts.notifications_sent = await api.count('notifications', `actor_id=${f}`);
  return counts;
}

function printCounts(label, counts) {
  console.log(`\n${label}`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(20)} ${v}`);
}

/**
 * Ranks one title to completion through rank_start / rank_answer, answering each
 * comparison from the intended band order. Binary insertion over a consistent total
 * order lands every title exactly where the plan puts it.
 */
async function rankToCompletion(api, token, { username, idOf, keyById, band, key, bucket }, { ledger = true } = {}) {
  const subject = idOf(key);
  const order = (k) => {
    const i = band.indexOf(k);
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  const start = await api.rpc(token, 'rank_start', {
    p_media_item_id: subject,
    p_bucket: bucket,
    p_operation_id: ledger ? operationId(COHORT_MARKER, username, 'rank_start', key) : null,
  });
  if (start.status !== 200) throw new Error(`rank_start ${key}: ${start.status} ${describe(start.body)}`);
  let state = start.body;
  if (state?.already_applied) return { ok: false, reason: 'already_applied without a stored answer' };

  for (let step = 0; state && !state.done; step += 1) {
    if (step > 40) return { ok: false, reason: 'did not converge' };
    const pivotKey = keyById.get(state.pivot);
    const winner = pivotKey !== undefined && order(pivotKey) < order(key) ? state.pivot : subject;
    const answer = await api.rpc(token, 'rank_answer', {
      p_session_id: state.session_id,
      p_winner: winner,
      p_operation_id: ledger ? operationId(COHORT_MARKER, username, 'rank_answer', key, state.session_id, step) : null,
    });
    if (answer.status !== 200) return { ok: false, reason: `rank_answer ${answer.status} ${describe(answer.body)}` };
    state = answer.body;
  }
  return { ok: Boolean(state?.done), reason: state?.done ? null : 'no placement', state };
}

// ---------------------------------------------------------------------------
// SEED
// ---------------------------------------------------------------------------

async function ensureAccount(api, pu, existing, marker) {
  const password = freshPassword();
  let user = existing;
  if (!user) {
    await assertNameFree(api, pu);
    const created = await api.service('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email: pu.email,
        password,
        email_confirm: true,
        app_metadata: { qa_cohort: marker },
      }),
    });
    if (!created.ok || !created.body?.id) {
      throw new Error(`could not create ${pu.email}: ${created.status} ${describe(created.body)}`);
    }
    user = created.body;
  } else {
    const updated = await api.service(`/auth/v1/admin/users/${user.id}`, {
      method: 'PUT',
      body: JSON.stringify({ password }),
    });
    if (!updated.ok) throw new Error(`could not refresh ${pu.email}: ${updated.status} ${describe(updated.body)}`);
  }
  if (user.app_metadata?.qa_cohort !== marker) {
    throw new Error(`${pu.email} does not carry qa_cohort=${marker}; refusing.`);
  }
  const token = await api.signIn(pu.email, password);

  let profile = (await profilesFor(api, [user.id])).get(user.id);
  let createdProfile = false;
  if (!profile) {
    const made = await api.rpc(token, 'create_profile', {
      p_username: pu.username,
      p_display_name: pu.displayName,
      p_date_of_birth: '1990-01-01',
    });
    if (made.status !== 200 || made.body?.ok === false) {
      throw new Error(`create_profile ${pu.username}: ${made.status} ${describe(made.body)}`);
    }
    profile = (await profilesFor(api, [user.id])).get(user.id);
    createdProfile = true;
  }
  if (!profile || profile.username !== pu.username) {
    throw new Error(`${pu.email} has profile ${profile?.username ?? '(none)'}, expected ${pu.username}; refusing.`);
  }
  return { id: user.id, token, user, profile, createdProfile, createdUser: !existing };
}

async function seedRankings(api, pu, account, titles) {
  const existing = await api.rows(`rankings?user_id=eq.${account.id}&select=media_item_id,bucket,position,category`);
  const have = new Map(existing.map((r) => [r.media_item_id, r]));
  let placed = 0;
  let skipped = 0;
  const idOf = (k) => titles.byKey.get(k).id;
  for (const r of pu.rankings) {
    if (have.has(idOf(r.key))) {
      skipped += 1;
      continue;
    }
    const ctx = {
      username: pu.username,
      idOf,
      keyById: titles.keyById,
      band: pu.bands[r.category][r.bucket],
      key: r.key,
      bucket: r.bucket,
    };
    let result = await rankToCompletion(api, account.token, ctx);
    if (!result.ok) {
      // A replayed ledger answer can name a session that no longer exists. Re-read, and
      // only if the title is still unranked, go again without the ledger.
      const again = await api.rows(`rankings?user_id=eq.${account.id}&media_item_id=eq.${idOf(r.key)}&select=media_item_id`);
      if (!again.length) result = await rankToCompletion(api, account.token, ctx, { ledger: false });
      else result = { ok: true };
    }
    if (!result.ok) throw new Error(`${pu.username} could not rank ${r.key}: ${result.reason}`);
    placed += 1;
  }

  const after = await api.rows(`rankings?user_id=eq.${account.id}&select=media_item_id,bucket,position,category`);
  const byId = new Map(after.map((r) => [r.media_item_id, r]));
  const drift = [];
  for (const r of pu.rankings) {
    const got = byId.get(idOf(r.key));
    if (!got) drift.push(`${r.key} missing`);
    else if (got.bucket !== r.bucket || got.position !== r.position) {
      drift.push(`${r.key} ${got.bucket}#${got.position} (planned ${r.bucket}#${r.position})`);
    }
  }
  if (after.length !== pu.rankings.length) drift.push(`${after.length} rankings, planned ${pu.rankings.length}`);
  return { placed, skipped, drift };
}

async function seedWatchlist(api, pu, account, titles) {
  const existing = new Set(
    (await api.rows(`watchlist?user_id=eq.${account.id}&select=media_item_id`)).map((w) => w.media_item_id),
  );
  let added = 0;
  let skipped = 0;
  for (const key of pu.watchlist) {
    const id = titles.byKey.get(key).id;
    if (existing.has(id)) {
      skipped += 1;
      continue;
    }
    const r = await api.rpc(account.token, 'set_watchlist', {
      p_operation_id: operationId(COHORT_MARKER, pu.username, 'watchlist', key),
      p_media_item_id: id,
      p_present: true,
    });
    if (r.status !== 200) throw new Error(`set_watchlist ${pu.username} ${key}: ${r.status} ${describe(r.body)}`);
    added += 1;
  }
  const after = new Set(
    (await api.rows(`watchlist?user_id=eq.${account.id}&select=media_item_id`)).map((w) => w.media_item_id),
  );
  const drift = pu.watchlist.filter((k) => !after.has(titles.byKey.get(k).id));
  if (after.size !== pu.watchlist.length) drift.push(`${after.size} rows, planned ${pu.watchlist.length}`);
  return { added, skipped, drift };
}

async function seed({ dryRun }) {
  const api = await connect();
  console.log(`staging ${STAGING_HOST}: environment_name() = nonprod`);
  const { plan, live } = await resolveGeneration(api, { forSeed: true });
  console.log(`${live ? 'live' : 'new'} cohort generation ${plan.generation}\n`);
  console.log(summarize(plan));
  const titles = await resolveTitles(api, plan);
  console.log(`resolved ${titles.byKey.size} planned titles on staging`);

  const cohort = await findCohort(api, plan);
  const ids = [...cohort.found.values()].map((u) => u.id);
  const before = await snapshotCounts(api, ids);
  printCounts('BEFORE', before);

  if (dryRun) {
    console.log('\n--dry-run: nothing written. Per user, what seed would do:');
    for (const pu of plan.users) {
      const u = cohort.found.get(pu.username);
      if (!u) {
        console.log(`  ${pu.username.padEnd(20)} create account + profile, rank ${pu.rankings.length}, watchlist ${pu.watchlist.length}, follow ${pu.follows.length}`);
        continue;
      }
      const ranked = new Set((await api.rows(`rankings?user_id=eq.${u.id}&select=media_item_id`)).map((r) => r.media_item_id));
      const saved = new Set((await api.rows(`watchlist?user_id=eq.${u.id}&select=media_item_id`)).map((r) => r.media_item_id));
      const toRank = pu.rankings.filter((r) => !ranked.has(titles.byKey.get(r.key).id)).length;
      const toSave = pu.watchlist.filter((k) => !saved.has(titles.byKey.get(k).id)).length;
      console.log(`  ${pu.username.padEnd(20)} exists${cohort.profiles.has(u.id) ? '' : ' (no profile)'}; rank ${toRank} more, watchlist ${toSave} more`);
    }
    return;
  }

  // Accounts and profiles, one at a time (auth admin is not worth racing).
  const accounts = new Map();
  for (const pu of plan.users) {
    const acct = await ensureAccount(api, pu, cohort.found.get(pu.username), COHORT_MARKER);
    accounts.set(pu.username, acct);
    console.log(`account ${pu.username.padEnd(20)} ${acct.createdUser ? 'created' : 'exists'}${acct.createdProfile ? ', profile created' : ''}`);
  }
  const cohortIds = new Set([...accounts.values()].map((a) => a.id));
  const assertCohortId = (id, what) => {
    if (!cohortIds.has(id)) throw new Error(`Refusing: ${what} targets a non-cohort account.`);
  };

  // Rankings and watchlists: each user's own writes, users in parallel.
  const problems = [];
  await Promise.all(
    plan.users.map(async (pu) => {
      const acct = accounts.get(pu.username);
      const rk = await seedRankings(api, pu, acct, titles);
      const wl = await seedWatchlist(api, pu, acct, titles);
      console.log(
        `collection ${pu.username.padEnd(20)} rankings +${rk.placed} (skipped ${rk.skipped})  watchlist +${wl.added} (skipped ${wl.skipped})`,
      );
      for (const d of rk.drift) problems.push(`${pu.username} ranking drift: ${d}`);
      for (const d of wl.drift) problems.push(`${pu.username} watchlist drift: ${d}`);
    }),
  );

  // Follows.
  const idsNow = [...cohortIds];
  const follows = await api.rows(`follows?follower_id=${inList(idsNow)}&select=follower_id,followee_id,state`);
  const haveFollow = new Set(follows.map((f) => `${f.follower_id}>${f.followee_id}`));
  let followed = 0;
  for (const pu of plan.users) {
    const me = accounts.get(pu.username);
    for (const target of pu.follows) {
      const them = accounts.get(target);
      assertCohortId(me.id, 'follow (follower)');
      assertCohortId(them?.id, 'follow');
      if (haveFollow.has(`${me.id}>${them.id}`)) continue;
      const r = await api.rpc(me.token, 'follow', {
        p_operation_id: operationId(COHORT_MARKER, pu.username, 'follow', target),
        p_followee_id: them.id,
      });
      if (r.status !== 200) throw new Error(`follow ${pu.username} -> ${target}: ${r.status} ${describe(r.body)}`);
      followed += 1;
    }
  }
  console.log(`follows +${followed} (planned ${plan.users.reduce((s, u) => s + u.follows.length, 0)})`);

  // Recommendations.
  const recs = await api.rows(`title_recommendations?sender_id=${inList(idsNow)}&select=sender_id,recipient_id,media_item_id,state`);
  const haveRec = new Set(recs.map((r) => `${r.sender_id}>${r.recipient_id}>${r.media_item_id}`));
  let sent = 0;
  for (const rec of plan.recommendations) {
    const from = accounts.get(rec.from);
    const to = accounts.get(rec.to);
    assertCohortId(from.id, 'recommendation (sender)');
    assertCohortId(to?.id, 'recommendation');
    const mediaId = titles.byKey.get(rec.title).id;
    if (haveRec.has(`${from.id}>${to.id}>${mediaId}`)) continue;
    const r = await api.rpc(from.token, 'recommend_title', {
      p_operation_id: operationId(COHORT_MARKER, rec.from, 'recommend', rec.to, rec.title),
      p_recipient_id: to.id,
      p_media_item_id: mediaId,
    });
    if (r.status !== 200 || !['ok', 'already_applied'].includes(r.body?.status)) {
      throw new Error(`recommend ${rec.from} -> ${rec.to} ${rec.title}: ${r.status} ${describe(r.body)}`);
    }
    sent += 1;
  }
  console.log(`recommendations +${sent} (planned ${plan.recommendations.length})`);

  const after = await snapshotCounts(api, idsNow);
  printCounts('AFTER', after);
  if (problems.length) {
    console.log('\nDRIFT (the database differs from the plan):');
    for (const p of problems) console.log(`  ${p}`);
    process.exitCode = 1;
  } else {
    console.log('\nseed complete: every planned ranking position, watchlist row, follow and recommendation is present.');
  }
}

// ---------------------------------------------------------------------------
// RESET
// ---------------------------------------------------------------------------

/** Deletes one selector-approved account: delete_account as the user, then confirm. */
async function deleteCohortAccount(api, user, profile) {
  if (!isResettableCohortAccount(user, profile)) {
    throw new Error(`Refusing to delete ${user?.id}: it does not pass the cohort selector.`);
  }
  const password = freshPassword();
  const put = await api.service(`/auth/v1/admin/users/${user.id}`, {
    method: 'PUT',
    body: JSON.stringify({ password }),
  });
  let via = 'delete_account';
  if (put.ok) {
    const token = await api.signIn(user.email, password);
    const r = await api.rpc(token, 'delete_account', { p_confirmation: profile.username });
    if (r.status !== 200 || r.body?.status !== 'ok') via = `delete_account failed (${r.status} ${describe(r.body)})`;
  } else {
    via = 'password refresh failed';
  }
  let gone = await api.service(`/auth/v1/admin/users/${user.id}`);
  if (gone.status !== 404) {
    // Same selector already passed above; the admin API removes the same auth row.
    const del = await api.service(`/auth/v1/admin/users/${user.id}`, { method: 'DELETE' });
    if (!del.ok) throw new Error(`could not delete ${profile.username}: ${del.status} ${describe(del.body)}`);
    via = `${via}; admin delete`;
    gone = await api.service(`/auth/v1/admin/users/${user.id}`);
  }
  if (gone.status !== 404) throw new Error(`${profile.username} still exists after deletion`);
  return via;
}

async function reset({ includeCohort = true, includeProbes = true, quiet = false } = {}) {
  const api = await connect();
  const users = await listAuthUsers(api);
  const marked = users.filter((u) => {
    const m = u.app_metadata?.qa_cohort;
    return (includeCohort && m === COHORT_MARKER) || (includeProbes && m === PROBE_MARKER);
  });
  const profiles = await profilesFor(api, marked.map((u) => u.id));
  let deleted = 0;
  let refused = 0;
  for (const u of marked) {
    const p = profiles.get(u.id);
    if (!isResettableCohortAccount(u, p)) {
      refused += 1;
      console.log(`  refused ${u.id}: marker present but ${p ? 'email/profile do not match the cohort selector' : 'no profile, so no qa_ username to confirm'}; left in place`);
      continue;
    }
    const via = await deleteCohortAccount(api, u, p);
    deleted += 1;
    if (!quiet) console.log(`  deleted ${p.username} (${via})`);
  }
  const remaining = (await listAuthUsers(api)).filter((u) => u.app_metadata?.qa_cohort === COHORT_MARKER);
  if (!quiet) {
    console.log(`\nreset: deleted ${deleted}, refused ${refused}, untouched non-cohort accounts ${users.length - marked.length}`);
    console.log(`cohort accounts remaining: ${remaining.length}`);
  }
  return { api, deleted, refused, remaining: remaining.length };
}

// ---------------------------------------------------------------------------
// VERIFY
// ---------------------------------------------------------------------------

async function verify() {
  const api = await connect();
  const resolved = await resolveGeneration(api, { forSeed: false });
  const plan = resolved.plan ?? buildPlan();
  console.log(resolved.live ? `verifying live cohort generation ${plan.generation}` : 'no live cohort generation');
  const results = [];
  const record = (status, name, detail = '') => {
    results.push({ status, name, detail });
  };
  const check = (ok, name, detail) => record(ok ? 'PASS' : 'FAIL', name, detail);

  // Clear any probe a previous verify left behind (selector-checked).
  const staleProbes = (await listAuthUsers(api)).filter((u) => u.app_metadata?.qa_cohort === PROBE_MARKER);
  if (staleProbes.length) {
    const pp = await profilesFor(api, staleProbes.map((u) => u.id));
    for (const u of staleProbes) {
      if (isResettableCohortAccount(u, pp.get(u.id))) await deleteCohortAccount(api, u, pp.get(u.id));
    }
  }

  const titles = await resolveTitles(api, plan);
  const cohort = await findCohort(api, plan);
  const present = !resolved.live ? [] : plan.users.filter((pu) => {
    const u = cohort.found.get(pu.username);
    return u && cohort.profiles.get(u.id)?.username === pu.username;
  });
  check(present.length === plan.users.length, 'cohort accounts exist with profiles', `${present.length}/${plan.users.length}`);
  if (present.length === 0) {
    const counts = await snapshotCounts(api, []);
    printTable(results);
    const qaProfiles = (await api.rows('profiles?select=username&username=like.qa*&limit=1000')).filter((p) => p.username.startsWith('qa_'));
    const marked = cohort.users.filter((u) => u.app_metadata?.qa_cohort).length;
    console.log('\nCOHORT ABSENT: no qa_cohort=v1 accounts on staging.');
    console.log(`  auth users carrying any qa_cohort marker: ${marked} (qa_ profiles: ${qaProfiles.length}); other auth users (untouched): ${cohort.users.length - marked}`);
    printCounts('counts', counts);
    process.exitCode = 1;
    return;
  }
  const idOfUser = (username) => cohort.found.get(username)?.id;
  const ids = present.map((pu) => idOfUser(pu.username));
  const idOfTitle = (k) => titles.byKey.get(k).id;

  // --- Collection shape ----------------------------------------------------
  const rankings = await api.rows(`rankings?user_id=${inList(ids)}&select=user_id,media_item_id,bucket,position`);
  const watchlist = await api.rows(`watchlist?user_id=${inList(ids)}&select=user_id,media_item_id`);
  const follows = await api.rows(`follows?follower_id=${inList(ids)}&select=follower_id,followee_id,state`);
  const recs = await api.rows(`title_recommendations?sender_id=${inList(ids)}&select=sender_id,recipient_id,media_item_id,state`);
  let rankOk = 0;
  let wlOk = 0;
  let followOk = 0;
  const shapeDetail = [];
  for (const pu of present) {
    const uid = idOfUser(pu.username);
    const mine = rankings.filter((r) => r.user_id === uid);
    const exact = pu.rankings.every((r) =>
      mine.some((m) => m.media_item_id === idOfTitle(r.key) && m.bucket === r.bucket && m.position === r.position),
    );
    if (exact && mine.length === pu.rankings.length) rankOk += 1;
    else shapeDetail.push(`${pu.username.slice(3)} rankings ${mine.length}/${pu.rankings.length}${exact ? '' : ' (order drift)'}`);
    const saved = watchlist.filter((w) => w.user_id === uid);
    if (saved.length === pu.watchlist.length && pu.watchlist.every((k) => saved.some((w) => w.media_item_id === idOfTitle(k)))) wlOk += 1;
    else shapeDetail.push(`${pu.username.slice(3)} watchlist ${saved.length}/${pu.watchlist.length}`);
    const out = follows.filter((f) => f.follower_id === uid && f.state === 'approved');
    if (out.length === pu.follows.length && pu.follows.every((t) => out.some((f) => f.followee_id === idOfUser(t)))) followOk += 1;
    else shapeDetail.push(`${pu.username.slice(3)} follows ${out.length}/${pu.follows.length}`);
  }
  const n = plan.users.length;
  check(rankOk === n, 'rankings match plan (bucket + exact position)', `${rankOk}/${n} users; ${rankings.length} rows${shapeDetail.filter((d) => d.includes('rankings')).map((d) => `; ${d}`).join('')}`);
  check(wlOk === n, 'watchlists match plan', `${wlOk}/${n} users; ${watchlist.length} rows`);
  check(followOk === n, 'follow graph matches plan (approved)', `${followOk}/${n} users; ${follows.length} edges`);
  const recsOk = plan.recommendations.filter((r) =>
    recs.some((x) => x.sender_id === idOfUser(r.from) && x.recipient_id === idOfUser(r.to) && x.media_item_id === idOfTitle(r.title) && x.state === 'delivered'),
  ).length;
  check(recsOk === plan.recommendations.length, 'recommendations delivered', `${recsOk}/${plan.recommendations.length}`);

  // --- As cohort members ---------------------------------------------------
  const signInAs = async (username) => {
    const u = cohort.found.get(username);
    const password = freshPassword();
    const put = await api.service(`/auth/v1/admin/users/${u.id}`, { method: 'PUT', body: JSON.stringify({ password }) });
    if (!put.ok) throw new Error(`could not refresh ${username}: ${put.status}`);
    return api.signIn(u.email, password);
  };
  const cohortUsernames = new Set(plan.users.map((u) => u.username));

  const mg = plan.groups.movies;
  const tvg = plan.groups.tv;
  const bbToken = await signInAs(mg.caller);
  const tvToken = mg.caller === tvg.caller ? bbToken : await signInAs(tvg.caller);

  const gpMovies = await api.rpc(bbToken, 'group_picks', {
    p_member_ids: mg.members.map(idOfUser),
    p_medium: 'movies',
    p_limit: 50,
  });
  const moviePicks = gpMovies.body?.picks ?? [];
  const movieGroupDerived = moviePicks.filter((p) => p.source !== 'trending');
  check(
    gpMovies.status === 200 && movieGroupDerived.length >= 3,
    `group_picks movies (${mg.caller.slice(3)} + ${mg.members.length})`,
    `${gpMovies.status}; ${moviePicks.length} picks, ${movieGroupDerived.length} group-derived; effective members ${gpMovies.body?.effective_member_count}; top: ${movieGroupDerived.slice(0, 3).map((p) => `${titles.keyById.get(p.media_item_id) ?? p.media_item_id}(${p.source},saved ${p.saved_count})`).join(', ')}`,
  );
  const gpTv = await api.rpc(tvToken, 'group_picks', {
    p_member_ids: tvg.members.map(idOfUser),
    p_medium: 'tv',
    p_limit: 50,
  });
  const tvPicks = gpTv.body?.picks ?? [];
  const tvGroupDerived = tvPicks.filter((p) => p.source !== 'trending');
  check(
    gpTv.status === 200 && tvGroupDerived.length >= 1,
    `group_picks tv (${tvg.caller.slice(3)} + ${tvg.members.length})`,
    `${gpTv.status}; ${tvPicks.length} picks, ${tvGroupDerived.length} group-derived; top: ${tvGroupDerived.slice(0, 3).map((p) => `${titles.keyById.get(p.media_item_id) ?? p.media_item_id}(${p.source},saved ${p.saved_count})`).join(', ')}`,
  );

  const fs = await api.rpc(bbToken, 'following_score', { p_media_item_id: idOfTitle('dark_knight') });
  const fsRow = Array.isArray(fs.body) ? fs.body[0] : null;
  check(fs.status === 200 && fsRow?.score != null, 'following_score(dark_knight) as blockbuster_fan', `${fs.status}; score ${fsRow?.score}, ${fsRow?.rating_count} of ${fsRow?.following_count} followees`);

  const fr = await api.rpc(bbToken, 'following_ratings', { p_media_item_id: idOfTitle('dark_knight') });
  check(fr.status === 200 && Array.isArray(fr.body) && fr.body.length >= 3, 'following_ratings(dark_knight) lists followees', `${fr.status}; ${Array.isArray(fr.body) ? fr.body.map((r) => `${r.username.slice(3)} ${r.score} match ${r.match_score}`).join(', ') : describe(fr.body)}`);

  const matchRows = [];
  for (const kind of ['similar', 'dissimilar']) {
    for (const [a, b] of plan.pairs[kind]) {
      const token = a === mg.caller ? bbToken : a === tvg.caller ? tvToken : await signInAs(a);
      const r = await api.rpc(token, 'taste_match', { p_user_id: idOfUser(b) });
      const row = Array.isArray(r.body) ? r.body[0] : null;
      const predicted = predictTasteMatch(plan.users.find((u) => u.username === a), plan.users.find((u) => u.username === b));
      matchRows.push({ kind, a, b, score: row?.score ?? null, common: row?.common_count, predicted: predicted.score });
    }
  }
  const similar = matchRows.filter((m) => m.kind === 'similar');
  const dissimilar = matchRows.filter((m) => m.kind === 'dissimilar');
  const minSimilar = Math.min(...similar.map((m) => m.score ?? -1));
  const maxDissimilar = Math.max(...dissimilar.map((m) => m.score ?? 101));
  check(
    similar.every((m) => m.score != null) && minSimilar > maxDissimilar,
    'taste_match similar pairs > dissimilar pairs',
    matchRows.map((m) => `${m.a.slice(3)}~${m.b.slice(3)} ${m.score}/${m.common} (plan ${m.predicted})`).join('; '),
  );

  const top = await api.rpc(bbToken, 'top_rated_titles', { p_medium: 'movies', p_limit: 50 });
  const coreIds = new Set(plan.core.map(idOfTitle));
  const topCore = Array.isArray(top.body) ? top.body.filter((t) => coreIds.has(t.media_item_id)) : [];
  check(top.status === 200 && topCore.length >= 3, "top_rated_titles('movies') includes cohort core", `${top.status}; ${Array.isArray(top.body) ? top.body.length : 0} rows, ${topCore.length} core (min_ratings ${top.body?.[0]?.min_ratings}); top: ${topCore.slice(0, 3).map((t) => `${titles.keyById.get(t.media_item_id)} ${t.score}/${t.rating_count}`).join(', ')}`);

  const cs = await api.rpc(bbToken, 'community_score', { p_media_item_id: idOfTitle('godfather') });
  const csRow = Array.isArray(cs.body) ? cs.body[0] : null;
  check(cs.status === 200 && csRow?.score != null && csRow.rating_count >= 5, 'community_score(godfather)', `${cs.status}; ${csRow?.score} over ${csRow?.rating_count}`);

  const lbAll = await api.rpc(bbToken, 'leaderboard', { p_metric: 'titles', p_timeframe: 'all_time', p_limit: 100 });
  const lbAllCohort = Array.isArray(lbAll.body) ? lbAll.body.filter((r) => cohortUsernames.has(r.username)) : [];
  check(lbAll.status === 200 && lbAllCohort.length >= 3, "leaderboard('titles','all_time') shows cohort", `${lbAll.status}; ${lbAllCohort.length} cohort of ${Array.isArray(lbAll.body) ? lbAll.body.length : 0} rows; top ${lbAllCohort.slice(0, 3).map((r) => `${r.username.slice(3)} ${r.metric_count}`).join(', ')}`);
  const lbMonth = await api.rpc(bbToken, 'leaderboard', { p_metric: 'titles', p_timeframe: 'month', p_limit: 100 });
  const lbMonthCohort = Array.isArray(lbMonth.body) ? lbMonth.body.filter((r) => cohortUsernames.has(r.username)) : [];
  record(
    lbMonth.status === 200 && lbMonthCohort.length >= 3 ? 'PASS' : 'INFO',
    "leaderboard('titles','month') shows cohort",
    `${lbMonth.status}; ${lbMonthCohort.length} cohort rows (month counts only rankings dated this calendar month; reseeding does not re-date them)`,
  );

  const followeeIds = plan.users.find((u) => u.username === mg.caller).follows.map(idOfUser);
  const feed = await api.rest(bbToken, `feed_events?actor_id=${inList(followeeIds)}&select=type&limit=1000`);
  const types = {};
  for (const e of Array.isArray(feed.body) ? feed.body : []) types[e.type] = (types[e.type] ?? 0) + 1;
  check(feed.status === 200 && (feed.body?.length ?? 0) > 0, `feed_events readable for ${mg.caller.slice(3)}'s followees`, `${feed.status}; ${feed.body?.length ?? 0} events: ${Object.entries(types).map(([t, c]) => `${t} ${c}`).join(', ')}`);

  // The app's own read (use-sent-to-you.ts); the table itself is not granted to clients.
  const inbox = await api.rpc(bbToken, 'recommendations_to_me', { p_limit: 50 });
  const inboxRows = Array.isArray(inbox.body) ? inbox.body : [];
  const inboxCohort = inboxRows.filter((r) => cohortUsernames.has(r.sender_username));
  check(
    inbox.status === 200 && inboxCohort.length >= 1,
    `recommendations_to_me (Sent to you) for ${mg.caller.slice(3)}`,
    `${inbox.status}; ${inboxRows.length ? inboxCohort.map((r) => `${r.media_title} from ${r.sender_username.slice(3)}`).join(', ') : describe(inbox.body)}`,
  );

  const mutuals = await api.rpc(bbToken, 'people_mutuals', { p_limit: 10 });
  const mutualCohort = Array.isArray(mutuals.body) ? mutuals.body.filter((r) => cohortUsernames.has(r.username)) : [];
  check(mutuals.status === 200 && mutualCohort.length >= 1, `people_mutuals for ${mg.caller.slice(3)}`, `${mutuals.status}; ${mutualCohort.map((r) => `${r.username.slice(3)} via ${r.mutual_count}`).join(', ')}`);

  const facets = await api.rows(`media_cache?facet=eq.similar&media_item_id=${inList([...coreIds])}&select=media_item_id,expires_at`);
  const liveFacets = facets.filter((f) => new Date(f.expires_at) > new Date()).length;
  record('INFO', 'similar-title facet cached for core titles', `${liveFacets}/${coreIds.size} unexpired media_cache similar rows; Group Picks' "similar" family only fires where these exist (cached by the For You adapter, not by this script)`);

  const topTv = await api.rpc(bbToken, 'top_rated_titles', { p_medium: 'tv', p_limit: 20 });
  const widestSeason = Math.max(
    ...[...raterCounts(plan)].filter(([k]) => titles.byKey.get(k)?.kind === 'season').map(([, c]) => c),
  );
  const topTvRows = Array.isArray(topTv.body) ? topTv.body : [];
  record(
    'INFO',
    "top_rated_titles('tv')",
    `${topTv.status}; ${topTvRows.length} seasons: ${topTvRows.slice(0, 3).map((t) => `${titles.keyById.get(t.media_item_id) ?? 'non-plan'} ${t.score}/${t.rating_count}`).join(', ')} (server floor ${topTvRows[0]?.min_ratings ?? 'n/a'} raters; the plan's widest season has ${widestSeason} cohort raters)`,
  );

  // --- The probe: a brand-new account, the way a preview tester arrives -----
  await probe(api, plan, titles, cohort, idOfUser, cohortUsernames, check, record);

  printTable(results);
  printCounts('cohort counts', await snapshotCounts(api, ids));
  if (results.some((r) => r.status === 'FAIL')) process.exitCode = 1;
}

async function probe(api, plan, titles, cohort, idOfUser, cohortUsernames, check, record) {
  const short = randomBytes(3).toString('hex');
  const pu = {
    username: `qa_probe_${short}`,
    email: `qa-cohort+probe_${short}@example.com`,
    displayName: 'QA · Probe',
  };
  let account = null;
  try {
    try {
      account = await ensureAccount(api, pu, null, PROBE_MARKER);
    } catch (err) {
      // An auth user this run just created but could not finish: remove it by id, after
      // re-checking the marker and email, so no half-made probe is left behind.
      const users = (await listAuthUsers(api)).filter((u) => u.email === pu.email && u.app_metadata?.qa_cohort === PROBE_MARKER);
      for (const u of users) await api.service(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' });
      throw err;
    }
    const token = account.token;

    const starter = await api.rpc(token, 'starter_movies', { p_limit: 60 });
    const rows = Array.isArray(starter.body) ? starter.body : [];
    const picks = rows.slice(0, 5);
    const coreIds = new Set(plan.core.map((k) => titles.byKey.get(k).id));
    check(
      starter.status === 200 && picks.length === 5,
      'probe: starter_movies grid',
      `${starter.status}; ${rows.length} rows, first 5: ${picks.map((p) => `${titles.keyById.get(p.media_item_id) ?? p.media_item_id}(${p.source}${p.rating_count ? ` ${p.rating_count}` : ''})`).join(', ')}; ${picks.filter((p) => coreIds.has(p.media_item_id)).length} are cohort core; min_ratings ${rows[0]?.min_ratings}`,
    );

    // Rank the five: three loved, two fine, in grid order.
    const band = { loved: [], fine: [] };
    picks.forEach((p, i) => band[i < 3 ? 'loved' : 'fine'].push(p.media_item_id));
    const probeKeyById = new Map(picks.map((p) => [p.media_item_id, p.media_item_id]));
    let rankedOk = 0;
    for (const bucket of ['loved', 'fine']) {
      for (const id of band[bucket]) {
        const r = await rankToCompletion(api, token, {
          username: pu.username,
          idOf: (k) => k,
          keyById: probeKeyById,
          band: band[bucket],
          key: id,
          bucket,
        });
        if (r.ok) rankedOk += 1;
      }
    }
    check(rankedOk === 5, 'probe: ranks 5 starter titles via rank_start/rank_answer', `${rankedOk}/5`);

    const sugg = await api.rpc(token, 'people_starter_suggestions', { p_limit: 10 });
    const suggRows = Array.isArray(sugg.body) ? sugg.body : [];
    const suggCohort = suggRows.filter((r) => cohortUsernames.has(r.username));
    check(
      sugg.status === 200 && suggCohort.length >= 3,
      'probe: people_starter_suggestions returns cohort',
      `${sugg.status}; ${suggCohort.length} cohort of ${suggRows.length}: ${suggRows.map((r) => `${cohortUsernames.has(r.username) ? r.username.slice(3) : '(non-cohort)'} shared ${r.shared_count}`).join(', ')}`,
    );

    const toFollow = suggCohort.slice(0, 3);
    let followed = 0;
    for (const target of toFollow) {
      if (!cohortUsernames.has(target.username) || target.user_id !== idOfUser(target.username)) {
        throw new Error('Refusing: probe follow target is not a cohort account.');
      }
      const r = await api.rpc(token, 'follow', {
        p_operation_id: operationId(PROBE_MARKER, pu.username, 'follow', target.username),
        p_followee_id: target.user_id,
      });
      if (r.status === 200 && r.body?.state === 'approved') followed += 1;
    }
    check(followed === 3, 'probe: follows 3 suggested cohort users', `${followed}/3: ${toFollow.map((t) => t.username.slice(3)).join(', ')}`);

    const gp = await api.rpc(token, 'group_picks', {
      p_member_ids: toFollow.map((t) => t.user_id),
      p_medium: 'movies',
      p_limit: 50,
    });
    const gpPicks = gp.body?.picks ?? [];
    const gpGroup = gpPicks.filter((p) => p.source !== 'trending');
    check(
      gp.status === 200 && gpGroup.length >= 1,
      'probe: group_picks movies with the 3 followees',
      `${gp.status}; ${gpPicks.length} picks, ${gpGroup.length} group-derived; top: ${gpGroup.slice(0, 3).map((p) => `${titles.keyById.get(p.media_item_id) ?? p.media_item_id}(${p.source})`).join(', ')}`,
    );

    const first = picks[0]?.media_item_id;
    const fs = first ? await api.rpc(token, 'following_score', { p_media_item_id: first }) : { status: 0, body: null };
    const fsRow = Array.isArray(fs.body) ? fs.body[0] : null;
    check(fs.status === 200 && fsRow?.score != null, 'probe: following_score for a ranked title', `${fs.status}; ${titles.keyById.get(first) ?? first}: ${fsRow?.score} over ${fsRow?.rating_count}`);

    const matches = [];
    for (const t of toFollow) {
      const r = await api.rpc(token, 'taste_match', { p_user_id: t.user_id });
      const row = Array.isArray(r.body) ? r.body[0] : null;
      matches.push({ who: t.username.slice(3), score: row?.score ?? null, common: row?.common_count, min: row?.min_common });
    }
    const anyMatch = matches.some((m) => m.score != null);
    check(
      anyMatch,
      'probe: taste_match with a cohort user',
      anyMatch
        ? matches.map((m) => `${m.who} ${m.score}/${m.common}`).join(', ')
        : `all null: ${matches.map((m) => `${m.who} shares ${m.common}, needs ${m.min}`).join('; ')}`,
    );
  } finally {
    if (account) {
      const profile = (await profilesFor(api, [account.id])).get(account.id);
      const user = (await api.service(`/auth/v1/admin/users/${account.id}`)).body;
      let via = 'not deleted';
      try {
        via = await deleteCohortAccount(api, user, profile);
      } catch (err) {
        via = `FAILED: ${err.message}`;
      }
      check(!via.startsWith('FAILED'), 'probe: account deleted', `${pu.username} via ${via}`);
    }
  }
}

function printTable(results) {
  const w = Math.max(...results.map((r) => r.name.length), 10);
  console.log(`\n${'STATUS'.padEnd(6)}  ${'CHECK'.padEnd(w)}  DETAIL`);
  console.log(`${'-'.repeat(6)}  ${'-'.repeat(w)}  ${'-'.repeat(40)}`);
  for (const r of results) console.log(`${r.status.padEnd(6)}  ${r.name.padEnd(w)}  ${r.detail}`);
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${pass} pass, ${fail} fail, ${results.length - pass - fail} info`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  const [command, ...rest] = argv;
  const allowed = new Set(command === 'seed' ? ['--dry-run'] : []);
  const unknown = rest.filter((a) => !allowed.has(a));
  if (unknown.length || !['seed', 'verify', 'reset'].includes(command)) {
    console.error('usage: node scripts/staging/qa-cohort.mjs seed [--dry-run] | verify | reset');
    process.exitCode = 2;
    return;
  }
  if (command === 'seed') await seed({ dryRun: rest.includes('--dry-run') });
  if (command === 'verify') await verify();
  if (command === 'reset') {
    const r = await reset();
    if (r.remaining !== 0) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`\nqa-cohort: ${err.message}`);
    process.exitCode = 1;
  });
}
