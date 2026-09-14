import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * An import that keeps up — `20260917001700`, the 2,500-title scale gate.
 *
 * `supabase/tests/perf/import-scale.mjs` found these against a real PostgreSQL at library
 * scale. Each property is pinned here at the smallest size that can show it, so it is held
 * on every run rather than on the day somebody benchmarks.
 *
 *   - a provider claim is a lease: a row in hand is not offered twice, and an answer clears it
 *   - "the provider answered and had nothing" settles a row at once; a lost request does not
 *   - an answer for a job that has already ended changes nothing
 *   - claims take every job's titles in turn
 *   - a job holds for an answer still in flight, even on the row's last attempt
 *   - the provider grace is measured from the provider's activity, not from the job's age
 *   - a tick works its jobs until the work or the budget runs out
 *   - the installer schedules a ten-second drain and a once-a-minute maintenance job
 */

let t;
let seq = 171000;

const staged = (name, over = {}) => ({
  kind: 'watched',
  correlation: `${name.toLowerCase()}|2001`,
  name,
  year: 2001,
  filmUri: `https://boxd.it/${name.toLowerCase().replace(/\W/g, '')}`,
  bucket: 'loved',
  ...over,
});

/** Stages an archive for `user` and hands it to the worker, without draining it. */
const stageArchive = async (user, rows) => {
  await t.actAs(user);
  const { rows: created } = await t.sql(`select import_create() as id`);
  const jobId = created[0].id;
  await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, JSON.stringify(rows)]);
  await t.sql(`select import_ready($1) as r`, [jobId]);
  await t.actAs(null);
  return jobId;
};

/** Titles the catalogue cannot place, so every one of them is the provider's. */
const unknownTitles = (n) =>
  Array.from({ length: n }, () => {
    const name = `Keeps Up Unknown ${seq++}`;
    return staged(name);
  });

const statusOf = async (jobId) =>
  (await t.sql(`select status, completed_at, counts from import_jobs where id = $1`, [jobId]))
    .rows[0];

/** A provider tier that "exists": a base URL and a vault secret, as push-drain.test.mjs builds it. */
const configureProvider = async () => {
  await t.sql(`create schema if not exists vault`);
  await t.sql(
    `create table if not exists vault.secrets (name text primary key, secret text not null)`,
  );
  await t.sql(
    `create or replace view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets`,
  );
  await t.sql(
    `insert into vault.secrets values ('service_role_key', 'not-a-real-key') on conflict do nothing`,
  );
  await t.sql(
    `insert into app_config (key, value) values ('functions.base_url', '"https://example.invalid"'::jsonb)
     on conflict (key) do update set value = excluded.value`,
  );
};

const unconfigureProvider = async () => {
  await t.sql(`delete from app_config where key = 'functions.base_url'`);
  await t.sql(`drop view if exists vault.decrypted_secrets`);
  await t.sql(`drop table if exists vault.secrets`);
};

/** Ticks until the job leaves `matching`, so its rows are waiting on the provider. */
const matchOut = async (jobId) => {
  for (let i = 0; i < 10; i += 1) {
    if ((await statusOf(jobId)).status !== 'matching') return;
    await t.sql(`select _drain_import_jobs() as r`);
  }
};

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close?.();
});

