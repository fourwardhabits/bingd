/**
 * The IMDb import, server side (20261111000100).
 *
 * Everything here runs through the real client RPCs as the user (`import_create`,
 * `import_stage`, `import_ready`), the real worker (`_drain_import_jobs`), and the real
 * provider claim/resolve pair the Edge Function drives -- with the Edge Function's TMDB
 * answers supplied by hand, because the decision being tested is the database's.
 *
 * The groups follow the founder spec's test list (§11): matching, integrity, provenance,
 * privacy, and the cross-provider cases.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

let t;
let seq = 61000;
const tt = () => `tt${String(9000000 + seq++).padStart(7, '0')}`;

const one = async (query, params) => (await t.sql(query, params)).rows[0];
const count = async (table, where = 'true', params) =>
  (await one(`select count(*)::int as n from ${table} where ${where}`, params)).n;

const movie = async (title, year, { imdbId = null, original = null } = {}) =>
  (
    await one(
      `insert into media_items (kind, tmdb_id, title, original_title, release_date, imdb_id, provenance)
       values ('movie', $1, $2, $3, $4, $5, 'manual') returning id`,
      [-Math.abs(seq++), title, original, year ? `${year}-06-01` : null, imdbId],
    )
  ).id;

const series = async (title, year, { imdbId = null } = {}) =>
  (
    await one(
      `insert into media_items (kind, tmdb_id, title, release_date, imdb_id, provenance)
       values ('series', $1, $2, $3, $4, 'manual') returning id`,
      [-Math.abs(seq++), title, year ? `${year}-01-20` : null, imdbId],
    )
  ).id;

/** One IMDb row as the client sends it. */
const row = (name, year, imdbId, over = {}) => ({
  kind: 'watched',
  correlation: imdbId,
  name,
  originalTitle: null,
  year,
  imdbId,
  titleType: 'movie',
  imdbRating: 8,
  ...over,
});

const tick = () => t.sql(`select _drain_import_jobs(5, 500) as r`);

const runToEnd = async (jobId) => {
  for (let i = 0; i < 40; i += 1) {
    await tick();
    const done = await one(`select completed_at from import_jobs where id = $1`, [jobId]);
    if (done.completed_at) return;
  }
  throw new Error('job did not finish');
};

/** Creates, stages and readies a job as `user`, returning its id. Does not run it. */
const stage = async (user, rows, provider = 'imdb') => {
  await t.actAs(user);
  const { id } = await one(
    provider === 'letterboxd'
      ? `select import_create() as id`
      : `select import_create($1) as id`,
    provider === 'letterboxd' ? undefined : [provider],
  );
  await t.sql(`select import_stage($1, $2::jsonb) as r`, [id, JSON.stringify(rows)]);
  await t.sql(`select import_ready($1) as r`, [id]);
  await t.actAs(null);
  return id;
};

const importFile = async (user, rows, provider = 'imdb') => {
  const id = await stage(user, rows, provider);
  await runToEnd(id);
  return (await one(`select counts, status from import_jobs where id = $1`, [id])).counts;
};

const collectionRow = (user, item) =>
  one(
    `select bucket, watched_on, source from user_media where user_id = $1 and media_item_id = $2`,
    [user, item],
  );

const provenance = (user, item) =>
  one(
    `select letterboxd_uri, source_name, rating, imdb_id, imdb_rating, providers
       from imported_titles where user_id = $1 and media_item_id = $2`,
    [user, item],
  );

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t.close();
});

// ===========================================================================
// The job and the stage
// ===========================================================================

