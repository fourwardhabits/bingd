/**
 * `export.sql` against the real schema: every migration applied in PGlite, a small cohort
 * seeded with everything an export must NOT carry (usernames, display names, emails, bios,
 * notes, watch dates, exact times), and the export run inside a READ ONLY transaction, so a
 * write would fail the test.
 *
 *   node --test eval/rec-v2-replay/export.test.mjs
 *
 * Not part of `test:db` (whose glob is `supabase/tests/*.test.mjs`), so it runs by hand, like
 * `eval/predicted-score/export.test.mjs`. No network and no production: the database lives in
 * memory and is gone when the process ends.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestDb } from '../../supabase/tests/harness.mjs';
import { ALLOWED_KEYS, validateExport } from './format.ts';

const here = dirname(fileURLToPath(import.meta.url));
const exportSql = () => readFile(join(here, 'export.sql'), 'utf8');

async function readOnly(t, sql) {
  await t.exec('begin transaction read only');
  try {
    const { rows } = await t.sql(sql);
    return rows;
  } finally {
    await t.exec('rollback');
  }
}

/**
 * Columns that identify a person or say what they wrote, by name. None may appear in the
 * export's SQL outside its comments: not selected, not even filtered on. (`created_at` is
 * checked separately: it may be read only as a day, or as an order.)
 */
const IDENTIFYING = [
  'username',
  'display_name',
  'email',
  'avatar_path',
  'bio',
  'link_instagram',
  'link_tiktok',
  'link_youtube',
  'link_x',
  'link_website',
  'date_of_birth',
  'invited_by',
  'note',
  'note_visibility',
  'watched_on',
  'body',
  'comment',
  'comments',
  'reaction',
  'reactions',
  'review',
  'reviews',
  'overview',
  'original_title',
  'imdb_id',
  'backdrop_path',
  'profile_private',
];

const stripComments = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('export.sql selects no identifying column, and reads created_at only as a day or an order', async () => {
  const code = stripComments(await exportSql());
  for (const column of IDENTIFYING) {
    assert.doesNotMatch(
      code,
      new RegExp(`\\b${column}\\b`, 'i'),
      `export.sql mentions ${column}`,
    );
  }
  // Every use of created_at is either the day cast or an ordering inside a window.
  const uses = code.match(/[^\n]*created_at[^\n]*/g) ?? [];
  assert.ok(uses.length > 0);
  for (const line of uses) {
    assert.match(
      line,
      /\(r\.created_at at time zone 'UTC'\)::date|order by r\.created_at/,
      `created_at read some other way: ${line.trim()}`,
    );
  }
  // And the JSON it builds has exactly the allowlisted keys, section by section.
  for (const [section, keys] of Object.entries(ALLOWED_KEYS)) {
    if (section === 'top') continue;
    for (const key of keys)
      assert.match(code, new RegExp(`'${key}'`), `${section}.${key} is built`);
  }
});

async function seed() {
  const t = await createTestDb();
  const users = [];
  for (const [name, visibility] of [
    ['replay_ada', 'public'],
    ['replay_ben', 'private'],
    ['replay_cy', 'public'],
    ['replay_dee', 'public'],
  ]) {
    users.push(await t.createUser({ username: name, visibility }));
  }
  const [ada, ben, cy, dee] = users;
  const gone = await t.createUser({ username: 'replay_gone' });
  await t.sql(`update profiles set status = 'suspended' where id = $1`, [gone]);
  await t.sql(
    `update profiles set display_name = 'Ada Lovelace Replay', bio = 'BIO-SECRET' where id = $1`,
    [ada],
  );
  await t.sql(`update auth.users set email = 'ada-replay@example.invalid' where id = $1`, [
    ada,
  ]);

  const films = [];
  for (let i = 0; i < 6; i += 1)
    films.push(await t.createMovie(`Replay Film Fixture ${i}`, 910000 + i));
  const show = await t.createSeries('Replay Show Fixture', 910100);
  const s1 = await t.createSeason(show, 1, 'Season 1');
  for (const [i, id] of films.entries()) {
    await t.sql(
      `update media_items set genres = '{Drama}', original_language = $2, release_date = '2010-06-01',
              popularity = $3, poster_path = '/p.jpg' where id = $1`,
      [id, i % 2 ? 'ja' : 'en', 10 + i],
    );
  }
  await t.sql(
    `update media_items set poster_path = '/s.jpg', release_date = '2019-01-01' where id = $1`,
    [show],
  );

  const place = async (user, item, category, bucket, position, at) => {
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, note, watched_on)
       values ($1, $2, $3::taste_bucket, 'NOTE-SECRET', '2026-01-02')`,
      [user, item, bucket],
    );
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position, created_at)
       values ($1, $2, $3::ranking_category, $4::taste_bucket, $5, $6::timestamptz)`,
      [user, item, category, bucket, position, at],
    );
  };
  await place(ada, films[0], 'movies', 'loved', 1, '2026-09-01T10:11:12Z');
  await place(ada, films[1], 'movies', 'loved', 2, '2026-09-01T13:14:15Z');
  await place(ada, films[2], 'movies', 'fine', 3, '2026-09-03T08:00:00Z');
  await place(ada, s1, 'tv_seasons', 'loved', 1, '2026-09-02T09:00:00Z');
  await place(ada, show, 'tv_shows', 'loved', 1, '2026-09-02T09:30:00Z');
  await place(ben, films[0], 'movies', 'fine', 1, '2026-09-05T00:00:00Z');
  await place(cy, films[1], 'movies', 'not_for_me', 1, '2026-09-06T00:00:00Z');
  await place(dee, films[3], 'movies', 'loved', 1, '2026-09-07T00:00:00Z');
  await place(gone, films[4], 'movies', 'loved', 1, '2026-09-08T00:00:00Z');
  // Logged, not ranked, with a note and a watch date that must not travel.
  await t.sql(
    `insert into user_media (user_id, media_item_id, bucket, note, watched_on)
     values ($1, $2, null, 'LOGGED-NOTE-SECRET', '2026-02-03')`,
    [ada, films[5]],
  );

  await t.sql(
    `insert into follows (follower_id, followee_id, state, approved_at) values ($1, $2, 'approved', now())`,
    [ada, ben],
  );
  await t.sql(
    `insert into follows (follower_id, followee_id, state) values ($1, $2, 'pending')`,
    [ben, ada],
  );
  await t.sql(
    `insert into media_cache (media_item_id, facet, payload, expires_at)
     values ($1, 'similar', $2::jsonb, now() + interval '1 day')`,
    [films[0], JSON.stringify({ ids: [films[3], 'not-a-uuid', films[4].toUpperCase()] })],
  );
  await t.sql(
    `insert into provider_list_cache (list_key, payload, expires_at)
     values ('trending.movie.week', $1::jsonb, now() + interval '1 day')`,
    [JSON.stringify({ ids: [films[5], films[2]] })],
  );
  return { t, users, gone, films, show, s1 };
}

