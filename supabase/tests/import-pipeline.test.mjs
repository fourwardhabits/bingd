import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

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

/**
 * A catalogue film with a real release date.
 *
 * `harness.createMovie` leaves `release_date` null, which is faithful to the catalogue —
 * undated stubs are ordinary, because it caches whatever anybody searched for — but it
 * means every fixture film is matched by the weak title-only tier. Only a match whose
 * years actually agreed is allowed to teach the shared cross-account cache, so a test
 * about the cache has to build a film the strong tier can reach.
 */
const datedMovie = async (title, year) => {
  const { rows } = await t.sql(
    `insert into media_items (kind, tmdb_id, title, release_date, provenance)
     values ('movie', $1, $2, $3, 'manual') returning id`,
    [-Math.abs(seq++), title, `${year}-06-01`],
  );
  return rows[0].id;
};

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
    // Dated, so the strong tier reaches it — only that tier may teach the shared cache.
    film = await datedMovie('Cached Film', 2001);
  });

  /**
   * **One import is a claim, not a mapping** (`20260917000900`).
   *
   * These two used to assert that a single import taught the shared cache outright. That is
   * the vulnerability: the URI is client-supplied on every tier and no tier dereferences it,
   * so one account could bind any URI to any title it could name, permanently, for every
   * later importer. Promotion now needs two accounts to agree.
   */
  it('records a film URI as a claim, trusts nothing yet, and never touches a diary URI', async () => {
    await importArchive(frank, [
      staged('Cached Film', {
        correlation: 'cached film|2001',
        filmUri: 'https://boxd.it/FILMURI',
        watches: [{ diaryUri: 'https://boxd.it/DIARYURI', watchedOn: '2024-01-01', isRewatch: false }],
      }),
    ]);

    const { rows: claimed } = await t.sql(
      `select letterboxd_uri from letterboxd_match_claims`);
    const claimedUris = claimed.map((r) => r.letterboxd_uri);
    assert.ok(claimedUris.includes('https://boxd.it/FILMURI'), 'the film URI is claimed');

    const { rows: trustedRows } = await t.sql(
      `select letterboxd_uri from letterboxd_matches`);
    const trustedUris = trustedRows.map((r) => r.letterboxd_uri);
    assert.ok(
      !trustedUris.includes('https://boxd.it/FILMURI'),
      'one account must not create a globally trusted mapping',
    );

    // The diary URI is absent from both, which is the structural guarantee: a per-viewing
    // URI identifies a viewing and can never denote a film.
    for (const table of [claimedUris, trustedUris]) {
      assert.ok(
        !table.includes('https://boxd.it/DIARYURI'),
        'a per-viewing URI must never become a global film identity',
      );
    }
  });

  it('resolves the next importer for free once a second account has agreed', async () => {
    // Hugo's import is the corroboration; Grace is then the beneficiary, and her title is
    // one the local tier could not reach — so only the promoted URI can place it.
    const hugo = await t.createUser({ username: 'pipe_hugo' });
    await importArchive(hugo, [
      staged('Cached Film', { correlation: 'cached film|2001', filmUri: 'https://boxd.it/FILMURI' }),
    ]);

    const { rows: promoted } = await t.sql(
      `select media_item_id from letterboxd_matches where letterboxd_uri = 'https://boxd.it/FILMURI'`);
    assert.equal(promoted[0]?.media_item_id, film, 'two agreeing accounts promote the pair');

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

  it('dead-letters a job that keeps failing with work still outstanding', async () => {
    await t.actAs(jack);
    const { rows: created } = await t.sql(`select import_create() as id`);
    const jobId = created[0].id;
    await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, JSON.stringify([
      staged('Never Matched', { correlation: 'never matched|2001' })])]);
    await t.sql(`select import_ready($1) as r`, [jobId]);
    await t.actAs(null);

    // Still `pending`: there is real work left, so failing is the honest ending.
    await t.sql(`update import_jobs set failures = 3 where id = $1`, [jobId]);
    await t.sql(`select _drain_import_jobs() as r`);

    const { rows } = await t.sql(`select status, completed_at from import_jobs where id = $1`, [jobId]);
    assert.equal(rows[0].status, 'failed');
    assert.ok(rows[0].completed_at, 'a dead job must not hold the one-live-job slot for ever');
  });

  it('never overwrites a finished summary with zeroes', async () => {
    // `_import_settle` computes its counts from `import_rows` and then deletes the applied
    // rows, so a second call reads an empty table. Two ticks can overlap — pg_cron does not
    // serialise a job against itself — and the result was a person staring at "0 films"
    // after an import that placed all of them, which is how a success gets reported as
    // data loss.
    const film = `Settle Twice ${seq}`;
    await t.createMovie(film, seq);
    seq += 1;

    const jobId = await importArchive(jack, [
      staged(film, { correlation: `${film.toLowerCase()}|2001` })]);

    const { rows: first } = await t.sql(`select counts from import_jobs where id = $1`, [jobId]);
    assert.equal(first[0].counts.applied, 1);

    await t.sql(`select _import_settle($1)`, [jobId]);

    const { rows: second } = await t.sql(`select counts from import_jobs where id = $1`, [jobId]);
    assert.deepEqual(second[0].counts, first[0].counts, 'the summary must survive a second settle');
  });

  it('settles rather than fails an exhausted job with nothing left to do', async () => {
    // The counters can be exhausted by a job whose rows have all landed — a long provider
    // wait, most obviously. Failing it would throw away counts the reader is owed and
    // leave a half-written collection with no explanation.
    await t.actAs(jack);
    const { rows: created } = await t.sql(`select import_create() as id`);
    const jobId = created[0].id;
    await t.sql(`select import_ready($1) as r`, [jobId]);
    await t.actAs(null);

    await t.sql(`update import_jobs set failures = 3 where id = $1`, [jobId]);
    await t.sql(`select _drain_import_jobs() as r`);

    const { rows } = await t.sql(`select status, counts from import_jobs where id = $1`, [jobId]);
    assert.equal(rows[0].status, 'done');
    assert.equal(rows[0].counts.applied, 0);
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

describe('a long import, through many small slices', () => {
  let liam;

  before(async () => {
    liam = await t.createUser({ username: 'pipe_liam' });
  });

  it('finishes rather than dead-lettering partway through', async () => {
    // THE defect the first version of this suite could not see. `attempts` is incremented
    // on every claim, and a claim is one *slice* of a long job — so an unreset ceiling of
    // six dead-lettered any library over about four hundred films, having already written
    // an arbitrary prefix of it.
    //
    // Every fixture above uses slice 500 and finishes in four ticks, which is exactly why
    // they all passed. This one uses a slice small enough that the job needs far more
    // claims than the ceiling allows.
    const rows = [];
    for (let i = 0; i < 30; i += 1) {
      const name = `Long Import ${seq}`;
      await t.createMovie(name, seq);
      rows.push(staged(name, { correlation: `${name.toLowerCase()}|2001` }));
      seq += 1;
    }

    await t.actAs(liam);
    const { rows: created } = await t.sql(`select import_create() as id`);
    const jobId = created[0].id;
    await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, JSON.stringify(rows)]);
    await t.sql(`select import_ready($1) as r`, [jobId]);
    await t.actAs(null);

    // Slice 3 over 30 rows: at least 20 productive claims, against a ceiling of 6.
    await runJob(jobId, { slice: 3, ticks: 60 });

    const { rows: job } = await t.sql(
      `select status, counts, attempts from import_jobs where id = $1`, [jobId]);
    assert.equal(job[0].status, 'done', 'a long job must not exhaust its attempt ceiling');
    assert.equal(job[0].counts.applied, 30);
    assert.equal(job[0].counts.stragglers, 0, 'no row may be left behind by a phase advance');
    assert.equal(await count('user_media', `user_id = '${liam}'`), 30);
  });
});

describe('a row the database refuses', () => {
  let mona;

  before(async () => {
    mona = await t.createUser({ username: 'pipe_mona' });
  });

  it('costs one film, not the whole library', async () => {
    // A malformed value used to raise inside the apply slice, roll the whole batch back,
    // and dead-letter the job three ticks later having written nothing at all.
    const good = `Survivor ${seq}`;
    await t.createMovie(good, seq++);
    const bad = `Poison ${seq}`;
    await t.createMovie(bad, seq++);

    await t.actAs(mona);
    const { rows: created } = await t.sql(`select import_create() as id`);
    const jobId = created[0].id;
    await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, JSON.stringify([
      staged(good, { correlation: `${good.toLowerCase()}|2001` }),
      staged(bad, { correlation: `${bad.toLowerCase()}|2001` }),
    ])]);
    await t.sql(`select import_ready($1) as r`, [jobId]);
    await t.actAs(null);

    // Corrupt one staged row past the point staging validated it — which is what a schema
    // change, or a value nobody anticipated, would look like at apply time.
    await t.sql(
      `update import_rows set raw = jsonb_set(raw, '{bucket}', '"not_a_bucket"')
        where job_id = $1 and correlation = $2`,
      [jobId, `${bad.toLowerCase()}|2001`],
    );

    await runJob(jobId, { slice: 2 });

    const { rows: job } = await t.sql(`select status, counts from import_jobs where id = $1`, [jobId]);
    assert.equal(job[0].status, 'done', 'one bad row must not fail the job');
    assert.equal(job[0].counts.applied, 1);
    assert.equal(job[0].counts.unmatched, 1, 'the film that could not be written is reported');
    assert.equal(await count('user_media', `user_id = '${mona}'`), 1, 'the good film arrived');
  });
});

