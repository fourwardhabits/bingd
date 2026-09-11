import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The import pipeline and the provenance rule — `20260917000200`, `20260917000300`.
 *
 * ---------------------------------------------------------------------------
 * TESTED BY INTENT, NOT BY TRIGGER
 *
 * The founder's instruction about provenance was explicit: a watchlist change, a note edit
 * or a maintenance sweep must not turn an imported history into native watches, and the
 * test for that must be about what a person did rather than about which trigger fired.
 *
 * So the provenance suites below are written as sentences about behaviour — "they ranked
 * it here", "they only edited the note" — and none of them mentions
 * `_source_follows_the_watch`. If that implementation is replaced tomorrow by a smarter
 * one, these keep meaning exactly what they mean now.
 */

let t;
let seq = 97000;

const count = async (table, where = 'true') => {
  const { rows } = await t.sql(`select count(*)::int as n from ${table} where ${where}`);
  return rows[0].n;
};

const sourceOf = async (user, item) => {
  const { rows } = await t.sql(
    `select source from user_media where user_id = $1 and media_item_id = $2`,
    [user, item],
  );
  return rows[0]?.source ?? null;
};

/** A row as the client stages it, after parsing. */
const staged = (name, over = {}) => ({
  kind: 'watched',
  correlation: `${name.toLowerCase()}|2001`,
  name,
  year: 2001,
  filmUri: `https://boxd.it/${name.toLowerCase().replace(/\W/g, '')}`,
  rating: 4.5,
  bucket: 'loved',
  watchedOn: null,
  ...over,
});

/** Runs a whole job to completion the way the cron tick would, but deterministically. */
const runJob = async (jobId, { slice = 500, ticks = 40 } = {}) => {
  for (let i = 0; i < ticks; i += 1) {
    const { rows } = await t.sql(`select _drain_import_jobs(5, $1) as r`, [slice]);
    const done = await t.sql(`select status, completed_at from import_jobs where id = $1`, [jobId]);
    if (done.rows[0]?.completed_at) return rows[0].r;
  }
  throw new Error('job did not finish within the tick budget');
};

/** Stages rows and hands the job to the worker, as the client does. */
const importArchive = async (user, rows) => {
  await t.actAs(user);
  const { rows: created } = await t.sql(`select import_create() as id`);
  const jobId = created[0].id;
  await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, JSON.stringify(rows)]);
  await t.sql(`select import_ready($1) as r`, [jobId]);
  await t.actAs(null);
  await runJob(jobId);
  return jobId;
};

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t.close();
});

// ===========================================================================
// Provenance — by intent
// ===========================================================================

