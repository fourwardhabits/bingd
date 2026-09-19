/**
 * `export.sql` against the real schema: every migration applied in PGlite, a small cohort
 * seeded, and the export run inside a READ ONLY transaction, so a write would fail the test.
 *
 *   node --test eval/predicted-score/export.test.mjs
 *
 * Not part of `test:db` (whose glob is `supabase/tests/*.test.mjs`), so it runs by hand. Run
 * it alone: parallel PGlite runs exhaust memory. No network and no production. The database
 * lives in memory and is gone when the process ends.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestDb } from '../../supabase/tests/harness.mjs';
import { validateSnapshot } from './snapshot.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SALT = 'a-test-salt-that-is-long-enough-000';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const exportSql = async ({ salt = SALT, stars = false } = {}) => {
  const text = await readFile(join(here, 'export.sql'), 'utf8');
  return text
    .replace("'REPLACE_WITH_A_RANDOM_SALT_OF_24_OR_MORE_CHARACTERS'::text", `'${salt}'::text`)
    .replace('false as include_letterboxd_stars', `${stars} as include_letterboxd_stars`);
};

async function readOnly(t, sql) {
  await t.exec('begin transaction read only');
  try {
    const { rows } = await t.sql(sql);
    return rows;
  } finally {
    await t.exec('rollback');
  }
}

async function seed() {
  const t = await createTestDb();
  const ada = await t.createUser({ username: 'ada_export' });
  const ben = await t.createUser({ username: 'ben_export', visibility: 'private' });
  const cy = await t.createUser({ username: 'cy_export' });
  const quiet = await t.createUser({ username: 'quiet_export' }); // ranks nothing
  await t.sql(`update profiles set status = 'suspended' where id = $1`, [cy]);

  const heat = await t.createMovie('Heat Export Fixture', 900001);
  const ronin = await t.createMovie('Ronin Export Fixture', 900002);
  const thief = await t.createMovie('Thief Export Fixture', 900003);
  const show = await t.createSeries('Show Export Fixture', 900004);
  const s1 = await t.createSeason(show, 1, 'Season 1');
  await t.sql(
    `update media_items set genres = '{Crime,Thriller}', original_language = 'en',
            release_date = '1995-12-15', popularity = 42.5 where id = $1`,
    [heat],
  );

  const at = (h) =>
    `2026-09-01T00:00:00Z`.replace('00:00:00', `${String(h).padStart(2, '0')}:00:00`);
  const place = async (user, item, category, bucket, position, hour) => {
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, $3::taste_bucket)`,
      [user, item, bucket],
    );
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position, created_at)
       values ($1, $2, $3::ranking_category, $4::taste_bucket, $5, $6::timestamptz)`,
      [user, item, category, bucket, position, at(hour)],
    );
  };
  await place(ada, heat, 'movies', 'loved', 1, 1);
  await place(ada, ronin, 'movies', 'loved', 2, 10);
  await place(ada, thief, 'movies', 'fine', 3, 20);
  await place(ada, s1, 'tv_seasons', 'loved', 1, 2);
  await place(ben, heat, 'movies', 'fine', 1, 3);
  await place(cy, ronin, 'movies', 'not_for_me', 1, 4);

  // Comparisons for Ada's Ronin: one long before its created_at (so it was re-placed), one in
  // its session window, one after it.
  const cmp = (winner, loser, hour) =>
    t.sql(
      `insert into comparisons (user_id, winner_id, loser_id, created_at) values ($1, $2, $3, $4::timestamptz)`,
      [ada, winner, loser, hour < 0 ? '2026-08-20T00:00:00Z' : at(hour)],
    );
  await cmp(heat, ronin, -1);
  await cmp(heat, ronin, 9);
  await cmp(ronin, thief, 19);

  await t.sql(
    `insert into follows (follower_id, followee_id, state, approved_at) values ($1, $2, 'approved', now())`,
    [ada, ben],
  );
  await t.sql(
    `insert into follows (follower_id, followee_id, state) values ($1, $2, 'pending')`,
    [ben, ada],
  );
  await t.sql(
    `insert into follows (follower_id, followee_id, state, approved_at) values ($1, $2, 'approved', now())`,
    [ada, quiet],
  );
  await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [cy, ada]);

  await t.sql(
    `insert into media_cache (media_item_id, facet, payload, expires_at)
     values ($1, 'similar', $2::jsonb, now() + interval '1 day')`,
    [heat, JSON.stringify({ ids: [ronin, 'not-a-uuid', thief.toUpperCase()] })],
  );

  await t.sql(
    `insert into imported_titles (user_id, media_item_id, letterboxd_uri, source_name, source_year, rating)
     values ($1, $2, 'https://boxd.it/test1', 'Thief', 1981, 3.5)`,
    [ada, thief],
  );

  return { t };
}

test('export.sql against every migration: read-only, pseudonymised, and valid for the harness', async () => {
  const { t } = await seed();

  // Refuses to run with the placeholder salt.
  await assert.rejects(
    t.sql(await exportSql({ salt: 'REPLACE_WITH_A_RANDOM_SALT_OF_24_OR_MORE_CHARACTERS' })),
    /SALT NOT SET/,
  );
  await assert.rejects(t.sql(await exportSql({ salt: 'too-short' })), /SALT NOT SET/);

  const rows = await readOnly(t, await exportSql());
  assert.equal(rows.length, 1);
  const document = rows[0].snapshot;
  const text = JSON.stringify(document);

  // No raw id and no name of anything survives.
  assert.doesNotMatch(text, UUID);
  for (const word of ['ada_export', 'ben_export', 'Heat Export', 'Ronin', 'boxd.it', 'Thief']) {
    assert.ok(!text.includes(word), `export leaked "${word}"`);
  }

  const snapshot = validateSnapshot(document);
  assert.equal(snapshot.users.length, 3, 'only accounts with a ranking');
  assert.deepEqual(snapshot.users.map((u) => u.status).sort(), [
    'active',
    'active',
    'suspended',
  ]);
  assert.deepEqual(snapshot.users.map((u) => u.visibility).sort(), [
    'private',
    'public',
    'public',
  ]);
  assert.equal(snapshot.users.filter((u) => u.imported_titles === 1).length, 1);
  assert.equal(snapshot.rankings.length, 6);
  assert.equal(snapshot.rankings.filter((r) => r.c === 'tv_seasons').length, 1);
  assert.equal(snapshot.follows.length, 1, 'approved follows between rankers only');
  assert.equal(snapshot.blocks.length, 1);
  assert.equal(snapshot.includes_letterboxd_stars, false);
  assert.deepEqual(snapshot.stars, []);

  // Salted keys are consistent across sections.
  const adaKey = snapshot.rankings.find((r) => r.c === 'tv_seasons').u;
  const adaMovies = snapshot.rankings
    .filter((r) => r.u === adaKey && r.c === 'movies')
    .sort((a, b) => a.p - b.p);
  assert.equal(adaMovies.length, 3);
  const [heatRow, roninRow, thiefRow] = adaMovies;

  // Comparison counts: Ronin had one comparison long before, one in its window, one after.
  assert.deepEqual([roninRow.cmp_earlier, roninRow.cmp_window, roninRow.cmp_later], [1, 1, 1]);
  // Heat is the other side of the early and the in-window comparison: both predate or follow
  // its own created_at, and neither falls in its window.
  assert.deepEqual([heatRow.cmp_earlier, heatRow.cmp_window, heatRow.cmp_later], [1, 0, 1]);
  // The earliest comparison dates a re-placed title's first presence in the list.
  assert.equal(roninRow.cmp_first, Date.parse('2026-08-20T00:00:00Z') * 1000);
  assert.equal(thiefRow.cmp_window, 1);
  assert.equal(thiefRow.imported, true);
  assert.equal(heatRow.imported, false);

  // Media carries only the facts the models read, and the season points at its series.
  const media = new Map(snapshot.media.map((m) => [m.m, m]));
  assert.deepEqual(media.get(heatRow.m), {
    m: heatRow.m,
    kind: 'movie',
    parent: null,
    season: null,
    genres: ['Crime', 'Thriller'],
    lang: 'en',
    year: 1995,
    popularity: 42.5,
  });
  const season = media.get(snapshot.rankings.find((r) => r.c === 'tv_seasons').m);
  assert.equal(season.kind, 'season');
  assert.equal(media.get(season.parent).kind, 'series');

  // The similar list is pseudonymised with the same salt, skips a non-uuid, and folds case.
  const similar = snapshot.similar.find((s) => s.m === heatRow.m);
  assert.deepEqual(similar.ids, [roninRow.m, thiefRow.m]);

  // Stars appear only when asked for, and only the owner's own.
  const withStars = validateSnapshot(
    (await readOnly(t, await exportSql({ stars: true })))[0].snapshot,
  );
  assert.equal(withStars.includes_letterboxd_stars, true);
  assert.deepEqual(
    withStars.stars.map((s) => [s.u, s.m, s.rating]),
    [[adaKey, thiefRow.m, 3.5]],
  );

  // The same salt gives the same keys; a different salt gives different ones.
  const again = (await readOnly(t, await exportSql()))[0].snapshot;
  assert.deepEqual(again.users.map((u) => u.u).sort(), snapshot.users.map((u) => u.u).sort());
  const other = (
    await readOnly(t, await exportSql({ salt: 'a-completely-different-salt-0000' }))
  )[0].snapshot;
  assert.equal(other.users.filter((u) => snapshot.users.some((s) => s.u === u.u)).length, 0);
});
