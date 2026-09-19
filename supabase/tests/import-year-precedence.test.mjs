import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The Hamlet report — `20260924000100`, and the removal it needed.
 *
 * ---------------------------------------------------------------------------
 * WHAT A REAL USER HIT
 *
 * An Android beta tester's Letterboxd *Hamlet* arrived as a different film: the provider
 * tier chose TMDB 1234733, the Romanian *Cătun* (2025-12-01), whose English title is
 * "Hamlet", instead of TMDB 843342, *Hamlet* (2026-02-06). It landed logged and unranked,
 * and nothing on the title page would take it out without ranking it first.
 *
 * The local tier had the same flaw with a different truncation — "exactly one *cached*
 * film within a year" — and that is what this file pins, together with what re-importing
 * and removing do to an import that already went wrong. The provider half is
 * `import-provider-match.test.mjs`.
 *
 * Fixtures mirror the real records: the same titles, original titles and release dates.
 * `Hamlet` is not in the seed catalogue, and every describe block clears the rows it made.
 */

let t;
let seq = 243000;

const count = async (table, where = 'true') => {
  const { rows } = await t.sql(`select count(*)::int as n from ${table} where ${where}`);
  return rows[0].n;
};

/** A catalogue film with an original title and a real release date. */
const film = async (title, releaseDate, originalTitle = title) => {
  const { rows } = await t.sql(
    `insert into media_items (kind, tmdb_id, title, original_title, release_date, provenance)
     values ('movie', $1, $2, $3, $4, 'manual') returning id`,
    [-Math.abs(seq++), title, originalTitle, releaseDate],
  );
  return rows[0].id;
};

const HAMLET_URI = 'https://boxd.it/hamletfilm';
const DIARY_URI = 'https://boxd.it/hamletdiary';

/** The Letterboxd row as the client stages it. */
const hamletRow = (year, over = {}) => ({
  kind: 'watched',
  correlation: `hamlet|${year ?? ''}`,
  name: 'Hamlet',
  year,
  filmUri: HAMLET_URI,
  rating: 4,
  bucket: 'loved',
  watchedOn: '2026-08-30',
  watches: [{ diaryUri: DIARY_URI, watchedOn: '2026-08-30', isRewatch: false }],
  ...over,
});

const runJob = async (jobId) => {
  for (let i = 0; i < 40; i += 1) {
    await t.sql(`select _drain_import_jobs(5, 500) as r`);
    const { rows } = await t.sql(`select completed_at from import_jobs where id = $1`, [jobId]);
    if (rows[0]?.completed_at) return;
  }
  throw new Error('job did not finish within the tick budget');
};

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

/** Stages and runs the local matcher only, so the row's own status can be read. */
const matchOnly = async (user, rows) => {
  await t.actAs(user);
  const { rows: created } = await t.sql(`select import_create() as id`);
  const jobId = created[0].id;
  await t.sql(`select import_stage($1, $2::jsonb) as r`, [jobId, JSON.stringify(rows)]);
  await t.sql(`select import_ready($1) as r`, [jobId]);
  await t.actAs(null);
  await t.sql(`select _import_match_batch($1, 100)`, [jobId]);
  const { rows: staged } = await t.sql(
    `select status, media_item_id, candidates from import_rows where job_id = $1`, [jobId]);
  // Closed so the next import by the same account opens a fresh job.
  await t.sql(`delete from import_jobs where id = $1`, [jobId]);
  return staged[0];
};

const collection = async (user) => {
  const { rows } = await t.sql(
    `select media_item_id, source from user_media where user_id = $1 order by media_item_id`, [user]);
  return rows;
};

/** Everything a Hamlet fixture touched, so each block starts from an empty shelf. */
const clearHamlet = async () => {
  await t.sql(`delete from import_jobs`);
  await t.sql(`delete from letterboxd_match_claims where letterboxd_uri = $1`, [HAMLET_URI]);
  await t.sql(`delete from letterboxd_matches where letterboxd_uri = $1`, [HAMLET_URI]);
  await t.sql(`delete from rankings where media_item_id in (select id from media_items where sort_key_squashed = 'hamlet')`);
  await t.sql(`delete from user_media where media_item_id in (select id from media_items where sort_key_squashed = 'hamlet')`);
  await t.sql(`delete from media_items where sort_key_squashed = 'hamlet'`);
};

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t.close();
});

