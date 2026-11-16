// Seeds ONE marked, public staging demo account for the poster-rails visual check, if it does
// not exist yet. Staging only. Prints outcomes, never keys or passwords.
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const REF = 'fjxhcbowoxuzulwirzyr';
const URL_ = `https://${REF}.supabase.co`;
const keys = await (await fetch(`https://api.supabase.com/v1/projects/${REF}/api-keys?reveal=true`)).json();
const anonKey = keys.find((k) => k.name === 'anon').api_key;
const serviceKey = keys.find((k) => k.name === 'service_role').api_key;
const { data: env } = await createClient(URL_, anonKey).rpc('environment_name');
if (env !== 'nonprod') throw new Error(`refusing: environment_name = ${env}`);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(URL_, serviceKey, opts);
const USERNAME = 'qa_fx_rails_demo';
const EMAIL = `${USERNAME}@example.invalid`;
const password = createHmac('sha256', serviceKey).update(`bingd-staging-rails-demo:${USERNAME}`).digest('base64url');
const op = () => crypto.randomUUID();

const { data: existing } = await service.from('profiles').select('id').eq('username', USERNAME).maybeSingle();
if (existing) { console.log(`exists: @${USERNAME} (${existing.id}); nothing written`); process.exit(0); }
const { data: created, error } = await service.auth.admin.createUser({
  email: EMAIL, password, email_confirm: true,
  app_metadata: { qa_fixture: 'rails-demo-v1' }, user_metadata: { qa_fixture: 'rails-demo-v1' },
});
if (error) throw new Error(`createUser: ${error.message}`);
const id = created.user.id;
const client = createClient(URL_, anonKey, opts);
await client.auth.signInWithPassword({ email: EMAIL, password });
const { error: pErr } = await client.rpc('create_profile', { p_username: USERNAME, p_display_name: 'Rails Demo', p_date_of_birth: '1990-01-01' });
if (pErr) await service.from('profiles').upsert({ id, username: USERNAME, display_name: 'Rails Demo' });

const { data: films } = await service.from('media_items').select('id, title').eq('kind', 'movie').not('poster_path', 'is', null).order('popularity', { ascending: false, nullsFirst: false }).limit(10);
const { data: seasons } = await service.from('media_items').select('id').eq('kind', 'season').eq('season_number', 1).not('poster_path', 'is', null).limit(2);

// 1. Six saves in one session: one grouped watchlist post.
for (const f of films.slice(0, 6)) await client.rpc('set_watchlist', { p_operation_id: op(), p_media_item_id: f.id, p_present: true });

// 2. One Unranked sitting: four movies and two seasons, on their own ladders (a fresh account,
// so positions are simply 1..n per ladder).
const sitting = op();
const ranked = [...films.slice(6, 10).map((f) => [f.id, 'movies']), ...seasons.map((s) => [s.id, 'tv_seasons'])];
const pos = { movies: 0, tv_seasons: 0 };
for (const [mid, cat] of ranked) {
  pos[cat] += 1;
  await service.from('user_media').upsert({ user_id: id, media_item_id: mid, bucket: 'loved' });
  await service.from('rankings').insert({ user_id: id, media_item_id: mid, category: cat, bucket: 'loved', position: pos[cat] });
  await client.rpc('rank_batch_note', { p_operation_id: op(), p_sitting: sitting, p_media_item_id: mid });
}
const { data: fin } = await client.rpc('rank_batch_finalize', { p_operation_id: op(), p_sitting: sitting });
const { data: posts } = await service.from('feed_events').select('type, payload').eq('actor_id', id).in('type', ['watchlist_added', 'ranking_batch']);
console.log(`created @${USERNAME} (${id}): ${posts.map((p) => `${p.type}×${p.payload?.count}`).join(', ')} finalize=${fin?.status}`);