describe('an IMDb job', () => {
  let ada;
  before(async () => {
    ada = await t.createUser({ username: 'imdb_job_ada' });
  });
  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
  });

  it('is letterboxd by default, so a client that predates providers is unchanged', async () => {
    await t.actAs(ada);
    const { id } = await one(`select import_create() as id`);
    await t.actAs(null);
    assert.equal(
      (await one(`select provider from import_jobs where id = $1`, [id])).provider,
      'letterboxd',
    );
  });

  it('refuses a provider it does not know', async () => {
    const error = await t.asUser(ada, () =>
      t.errorFrom(`select import_create('rotten_tomatoes')`),
    );
    await t.actAs(null);
    assert.equal(error?.code, '22023');
  });

  it('never hands a half-sent Letterboxd job to an IMDb import, or the reverse', async () => {
    await t.actAs(ada);
    const lb = (await one(`select import_create() as id`)).id;
    const imdb = (await one(`select import_create('imdb') as id`)).id;
    await t.actAs(null);
    assert.notEqual(lb, imdb);
    assert.equal(
      await count('import_jobs', 'id = $1', [lb]),
      0,
      'the abandoned pending job is cleared',
    );
    assert.equal(
      (await one(`select provider from import_jobs where id = $1`, [imdb])).provider,
      'imdb',
    );
  });

  it('refuses, rather than clears, the other provider’s job while its rows are being sent', async () => {
    // Device A is mid-upload of a Letterboxd file; device B starts an IMDb import
    // (independent review, 2026-11-11). Clearing A's job would break its upload, and A's
    // retry would then clear B's.
    await t.actAs(ada);
    const lb = (await one(`select import_create() as id`)).id;
    await t.sql(`select import_stage($1, $2::jsonb)`, [
      lb,
      JSON.stringify([{ kind: 'watched', correlation: 'a|2001', name: 'A', year: 2001 }]),
    ]);
    const error = await t.errorFrom(`select import_create('imdb')`);
    await t.actAs(null);
    assert.equal(error?.code, '22023');
    assert.equal(
      await count('import_jobs', 'id = $1', [lb]),
      1,
      'the upload in progress is intact',
    );
    assert.equal(await count('import_rows', 'job_id = $1', [lb]), 1);
  });

  it('hands back a RUNNING job of either provider, so the client can say one is running', async () => {
    const running = await stage(ada, [row('Running Film', 2001, tt())]);
    await t.actAs(ada);
    const again = (await one(`select import_create() as id`)).id;
    await t.actAs(null);
    assert.equal(again, running);
  });

  it('reports its provider through import_status', async () => {
    const id = await stage(ada, [row('Status Film', 2001, tt())]);
    const status = await t.asUser(ada, () => one(`select * from import_status($1)`, [id]));
    await t.actAs(null);
    assert.equal(status.provider, 'imdb');
  });
});

describe('what an IMDb page may carry', () => {
  let bo;
  before(async () => {
    bo = await t.createUser({ username: 'imdb_stage_bo' });
  });
  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
  });

  const stagedRaw = async (rows) => {
    await t.actAs(bo);
    const { id } = await one(`select import_create('imdb') as id`);
    const result = (
      await one(`select import_stage($1, $2::jsonb) as r`, [id, JSON.stringify(rows)])
    ).r;
    await t.actAs(null);
    const { rows: staged } = await t.sql(
      `select correlation, raw from import_rows where job_id = $1 order by correlation`,
      [id],
    );
    return { result, staged };
  };

  it('keeps the named IMDb fields and discards everything else, Letterboxd fields included', async () => {
    const id = tt();
    const { staged } = await stagedRaw([
      {
        ...row('The Kept Film', 1999, id, {
          originalTitle: 'Le Film Gardé',
          titleType: 'Movie',
        }),
        filmUri: 'https://boxd.it/abc',
        rating: 4.5,
        bucket: 'loved',
        watchedOn: '2020-01-01',
        dateRated: '2020-01-01',
        imdbCommunityRating: 7.9,
        directors: 'Somebody',
      },
    ]);
    assert.equal(staged.length, 1);
    assert.equal(staged[0].correlation, id);
    assert.deepEqual(staged[0].raw, {
      name: 'The Kept Film',
      originalTitle: 'Le Film Gardé',
      year: 1999,
      imdbId: id,
      titleType: 'movie',
      imdbRating: 8,
    });
  });

  it('drops a row whose Const is not a tt id, and a row with no title', async () => {
    const { staged } = await stagedRaw([
      row('No Id', 2001, 'nm0000001'),
      row('Short Id', 2001, 'tt12'),
      row('', 2001, tt()),
      row('Kept', 2001, tt()),
    ]);
    assert.deepEqual(
      staged.map((s) => s.raw.name),
      ['Kept'],
    );
  });

  it('drops an out-of-range rating and any rating on a type bingd cannot place', async () => {
    const a = tt();
    const b = tt();
    const c = tt();
    const { staged } = await stagedRaw([
      row('Eleven', 2001, a, { imdbRating: 11 }),
      row('Episode', 2001, b, { titleType: 'TV Episode', imdbRating: 9 }),
      row('Nine', 2001, c, { imdbRating: 9 }),
      row('Show', 2001, tt(), { titleType: 'TV Series', imdbRating: 9 }),
    ]);
    const by = Object.fromEntries(staged.map((s) => [s.raw.name, s.raw]));
    assert.equal(by.Eleven.imdbRating, undefined);
    assert.equal(by.Episode.imdbRating, undefined);
    assert.equal(by.Episode.titleType, 'tvepisode');
    assert.equal(by.Nine.imdbRating, 9);
    // A show is recognised and not added: its rating has nowhere to live, so it is not kept.
    assert.equal(by.Show.imdbRating, undefined);
  });

  it('stages a duplicated Const once', async () => {
    const id = tt();
    const { result, staged } = await stagedRaw([
      row('Twice', 2001, id),
      row('Twice', 2001, id),
    ]);
    assert.equal(staged.length, 1);
    assert.equal(result.staged, 1);
  });

  it('folds an unknown type to other, which places nothing', async () => {
    const { staged } = await stagedRaw([
      row('Game', 2001, tt(), { titleType: 'Video Game!' }),
      row('Odd', 2001, tt(), { titleType: 'Hologram' }),
    ]);
    assert.deepEqual(staged.map((s) => s.raw.titleType).sort(), ['other', 'videogame']);
  });
});