describe('a provider claim is a lease', () => {
  let ona;

  before(async () => {
    ona = await t.createUser({ username: 'keeps_ona' });
  });

  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
  });

  it('does not offer a row that is already in hand', async () => {
    await stageArchive(ona, unknownTitles(1));
    await t.sql(`select _import_match_batch(id, 100) from import_jobs`);

    const first = await t.sql(`select * from _import_provider_claim(50)`);
    assert.equal(first.rows.length, 1);

    // An overlapping invocation, inside the lease: nothing to take.
    const overlap = await t.sql(`select * from _import_provider_claim(50)`);
    assert.equal(overlap.rows.length, 0, 'a leased row must not be searched twice at once');

    // The first invocation died without answering. Once the lease lapses, it is offered again,
    // on its second attempt.
    await t.sql(`update import_rows set provider_claimed_at = now() - interval '3 minutes'`);
    const retry = await t.sql(`select * from _import_provider_claim(50)`);
    assert.equal(retry.rows.length, 1);
    const { rows } = await t.sql(`select provider_attempts from import_rows`);
    assert.equal(rows[0].provider_attempts, 2);
  });

  it('is released by an answer, so a row the provider could not decide is offered again at once', async () => {
    await stageArchive(ona, unknownTitles(1));
    await t.sql(`select _import_match_batch(id, 100) from import_jobs`);

    const { rows: claims } = await t.sql(`select * from _import_provider_claim(50)`);
    await t.sql(`select _import_provider_resolve($1, null)`, [claims[0].row_id]);

    const { rows: row } = await t.sql(`select status, provider_claimed_at from import_rows`);
    assert.equal(row[0].status, 'needs_provider', 'not final: still retryable');
    assert.equal(row[0].provider_claimed_at, null, 'and no longer in hand');
    assert.equal((await t.sql(`select * from _import_provider_claim(50)`)).rows.length, 1);
  });

  it('settles a row at once when the provider answered and had nothing', async () => {
    await stageArchive(ona, unknownTitles(1));
    await t.sql(`select _import_match_batch(id, 100) from import_jobs`);

    const { rows: claims } = await t.sql(`select * from _import_provider_claim(50)`);
    await t.sql(`select _import_provider_resolve($1, null, true)`, [claims[0].row_id]);

    const { rows } = await t.sql(`select status, provider_attempts from import_rows`);
    assert.equal(rows[0].status, 'unmatched', 'the same search would get the same answer');
    assert.equal(rows[0].provider_attempts, 1, 'one request, not three');
  });

  it('changes nothing when the answer arrives after its job has ended', async () => {
    const jobId = await stageArchive(ona, unknownTitles(1));
    await t.sql(`select _import_match_batch($1, 100)`, [jobId]);
    const { rows: claims } = await t.sql(`select * from _import_provider_claim(50)`);

    await t.sql(`select _import_settle($1)`, [jobId]);
    const film = (
      await t.sql(
        `insert into media_items (kind, tmdb_id, title, release_date, provenance)
         values ('movie', $1, 'Late Answer', '2001-06-01', 'manual') returning id`,
        [-seq++],
      )
    ).rows[0].id;
    await t.sql(`select _import_provider_resolve($1, $2)`, [claims[0].row_id, film]);

    const { rows } = await t.sql(
      `select status, media_item_id from import_rows where job_id = $1`,
      [jobId],
    );
    assert.equal(rows[0].status, 'needs_provider', 'a finished job is not written to');
    assert.equal(rows[0].media_item_id, null);
    assert.equal(
      (
        await t.sql(
          `select count(*)::int as n from letterboxd_match_claims where media_item_id = $1`,
          [film],
        )
      ).rows[0].n,
      0,
      'and a late answer teaches nothing',
    );
  });

  it('refunds a claim the provider was never asked about, so a rate limit cannot use a title up', async () => {
    // Independent review 83a: an invocation that stops at a 429 leaves the rest of its batch
    // claimed. Three of those used to settle a findable film unmatched without one request.
    await stageArchive(ona, unknownTitles(1));
    await t.sql(`select _import_match_batch(id, 100) from import_jobs`);

    for (let i = 0; i < 5; i += 1) {
      const { rows: claims } = await t.sql(`select * from _import_provider_claim(50)`);
      assert.equal(claims.length, 1, `offered again after release ${i}`);
      const { rows } = await t.sql(`select _import_provider_release($1::uuid[]) as n`, [
        [claims[0].row_id],
      ]);
      assert.equal(rows[0].n, 1);
    }
    const { rows } = await t.sql(
      `select status, provider_attempts, provider_claimed_at from import_rows`,
    );
    assert.equal(rows[0].status, 'needs_provider');
    assert.equal(rows[0].provider_attempts, 0, 'five rate-limited invocations cost it nothing');
    assert.equal(rows[0].provider_claimed_at, null);
  });

  it('releases only rows still leased and still waiting', async () => {
    await stageArchive(ona, unknownTitles(1));
    await t.sql(`select _import_match_batch(id, 100) from import_jobs`);
    const { rows: claims } = await t.sql(`select * from _import_provider_claim(50)`);
    await t.sql(`select _import_provider_resolve($1, null, true)`, [claims[0].row_id]);

    const { rows } = await t.sql(`select _import_provider_release($1::uuid[]) as n`, [
      [claims[0].row_id],
    ]);
    assert.equal(rows[0].n, 0, 'an answered row is not handed back');
    const { rows: row } = await t.sql(`select status, provider_attempts from import_rows`);
    assert.equal(row[0].status, 'unmatched');
    assert.equal(row[0].provider_attempts, 1);
  });

  it("takes every job's titles in turn", async () => {
    const pia = await t.createUser({ username: `keeps_pia_${seq}` });
    const big = await stageArchive(ona, unknownTitles(6));
    const small = await stageArchive(pia, unknownTitles(2));
    await t.sql(`select _import_match_batch(id, 100) from import_jobs`);

    const { rows } = await t.sql(
      `select r.job_id from _import_provider_claim(2) c join import_rows r on r.id = c.row_id`,
    );
    const jobs = new Set(rows.map((r) => r.job_id));
    assert.deepEqual(
      jobs,
      new Set([big, small]),
      'the small import is not queued behind the big one',
    );
  });
});

