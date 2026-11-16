// #308 staging integration: watch-note privacy and publication, B6 unread badges (fixture,
// read-only), P2 review sorts / Helpful / privacy, P1 import with a synthetic file.
// Staging only. Disposable accounts at @example.invalid, deleted at the end. Never prints
// keys, passwords or tokens.
import { createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const { derivePassword } = await import(
  new URL('../qa-fixtures/social/fixture.mjs', import.meta.url).href
);

const REF = 'fjxhcbowoxuzulwirzyr';
const URL_ = `https://${REF}.supabase.co`;
const keys = await (await fetch(`https://api.supabase.com/v1/projects/${REF}/api-keys?reveal=true`)).json();
const anonKey = keys.find((k) => k.name === 'anon').api_key;
const serviceKey = keys.find((k) => k.name === 'service_role').api_key;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(URL_, serviceKey, opts);
const admin = service.auth.admin;
const op = () => crypto.randomUUID();
const INSIDE_OUT = 'e155e0b6-00a3-4615-b253-d74607014ccf';
const RATATOUILLE = 'ca3b65f2-b7cc-47b3-89e6-33b2a81e4860';
const TOP_GUN = '957726dc-226e-4844-9590-24fdddd77914';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const people = [];
async function person(label) {
  const email = `p308-${label}-${randomBytes(5).toString('hex')}@example.invalid`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  const id = data.user.id;
  people.push(id);
  const username = `p308_${label}_${randomBytes(3).toString('hex')}`;
  await service.from('profiles').upsert({ id, username, display_name: `P308 ${label}` });
  const client = createClient(URL_, anonKey, opts);
  const { error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2) throw new Error(`sign in ${label}: ${e2.code}`);
  return { id, client };
}
const fixturePassword = createHmac('sha256', serviceKey).update('bingd-staging-social-fixture').digest('hex');
async function fixture(n) {
  const username = `qa_fx_social_${n}`;
  const password = derivePassword(fixturePassword, username);
  const client = createClient(URL_, anonKey, opts);
  const { data, error } = await client.auth.signInWithPassword({ email: `${username}@example.invalid`, password });
  if (error) throw new Error(`fixture sign in ${n}: ${error.code}`);
  return { id: data.user.id, client };
}
const reviews = async (who, media, sort = 'top_desc') => {
  const { data, error } = await who.client.rpc('title_reviews_v2', { p_media_item_id: media, p_sort: sort, p_limit: 50 });
  if (error) throw new Error(`title_reviews_v2: ${error.message}`);
  return data ?? [];
};

try {
  // ---------------------------------------------------------------- A. watch note → review
  const author = await person('author');
  const follower = await person('follower');
  const stranger = await person('stranger');
  await follower.client.rpc('follow', { p_operation_id: op(), p_followee_id: author.id });
  const { data: logged, error: logErr } = await author.client.rpc('log_title', {
    p_operation_id: op(), p_media_item_id: INSIDE_OUT, p_bucket: 'loved', p_watched_on: '2026-11-01', p_basis: 'reader',
  });
  if (logErr) throw new Error(`log_title: ${logErr.message}`);
  const { data: watches } = await author.client.from('watch_events').select('id, note').eq('user_id', author.id).eq('media_item_id', INSIDE_OUT);
  check('the author has one watch to note', watches?.length === 1, `status=${logged?.status}`);
  const watchId = watches[0].id;
  const WATCH_NOTE = 'P308 watch note: only mine.';
  const { data: wd, error: wdErr } = await author.client.rpc('set_watch_details', { p_operation_id: op(), p_watch_event_id: watchId, p_note: WATCH_NOTE });
  check('set_watch_details saves the watch note', !wdErr && wd?.status === 'ok', wdErr?.message ?? wd?.status);
  for (const [who, label] of [[follower, 'a follower'], [stranger, 'a stranger']]) {
    const { data: seen } = await who.client.from('watch_events').select('id, note').eq('user_id', author.id);
    check(`${label} reads none of the author's watches`, (seen ?? []).length === 0, `rows=${seen?.length}`);
  }
  const um = async () => (await author.client.from('user_media').select('note, note_visibility, note_has_spoilers, note_updated_at').eq('user_id', author.id).eq('media_item_id', INSIDE_OUT).single()).data;
  check('a private watch-note save writes no title review', (await um())?.note == null);
  check('a follower sees no review from the author yet', !(await reviews(follower, INSIDE_OUT)).some((r) => r.user_id === author.id));

  const count = async (table, col, val) => (await service.from(table).select('*', { count: 'exact', head: true }).eq(col, val)).count;
  const feedBefore = await count('feed_events', 'actor_id', author.id);
  const notesBefore = await count('notifications', 'recipient_id', follower.id);
  const shareOp = op();
  const share = (base) => author.client.rpc('save_note', {
    p_operation_id: shareOp, p_media_item_id: INSIDE_OUT, p_note: WATCH_NOTE, p_base_updated_at: base,
    p_note_visibility: 'public', p_note_spoilers: true,
  });
  const { error: sErr } = await share(null);
  check('Share publishes the watch note as a public, spoiler-flagged review', !sErr, sErr?.message);
  const afterShare = await um();
  check('the title review holds the shared text, public, with spoilers', afterShare?.note === WATCH_NOTE && afterShare.note_visibility === 'public' && afterShare.note_has_spoilers === true);
  for (const [who, label] of [[follower, 'a follower'], [stranger, 'a stranger (public profile)']]) {
    const row = (await reviews(who, INSIDE_OUT)).find((r) => r.user_id === author.id);
    check(`${label} sees the published review with its spoiler flag`, row?.note === WATCH_NOTE && row?.has_spoilers === true);
  }
  const { error: replayErr } = await share(null);
  check('retrying the same publish is the same operation', !replayErr, replayErr?.message);
  check('publishing posts nothing to the Feed', (await count('feed_events', 'actor_id', author.id)) === feedBefore, `${feedBefore}→${await count('feed_events', 'actor_id', author.id)}`);
  check('publishing notifies nobody', (await count('notifications', 'recipient_id', follower.id)) === notesBefore);
  const { data: still } = await author.client.from('watch_events').select('note').eq('id', watchId).single();
  check('the watch keeps its own note after publishing', still?.note === WATCH_NOTE);

  const { error: w2Err } = await author.client.rpc('set_watch_details', { p_operation_id: op(), p_watch_event_id: watchId, p_note: 'P308 later private edit.' });
  const row2 = (await reviews(follower, INSIDE_OUT)).find((r) => r.user_id === author.id);
  check('a later private watch edit leaves the published review as it was', !w2Err && row2?.note === WATCH_NOTE);
  const { error: stale } = await author.client.rpc('save_note', {
    p_operation_id: op(), p_media_item_id: INSIDE_OUT, p_note: 'P308 stale', p_base_updated_at: '2020-01-01T00:00:00Z',
    p_note_visibility: 'public', p_note_spoilers: false,
  });
  check('a publish on a stale base version is refused (55000), not applied', stale?.code === '55000' && (await um())?.note === WATCH_NOTE, stale?.code);

  // Helpful round trip on the disposable review.
  const reviewId = row2?.id;
  const helpful = async (who, on) => who.client.rpc('set_review_helpful', { p_operation_id: op(), p_review_id: reviewId, p_helpful: on });
  await helpful(follower, true);
  let r = (await reviews(follower, INSIDE_OUT)).find((x) => x.user_id === author.id);
  check('Helpful counts a vote and marks it as the voter’s', r?.helpful_count === 1 && r?.viewer_helpful === true);
  await helpful(follower, false);
  r = (await reviews(follower, INSIDE_OUT)).find((x) => x.user_id === author.id);
  check('taking Helpful back removes it', r?.helpful_count === 0 && !r?.viewer_helpful);
  const { data: self, error: selfErr } = await helpful(author, true);
  r = (await reviews(follower, INSIDE_OUT)).find((x) => x.user_id === author.id);
  check('an author cannot vote their own review Helpful', r?.helpful_count === 0, selfErr?.code ?? self?.status ?? self?.reason);

  // ---------------------------------------------------------------- B6. unread badges
  const unreadOf = async (who) => {
    const { data, error } = await who.client.rpc('recommendations_to_me_page', { p_limit: 50 });
    if (error) throw new Error(`recommendations_to_me_page: ${error.message}`);
    const unread = (data ?? []).filter((x) => x.opened_at == null && x.seen_at == null);
    return { movies: unread.filter((x) => x.media_kind === 'movie').length, tv: unread.filter((x) => x.media_kind !== 'movie').length, rows: data.length };
  };
  const fx1 = await fixture(1);
  const fx2 = await fixture(2);
  const u1 = await unreadOf(fx1);
  const u2 = await unreadOf(fx2);
  check('B6: fx1 has an unread movie and an unread TV recommendation', u1.movies >= 1 && u1.tv >= 1, JSON.stringify(u1));
  check('B6: fx2 has no unread movie (opened, seen) and one unread TV', u2.movies === 0 && u2.tv === 1, JSON.stringify(u2));
  const u1again = await unreadOf(fx1);
  check('B6: listing does not itself mark anything seen', JSON.stringify(u1again) === JSON.stringify(u1));

  // ---------------------------------------------------------------- P2. review sorts / privacy
  const fx3 = await fixture(3);
  const fx4 = await fixture(4);
  const FX = new Set([fx1.id, fx2.id, fx3.id, fx4.id]);
  const mine = (rows) => rows.filter((x) => FX.has(x.user_id));
  const top = mine(await reviews(fx3, INSIDE_OUT, 'top_desc'));
  check('P2: Most helpful puts the 3-vote review first', top[0]?.user_id === fx1.id && top[0]?.helpful_count === 3, top.map((x) => x.helpful_count).join(','));
  const topAsc = mine(await reviews(fx3, INSIDE_OUT, 'top_asc'));
  check('P2: Least helpful puts it last', topAsc.at(-1)?.user_id === fx1.id);
  const recentDesc = mine(await reviews(fx3, INSIDE_OUT, 'recent_desc')).map((x) => x.id);
  const recentAsc = mine(await reviews(fx3, INSIDE_OUT, 'recent_asc')).map((x) => x.id);
  check('P2: Newest and Oldest are each other reversed', recentDesc.length >= 4 && recentDesc.join() === [...recentAsc].reverse().join());
  const following = mine(await reviews(fx4, INSIDE_OUT, 'following'));
  check('P2: Following puts a followed author first (fx4 follows fx1)', following[0]?.user_id === fx1.id, following.map((x) => x.user_id === fx1.id).join(','));
  const fx5Id = (await service.from('profiles').select('id').eq('username', 'qa_fx_social_5').single()).data.id;
  check('P2: a private profile’s review is hidden from a non-follower', !(await reviews(fx4, TOP_GUN)).some((x) => x.user_id === fx5Id));
  check('P2: and shown to its approved follower', (await reviews(fx3, TOP_GUN)).some((x) => x.user_id === fx5Id));
  check('P2: a private note is nobody’s review', !(await reviews(fx1, TOP_GUN)).some((x) => x.user_id === fx2.id));

  // ---------------------------------------------------------------- P1. import, synthetic
  const importer = await person('importer');
  const { data: jobId, error: cErr } = await importer.client.rpc('import_create');
  if (cErr || typeof jobId !== 'string') throw new Error(`import_create: ${cErr?.message}`);
  const rows = [
    { kind: 'watched', correlation: 'p308-1', name: 'Inside Out', year: 2015, filmUri: null, rating: 4.5, watchedOn: '2026-01-02' },
    { kind: 'watched', correlation: 'p308-2', name: 'Zzqx Film That Does Not Exist', year: 1901, filmUri: null, rating: 3 },
    { kind: 'watchlist', correlation: 'p308-3', name: 'Ratatouille', year: 2007, filmUri: null },
  ];
  const { error: stErr } = await importer.client.rpc('import_stage', { p_job_id: jobId, p_rows: rows });
  check('P1: a synthetic Letterboxd page stages', !stErr, stErr?.message);
  const { error: rdErr } = await importer.client.rpc('import_ready', { p_job_id: jobId });
  check('P1: the job is handed to the worker', !rdErr, rdErr?.message);
  let status;
  for (let i = 0; i < 40; i++) {
    status = (await importer.client.rpc('import_status', { p_job_id: jobId }).maybeSingle()).data;
    if (status && ['done', 'failed'].includes(status.status)) break;
    await new Promise((res) => setTimeout(res, 3000));
  }
  check('P1: the worker finishes the job', status?.status === 'done', `${status?.status} ${JSON.stringify(status?.counts)}`);
  const { data: col } = await importer.client.from('user_media').select('media_item_id, bucket, watched_on').eq('user_id', importer.id);
  check('P1: the matched watched title lands in the collection', (col ?? []).some((x) => x.media_item_id === INSIDE_OUT), `rows=${col?.length}`);
  const { data: wl } = await importer.client.from('watchlist').select('media_item_id').eq('user_id', importer.id);
  check('P1: the watchlist row lands on the watchlist', (wl ?? []).some((x) => x.media_item_id === RATATOUILLE), `rows=${wl?.length}`);
  const { data: again } = await importer.client.rpc('import_status', { p_job_id: jobId }).maybeSingle();
  const { data: other } = await stranger.client.rpc('import_status', { p_job_id: jobId }).maybeSingle();
  check('P1: another account cannot read the job', other == null && again != null);
} catch (error) {
  check('run completed', false, error.message);
} finally {
  for (const id of people) await admin.deleteUser(id);
  const { count } = await service.from('profiles').select('id', { count: 'exact', head: true }).in('id', people);
  console.log(`cleanup: ${people.length} disposable accounts deleted, ${count ?? '?'} profiles left`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`RESULT ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