// ===========================================================================
// Matching
// ===========================================================================

describe('matching an IMDb row', () => {
  let cy;
  before(async () => {
    cy = await t.createUser({ username: 'imdb_match_cy' });
  });
  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
    await t.sql(`delete from user_media where user_id = $1`, [cy]);
  });

  it('places a movie through a catalogue title TMDB already confirmed for that id', async () => {
    const id = tt();
    const film = await movie('Local Mapping', 2004, { imdbId: id });
    const counts = await importFile(cy, [row('Local Mapping', 2004, id)]);
    assert.equal(counts.watched, 1);
    assert.deepEqual(await collectionRow(cy, film), {
      bucket: null,
      watched_on: null,
      source: 'imported',
    });
  });

  it('accepts a localised title when the original title agrees', async () => {
    const id = tt();
    const film = await movie('The Lives of Others', 2006, {
      imdbId: id,
      original: 'Das Leben der Anderen',
    });
    const counts = await importFile(cy, [
      row('Das Leben der Anderen', 2006, id, { originalTitle: 'Das Leben der Anderen' }),
    ]);
    assert.equal(counts.watched, 1);
    assert.ok(await collectionRow(cy, film));
  });

  it('refuses a mapping whose year is more than one out, rather than trusting the id blindly', async () => {
    const id = tt();
    const film = await movie('Wrong Year', 1990, { imdbId: id });
    const counts = await importFile(cy, [row('Wrong Year', 2010, id)]);
    assert.equal(counts.unmatched, 1);
    assert.equal(await collectionRow(cy, film), undefined);
  });

  it('refuses a mapping whose title is nothing like the row', async () => {
    const id = tt();
    const film = await movie('Cats', 2019, { imdbId: id });
    const counts = await importFile(cy, [row('The Godfather', 2019, id)]);
    assert.equal(counts.unmatched, 1);
    assert.equal(await collectionRow(cy, film), undefined);
  });

  it('never reclassifies: an IMDb Movie whose id names a TV series stays unmatched', async () => {
    const id = tt();
    const show = await series('Kind Clash', 2008, { imdbId: id });
    const counts = await importFile(cy, [row('Kind Clash', 2008, id, { titleType: 'Movie' })]);
    assert.equal(counts.unmatched, 1);
    assert.equal(await count('user_media', 'media_item_id = $1', [show]), 0);
  });

  it('leaves conflicting ids (two titles carrying one) unresolved', async () => {
    const id = tt();
    await movie('Twin', 2001, { imdbId: id });
    await movie('Twin', 2001, { imdbId: id });
    const counts = await importFile(cy, [row('Twin', 2001, id)]);
    assert.equal(counts.ambiguous, 1);
    assert.equal(counts.watched, 0);
  });

  it('recognises a TV series as the canonical show and reports it, never touching a season', async () => {
    const id = tt();
    const show = await series('Breaking Ground', 2008, { imdbId: id });
    const season = await t.createSeason(show, 1, 'Season 1');
    const counts = await importFile(cy, [
      row('Breaking Ground', 2008, id, { titleType: 'TV Series', imdbRating: 10 }),
    ]);
    assert.equal(counts.unsupported, 1);
    assert.equal(counts.unsupported_tv, 1);
    assert.equal(counts.watched, 0);
    assert.equal(
      await count('user_media', 'user_id = $1 and media_item_id in ($2, $3)', [
        cy,
        show,
        season,
      ]),
      0,
    );
    assert.equal(
      await count('rankings', 'user_id = $1', [cy]),
      0,
      'no season ranking is invented',
    );
  });

  it('recognises a TV mini-series as the canonical show, and reports it the same way', async () => {
    const id = tt();
    await series('Short Run', 2019, { imdbId: id });
    const counts = await importFile(cy, [
      row('Short Run', 2019, id, { titleType: 'TV Mini Series' }),
    ]);
    assert.equal(counts.unsupported_tv, 1);
  });

  it('reports an episode as unsupported without ever asking the provider', async () => {
    const id = await stage(cy, [row('Pilot', 2008, tt(), { titleType: 'TV Episode' })]);
    await t.sql(`select _import_match_batch($1, 50)`, [id]);
    const claimed = await t.sql(`select * from _import_provider_claim(50)`);
    assert.equal(claimed.rows.length, 0);
    await runToEnd(id);
    const counts = (await one(`select counts from import_jobs where id = $1`, [id])).counts;
    assert.equal(counts.unsupported, 1);
    assert.equal(counts.unsupported_episode, 1);
  });

  it('does not let unsupported or unmatched rows block the rest of the file', async () => {
    const good = tt();
    const film = await movie('Good Film', 2015, { imdbId: good });
    const counts = await importFile(cy, [
      row('Good Film', 2015, good),
      row('Pilot', 2015, tt(), { titleType: 'TV Episode' }),
      row('Game', 2015, tt(), { titleType: 'Video Game' }),
      row('Nowhere Film', 2015, tt()),
    ]);
    assert.equal(counts.watched, 1);
    assert.equal(counts.unsupported, 2);
    assert.equal(
      counts.unmatched,
      1,
      'no provider configured here, so the unknown film settles unmatched',
    );
    assert.ok(await collectionRow(cy, film));
  });
});