describe('a job and the provider it waits for', () => {
  let ren;

  before(async () => {
    ren = await t.createUser({ username: 'keeps_ren' });
  });

  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
    await configureProvider();
  });

  afterEach(async () => {
    await unconfigureProvider();
  });

  it("holds for an answer still in flight, even on the row's last attempt", async () => {
    const jobId = await stageArchive(ren, unknownTitles(1));
    await matchOut(jobId);

    await t.sql(`update import_rows set provider_attempts = 2 where job_id = $1`, [jobId]);
    const { rows: claims } = await t.sql(`select * from _import_provider_claim(50)`);
    assert.equal(claims.length, 1, 'the third attempt is in hand');

    for (let i = 0; i < 3; i += 1) await t.sql(`select _drain_import_jobs() as r`);
    assert.equal(
      (await statusOf(jobId)).completed_at,
      null,
      'the job waits for the answer it handed out',
    );

    await t.sql(`select _import_provider_resolve($1, null, true)`, [claims[0].row_id]);
    await t.sql(`select _drain_import_jobs() as r`);
    const end = await statusOf(jobId);
    assert.equal(end.status, 'done');
    assert.equal(end.counts.unmatched, 1);
  });

  it("measures the grace from the provider's activity, not from the job's age", async () => {
    const jobId = await stageArchive(ren, unknownTitles(1));
    await matchOut(jobId);
    await t.sql(`select _drain_import_jobs() as r`);

    // Two hours old — past any grace counted from creation — but the provider claimed for it
    // a moment ago. That is a long import being worked through, and it must not be cut off.
    await t.sql(
      `update import_jobs set created_at = now() - interval '2 hours' where id = $1`,
      [jobId],
    );
    await t.sql(`select * from _import_provider_claim(50)`);
    await t.sql(`update import_rows set provider_claimed_at = null where job_id = $1`, [jobId]);
    await t.sql(`select _drain_import_jobs() as r`);
    assert.equal(
      (await statusOf(jobId)).completed_at,
      null,
      'a working provider keeps the job open',
    );

    // The provider then goes silent for longer than the grace. The wait ends honestly.
    await t.sql(
      `update import_jobs set provider_touched_at = now() - interval '31 minutes' where id = $1`,
      [jobId],
    );
    await t.sql(`select _drain_import_jobs() as r`);
    const end = await statusOf(jobId);
    assert.equal(end.status, 'done', 'a silent provider still ends in a summary');
    assert.equal(end.counts.unmatched, 1);
  });

  it('starts no second provider invocation while one is in flight', async () => {
    // One invocation at a time is what bounds TMDB traffic (review 83a). PGlite has no `net`
    // schema, so the nudge is observed through a recorder installed for this test.
    await t.sql(`create schema if not exists net`);
    await t.sql(`create table if not exists net.keeps_posts (id serial, body jsonb)`);
    await t.sql(
      `create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
         headers jsonb default '{}', timeout_milliseconds integer default 5000)
       returns bigint language sql as $f$ insert into net.keeps_posts (body) values (body) returning id::bigint $f$`,
    );
    try {
      const jobId = await stageArchive(ren, unknownTitles(3));
      await matchOut(jobId);
      await t.sql(`delete from net.keeps_posts`);

      await t.sql(`select _drain_import_jobs() as r`);
      assert.equal(
        (await t.sql(`select count(*)::int as n from net.keeps_posts`)).rows[0].n,
        1,
      );

      // An invocation takes one row and is still working on it.
      await t.sql(`select * from _import_provider_claim(1)`);
      await t.sql(`delete from net.keeps_posts`);
      await t.sql(`select _drain_import_jobs() as r`);
      assert.equal(
        (await t.sql(`select count(*)::int as n from net.keeps_posts`)).rows[0].n,
        0,
        'two rows are unasked, but an invocation is in flight',
      );
    } finally {
      await t.sql(`drop function if exists net.http_post(text, jsonb, jsonb, jsonb, integer)`);
      await t.sql(`drop table if exists net.keeps_posts`);
    }
  });

  it('starts the grace when the job starts applying, for a provider that never claims at all', async () => {
    const jobId = await stageArchive(ren, unknownTitles(1));
    await matchOut(jobId);
    const { rows } = await t.sql(`select provider_touched_at from import_jobs where id = $1`, [
      jobId,
    ]);
    assert.ok(rows[0].provider_touched_at, 'the clock starts at applying, not at creation');
  });
});