// ===========================================================================
// Matching
// ===========================================================================

describe('an export year with the same title beside it', () => {
  let ivo;

  before(async () => {
    ivo = await t.createUser({ username: 'hamlet_ivo' });
  });

  beforeEach(clearHamlet);

  it('places the exact-year film when both are cached', async () => {
    const hamlet2026 = await film('Hamlet', '2026-02-06');
    await film('Hamlet', '2025-12-01', 'Cătun');

    const row = await matchOnly(ivo, [hamletRow(2026)]);
    assert.equal(row.status, 'matched', 'an exact year is not ambiguous beside a neighbour');
    assert.equal(row.media_item_id, hamlet2026);
  });

  it('places the exact-year film over a natively titled neighbour too', async () => {
    const hamlet2026 = await film('Hamlet', '2026-02-06');
    await film('Hamlet', '2025-03-01');

    const row = await matchOnly(ivo, [hamletRow(2026)]);
    assert.equal(row.media_item_id, hamlet2026);
  });

  it('never settles on the only cached film when it is a year out', async () => {
    // The cache holds *Cătun* and not the film meant. Before, it was the one candidate
    // within a year, so it was placed and the provider — which can see 2026 — was never asked.
    const catun = await film('Hamlet', '2025-12-01', 'Cătun');

    const row = await matchOnly(ivo, [hamletRow(2026)]);
    assert.notEqual(row.media_item_id, catun);
    assert.equal(row.status, 'needs_provider');
  });

  it('does not place a translated exact-year title the cache cannot vouch for', async () => {
    // The reported row: `Hamlet, 2025`, with only *Cătun* cached. It is in exactly that
    // year, and the real film one year later is simply not in the cache yet.
    await film('Hamlet', '2025-12-01', 'Cătun');

    const row = await matchOnly(ivo, [hamletRow(2025)]);
    assert.equal(row.media_item_id, null);
    assert.equal(row.status, 'needs_provider', 'the provider can see all three years');
  });

  it('leaves the reported row unresolved against the catalogue production holds today', async () => {
    await film('Hamlet', '2026-02-06');
    await film('Hamlet', '2025-12-01', 'Cătun');
    await film('Hamlet', '2024-05-10');
    await film('Hamlet', '2024-02-27');

    const row = await matchOnly(ivo, [hamletRow(2025)]);
    assert.equal(row.status, 'ambiguous');
    assert.equal(row.media_item_id, null);
    assert.equal(row.candidates.length, 4);
  });

  it('hands a translated exact-year title to the provider even with no native neighbour cached', async () => {
    // A foreign film exported under its English name. Not suspect, but the cache cannot rule
    // out an uncached native neighbour, so the provider (which can) decides.
    await film('Hamlet', '2025-12-01', 'Cătun');
    await film('Hamlet', '2024-01-01', 'Hamlet (Ein Film)');

    const row = await matchOnly(ivo, [hamletRow(2025)]);
    assert.equal(row.status, 'needs_provider');
  });

  it('still leaves a same-year remake unresolved', async () => {
    await film('Hamlet', '2024-05-10');
    await film('Hamlet', '2024-02-27');

    const row = await matchOnly(ivo, [hamletRow(2024)]);
    assert.equal(row.status, 'ambiguous');
    assert.equal(row.candidates.length, 2);
  });

  it('still places a lone undated film, which a year filter could never reach', async () => {
    const undated = await film('Hamlet', null);

    const row = await matchOnly(ivo, [hamletRow(2026)]);
    assert.equal(row.status, 'matched');
    assert.equal(row.media_item_id, undated);
  });

  it('is unchanged for a row with no year', async () => {
    await film('Hamlet', '2026-02-06');
    await film('Hamlet', '2025-12-01', 'Cătun');

    const row = await matchOnly(ivo, [hamletRow(null)]);
    assert.equal(row.status, 'ambiguous');
  });

  it('records a claim only for the film it placed', async () => {
    const hamlet2026 = await film('Hamlet', '2026-02-06');
    const catun = await film('Hamlet', '2025-12-01', 'Cătun');

    await matchOnly(ivo, [hamletRow(2026)]);

    const { rows } = await t.sql(
      `select media_item_id from letterboxd_match_claims where letterboxd_uri = $1`, [HAMLET_URI]);
    assert.deepEqual(rows.map((r) => r.media_item_id), [hamlet2026]);
    assert.ok(!rows.some((r) => r.media_item_id === catun));
  });
});