describe('the provider tier for an IMDb row', () => {
  let di;
  before(async () => {
    di = await t.createUser({ username: 'imdb_provider_di' });
  });
  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
    await t.sql(`delete from user_media where user_id = $1`, [di]);
  });

  const claimOne = async (jobId) => {
    await t.sql(`select _import_match_batch($1, 50)`, [jobId]);
    const { rows } = await t.sql(`select * from _import_provider_claim(50)`);
    assert.equal(rows.length, 1);
    return rows[0];
  };

  it('hands the Edge Function the id, type and original title it needs', async () => {
    const id = tt();
    const job = await stage(di, [
      row('Claimed Film', 2002, id, { originalTitle: 'Film Réclamé' }),
    ]);
    const claim = await claimOne(job);
    assert.equal(claim.provider, 'imdb');
    assert.equal(claim.imdb_id, id);
    assert.equal(claim.title_type, 'movie');
    assert.equal(claim.original_title, 'Film Réclamé');
    assert.equal(claim.name, 'Claimed Film');
    assert.equal(claim.year, 2002);
  });

  it('a /find answer places the film and teaches the catalogue the id', async () => {
    const id = tt();
    const film = await movie('Found Film', 2003);
    const job = await stage(di, [row('Found Film', 2003, id)]);
    const claim = await claimOne(job);
    await t.sql(`select _import_provider_resolve($1, $2, false, $3)`, [claim.row_id, film, id]);
    await runToEnd(job);
    assert.equal(
      (await one(`select imdb_id from media_items where id = $1`, [film])).imdb_id,
      id,
    );
    assert.ok(await collectionRow(di, film));
  });

  it('a title-search answer places the film but never writes the id', async () => {
    const id = tt();
    const film = await movie('Searched Film', 2003);
    const job = await stage(di, [row('Searched Film', 2003, id)]);
    const claim = await claimOne(job);
    await t.sql(`select _import_provider_resolve($1, $2, false)`, [claim.row_id, film]);
    await runToEnd(job);
    assert.equal(
      (await one(`select imdb_id from media_items where id = $1`, [film])).imdb_id,
      null,
    );
    assert.ok(await collectionRow(di, film));
  });

  it('re-checks the answer: a series offered for an IMDb Movie row is refused', async () => {
    const id = tt();
    const show = await series('Answer Clash', 2003);
    const job = await stage(di, [row('Answer Clash', 2003, id)]);
    const claim = await claimOne(job);
    await t.sql(`select _import_provider_resolve($1, $2, false, $3)`, [claim.row_id, show, id]);
    assert.equal(
      (await one(`select status from import_rows where id = $1`, [claim.row_id])).status,
      'unmatched',
    );
    assert.equal(
      (await one(`select imdb_id from media_items where id = $1`, [show])).imdb_id,
      null,
    );
  });

  it('re-checks the answer: a film from the wrong year is refused', async () => {
    const id = tt();
    const film = await movie('Year Clash', 1970);
    const job = await stage(di, [row('Year Clash', 2003, id)]);
    const claim = await claimOne(job);
    await t.sql(`select _import_provider_resolve($1, $2, false, $3)`, [claim.row_id, film, id]);
    assert.equal(
      (await one(`select status from import_rows where id = $1`, [claim.row_id])).status,
      'unmatched',
    );
  });

  it('never writes an id onto a second title', async () => {
    const id = tt();
    await movie('Holder', 2003, { imdbId: id });
    const other = await movie('Holder', 2003);
    // The holder is found locally, so a fresh tt on a row named Holder goes to the provider.
    const job = await stage(di, [row('Holder', 2003, id)]);
    await t.sql(`select _import_match_batch($1, 50)`, [job]);
    // Local tier settled it (one title carries the id); force the write path directly.
    const { rows } = await t.sql(`select id from import_rows where job_id = $1`, [job]);
    await t.sql(
      `update import_rows set status = 'needs_provider', media_item_id = null where id = $1`,
      [rows[0].id],
    );
    await t.sql(`select _import_provider_resolve($1, $2, false, $3)`, [rows[0].id, other, id]);
    assert.equal(
      (await one(`select imdb_id from media_items where id = $1`, [other])).imdb_id,
      null,
    );
  });

  it('a series answer is recorded as recognised and unsupported, not added', async () => {
    const id = tt();
    const show = await series('Provider Show', 2010);
    const job = await stage(di, [row('Provider Show', 2010, id, { titleType: 'TV Series' })]);
    const claim = await claimOne(job);
    await t.sql(`select _import_provider_resolve($1, $2, false, $3)`, [claim.row_id, show, id]);
    await runToEnd(job);
    const counts = (await one(`select counts from import_jobs where id = $1`, [job])).counts;
    assert.equal(counts.unsupported_tv, 1);
    assert.equal(await count('user_media', 'user_id = $1', [di]), 0);
  });

  it('an episode /find answer is reported unsupported', async () => {
    const job = await stage(di, [row('Episode Typed As Movie', 2010, tt())]);
    const claim = await claimOne(job);
    await t.sql(`select _import_provider_resolve($1, null, false, null, true)`, [claim.row_id]);
    await runToEnd(job);
    assert.equal(
      (await one(`select counts from import_jobs where id = $1`, [job])).counts.unsupported,
      1,
    );
  });

  it('cannot be called by a signed-in client', async () => {
    const error = await t.asUser(di, () =>
      t.errorFrom(
        `select _import_provider_resolve(gen_random_uuid(), gen_random_uuid(), false, 'tt0000001')`,
      ),
    );
    await t.actAs(null);
    assert.equal(error?.code, '42501');
  });

  it('cannot be bypassed: a client cannot write a title id itself', async () => {
    const film = await movie('Poison Target', 2003);
    await t.asUser(di, () =>
      t.errorFrom(`update media_items set imdb_id = 'tt0068646' where id = $1`, [film]),
    );
    await t.actAs(null);
    assert.equal(
      (await one(`select imdb_id from media_items where id = $1`, [film])).imdb_id,
      null,
    );
  });
});