describe('a tick', () => {
  let sol;

  before(async () => {
    sol = await t.createUser({ username: 'keeps_sol' });
  });

  afterEach(async () => {
    await t.sql(`delete from app_config where key = 'import.tick_budget_ms'`);
    await t.sql(
      `insert into app_config (key, value) values ('import.tick_budget_ms', '2000'::jsonb)
       on conflict (key) do nothing`,
    );
  });

  it('works a job slice after slice until it is done, inside its budget', async () => {
    await t.sql(
      `insert into app_config (key, value) values ('import.tick_budget_ms', '20000'::jsonb)
       on conflict (key) do update set value = excluded.value`,
    );
    const names = Array.from({ length: 60 }, () => `Keeps Up Local ${seq++}`);
    for (const name of names) {
      await t.sql(
        `insert into media_items (kind, tmdb_id, title, release_date, provenance)
         values ('movie', $1, $2, '2001-06-01', 'manual')`,
        [-seq++, name],
      );
    }
    const jobId = await stageArchive(
      sol,
      names.map((name) => staged(name)),
    );

    // Slices of ten, sixty rows: one slice per tick used to need fourteen ticks.
    const { rows } = await t.sql(`select _drain_import_jobs(8, 10) as r`);
    const end = await statusOf(jobId);
    assert.equal(
      end.status,
      'done',
      `one tick finished the job (${JSON.stringify(rows[0].r)})`,
    );
    assert.equal(end.counts.applied, 60);
    assert.ok(rows[0].r.passes > 1, 'by working it more than once');
  });

  it('leaves the rest of the work for the next tick when the budget is spent', async () => {
    await t.sql(
      `insert into app_config (key, value) values ('import.tick_budget_ms', '100'::jsonb)
       on conflict (key) do update set value = excluded.value`,
    );
    const names = Array.from({ length: 40 }, () => `Keeps Up Budget ${seq++}`);
    for (const name of names) {
      await t.sql(
        `insert into media_items (kind, tmdb_id, title, release_date, provenance)
         values ('movie', $1, $2, '2001-06-01', 'manual')`,
        [-seq++, name],
      );
    }
    const jobId = await stageArchive(
      sol,
      names.map((name) => staged(name)),
    );
    for (let i = 0; i < 40; i += 1) {
      if ((await statusOf(jobId)).completed_at) break;
      await t.sql(`select _drain_import_jobs(8, 1) as r`);
    }
    const end = await statusOf(jobId);
    assert.equal(end.status, 'done', 'a small budget is slower, never wrong');
    assert.equal(end.counts.applied, 40);
  });
});

describe('the schedule', () => {
  it('drains every ten seconds and maintains once a minute', async () => {
    const { rows } = await t.sql(
      `select pg_get_functiondef('schedule_import_drain(text)'::regprocedure) as src`,
    );
    const src = rows[0].src;
    assert.match(src, /DEFAULT '10 seconds'/i);
    assert.match(src, /'bingd-import-drain'/);
    assert.match(src, /'bingd-import-maintenance'/);
    // The sweep and the poster nudge moved to the minute job: the nudge must not re-ask for
    // posters still being fetched every ten seconds.
    assert.match(src, /_import_sweep_abandoned\(\), public\._import_enrich_nudge\(\)/);
    assert.doesNotMatch(src, /_drain_import_jobs\(\), public\._import_sweep_abandoned/);
  });

  it('falls back to once a minute where pg_cron cannot schedule in seconds', async () => {
    const { rows } = await t.sql(
      `select pg_get_functiondef('schedule_import_drain(text)'::regprocedure) as src`,
    );
    assert.match(rows[0].src, /fell back to one minute/);
  });
});