describe('staging refuses what apply would choke on', () => {
  let nora;
  let jobId;

  before(async () => {
    nora = await t.createUser({ username: 'pipe_nora' });
    await t.actAs(nora);
    const { rows } = await t.sql(`select import_create() as id`);
    jobId = rows[0].id;
  });

  after(() => t.actAs(null));

  const stageOne = async (row) => {
    await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, JSON.stringify([row])]);
    const { rows } = await t.sql(
      `select raw from import_rows where job_id = $1 and correlation = $2`,
      [jobId, row.correlation],
    );
    return rows[0]?.raw ?? null;
  };

  it('drops a rating that is not a Letterboxd star rather than storing it', async () => {
    // 4.3 would pass every cast and then violate imported_titles' CHECK at apply time.
    const raw = await stageOne(staged('Bad Rating', { correlation: 'bad rating|2001', rating: 4.3 }));
    assert.ok(raw, 'the row is still staged');
    assert.equal(raw.rating, undefined, 'the bad value is dropped, the row survives');
  });

  it('drops an unparseable date rather than storing it', async () => {
    const raw = await stageOne(
      staged('Bad Date', { correlation: 'bad date|2001', watchedOn: 'not-a-date' }));
    assert.ok(raw);
    assert.equal(raw.watchedOn, undefined);
  });

  it('drops a bucket that is not a bucket', async () => {
    const raw = await stageOne(
      staged('Bad Bucket', { correlation: 'bad bucket|2001', bucket: 'adored' }));
    assert.ok(raw);
    assert.equal(raw.bucket, undefined);
  });

  it('rebuilds watches element by element, so nothing rides along inside one', async () => {
    // The projection comment used to claim this and `watches` was a verbatim passthrough.
    const raw = await stageOne(staged('Nested Junk', {
      correlation: 'nested junk|2001',
      watches: [{
        diaryUri: 'https://boxd.it/ok',
        watchedOn: '2024-01-02',
        isRewatch: false,
        review: 'ARBITRARY BLOB THE CLIENT SENT',
      }],
    }));

    assert.equal(raw.watches.length, 1);
    assert.deepEqual(Object.keys(raw.watches[0]).sort(), ['diaryUri', 'isRewatch', 'watchedOn']);
    assert.ok(!JSON.stringify(raw).includes('ARBITRARY BLOB'));
  });

  it('drops a viewing whose date is unusable but keeps the rest', async () => {
    const raw = await stageOne(staged('Mixed Watches', {
      correlation: 'mixed watches|2001',
      watches: [
        { diaryUri: 'https://boxd.it/bad', watchedOn: 'nope', isRewatch: false },
        { diaryUri: 'https://boxd.it/good', watchedOn: '2024-02-03', isRewatch: true },
      ],
    }));
    assert.equal(raw.watches.length, 1);
    assert.equal(raw.watches[0].diaryUri, 'https://boxd.it/good');
  });

  it('refuses a nameless row outright', async () => {
    const raw = await stageOne({ ...staged('x', { correlation: 'nameless|2001' }), name: null });
    assert.equal(raw, null);
  });

  it('never raises on a date that is the right shape and still not a date', async () => {
    // `to_date('2026-02-31','YYYY-MM-DD')` raises 22008, and so do 2023-02-29 and
    // 2024-06-31 — every one of which passes a `^\d{4}-\d{2}-\d{2}$` guard. One of them in
    // one row used to make `import_stage` itself raise and reject the whole page of up to
    // a thousand rows, which is worse than the bug it replaced.
    for (const bad of ['2026-02-31', '2023-02-29', '2024-06-31', '2026-13-45', '0000-00-00']) {
      const key = `bad date ${bad}|2001`;
      const raw = await stageOne(
        staged(`Bad Date ${bad}`, { correlation: key, watchedOn: bad }));
      assert.ok(raw, `${bad}: the row must still be staged`);
      assert.equal(raw.watchedOn, undefined, `${bad}: the unreadable date is dropped`);
    }
  });

  it('never raises on an unreadable date inside a viewing either', async () => {
    const raw = await stageOne(staged('Bad Viewing Date', {
      correlation: 'bad viewing date|2001',
      watches: [
        { diaryUri: 'https://boxd.it/bv1', watchedOn: '2026-02-31', isRewatch: false },
        { diaryUri: 'https://boxd.it/bv2', watchedOn: '2024-02-03', isRewatch: false },
      ],
    }));
    assert.ok(raw);
    assert.equal(raw.watches.length, 1);
    assert.equal(raw.watches[0].diaryUri, 'https://boxd.it/bv2');
  });

  it('drops a rating above five, which the collection would refuse later', async () => {
    // `^[0-5](\.[05])?$` admits 5.5, and `imported_titles`' CHECK then rejects it at apply
    // time — so the film was dropped and reported to the reader as one we could not find,
    // over a rating.
    const raw = await stageOne(
      staged('Rating Overflow', { correlation: 'rating overflow|2001', rating: 5.5 }));
    assert.ok(raw);
    assert.equal(raw.rating, undefined);
  });

  it('survives a watches array that is not an array of objects', async () => {
    const raw = await stageOne({
      ...staged('Odd Watches', { correlation: 'odd watches|2001' }),
      watches: ['not an object', 42, null],
    });
    assert.ok(raw);
    assert.equal(raw.watches, undefined);
  });

  it('never raises on a correlation long enough to overflow the index', async () => {
    // `correlation` is the third column of a unique btree, and a btree tuple cannot exceed
    // 2704 bytes. One unquoted comma in one CSV line puts most of a row into the Name
    // column and produces a multi-kilobyte key — which used to raise 54000 and reject the
    // whole page, the same failure as an unreadable date by another road.
    const huge = 'x'.repeat(6000) + '|2001';
    const raw = await stageOne({ ...staged('Huge Key'), correlation: huge });
    assert.equal(raw, null, 'the truncated key is not the one we looked up');

    const { rows } = await t.sql(
      `select length(correlation) as n from import_rows where job_id = $1 order by n desc limit 1`,
      [jobId]);
    assert.ok(rows[0].n <= 200, 'the stored key is bounded');
  });

  it('refuses a relative date, which would fabricate a watch from the import’s own clock', async () => {
    // `'today'::date` is a perfectly good cast. It is also the exact thing
    // `imported_watches.watched_on` exists to never contain — a date the import invented
    // rather than one the person recorded.
    for (const relative of ['today', 'yesterday', 'now']) {
      const raw = await stageOne(
        staged(`Relative ${relative}`, {
          correlation: `relative ${relative}|2001`, watchedOn: relative }));
      assert.ok(raw, `${relative}: the row is still staged`);
      assert.equal(raw.watchedOn, undefined, `${relative}: must not become a watch date`);
    }
  });

  it('refuses a locale-dependent date, which would mean different days on different servers', async () => {
    // `1/2/2024` is January 2nd under DateStyle MDY and February 1st under DMY. A feature
    // whose whole value is preserving real watch dates must not reinterpret them by the
    // locale of whichever session happened to run the RPC.
    for (const ambiguous of ['1/2/2024', '20240102', '2024-1-2']) {
      const raw = await stageOne(
        staged(`Ambiguous ${ambiguous}`, {
          correlation: `ambiguous ${ambiguous}|2001`, watchedOn: ambiguous }));
      assert.ok(raw);
      assert.equal(raw.watchedOn, undefined, `${ambiguous}: only ISO is a date here`);
    }
  });

  it('survives watches being an object rather than an array', async () => {
    const raw = await stageOne({
      ...staged('Object Watches', { correlation: 'object watches|2001' }),
      watches: { diaryUri: 'https://boxd.it/x', watchedOn: '2024-01-01' },
    });
    assert.ok(raw);
    assert.equal(raw.watches, undefined);
  });
});