describe('who the watched state belongs to', () => {
  let alice;
  let film;

  before(async () => {
    alice = await t.createUser({ username: 'prov_alice' });
  });

  beforeEach(async () => {
    await t.sql(`delete from rankings`);
    await t.sql(`delete from user_media`);
    await t.sql(`delete from watchlist`);
    film = await t.createMovie(`Provenance ${seq}`, seq++);
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, source)
       values ($1, $2, 'loved', 'imported')`,
      [alice, film],
    );
  });

  it('stays imported when nothing has happened here', async () => {
    assert.equal(await sourceOf(alice, film), 'imported');
  });

  it('becomes native when they log a watch date here', async () => {
    await t.actAs(alice);
    await t.sql(`select log_watched(gen_random_uuid(), $1, current_date) as r`, [film]);
    assert.equal(await sourceOf(alice, film), 'in_app');
  });

  it('becomes native when they change the bucket here', async () => {
    await t.actAs(alice);
    await t.sql(`select set_bucket(gen_random_uuid(), $1, 'fine') as r`, [film]);
    assert.equal(await sourceOf(alice, film), 'in_app');
  });

  it('becomes native when they rank it here, even inside the band the import chose', async () => {
    // THE case a trigger on user_media alone cannot see. `_rank_finalize`'s upsert is
    // guarded by `where bucket is distinct from excluded.bucket`, so ranking a `loved`
    // imported film into the `loved` band updates no collection row at all.
    await t.actAs(alice);
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved', 1)`,
      [alice, film],
    );
    assert.equal(await sourceOf(alice, film), 'in_app');
  });

  it('stays imported when they only write a note about it', async () => {
    // Writing about a film is not watching it here.
    await t.actAs(alice);
    await t.sql(`select save_note(gen_random_uuid(), $1, 'a thought') as r`, [film]);
    assert.equal(await sourceOf(alice, film), 'imported');
  });

  it('stays imported when they publish that note as a review', async () => {
    await t.actAs(alice);
    await t.sql(
      `select save_note(gen_random_uuid(), $1, 'a review', null, 'public'::note_visibility) as r`,
      [film],
    );
    assert.equal(await sourceOf(alice, film), 'imported');
  });

  it('stays imported when a watch date is cleared rather than recorded', async () => {
    // The date is inserted with the row rather than updated onto it, because updating it
    // outside an import IS recording a watch here — which the suite above already asserts.
    const dated = await t.createMovie(`Dated ${seq}`, seq++);
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, watched_on, source)
       values ($1, $2, 'loved', current_date, 'imported')`,
      [alice, dated],
    );

    await t.actAs(alice);
    await t.sql(`select clear_watch_date(gen_random_uuid(), $1) as r`, [dated]);
    assert.equal(await sourceOf(alice, dated), 'imported');
  });

  it('stays imported through watchlist activity', async () => {
    // The founder's explicit case. `watchlist` is a different table and nothing in it
    // writes `user_media` — the dependency runs the other way.
    const other = await t.createMovie(`Wanted ${seq}`, seq++);
    await t.actAs(alice);
    await t.sql(`select set_watchlist(gen_random_uuid(), $1, true) as r`, [other]);
    await t.sql(`select set_watchlist(gen_random_uuid(), $1, false) as r`, [other]);
    assert.equal(await sourceOf(alice, film), 'imported');
  });

  it('stays imported through a maintenance sweep that touches every row', async () => {
    // The shape of a backfill migration. It must not manufacture native watches.
    await t.sql(`update user_media set updated_at = now()`);
    assert.equal(await sourceOf(alice, film), 'imported');
  });

  it('never goes back to imported once it is native', async () => {
    // The ratchet. Native-wins stops being a rule the apply path remembers and becomes a
    // thing the database will not do.
    await t.actAs(alice);
    await t.sql(`select set_bucket(gen_random_uuid(), $1, 'fine') as r`, [film]);
    assert.equal(await sourceOf(alice, film), 'in_app');

    await t.actAs(null);
    await t.sql(
      `update user_media set source = 'imported' where user_id = $1 and media_item_id = $2`,
      [alice, film],
    );
    assert.equal(await sourceOf(alice, film), 'in_app', 'the ratchet must refuse the downgrade');
  });

  it('lets an import write its own rows without claiming them as native', async () => {
    await t.sql(`do $$ begin
      perform set_config('bingd.import_running', txid_current()::text, true);
      update user_media set watched_on = current_date, bucket = 'fine';
    end $$;`);
    assert.equal(await sourceOf(alice, film), 'imported');
  });
});

// ===========================================================================
// The pipeline, end to end
// ===========================================================================

describe('an archive that imports cleanly', () => {
  let bob;
  let shrek;
  let barbie;
  let wanted;
  let jobId;

  before(async () => {
    bob = await t.createUser({ username: 'pipe_bob' });
    shrek = await t.createMovie('Shrek', seq++);
    barbie = await t.createMovie('Barbie', seq++);
    wanted = await t.createMovie('Obsession', seq++);

    jobId = await importArchive(bob, [
      staged('Shrek', { rating: 4.5, bucket: 'loved', watchedOn: '2024-03-04',
        watches: [{ diaryUri: 'https://boxd.it/d1', watchedOn: '2024-03-04', isRewatch: false },
                  { diaryUri: 'https://boxd.it/d2', watchedOn: '2023-01-02', isRewatch: true }] }),
      staged('Barbie', { rating: 2, bucket: 'not_for_me' }),
      staged('Obsession', { kind: 'watchlist', correlation: 'obsession|2001', rating: null, bucket: null }),
    ]);
  });

  it('finishes the job and records what it did', async () => {
    const { rows } = await t.sql(`select status, counts from import_jobs where id = $1`, [jobId]);
    assert.equal(rows[0].status, 'done');
    assert.equal(rows[0].counts.applied, 3);
  });

  it('puts the watched films in the collection, marked imported', async () => {
    assert.equal(await sourceOf(bob, shrek), 'imported');
    assert.equal(await sourceOf(bob, barbie), 'imported');
  });

  it('carries the star across as a bucket prior', async () => {
    const { rows } = await t.sql(
      `select bucket from user_media where user_id = $1 and media_item_id = $2`, [bob, shrek]);
    assert.equal(rows[0].bucket, 'loved');
  });

  it('keeps the raw star beside it, so the policy stays reversible', async () => {
    const { rows } = await t.sql(
      `select rating, source_name from imported_titles where user_id = $1 and media_item_id = $2`,
      [bob, shrek]);
    assert.equal(Number(rows[0].rating), 4.5);
    assert.equal(rows[0].source_name, 'Shrek');
  });

  it('takes the watch date only from the diary, and the most recent one', async () => {
    const { rows } = await t.sql(
      `select watched_on from user_media where user_id = $1 and media_item_id = $2`, [bob, shrek]);
    assert.equal(rows[0].watched_on.toISOString().slice(0, 10), '2024-03-04');

    const { rows: none } = await t.sql(
      `select watched_on from user_media where user_id = $1 and media_item_id = $2`, [bob, barbie]);
    assert.equal(none[0].watched_on, null, 'a film with no diary entry gets no date');
  });

  it('keeps both viewings as provenance', async () => {
    assert.equal(await count('imported_watches', `user_id = '${bob}'`), 2);
    const { rows } = await t.sql(
      `select diary_uri, is_rewatch from imported_watches where user_id = $1 order by watched_on`,
      [bob]);
    assert.equal(rows[0].is_rewatch, true);
  });

  it('puts the watchlist film on the watchlist and not in the collection', async () => {
    assert.equal(await count('watchlist', `user_id = '${bob}' and media_item_id = '${wanted}'`), 1);
    assert.equal(await sourceOf(bob, wanted), null);
  });

  it('writes no rankings and no scores', async () => {
    assert.equal(await count('rankings', `user_id = '${bob}'`), 0);
  });

  it('writes no feed activity and no notifications', async () => {
    assert.equal(await count('feed_events', `actor_id = '${bob}'`), 0);
    assert.equal(await count('notifications', `recipient_id = '${bob}'`), 0);
  });

  it('counts for nothing on either leaderboard', async () => {
    for (const timeframe of ['all_time', 'month']) {
      const n = await t.asUser(bob, async () => {
        const { rows } = await t.sql(`select * from my_leaderboard_standing('titles', $1)`, [timeframe]);
        return rows[0]?.metric_count ?? 0;
      });
      assert.equal(n, 0, `${timeframe} must not count an imported history`);
    }
  });

  it('deletes the staging rows it applied', async () => {
    assert.equal(await count('import_rows', `job_id = '${jobId}' and status = 'applied'`), 0);
    assert.equal(await count('import_rows', `job_id = '${jobId}'`), 0);
  });
});

// ===========================================================================

describe('the same archive imported twice', () => {
  let carol;
  let film;

  before(async () => {
    carol = await t.createUser({ username: 'pipe_carol' });
    film = await t.createMovie('Twice', seq++);
  });

  const archive = () => [
    staged('Twice', { watchedOn: '2024-05-06',
      watches: [{ diaryUri: 'https://boxd.it/t1', watchedOn: '2024-05-06', isRewatch: false }] }),
  ];

  it('changes nothing the second time', async () => {
    await importArchive(carol, archive());
    const first = {
      media: await count('user_media', `user_id = '${carol}'`),
      titles: await count('imported_titles', `user_id = '${carol}'`),
      watches: await count('imported_watches', `user_id = '${carol}'`),
    };

    await importArchive(carol, archive());

    assert.deepEqual(
      {
        media: await count('user_media', `user_id = '${carol}'`),
        titles: await count('imported_titles', `user_id = '${carol}'`),
        watches: await count('imported_watches', `user_id = '${carol}'`),
      },
      first,
    );
    assert.equal(await sourceOf(carol, film), 'imported');
  });
});

describe('a re-import after the person has acted here', () => {
  let dave;
  let ranked;
  let logged;

  before(async () => {
    dave = await t.createUser({ username: 'pipe_dave' });
    ranked = await t.createMovie('Ranked Here', seq++);
    logged = await t.createMovie('Logged Here', seq++);
  });

  it('leaves a ranked title completely alone and keeps a logged one native', async () => {
    await importArchive(dave, [
      staged('Ranked Here', { correlation: 'ranked here|2001', bucket: 'loved', rating: 5 }),
      staged('Logged Here', { correlation: 'logged here|2001', bucket: 'loved', rating: 5 }),
    ]);

    // They rank one and re-bucket the other, here.
    await t.actAs(dave);
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved', 1)`,
      [dave, ranked],
    );
    await t.sql(`select set_bucket(gen_random_uuid(), $1, 'not_for_me') as r`, [logged]);
    await t.actAs(null);

    assert.equal(await sourceOf(dave, ranked), 'in_app');
    assert.equal(await sourceOf(dave, logged), 'in_app');

    // The same archive arrives again, still claiming both were loved.
    await importArchive(dave, [
      staged('Ranked Here', { correlation: 'ranked here|2001', bucket: 'loved', rating: 5 }),
      staged('Logged Here', { correlation: 'logged here|2001', bucket: 'loved', rating: 5 }),
    ]);

    assert.equal(await sourceOf(dave, ranked), 'in_app');
    assert.equal(await sourceOf(dave, logged), 'in_app');

    const { rows } = await t.sql(
      `select bucket from user_media where user_id = $1 and media_item_id = $2`, [dave, logged]);
    assert.equal(rows[0].bucket, 'not_for_me', 'the import must not overwrite a native opinion');

    assert.equal(await count('rankings', `user_id = '${dave}'`), 1, 'the ranking survives');
  });
});

