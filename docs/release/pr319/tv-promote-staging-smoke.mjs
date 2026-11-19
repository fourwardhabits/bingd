// Staging smoke for #319's TV wall and silent updates (20261129000300). STAGING ONLY: the ref is fixed below.
// Disposable accounts at @example.invalid, deleted at the end. Prints outcomes only, never keys or
// tokens. Run AFTER the staging migration 20261129000300:
//   node tv-promote-staging-smoke.mjs
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
const sql = async (query, readOnly = true) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, read_only: readOnly }),
  });
  return { ok: r.ok, body: await r.json() };
};
/** The assert_* checkers, as the owner inside a READ ONLY transaction that is rolled back. */
const checkInvariants = async (user) => {
  const calls = `select assert_ranking_valid('${user}', 'tv_shows'); select assert_ranking_valid('${user}', 'tv_seasons');
    select assert_placements_valid('${user}'); select assert_watch_history_valid('${user}');`;
  const { ok, body } = await sql(`begin transaction read only; ${calls} rollback;`, false);
  return { ok: ok && !(body && (body.message || body.error)), body };
};
const people = [];
async function person(label) {
  const email = `tvp-${label}-${randomBytes(5).toString('hex')}@example.invalid`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  people.push(data.user.id);
  await service.from('profiles').upsert({ id: data.user.id, username: `tvp_${label}_${randomBytes(3).toString('hex')}`, display_name: `TV wall ${label}` });
  const client = createClient(URL_, anonKey, opts);
  const { error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2) throw new Error(`sign in ${label}: ${e2.code}`);
  return { id: data.user.id, client };
}
/** Drives a session to its end; each new title loses every comparison, so lands last. */
async function drive(who, r) {
  let guard = 0;
  let error;
  while (!r.done) {
    ({ data: r, error } = await who.client.rpc('rank_answer', { p_session_id: r.session_id, p_winner: r.pivot, p_operation_id: op() }));
    if (error) throw new Error(`rank_answer: ${error.message}`);
    if ((guard += 1) > 32) throw new Error('did not converge');
  }
  return r;
}
async function rankLast(who, mediaItemId, bucket) {
  const { data, error } = await who.client.rpc('rank_start', { p_media_item_id: mediaItemId, p_bucket: bucket, p_operation_id: op() });
  if (error) throw new Error(`rank_start: ${error.message}`);
  return drive(who, data);
}
const shows = async (who) =>
  ((await service.from('rankings').select('media_item_id').eq('user_id', who.id).eq('category', 'tv_shows').order('position')).data ?? []).map((r) => r.media_item_id);
const seasonsOf = async (who) =>
  JSON.stringify((await service.from('rankings').select('media_item_id, position, bucket').eq('user_id', who.id).eq('category', 'tv_seasons').order('position')).data ?? []);
const count = async (table, column, id) =>
  (await service.from(table).select('*', { count: 'exact', head: true }).eq(column, id)).count;
const sideEffects = async (who) =>
  JSON.stringify([
    await count('feed_events', 'actor_id', who.id),
    await count('watch_events', 'user_id', who.id),
    await count('comparisons', 'user_id', who.id),
    await count('award_unlocks', 'user_id', who.id),
    await count('notifications', 'recipient_id', who.id),
  ]);
const row = async (who, id) =>
  (await service.from('user_media').select('bucket').eq('user_id', who.id).eq('media_item_id', id).maybeSingle()).data;

