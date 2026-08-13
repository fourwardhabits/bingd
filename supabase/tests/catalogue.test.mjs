import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SEED = '20260813002500_seed_catalogue.sql';

/**
 * The seed catalogue.
 *
 * Two properties are worth testing and the rest is data. The first is that the seed
 * actually arrives through the migration path, since that is the whole argument for
 * shipping it as a migration rather than a script someone has to remember. The second is
 * that applying it twice changes nothing: the next refresh is a *new* generated file
 * over the same titles, so its upserts have to correct rows instead of failing on a
 * unique index or doubling the catalogue.
 */
describe('seed catalogue', () => {
  let t;

  before(async () => {
    t = await createTestDb();
  });

  after(async () => t.close());

  const count = async (where = 'true', params) => {
    const { rows } = await t.sql(`select count(*)::int as n from media_items where ${where}`, params);
    return rows[0].n;
  };

  it('is present, with films, series and their seasons', async () => {
    assert.ok((await count(`kind = 'movie'`)) > 300, 'films');
    assert.ok((await count(`kind = 'series'`)) > 100, 'series');
    assert.ok((await count(`kind = 'season'`)) > 500, 'seasons');
  });

  it('marks every seeded row as Wikidata, so the TMDB retention window skips it', async () => {
    // PRD §19 gives TMDB-derived metadata six months. These rows are CC0 and expire
    // never, and the only thing standing between those two facts is this column.
    assert.equal(await count(`provenance = 'tmdb'`), 0);
    assert.ok((await count(`provenance = 'wikidata'`)) > 900);
  });

  it('gives every film and series a Wikidata id and a TMDB id', async () => {
    // The Wikidata id is what a refresh matches on. The TMDB id is what the adapter will
    // enrich through, which is the difference between this catalogue being a bridge and
    // being a thing to throw away.
    assert.equal(await count(`kind in ('movie', 'series') and wikidata_qid is null`), 0);
    assert.equal(await count(`kind in ('movie', 'series') and tmdb_id is null`), 0);
  });

  it('leaves every season attached to a series', async () => {
    const { rows } = await t.sql(`
      select count(*)::int as orphans
        from media_items season
        left join media_items parent on parent.id = season.parent_id
       where season.kind = 'season'
         and (parent.id is null or parent.kind <> 'series')
    `);
    assert.equal(rows[0].orphans, 0);
  });

  it('has no artwork and no popularity, which is the trade rather than an omission', async () => {
    // Wikidata has no poster to give, because a poster is not a free work. The client has
    // to look right without one, and this is where that assumption breaks first if
    // something starts relying on artwork before a provider is wired up. Popularity is
    // null because PRD §19 defines it as the provider's score, and sitelink count — which
    // is what chose these titles — is not that.
    assert.equal(await count(`provenance = 'wikidata' and poster_path is not null`), 0);
    assert.equal(await count(`provenance = 'wikidata' and popularity is not null`), 0);
  });

  it('leaves the fixture range alone, so a test cannot collide with a real title', async () => {
    // The harness negates the tmdb ids tests hand it, for exactly this reason: before it
    // did, a fixture asking for 1018 failed on a unique index because a real film had
    // that id. A test should not break over what someone else's catalogue contains.
    assert.equal(await count('tmdb_id < 0'), 0);
  });

  /**
   * The property that makes a refresh safe. Re-running the generated file must be a
   * no-op on counts and must not raise: a multi-row upsert whose rows collide with each
   * other is refused by Postgres, and a mistaken conflict target would double the
   * catalogue instead of correcting it.
   */
  it('applies twice with no duplicates and no error', async () => {
    const before = {
      total: await count(),
      movies: await count(`kind = 'movie'`),
      seasons: await count(`kind = 'season'`),
    };

    const sql = await readFile(join(migrationsDir, SEED), 'utf8');
    await t.db.exec(sql);

    assert.equal(await count(), before.total);
    assert.equal(await count(`kind = 'movie'`), before.movies);
    assert.equal(await count(`kind = 'season'`), before.seasons);
  });

  it('refreshes a title in place rather than inserting beside it', async () => {
    const { rows: original } = await t.sql(`
      select id, tmdb_id, title from media_items
       where kind = 'movie' and wikidata_qid is not null
       order by title limit 1
    `);
    const film = original[0];

    await t.sql(`update media_items set title = 'Stale Title' where id = $1`, [film.id]);
    await t.db.exec(await readFile(join(migrationsDir, SEED), 'utf8'));

    const { rows: after } = await t.sql(`select id, title from media_items where id = $1`, [
      film.id,
    ]);
    assert.equal(after[0].title, film.title, 'the same row must be corrected');
    assert.equal(await count('tmdb_id = $1 and kind = $2', [film.tmdb_id, 'movie']), 1);
  });
});