// ===========================================================================

describe('titles the catalogue cannot place', () => {
  let erin;

  before(async () => {
    erin = await t.createUser({ username: 'pipe_erin' });
    // Two films that squash identically and sit a year apart: a remake.
    await t.sql(
      `insert into media_items (kind, tmdb_id, title, release_date)
       values ('movie', $1, 'The Beguiled', '1971-03-31'), ('movie', $2, 'The Beguiled', '1971-06-01')`,
      [seq++, seq++],
    );
  });

  it('leaves a remake unresolved rather than guessing', async () => {
    const jobId = await importArchive(erin, [
      staged('The Beguiled', { correlation: 'the beguiled|1971', year: 1971 }),
    ]);

    const { rows } = await t.sql(
      `select status, media_item_id, candidates from import_rows where job_id = $1`, [jobId]);
    assert.equal(rows.length, 1, 'an unresolved row is retained, not deleted');
    assert.equal(rows[0].status, 'ambiguous');
    assert.equal(rows[0].media_item_id, null, 'nothing is guessed');
    assert.equal(rows[0].candidates.length, 2);

    assert.equal(await count('user_media', `user_id = '${erin}'`), 0);
  });

  it('leaves an unknown title waiting for the provider rather than calling it unmatched', async () => {
    const jobId = await importArchive(erin, [
      staged('A Film The Catalogue Has Never Heard Of', {
        correlation: 'a film the catalogue has never heard of|2001' }),
    ]);

    const { rows } = await t.sql(`select status from import_rows where job_id = $1`, [jobId]);
    assert.equal(rows[0].status, 'needs_provider');

    const { rows: job } = await t.sql(`select counts from import_jobs where id = $1`, [jobId]);
    assert.equal(job[0].counts.unmatched, 1, 'the summary counts it as not placed');
  });

  it('finishes the job anyway, so a few unresolved titles never block the rest', async () => {
    const known = await t.createMovie('Definitely Known', seq++);
    const jobId = await importArchive(erin, [
      staged('Definitely Known', { correlation: 'definitely known|2001' }),
      staged('Nobody Has This One', { correlation: 'nobody has this one|2001' }),
    ]);

    const { rows } = await t.sql(`select status, counts from import_jobs where id = $1`, [jobId]);
    assert.equal(rows[0].status, 'done');
    assert.equal(rows[0].counts.applied, 1);
    assert.equal(await sourceOf(erin, known), 'imported');
  });
});

