// Focused staging integration check for Feed Activity Grouping (PR A, and PR B when applied).
// Staging only. Disposable accounts at @example.invalid, deleted at the end. Prints outcomes,
// never keys, passwords or tokens.
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
const withRanking = process.argv.includes('--ranking');

// The exact projection the shipped Feed reads (use-feed.ts ACTIVITY_SELECT), so an embed made
// ambiguous by the new membership table would fail here as it would on a phone (PGRST201).
const ACTIVITY_SELECT =
  'id, type, actor_id, media_item_id, created_at, causal_at, causal_step, payload, ' +
  'media_items:media_item_id(kind, title,season_number, release_date, poster_path, backdrop_path, ' +
  'genres, original_language, certification, runtime_minutes, episode_count, ' +
  'parent:parent_id(title, genres, original_language, certification, backdrop_path, poster_path)), ' +
  'profiles:actor_id(username, display_name, avatar_path)';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const people = [];
let flagTouched = false;
async function person(label) {
  const email = `fg-${label}-${randomBytes(5).toString('hex')}@example.invalid`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  const id = data.user.id;
  people.push(id);
  const username = `fg_${label}_${randomBytes(3).toString('hex')}`;
  await service.from('profiles').upsert({ id, username, display_name: `FG ${label}` });
  const client = createClient(URL_, anonKey, opts);
  const { error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2) throw new Error(`sign in ${label}: ${e2.code}`);
  return { id, client };
}

const op = () => crypto.randomUUID();

