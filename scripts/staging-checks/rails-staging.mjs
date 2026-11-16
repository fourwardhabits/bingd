// Staging check for Feed poster rails (PR 312, feed_group_previews). Disposable accounts at
// @example.invalid, deleted at the end. Prints outcomes only, never keys or tokens.
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
const admin = service.auth.admin;
const op = () => crypto.randomUUID();
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const people = [];
async function person(label, visibility) {
  const email = `rails-${label}-${randomBytes(5).toString('hex')}@example.invalid`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  people.push(data.user.id);
  await service.from('profiles').upsert({ id: data.user.id, username: `rl_${label}_${randomBytes(3).toString('hex')}`, display_name: `Rails ${label}`, ...(visibility ? { visibility } : {}) });
  const client = createClient(URL_, anonKey, opts);
  const { error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2) throw new Error(`sign in ${label}: ${e2.code}`);
  return { id: data.user.id, client };
}
const previews = async (who, ids) => {
  const { data, error } = await who.client.rpc('feed_group_previews', { p_event_ids: ids, p_limit: 12 });
  if (error) throw new Error(`feed_group_previews: ${error.message}`);
  return data ?? [];
};
try {
  const { data: films } = await service.from('media_items').select('id, title').eq('kind', 'movie').not('poster_path', 'is', null).range(20, 25);
  const { data: season } = await service.from('media_items').select('id').eq('kind', 'season').eq('season_number', 1).not('poster_path', 'is', null).limit(1).single();
  const actor = await person('actor');
  const reader = await person('reader');
  const blocked = await person('blocked');
  const shy = await person('shy', 'private');
  await reader.client.rpc('follow', { p_operation_id: op(), p_followee_id: actor.id });

  for (const f of films.slice(0, 3)) await actor.client.rpc('set_watchlist', { p_operation_id: op(), p_media_item_id: f.id, p_present: true });
  const { data: wl } = await service.from('feed_events').select('id, payload').eq('actor_id', actor.id).eq('type', 'watchlist_added');
  const wlId = wl?.[0]?.id;
  const wlRows = await previews(reader, [wlId]);
  check('a follower previews the watchlist group in save order', wlRows.map((r) => r.media_item_id).join() === films.slice(0, 3).map((f) => f.id).join(), `rows=${wlRows.length} count=${wl?.[0]?.payload?.count}`);
  check('a save carries no score', wlRows.every((r) => r.score === null && r.ranked === false));

  // A ranking sitting: two movies and a season, ranked directly as the feedgroup check does.
  const members = [films[3].id, films[4].id, season.id];
  for (const [i, id] of members.entries()) {
    await service.from('user_media').upsert({ user_id: actor.id, media_item_id: id, bucket: 'loved' });
    await service.from('rankings').insert({ user_id: actor.id, media_item_id: id, category: id === season.id ? 'tv_seasons' : 'movies', bucket: 'loved', position: id === season.id ? 1 : i + 1 });
  }
  const sitting = crypto.randomUUID();
  for (const id of members) await actor.client.rpc('rank_batch_note', { p_operation_id: op(), p_sitting: sitting, p_media_item_id: id });
  const { data: fin } = await actor.client.rpc('rank_batch_finalize', { p_operation_id: op(), p_sitting: sitting });
  const rbId = fin?.event_id;
  const both = await previews(reader, [wlId, rbId]);
  const rb = both.filter((r) => r.event_id === rbId);
  const { data: sheet } = await reader.client.rpc('ranking_batch_titles', { p_event_id: rbId });
  check('one call answers both posts', both.filter((r) => r.event_id === wlId).length === 3 && rb.length === 3);
  check('ranking scores equal the member sheet’s, per title', rb.every((r) => Number(r.score) === Number(sheet.find((s) => s.media_item_id === r.media_item_id)?.score)), rb.map((r) => r.score).join(','));
  const sRow = rb.find((r) => r.media_item_id === season.id);
  check('the season is scored on its own ladder and names its show', sRow?.kind === 'season' && Number(sRow.score) === 10 && Boolean(sRow.parent_title));

  await service.from('rankings').delete().eq('user_id', actor.id).eq('media_item_id', films[4].id);
  const after = (await previews(reader, [rbId])).find((r) => r.media_item_id === films[4].id);
  check('an unranked member keeps its row with no score', after && after.score === null && after.ranked === false);

  await actor.client.rpc('block', { p_operation_id: op(), p_blocked_id: blocked.id });
  check('a blocked account reads nothing', (await previews(blocked, [wlId, rbId])).length === 0);
  for (const f of films.slice(0, 2)) await shy.client.rpc('set_watchlist', { p_operation_id: op(), p_media_item_id: f.id, p_present: true });
  const { data: shyPost } = await service.from('feed_events').select('id').eq('actor_id', shy.id).eq('type', 'watchlist_added').single();
  check('a private account’s group is hidden from a non-follower', (await previews(reader, [shyPost.id])).length === 0);
  check('and readable by its author', (await previews(shy, [shyPost.id])).length === 2);
  const anon = createClient(URL_, anonKey, opts);
  const { error: anonErr } = await anon.rpc('feed_group_previews', { p_event_ids: [wlId] });
  check('anonymous callers are refused', Boolean(anonErr));
} catch (error) {
  check('run completed', false, error.message);
} finally {
  for (const id of people) await admin.deleteUser(id);
  const { count } = await service.from('profiles').select('id', { count: 'exact', head: true }).in('id', people);
  console.log(`cleanup: ${people.length} disposable accounts deleted, ${count ?? '?'} profiles left`);
}
const failed = results.filter((ok) => !ok).length;
console.log(`RESULT ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