// ===========================================================================

describe('the shared match cache', () => {
  let frank;
  let grace;
  let film;

  before(async () => {
    frank = await t.createUser({ username: 'pipe_frank' });
    grace = await t.createUser({ username: 'pipe_grace' });
    film = await t.createMovie('Cached Film', seq++);
  });

  it('learns a film URI from one import and never a diary URI', async () => {
    await importArchive(frank, [
      staged('Cached Film', {
        correlation: 'cached film|2001',
        filmUri: 'https://boxd.it/FILMURI',
        watches: [{ diaryUri: 'https://boxd.it/DIARYURI', watchedOn: '2024-01-01', isRewatch: false }],
      }),
    ]);

    const { rows } = await t.sql(`select letterboxd_uri from letterboxd_matches`);
    const uris = rows.map((r) => r.letterboxd_uri);
    assert.ok(uris.includes('https://boxd.it/FILMURI'));
    assert.ok(
      !uris.includes('https://boxd.it/DIARYURI'),
      'a per-viewing URI must never become a global film identity',
    );
  });

  it('resolves the next importer for free, even under a title the catalogue would miss', async () => {
    await importArchive(grace, [
      staged('Cached Film But Spelled Differently', {
        correlation: 'cached film but spelled differently|2001',
        filmUri: 'https://boxd.it/FILMURI',
      }),
    ]);
    assert.equal(await sourceOf(grace, film), 'imported');
  });
});

