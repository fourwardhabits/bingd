/**
 * The award drill-downs that name other people, probed against the deployed database.
 *
 *   node supabase/tests/award-privacy.mjs
 *
 * WHY THIS CANNOT BE A UNIT TEST
 *
 * Nine of the twenty awards read rows that belong to somebody else, and every one of
 * them is authorised by row level security rather than by application code. PGlite runs
 * the migrations as the table owner and knows nothing about PostgREST, so the local
 * suite can assert what `contributions` computes but not *which rows arrive* — and for
 * these awards that is the entire question.
 *
 * Mutual Mania is the sharpest case in the schema. `follows_read` admits any row the
 * caller is an end of, so it performs **no filtering at all** on this query: the two
 * `!inner` markers on the profile embeds are the only thing standing between a suspended
 * account and the numerator. Remove them and the join becomes a left join — the row
 * still arrives with `followee: null`, the client renders it "Someone on Bingd", and it
 * still counts. A count that includes somebody who is no longer a valid mutual is the
 * app being wrong about a relationship, and nothing in the local suite can see it.
 *
 * TWO RULES THIS FILE FOLLOWS
 *
 * **The select string is read out of the app, not retyped here.** A copy would keep
 * passing after somebody deleted an `!inner` from `use-awards.ts`, which is precisely
 * the regression worth catching. `FOLLOWS_SELECT` is extracted from the source below, so
 * this probe exercises the string that actually ships.
 *
 * **Every negative has a control.** The first read happens while all three accounts are
 * active and asserts that both mutuals *are* found. Without it a later absence would be
 * indistinguishable from a query that never matched anything — which is how a
 * comfortable security test gets written. The left-join variant is run too, so the run
 * shows both what the shipped form does and what the unsafe form would have done.
 *
 * SAFETY
 *
 * Three accounts, created and destroyed by this run, with a run-scoped handle. Nothing
 * touches the founder's account or any existing row. Refuses to run against anything but
 * bingd-nonprod, checked on the parsed host rather than on the string.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadEnv(file) {
  const out = {};
  for (const line of readFileSync(join(root, file), 'utf8').split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

const env = { ...loadEnv('.env'), ...loadEnv('.env.local') };
const url = env.EXPO_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL;
const anonKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  console.error('Need EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// On the parsed host, not on the string: `url.includes(ref)` passes for
// `https://<ref>.example.com`, which is a hostname anybody can register — and the next
// thing that happens is the service-role key being posted to it (independent review 15).
const NONPROD_HOST = 'abheeqyjzekiowkztfxv.supabase.co';
{
  let host = null;
  let protocol = null;
  try {
    const parsed = new URL(url);
    host = parsed.host;
    protocol = parsed.protocol;
  } catch {
    host = null;
  }
  if (protocol !== 'https:' || host !== NONPROD_HOST) {
    console.error(`Refusing to run: ${url} is not https://${NONPROD_HOST}.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// The select string the app actually ships
// ---------------------------------------------------------------------------

/**
 * `FOLLOWS_SELECT`, lifted out of `use-awards.ts`.
 *
 * Deliberately a source read rather than a duplicate literal. The failure this whole
 * file exists to catch is somebody simplifying `follower_id!inner(...)` to
 * `follower_id(...)`, and a local copy of the string would sail through that.
 *
 * Parsed rather than imported because this is a plain Node script and the source is
 * TypeScript. The shape is pinned narrowly — a single `export const FOLLOWS_SELECT`
 * built from adjacent string literals — so a rewrite that this parser cannot read fails
 * loudly here instead of silently probing a stale string.
 */