// ===========================================================================
// Integrity: what an import may never do
// ===========================================================================

describe('what an IMDb import never changes', () => {
  let ed;
  before(async () => {
    ed = await t.createUser({ username: 'imdb_integrity_ed' });
  });
  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
    await t.sql(`delete from rankings where user_id = $1`, [ed]);
    await t.sql(`delete from user_media where user_id = $1`, [ed]);
    await t.sql(`delete from feed_events where actor_id = $1`, [ed]);
  });

  it('never overwrites a ranking, and still records where else it was rated', async () => {
    const id = tt();
    const film = await movie('Ranked Here', 2001, { imdbId: id });
    await t.actAs(ed);
    await t.rankToCompletion(film, 'fine', () => film);
    await t.actAs(null);
    const before = await t.ranking(ed);
    const counts = await importFile(ed, [row('Ranked Here', 2001, id, { imdbRating: 10 })]);
    assert.deepEqual(await t.ranking(ed), before);
    assert.equal(counts.kept, 1);
    assert.equal(counts.watched, 0);
    const prov = await provenance(ed, film);
    assert.equal(prov?.imdb_rating, 10, 'the IMDb rating is kept as provenance');
  });

  it('never turns an IMDb rating into a bucket, a position or a score', async () => {
    const id = tt();
    const film = await movie('Ten Out Of Ten', 2001, { imdbId: id });
    await importFile(ed, [row('Ten Out Of Ten', 2001, id, { imdbRating: 10 })]);
    assert.equal((await collectionRow(ed, film)).bucket, null);
    assert.equal(await count('rankings', 'user_id = $1', [ed]), 0);
    const prov = await provenance(ed, film);
    assert.equal(prov.imdb_rating, 10);
    assert.equal(prov.rating, null, 'the Letterboxd star column is not borrowed');
  });

  it('never overwrites a title logged here: bucket and date stay', async () => {
    const id = tt();
    const film = await movie('Logged Here', 2001, { imdbId: id });
    await t.actAs(ed);
    await t.sql(`select log_watched(gen_random_uuid(), $1, date '2024-02-02', 'loved') as r`, [
      film,
    ]);
    await t.actAs(null);
    const before = await collectionRow(ed, film);
    const counts = await importFile(ed, [row('Logged Here', 2001, id, { imdbRating: 2 })]);
    assert.deepEqual(await collectionRow(ed, film), before);
    assert.equal(counts.kept, 1);
  });

  it('never assigns a watch date: Date Rated is not sent and nothing is dated', async () => {
    const id = tt();
    const film = await movie('Undated', 2001, { imdbId: id });
    await importFile(ed, [
      { ...row('Undated', 2001, id), dateRated: '2023-03-03', watchedOn: '2023-03-03' },
    ]);
    assert.equal((await collectionRow(ed, film)).watched_on, null);
    assert.equal(
      await count(
        'watch_events',
        'user_id = $1 and media_item_id = $2 and watched_on is not null',
        [ed, film],
      ),
      0,
    );
  });

  it('posts nothing to the feed and sends only the import lifecycle notifications', async () => {
    const ids = [tt(), tt(), tt()];
    for (const [i, id] of ids.entries()) await movie(`Quiet ${i}`, 2001, { imdbId: id });
    const job = await stage(
      ed,
      ids.map((id, i) => row(`Quiet ${i}`, 2001, id)),
    );
    await runToEnd(job);
    assert.equal(await count('feed_events', 'actor_id = $1', [ed]), 0);
    const { rows } = await t.sql(
      `select type, payload from notifications
        where recipient_id = $1 and subject_id = $2 order by created_at`,
      [ed, job],
    );
    assert.deepEqual(
      rows.map((r) => r.type),
      ['import_started', 'import_completed'],
    );
    assert.ok(rows.every((r) => r.payload.provider === 'imdb'));
  });

  it('is idempotent: the same file twice is one collection row, reported as previously imported', async () => {
    const id = tt();
    const film = await movie('Twice Imported', 2001, { imdbId: id });
    await importFile(ed, [row('Twice Imported', 2001, id)]);
    const second = await importFile(ed, [row('Twice Imported', 2001, id)]);
    assert.equal(second.watched, 0);
    assert.equal(second.already, 1);
    assert.equal(
      await count('user_media', 'user_id = $1 and media_item_id = $2', [ed, film]),
      1,
    );
    assert.equal(
      await count('imported_titles', 'user_id = $1 and media_item_id = $2', [ed, film]),
      1,
    );
  });

  it('counts two Consts that resolve to one title once', async () => {
    const a = tt();
    const b = tt();
    const film = await movie('Doubled', 2001, { imdbId: a });
    const job = await stage(ed, [row('Doubled', 2001, a), row('Doubled', 2001, b)]);
    await t.sql(`select _import_match_batch($1, 50)`, [job]);
    const claim = (await t.sql(`select * from _import_provider_claim(50)`)).rows[0];
    await t.sql(`select _import_provider_resolve($1, $2, false)`, [claim.row_id, film]);
    await runToEnd(job);
    const counts = (await one(`select counts from import_jobs where id = $1`, [job])).counts;
    assert.equal(counts.watched, 1);
    assert.equal(counts.duplicate, 1);
    assert.equal(await count('user_media', 'user_id = $1', [ed]), 1);
  });
});