describe('the worker cannot be stopped by its surroundings', () => {
  let quinn;

  before(async () => {
    quinn = await t.createUser({ username: 'pipe_quinn' });
  });

  afterEach(async () => {
    await t.sql(`delete from app_config where key = 'import.provider_grace_minutes'`);
    await t.sql(
      `insert into app_config (key, value) values ('import.provider_grace_minutes', '30'::jsonb)
       on conflict (key) do update set value = excluded.value`);
  });

  it('is not stopped by a nonsense grace setting', async () => {
    // The read is outside every handler, so an operator typo in one config row used to
    // raise every minute, for ever, for every account.
    await t.sql(
      `update app_config set value = '"soon"'::jsonb where key = 'import.provider_grace_minutes'`);

    const film = `Grace Typo ${seq}`;
    await t.createMovie(film, seq);
    seq += 1;

    const jobId = await importArchive(quinn, [
      staged(film, { correlation: `${film.toLowerCase()}|2001` })]);

    const { rows } = await t.sql(`select status from import_jobs where id = $1`, [jobId]);
    assert.equal(rows[0].status, 'done');
  });

  it('settles a job that only ever waited, rather than failing it', async () => {
    // A provider that is configured and never answers used to dead-letter the job at about
    // eight minutes with half the archive written and no counts at all. It should wait for
    // the grace period and then finish honestly, reporting the rows it could not place.
    await t.sql(
      `insert into app_config (key, value) values ('functions.base_url', '"https://example.invalid"'::jsonb)
       on conflict (key) do update set value = excluded.value`);
    await t.sql(
      `update app_config set value = '1'::jsonb where key = 'import.provider_grace_minutes'`);

    try {
      const known = `Waited Known ${seq}`;
      await t.createMovie(known, seq);
      seq += 1;

      await t.actAs(quinn);
      const { rows: created } = await t.sql(`select import_create() as id`);
      const jobId = created[0].id;
      await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, JSON.stringify([
        staged(known, { correlation: `${known.toLowerCase()}|2001` }),
        staged(`Waited Unknown ${seq}`, { correlation: `waited unknown ${seq}|2001` }),
      ])]);
      seq += 1;
      await t.sql(`select import_ready($1) as r`, [jobId]);
      await t.actAs(null);

      // Two ticks of real work, then age the job past the one-minute grace.
      await t.sql(`select _drain_import_jobs(5, 500) as r`);
      await t.sql(`select _drain_import_jobs(5, 500) as r`);
      await t.sql(
        `update import_jobs set created_at = created_at - interval '5 minutes' where id = $1`,
        [jobId]);

      await runJob(jobId);

      const { rows } = await t.sql(`select status, counts from import_jobs where id = $1`, [jobId]);
      assert.equal(rows[0].status, 'done', 'a wait must end in a summary, not a failure');
      assert.equal(rows[0].counts.applied, 1);
      assert.equal(rows[0].counts.unmatched, 1);
    } finally {
      await t.sql(`delete from app_config where key = 'functions.base_url'`);
    }
  });

  it('does not fall over when pg_net is absent', async () => {
    // The nudge used to sit outside every handler, so a missing `net` schema rolled back
    // the whole tick — the row writes, the claim, the counters and the dead letter — every
    // minute, for ever, with the account locked out of importing by the one-live-job index.
    // PGlite has no `net` schema at all, which is exactly the configuration in question.
    await t.sql(
      `insert into app_config (key, value) values ('functions.base_url', '"https://example.invalid"'::jsonb)
       on conflict (key) do update set value = excluded.value`);

    try {
      const film = `No Net ${seq}`;
      await t.createMovie(film, seq);
      seq += 1;

      const jobId = await importArchive(quinn, [
        staged(film, { correlation: `${film.toLowerCase()}|2001` })]);

      const { rows } = await t.sql(`select status from import_jobs where id = $1`, [jobId]);
      assert.equal(rows[0].status, 'done');
    } finally {
      await t.sql(`delete from app_config where key = 'functions.base_url'`);
    }
  });

  it('settles a job whose matched title was deleted from the catalogue', async () => {
    // `import_rows.media_item_id` is `on delete set null`, so a catalogue row removed
    // between matching and applying left a row that was `matched` and pointed at nothing:
    // the apply loop could not select it, and it held the job open until the job died.
    const doomed = `Doomed Title ${seq}`;
    await t.createMovie(doomed, seq);
    seq += 1;

    await t.actAs(quinn);
    const { rows: created } = await t.sql(`select import_create() as id`);
    const jobId = created[0].id;
    await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, JSON.stringify([
      staged(doomed, { correlation: `${doomed.toLowerCase()}|2001` })])]);
    await t.sql(`select import_ready($1) as r`, [jobId]);
    await t.actAs(null);

    await t.sql(`select _import_match_batch($1, 100)`, [jobId]);
    await t.sql(
      `delete from media_items where id = (select media_item_id from import_rows where job_id = $1)`,
      [jobId]);

    await runJob(jobId);

    const { rows } = await t.sql(`select status, counts from import_jobs where id = $1`, [jobId]);
    assert.equal(rows[0].status, 'done', 'a vanished title must not hold the job open');
    assert.equal(rows[0].counts.unmatched, 1);
    assert.equal(rows[0].counts.stragglers, 0);
  });
});

describe('an import does not disturb what the person built here', () => {
  let owen;
  let film;

  before(async () => {
    owen = await t.createUser({ username: 'pipe_owen' });
    film = await t.createMovie(`Native Standing ${seq}`, seq);
    seq += 1;
  });

  it('leaves a natively logged film on this month’s board', async () => {
    // A native log with no date is attributed to the month it was logged. Filling that
    // null with a 2019 date from Letterboxd would silently remove it from this month's
    // board — the mirror of "imported rows never count toward monthly", and equally
    // unsanctioned.
    await t.actAs(owen);
    await t.sql(`select set_bucket(gen_random_uuid(), $1, 'loved') as r`, [film]);
    await t.actAs(null);

    const before = await t.asUser(owen, async () => {
      const { rows } = await t.sql(`select * from my_leaderboard_standing('titles', 'month')`);
      return rows[0]?.metric_count ?? 0;
    });
    assert.equal(before, 1);

    await importArchive(owen, [
      staged(`Native Standing ${seq - 1}`, {
        correlation: `native standing ${seq - 1}|2001`,
        watchedOn: '2019-03-04',
        watches: [{ diaryUri: 'https://boxd.it/ns', watchedOn: '2019-03-04', isRewatch: false }],
      }),
    ]);

    const after = await t.asUser(owen, async () => {
      const { rows } = await t.sql(`select * from my_leaderboard_standing('titles', 'month')`);
      return rows[0]?.metric_count ?? 0;
    });
    assert.equal(after, 1, 'an import must not move a native row off this month');

    const { rows } = await t.sql(
      `select watched_on, source from user_media where user_id = $1 and media_item_id = $2`,
      [owen, film]);
    assert.equal(rows[0].watched_on, null, 'the native watched state is untouched');
    assert.equal(rows[0].source, 'in_app');

    // And nothing was lost: the Letterboxd date is still recorded as provenance.
    assert.equal(await count('imported_watches', `user_id = '${owen}'`), 1);
  });
});

describe('the shared cache takes only strong evidence', () => {
  let pat;

  before(async () => {
    pat = await t.createUser({ username: 'pipe_pat' });
  });

  it('does not learn from a title-only match against an undated catalogue row', async () => {
    // The catalogue is a cache of whatever anybody searched for, so undated stubs are
    // ordinary. A stub for one Nosferatu would otherwise capture the URI of another and
    // hand it to every later importer, permanently and with no eviction path.
    await t.sql(
      `insert into media_items (kind, tmdb_id, title, release_date) values ('movie', $1, 'Undated Stub', null)`,
      [seq++]);

    await importArchive(pat, [
      staged('Undated Stub', {
        correlation: 'undated stub|2001',
        filmUri: 'https://boxd.it/UNDATEDSTUB',
      }),
    ]);

    // It still lands in the person's own collection — good enough for the account that
    // told us the name and year.
    assert.equal(await count('user_media', `user_id = '${pat}'`), 1);

    const { rows } = await t.sql(
      `select 1 from letterboxd_matches where letterboxd_uri = 'https://boxd.it/UNDATEDSTUB'`);
    assert.equal(rows.length, 0, 'a weak match must not be asserted across accounts');
  });
});