try {
  const { data: films } = await service
    .from('media_items')
    .select('id, title, kind')
    .eq('kind', 'movie')
    .not('poster_path', 'is', null)
    .limit(4);
  if (!films || films.length < 4) throw new Error('not enough catalogue titles on staging');

  const actor = await person('actor');
  const reader = await person('reader');
  const stranger = await person('stranger');

  await reader.client.rpc('follow', { p_operation_id: op(), p_followee_id: actor.id });

  // 1-2. Three saves in one session: one post, count 3, members in order.
  for (const film of films.slice(0, 3)) {
    const { data, error } = await actor.client.rpc('set_watchlist', {
      p_operation_id: op(),
      p_media_item_id: film.id,
      p_present: true,
    });
    if (error || data?.status !== 'ok') throw new Error(`set_watchlist: ${error?.message ?? data?.status}`);
  }
  const { data: feed, error: feedError } = await reader.client
    .from('feed_events')
    .select(ACTIVITY_SELECT)
    .eq('actor_id', actor.id)
    .in('type', ['watchlist_added'])
    .order('causal_at', { ascending: false })
    .limit(20);
  check('the shipped Feed projection reads the post (no PGRST201)', !feedError, feedError?.code);
  check('three saves are one post', feed?.length === 1, `posts=${feed?.length}`);
  check('its count is 3', feed?.[0]?.payload?.count === 3);
  check('its title is the first saved', feed?.[0]?.media_item_id === films[0].id);
  const eventId = feed?.[0]?.id;

  const { data: members, error: mErr } = await reader.client.rpc('watchlist_group_titles', {
    p_event_id: eventId,
  });
  check(
    'a follower reads the members, in saved order',
    !mErr && members?.map((m) => m.media_item_id).join() === films.slice(0, 3).map((f) => f.id).join(),
  );

  // Conversation, then growth.
  const { error: cErr } = await reader.client.rpc('add_comment', {
    p_operation_id: op(),
    p_feed_event_id: eventId,
    p_body: 'staging grouping check',
    p_has_spoilers: false,
    p_parent_id: null,
    p_mention_ids: [],
  });
  const { error: rErr } = await reader.client.rpc('set_reaction', {
    p_operation_id: op(),
    p_feed_event_id: eventId,
    p_kind: 'love',
  });
  check('a follower comments and reacts on the post', !cErr && !rErr, cErr?.message ?? rErr?.message);
  await actor.client.rpc('set_watchlist', { p_operation_id: op(), p_media_item_id: films[3].id, p_present: true });
  const { data: grown } = await service.from('feed_events').select('id, payload').eq('actor_id', actor.id).eq('type', 'watchlist_added');
  check('the post grows in place (same id, count 4)', grown?.length === 1 && grown[0].id === eventId && grown[0].payload.count === 4);
  const { count: comments } = await service.from('comments').select('id', { count: 'exact', head: true }).eq('feed_event_id', eventId);
  const { count: reactions } = await service.from('reactions').select('feed_event_id', { count: 'exact', head: true }).eq('feed_event_id', eventId);
  check('its comment and reaction survive growth', comments === 1 && reactions === 1);

  // Remove and re-add: no new activity.
  await actor.client.rpc('set_watchlist', { p_operation_id: op(), p_media_item_id: films[1].id, p_present: false });
  await actor.client.rpc('set_watchlist', { p_operation_id: op(), p_media_item_id: films[1].id, p_present: true });
  const { data: after } = await service.from('feed_events').select('id, payload').eq('actor_id', actor.id).eq('type', 'watchlist_added');
  check('remove and re-add creates nothing new', after?.length === 1 && after[0].payload.count === 4);

  // Privacy.
  const { data: blocked, error: bErr } = await actor.client.rpc('block', {
    p_operation_id: op(),
    p_blocked_id: stranger.id,
  });
  check('the actor blocks the stranger (through the app\'s block RPC)', !bErr, bErr?.message ?? blocked?.status);
  const { data: hidden } = await stranger.client.rpc('watchlist_group_titles', { p_event_id: eventId });
  check('a blocked account reads no members', (hidden ?? []).length === 0);
  const { error: tableError } = await reader.client.from('feed_watchlist_titles').select('*').limit(1);
  check('the membership table is not readable by a client', Boolean(tableError));

  // Cross-actor isolation: another account's save in the same window is its own post.
  const other = await person('other');
  await reader.client.rpc('follow', { p_operation_id: op(), p_followee_id: other.id });
  await other.client.rpc('set_watchlist', { p_operation_id: op(), p_media_item_id: films[0].id, p_present: true });
  const { data: mineNow } = await service.from('feed_events').select('id, payload').eq('actor_id', actor.id).eq('type', 'watchlist_added');
  const { data: theirs } = await service.from('feed_events').select('id, payload').eq('actor_id', other.id).eq('type', 'watchlist_added');
  check('another account’s save is its own post, and joins nothing of the actor’s',
    theirs?.length === 1 && theirs[0].id !== eventId && theirs[0].payload?.count === 1 && mineNow?.[0]?.payload?.count === 4);
  const { data: crossMembers } = await reader.client.rpc('watchlist_group_titles', { p_event_id: theirs?.[0]?.id });
  check('its members are only its own title', crossMembers?.length === 1 && crossMembers[0].media_item_id === films[0].id);

  // Flag off: history is preserved and new saves post singly.
  const setFlag = async (key, on) => {
    const { error } = await service.from('app_config').update({ value: on }).eq('key', key);
    if (error) throw new Error(`flag ${key}: ${error.message}`);
  };
  flagTouched = true;
  await setFlag('feed.watchlist_grouping_enabled', false);
  const { data: extra } = await service.from('media_items').select('id').eq('kind', 'movie').not('poster_path', 'is', null).range(10, 11);
  for (const film of extra) {
    await actor.client.rpc('set_watchlist', { p_operation_id: op(), p_media_item_id: film.id, p_present: true });
  }
  const { data: offPosts } = await service.from('feed_events').select('id, payload').eq('actor_id', actor.id).eq('type', 'watchlist_added').order('causal_at');
  const grouped = offPosts?.find((x) => x.id === eventId);
  check('flag off: the existing group is untouched (same id, count 4)', grouped?.payload?.count === 4);
  check('flag off: each new save is its own post', offPosts?.length === 3 && offPosts.filter((x) => x.id !== eventId).every((x) => (x.payload?.count ?? 1) === 1), `posts=${offPosts?.length}`);
  const { data: keptMembers } = await reader.client.rpc('watchlist_group_titles', { p_event_id: eventId });
  check('flag off: the group still lists its members', keptMembers?.length === 4);
  const { data: keptComments } = await service.from('comments').select('id').eq('feed_event_id', eventId);
  check('flag off: its conversation is kept', keptComments?.length === 1);
  await setFlag('feed.watchlist_grouping_enabled', true);

  const watchlistBeforeRanking = offPosts?.length;
  if (withRanking) {
    // PR B: two backlog sittings inside one half hour are one post.
    const ranked = [];
    for (const [i, film] of films.slice(0, 2).entries()) {
      await service.from('user_media').upsert({ user_id: actor.id, media_item_id: film.id, bucket: 'loved' });
      await service.from('rankings').insert({ user_id: actor.id, media_item_id: film.id, category: 'movies', bucket: 'loved', position: i + 1 });
      ranked.push(film.id);
    }
    for (const id of ranked) {
      const sitting = crypto.randomUUID();
      await actor.client.rpc('rank_batch_note', { p_operation_id: op(), p_sitting: sitting, p_media_item_id: id });
      const { data } = await actor.client.rpc('rank_batch_finalize', { p_operation_id: op(), p_sitting: sitting });
      if (data?.status !== 'ok') throw new Error(`finalize: ${data?.status}`);
    }
    const { data: batches } = await service.from('feed_events').select('id, payload').eq('actor_id', actor.id).in('type', ['ranking_batch', 'ranking_batch_draft']);
    check('two backlog sittings in one half hour are one post', batches?.length === 1 && batches[0].payload.count === 2);
    // Ranking flag off: the existing batch keeps its count; a new sitting posts on its own.
    await setFlag('feed.ranking_grouping_enabled', false);
    const third = films[2];
    await service.from('user_media').upsert({ user_id: actor.id, media_item_id: third.id, bucket: 'loved' });
    await service.from('rankings').insert({ user_id: actor.id, media_item_id: third.id, category: 'movies', bucket: 'loved', position: 3 });
    const sitting3 = crypto.randomUUID();
    await actor.client.rpc('rank_batch_note', { p_operation_id: op(), p_sitting: sitting3, p_media_item_id: third.id });
    const { data: fin3 } = await actor.client.rpc('rank_batch_finalize', { p_operation_id: op(), p_sitting: sitting3 });
    const { data: offBatches } = await service.from('feed_events').select('id, payload, type').eq('actor_id', actor.id).in('type', ['ranking_batch', 'ranking_batch_draft']);
    const kept = offBatches?.find((x) => x.id === batches?.[0]?.id);
    check('ranking flag off: the existing batch keeps its count', kept?.payload?.count === 2);
    check('ranking flag off: a new sitting is its own post', fin3?.status === 'ok' && fin3?.joined !== true && offBatches?.length === 2, `posts=${offBatches?.length} joined=${fin3?.joined}`);
    await setFlag('feed.ranking_grouping_enabled', true);
    const { data: wl } = await service.from('feed_events').select('id').eq('actor_id', actor.id).eq('type', 'watchlist_added');
    check('ranking and watchlist posts stay separate (ranking added no watchlist post)', wl?.length === watchlistBeforeRanking, `${watchlistBeforeRanking}→${wl?.length}`);
  }
} catch (error) {
  check('run completed', false, error.message);
} finally {
  if (flagTouched) {
    await service.from('app_config').update({ value: true }).eq('key', 'feed.watchlist_grouping_enabled');
    await service.from('app_config').update({ value: true }).eq('key', 'feed.ranking_grouping_enabled');
    const { data: f } = await service.from('app_config').select('key, value').like('key', 'feed.%grouping_enabled');
    console.log(`flags after run: ${JSON.stringify(f)}`);
  }
  for (const id of people) await admin.deleteUser(id);
  const { count } = await service.from('profiles').select('id', { count: 'exact', head: true }).in('id', people);
  console.log(`cleanup: ${people.length} disposable accounts deleted, ${count ?? '?'} profiles left`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`RESULT ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