// ===========================================================================
// Two providers, one collection
// ===========================================================================

describe('Letterboxd and IMDb together', () => {
  let flo;
  before(async () => {
    flo = await t.createUser({ username: 'imdb_cross_flo' });
  });
  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
    await t.sql(`delete from user_media where user_id = $1`, [flo]);
  });

  const lbRow = (name, year) => ({
    kind: 'watched',
    correlation: `${name.toLowerCase()}|${year}`,
    name,
    year,
    filmUri: `https://boxd.it/${name.toLowerCase().replace(/\W/g, '')}`,
    rating: 3.5,
    watchedOn: '2022-05-05',
    watches: [
      { diaryUri: `https://boxd.it/d${seq++}`, watchedOn: '2022-05-05', isRewatch: false },
    ],
  });

  it('Letterboxd then IMDb is one collection row with both provenances, nothing overwritten', async () => {
    const id = tt();
    const film = await movie('Both Places', 2012, { imdbId: id });
    await importFile(flo, [lbRow('Both Places', 2012)], 'letterboxd');
    const before = await collectionRow(flo, film);
    const counts = await importFile(flo, [row('Both Places', 2012, id, { imdbRating: 7 })]);

    assert.equal(counts.already, 1);
    assert.equal(counts.watched, 0);
    assert.equal(await count('user_media', 'user_id = $1', [flo]), 1);
    assert.deepEqual(
      await collectionRow(flo, film),
      before,
      'the diary date Letterboxd brought stays',
    );
    const prov = await provenance(flo, film);
    assert.equal(Number(prov.rating), 3.5, 'the Letterboxd star is untouched');
    assert.equal(prov.imdb_rating, 7);
    assert.equal(prov.imdb_id, id);
    assert.ok(prov.letterboxd_uri);
    assert.deepEqual(prov.providers, ['letterboxd', 'imdb']);
  });

  it('IMDb then Letterboxd is one collection row, and Letterboxd adds what only it knows', async () => {
    const id = tt();
    const film = await movie('Other Order', 2013, { imdbId: id });
    await importFile(flo, [row('Other Order', 2013, id, { imdbRating: 6 })]);
    const counts = await importFile(flo, [lbRow('Other Order', 2013)], 'letterboxd');
    assert.equal(counts.already, 1);
    assert.equal(await count('user_media', 'user_id = $1', [flo]), 1);
    const prov = await provenance(flo, film);
    assert.deepEqual(prov.providers, ['imdb', 'letterboxd']);
    assert.equal(prov.imdb_rating, 6);
    assert.equal(Number(prov.rating), 3.5);
  });

  it('a Letterboxd import alone still records itself as Letterboxd', async () => {
    const film = await movie('Only Letterboxd', 2014);
    await importFile(flo, [lbRow('Only Letterboxd', 2014)], 'letterboxd');
    assert.deepEqual((await provenance(flo, film)).providers, ['letterboxd']);
  });

  it('keeps the Letterboxd summary exactly as it was: no IMDb buckets on it', async () => {
    await movie('Plain Letterboxd', 2015);
    const counts = await importFile(flo, [lbRow('Plain Letterboxd', 2015)], 'letterboxd');
    for (const key of [
      'unsupported',
      'unsupported_tv',
      'unsupported_episode',
      'failed',
      'duplicate',
    ]) {
      assert.equal(key in counts, false, key);
    }
  });
});