// ===========================================================================

describe('goals and awards after an import', () => {
  let helen;

  before(async () => {
    helen = await t.createUser({ username: 'pipe_helen' });
  });

  it('counts a genuine diary date toward the year’s goal, and says nothing about it', async () => {
    // The locked decision: historical truth counts, fabricated engagement does not.
    await t.sql(
      `insert into watch_goals (user_id, year, category, target)
       values ($1, extract(year from current_date)::int, 'movies', 2)`,
      [helen],
    );

    const thisYear = new Date().getFullYear();
    const names = [];
    for (let i = 0; i < 2; i += 1) {
      const name = `Goal Film ${seq}`;
      await t.createMovie(name, seq);
      names.push(name);
      seq += 1;
    }

    await importArchive(helen, names.map((name, i) =>
      staged(name, {
        correlation: `${name.toLowerCase()}|2001`,
        watchedOn: `${thisYear}-02-0${i + 1}`,
        watches: [{ diaryUri: `https://boxd.it/g${i}`, watchedOn: `${thisYear}-02-0${i + 1}`, isRewatch: false }],
      })));

    const { rows } = await t.sql(
      `select _goal_qualifying_count($1, $2, 'movies') as n`, [helen, thisYear]);
    assert.equal(rows[0].n, 2, 'genuine diary dates are real viewing history');

    assert.equal(await count('feed_events', `actor_id = '${helen}'`), 0, 'no celebration');
    assert.equal(await count('notifications', `recipient_id = '${helen}'`), 0, 'no notification');
  });

  it('settles the award ledger once, silently', async () => {
    const { rows: tier } = await t.sql(
      `select min(threshold) as lowest from award_tiers where award_key = 'movie-muncher'`);
    const lowest = tier[0].lowest;

    const ivan = await t.createUser({ username: 'pipe_ivan' });
    const rows = [];
    for (let i = 0; i < lowest; i += 1) {
      await t.createMovie(`Muncher ${seq}`, seq);
      rows.push(staged(`Muncher ${seq}`, { correlation: `muncher ${seq}|2001` }));
      seq += 1;
    }

    await importArchive(ivan, rows);

    assert.ok(
      (await count('award_unlocks', `user_id = '${ivan}' and award_key = 'movie-muncher'`)) >= 1,
      'the ledger must be true',
    );
    assert.equal(await count('feed_events', `actor_id = '${ivan}'`), 0);
    assert.equal(await count('notifications', `recipient_id = '${ivan}'`), 0);
  });
});

// ===========================================================================