// ===========================================================================
// Re-import, provenance and repair
// ===========================================================================

describe('an import that already went wrong', () => {
  let jo;
  let other;
  let hamlet2026;
  let catun;

  /**
   * The state the old matcher left behind: *Cătun* in the collection as an imported, logged,
   * unranked film, carrying the Hamlet row's provenance and its one provider claim.
   * Written directly, because no code path in this build can produce it any more.
   */
  const seedWrongImport = async () => {
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, watched_on, source)
       values ($1, $2, 'loved', '2026-08-30', 'imported')`, [jo, catun]);
    await t.sql(
      `insert into imported_titles (user_id, media_item_id, letterboxd_uri, source_name, source_year, rating)
       values ($1, $2, $3, 'Hamlet', 2025, 4)`, [jo, catun, HAMLET_URI]);
    await t.sql(
      `insert into imported_watches (user_id, media_item_id, diary_uri, watched_on)
       values ($1, $2, $3, '2026-08-30')`, [jo, catun, DIARY_URI]);
    await t.sql(
      `insert into letterboxd_match_claims (letterboxd_uri, media_item_id, user_id, tier)
       values ($1, $2, $3, 'provider')`, [HAMLET_URI, catun, jo]);
  };

  const removeFromCollection = (user, item) =>
    t.asUser(user, () => t.sql(`select unlog(gen_random_uuid(), $1) as r`, [item]));

  before(async () => {
    jo = await t.createUser({ username: 'hamlet_jo' });
    other = await t.createUser({ username: 'hamlet_other' });
  });

  beforeEach(async () => {
    await clearHamlet();
    await t.sql(`delete from rankings where user_id = $1`, [jo]);
    await t.sql(`delete from user_media where user_id = $1`, [jo]);
    hamlet2026 = await film('Hamlet', '2026-02-06');
    catun = await film('Hamlet', '2025-12-01', 'Cătun');
    await seedWrongImport();
  });

  it('removal takes the wrong film and its provenance, and nothing else', async () => {
    // Another film they ranked here, and another person with the same wrong film.
    const kept = await film('Kept Film For Hamlet Suite', '2001-06-01');
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, source) values ($1, $2, 'loved', 'in_app')`,
      [jo, kept]);
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved', 1)`, [jo, kept]);
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, source) values ($1, $2, 'fine', 'imported')`,
      [other, catun]);
    const feedBefore = await count('feed_events');

    await removeFromCollection(jo, catun);

    assert.equal(await count('user_media', `user_id = '${jo}' and media_item_id = '${catun}'`), 0);
    assert.equal(await count('imported_titles', `user_id = '${jo}' and media_item_id = '${catun}'`), 0);
    assert.equal(await count('imported_watches', `user_id = '${jo}'`), 0,
      'provenance describes a collection row and cannot outlive it');

    assert.equal(await count('rankings', `user_id = '${jo}'`), 1, 'no ranking was needed or touched');
    assert.equal(await count('user_media', `user_id = '${other}' and media_item_id = '${catun}'`), 1,
      'nobody else is affected');
    assert.equal(await count('feed_events'), feedBefore, 'removal posts nothing');

    // The one stale claim is not evidence enough to be shared, and stays that way.
    assert.equal(await count('letterboxd_matches', `letterboxd_uri = '${HAMLET_URI}'`), 0);
  });

  it('remove, then re-import: the right film arrives with its provenance (repair model A)', async () => {
    await removeFromCollection(jo, catun);
    await importArchive(jo, [hamletRow(2026)]);

    assert.deepEqual(await collection(jo), [{ media_item_id: hamlet2026, source: 'imported' }]);
    const { rows } = await t.sql(
      `select media_item_id from imported_watches where user_id = $1 and diary_uri = $2`, [jo, DIARY_URI]);
    assert.equal(rows[0].media_item_id, hamlet2026, 'the diary entry re-attaches to the right film');
    const { rows: titles } = await t.sql(
      `select media_item_id, source_year from imported_titles where user_id = $1`, [jo]);
    assert.deepEqual(titles, [{ media_item_id: hamlet2026, source_year: 2026 }]);
    assert.equal(await count('feed_events', `actor_id = '${jo}'`), 0);
  });

  it('re-importing again after the repair changes nothing', async () => {
    await removeFromCollection(jo, catun);
    await importArchive(jo, [hamletRow(2026)]);
    const snapshot = {
      media: await count('user_media', `user_id = '${jo}'`),
      titles: await count('imported_titles', `user_id = '${jo}'`),
      watches: await count('imported_watches', `user_id = '${jo}'`),
    };

    await importArchive(jo, [hamletRow(2026)]);

    assert.deepEqual(
      {
        media: await count('user_media', `user_id = '${jo}'`),
        titles: await count('imported_titles', `user_id = '${jo}'`),
        watches: await count('imported_watches', `user_id = '${jo}'`),
      },
      snapshot,
    );
  });

  it('re-import first: adds the right film, never removes the wrong one, never duplicates', async () => {
    await importArchive(jo, [hamletRow(2026)]);

    assert.deepEqual(
      (await collection(jo)).map((r) => r.media_item_id).sort(),
      [hamlet2026, catun].sort(),
      'the importer only ever adds; taking the wrong film out is the person’s act',
    );
    // The diary entry is at-most-once per URI, so it stays where it first landed.
    const { rows } = await t.sql(
      `select media_item_id from imported_watches where user_id = $1`, [jo]);
    assert.deepEqual(rows.map((r) => r.media_item_id), [catun]);

    // Removing the wrong film then takes that entry with it; the next import restores it
    // against the right film. Remove-first is simply the order that needs one import.
    await removeFromCollection(jo, catun);
    assert.equal(await count('imported_watches', `user_id = '${jo}'`), 0);
    await importArchive(jo, [hamletRow(2026)]);
    const { rows: again } = await t.sql(
      `select media_item_id from imported_watches where user_id = $1`, [jo]);
    assert.deepEqual(again.map((r) => r.media_item_id), [hamlet2026]);
    assert.deepEqual(await collection(jo), [{ media_item_id: hamlet2026, source: 'imported' }]);
  });

  it('with the row as the export must have carried it (2025), re-import writes nothing wrong', async () => {
    // Against the full catalogue the reported row is genuinely ambiguous, so the repair is
    // removal plus adding the film by hand — not a second wrong film.
    await film('Hamlet', '2024-05-10');
    await film('Hamlet', '2024-02-27');
    await removeFromCollection(jo, catun);

    await importArchive(jo, [hamletRow(2025)]);
    assert.deepEqual(await collection(jo), []);
  });
});

describe('removing an imported, unranked title needs no ranking', () => {
  let kai;
  let item;

  before(async () => {
    kai = await t.createUser({ username: 'hamlet_kai' });
  });

  beforeEach(async () => {
    await clearHamlet();
    item = await film('Hamlet', '2026-02-06');
    await importArchive(kai, [hamletRow(2026)]);
  });

  it('is logged, unranked and imported before anything is done', async () => {
    assert.deepEqual(await collection(kai), [{ media_item_id: item, source: 'imported' }]);
    assert.equal(await count('rankings', `user_id = '${kai}'`), 0);
  });

  it('comes out in one call, with no ranking created on the way', async () => {
    const { rows } = await t.asUser(kai, () =>
      t.sql(`select unlog(gen_random_uuid(), $1) as r`, [item]));
    assert.equal(rows[0].r.status, 'ok');
    assert.deepEqual(await collection(kai), []);
    assert.equal(await count('rankings', `user_id = '${kai}'`), 0);
    assert.equal(await count('ranking_sessions', `user_id = '${kai}'`), 0);
    assert.equal(await count('feed_events', `actor_id = '${kai}'`), 0);
  });

  it('a ranked title still has to be unranked first, which is the client’s ranked path', async () => {
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved', 1)`, [kai, item]);
    const refused = await t.asUser(kai, () =>
      t.errorFrom(`select unlog(gen_random_uuid(), $1)`, [item]));
    assert.equal(refused?.code, '55000');

    await t.asUser(kai, () => t.sql(`select rank_unrank($1)`, [item]));
    await t.asUser(kai, () => t.sql(`select unlog(gen_random_uuid(), $1)`, [item]));
    assert.deepEqual(await collection(kai), []);
  });
});

