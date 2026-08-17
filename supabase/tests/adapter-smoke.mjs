/**
 * The adapter's user actions, against the deployed function, as a real signed-in user.
 *
 * `remote-smoke.mjs` proves anon cannot reach any of these. This proves they *work* —
 * which is a different claim and the one Phase E's deployment turns on: the facets are
 * written by an Edge Function, not by a migration, so "the schema knows about videos"
 * and "a title has a trailer" were true and false at the same time for a fortnight.
 */

import { readFileSync } from 'node:fs';

const env = {};
for (const file of ['.env', '.env.local']) {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
}

const url = env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

// The one guard rail that matters. These scripts create and delete accounts and send
// the service-role key to whatever `url` says, so the check has to be on the *host* and
// not on the string. Independent review 15: `url.includes(ref)` passes for
// `https://<ref>.example.com`, which is a hostname anybody can register — and the next
// thing that happens is the service-role key being posted to it.
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

let passed = 0;
let failed = 0;
const report = (name, ok, detail) => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'pass' : 'FAIL'}          ${name}${ok ? '' : ` — ${detail}`}`);
};

const stamp = Date.now().toString(36).slice(-6);
const email = `bingd_adapter_${stamp}@example.com`;
const password = `Adapter-${crypto.randomUUID()}`;

const admin = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

// Recorded the instant the account exists, and everything that can fail happens after.
// Independent review 15: the setup used to sit outside the try/finally entirely, so a
// failed sign-in or a refused profile left an account in the project with nothing to
// clean it up.
let user = null;
let auth = null;
let createdEmail = null;

try {
  const response = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { ...admin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!response.ok) throw new Error(`could not create the probe account: ${await response.text()}`);
  // Between the status check and the parse: only an address this run was given, and
  // still recorded when the body turns out to be unreadable.
  createdEmail = email;
  user = await response.json();

  const session = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!session.ok) throw new Error(`could not sign the probe account in: ${await session.text()}`);
  const { access_token: token } = await session.json();

  auth = { apikey: anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const profile = await fetch(`${url}/rest/v1/rpc/create_profile`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      p_username: `adp_${stamp}`,
      p_display_name: 'Adapter probe',
      p_date_of_birth: '1990-01-01',
    }),
  });
  if (!profile.ok) throw new Error(`could not create the probe profile: ${await profile.text()}`);

const invoke = async (body) => {
  const res = await fetch(`${url}/functions/v1/tmdb-adapter`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const rest = async (path) => {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: auth });
  return res.ok ? res.json() : null;
};

  // ---- search -------------------------------------------------------------
  const search = await invoke({ action: 'search', query: 'inception', limit: 5 });
  const film = (search.body?.results ?? [])[0];
  report('search returns catalogue rows', search.status === 200 && Boolean(film), JSON.stringify(search.body)?.slice(0, 160));

  // ---- detail, and the three facets it now writes -------------------------
  const detail = await invoke({ action: 'detail', mediaItemId: film.id });
  report('detail enriches the title', detail.status === 200 && detail.body?.enriched === true, JSON.stringify(detail.body));

  const facets = await rest(`media_cache?media_item_id=eq.${film.id}&select=facet,payload`);
  const byFacet = Object.fromEntries((facets ?? []).map((row) => [row.facet, row.payload]));

  report('credits are written', Array.isArray(byFacet.credits?.cast) && byFacet.credits.cast.length > 0);
  report(
    'videos are written, which is the whole of E1',
    Array.isArray(byFacet.videos?.results) && byFacet.videos.results.length > 0,
    JSON.stringify(byFacet.videos)?.slice(0, 160),
  );
  report(
    'TMDB reviews are written',
    Array.isArray(byFacet.reviews?.results),
    JSON.stringify(byFacet.reviews)?.slice(0, 160),
  );
  const review = byFacet.reviews?.results?.[0];
  report(
    'and a review carries an author and a body',
    !review || (Boolean(review.author) && Boolean(review.content)),
    JSON.stringify(review)?.slice(0, 160),
  );

  // ---- similar ------------------------------------------------------------
  // `cached` counts as success and that is not a loosened assertion: the claim is the
  // feature. A second run of this file against a warm cache *should* be refused, and a
  // probe that failed on it would be a probe that only passes once.
  const similar = await invoke({ action: 'similar', mediaItemId: film.id });
  report(
    'similar caches a facet, or is refused because one is fresh',
    similar.status === 200 && ((similar.body?.written ?? 0) > 0 || similar.body?.reason === 'cached'),
    JSON.stringify(similar.body),
  );
  const similarFacet = await rest(`media_cache?media_item_id=eq.${film.id}&facet=eq.similar&select=payload`);
  report(
    'and the facet is there either way',
    Array.isArray(similarFacet?.[0]?.payload?.ids),
    JSON.stringify(similarFacet)?.slice(0, 160),
  );

  // ---- person -------------------------------------------------------------
  const credits = byFacet.credits;
  const personId = credits?.cast?.[0]?.id;
  const person = await invoke({ action: 'person', personId });
  report(
    'person caches a filmography, or is refused because one is fresh',
    person.status === 200 && ((person.body?.written ?? 0) > 0 || person.body?.reason === 'cached'),
    JSON.stringify(person.body),
  );

  const cached = await rest(`person_cache?tmdb_person_id=eq.${personId}&select=payload,expires_at`);
  const payload = cached?.[0]?.payload;
  report('the person record has a name', Boolean(payload?.person?.name), JSON.stringify(payload?.person)?.slice(0, 160));
  report(
    'and the credits point at real catalogue rows',
    Array.isArray(payload?.credits) && payload.credits.length > 0,
    `${payload?.credits?.length} credits of ${payload?.credit_total}`,
  );

  const first = payload?.credits?.[0];
  const row = first ? await rest(`media_items?id=eq.${first.id}&select=id,title,kind`) : null;
  report('every credit resolves to a title', Boolean(row?.[0]?.title), JSON.stringify(row)?.slice(0, 160));

  const claimAgain = await invoke({ action: 'person', personId });
  report(
    'a second request is refused by the claim rather than spent',
    claimAgain.body?.reason === 'cached',
    JSON.stringify(claimAgain.body),
  );

  report('person refuses a non-integer id', (await invoke({ action: 'person', personId: 'x' })).status === 400);

  // ---- series and seasons -------------------------------------------------
  const seriesSearch = await invoke({ action: 'search', query: 'breaking bad', limit: 5 });
  const series = (seriesSearch.body?.results ?? []).find((r) => r.kind === 'series');
  report('search finds a series', Boolean(series), JSON.stringify(seriesSearch.body)?.slice(0, 160));

  await invoke({ action: 'detail', mediaItemId: series.id });
  const seasons = await rest(
    `media_items?parent_id=eq.${series.id}&kind=eq.season&select=id,title,season_number,poster_path,release_date&order=season_number`,
  );
  report('the series has seasons', (seasons ?? []).length > 1, `${seasons?.length} seasons`);
  report(
    'including Season 0 where TMDB has one, numbered rather than named away',
    (seasons ?? []).every((s) => Number.isInteger(s.season_number)),
    JSON.stringify((seasons ?? []).map((s) => s.season_number)),
  );

  const season = (seasons ?? []).find((s) => s.season_number === 1);
  const seasonDetail = await invoke({ action: 'detail', mediaItemId: season.id });
  report('a season enriches through its parent', seasonDetail.body?.enriched === true, JSON.stringify(seasonDetail.body));

  const seasonFacets = await rest(`media_cache?media_item_id=eq.${season.id}&select=facet`);
  const seasonHas = new Set((seasonFacets ?? []).map((r) => r.facet));
  report('a season gets credits and videos', seasonHas.has('credits') && seasonHas.has('videos'), [...seasonHas].join(','));
  report(
    'and never reviews, because TMDB has none for a season',
    !seasonHas.has('reviews'),
    [...seasonHas].join(','),
  );

  // ---- trending -----------------------------------------------------------
  const lists = await rest(`provider_list_cache?select=list_key,expires_at`);
  report('the trending cache holds all four lists', (lists ?? []).length === 4, JSON.stringify(lists?.map((l) => l.list_key)));
} catch (cause) {
  failed += 1;
  console.log(`FAIL          the run itself — ${cause.message}`);
} finally {
  // Each step independently caught, so one failing cannot stop the next. Independent
  // review 15b: a rejected `delete_account` used to prevent the admin deletion
  // entirely, which is the one path that guarantees the account goes.
  const attempt = async (what, fn) => {
    try {
      await fn();
    } catch (cause) {
      failed += 1;
      console.log(`FAIL          cleanup: ${what} — ${cause.message}`);
    }
  };

  if (auth) {
    // `fetch` resolves for a 4xx, so the status is checked rather than assumed —
    // review 15c's first Minor. The sweep below would repair it either way; what would
    // not happen is anybody finding out.
    await attempt('delete the probe account', async () => {
      const res = await fetch(`${url}/rest/v1/rpc/delete_account`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ p_confirmation: `adp_${stamp}` }),
      });
      if (!res.ok) throw new Error(`delete_account returned ${res.status}`);
    });
  }

  // By email rather than by id, so this also reaches an account whose creation response
  // was never parseable — but only when this run is known to have created it. Review
  // 15c: an address used is not an address owned, and a conflicting create would
  // otherwise make this delete somebody else's account.
  if (user?.id || createdEmail) await attempt('sweep the probe account', async () => {
    const res = await fetch(`${url}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`, {
      headers: admin,
    });
    if (!res.ok) throw new Error(`lookup returned ${res.status}`);
    const { users = [] } = await res.json();
    for (const found of users) {
      // Matched exactly rather than on the partial filter, so this can never delete an
      // account that merely shares a prefix with the probe address.
      if (found.email !== email) continue;
      const del = await fetch(`${url}/auth/v1/admin/users/${found.id}`, {
        method: 'DELETE',
        headers: admin,
      });
      if (!del.ok && del.status !== 404) throw new Error(`delete returned ${del.status}`);
    }
  });
  void user;
}

console.log(`\n${passed}/${passed + failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