describe('what survives a finished job', () => {
  let rhea;

  before(async () => {
    rhea = await t.createUser({ username: 'pipe_rhea' });
    // Two catalogue rows that squash identically: the ambiguous case.
    await t.sql(
      `insert into media_items (kind, tmdb_id, title, release_date)
       values ('movie', $1, 'Twin Title', '1990-01-01'), ('movie', $2, 'Twin Title', '1990-06-01')`,
      [seq++, seq++]);
  });

  it('keeps only the name and year of a row it could not place', async () => {
    // Contract V3 §14: the export is not retained indefinitely, and a completed job used to
    // keep its unresolved rows' whole payload for ever — film URI, rating, bucket, watch
    // date, and every diary URI attached to them.
    const jobId = await importArchive(rhea, [
      staged('Twin Title', {
        correlation: 'twin title|1990',
        year: 1990,
        filmUri: 'https://boxd.it/TWIN',
        rating: 4.5,
        bucket: 'loved',
        watchedOn: '2024-05-06',
        watches: [{ diaryUri: 'https://boxd.it/PRIVATE', watchedOn: '2024-05-06', isRewatch: true }],
      }),
      staged('Nobody Can Place This', { correlation: 'nobody can place this|2001' }),
    ]);

    const { rows } = await t.sql(
      `select status, raw, candidates from import_rows where job_id = $1 order by status`, [jobId]);
    assert.equal(rows.length, 2, 'unresolved rows are retained, not deleted');

    for (const row of rows) {
      assert.deepEqual(
        Object.keys(row.raw).sort(),
        ['name', 'year'].filter((k) => k in row.raw).sort(),
        'only the fields the repair surface renders survive',
      );
      assert.ok(row.raw.name, 'the name survives, or the repair list is a count of nothing');
      assert.equal(row.raw.filmUri, undefined);
      assert.equal(row.raw.rating, undefined);
      assert.equal(row.raw.bucket, undefined);
      assert.equal(row.raw.watchedOn, undefined);
      assert.equal(row.raw.watches, undefined);
    }

    const all = JSON.stringify(rows);
    assert.ok(!all.includes('PRIVATE'), 'no diary URI may survive a finished job');
    assert.ok(!all.includes('TWIN'), 'no film URI either');
  });

  it('leaves an ambiguous row its candidates, which are what resolve it', async () => {
    const { rows } = await t.sql(
      `select candidates from import_rows where status = 'ambiguous' and candidates is not null`);
    assert.ok(rows.length >= 1, 'candidates live in their own column and are not redacted');
  });
});

describe('a page that is too heavy', () => {
  let sam;
  let jobId;

  before(async () => {
    sam = await t.createUser({ username: 'pipe_sam' });
    await t.actAs(sam);
    const { rows } = await t.sql(`select import_create() as id`);
    jobId = rows[0].id;
  });

  after(() => t.actAs(null));

  it('accepts a page the size a real export actually produces', async () => {
    // Measured: 171-185 bytes a row, so a thousand real rows is about 190 KiB. This builds
    // one deliberately fatter than that and it must still pass.
    const page = Array.from({ length: 900 }, (_, i) => staged(`Heavy ${i}`, {
      correlation: `heavy ${i}|2001`,
      watches: [{ diaryUri: `https://boxd.it/h${i}`, watchedOn: '2024-01-02', isRewatch: false }],
    }));
    const bytes = Buffer.byteLength(JSON.stringify(page), 'utf8');
    assert.ok(bytes > 190 * 1024, `the fixture should exceed a real page (was ${bytes})`);

    const { rows } = await t.sql(`select import_stage($1, $2::jsonb) as r`, [
      jobId, JSON.stringify(page)]);
    assert.equal(rows[0].r.staged, 900);
    assert.ok(rows[0].r.bytes > 0, 'the call reports what it weighed');
  });

  it('refuses a page past the byte bound, and says what the bound is', async () => {
    // A row limit is not a payload limit: this is 5 rows and several megabytes.
    const page = Array.from({ length: 5 }, (_, i) => staged(`Bloat ${i}`, {
      correlation: `bloat ${i}|2001`,
      name: 'x'.repeat(600_000),
    }));

    await assert.rejects(
      () => t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, JSON.stringify(page)]),
      /too large/i,
    );
  });

  it('is not stopped by a nonsense byte bound', async () => {
    await t.sql(
      `insert into app_config (key, value) values ('import.max_page_bytes', '"lots"'::jsonb)
       on conflict (key) do update set value = excluded.value`);
    try {
      const { rows } = await t.sql(`select import_stage($1, $2::jsonb) as r`, [
        jobId, JSON.stringify([staged('After Typo', { correlation: 'after typo|2001' })])]);
      assert.equal(rows[0].r.staged, 1, 'an operator typo must not stop every import');
    } finally {
      await t.sql(
        `update app_config set value = '2097152'::jsonb where key = 'import.max_page_bytes'`);
    }
  });
});

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

  it('matches a row the provider places, and claims it like a local one', async () => {
    await stageNeedsProvider(1);
    // Dated and agreeing with the staged year (2001), because the provider writer is held
    // to the same bar as the local one: `match.mjs`'s confidence rule accepts on title
    // alone when either side has no year, which is exactly the weak evidence the cache
    // must not take.
    const film = await datedMovie(`Provider Found ${seq}`, 2001);

    const { rows } = await t.sql(`select * from _import_provider_claim(50)`);
    await t.sql(`select _import_provider_resolve($1, $2)`, [rows[0].row_id, film]);

    const { rows: after } = await t.sql(
      `select status, media_item_id from import_rows where job_id = $1`, [jobId]);
    assert.equal(after[0].status, 'matched');
    assert.equal(after[0].media_item_id, film);

    // **A claim, not a mapping** (`20260917000900`). The provider chose this film by
    // searching TMDB for the client's own name and year; it never dereferenced the URI, so
    // its confidence is about the title and cannot establish the binding alone. Trusting
    // it outright left the poisoning reachable by naming a film the catalogue lacked.
    const { rows: claimed } = await t.sql(
      `select tier from letterboxd_match_claims where media_item_id = $1`, [film]);
    assert.equal(claimed.length, 1, 'a provider match is recorded as a single claim');
    assert.equal(claimed[0].tier, 'provider');

    const { rows: cached } = await t.sql(
      `select media_item_id from letterboxd_matches where media_item_id = $1`, [film]);
    assert.equal(cached.length, 0, 'and one account is not enough to share it');
  });

  it('does not teach the cache when the provider placed it on title alone', async () => {
    // `isConfident` accepts on the squashed title when the result has no release date —
    // the same weak evidence class the local writer was changed to exclude. Leaving the
    // provider writer open left the cross-account poisoning reachable by the other road.
    await stageNeedsProvider(1);
    const undated = await t.createMovie(`Provider Undated ${seq}`, seq++);

    const { rows } = await t.sql(`select * from _import_provider_claim(50)`);
    await t.sql(`select _import_provider_resolve($1, $2)`, [rows[0].row_id, undated]);

    const { rows: after } = await t.sql(
      `select status from import_rows where job_id = $1`, [jobId]);
    assert.equal(after[0].status, 'matched', 'the row is still placed for this account');

    const { rows: cached } = await t.sql(
      `select 1 from letterboxd_matches where media_item_id = $1`, [undated]);
    assert.equal(cached.length, 0, 'but it is not asserted across accounts');
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


// ===========================================================================
// Starting over — `20260917000500`
// ===========================================================================

/**
 * **The hole this closes is two taps wide.**
 *
 * `import_create` adopts an open job for an hour, which is right for a client that lost
 * its connection mid-staging and wrong for a person who pressed "Start over" and picked a
 * different archive. Without `import_discard`, archive A's staged rows sit in the adopted
 * job and archive B stages beside them, and the worker applies both as one collection.
 *
 * So the first test here is the scenario rather than the function: two archives, a Start
 * over between them, and an assertion about which films the person ends up with. The rest
 * are the boundaries that make it safe to call from a button.
 */
describe('starting over means starting over', () => {
  let tess;

  before(async () => {
    tess = await t.createUser({ username: 'pipe_tess' });
  });

  afterEach(async () => {
    await t.actAs(null);
    await t.sql(`delete from import_jobs where user_id = $1`, [tess]);
  });

  it('does not import an abandoned archive alongside the one that replaced it', async () => {
    const kept = await datedMovie('Tess Kept', 1998);
    const abandoned = await datedMovie('Tess Abandoned', 1999);

    await t.actAs(tess);

    // Archive A stages, then the connection drops: no `import_ready`, job left `pending`.
    const { rows: first } = await t.sql(`select import_create() as id`);
    await t.sql(`select import_stage($1, $2::jsonb) as r`, [first[0].id, JSON.stringify([
      staged('Tess Abandoned', { correlation: 'tess abandoned|1999', year: 1999 }),
    ])]);

    // Start over.
    await t.sql(`select import_discard($1) as r`, [first[0].id]);

    // Archive B, well inside the hour `import_create` would otherwise adopt within.
    const { rows: second } = await t.sql(`select import_create() as id`);
    assert.notEqual(second[0].id, first[0].id, 'a discarded job must not be adopted');

    await t.sql(`select import_stage($1, $2::jsonb) as r`, [second[0].id, JSON.stringify([
      staged('Tess Kept', { correlation: 'tess kept|1998', year: 1998 }),
    ])]);
    await t.sql(`select import_ready($1) as r`, [second[0].id]);
    await t.actAs(null);
    await runJob(second[0].id);

    assert.equal(await count('user_media', `user_id = '${tess}' and media_item_id = '${kept}'`), 1);
    assert.equal(
      await count('user_media', `user_id = '${tess}' and media_item_id = '${abandoned}'`), 0,
      'the abandoned archive must not arrive in the collection',
    );
  });

  it('takes the staged rows with it', async () => {
    await t.actAs(tess);
    const { rows } = await t.sql(`select import_create() as id`);
    await t.sql(`select import_stage($1, $2::jsonb) as r`, [rows[0].id, JSON.stringify([
      staged('Tess Staged', { correlation: 'tess staged|2001' }),
    ])]);
    assert.equal(await count('import_rows', `job_id = '${rows[0].id}'`), 1);

    const { rows: out } = await t.sql(`select import_discard($1) as r`, [rows[0].id]);
    assert.equal(out[0].r.status, 'discarded');
    // `import_rows` cascades from `import_jobs`; the staged archive goes with the job.
    assert.equal(await count('import_rows', `job_id = '${rows[0].id}'`), 0);
    assert.equal(await count('import_jobs', `id = '${rows[0].id}'`), 0);
  });

  it('answers "gone" rather than failing when the job is already discarded', async () => {
    // A client that retries after a dropped response must not be told its own completed
    // request failed. Idempotence is what makes `reset()` safe to fire and forget.
    await t.actAs(tess);
    const { rows } = await t.sql(`select import_create() as id`);
    await t.sql(`select import_discard($1) as r`, [rows[0].id]);

    const { rows: again } = await t.sql(`select import_discard($1) as r`, [rows[0].id]);
    assert.equal(again[0].r.status, 'gone');
  });

  it('answers "gone" for a job id that never existed', async () => {
    await t.actAs(tess);
    const { rows } = await t.sql(`select import_discard(gen_random_uuid()) as r`);
    assert.equal(rows[0].r.status, 'gone');
  });

  it('leaves a job the worker has claimed alone, and says so', async () => {
    // **The other half of the same review finding.** Anything past `pending` may be
    // mid-batch or holding a row lock, and a button on a phone must not race
    // `_drain_import_jobs`. The client turns this answer into "an import is already
    // running" rather than a retry that could never succeed.
    await t.actAs(tess);
    const { rows } = await t.sql(`select import_create() as id`);
    const jobId = rows[0].id;
    await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, JSON.stringify([
      staged('Tess Claimed', { correlation: 'tess claimed|2001' }),
    ])]);
    await t.sql(`select import_ready($1) as r`, [jobId]);

    await t.actAs(null);
    // 'matching' is what _drain_import_jobs sets when it claims a job; 'working' is the
    // client's word for the same thing and is not a value the constraint admits.
    await t.sql(`update import_jobs set status = 'matching', claimed_at = now() where id = $1`,
      [jobId]);

    await t.actAs(tess);
    const { rows: out } = await t.sql(`select import_discard($1) as r`, [jobId]);
    assert.equal(out[0].r.status, 'running');
    assert.equal(out[0].r.job_status, 'matching');
    assert.equal(await count('import_jobs', `id = '${jobId}'`), 1, 'the job must survive');
    assert.equal(await count('import_rows', `job_id = '${jobId}'`), 1, 'its rows must survive');
  });

  it('refuses somebody else’s job, and does not delete it', async () => {
    await t.actAs(tess);
    const { rows } = await t.sql(`select import_create() as id`);
    const jobId = rows[0].id;

    const mallory = await t.createUser({ username: 'pipe_mallory_discard' });
    await t.actAs(mallory);
    await assert.rejects(
      () => t.sql(`select import_discard($1) as r`, [jobId]),
      /no such import/i,
    );

    await t.actAs(null);
    assert.equal(await count('import_jobs', `id = '${jobId}'`), 1);
  });
});