// ===========================================================================
// Privacy, scoping and retention
// ===========================================================================

describe('whose import it is, and what is kept', () => {
  let gus;
  let hal;
  before(async () => {
    gus = await t.createUser({ username: 'imdb_privacy_gus' });
    hal = await t.createUser({ username: 'imdb_privacy_hal' });
  });
  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
  });

  it('another account can neither stage into the job nor read it', async () => {
    await t.actAs(gus);
    const { id } = await one(`select import_create('imdb') as id`);
    await t.actAs(null);
    const error = await t.asUser(hal, () =>
      t.errorFrom(`select import_stage($1, $2::jsonb)`, [
        id,
        JSON.stringify([row('Intruder', 2001, tt())]),
      ]),
    );
    const seen = await t.asUser(hal, () => t.sql(`select * from import_status($1)`, [id]));
    await t.actAs(null);
    assert.equal(error?.code, 'P0002');
    assert.equal(seen.rows.length, 0);
  });

  it('anon cannot open an import at all', async () => {
    const error = await t.asAnon(() => t.errorFrom(`select import_create('imdb')`));
    assert.ok(error);
  });

  it('keeps no ratings or ids once settled: placed rows deleted, unmatched ones reduced to name and year', async () => {
    const placed = tt();
    const lost = tt();
    await movie('Placed', 2001, { imdbId: placed });
    const job = await stage(gus, [
      row('Placed', 2001, placed),
      row('Not Found Anywhere', 2001, lost, { originalTitle: 'Nulle Part' }),
      row('An Episode', 2001, tt(), { titleType: 'TV Episode' }),
    ]);
    await runToEnd(job);
    const { rows } = await t.sql(`select status, raw from import_rows where job_id = $1`, [
      job,
    ]);
    // `needs_provider` is how a row the provider never reached settles (counted unmatched).
    assert.equal(rows.length, 1);
    assert.ok(['unmatched', 'needs_provider'].includes(rows[0].status));
    assert.deepEqual(rows[0].raw, { name: 'Not Found Anywhere', year: 2001 });
    // The tt id was the row's correlation; it goes too (independent review, 2026-11-11).
    assert.equal(
      await count('import_rows', 'job_id = $1 and correlation = $2', [job, lost]),
      0,
    );
    assert.equal(
      await count('import_rows', `job_id = $1 and correlation not like 'redacted:%'`, [job]),
      0,
    );
  });

  it('a job that fails keeps nothing', async () => {
    const job = await stage(gus, [row('Doomed', 2001, tt())]);
    await t.sql(
      `update import_jobs set status = 'failed', completed_at = now() where id = $1`,
      [job],
    );
    assert.equal(await count('import_rows', 'job_id = $1', [job]), 0);
  });

  it('deleting the account removes the job and the provenance', async () => {
    const id = tt();
    const film = await movie('Leaving With Me', 2001, { imdbId: id });
    await importFile(hal, [row('Leaving With Me', 2001, id)]);
    assert.equal(await count('imported_titles', 'user_id = $1', [hal]), 1);
    await t.sql(`delete from auth.users where id = $1`, [hal]);
    assert.equal(await count('imported_titles', 'user_id = $1', [hal]), 0);
    assert.equal(await count('import_jobs', 'user_id = $1', [hal]), 0);
    assert.equal(
      (await one(`select imdb_id from media_items where id = $1`, [film])).imdb_id,
      id,
      'the catalogue keeps its id: that is TMDB data, not theirs',
    );
  });
});