// ===========================================================================
// Rule 1b — same-year namesakes (`20260925000100`, staging 2026-09-19)
//
// TMDB holds two 2023 "Past Lives": 666277 (original "Past Lives") and 1164820 (original
// "Nagligad nga Kinabuhi"). Before, two films in exactly the export's year were a remake.
// ===========================================================================

describe('several cached films in exactly the export’s year', () => {
  let lia;
  const PAST_URI = 'https://boxd.it/pastlivesfilm';

  const pastRow = (year, over = {}) => ({
    ...hamletRow(year),
    correlation: `past lives|${year ?? ''}`,
    name: 'Past Lives',
    filmUri: PAST_URI,
    watches: [],
    ...over,
  });

  const clearPast = async () => {
    await t.sql(`delete from import_jobs`);
    await t.sql(`delete from letterboxd_match_claims where letterboxd_uri = $1`, [PAST_URI]);
    await t.sql(`delete from letterboxd_matches where letterboxd_uri = $1`, [PAST_URI]);
    await t.sql(`delete from user_media where media_item_id in (select id from media_items where sort_key_squashed = 'pastlives')`);
    await t.sql(`delete from media_items where sort_key_squashed = 'pastlives'`);
  };

  before(async () => {
    lia = await t.createUser({ username: 'pastlives_lia' });
  });

  beforeEach(clearPast);

  it('places the one whose original title is the exported name', async () => {
    const real = await film('Past Lives', '2023-06-02');
    await film('Past Lives', '2023-03-02', 'Nagligad nga Kinabuhi');

    const row = await matchOnly(lia, [pastRow(2023)]);
    assert.equal(row.status, 'matched');
    assert.equal(row.media_item_id, real);
  });

  it('places it over a cached neighbour a year out, too', async () => {
    const real = await film('Past Lives', '2023-06-02');
    await film('Past Lives', '2023-03-02', 'Nagligad nga Kinabuhi');
    await film('Past Lives', '2022-07-16');

    const row = await matchOnly(lia, [pastRow(2023)]);
    assert.equal(row.media_item_id, real);
  });

  it('leaves two natively titled films in that year unresolved', async () => {
    await film('Past Lives', '2023-06-02');
    await film('Past Lives', '2023-10-01');

    const row = await matchOnly(lia, [pastRow(2023)]);
    assert.equal(row.status, 'ambiguous');
    assert.equal(row.media_item_id, null);
  });

  it('leaves them unresolved when none bears the name natively', async () => {
    await film('Past Lives', '2023-03-02', 'Nagligad nga Kinabuhi');
    await film('Past Lives', '2023-05-01', 'Vies antérieures');

    const row = await matchOnly(lia, [pastRow(2023)]);
    assert.equal(row.status, 'ambiguous');
  });

  it('leaves them unresolved when a competitor’s original title is unknown', async () => {
    await film('Past Lives', '2023-06-02');
    await t.sql(
      `insert into media_items (kind, tmdb_id, title, original_title, release_date, provenance)
       values ('movie', $1, 'Past Lives', null, '2023-09-01', 'manual')`, [-Math.abs(seq++)]);

    const row = await matchOnly(lia, [pastRow(2023)]);
    assert.equal(row.status, 'ambiguous');
  });

  it('still lets a trusted mapping speak first', async () => {
    await film('Past Lives', '2023-06-02');
    await film('Past Lives', '2023-03-02', 'Nagligad nga Kinabuhi');
    const trusted = await film('Past Lives', '2023-11-11', 'Something Corroborated');
    await t.sql(
      `insert into letterboxd_matches (letterboxd_uri, media_item_id, tier, claim_count)
       values ($1, $2, 'local', 2)`, [PAST_URI, trusted]);

    const row = await matchOnly(lia, [pastRow(2023)]);
    assert.equal(row.media_item_id, trusted);
  });

  it('is unchanged for a row with no year', async () => {
    await film('Past Lives', '2023-06-02');
    await film('Past Lives', '2023-03-02', 'Nagligad nga Kinabuhi');

    const row = await matchOnly(lia, [pastRow(null)]);
    assert.equal(row.status, 'ambiguous');
  });

  it('imports once and re-imports to nothing new', async () => {
    const real = await film('Past Lives', '2023-06-02');
    await film('Past Lives', '2023-03-02', 'Nagligad nga Kinabuhi');

    await importArchive(lia, [pastRow(2023)]);
    const first = await collection(lia);
    assert.deepEqual(first, [{ media_item_id: real, source: 'imported' }]);

    await importArchive(lia, [pastRow(2023)]);
    assert.deepEqual(await collection(lia), first);
    assert.equal(await count('imported_titles', `user_id = '${lia}'`), 1);
  });
});