// ===========================================================================
// The failure path keeps nothing either — `20260917000600`
// ===========================================================================

/**
 * **Retention was true on the happy path and false on the failure path.**
 *
 * Every deletion and redaction lived in `_import_settle`, and the dead letter in
 * `_drain_import_jobs` does not go through it — it writes `failed` and `completed_at`
 * straight onto the job. So an import that exhausted its attempts kept its whole staged
 * payload permanently: film URIs, ratings, buckets, watch dates and every diary URI.
 *
 * That is the wrong way round. Somebody whose import failed is the least likely to come
 * back and the least well served by us keeping their diary. Found by independent review;
 * the existing dead-letter test asserted `status` and `completed_at` and never looked at
 * the rows it left behind.
 */
describe('what survives a job that failed', () => {
  let vera;

  before(async () => {
    vera = await t.createUser({ username: 'pipe_vera' });
  });

  afterEach(async () => {
    await t.actAs(null);
    await t.sql(`delete from import_jobs where user_id = $1`, [vera]);
  });

  const stagedPrivateRow = async () => {
    await t.actAs(vera);
    const { rows } = await t.sql(`select import_create() as id`);
    const jobId = rows[0].id;
    await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, JSON.stringify([
      staged('Vera Private', {
        correlation: 'vera private|2001',
        filmUri: 'https://boxd.it/VERAFILM',
        rating: 4.5,
        bucket: 'loved',
        watchedOn: '2024-05-06',
        watches: [
          { diaryUri: 'https://boxd.it/VERADIARY', watchedOn: '2024-05-06', isRewatch: true },
        ],
      }),
    ])]);
    await t.sql(`select import_ready($1) as r`, [jobId]);
    await t.actAs(null);
    return jobId;
  };

  it('keeps nothing at all when the job is dead-lettered', async () => {
    const jobId = await stagedPrivateRow();

    // Exhaust the attempt budget the way a job that keeps erroring does, then run the tick
    // that dead-letters it. Driven through the worker rather than by writing `failed`
    // directly, so this exercises the path a real failure takes.
    await t.sql(`update import_jobs set failures = 3 where id = $1`, [jobId]);
    await t.sql(`select _drain_import_jobs(5, 500) as r`);

    const { rows: job } = await t.sql(
      `select status, completed_at from import_jobs where id = $1`, [jobId]);
    assert.equal(job[0].status, 'failed');
    assert.ok(job[0].completed_at, 'a dead-lettered job is completed');

    /**
     * **Deleted, not redacted** (`20260917001300`).
     *
     * An earlier version kept the name and year here, reasoning by analogy with a completed
     * job's unresolved rows. But those have a reader and these do not: the repair surface
     * belongs to a finished import, and nothing anywhere renders the leftovers of one that
     * failed. Redaction answered "what may we keep" without ever asking "why are we keeping
     * it".
     */
    assert.equal(await count('import_rows', `job_id = '${jobId}'`), 0);
  });

  it('keeps nothing when the sweep retires an abandoned job either', async () => {
    // The other road to `failed`, and the same answer. A half-staged archive nobody came
    // back for has even less of a reader than a dead-lettered one.
    //
    // Staged without `import_ready`, because that is what "abandoned" means: the sweep
    // takes only `pending` jobs, and `stagedPrivateRow` hands its job to the worker.
    await t.actAs(vera);
    const { rows: created } = await t.sql(`select import_create() as id`);
    const jobId = created[0].id;
    await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, JSON.stringify([
      staged('Vera Walked Away', {
        correlation: 'vera walked away|2001',
        filmUri: 'https://boxd.it/VERAGONE',
        watches: [{ diaryUri: 'https://boxd.it/VERAGONEDIARY', watchedOn: '2024-05-06', isRewatch: false }],
      }),
    ])]);
    await t.actAs(null);

    await t.sql(
      `update import_jobs set created_at = now() - interval '30 hours' where id = $1`, [jobId]);
    assert.equal((await t.sql(`select _import_sweep_abandoned() as n`)).rows[0].n, 1);

    assert.equal(await count('import_rows', `job_id = '${jobId}'`), 0);
  });
});


// ===========================================================================
// Somebody has to start the worker — `20260917000600`, `20260917000700`
// ===========================================================================

/**
 * **The worker was never installed, and nothing could see it.**
 *
 * `20260917000300` defined `schedule_import_drain()` and then nothing called it: no
 * self-install block, no grant to `service_role`, no step in the bootstrap script. The push
 * lane it names as its precedent has all three. On a real project that means no cron job,
 * so `_drain_import_jobs` is never called, `import_status` keeps answering `matching`
 * successfully, the client's blind-poll bail-out never fires, and the person sits on a
 * screen with no buttons — for ever, because the 24-hour dead letter lives inside the
 * worker too.
 *
 * The entire suite above calls `_drain_import_jobs()` directly, which is the right way to
 * test a worker and exactly why none of it noticed. So these assert the *wiring* rather
 * than the draining: the grant that lets the bootstrap script call the installer, and a
 * status function that answers honestly on a database with no pg_cron at all — which is
 * this one, and is also a freshly restored production before the extensions are enabled.
 */