describe('the worker', () => {
  let jack;

  before(async () => {
    jack = await t.createUser({ username: 'pipe_jack' });
  });

  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
  });

  it('does nothing, cheaply, when there is nothing to do', async () => {
    const { rows } = await t.sql(`select _drain_import_jobs() as r`);
    assert.equal(rows[0].r.status, 'idle');
  });

  it('reclaims a job whose worker died mid-slice', async () => {
    await t.createMovie('Stranded', seq);
    await t.actAs(jack);
    const { rows: created } = await t.sql(`select import_create() as id`);
    const jobId = created[0].id;
    await t.sql(`select import_stage($1, $2::jsonb) as r`,
      [jobId, JSON.stringify([staged(`Stranded`, { correlation: 'stranded|2001' })])]);
    await t.sql(`select import_ready($1) as r`, [jobId]);
    await t.actAs(null);
    seq += 1;

    // A worker took it and never came back.
    await t.sql(
      `update import_jobs set claimed_at = now() - interval '10 minutes' where id = $1`, [jobId]);

    await runJob(jobId);
    const { rows } = await t.sql(`select status from import_jobs where id = $1`, [jobId]);
    assert.equal(rows[0].status, 'done', 'an expired lease must be reclaimable');
  });

  it('does not touch a job whose lease is still live', async () => {
    await t.actAs(jack);
    const { rows: created } = await t.sql(`select import_create() as id`);
    const jobId = created[0].id;
    await t.sql(`select import_ready($1) as r`, [jobId]);
    await t.actAs(null);

    await t.sql(`update import_jobs set claimed_at = now() where id = $1`, [jobId]);
    const { rows } = await t.sql(`select _drain_import_jobs() as r`);
    assert.equal(rows[0].r.jobs, 0, 'a live lease means another worker has it');
  });

  it('dead-letters a job that keeps failing', async () => {
    await t.actAs(jack);
    const { rows: created } = await t.sql(`select import_create() as id`);
    const jobId = created[0].id;
    await t.sql(`select import_ready($1) as r`, [jobId]);
    await t.actAs(null);

    await t.sql(`update import_jobs set failures = 3 where id = $1`, [jobId]);
    await t.sql(`select _drain_import_jobs() as r`);

    const { rows } = await t.sql(`select status, completed_at from import_jobs where id = $1`, [jobId]);
    assert.equal(rows[0].status, 'failed');
    assert.ok(rows[0].completed_at, 'a dead job must not hold the one-live-job slot for ever');
  });

  it('lets the account start again after a job dies', async () => {
    await t.actAs(jack);
    const { rows: first } = await t.sql(`select import_create() as id`);
    await t.sql(`select import_ready($1) as r`, [first[0].id]);
    await t.actAs(null);
    await t.sql(`update import_jobs set failures = 3 where id = $1`, [first[0].id]);
    await t.sql(`select _drain_import_jobs() as r`);

    await t.actAs(jack);
    const { rows: second } = await t.sql(`select import_create() as id`);
    assert.notEqual(second[0].id, first[0].id);
    await t.actAs(null);
  });

  it('gives one account one live job', async () => {
    await t.actAs(jack);
    const { rows: a } = await t.sql(`select import_create() as id`);
    const { rows: b } = await t.sql(`select import_create() as id`);
    assert.equal(a[0].id, b[0].id, 'a second tap resumes rather than forking');
    await t.actAs(null);
  });
});

// ===========================================================================