try {
  const sig = await sql(`select p.oid::regprocedure::text as sig, has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('anon', p.oid, 'execute') as anon from pg_proc p where proname in ('rank_promote_show', 'rank_unpromote_show') order by 1`);
  check('rank_promote_show and rank_unpromote_show exist, for authenticated only',
    sig.body.length === 2 && sig.body.every((s) => s.auth === true && s.anon === false), JSON.stringify(sig.body));

  const { data: series } = await sql(`select s.id from media_items s where s.kind = 'series' and s.poster_path is not null
      and (select count(*) from media_items c where c.parent_id = s.id and c.kind = 'season' and c.season_number > 0) >= 2
    order by s.id limit 3`).then((r) => ({ data: r.body }));
  const [a, b, avg] = series.map((s) => s.id);
  const { body: seasonRows } = await sql(`select id from media_items where parent_id = '${avg}' and kind = 'season' and season_number > 0 order by season_number limit 2`);
  const me = await person('me');
  await rankLast(me, a, 'loved');
  await rankLast(me, b, 'loved');
  for (const s of seasonRows) await rankLast(me, s.id, 'loved');
  check('fixture: two explicit shows, and a third show with two ranked seasons only',
    (await shows(me)).join() === [a, b].join() && (await row(me, avg)) === null);

  const fx = await sideEffects(me);
  const seasonsBefore = await seasonsOf(me);
  const { data: promoted, error: pErr } = await me.client.rpc('rank_promote_show', {
    p_media_item_id: avg, p_new_position: 2, p_new_bucket: 'loved', p_operation_id: op(), p_anchor_media_item_id: b,
  });
  check('the SN AVG show is promoted between the two explicit shows', !pErr && promoted?.promoted === true && promoted?.position === 2 && !!promoted?.placement_id, pErr?.message);
  check('persisted: show order, and the collection row says I liked it',
    (await shows(me)).join() === [a, avg, b].join() && (await row(me, avg))?.bucket === 'loved');
  check('its score is the place’s (I liked it, 2 of 3)', Number(promoted?.score) === 8.5, `${promoted?.score}`);
  check('no watch event, post, comparison, award or notification', (await sideEffects(me)) === fx);
  check('season rankings untouched', (await seasonsOf(me)) === seasonsBefore);
  let inv = await checkInvariants(me.id);
  check('I1–I4, P1–P4 and W1–W5 hold after the promotion', inv.ok, JSON.stringify(inv.body).slice(0, 160));

  const { error: uErr } = await me.client.rpc('rank_unpromote_show', {
    p_media_item_id: avg, p_placement_id: promoted?.placement_id, p_operation_id: op(), p_expected_position: 2,
  });
  check('Undo restores the average-only state', !uErr && (await shows(me)).join() === [a, b].join() && (await row(me, avg)) === null, uErr?.message);
  check('…without touching seasons or watches', (await seasonsOf(me)) === seasonsBefore && (await sideEffects(me)) === fx);

  const { data: again } = await me.client.rpc('rank_promote_show', {
    p_media_item_id: avg, p_new_position: 3, p_new_bucket: 'loved', p_operation_id: op(), p_anchor_media_item_id: null,
  });
  const { data: moved, error: mErr } = await me.client.rpc('rank_reorder', {
    p_media_item_id: avg, p_new_position: 3, p_operation_id: op(), p_expected_position: 3, p_anchor_media_item_id: avg,
    p_new_bucket: 'fine', p_expected_bucket: 'loved',
  });
  check('the promoted show then moves like any explicit show, across a category', !mErr && moved?.bucket === 'fine', mErr?.message);
  const { error: late } = await me.client.rpc('rank_unpromote_show', {
    p_media_item_id: avg, p_placement_id: again?.placement_id, p_operation_id: op(), p_expected_position: 3,
  });
  check('Undo of the promotion after a later move is refused (55000)', late?.code === '55000', late?.code);
  const { error: stale } = await me.client.rpc('rank_promote_show', {
    p_media_item_id: avg, p_new_position: 1, p_new_bucket: 'loved', p_operation_id: op(), p_anchor_media_item_id: a,
  });
  check('promoting a show that is already explicit is refused (55000)', stale?.code === '55000', stale?.code);

  // Silent updates: a TV correction that moves its title posts nothing new.
  const postsBefore = await count('feed_events', 'actor_id', me.id);
  const { data: rb, error: rbErr } = await me.client.rpc('rank_rebucket', { p_media_item_id: a, p_bucket: 'fine', p_operation_id: op() });
  if (rbErr) throw new Error(`rank_rebucket: ${rbErr.message}`);
  await drive(me, rb);
  const aPosts = (await service.from('feed_events').select('payload').eq('actor_id', me.id).eq('media_item_id', a).eq('type', 'title_ranked')).data ?? [];
  check('a TV show correction across a category posts nothing new', (await count('feed_events', 'actor_id', me.id)) === postsBefore && aPosts.length === 1 && aPosts[0].payload.update === undefined);
  check('…and its first post follows the new category', aPosts[0]?.payload.bucket === 'fine');

  inv = await checkInvariants(me.id);
  check('every invariant holds at the end', inv.ok, JSON.stringify(inv.body).slice(0, 160));
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
