// Staging integration for Feed PR 2 (20261128000100). Disposable @example.invalid accounts,
// deleted at the end; only they are written. Ranks through the app's own RPCs.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const REF = 'fjxhcbowoxuzulwirzyr';
const URL_ = `https://${REF}.supabase.co`;
const keys = await (await fetch(`https://api.supabase.com/v1/projects/${REF}/api-keys?reveal=true`)).json();
const anonKey = keys.find((k) => k.name === 'anon').api_key;
const serviceKey = keys.find((k) => k.name === 'service_role').api_key;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(URL_, serviceKey, opts);
const op = () => crypto.randomUUID();
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const people = [];
async function person(label, visibility) {
  const email = `pr2-${label}-${randomBytes(5).toString('hex')}@example.invalid`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  people.push(data.user.id);
  await service.from('profiles').upsert({ id: data.user.id, username: `p2_${label}_${randomBytes(3).toString('hex')}`, display_name: `PR2 ${label}`, ...(visibility ? { visibility } : {}) });
  const client = createClient(URL_, anonKey, opts);
  const { error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2) throw new Error(`sign in ${label}: ${e2.code}`);
  return { id: data.user.id, client };
}
const rpc = async (who, name, args) => {
  const { data, error } = await who.client.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
};
/** Log (with the given watch evidence) and rank a title to completion, as the title page does. */
async function rankFromTitlePage(who, mediaItemId, { basis = 'none', watchedOn = null } = {}) {
  await rpc(who, 'log_title', { p_operation_id: op(), p_media_item_id: mediaItemId, p_bucket: 'loved', p_watched_on: watchedOn, p_basis: basis });
  let r = await rpc(who, 'rank_start', { p_media_item_id: mediaItemId, p_bucket: 'loved', p_operation_id: op() });
  let guard = 0;
  while (r && !r.done && guard++ < 40) r = await rpc(who, 'rank_answer', { p_session_id: r.session_id, p_winner: mediaItemId, p_operation_id: op() });
  if (!r?.done) throw new Error('ranking did not finish');
  return rpc(who, 'rank_group_note', { p_operation_id: op(), p_media_item_id: mediaItemId });
}
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const visible = async (who, actorId) => (await who.client.from('feed_events').select('id, type, payload').eq('actor_id', actorId).in('type', ['title_ranked', 'ranking_batch', 'watchlist_added']).order('causal_at')).data ?? [];
const notes = async (ids) => (await service.from('notifications').select('id', { count: 'exact', head: true }).in('recipient_id', ids)).count;

