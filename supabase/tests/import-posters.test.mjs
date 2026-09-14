import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { catalogueItem } from '../functions/letterboxd-import/match.mjs';
import { createTestDb } from './harness.mjs';

/**
 * Imported films arrive with their posters — `letterboxd-import/match.mjs` `catalogueItem`
 * and `20260917001400`.
 *
 * Physical QA on staging, 2026-09-12: fourteen of twenty-four imported films were initials
 * tiles in Collection until each title page was opened. The provider tier had created them
 * from a search result and kept only the id, title and date. These tests are written against
 * what Collection reads (`user_media` embedding `media_items.poster_path`), not against the
 * function that happens to write it.
 */

let t;
let seq = 171000;

const staged = (name, over = {}) => ({
  kind: 'watched',
  correlation: `${name.toLowerCase()}|2001`,
  name,
  year: 2001,
  filmUri: `https://boxd.it/${name.toLowerCase().replace(/\W/g, '')}`,
  rating: 4,
  bucket: 'loved',
  watchedOn: null,
  ...over,
});

/** A TMDB `/search/movie` result, as the provider tier receives it. */
const searchResult = (title, over = {}) => ({
  id: 900000 + seq++,
  title,
  original_title: title,
  release_date: '2001-05-18',
  overview: 'An ogre, a donkey, a swamp.',
  poster_path: `/poster-${seq}.jpg`,
  backdrop_path: `/backdrop-${seq}.jpg`,
  original_language: 'en',
  popularity: 12.5,
  genre_ids: [16, 35],
  ...over,
});

/** What Collection's Watched and Unranked shelves read for this account. */
const collectionPosters = async (user) => {
  const { rows } = await t.sql(
    `select mi.title, mi.poster_path
       from user_media um join media_items mi on mi.id = um.media_item_id
      where um.user_id = $1 order by mi.title`,
    [user],
  );
  return rows;
};

/**
 * One import, driven the way the worker drives it, with the provider tier played by the
 * same two calls `letterboxd-import/index.ts` makes: the upsert, then the resolve.
 */
const importThroughProvider = async (user, name, result) => {
  await t.actAs(user);
  const { rows } = await t.sql(`select import_create() as id`);
  const jobId = rows[0].id;
  await t.sql(`select import_stage($1, $2::jsonb) as r`, [
    jobId,
    JSON.stringify([staged(name, { correlation: `${name.toLowerCase()}|2001` })]),
  ]);
  await t.sql(`select import_ready($1) as r`, [jobId]);
  await t.actAs(null);
  await t.sql(`select _import_match_batch($1, 100)`, [jobId]);

  const { rows: claims } = await t.sql(`select * from _import_provider_claim(50)`);
  assert.equal(claims.length, 1, 'the row should have needed the provider');
  const { rows: written } = await t.sql(`select * from tmdb_upsert_titles($1::jsonb)`, [
    JSON.stringify([catalogueItem(result)]),
  ]);
  await t.sql(`select _import_provider_resolve($1, $2)`, [
    claims[0].row_id,
    written[0].media_item_id,
  ]);

  for (let i = 0; i < 20; i += 1) {
    await t.sql(`select _drain_import_jobs(5, 500)`);
    const { rows: job } = await t.sql(`select completed_at from import_jobs where id = $1`, [
      jobId,
    ]);
    if (job[0].completed_at) return written[0].media_item_id;
  }
  throw new Error('job did not finish');
};

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t.close();
});

describe('catalogueItem', () => {
  it('keeps the poster and the other display fields the search already returned', () => {
    const item = catalogueItem(searchResult('Shrek'));
    assert.equal(item.kind, 'movie');
    assert.equal(item.title, 'Shrek');
    assert.equal(item.release_date, '2001-05-18');
    assert.match(item.poster_path, /^\/poster-/);
    assert.match(item.backdrop_path, /^\/backdrop-/);
    assert.equal(item.overview, 'An ogre, a donkey, a swamp.');
    assert.equal(item.original_language, 'en');
    assert.equal(item.popularity, 12.5);
  });

  it("reads TMDB's empty strings as nothing, so a coalesce keeps what a detail call wrote", () => {
    const item = catalogueItem(
      searchResult('Free Solo', { poster_path: null, overview: '', release_date: '' }),
    );
    assert.equal(item.poster_path, null);
    assert.equal(item.overview, null);
    assert.equal(item.release_date, null);
  });

  it('sends no genres, because a search result has ids and the column holds names', () => {
    assert.equal('genres' in catalogueItem(searchResult('Barbie')), false);
  });
});