test('export.sql against every migration: read-only, pseudonymous, and valid for the replay', async () => {
  const { t, users, gone, films, show, s1 } = await seed();
  const rows = await readOnly(t, await exportSql());
  assert.equal(rows.length, 1);
  const document = rows[0].replay;
  const text = JSON.stringify(document);

  // Nothing that identifies a person survives: no profile id, name, email, bio, note.
  for (const id of [...users, gone]) assert.ok(!text.includes(id), 'a profile id leaked');
  for (const word of [
    'replay_ada',
    'replay_ben',
    'Ada Lovelace',
    'ada-replay@',
    'BIO-SECRET',
    'NOTE-SECRET',
    'Replay Film Fixture',
    'Replay Show Fixture',
    '2026-01-02',
    '2026-02-03',
  ]) {
    assert.ok(!text.includes(word), `export leaked "${word}"`);
  }
  // No timestamp finer than a day, in any form: no ISO time, no epoch seconds or micros.
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:/);
  assert.doesNotMatch(text, /\b1[6-9]\d{8,}\b/);

  const doc = validateExport(document);
  assert.equal(doc.users.length, 4, 'active rankers only');
  assert.equal(doc.rankings.length, 8);
  assert.deepEqual([...new Set(doc.users.map((u) => u.u))].sort(), [1, 2, 3, 4]);
  assert.equal(doc.users.filter((u) => u.visibility === 'private').length, 1);
  assert.equal(doc.follows.length, 1, 'approved follows between exported accounts only');

  // Ada's five rankings, in order, by day and ordinal only.
  const adaKey = doc.rankings.find((r) => r.c === 'tv_shows').u;
  const ada = doc.rankings.filter((r) => r.u === adaKey).sort((a, b) => a.seq - b.seq);
  assert.deepEqual(
    ada.map((r) => r.m),
    [films[0], films[1], s1, show, films[2]],
  );
  const day = (iso) => Math.floor(Date.parse(iso) / 86_400_000);
  assert.deepEqual(
    ada.map((r) => r.day),
    [
      day('2026-09-01'),
      day('2026-09-01'),
      day('2026-09-02'),
      day('2026-09-02'),
      day('2026-09-03'),
    ],
  );
  assert.deepEqual(doc.logged, [{ u: adaKey, m: films[5], b: null }]);

  // Media carries facts only, the season points at its show, and the catalogue is included.
  const media = new Map(doc.media.map((m) => [m.m, m]));
  assert.equal(media.get(s1).parent, show);
  assert.equal(media.get(films[1]).lang, 'ja');
  assert.equal(media.get(films[1]).year, 2010);
  assert.equal(media.get(films[1]).tile, true);
  assert.ok(
    media.has(films[4]),
    'a catalogue title nobody exported ranks is still a candidate',
  );

  assert.deepEqual(doc.similar.find((s) => s.m === films[0]).ids, [films[3], films[4]]);
  assert.deepEqual(doc.trending, [{ list: 'trending.movie.week', ids: [films[5], films[2]] }]);

  // A user key is random per run: across runs the same account does not keep its key.
  const keyOfAda = (d) => d.rankings.find((r) => r.c === 'tv_shows').u;
  const keys = new Set([keyOfAda(doc)]);
  for (let i = 0; i < 6; i += 1)
    keys.add(keyOfAda(validateExport((await readOnly(t, await exportSql()))[0].replay)));
  assert.ok(keys.size > 1, 'the same key every run: keys are not random per run');
  await t.db.close();
});

test('the checks fail when an identifying column is added to the export', async () => {
  const { t } = await seed();
  const original = await exportSql();
  const leaky = original.replace(
    "jsonb_build_object('u', pu.k, 'visibility', pu.visibility)",
    "jsonb_build_object('u', pu.k, 'visibility', pu.visibility, 'name', (select username from profiles where id = pu.id))",
  );
  assert.notEqual(leaky, original, 'the mutation applied');
  // The static scan refuses the SQL…
  assert.match(stripComments(leaky), /\busername\b/);
  // …and the validator refuses its output, so a leaky export can never be read by run.mjs.
  const rows = await readOnly(t, leaky);
  assert.throws(() => validateExport(rows[0].replay), /keys .* are not exactly/);
  // So does a timestamp.
  const timed = original.replace("'seq', r.seq", "'seq', r.seq, 'at', r.day");
  const timedRows = await readOnly(t, timed);
  assert.throws(() => validateExport(timedRows[0].replay), /keys .* are not exactly/);
  await t.db.close();
});
