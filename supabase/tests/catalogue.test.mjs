import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Found rather than named, because the generator writes a new timestamped file on every
 * refresh — naming one here would mean this file silently tested a migration that is no
 * longer the current seed. More than one is an error: two seed migrations in a tree means
 * an old one was left behind, and the tests would be asserting against the wrong catalogue.
 */
const seedMigration = async () => {
  const { readdir } = await import('node:fs/promises');
  const found = (await readdir(migrationsDir)).filter((f) => f.endsWith('_seed_catalogue.sql'));
  assert.equal(found.length, 1, `expected exactly one seed migration, found ${found.join(', ')}`);
  return readFile(join(migrationsDir, found[0]), 'utf8');
};

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

  /**
   * Seasons are the rankable television unit under PRD §10, so an unidentifiable season
   * is most of the TV half of the product. They were shipped with neither id at first —
   * 1,432 of 2,010 rows that nothing outside this catalogue could ever match — while the
   * documentation claimed every row carried its tmdb_id.
   */
  it('gives every season a Wikidata id, since it cannot have a TMDB one', async () => {
    assert.equal(await count(`kind = 'season' and wikidata_qid is null`), 0);
    // Wikidata has no TMDB season property, so the honest state is null here and a match
    // through the parent series plus the season number.
    assert.equal(await count(`kind = 'season' and tmdb_id is not null`), 0);
  });

  it('has plausible runtimes, in minutes', async () => {
    // P2047 is a quantity with a unit and some titles record it in seconds: Oppenheimer
    // arrived as 10809, which shipped a three-hour film as a seven-day one. The unit is
    // read now, and anything outside a plausible range is dropped rather than shown.
    assert.equal(await count('runtime_minutes is not null and runtime_minutes not between 1 and 600'), 0);

    const { rows } = await t.sql(
      `select runtime_minutes from media_items where title = 'Oppenheimer' and kind = 'movie'`,
    );
    if (rows[0]) assert.equal(rows[0].runtime_minutes, 180);
  });

  it('stores a release date only where Wikidata knows the day', async () => {
    // A year-precision value renders as 1 January, indistinguishable from a real date
    // unless the precision is asked for. 86 titles claimed a 1 January release before it
    // was, and taking the earliest value made it worse rather than better.
    const janFirst = await count(`provenance = 'wikidata' and extract(month from release_date) = 1
                                    and extract(day from release_date) = 1`);
    const dated = await count(`provenance = 'wikidata' and release_date is not null`);
    assert.ok(
      janFirst < dated * 0.02,
      `${janFirst} of ${dated} dated rows fall on 1 January, which suggests year-precision values are being stored as dates`,
    );
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

    await t.db.exec(await seedMigration());

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
    await t.db.exec(await seedMigration());

    const { rows: after } = await t.sql(`select id, title from media_items where id = $1`, [
      film.id,
    ]);
    assert.equal(after[0].title, film.title, 'the same row must be corrected');
    assert.equal(await count('tmdb_id = $1 and kind = $2', [film.tmdb_id, 'movie']), 1);
  });

  /**
   * The refresh case that actually happens. Wikidata corrects a TMDB id, so the next
   * generated file carries the same Q-number with a different tmdb_id. Keyed on
   * (kind, tmdb_id), that row conflicted on the *other* unique index instead and aborted
   * the transaction — which on a hosted push means the whole migration rolls back.
   */
  it('absorbs a corrected TMDB id instead of aborting the migration', async () => {
    const { rows } = await t.sql(`
      select id, tmdb_id, wikidata_qid from media_items
       where kind = 'movie' and wikidata_qid is not null
       order by title limit 1
    `);
    const film = rows[0];

    await t.sql(`update media_items set tmdb_id = 987654321 where id = $1`, [film.id]);
    await t.db.exec(await seedMigration());

    const { rows: after } = await t.sql(`select tmdb_id from media_items where id = $1`, [film.id]);
    assert.equal(after[0].tmdb_id, film.tmdb_id, 'the seeded id must win, on the same row');
    assert.equal(await count('wikidata_qid = $1', [film.wikidata_qid]), 1);
  });

  /**
   * The licence direction the provenance column exists to protect, reached from the side
   * nobody was watching. Once the adapter enriches a row it owns it: the poster, synopsis
   * and score are the provider's and PRD §19's six-month window applies. A refresh that
   * reset provenance to 'wikidata' while leaving that data in place would relabel TMDB
   * content as CC0 and exempt from expiry.
   */
  it('leaves a row the adapter has enriched alone', async () => {
    const { rows } = await t.sql(`
      select id from media_items where kind = 'movie' and wikidata_qid is not null
       order by title offset 1 limit 1
    `);
    const id = rows[0].id;

    await t.sql(
      `update media_items
          set provenance = 'tmdb', poster_path = '/enriched.jpg', overview = 'from the provider',
              title = 'Provider Title'
        where id = $1`,
      [id],
    );
    await t.db.exec(await seedMigration());

    const { rows: after } = await t.sql(
      `select provenance, poster_path, title from media_items where id = $1`,
      [id],
    );
    assert.equal(after[0].provenance, 'tmdb', 'a refresh must not relabel provider data as CC0');
    assert.equal(after[0].poster_path, '/enriched.jpg');
    assert.equal(after[0].title, 'Provider Title', 'and must not overwrite what it does not own');
  });

  /**
   * The column is only worth having if something reads it. media_refresh_due offers rows
   * to the TMDB refresh job, and until it filtered on provenance it offered these ones —
   * making the column written by the seed and read by nobody, while the documentation said
   * a retention job could now tell the two apart.
   */
  it('keeps CC0 rows out of the TMDB refresh queue', async () => {
    const user = await t.createUser({ username: 'refresher' });
    const { rows } = await t.sql(
      `select id from media_items where provenance = 'wikidata' and kind = 'movie' limit 1`,
    );
    const seeded = rows[0].id;

    // Referenced by a collection and long past the window: everything the view asks for
    // except being TMDB's.
    await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [user, seeded]);
    await t.sql(`update media_items set fetched_at = now() - interval '2 years' where id = $1`, [
      seeded,
    ]);

    const due = async () => {
      const { rows: r } = await t.sql(
        `select count(*)::int as n from media_refresh_due where id = $1`,
        [seeded],
      );
      return r[0].n;
    };

    assert.equal(await due(), 0, 'a CC0 row has no expiry and must never be offered for refresh');

    await t.sql(`update media_items set provenance = 'tmdb' where id = $1`, [seeded]);
    assert.equal(await due(), 1, 'and the view must still find a TMDB row, or it tests nothing');
  });
});