describe('an imported film in Collection', () => {
  let ivy;

  before(async () => {
    ivy = await t.createUser({ username: 'poster_ivy' });
  });

  beforeEach(async () => {
    await t.sql(`delete from import_jobs`);
    await t.sql(`delete from user_media where user_id = $1`, [ivy]);
  });

  it('has its poster as soon as the import finishes, when the provider placed it', async () => {
    const name = `Shrek Poster ${seq}`;
    await importThroughProvider(ivy, name, searchResult(name));

    const shelf = await collectionPosters(ivy);
    assert.equal(shelf.length, 1);
    assert.match(
      shelf[0].poster_path ?? '',
      /^\/poster-/,
      'Collection must not need a title page visit',
    );
  });

  it('shows the placeholder only for a film the provider genuinely has no poster for', async () => {
    const name = `Posterless Short ${seq}`;
    await importThroughProvider(ivy, name, searchResult(name, { poster_path: null }));

    const shelf = await collectionPosters(ivy);
    assert.equal(shelf[0].poster_path, null);
  });
});

describe('the enrichment nudge', () => {
  let una;

  const thin = async () => {
    const { rows } = await t.sql(`select _import_thin_titles(25) as ids`);
    return rows[0].ids;
  };

  // A seed row: fetched once, long before anybody imported it. `fetched_at` is not null.
  const film = async ({
    poster = null,
    fetched = new Date(Date.now() - 86_400_000).toISOString(),
  } = {}) => {
    const { rows } = await t.sql(
      `insert into media_items (kind, tmdb_id, title, poster_path, provenance, fetched_at)
       values ('movie', $1, $2, $3, 'manual', $4) returning id`,
      [-seq, `Nudge Film ${seq++}`, poster, fetched],
    );
    return rows[0].id;
  };

  const imported = async (item, { hoursAgo = 0 } = {}) => {
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, source, created_at)
       values ($1, $2, 'loved', 'imported', now() - make_interval(hours => $3))`,
      [una, item, hoursAgo],
    );
  };

  before(async () => {
    una = await t.createUser({ username: 'poster_una' });
  });

  beforeEach(async () => {
    await t.sql(`delete from user_media where user_id = $1`, [una]);
    await t.sql(`delete from watchlist where user_id = $1`, [una]);
  });

  it('names a poster-less title somebody just imported onto a local match', async () => {
    const seed = await film();
    await imported(seed);
    assert.ok((await thin()).includes(seed));
  });

  it('leaves alone a title that already has a poster', async () => {
    const fine = await film({ poster: '/has.jpg' });
    await imported(fine);
    assert.equal((await thin()).includes(fine), false);
  });

  it('asks about a poster-less title once: a fetch after the import takes it off the list', async () => {
    const stub = await film({ fetched: new Date(Date.now() - 60_000).toISOString() });
    await imported(stub);
    assert.ok((await thin()).includes(stub), 'a stub from the provider search is still due');

    // What `enrichOne`'s write does to the row when TMDB has no poster either.
    await t.sql(`update media_items set fetched_at = now() where id = $1`, [stub]);
    assert.equal((await thin()).includes(stub), false, 'and one detail call settles it');
  });

  it('stops asking three hours after the import, so a title TMDB lost is not retried for ever', async () => {
    const old = await film();
    await imported(old, { hoursAgo: 4 });
    assert.equal((await thin()).includes(old), false);
  });

  it('does not name a native log, which came from a title page that enriches itself', async () => {
    const native = await film();
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, source) values ($1, $2, 'loved', 'in_app')`,
      [una, native],
    );
    assert.equal((await thin()).includes(native), false);
  });

  it('names a poster-less watchlist title the import just added', async () => {
    const wanted = await film();
    await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [
      una,
      wanted,
    ]);
    assert.ok((await thin()).includes(wanted));
  });

  it('is bounded, however large the import', async () => {
    for (let i = 0; i < 30; i += 1) await imported(await film());
    const { rows } = await t.sql(`select cardinality(_import_thin_titles(25)) as n`);
    assert.equal(rows[0].n, 25);
    const { rows: capped } = await t.sql(`select cardinality(_import_thin_titles(5000)) as n`);
    assert.ok(capped[0].n <= 100, 'no caller can ask for more than one adapter batch');
  });

  it('does nothing and raises nothing on a project with no function URL, key or pg_net', async () => {
    await imported(await film());
    const { rows } = await t.sql(`select _import_enrich_nudge() as r`);
    assert.equal(rows[0].r.status, 'unconfigured');
  });

  it('is idle when nothing is due', async () => {
    await t.sql(`delete from user_media`);
    await t.sql(`delete from watchlist`);
    const { rows } = await t.sql(`select _import_enrich_nudge() as r`);
    assert.equal(rows[0].r.status, 'idle');
  });

  it('is not callable by a signed-in person', async () => {
    const error = await t.asUser(una, () => t.errorFrom(`select _import_enrich_nudge()`));
    assert.ok(error, 'the nudge is the tick’s, not a client’s');
  });
});