describe('the provider tier', () => {
  let nina;
  let jobId;

  const stageNeedsProvider = async (n) => {
    await t.actAs(nina);
    const { rows } = await t.sql(`select import_create() as id`);
    jobId = rows[0].id;
    const payload = Array.from({ length: n }, (_, i) =>
      staged(`Provider Unknown ${seq + i}`, { correlation: `provider unknown ${seq + i}|2001` }));
    seq += n;
    await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, JSON.stringify(payload)]);
    await t.sql(`select import_ready($1) as r`, [jobId]);
    await t.actAs(null);
    await t.sql(`select _import_match_batch($1, 100)`, [jobId]);
    return jobId;
  };

  before(async () => {
    nina = await t.createUser({ username: 'pipe_nina' });
  });

  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
  });

  it('hands out only rows the local catalogue could not place', async () => {
    await stageNeedsProvider(2);
    const { rows } = await t.sql(`select * from _import_provider_claim(50)`);
    assert.equal(rows.length, 2);
    assert.ok(rows[0].name.startsWith('Provider Unknown'));
  });

  it('spends an attempt per claim, so one title cannot be asked about for ever', async () => {
    await stageNeedsProvider(1);

    for (let i = 1; i <= 3; i += 1) {
      const { rows } = await t.sql(`select * from _import_provider_claim(50)`);
      assert.equal(rows.length, 1, `attempt ${i} should still be offered`);
      // The provider found nothing this time.
      await t.sql(`select _import_provider_resolve($1, null)`, [rows[0].row_id]);
    }

    const { rows: exhausted } = await t.sql(`select * from _import_provider_claim(50)`);
    assert.equal(exhausted.length, 0, 'a fourth attempt must not be offered');
  });

  it('keeps a row retryable until its attempts are spent, then settles it unmatched', async () => {
    await stageNeedsProvider(1);

    const { rows: a } = await t.sql(`select * from _import_provider_claim(50)`);
    await t.sql(`select _import_provider_resolve($1, null)`, [a[0].row_id]);
    let { rows: status } = await t.sql(`select status from import_rows where job_id = $1`, [jobId]);
    assert.equal(status[0].status, 'needs_provider', 'a transient failure must stay retryable');

    for (let i = 0; i < 2; i += 1) {
      const { rows } = await t.sql(`select * from _import_provider_claim(50)`);
      await t.sql(`select _import_provider_resolve($1, null)`, [rows[0].row_id]);
    }

    ({ rows: status } = await t.sql(`select status from import_rows where job_id = $1`, [jobId]));
    assert.equal(status[0].status, 'unmatched', 'an unknown film must eventually settle');
  });

  it('matches a row the provider places, and teaches the shared cache', async () => {
    await stageNeedsProvider(1);
    const film = await t.createMovie(`Provider Found ${seq}`, seq++);

    const { rows } = await t.sql(`select * from _import_provider_claim(50)`);
    await t.sql(`select _import_provider_resolve($1, $2)`, [rows[0].row_id, film]);

    const { rows: after } = await t.sql(
      `select status, media_item_id from import_rows where job_id = $1`, [jobId]);
    assert.equal(after[0].status, 'matched');
    assert.equal(after[0].media_item_id, film);

    const { rows: cached } = await t.sql(
      `select media_item_id from letterboxd_matches where media_item_id = $1`, [film]);
    assert.equal(cached.length, 1, 'a provider match teaches the cache like a local one');
  });

  it('lets the job finish even when the provider never places anything', async () => {
    // An import of two thousand films with one obscure short in it must still complete.
    const known = await t.createMovie(`Provider Known ${seq}`, seq);
    await t.actAs(nina);
    const { rows: created } = await t.sql(`select import_create() as id`);
    const id = created[0].id;
    await t.sql(`select import_stage($1, $2::jsonb) as r`, [id, JSON.stringify([
      staged(`Provider Known ${seq}`, { correlation: `provider known ${seq}|2001` }),
      staged(`Provider Missing ${seq}`, { correlation: `provider missing ${seq}|2001` }),
    ])]);
    seq += 1;
    await t.sql(`select import_ready($1) as r`, [id]);
    await t.actAs(null);

    await runJob(id);

    const { rows } = await t.sql(`select status, counts from import_jobs where id = $1`, [id]);
    assert.equal(rows[0].status, 'done');
    assert.equal(rows[0].counts.applied, 1);
    assert.equal(rows[0].counts.unmatched, 1);
    assert.equal(await sourceOf(nina, known), 'imported');
  });
});

describe('staging', () => {
  let kate;
  let jobId;

  before(async () => {
    kate = await t.createUser({ username: 'pipe_kate' });
    await t.actAs(kate);
    const { rows } = await t.sql(`select import_create() as id`);
    jobId = rows[0].id;
  });

  after(async () => {
    await t.actAs(null);
  });

  it('is idempotent, so a retried page stages nothing twice', async () => {
    const page = JSON.stringify([staged('Retried', { correlation: 'retried|2001' })]);
    await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, page]);
    const { rows } = await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, page]);
    assert.equal(rows[0].r.staged, 0);
    assert.equal(await count('import_rows', `job_id = '${jobId}'`), 1);
  });

  it('keeps only the fields the contract imports', async () => {
    await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, JSON.stringify([{
      ...staged('Extra', { correlation: 'extra|2001' }),
      review: 'a review the import must never carry',
      tags: ['spoilers'],
      likedOn: '2024-01-01',
    }])]);

    const { rows } = await t.sql(
      `select raw from import_rows where job_id = $1 and correlation = 'extra|2001'`, [jobId]);
    const keys = Object.keys(rows[0].raw).sort();
    assert.deepEqual(keys.filter((k) => ['review', 'tags', 'likedOn'].includes(k)), []);
    assert.ok(!JSON.stringify(rows[0].raw).includes('a review the import must never carry'));
  });

  it('refuses somebody else’s job', async () => {
    const mallory = await t.createUser({ username: 'pipe_mallory' });
    await t.actAs(mallory);
    await assert.rejects(
      () => t.sql(`select import_stage($1, '[]'::jsonb) as r`, [jobId]),
      /no such import/i,
    );
    await t.actAs(kate);
  });

  it('refuses a page that is too large', async () => {
    const huge = JSON.stringify(
      Array.from({ length: 1001 }, (_, i) => staged(`Big ${i}`, { correlation: `big ${i}|2001` })));
    await assert.rejects(
      () => t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, huge]),
      /too many rows/i,
    );
  });
});
