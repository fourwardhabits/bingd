import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Season hydration — `season_hydration_due` and what `tmdb_upsert_seasons` preserves.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 *
 * Physical acceptance on 2026-08-30 reported a series showing fewer seasons than it has.
 * The particular show is the provider's own doing — TMDB publishes JUJUTSU KAISEN as a
 * single 59-episode Season 1 under `/tv/95479` and has no Season 2 there — but tracing
 * it found two real defects, and both are repaired by the same act:
 *
 *   * a series' season list was written once and never revisited, so a show that gained
 *     a season after somebody first opened it stayed short of it; and
 *   * every season row on nonprod carried a null `episode_count`, because the deployed
 *     adapter predated the payload `20260820000400` added.
 *
 * The act is one series detail call, whose season list goes through
 * `tmdb_upsert_seasons`. So the properties worth asserting are not about counting: they
 * are about what a *repeat* of that write does and does not do to rows a reader has
 * attached their own data to. A backfill that repairs metadata and detaches a ranking
 * would be a far worse defect than the one it fixed.
 */

let t;
let seq = 96000;

/**
 * A TMDB-provenance series, which `createSeries` does not make — its fixtures are
 * `manual` so that season numbers cannot collide with the seeded catalogue. The view
 * filters on provenance, so a fixture that is not TMDB's would be testing nothing.
 */
const providerSeries = async (title) => {
  const { rows } = await t.sql(
    `insert into media_items (kind, title, tmdb_id, provenance)
     values ('series', $1, $2, 'tmdb') returning id`,
    [title, seq++],
  );
  return rows[0].id;
};

/** The payload shape `seasonsOf` builds from a TMDB series detail. */
const season = (number, over = {}) => ({
  season_number: number,
  tmdb_id: 500000 + number,
  title: number === 0 ? 'Specials' : `Season ${number}`,
  release_date: `20${10 + number}-01-01`,
  overview: null,
  poster_path: null,
  episode_count: 10 + number,
  ...over,
});

const upsert = (parentId, seasons) =>
  t.sql(`select * from tmdb_upsert_seasons($1, $2::jsonb)`, [parentId, JSON.stringify(seasons)]);

const seasonsUnder = async (parentId) => {
  const { rows } = await t.sql(
    `select id, season_number, title, episode_count, release_date
       from media_items
      where parent_id = $1 and kind = 'season'
      order by season_number`,
    [parentId],
  );
  return rows;
};

const isDue = async (id) => {
  const { rows } = await t.sql(`select count(*)::int as n from season_hydration_due where id = $1`, [
    id,
  ]);
  return rows[0].n === 1;
};

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t.close();
});

// ---------------------------------------------------------------------------

describe('season_hydration_due — what the backfill is owed', () => {
  let series;

  beforeEach(async () => {
    series = await providerSeries(`Hydration ${seq}`);
  });

  it('offers a series whose season carries no episode count', async () => {
    await upsert(series, [season(1, { episode_count: null })]);
    assert.equal(await isDue(series), true);
  });

  it('does not offer a series whose seasons all have one', async () => {
    await upsert(series, [season(0), season(1)]);
    assert.equal(await isDue(series), false);
  });

  it('offers a series where only one season of several is short', async () => {
    await upsert(series, [season(0), season(1), season(2, { episode_count: null })]);
    assert.equal(await isDue(series), true);
  });

  it('does not offer a series with no seasons at all', async () => {
    // That is `tmdb_enrich_due`'s question and the season picker's. Answering it here as
    // well would spend a provider request twice on the same row.
    assert.equal(await isDue(series), false);
  });

  it('does not offer a CC0 row, which has no provider to ask', async () => {
    await upsert(series, [season(1, { episode_count: null })]);
    await t.sql(`update media_items set provenance = 'wikidata' where id = $1`, [series]);
    assert.equal(await isDue(series), false);
  });

  it('does not offer a series with no tmdb id, which cannot be looked up', async () => {
    await upsert(series, [season(1, { episode_count: null })]);
    await t.sql(`update media_items set tmdb_id = null where id = $1`, [series]);
    assert.equal(await isDue(series), false);
  });

  it('leaves the view once the counts arrive', async () => {
    await upsert(series, [season(0, { episode_count: null }), season(1, { episode_count: null })]);
    assert.equal(await isDue(series), true);

    await upsert(series, [season(0), season(1)]);
    assert.equal(await isDue(series), false);
  });

  /**
   * Membership is not a proof of progress, and the drain does not pretend it is.
   *
   * Reviews 77 and 77b between them found two rows that stay here however many times
   * the series is hydrated: a season the provider reports as having zero episodes
   * (stored as null by `nullif(count, 0)`), and a season the provider has dropped from
   * its answer, which no later write names at all. So this view never empties, a
   * `remaining` over it could never reach zero, and the drain **walks** it in id order
   * behind a cursor instead — termination is a property of the walk.
   *
   * Asserted here rather than argued, because both earlier attempts at this failed in
   * exactly the direction these two cases point.
   */
  it('keeps offering a series whose provider answer is permanently null', async () => {
    // Zero episodes: an announced season that has not aired. `tmdb_upsert_seasons`
    // stores that as null, and it stays null however often it is re-read.
    await upsert(series, [season(1, { episode_count: 0 })]);
    assert.equal(await isDue(series), true);

    await upsert(series, [season(1, { episode_count: 0 })]);
    assert.equal(
      await isDue(series),
      true,
      'the view cannot be a queue that empties, which is why the drain is a walk',
    );
  });

  it('keeps offering a series whose season the provider has stopped naming', async () => {
    // The JUJUTSU KAISEN shape: two seasons were written, and TMDB now publishes one.
    // The dropped row is never named by a later answer, so nothing it carries moves.
    await upsert(series, [season(1, { episode_count: null }), season(2)]);
    assert.equal(await isDue(series), true);

    await upsert(series, [season(2)]);
    assert.equal(await isDue(series), true);
  });

  it('is ordered by id, which is what makes a cursor walk terminate', async () => {
    // The walk pages on `id` and nothing renumbers it, so a page that comes back short
    // cannot be followed by a full one.
    const others = [];
    for (let i = 0; i < 3; i += 1) {
      const s = await providerSeries(`Ordered ${seq}`);
      await upsert(s, [season(1, { episode_count: null })]);
      others.push(s);
    }

    const { rows } = await t.sql(
      `select id from season_hydration_due where id = any($1::uuid[]) order by id`,
      [others],
    );
    const ids = rows.map((row) => row.id);
    assert.deepEqual(ids, [...ids].sort());

    const { rows: after } = await t.sql(
      `select id from season_hydration_due
        where id = any($1::uuid[]) and id > $2 order by id`,
      [others, ids[0]],
    );
    assert.deepEqual(
      after.map((row) => row.id),
      ids.slice(1),
      'a cursor on id must return the rest of the list and never repeat a page',
    );
  });
});