try {
  const { data: films } = await service.from('media_items').select('id').eq('kind', 'movie').not('poster_path', 'is', null).range(40, 60);
  const { data: seasons } = await service.from('media_items').select('id').eq('kind', 'season').eq('season_number', 1).not('poster_path', 'is', null).range(5, 8);
  const actor = await person('actor');
  const reader = await person('reader');
  const blocked = await person('blocked');
  const shy = await person('shy', 'private');
  await rpc(reader, 'follow', { p_operation_id: op(), p_followee_id: actor.id });
  const notesBefore = await notes([reader.id, actor.id]);

  // 1. Six historical title-page rankings, mixed movies and seasons: one group.
  const burst = [films[0].id, films[1].id, seasons[0].id, films[2].id, seasons[1].id, films[3].id];
  const statuses = [];
  for (const [i, id] of burst.entries()) {
    statuses.push((await rankFromTitlePage(actor, id, i % 2 ? { basis: 'reader', watchedOn: daysAgo(300) } : {})).status);
  }
  check('six historical rankings: solo, grouped, then joined four times', statuses.join() === 'solo,grouped,joined,joined,joined,joined', statuses.join());
  let seen = await visible(reader, actor.id);
  const g = seen.find((p) => p.type === 'ranking_batch');
  check('the reader sees one group card and no member cards', seen.filter((p) => p.type === 'ranking_batch').length === 1 && seen.filter((p) => p.type === 'title_ranked').length === 0, seen.map((p) => p.type).join());
  check('its count matches its members', g?.payload?.count === 6);
  const titles = await rpc(reader, 'ranking_batch_titles', { p_event_id: g.id });
  check('the sheet lists all six, each on its own ladder', titles.length === 6 && titles.filter((t) => t.category === 'tv_seasons').length === 2 && titles.every((t) => t.score != null));
  const previews = await rpc(reader, 'feed_group_previews', { p_event_ids: [g.id], p_limit: 12 });
  check('the rail preview shows the same six', previews.length === 6);

  // 2. After-watch and reviewed rankings stay single, even inside the window.
  const after = await rankFromTitlePage(actor, films[4].id, { basis: 'today_default', watchedOn: daysAgo(0) });
  check('an after-watch ranking keeps its own card', after.status === 'skipped' && after.reason === 'after_watch', after.reason);
  await rpc(actor, 'log_title', { p_operation_id: op(), p_media_item_id: films[5].id, p_bucket: 'loved', p_watched_on: null, p_basis: 'none' });
  const { data: um } = await service.from('user_media').select('note_updated_at').eq('user_id', actor.id).eq('media_item_id', films[5].id).single();
  await rpc(actor, 'save_note', { p_operation_id: op(), p_media_item_id: films[5].id, p_note: 'PR2 staging review', p_base_updated_at: um?.note_updated_at ?? null, p_note_visibility: 'public', p_note_spoilers: false });
  let r = await rpc(actor, 'rank_start', { p_media_item_id: films[5].id, p_bucket: 'loved', p_operation_id: op() });
  while (r && !r.done) r = await rpc(actor, 'rank_answer', { p_session_id: r.session_id, p_winner: films[5].id, p_operation_id: op() });
  const reviewed = await rpc(actor, 'rank_group_note', { p_operation_id: op(), p_media_item_id: films[5].id });
  check('a ranking with a published review keeps its own card', reviewed.reason === 'reviewed', reviewed.reason);

  // 3. An Unranked sitting begun inside the window joins the same group.
  const sitting = op();
  await rpc(actor, 'log_title', { p_operation_id: op(), p_media_item_id: films[6].id, p_bucket: 'loved', p_watched_on: null, p_basis: 'none' });
  r = await rpc(actor, 'rank_start', { p_media_item_id: films[6].id, p_bucket: 'loved', p_operation_id: op() });
  while (r && !r.done) r = await rpc(actor, 'rank_answer', { p_session_id: r.session_id, p_winner: films[6].id, p_operation_id: op() });
  await rpc(actor, 'rank_batch_note', { p_operation_id: op(), p_sitting: sitting, p_media_item_id: films[6].id });
  seen = await visible(reader, actor.id);
  check('the sitting stays invisible while it runs', !seen.some((p) => p.type === 'ranking_batch_draft') && (seen.find((p) => p.id === g.id)?.payload?.count === 6));
  const fin = await rpc(actor, 'rank_batch_finalize', { p_operation_id: op(), p_sitting: sitting });
  check('then joins the open group when it ends', fin.joined === true && fin.event_id === g.id && fin.count === 7, JSON.stringify(fin));

  // 4. Privacy and links.
  await rpc(actor, 'block', { p_operation_id: op(), p_blocked_id: blocked.id });
  check('a blocked account sees no group and no members', (await visible(blocked, actor.id)).length === 0);
  const member = (await service.from('feed_events').select('id').eq('actor_id', actor.id).eq('presented_in', g.id).limit(1).single()).data;
  check('a hidden member’s id resolves to its group for a follower', (await rpc(reader, 'feed_event_presentation', { p_event_id: member.id })) === g.id);
  check('and to nothing for the blocked account', (await rpc(blocked, 'feed_event_presentation', { p_event_id: member.id })) === null);
  for (const id of [films[7].id, films[8].id]) await rankFromTitlePage(shy, id);
  check('a private account’s group is invisible to a non-follower', (await visible(reader, shy.id)).length === 0);

  // 4b. A stale device's reaction, or a review written later, puts a hidden card back.
  const hidden = (await service.from('feed_events').select('id, media_item_id').eq('actor_id', actor.id).eq('presented_in', g.id).order('created_at').limit(2)).data;
  await rpc(reader, 'set_reaction', { p_operation_id: op(), p_feed_event_id: hidden[0].id, p_kind: 'love' });
  seen = await visible(reader, actor.id);
  check('a late reaction on a hidden member gives it its card back', seen.some((p) => p.id === hidden[0].id) && seen.find((p) => p.id === g.id)?.payload?.count === 6, `count=${seen.find((p) => p.id === g.id)?.payload?.count}`);
  const { data: um2 } = await service.from('user_media').select('note_updated_at').eq('user_id', actor.id).eq('media_item_id', hidden[1].media_item_id).single();
  await rpc(actor, 'save_note', { p_operation_id: op(), p_media_item_id: hidden[1].media_item_id, p_note: 'PR2 staging late review', p_base_updated_at: um2?.note_updated_at ?? null, p_note_visibility: 'public', p_note_spoilers: false });
  seen = await visible(reader, actor.id);
  check('a review published later gives its ranking its card back', seen.some((p) => p.id === hidden[1].id) && seen.find((p) => p.id === g.id)?.payload?.count === 5);

  // 5. Retrospective consolidation of an older burst (backdated on disposable accounts only).
  const old = await person('old');
  await rpc(reader, 'follow', { p_operation_id: op(), p_followee_id: old.id });
  await service.from('app_config').update({ value: false }).eq('key', 'feed.ranking_backfill_grouping_enabled');
  try {
    for (const id of [films[9].id, films[10].id, films[11].id, films[12].id]) await rankFromTitlePage(old, id);
  } finally {
    await service.from('app_config').update({ value: true }).eq('key', 'feed.ranking_backfill_grouping_enabled');
  }
  const { data: oldPosts } = await service.from('feed_events').select('id').eq('actor_id', old.id).eq('type', 'title_ranked').order('created_at');
  for (const [i, p] of oldPosts.entries()) {
    const at = new Date(Date.now() - 3 * 86400000 + i * 300000).toISOString();
    await service.from('feed_events').update({ created_at: at, causal_at: at }).eq('id', p.id);
  }
  await service.from('watch_events').update({ recorded_at: new Date(Date.now() - 4 * 86400000).toISOString() }).eq('user_id', old.id);
  await rpc(reader, 'add_comment', { p_operation_id: op(), p_feed_event_id: oldPosts[1].id, p_body: 'PR2 staging comment', p_has_spoilers: false, p_parent_id: null, p_mention_ids: [] });
  await rpc(reader, 'set_reaction', { p_operation_id: op(), p_feed_event_id: oldPosts[2].id, p_kind: 'love' });
  const sql = (q) => fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q, read_only: false }) }).then((x) => x.json());
  const batch = `pr2-staging-${randomBytes(3).toString('hex')}`;
  const since = new Date(Date.now() - 5 * 86400000).toISOString();
  const dry = (await sql(`select consolidate_feed_history('${batch}', '${since}', now(), false, 30, '${old.id}') r`))[0].r;
  check('dry run: the commented and reacted-to posts are left out; the two clean ones would group', dry.planned_groups.ranking === 1 && dry.planned_groups.members === 2 && dry.excluded.referenced === 2, JSON.stringify(dry.planned_groups));
  check('and a dry run writes nothing', (await service.from('feed_events').select('id', { count: 'exact', head: true }).eq('actor_id', old.id).not('presented_in', 'is', null)).count === 0);
  // A fifth historical post next to the two clean ones makes a group of three.
  const extra = films[13].id;
  await service.from('app_config').update({ value: false }).eq('key', 'feed.ranking_backfill_grouping_enabled');
  try { await rankFromTitlePage(old, extra); } finally { await service.from('app_config').update({ value: true }).eq('key', 'feed.ranking_backfill_grouping_enabled'); }
  const { data: newest } = await service.from('feed_events').select('id').eq('actor_id', old.id).eq('media_item_id', extra).eq('type', 'title_ranked').single();
  const at = new Date(Date.now() - 3 * 86400000 + 20 * 60000).toISOString();
  await service.from('feed_events').update({ created_at: at, causal_at: at }).eq('id', newest.id);
  await service.from('watch_events').update({ recorded_at: new Date(Date.now() - 4 * 86400000).toISOString() }).eq('user_id', old.id);
  const positions = (await service.from('rankings').select('media_item_id, position, bucket').eq('user_id', old.id).order('media_item_id')).data;
  const done = (await sql(`select consolidate_feed_history('${batch}', '${since}', now(), true, 30, '${old.id}') r`))[0].r;
  check('applied: one ranking group of the three clean posts', done.applied_groups.ranking === 1 && done.hidden_posts === 3, JSON.stringify(done.applied_groups));
  seen = await visible(reader, old.id);
  check('the commented and reacted-to posts keep their own cards', seen.filter((p) => p.type === 'title_ranked').map((p) => p.id).sort().join() === [oldPosts[1].id, oldPosts[2].id].sort().join());
  const { count: commentsKept } = await service.from('comments').select('id', { count: 'exact', head: true }).eq('feed_event_id', oldPosts[1].id);
  check('the comment is still on its own post', commentsKept === 1);
  check('no ranking moved', JSON.stringify((await service.from('rankings').select('media_item_id, position, bucket').eq('user_id', old.id).order('media_item_id')).data) === JSON.stringify(positions));
  const reverted = (await sql(`select revert_feed_consolidation('${batch}') r`))[0].r;
  seen = await visible(reader, old.id);
  check('revert shows every post again and removes the group', reverted.deleted_groups === 1 && seen.filter((p) => p.type === 'title_ranked').length === 5 && !seen.some((p) => p.type === 'ranking_batch'));

  check('no notifications came from grouping or consolidation (beyond the follow, comment and reaction)', (await notes([reader.id, actor.id])) - notesBefore <= 2, `${notesBefore}→${await notes([reader.id, actor.id])}`);
} catch (error) {
  check('run completed', false, error.message);
} finally {
  for (const id of people) await service.auth.admin.deleteUser(id);
  const { count } = await service.from('profiles').select('id', { count: 'exact', head: true }).in('id', people);
  const { data: flag } = await service.from('app_config').select('value').eq('key', 'feed.ranking_backfill_grouping_enabled').single();
  console.log(`cleanup: ${people.length} disposable accounts deleted, ${count ?? '?'} profiles left; backfill flag ${JSON.stringify(flag?.value)}`);
}
const failed = results.filter((ok) => !ok).length;
console.log(`RESULT ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
