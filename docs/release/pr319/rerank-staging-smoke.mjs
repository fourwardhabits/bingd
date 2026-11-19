// Staging smoke for #318 (rank_reorder, 20261129000100). STAGING ONLY: the ref is fixed below.
// Disposable accounts at @example.invalid, deleted at the end. Prints outcomes only, never keys or
// tokens. Run AFTER the staging migration, from a checkout of f010b51f:
//   node rerank-staging-smoke.mjs
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire('/home/user/bingd/package.json');
const { createClient } = require('@supabase/supabase-js');
const REF = 'fjxhcbowoxuzulwirzyr';
const URL_ = `https://${REF}.supabase.co`;
const keys = await (await fetch(`https://api.supabase.com/v1/projects/${REF}/api-keys?reveal=true`)).json();
const anonKey = keys.find((k) => k.name === 'anon').api_key;
const serviceKey = keys.find((k) => k.name === 'service_role').api_key;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(URL_, serviceKey, opts);
const admin = service.auth.admin;
const op = () => crypto.randomUUID();
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const readOnly = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  return r.json();
};
const people = [];
async function person(label) {
  const email = `rr-${label}-${randomBytes(5).toString('hex')}@example.invalid`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  people.push(data.user.id);
  await service.from('profiles').upsert({ id: data.user.id, username: `rr_${label}_${randomBytes(3).toString('hex')}`, display_name: `Rerank ${label}` });
  const client = createClient(URL_, anonKey, opts);
  const { error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2) throw new Error(`sign in ${label}: ${e2.code}`);
  return { id: data.user.id, client };
}
/** A real first ranking through the engine: each new title loses every comparison, so lands last. */
async function rankLast(who, mediaItemId, bucket) {
  let { data: r, error } = await who.client.rpc('rank_start', { p_media_item_id: mediaItemId, p_bucket: bucket, p_operation_id: op() });
  if (error) throw new Error(`rank_start: ${error.message}`);
  let guard = 0;
  while (!r.done) {
    ({ data: r, error } = await who.client.rpc('rank_answer', { p_session_id: r.session_id, p_winner: r.pivot, p_operation_id: op() }));
    if (error) throw new Error(`rank_answer: ${error.message}`);
    if ((guard += 1) > 32) throw new Error('did not converge');
  }
  return r;
}
const order = async (who) =>
  ((await service.from('rankings').select('media_item_id, position').eq('user_id', who.id).eq('category', 'movies').order('position')).data ?? []).map((r) => r.media_item_id);
const count = async (table, column, id, extra = (q) => q) =>
  (await extra(service.from(table).select('*', { count: 'exact', head: true }).eq(column, id))).count;
const reorder = (who, args) => who.client.rpc('rank_reorder', args);

try {
  const sig = await readOnly(`select p.oid::regprocedure::text as sig, has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('anon', p.oid, 'execute') as anon from pg_proc p where proname = 'rank_reorder'`);
  check('one rank_reorder, the five-argument form, executable by authenticated only',
    sig.length === 1 && sig[0].sig === 'rank_reorder(uuid,integer,uuid,integer,uuid)' && sig[0].auth === true && sig[0].anon === false, JSON.stringify(sig));
  const trig = await readOnly(`select pg_get_triggerdef(oid) as d from pg_trigger where tgname = 'ranking_placements_correction_follows_latest_watch'`);
  check('the latest-watch trigger follows correction and manual', /correction.*manual|manual.*correction/.test(trig?.[0]?.d ?? ''));

  const { data: films } = await service.from('media_items').select('id, title').eq('kind', 'movie').not('poster_path', 'is', null).range(40, 44);
  const me = await person('me');
  const other = await person('other');
  for (const f of films.slice(0, 4)) await rankLast(me, f.id, 'loved');
  await rankLast(me, films[4].id, 'fine');
  const ids = films.map((f) => f.id);
  check('fixture ranked through the engine', (await order(me)).join() === ids.join());

  const feedBefore = await count('feed_events', 'actor_id', me.id);
  const cmpBefore = await count('comparisons', 'user_id', me.id);
  const watchBefore = await count('watch_events', 'user_id', me.id);

  const opId = op();
  const { data: moved, error: moveErr } = await reorder(me, { p_media_item_id: ids[3], p_new_position: 1, p_operation_id: opId, p_expected_position: 4, p_anchor_media_item_id: ids[0] });
  check('a guarded move inside the band lands', !moveErr && moved?.moved === true && moved?.position === 1 && moved?.from_position === 4, moveErr?.message);
  check('the ranking is the shift, not a swap', (await order(me)).join() === [ids[3], ids[0], ids[1], ids[2], ids[4]].join());
  check('the reply carries the reflowed score', Number(moved?.score) === 10 && Number(moved?.from_score) === 7);

  const { data: replay } = await reorder(me, { p_media_item_id: ids[3], p_new_position: 1, p_operation_id: opId, p_expected_position: 4, p_anchor_media_item_id: ids[0] });
  check('a replayed operation id answers from the ledger and moves nothing', replay?.position === 1 && (await order(me))[0] === ids[3]);
  check('exactly one manual placement', (await count('ranking_placements', 'user_id', me.id, (q) => q.eq('kind', 'manual'))) === 1);

  const { error: stale } = await reorder(me, { p_media_item_id: ids[2], p_new_position: 2, p_operation_id: op(), p_expected_position: 3, p_anchor_media_item_id: ids[0] });
  check('a stale expected position is refused with 55000', stale?.code === '55000', stale?.code);
  const { error: cross } = await reorder(me, { p_media_item_id: ids[4], p_new_position: 1, p_operation_id: op() });
  check('a cross-band move is refused with 22023', cross?.code === '22023', cross?.code);
  const { error: theirs } = await reorder(other, { p_media_item_id: ids[0], p_new_position: 1, p_operation_id: op() });
  check("another account cannot move this account's title (P0002)", theirs?.code === 'P0002', theirs?.code);
  const anon = createClient(URL_, anonKey, opts);
  const { error: anonErr } = await anon.rpc('rank_reorder', { p_media_item_id: ids[0], p_new_position: 1 });
  check('anonymous callers are refused', Boolean(anonErr));

  check('no feed post, comparison or watch was created by any move',
    (await count('feed_events', 'actor_id', me.id)) === feedBefore &&
    (await count('comparisons', 'user_id', me.id)) === cmpBefore &&
    (await count('watch_events', 'user_id', me.id)) === watchBefore);

  const inv = await readOnly(`select assert_ranking_valid('${me.id}', 'movies') as a, assert_placements_valid('${me.id}') as b`);
  check('I1–I3 and P1–P4 hold', Array.isArray(inv) && inv.length === 1, JSON.stringify(inv).slice(0, 120));
} catch (error) {
  check('run completed', false, error.message);
} finally {
  for (const id of people) await admin.deleteUser(id);
  const { count: left } = await service.from('profiles').select('id', { count: 'exact', head: true }).in('id', people);
  console.log(`cleanup: ${people.length} disposable accounts deleted, ${left ?? '?'} profiles left`);
}
const failed = results.filter((ok) => !ok).length;
console.log(`RESULT ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