describe('the worker has somebody to start it', () => {
  const grantsOn = async (signature) => {
    const { rows } = await t.sql(
      `select coalesce(array_agg(grantee order by grantee), '{}') as roles
         from information_schema.routine_privileges
        where specific_schema = 'public'
          and privilege_type = 'EXECUTE'
          and routine_name = $1`,
      [signature],
    );
    return rows[0].roles;
  };

  it('lets service_role install the cron job', async () => {
    // The one grant the bootstrap script needs, and the one that was missing: the function
    // was revoked from public, anon and authenticated and then granted to nobody, so the
    // documented way to install the drain could not be used by the thing that documents it.
    assert.ok(
      (await grantsOn('schedule_import_drain')).includes('service_role'),
      'schedule_import_drain must be callable by service_role',
    );
  });

  it('lets service_role ask whether it is running', async () => {
    assert.ok((await grantsOn('import_drain_status')).includes('service_role'));
  });

  it('ships an off switch as well as an on one', async () => {
    // The push lane has had both halves since `20260826000300`, and `backup-and-recovery.md`
    // names the rollback as the first thing to reach for. The import lane shipped the
    // installer alone, so stopping a drain that was spending provider requests and writing
    // the cross-account match cache meant a raw `cron.unschedule` as a superuser.
    assert.ok((await grantsOn('unschedule_import_drain')).includes('service_role'));
  });

  it('answers "absent" rather than failing when there is no job to stop', async () => {
    // An operator reaching for this in a hurry must not have to care whether somebody
    // already pulled it, and a runbook step that fails when it is already satisfied is a
    // step people learn to skip. PGlite has no `cron` schema at all, which is the same
    // shape as a project whose extensions were never enabled.
    const { rows } = await t.sql(`select unschedule_import_drain() as r`);
    assert.equal(rows[0].r.status, 'absent');
  });

  it('keeps the installer away from signed-in callers', async () => {
    const roles = await grantsOn('schedule_import_drain');
    assert.ok(!roles.includes('authenticated'), 'a phone must not schedule cron jobs');
    assert.ok(!roles.includes('anon'));
  });

  it('reports no job rather than failing where pg_cron does not exist', async () => {
    // PGlite has no `cron` schema, and neither does a Supabase project until somebody
    // enables the extension. A status call that raised there would be useless at exactly
    // the moment it is most needed — the first check after a restore.
    const { rows } = await t.sql(`select import_drain_status() as s`);
    const status = rows[0].s;

    assert.equal(status.job, null, 'a null job is how "nothing is draining" is reported');
    assert.equal(typeof status.open, 'number');
    assert.equal(typeof status.older_than_15m, 'number');
  });

  it('counts an open job as open, and an old one as stalled', async () => {
    // Deltas rather than absolutes: this suite shares one database with nineteen others and
    // several of them leave jobs behind on purpose. An absolute count here would assert the
    // tidiness of its neighbours rather than anything about this function.
    const read = async () => (await t.sql(`select import_drain_status() as s`)).rows[0].s;
    const before = await read();

    const wendy = await t.createUser({ username: 'pipe_wendy' });
    await t.actAs(wendy);
    const { rows: created } = await t.sql(`select import_create() as id`);
    await t.actAs(null);

    const opened = await read();
    assert.equal(opened.open, before.open + 1);
    assert.equal(opened.older_than_15m, before.older_than_15m);

    // The symptom the runbook alerts on: rows arrived and nothing took them.
    await t.sql(`update import_jobs set created_at = now() - interval '30 minutes' where id = $1`,
      [created[0].id]);
    const stalled = await read();
    assert.equal(stalled.older_than_15m, before.older_than_15m + 1);

    await t.sql(`delete from import_jobs where id = $1`, [created[0].id]);
  });
});


// ===========================================================================
// What the summary says happened — `20260917001000`
// ===========================================================================

/**
 * **The numbers a person reads, against what the database actually holds.**
 *
 * Every one of these asserts `import_jobs.counts` *and* the rows, in the same test. That
 * pairing is the point: the defect this suite exists for was a summary saying "Added to
 * your collection: 22" beside a `user_media` that had not changed, and the existing
 * idempotence test caught neither half because it only ever looked at the rows.
 *
 * The units are not interchangeable and the tests are written to keep them apart:
 * `watched`, `kept` and `watchlist` are films; `viewings` is diary entries, and a rewatch
 * is one film and several of them.
 */