function shippedFollowsSelect() {
  const file = join(root, 'src', 'features', 'awards', 'use-awards.ts');
  const source = readFileSync(file, 'utf8');
  const match = /export const FOLLOWS_SELECT\s*=\s*([\s\S]*?);\n/.exec(source);
  if (!match) {
    throw new Error(`could not find FOLLOWS_SELECT in ${file} — the parser needs updating`);
  }
  const parts = [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  if (parts.length === 0) throw new Error('FOLLOWS_SELECT held no string literals');
  return parts.join('');
}

const FOLLOWS_SELECT = shippedFollowsSelect();

/** The same read with the inner markers stripped: what the unsafe form would return. */
const LEFT_JOIN_SELECT = FOLLOWS_SELECT.replaceAll('!inner', '');

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`pass          ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL          ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const uuid = () => crypto.randomUUID();

const rpc = async (token, name, args) => {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args ?? {}),
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

const get = async (token, path) => {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
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

/** The awards read, verbatim: same table, same select, same filters. */
const followsRead = (token, select, id) =>
  get(
    token,
    `follows?select=${encodeURIComponent(select)}&state=eq.approved` +
      `&or=(follower_id.eq.${id},followee_id.eq.${id})`,
  );

/**
 * `mutualsFrom` from `use-awards.ts`, in the one respect this file tests.
 *
 * Only the intersection is reproduced — the client's version also resolves a display
 * name — because what is under test is *which ids survive the read*, and that is
 * decided by the database.
 */
function mutualIds(rows, me) {
  const following = new Set();
  const followers = new Set();
  for (const row of rows ?? []) {
    if (row.follower_id === me) following.add(row.followee_id);
    if (row.followee_id === me) followers.add(row.follower_id);
  }
  return [...following].filter((id) => id !== me && followers.has(id));
}

const stamp = Date.now().toString(36).slice(-6);
const created = [];
const emails = [];

async function createAccount(label) {
  const email = `bingd_awardpriv_${label}_${stamp}@example.com`;
  const password = `Award-${uuid()}`;

  const response = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!response.ok) throw new Error(`could not create ${label}: ${await response.text()}`);
  // Registered after the status check and before the parse: only an address this run
  // successfully created is ever swept, but a body nobody can read still leaves a handle.
  emails.push(email);
  const user = await response.json();
  created.push(user.id);

  const session = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!session.ok) throw new Error(`could not sign in ${label}: ${await session.text()}`);
  const { access_token: token } = await session.json();

  const username = `ap_${label}_${stamp}`.toLowerCase().slice(0, 24);
  const profile = await rpc(token, 'create_profile', {
    p_username: username,
    p_display_name: `Award ${label.toUpperCase()}`,
    p_date_of_birth: '1990-01-01',
  });
  if (profile.status !== 200 || profile.body?.ok !== true) {
    throw new Error(`could not create profile for ${label}: ${JSON.stringify(profile)}`);
  }

  return { id: user.id, email, token, username, label };
}

async function sweepByEmail(email) {
  const res = await fetch(`${url}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (!res.ok) throw new Error(`could not look up ${email}: ${res.status}`);
  const { users = [] } = await res.json();
  for (const user of users) {
    // Matched exactly rather than on the partial filter, so this can never delete an
    // account that merely shares a prefix with a test address.
    if (user.email !== email) continue;
    const del = await fetch(`${url}/auth/v1/admin/users/${user.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (!del.ok && del.status !== 404) throw new Error(`could not delete ${email}: ${del.status}`);
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

let a;
let b;
let c;

try {
  console.log(`Award privacy against ${url}\n`);
  console.log(`FOLLOWS_SELECT as shipped:\n  ${FOLLOWS_SELECT}\n`);

  check(
    'the shipped follows read marks both profile embeds !inner',
    /follower:follower_id!inner\(/.test(FOLLOWS_SELECT) &&
      /followee:followee_id!inner\(/.test(FOLLOWS_SELECT),
    FOLLOWS_SELECT,
  );

  a = await createAccount('a');
  b = await createAccount('b');
  c = await createAccount('c');
  console.log(`\nA = @${a.username}   B = @${b.username}   C = @${c.username}\n`);

  const label = (id) => (id === a.id ? 'A' : id === b.id ? 'B' : id === c.id ? 'C' : id);

  // -------------------------------------------------------------------------
  console.log('— A is mutual with both B and C —');
  // -------------------------------------------------------------------------

  for (const [x, y] of [
    [a, b],
    [b, a],
    [a, c],
    [c, a],
  ]) {
    const followed = await rpc(x.token, 'follow', {
      p_operation_id: uuid(),
      p_followee_id: y.id,
    });
    check(
      `${x.label.toUpperCase()} follows ${y.label.toUpperCase()}, approved`,
      followed.status === 200 && followed.body?.state === 'approved',
      JSON.stringify(followed.body),
    );
  }

  /**
   * The control, and the run is worthless without it.
   *
   * Everybody is active, so the shipped read must find both mutuals. If this fails, the
   * absences below prove nothing at all — a malformed select, an embed PostgREST cannot
   * resolve, or a follow that never landed would each produce the same empty result as a
   * working privacy filter.
   */
  const control = await followsRead(a.token, FOLLOWS_SELECT, a.id);
  const controlMutuals = mutualIds(control.body, a.id);
  check(
    'CONTROL: with all three active, the shipped read finds both mutuals',
    control.status === 200 && controlMutuals.length === 2,
    `${control.status} · ${controlMutuals.map(label).join(',')} · ${JSON.stringify(control.body)?.slice(0, 200)}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n— B is suspended, and stops being a current mutual —');
  // -------------------------------------------------------------------------

  const suspend = await fetch(`${url}/rest/v1/profiles?id=eq.${b.id}`, {
    method: 'PATCH',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: 'suspended' }),
  });
  check('B can be suspended', suspend.status === 204 || suspend.ok, String(suspend.status));

  const suspended = await followsRead(a.token, FOLLOWS_SELECT, a.id);
  const suspendedMutuals = mutualIds(suspended.body, a.id);
  check(
    'a suspended account is not counted as a mutual follow',
    !suspendedMutuals.includes(b.id),
    `mutuals = ${suspendedMutuals.map(label).join(',') || '(none)'}`,
  );
  check(
    'and the still-active mutual survives, so the filter is not just breaking the query',
    suspendedMutuals.includes(c.id),
    `mutuals = ${suspendedMutuals.map(label).join(',') || '(none)'}`,
  );
  check(
    'nothing about the suspended account is disclosed by the rows that do arrive',
    !JSON.stringify(suspended.body ?? []).includes(b.username),
    JSON.stringify(suspended.body)?.slice(0, 200),
  );

  /**
   * The assertion that fails if **either** `!inner` is removed, and it took a
   * deliberate mutation to find that the obvious one does not.
   *
   * Stripping only `followee:followee_id!inner` leaves the intersection correct by
   * accident: row `A→B` survives with a null followee and puts B in `following`, but row
   * `B→A` is still dropped by the surviving `follower` marker, so B never reaches
   * `followers` and falls out of the intersection anyway. The count check above passes,
   * and the privacy control is half gone.
   *
   * So the real invariant is stronger than "B is not a mutual": **no row mentioning an
   * ineligible account may arrive at all.** One reference is one nameless row the client
   * could count, and a single surviving edge is enough for a future reader of this data
   * to reintroduce the defect.
   */
  const rowsMentioningB = (suspended.body ?? []).filter(
    (row) => row.follower_id === b.id || row.followee_id === b.id,
  );
  check(
    'no follow row mentioning the suspended account arrives, in either direction',
    rowsMentioningB.length === 0,
    `${rowsMentioningB.length} row(s): ${JSON.stringify(rowsMentioningB)?.slice(0, 200)}`,
  );

  /**
   * What the unsafe form would have done, in the same conditions.
   *
   * Not a requirement being tested — it is the evidence that the `!inner` above is doing
   * the work. A left join returns the row with a null profile, the client's `personFrom`
   * turns that into "Someone on Bingd", and the suspended account keeps its place in the
   * numerator. If this check ever stops finding B, the two forms have converged and the
   * assertion above has quietly stopped meaning anything.
   */
  const left = await followsRead(a.token, LEFT_JOIN_SELECT, a.id);
  const leftMutuals = mutualIds(left.body, a.id);
  check(
    'CONTRAST: without !inner the suspended account would still be counted',
    leftMutuals.includes(b.id),
    `mutuals = ${leftMutuals.map(label).join(',') || '(none)'}`,
  );
  const leftRowForB = (left.body ?? []).find(
    (row) => row.follower_id === b.id || row.followee_id === b.id,
  );
  check(
    'CONTRAST: and it would arrive as a null profile, which renders as "Someone on Bingd"',
    Boolean(leftRowForB) && (leftRowForB.follower === null || leftRowForB.followee === null),
    JSON.stringify(leftRowForB)?.slice(0, 200),
  );

  // -------------------------------------------------------------------------
  console.log('\n— C blocks A, and the edges themselves go —');
  // -------------------------------------------------------------------------

  const blocked = await rpc(c.token, 'block', { p_operation_id: uuid(), p_blocked_id: a.id });
  check('C can block A', blocked.status === 200 && blocked.body?.status === 'ok', JSON.stringify(blocked.body));

  const afterBlock = await followsRead(a.token, FOLLOWS_SELECT, a.id);
  const blockMutuals = mutualIds(afterBlock.body, a.id);
  check(
    'a blocked account is not counted as a mutual follow',
    !blockMutuals.includes(c.id),
    `mutuals = ${blockMutuals.map(label).join(',') || '(none)'}`,
  );
  // Scoped to the A/C pair rather than asserting the whole result set is empty. The
  // broader form passed for the wrong reason: B's suspended edges are also absent, so an
  // empty body conflated this block with the previous section and reported a failure
  // there when a `!inner` was removed here.
  const rowsMentioningC = (afterBlock.body ?? []).filter(
    (row) => row.follower_id === c.id || row.followee_id === c.id,
  );
  check(
    'the block removed the follow rows themselves, in both directions',
    rowsMentioningC.length === 0,
    `${rowsMentioningC.length} row(s): ${JSON.stringify(rowsMentioningC)?.slice(0, 200)}`,
  );

  // -------------------------------------------------------------------------
  console.log('\n— a deleted account takes its edges with it —');
  // -------------------------------------------------------------------------

  // A fresh mutual, so deletion is tested on an edge that exists at the time.
  const d = await createAccount('d');
  for (const [x, y] of [
    [a, d],
    [d, a],
  ]) {
    await rpc(x.token, 'follow', { p_operation_id: uuid(), p_followee_id: y.id });
  }
  const beforeDelete = mutualIds((await followsRead(a.token, FOLLOWS_SELECT, a.id)).body, a.id);
  check('CONTROL: D is a mutual before deleting D', beforeDelete.includes(d.id));

  const deleted = await rpc(d.token, 'delete_account', { p_confirmation: d.username });
  check('D can delete their own account', deleted.status === 200, JSON.stringify(deleted.body)?.slice(0, 200));

  const afterDelete = await followsRead(a.token, FOLLOWS_SELECT, a.id);
  const deleteMutuals = mutualIds(afterDelete.body, a.id);
  check(
    'a deleted account is not counted as a mutual follow',
    !deleteMutuals.includes(d.id),
    `mutuals = ${deleteMutuals.map(label).join(',') || '(none)'}`,
  );
  const rowsMentioningD = (afterDelete.body ?? []).filter(
    (row) => row.follower_id === d.id || row.followee_id === d.id,
  );
  check(
    'the cascade removed the follow rows rather than leaving them nameless',
    rowsMentioningD.length === 0,
    `${rowsMentioningD.length} row(s): ${JSON.stringify(rowsMentioningD)?.slice(0, 200)}`,
  );
} catch (cause) {
  failed += 1;
  failures.push(`threw — ${cause.message}`);
  console.log(`FAIL          the run threw — ${cause.message}`);
} finally {
  console.log('\n— cleanup —');
  for (const email of emails) {
    try {
      await sweepByEmail(email);
      console.log(`swept         ${email}`);
    } catch (cause) {
      failed += 1;
      failures.push(`cleanup: ${email} — ${cause.message}`);
      console.log(`FAIL          cleanup ${email} — ${cause.message}`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
}
process.exit(failed === 0 ? 0 : 1);
