/**
 * The staging QA cohort fixture and its safety guard, with no network and no database.
 *
 * `scripts/staging/qa-cohort.mjs` writes to staging with a service-role key, so the
 * refusals are asserted here where a change to them fails CI rather than a run.
 * The fixture assertions are the shape the verify step depends on: if one of them
 * breaks, a surface on a fresh preview account goes quiet and nothing else says why.
 *
 *   node --test supabase/tests/staging-qa-cohort.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  CORE,
  COHORT_MARKER,
  PROBE_MARKER,
  SEASONS,
  buildPlan,
  operationId,
  predictTasteMatch,
  raterCounts,
  scoreFor,
  sharedRankings,
  titleSpec,
} from '../../scripts/staging/qa-cohort-plan.mjs';
import {
  COHORT_EMAIL_PATTERN,
  PRODUCTION_REF,
  STAGING_HOST,
  STAGING_REF,
  STAGING_URL,
  assertEnvironmentAnswer,
  assertLaneConfig,
  assertStagingKey,
  assertStagingUrl,
  isResettableCohortAccount,
} from '../../scripts/staging/qa-cohort.mjs';

const require = createRequire(import.meta.url);
const plan = buildPlan();
const byName = new Map(plan.users.map((u) => [u.username, u]));

/** A structurally valid, unsigned legacy-style JWT with the given payload. */
const fakeJwt = (payload) =>
  [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

test('the plan is deterministic', () => {
  assert.deepEqual(buildPlan(), buildPlan());
  assert.equal(JSON.stringify(buildPlan()), JSON.stringify(plan));
  const a = operationId('v1', 'qa_scifi_fan', 'rank_start', 'dune');
  assert.equal(a, operationId('v1', 'qa_scifi_fan', 'rank_start', 'dune'));
  assert.notEqual(a, operationId('v1', 'qa_scifi_fan', 'rank_start', 'arrival'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('six to eight users, each named qa_ with a matching cohort email', () => {
  assert.ok(plan.users.length >= 6 && plan.users.length <= 8);
  assert.equal(new Set(plan.users.map((u) => u.username)).size, plan.users.length);
  for (const u of plan.users) {
    assert.match(u.username, /^qa_[a-z0-9_]{3,21}$/);
    assert.match(u.username, /^[a-z0-9_]{3,24}$/, 'the profiles username_format check');
    const m = COHORT_EMAIL_PATTERN.exec(u.email);
    assert.ok(m, `${u.email} matches the cohort email pattern`);
    assert.equal(`qa_${m[1]}`, u.username);
    assert.ok(!m[1].startsWith('probe_'), 'cohort names never collide with probe names');
    assert.ok(u.displayName.length <= 50);
  }
});

test('generations: a reset cohort reseeds under new names, and only the names change', () => {
  // A deleted profile's username is reserved for ever (20260813001500), so generation n
  // must never reuse generation m's names or emails.
  const g1 = buildPlan({ generation: 1 });
  assert.deepEqual(g1, plan, 'generation 1 is the default');
  const seen = new Set();
  for (const g of [1, 2, 3, 10, 99]) {
    const p = buildPlan({ generation: g });
    assert.equal(p.generation, g);
    assert.deepEqual(buildPlan({ generation: g }), p, 'deterministic per generation');
    for (const u of p.users) {
      assert.match(u.username, /^qa_[a-z0-9_]{3,21}$/);
      const m = COHORT_EMAIL_PATTERN.exec(u.email);
      assert.ok(m && `qa_${m[1]}` === u.username);
      assert.ok(!seen.has(u.username) && !seen.has(u.email), `${u.username} reused across generations`);
      seen.add(u.username);
      seen.add(u.email);
      assert.equal(isResettableCohortAccount(
        { id: 'x', email: u.email, app_metadata: { qa_cohort: COHORT_MARKER } },
        { id: 'x', username: u.username },
      ), true);
    }
    // Everything but identity is the same fixture.
    const strip = (pl) => pl.users.map(({ username, email, follows, ...rest }) => rest);
    assert.deepEqual(strip(p), strip(g1));
    for (const [i, r] of p.recommendations.entries()) assert.equal(r.title, g1.recommendations[i].title);
    for (const u of p.users) for (const f of u.follows) assert.ok(p.users.some((x) => x.username === f));
  }
  assert.throws(() => buildPlan({ generation: 0 }));
  assert.throws(() => buildPlan({ generation: 100 }));
  assert.throws(() => buildPlan({ generation: 1.5 }));
});

test('ranking volumes: 15-30 movies each (TV-leaning users rank seasons instead)', () => {
  for (const u of plan.users) {
    const movies = u.rankings.filter((r) => r.category === 'movies').length;
    const seasons = u.rankings.filter((r) => r.category === 'tv_seasons').length;
    if (u.username === 'qa_tv_fan') {
      assert.ok(seasons >= 15, `${u.username} is TV-leaning`);
      assert.ok(movies >= 10);
    } else {
      assert.ok(movies >= 15 && movies <= 30, `${u.username} ranks ${movies} movies`);
    }
    const keys = u.rankings.map((r) => r.key);
    assert.equal(new Set(keys).size, keys.length, `${u.username} ranks nothing twice`);
  }
});

test('planned positions are a contiguous 1..n per category with bands in order', () => {
  for (const u of plan.users) {
    for (const category of ['movies', 'tv_seasons']) {
      const rows = u.rankings.filter((r) => r.category === category);
      const positions = rows.map((r) => r.position).sort((a, b) => a - b);
      assert.deepEqual(positions, rows.map((_, i) => i + 1));
      const order = { loved: 0, fine: 1, not_for_me: 2 };
      const sorted = [...rows].sort((a, b) => a.position - b.position);
      for (let i = 1; i < sorted.length; i += 1) {
        assert.ok(order[sorted[i - 1].bucket] <= order[sorted[i].bucket]);
      }
    }
  }
});

test('no series is ranked; every season key names a real season number', () => {
  for (const u of plan.users) for (const r of u.rankings) assert.notEqual(titleSpec(r.key).kind, 'series');
  for (const [key, [tmdb, season]] of Object.entries(SEASONS)) {
    assert.ok(Number.isInteger(tmdb) && Number.isInteger(season) && season >= 1, key);
  }
});

test('intended matching pairs share at least 5 rankings (similar ones 8+)', () => {
  for (const [a, b] of plan.pairs.similar) {
    const n = sharedRankings(byName.get(a), byName.get(b)).length;
    assert.ok(n >= 8, `${a} ~ ${b} share ${n}`);
  }
  for (const [a, b] of plan.pairs.dissimilar) {
    const n = sharedRankings(byName.get(a), byName.get(b)).length;
    assert.ok(n >= 5, `${a} ~ ${b} share ${n}`);
  }
  for (const g of Object.values(plan.groups)) {
    for (const m of g.members) {
      assert.ok(sharedRankings(byName.get(g.caller), byName.get(m)).length >= 5, `${g.caller} ~ ${m}`);
    }
  }
});

test('predicted taste_match: every similar pair beats every dissimilar pair', () => {
  const similar = plan.pairs.similar.map(([a, b]) => predictTasteMatch(byName.get(a), byName.get(b)).score);
  const dissimilar = plan.pairs.dissimilar.map(([a, b]) => predictTasteMatch(byName.get(a), byName.get(b)).score);
  assert.ok(similar.every((s) => s !== null) && dissimilar.every((s) => s !== null));
  assert.ok(Math.min(...similar) > Math.max(...dissimilar), `${similar} vs ${dissimilar}`);
  assert.ok(Math.min(...similar) - Math.max(...dissimilar) >= 15, 'the gap is clear, not marginal');
});

test('scoreFor mirrors the band arithmetic', () => {
  assert.equal(scoreFor('loved', 1, 10), 10.0);
  assert.equal(scoreFor('loved', 10, 10), 7.0);
  assert.equal(scoreFor('fine', 1, 1), 6.9);
  assert.equal(scoreFor('not_for_me', 3, 3), 0.0);
  assert.equal(scoreFor('fine', 2, 3), 5.2);
});

test('at least 10 titles are ranked by 5 or more cohort users, the core among them', () => {
  const counts = raterCounts(plan);
  const wide = [...counts].filter(([, n]) => n >= 5);
  assert.ok(wide.length >= 10, `${wide.length} titles`);
  for (const key of CORE) assert.ok((counts.get(key) ?? 0) >= 5, `core ${key}`);
  assert.ok(CORE.length >= 12 && CORE.length <= 15);
});

test("starter_movies' community tier would be titles every cohort user ranked", () => {
  // Mirrors the cutoff: percentile_disc(0.9) over per-movie rater counts, floored at 3.
  const counts = [...raterCounts(plan)].filter(([k]) => titleSpec(k).kind === 'movie');
  const ns = counts.map(([, n]) => n).sort((a, b) => a - b);
  const cutoff = Math.max(ns[Math.ceil(0.9 * ns.length) - 1], 3);
  const community = counts.filter(([, n]) => n >= cutoff).map(([k]) => k);
  assert.ok(community.length >= 5, `${community.length} community titles at cutoff ${cutoff}`);
  const everybody = community.filter((k) => plan.users.every((u) => u.rankings.some((r) => r.key === k)));
  assert.ok(everybody.length >= 5, 'a probe picking any five shares five with each cohort user');
});

test('watchlist titles are never ranked by the same user (nor any season of a watchlisted series)', () => {
  for (const u of plan.users) {
    const ranked = new Set(u.rankings.map((r) => r.key));
    const rankedSeriesTmdb = new Set(
      u.rankings.filter((r) => r.category === 'tv_seasons').map((r) => titleSpec(r.key).tmdbId),
    );
    assert.equal(new Set(u.watchlist).size, u.watchlist.length);
    for (const key of u.watchlist) {
      assert.ok(!ranked.has(key), `${u.username} both ranks and saves ${key}`);
      const spec = titleSpec(key);
      if (spec.kind === 'series') assert.ok(!rankedSeriesTmdb.has(spec.tmdbId), `${u.username} ranks a season of ${key}`);
    }
  }
});

test('watchlists intersect across users', () => {
  const savers = new Map();
  for (const u of plan.users) for (const k of u.watchlist) savers.set(k, (savers.get(k) ?? 0) + 1);
  const shared = [...savers].filter(([, n]) => n >= 3);
  assert.ok(shared.length >= 3, `${shared.length} titles saved by 3+ users`);
});

test('follow graph: cohort-only, not complete, with mutual and one-way edges', () => {
  const edges = new Set();
  for (const u of plan.users) {
    assert.equal(new Set(u.follows).size, u.follows.length);
    for (const t of u.follows) {
      assert.ok(byName.has(t), `${u.username} follows non-cohort ${t}`);
      assert.notEqual(t, u.username);
      edges.add(`${u.username}>${t}`);
    }
  }
  const n = plan.users.length;
  assert.ok(edges.size < n * (n - 1), 'not complete');
  const mutual = [...edges].filter((e) => edges.has(e.split('>').reverse().join('>')));
  const oneWay = [...edges].filter((e) => !edges.has(e.split('>').reverse().join('>')));
  assert.ok(mutual.length >= 4 && oneWay.length >= 3, `${mutual.length} mutual, ${oneWay.length} one-way`);
  for (const u of plan.users) assert.ok(u.follows.length <= 60, 'under follow.max_per_hour');
});

test('group picks: each group caller follows 3-5 members with overlapping collections', () => {
  for (const [medium, g] of Object.entries(plan.groups)) {
    const caller = byName.get(g.caller);
    assert.ok(g.members.length >= 3 && g.members.length <= 5, medium);
    for (const m of g.members) assert.ok(caller.follows.includes(m), `${g.caller} follows ${m}`);
    const kind = medium === 'movies' ? 'movie' : 'series';
    const saved = new Map();
    for (const who of [g.caller, ...g.members]) {
      for (const k of byName.get(who).watchlist) {
        if (titleSpec(k).kind === kind) saved.set(k, (saved.get(k) ?? 0) + 1);
      }
    }
    assert.ok([...saved.values()].some((c) => c >= 2), `${medium} group has a title saved by 2+ members`);
  }
});

test('recommendations: mutual followers only, rankable, unranked by the recipient, under limits', () => {
  const perSender = new Map();
  const seen = new Set();
  for (const r of plan.recommendations) {
    const from = byName.get(r.from);
    const to = byName.get(r.to);
    assert.ok(from && to && r.from !== r.to);
    assert.ok(from.follows.includes(r.to), `${r.from} follows ${r.to}`);
    assert.ok(to.follows.includes(r.from), `${r.to} follows ${r.from} back, so it is delivered`);
    assert.notEqual(titleSpec(r.title).kind, 'series');
    assert.ok(!to.rankings.some((x) => x.key === r.title), `${r.to} has not ranked ${r.title}`);
    const id = `${r.from}>${r.to}>${r.title}`;
    assert.ok(!seen.has(id));
    seen.add(id);
    perSender.set(r.from, (perSender.get(r.from) ?? 0) + 1);
  }
  assert.ok(plan.recommendations.length >= 3);
  for (const c of perSender.values()) assert.ok(c < 20, 'under recommendations.max_per_hour');
});

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

test('the target is a hard-coded staging constant', () => {
  assert.equal(STAGING_REF, 'fjxhcbowoxuzulwirzyr');
  assert.equal(STAGING_HOST, 'fjxhcbowoxuzulwirzyr.supabase.co');
  assert.equal(STAGING_URL, 'https://fjxhcbowoxuzulwirzyr.supabase.co');
  const backends = require('../../config/backends.cjs');
  assert.equal(backends.STAGING_REF, STAGING_REF);
  assert.equal(backends.PRODUCTION_REF, PRODUCTION_REF);
});

test('the URL guard refuses production and look-alikes', () => {
  assert.doesNotThrow(() => assertStagingUrl(`${STAGING_URL}/rest/v1/rpc/environment_name`));
  for (const bad of [
    `https://${PRODUCTION_REF}.supabase.co`,
    `https://${PRODUCTION_REF}.supabase.co/rest/v1/profiles`,
    `http://${STAGING_HOST}`,
    `https://${STAGING_HOST}.evil.example`,
    `https://evil.example/?x=${STAGING_HOST}`,
    `https://user:pass@${STAGING_HOST}`,
    `https://${STAGING_HOST}:8443`,
    `https://${STAGING_HOST}/?also=${PRODUCTION_REF}`,
    'https://api.supabase.com',
    'not a url',
  ]) {
    assert.throws(() => assertStagingUrl(bad), /Refusing/, bad);
  }
});

test('the key guard refuses a production ref claim, a wrong role and garbage', () => {
  assert.doesNotThrow(() => assertStagingKey(fakeJwt({ ref: STAGING_REF, role: 'anon' }), 'anon'));
  assert.doesNotThrow(() => assertStagingKey(fakeJwt({ ref: STAGING_REF, role: 'service_role' }), 'service_role'));
  assert.throws(() => assertStagingKey(fakeJwt({ ref: PRODUCTION_REF, role: 'service_role' }), 'service_role'), /production/);
  assert.throws(() => assertStagingKey(fakeJwt({ ref: PRODUCTION_REF, role: 'anon' }), 'anon'), /production/);
  assert.throws(() => assertStagingKey(fakeJwt({ ref: 'someotherproject00', role: 'anon' }), 'anon'), /Refusing/);
  assert.throws(() => assertStagingKey(fakeJwt({ role: 'anon' }), 'anon'), /Refusing/);
  assert.throws(() => assertStagingKey(fakeJwt({ ref: STAGING_REF, role: 'anon' }), 'service_role'), /Refusing/);
  assert.throws(() => assertStagingKey('sb_secret_abc', 'service_role'), /Refusing/);
  assert.throws(() => assertStagingKey(undefined, 'anon'), /Refusing/);
});

test('the lane guard accepts the repo config and refuses one that points preview at production', () => {
  const backends = require('../../config/backends.cjs');
  const lane = require('../../config/production-lane.cjs');
  assert.doesNotThrow(() => assertLaneConfig({ ...backends, ...lane }));
  assert.throws(
    () => assertLaneConfig({ LANE_BACKENDS: { preview: [PRODUCTION_REF] }, environmentForRef: lane.environmentForRef }),
    /Refusing/,
  );
  assert.throws(
    () => assertLaneConfig({ LANE_BACKENDS: backends.LANE_BACKENDS, environmentForRef: () => 'production' }),
    /Refusing/,
  );
  assert.throws(() => assertLaneConfig({ LANE_BACKENDS: backends.LANE_BACKENDS, environmentForRef: () => 'nonprod' }), /production nonprod/);
  assert.throws(() => assertLaneConfig({}), /Refusing/);
});

test("the database's own answer must be nonprod", () => {
  assert.doesNotThrow(() => assertEnvironmentAnswer(200, 'nonprod'));
  assert.throws(() => assertEnvironmentAnswer(200, 'production'), /Refusing/);
  assert.throws(() => assertEnvironmentAnswer(404, 'nonprod'), /Refusing/);
  assert.throws(() => assertEnvironmentAnswer(200, null), /Refusing/);
});

test('the script reads no environment, no .env and accepts no target override', () => {
  const src = readFileSync(new URL('../../scripts/staging/qa-cohort.mjs', import.meta.url), 'utf8');
  assert.ok(!/process\.env/.test(src), 'no process.env');
  assert.ok(!/readFileSync|dotenv|loadEnv/.test(src), 'no .env file is read');
  // The one `--project-ref` is the Supabase CLI key fetch, pinned to the constant.
  assert.equal(src.match(/--project-ref/g)?.length, 1);
  assert.ok(src.includes('--project-ref ${STAGING_REF} -o json'));
  assert.ok(!/--(project(?!-ref \$\{STAGING_REF\})|ref|url|target|host)/.test(src), 'no target flag');
  assert.ok(src.includes("command === 'seed' ? ['--dry-run'] : []"), 'the only accepted flag is --dry-run');
  assert.ok(!/writeFile|appendFile|createWriteStream/.test(src), 'writes no files');
  const refs = src.match(/[a-z]{20}\.supabase\.co|'[a-z]{20}'/g) ?? [];
  assert.deepEqual([...new Set(refs)].sort(), [`'${PRODUCTION_REF}'`, `'${STAGING_REF}'`].sort());
});

// ---------------------------------------------------------------------------
// The reset selector
// ---------------------------------------------------------------------------

test('reset deletes only marked cohort accounts with matching email and qa_ profile', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const cohortUser = { id, email: 'qa-cohort+horror_fan@example.com', app_metadata: { qa_cohort: COHORT_MARKER } };
  const cohortProfile = { id, username: 'qa_horror_fan' };
  assert.equal(isResettableCohortAccount(cohortUser, cohortProfile), true);

  const probeUser = { id, email: 'qa-cohort+probe_a1b2c3@example.com', app_metadata: { qa_cohort: PROBE_MARKER } };
  assert.equal(isResettableCohortAccount(probeUser, { id, username: 'qa_probe_a1b2c3' }), true);

  // The real founder accounts on staging, and every near miss.
  const founder = { id, email: 'someone@gmail.com', app_metadata: { provider: 'email' } };
  assert.equal(isResettableCohortAccount(founder, { id, username: 'bingdtest' }), false);
  assert.equal(isResettableCohortAccount(founder, { id, username: 'bingdsocial2' }), false);
  assert.equal(isResettableCohortAccount({ ...founder, app_metadata: { qa_cohort: 'v1' } }, { id, username: 'bingdtest' }), false);
  assert.equal(isResettableCohortAccount({ ...cohortUser, app_metadata: {} }, cohortProfile), false, 'no marker');
  assert.equal(isResettableCohortAccount({ ...cohortUser, app_metadata: { qa_cohort: 'v2' } }, cohortProfile), false);
  assert.equal(isResettableCohortAccount({ ...cohortUser, user_metadata: { qa_cohort: 'v1' }, app_metadata: {} }, cohortProfile), false, 'user_metadata is user-writable and does not count');
  assert.equal(isResettableCohortAccount({ ...cohortUser, email: 'qa-cohort+horror_fan@example.com.evil.io' }, cohortProfile), false);
  assert.equal(isResettableCohortAccount({ ...cohortUser, email: 'horror_fan@example.com' }, cohortProfile), false);
  assert.equal(isResettableCohortAccount(cohortUser, { id, username: 'bingdtest' }), false, 'not qa_');
  assert.equal(isResettableCohortAccount(cohortUser, { id, username: 'qa_scifi_fan' }), false, 'name mismatch');
  assert.equal(isResettableCohortAccount(cohortUser, { id: '00000000-0000-4000-8000-000000000002', username: 'qa_horror_fan' }), false, 'profile of another id');
  assert.equal(isResettableCohortAccount(cohortUser, undefined), false, 'no profile');
  assert.equal(isResettableCohortAccount({ ...probeUser, app_metadata: { qa_cohort: COHORT_MARKER } }, { id, username: 'qa_probe_a1b2c3' }), false, 'probe name under the cohort marker');
  assert.equal(isResettableCohortAccount(null, cohortProfile), false);
});