describe('the counts the summary reads', () => {
  let ada;

  before(async () => {
    ada = await t.createUser({ username: 'pipe_ada' });
  });

  beforeEach(async () => {
    await t.actAs(null);
    await t.sql(`delete from rankings where user_id = $1`, [ada]);
    await t.sql(`delete from user_media where user_id = $1`, [ada]);
    await t.sql(`delete from watchlist where user_id = $1`, [ada]);
    await t.sql(`delete from imported_watches where user_id = $1`, [ada]);
    await t.sql(`delete from imported_titles where user_id = $1`, [ada]);
    await t.sql(`delete from import_jobs where user_id = $1`, [ada]);
  });

  const countsOf = async (jobId) => {
    const { rows } = await t.sql(`select counts from import_jobs where id = $1`, [jobId]);
    return rows[0].counts;
  };

  it('counts one film once, however many files of the archive mentioned it', async () => {
    // Watched, rated, in the diary and on the watchlist — one film in four places, which is
    // ordinary for anything somebody loved. The normaliser collapses the first three into
    // one watched row; the watchlist row is separate and must not be double-counted as a
    // collection addition, because the apply step skips a title already collected.
    const title = `Four Ways ${seq}`;
    const film = await datedMovie(title, 2001);
    const jobId = await importArchive(ada, [
      staged(title, {
        correlation: 'four ways|2001',
        year: 2001,
        rating: 4.5,
        bucket: 'loved',
        watches: [{ diaryUri: 'https://boxd.it/4W1', watchedOn: '2024-01-02', isRewatch: false }],
      }),
      staged(title, { kind: 'watchlist', correlation: 'four ways|2001', year: 2001 }),
    ]);

    const counts = await countsOf(jobId);
    assert.equal(counts.watched, 1, 'one film');
    assert.equal(counts.viewings, 1, 'one diary entry');
    assert.equal(
      counts.watchlist, 0,
      'a watchlist row for a film already collected is not a watchlist addition',
    );

    assert.equal(await count('user_media', `user_id = '${ada}' and media_item_id = '${film}'`), 1);
    assert.equal(await count('watchlist', `user_id = '${ada}'`), 0);
  });

  it('counts a rewatch as one film and several diary entries', async () => {
    const title = `Rewatched Often ${seq}`;
    const film = await datedMovie(title, 1999);
    const jobId = await importArchive(ada, [
      staged(title, {
        correlation: 'rewatched often|1999',
        year: 1999,
        watches: [
          { diaryUri: 'https://boxd.it/R1', watchedOn: '2022-01-02', isRewatch: false },
          { diaryUri: 'https://boxd.it/R2', watchedOn: '2023-01-02', isRewatch: true },
          { diaryUri: 'https://boxd.it/R3', watchedOn: '2024-01-02', isRewatch: true },
        ],
      }),
    ]);

    const counts = await countsOf(jobId);
    assert.equal(counts.watched, 1, 'still one film');
    assert.equal(counts.viewings, 3, 'three diary entries');
    assert.equal(
      await count('imported_watches', `user_id = '${ada}' and media_item_id = '${film}'`), 3);
  });

  it('reports nothing added when a re-import changes nothing', async () => {
    // The defect, exactly. The first import adds the film; the second is a no-op, and used
    // to announce the full count again under "Your history is in".
    const title = `Repeated ${seq}`;
    const film = await datedMovie(title, 2005);
    const rows = [
      staged(title, {
        correlation: 'repeated|2005',
        year: 2005,
        watches: [{ diaryUri: 'https://boxd.it/RP1', watchedOn: '2024-02-02', isRewatch: false }],
      }),
    ];

    const first = await importArchive(ada, rows);
    assert.equal((await countsOf(first)).watched, 1);

    const second = await importArchive(ada, rows);
    const counts = await countsOf(second);
    assert.equal(counts.watched, 0, 'nothing was added the second time');
    // `viewings` is what is held rather than what arrived, so it is stable across a
    // re-import rather than doubling.
    assert.equal(counts.viewings, 1);

    assert.equal(await count('user_media', `user_id = '${ada}' and media_item_id = '${film}'`), 1);
    assert.equal(
      await count('imported_watches', `user_id = '${ada}' and media_item_id = '${film}'`), 1);
  });

  it('counts a film the person ranked here as kept, not as added', async () => {
    // The provenance rule, from the summary's side. Ranking is the strongest native state
    // there is and the import writes nothing at all — so counting it as an addition was the
    // clearest case of the summary claiming credit for work it did not do.
    const title = `Ranked Here ${seq}`;
    const film = await datedMovie(title, 2011);
    await t.actAs(ada);
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved', 1)`, [ada, film]);
    await t.actAs(null);

    const jobId = await importArchive(ada, [
      staged(title, { correlation: 'ranked here|2011', year: 2011, bucket: 'not_for_me' }),
    ]);

    const counts = await countsOf(jobId);
    assert.equal(counts.watched, 0, 'the import added nothing');
    assert.equal(counts.kept, 1, 'and says so rather than staying silent');

    // **No collection row at all**, which is the sharpest form of "wrote nothing" and the
    // reason the first version of the `kept` filter missed this case: it required a
    // `user_media` row to exist before it would count one as left alone.
    assert.equal(
      await count('user_media', `user_id = '${ada}' and media_item_id = '${film}'`), 0,
      'a ranked title the import declined to touch has no collection row of its own',
    );
  });

  it('counts an unmatched film and an ambiguous one without counting them as added', async () => {
    // Two catalogue rows that squash identically: the remake case.
    await t.sql(
      `insert into media_items (kind, tmdb_id, title, release_date)
       values ('movie', $1, 'Counting Twins', '1980-01-01'), ('movie', $2, 'Counting Twins', '1981-01-01')`,
      [-Math.abs(seq++), -Math.abs(seq++)]);

    const jobId = await importArchive(ada, [
      staged('Counting Twins', { correlation: 'counting twins|1980', year: 1980 }),
      staged('Nothing Like This Exists At All', {
        correlation: 'nothing like this exists at all|1955', year: 1955 }),
    ]);

    const counts = await countsOf(jobId);
    assert.equal(counts.watched, 0);
    assert.equal(counts.kept, 0);
    assert.equal(counts.ambiguous, 1);
    assert.equal(counts.unmatched, 1);
  });

  it('adds up: every watched row lands in exactly one bucket', async () => {
    // The property the screen depends on. Without it the numbers silently fail to total the
    // count the preview promised, and the difference is never explained.
    const addedTitle = `Sums Added ${seq}`;
    const added = await datedMovie(addedTitle, 1990);
    const rankedTitle = `Sums Ranked ${seq}`;
    const ranked = await datedMovie(rankedTitle, 1991);
    await t.actAs(ada);
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'fine', 1)`, [ada, ranked]);
    await t.actAs(null);

    const watchedRows = [
      staged(addedTitle, { correlation: 'sums added|1990', year: 1990 }),
      staged(rankedTitle, { correlation: 'sums ranked|1991', year: 1991 }),
      staged('Sums Missing Entirely', { correlation: 'sums missing entirely|1992', year: 1992 }),
    ];
    const jobId = await importArchive(ada, watchedRows);

    // **`already` is in this sum**, and was not: the total omitted it while no test in the
    // file ever built a job where it was non-zero, so a regression that moved rows into it
    // would have passed twice over. The re-import below is that job.
    const c = await countsOf(jobId);
    const total = (c.watched ?? 0) + (c.kept ?? 0) + (c.already ?? 0) + (c.ambiguous ?? 0)
      + (c.unmatched ?? 0) + (c.stragglers ?? 0);
    assert.equal(total, watchedRows.length, 'every watched row is counted exactly once');
    assert.equal(c.watched, 1);
    assert.equal(c.kept, 1);
    assert.equal(c.already, 0);
    assert.equal(c.unmatched, 1);

    // The same archive again: the film this run added moves from `watched` to `already`,
    // and the partition still holds.
    const second = await countsOf(await importArchive(ada, watchedRows));
    const secondTotal = (second.watched ?? 0) + (second.kept ?? 0) + (second.already ?? 0)
      + (second.ambiguous ?? 0) + (second.unmatched ?? 0) + (second.stragglers ?? 0);
    assert.equal(secondTotal, watchedRows.length);
    assert.equal(second.watched, 0);
    assert.equal(second.already, 1);
    assert.equal(second.kept, 1);
    assert.ok(added && ranked);
  });
});


// ===========================================================================
// A ceiling on the whole job — `20260917001100`
// ===========================================================================

/**
 * **A safety ceiling, and the tests are written to keep it distinct from a product limit.**
 *
 * The page bounds were already here. Nothing bounded the number of pages, so one account
 * could stage without limit. What these assert is that the job bound exists, that it is
 * counted from what was actually inserted rather than from what arrived, and — the part
 * worth as much as the bound itself — that it sits far enough above the supported library
 * size that the 2,500 / 5,000 / 10,000 performance fixtures are unaffected by it.
 */
describe('a job that will not stop growing', () => {
  let ivy;
  let jobId;

  const config = async (key, value) => {
    await t.sql(
      `insert into app_config (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [key, JSON.stringify(value)],
    );
  };

  const page = (from, count) =>
    JSON.stringify(
      Array.from({ length: count }, (_, i) =>
        staged(`Ceiling ${from + i}`, { correlation: `ceiling ${from + i}|2001` })),
    );

  const totals = async () => {
    const { rows } = await t.sql(
      `select staged_rows, staged_bytes from import_jobs where id = $1`, [jobId]);
    return rows[0];
  };

  before(async () => {
    ivy = await t.createUser({ username: 'pipe_ivy_ceiling' });
  });

  beforeEach(async () => {
    await t.actAs(null);
    await t.sql(`delete from import_jobs where user_id = $1`, [ivy]);
    await config('import.max_job_rows', 50000);
    await config('import.max_job_bytes', 33554432);
    await t.actAs(ivy);
    const { rows } = await t.sql(`select import_create() as id`);
    jobId = rows[0].id;
  });

  after(async () => {
    await t.actAs(null);
  });

  it('counts what it actually inserted, not what it was sent', async () => {
    const first = await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, page(1, 10)]);
    assert.equal(first.rows[0].r.staged, 10);
    assert.equal(first.rows[0].r.job_rows, 10);

    const after = await totals();
    assert.equal(after.staged_rows, 10);
    assert.ok(Number(after.staged_bytes) > 0);

    // The same page again, as a client retrying after a dropped response. `import_rows_once`
    // swallows it, so the totals must not move — a counter that double-counted a retry
    // would turn a network blip into a refused import.
    const again = await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, page(1, 10)]);
    assert.equal(again.rows[0].r.staged, 0);

    const unchanged = await totals();
    assert.equal(unchanged.staged_rows, 10);
    assert.equal(String(unchanged.staged_bytes), String(after.staged_bytes));
  });

  it('refuses the page that would cross the row ceiling, and writes none of it', async () => {
    await config('import.max_job_rows', 1000);

    await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, page(1, 600)]);
    assert.equal((await totals()).staged_rows, 600);

    await assert.rejects(
      () => t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, page(601, 600)]),
      /this import is too large .*rows/,
    );

    // **Refused before anything was written.** A half-built impossible job is worse than a
    // refused one: it holds the account's single live slot and cannot be completed.
    assert.equal((await totals()).staged_rows, 600, 'not one row of the refused page landed');
  });

  it('refuses on weight as well as on count', async () => {
    // The two bound different attacks and neither implies the other: one row may carry a
    // hundred viewings and every field at its length cap, so a job can be heavy while well
    // inside the row ceiling.
    await config('import.max_job_bytes', 4194304);
    await config('import.max_job_rows', 50000);

    /**
     * **Every page carries its own correlations**, which the first version of this did not.
     *
     * It built one page and rewrote the *names* between attempts, leaving the correlations
     * identical — so `import_rows_once` swallowed every page after the first, nothing was
     * inserted, and the running total never moved. The test failed for the opposite of the
     * reason it was about: staging was correctly idempotent and the bound was never
     * approached.
     */
    const heavyPage = (attempt) =>
      JSON.stringify(
        Array.from({ length: 40 }, (_, i) =>
          staged(`Heavy ${attempt}-${i}`, {
            correlation: `heavy ${attempt}-${i}|2001`,
            name: `Heavy ${attempt}-${i} ${'x'.repeat(180)}`,
            watches: Array.from({ length: 60 }, (_, w) => ({
              diaryUri: `https://boxd.it/H${attempt}-${i}-${w}-${'y'.repeat(200)}`,
              watchedOn: '2024-01-02',
              isRewatch: w > 0,
            })),
          })),
      );

    // Each page is legal on its own — well inside the 1,000-row and 2 MiB page bounds — and
    // it is the accumulation that is refused. That is the whole point of a job ceiling.
    let refused = null;
    for (let attempt = 0; attempt < 40 && refused === null; attempt += 1) {
      try {
        await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, heavyPage(attempt)]);
      } catch (error) {
        refused = error;
      }
    }

    assert.ok(refused, 'the byte ceiling has to stop it eventually');
    assert.match(refused.message, /this import is too large .*bytes/);
    // And well inside the row ceiling when it happened: the two bounds are independent.
    assert.ok((await totals()).staged_rows < 5000);
  });

  it('leaves a ten-thousand-film import comfortably inside both bounds', async () => {
    /**
     * **The assertion that keeps this a safety ceiling rather than a product cap.**
     *
     * The supported library size is about ten thousand films and is a measured product
     * recommendation, not a refusal. If a future edit brings the safety numbers anywhere
     * near it, this fails — which is the check the previously rejected five-thousand-title
     * cap would not have survived.
     */
    const { rows } = await t.sql(
      `select
         (select (value #>> '{}')::bigint from app_config where key = 'import.max_job_rows')  as max_rows,
         (select (value #>> '{}')::bigint from app_config where key = 'import.max_job_bytes') as max_bytes`);

    // 185 bytes per normalised row is what `payload.test.ts` measures across the real
    // export and the generated 2,500 / 5,000 / 10,000 libraries.
    const tenThousandRows = 10000;
    const tenThousandBytes = tenThousandRows * 185;

    assert.ok(
      Number(rows[0].max_rows) >= tenThousandRows * 4,
      'the row ceiling must stay far above the supported library size',
    );
    assert.ok(
      Number(rows[0].max_bytes) >= tenThousandBytes * 8,
      'and so must the byte ceiling',
    );
  });

  it('clamps a configured ceiling that would be absurd in either direction', async () => {
    // An operator cannot make the safety bound smaller than a legitimate import by editing
    // one row, and cannot remove it either. The floor is 1,000 rows and 4 MiB.
    await config('import.max_job_rows', 1);

    // 1 was clamped up to the 1,000 floor, so a full page of a thousand still stages.
    await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, page(1, 1000)]);
    assert.equal((await totals()).staged_rows, 1000);

    // And the one after it is the row that crosses the floor.
    await assert.rejects(
      () => t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, page(1001, 1)]),
      /this import is too large/,
    );
  });

  it('survives a malformed ceiling rather than refusing every import', async () => {
    await t.sql(
      `insert into app_config (key, value) values ('import.max_job_rows', '"loads"'::jsonb)
       on conflict (key) do update set value = excluded.value`);

    await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, page(1, 10)]);
    assert.equal((await totals()).staged_rows, 10, 'falls back to the default');
  });
});


