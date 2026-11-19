// Staging smoke for #318 revised (cross-category rank_reorder, 20261129000200). STAGING ONLY: the ref is fixed below.
// Disposable accounts at @example.invalid, deleted at the end. Prints outcomes only, never keys or
// tokens. Run AFTER the staging migration 20261129000200:
//   node rerank-cross-staging-smoke.mjs
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
/**
 * The two assert_* checkers are revoked from every client role, including the API's
 * read-only one, so they run as the owner inside a READ ONLY transaction that is rolled
 * back: nothing can be written. A violation raises, and the reply carries the message.
 */
const checkInvariants = async (users) => {
  const calls = users
    .map((u) => `select assert_ranking_valid('${u}', 'movies'); select assert_placements_valid('${u}');`)
    .join(' ');
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `begin transaction read only; ${calls} rollback;`, read_only: false }),
  });
  const body = await r.json();
  return { ok: r.ok && !(body && (body.message || body.error)), body };
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

const bucketOf = async (who, id) =>
  (await service.from('rankings').select('bucket').eq('user_id', who.id).eq('media_item_id', id).single()).data?.bucket;
const collectionBucket = async (who, id) =>
  (await service.from('user_media').select('bucket').eq('user_id', who.id).eq('media_item_id', id).single()).data?.bucket;

try {
  const sig = await readOnly(`select p.oid::regprocedure::text as sig, has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('anon', p.oid, 'execute') as anon from pg_proc p where proname = 'rank_reorder'`);
  check('one rank_reorder, the six-argument form, executable by authenticated only',
    sig.length === 1 && sig[0].sig === 'rank_reorder(uuid,integer,uuid,integer,uuid,taste_bucket)' && sig[0].auth === true && sig[0].anon === false, JSON.stringify(sig));

  const { data: films } = await service.from('media_items').select('id, title').eq('kind', 'movie').not('poster_path', 'is', null).range(60, 67);
  const me = await person('me');
  const loved = films.slice(0, 4).map((f) => f.id);
  const fine = films.slice(4, 8).map((f) => f.id);
  for (const id of loved) await rankLast(me, id, 'loved');
  for (const id of fine) await rankLast(me, id, 'fine');
  check('fixture: 4 I liked it, then 4 It was fine, ranked through the engine', (await order(me)).join() === [...loved, ...fine].join());

  const feedBefore = await count('feed_events', 'actor_id', me.id);
  const cmpBefore = await count('comparisons', 'user_id', me.id);
  const watchBefore = await count('watch_events', 'user_id', me.id);

  // The founder's acceptance case: a 10.0 dropped among the It was fine titles.
  const { data: down, error: downErr } = await reorder(me, { p_media_item_id: loved[0], p_new_position: 6, p_operation_id: op(), p_expected_position: 1, p_anchor_media_item_id: fine[2], p_new_bucket: 'fine' });
  check('a drag from I liked it onto an It was fine title lands', !downErr && down?.moved === true && down?.bucket === 'fine' && down?.from_bucket === 'loved' && down?.position === 6, downErr?.message);
  check('it is rescored in the It was fine range', Number(down?.score) < 7 && Number(down?.score) >= 3.5 && Number(down?.from_score) === 10, `${down?.score}`);
  // "Reload": a fresh read of the stored ranking, not the reply.
  check('persisted: position, category and the collection row agree',
    (await order(me)).join() === [loved[1], loved[2], loved[3], fine[0], fine[1], loved[0], fine[2], fine[3]].join() &&
    (await bucketOf(me, loved[0])) === 'fine' && (await collectionBucket(me, loved[0])) === 'fine');
  const post = (await service.from('feed_events').select('payload').eq('actor_id', me.id).eq('media_item_id', loved[0]).eq('type', 'title_ranked')).data ?? [];
  check('the latest watch’s existing post follows (one post, new category and score)', post.length === 1 && post[0].payload.bucket === 'fine' && Number(post[0].payload.score) === Number(down?.score));

  // Undo: back to #1, I liked it, anchored on whoever is at #1 now.
  const now = await order(me);
  const { data: back, error: backErr } = await reorder(me, { p_media_item_id: loved[0], p_new_position: 1, p_operation_id: op(), p_expected_position: 6, p_anchor_media_item_id: now[0], p_new_bucket: 'loved' });
  check('undo restores the category, place and score', !backErr && back?.bucket === 'loved' && back?.position === 1 && Number(back?.score) === 10 && (await order(me)).join() === [...loved, ...fine].join() && (await collectionBucket(me, loved[0])) === 'loved', backErr?.message);

  // Up: the worst It was fine onto the second I liked it.
  const { data: up, error: upErr } = await reorder(me, { p_media_item_id: fine[3], p_new_position: 2, p_operation_id: op(), p_expected_position: 8, p_anchor_media_item_id: loved[1], p_new_bucket: 'loved' });
  check('a drag from It was fine up among I liked it lands and rescores', !upErr && up?.bucket === 'loved' && Number(up?.score) >= 7, upErr?.message);

  // An installed client's same-category call (no p_new_bucket) still works.
  const { data: same, error: sameErr } = await reorder(me, { p_media_item_id: loved[3], p_new_position: 1, p_operation_id: op(), p_expected_position: 5, p_anchor_media_item_id: loved[0] });
  check('a same-category call without p_new_bucket works as before', !sameErr && same?.moved === true && same?.bucket === 'loved', sameErr?.message);

  const { error: notAPlace } = await reorder(me, { p_media_item_id: loved[0], p_new_position: 1, p_operation_id: op(), p_new_bucket: 'not_for_me' });
  check('a position that is not a place in the named category is refused with 22023', notAPlace?.code === '22023', notAPlace?.code);
  const { error: stale } = await reorder(me, { p_media_item_id: loved[1], p_new_position: 6, p_operation_id: op(), p_expected_position: 1, p_anchor_media_item_id: fine[1], p_new_bucket: 'fine' });
  check('a stale cross-category move is refused with 55000', stale?.code === '55000', stale?.code);

  check('no feed post, comparison or watch was created by any move',
    (await count('feed_events', 'actor_id', me.id)) === feedBefore &&
    (await count('comparisons', 'user_id', me.id)) === cmpBefore &&
    (await count('watch_events', 'user_id', me.id)) === watchBefore);
  check('one manual placement per applied move (4)', (await count('ranking_placements', 'user_id', me.id, (q) => q.eq('kind', 'manual'))) === 4);

  const inv = await checkInvariants([me.id]);
  check('I1–I4 and P1–P4 hold', inv.ok, JSON.stringify(inv.body).slice(0, 160));
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