// ---------------------------------------------------------------------------

describe('re-reading a season list preserves what the reader put there', () => {
  let series;
  let user;

  beforeEach(async () => {
    series = await providerSeries(`Preserved ${seq}`);
    user = await t.createUser({ username: `sh_${seq++}` });
  });

  it('adds a season the provider has published since, and keeps the ones already there', async () => {
    await upsert(series, [season(0), season(1)]);
    const before = await seasonsUnder(series);

    await upsert(series, [season(0), season(1), season(2)]);
    const now = await seasonsUnder(series);

    assert.deepEqual(
      now.map((row) => row.season_number),
      [0, 1, 2],
    );
    // Same rows, not replacements: the ids a ranking points at do not move.
    assert.equal(now[0].id, before[0].id);
    assert.equal(now[1].id, before[1].id);
  });

  it('keeps a ranking, a watch state and a progress attached across the rewrite', async () => {
    await upsert(series, [season(1, { episode_count: null })]);
    const [only] = await seasonsUnder(series);

    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, watched_on, progress)
       values ($1, $2, 'loved', date '2026-03-04', 'completed')`,
      [user, only.id],
    );
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'tv_seasons', 'loved', 1)`,
      [user, only.id],
    );

    await upsert(series, [season(1), season(2)]);

    const { rows: kept } = await t.sql(
      `select um.bucket, um.watched_on, um.progress, r.position
         from user_media um
         join rankings r on r.user_id = um.user_id and r.media_item_id = um.media_item_id
        where um.user_id = $1 and um.media_item_id = $2`,
      [user, only.id],
    );
    assert.equal(kept.length, 1, 'the row the reader ranked must still be the row that exists');
    assert.equal(kept[0].bucket, 'loved');
    assert.equal(new Date(kept[0].watched_on).toISOString().slice(0, 10), '2026-03-04');
    assert.equal(kept[0].progress, 'completed');
    assert.equal(kept[0].position, 1);

    // And the repair itself landed.
    const [repaired] = await seasonsUnder(series);
    assert.equal(repaired.episode_count, 11);
  });

  it('is idempotent, so a backfill that runs twice writes one set of rows', async () => {
    await upsert(series, [season(0), season(1), season(2)]);
    await upsert(series, [season(0), season(1), season(2)]);
    await upsert(series, [season(0), season(1), season(2)]);

    assert.deepEqual(
      (await seasonsUnder(series)).map((row) => row.season_number),
      [0, 1, 2],
    );
  });

  /**
   * The acceptance the founder asked for by name: a partial provider answer must not be
   * able to replace a more complete set. It cannot, and the reason is structural rather
   * than defensive — `tmdb_upsert_seasons` inserts and updates and has no delete in it,
   * so a short payload is a write about the seasons it names and silence about the rest.
   */
  it('cannot shrink a season list, however short the payload is', async () => {
    await upsert(series, [season(0), season(1), season(2), season(3)]);

    await upsert(series, [season(1)]);

    assert.deepEqual(
      (await seasonsUnder(series)).map((row) => row.season_number),
      [0, 1, 2, 3],
    );
  });

  it('cannot blank a count a fuller answer already supplied', async () => {
    // `fromSeasonDetail` — the shape written when one season is enriched through its own
    // route — legitimately carries no count, and the SQL coalesces for exactly this.
    await upsert(series, [season(2)]);
    await upsert(series, [season(2, { episode_count: null, title: null })]);

    const [row] = await seasonsUnder(series);
    assert.equal(row.episode_count, 12);
    assert.equal(row.title, 'Season 2', 'and a null title falls back rather than erasing one');
  });
});