// ===========================================================================
// Retention, across every terminal path — `20260917001200`
// ===========================================================================

/**
 * **The fourth road out of a job, and the one nothing swept.**
 *
 * Complete, duplicate and dead-lettered are covered above. A job left `pending` is not:
 * `import_create` only clears one when the same person imports again, `import_discard` is
 * the button they did not press, and the worker's dead letter is unreachable for it because
 * the tick returns `idle` unless something is `matching` or `applying`.
 *
 * So a half-staged archive from somebody who tried once and gave up sat there with its film
 * URIs, ratings, watch dates and every diary URI — for ever, on the account least likely to
 * come back and least likely to want it kept.
 */
describe('an archive nobody came back for', () => {
  let zoe;

  before(async () => {
    zoe = await t.createUser({ username: 'pipe_zoe' });
  });

  afterEach(async () => {
    await t.actAs(null);
    await t.sql(`delete from import_jobs where user_id = $1`, [zoe]);
  });

  /** Stages a page and walks away: no `import_ready`, so the job stays `pending`. */
  const halfStaged = async () => {
    await t.actAs(zoe);
    const { rows } = await t.sql(`select import_create() as id`);
    const jobId = rows[0].id;
    await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, JSON.stringify([
      staged('Zoe Abandoned', {
        correlation: 'zoe abandoned|2001',
        filmUri: 'https://boxd.it/ZOEFILM',
        rating: 4.5,
        bucket: 'loved',
        watchedOn: '2024-03-04',
        watches: [
          { diaryUri: 'https://boxd.it/ZOEDIARY', watchedOn: '2024-03-04', isRewatch: false },
        ],
      }),
    ])]);
    await t.actAs(null);
    return jobId;
  };

  const rawOf = async (jobId) => {
    const { rows } = await t.sql(`select raw from import_rows where job_id = $1`, [jobId]);
    return rows[0]?.raw ?? null;
  };

  it('is left alone while it is still young enough to be resumed', async () => {
    // `import_create` adopts a pending job for an hour, so sweeping one sooner would retire
    // a job somebody is still staging onto.
    const jobId = await halfStaged();

    assert.equal((await t.sql(`select _import_sweep_abandoned() as n`)).rows[0].n, 0);
    const raw = await rawOf(jobId);
    assert.ok(raw.filmUri, 'a live job keeps its payload, which is what it is for');
  });

  it('is retired and cleared once nobody has come back for a day', async () => {
    const jobId = await halfStaged();
    await t.sql(
      `update import_jobs set created_at = now() - interval '30 hours' where id = $1`, [jobId]);

    assert.equal((await t.sql(`select _import_sweep_abandoned() as n`)).rows[0].n, 1);

    const { rows: job } = await t.sql(
      `select status, completed_at, last_error from import_jobs where id = $1`, [jobId]);
    assert.equal(job[0].status, 'failed');
    assert.ok(job[0].completed_at, 'and completed, so it stops holding the one live slot');
    assert.equal(job[0].last_error, 'abandoned');

    // The completion trigger cleaned up, which is the point of marking it failed rather
    // than inventing a second rule about what a finished job keeps. For a failed job that
    // means deletion: nothing renders an abandoned import's leftovers (`20260917001300`).
    assert.equal(await rawOf(jobId), null);
    assert.equal(await count('import_rows', `job_id = '${jobId}'`), 0);
  });

  it('frees the account to import again', async () => {
    const jobId = await halfStaged();
    await t.sql(
      `update import_jobs set created_at = now() - interval '30 hours' where id = $1`, [jobId]);
    await t.sql(`select _import_sweep_abandoned() as n`);

    await t.actAs(zoe);
    const { rows } = await t.sql(`select import_create() as id`);
    assert.notEqual(rows[0].id, jobId, 'a retired job is not adopted');
    await t.actAs(null);
  });

  it('leaves a job the worker is working on alone', async () => {
    // Only `pending` is swept. Anything further along belongs to the worker, which has its
    // own dead letter and its own attempt counters.
    const jobId = await halfStaged();
    await t.sql(
      `update import_jobs set status = 'matching', created_at = now() - interval '30 hours'
        where id = $1`, [jobId]);

    assert.equal((await t.sql(`select _import_sweep_abandoned() as n`)).rows[0].n, 0);
    const { rows } = await t.sql(`select completed_at from import_jobs where id = $1`, [jobId]);
    assert.equal(rows[0].completed_at, null);
  });

  it('cannot be configured to retire a job somebody is still staging', async () => {
    // The floor is an hour, in the function rather than the row, because `import_create`
    // adopts a pending job for exactly that long.
    await t.sql(
      `insert into app_config (key, value) values ('import.abandoned_hours', '0'::jsonb)
       on conflict (key) do update set value = excluded.value`);

    const jobId = await halfStaged();
    assert.equal((await t.sql(`select _import_sweep_abandoned() as n`)).rows[0].n, 0);
    assert.ok((await rawOf(jobId)).filmUri);

    await t.sql(
      `insert into app_config (key, value) values ('import.abandoned_hours', '24'::jsonb)
       on conflict (key) do update set value = excluded.value`);
  });

  it('is what the scheduled tick actually runs', async () => {
    // The sweep exists and is unreachable if nothing calls it — which is exactly how the
    // drain itself shipped uninstalled. Asserted on the command the installer schedules.
    const { rows } = await t.sql(
      `select prosrc from pg_proc where proname = 'schedule_import_drain'`);
    assert.match(rows[0].prosrc, /_import_sweep_abandoned/);
    assert.match(rows[0].prosrc, /_drain_import_jobs/);
  });
});


// ===========================================================================
// The watchlist count, which was the one bucket left counting attempts
// ===========================================================================

describe('a watchlist the import did not add to', () => {
  let wren;

  before(async () => {
    wren = await t.createUser({ username: 'pipe_wren' });
  });

  beforeEach(async () => {
    await t.actAs(null);
    await t.sql(`delete from watchlist where user_id = $1`, [wren]);
    await t.sql(`delete from user_media where user_id = $1`, [wren]);
    await t.sql(`delete from import_jobs where user_id = $1`, [wren]);
  });

  const countsOfJob = async (jobId) =>
    (await t.sql(`select counts from import_jobs where id = $1`, [jobId])).rows[0].counts;

  it('does not count a film that was already on it', async () => {
    // The defect `20260917001000` fixed for `watched` and left standing here: the apply
    // step inserts `on conflict do nothing`, so a title already listed is a no-op — and the
    // row existing said nothing about who put it there.
    const film = await datedMovie(`Wanted Already ${seq}`, 2015);
    await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [wren, film]);

    const jobId = await importArchive(wren, [
      staged(`Wanted Already ${seq - 1}`, {
        kind: 'watchlist', correlation: 'wanted already|2015', year: 2015,
      }),
    ]);

    assert.equal((await countsOfJob(jobId)).watchlist, 0, 'nothing was added');
    assert.equal(await count('watchlist', `user_id = '${wren}'`), 1);
  });

  it('counts one the import really did add, and not again on a re-import', async () => {
    const film = await datedMovie(`Wanted New ${seq}`, 2016);
    const rows = [
      staged(`Wanted New ${seq - 1}`, {
        kind: 'watchlist', correlation: 'wanted new|2016', year: 2016,
      }),
    ];

    assert.equal((await countsOfJob(await importArchive(wren, rows))).watchlist, 1);
    assert.equal((await countsOfJob(await importArchive(wren, rows))).watchlist, 0,
      're-importing forty watchlist films used to report forty additions');

    assert.equal(await count('watchlist', `user_id = '${wren}' and media_item_id = '${film}'`), 1);
  });
});
