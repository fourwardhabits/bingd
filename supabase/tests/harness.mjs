import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

/**
 * Supabase provides these; PGlite does not. The shim is deliberately thin, so a
 * test exercises the real migration files rather than a parallel schema.
 *
 * Two known gaps, both harmless:
 *
 *   citext  — unavailable in PGlite, shimmed as plain text. Case-insensitive
 *             uniqueness therefore is not exercised. It has no practical
 *             consequence here because profiles.username_format already forbids
 *             uppercase from being stored at all, so two rows cannot differ by
 *             case alone regardless of the column type.
 *
 *   RLS     — policies are created and their expressions are compiled, but the
 *             owner role bypasses row security. Policy behaviour is tested by
 *             calling can_view_profile directly and by switching to a
 *             non-owning role where it matters.
 */
const SHIM = `
  create schema if not exists auth;
  create table auth.users (id uuid primary key);
  create domain citext as text;

  -- Mirrors Supabase's auth.uid(), reading a value the tests can set.
  create or replace function auth.uid() returns uuid
  language sql stable as $shim$
    select nullif(current_setting('test.user_id', true), '')::uuid;
  $shim$;
`;

export async function createTestDb() {
  const db = await PGlite.create();
  await db.exec(SHIM);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    let sql = await readFile(join(migrationsDir, file), 'utf8');
    // The shim already defines citext as a domain.
    sql = sql.replace(/create extension if not exists citext;/g, '');
    try {
      await db.exec(sql);
    } catch (e) {
      throw new Error(`Migration ${file} failed: ${e.message}`);
    }
  }

  return {
    db,
    appliedMigrations: files,

    async sql(query, params) {
      return params ? db.query(query, params) : db.query(query);
    },

    async exec(query) {
      return db.exec(query);
    },

    /** Everything after this runs as the given profile, via auth.uid(). */
    async actAs(userId) {
      await db.query(`select set_config('test.user_id', $1, false)`, [userId ?? '']);
    },

    /** Creates an auth user and a profile, and returns the id. */
    async createUser({ username, visibility = 'public', dob = '1990-01-01' }) {
      const { rows } = await db.query(`select gen_random_uuid() as id`);
      const id = rows[0].id;
      await db.query(`insert into auth.users (id) values ($1)`, [id]);
      await db.query(
        `insert into profiles (id, username, display_name, visibility, date_of_birth)
         values ($1, $2, $3, $4::profile_visibility, $5)`,
        [id, username, username, visibility, dob],
      );
      return id;
    },

    /** Creates a movie and returns its id. */
    async createMovie(title, tmdbId) {
      const { rows } = await db.query(
        `insert into media_items (kind, tmdb_id, title)
         values ('movie', $1, $2) returning id`,
        [tmdbId, title],
      );
      return rows[0].id;
    },

    async createSeries(title, tmdbId) {
      const { rows } = await db.query(
        `insert into media_items (kind, tmdb_id, title)
         values ('series', $1, $2) returning id`,
        [tmdbId, title],
      );
      return rows[0].id;
    },

    async createSeason(parentId, seasonNumber, title) {
      const { rows } = await db.query(
        `insert into media_items (kind, parent_id, season_number, title)
         values ('season', $1, $2, $3) returning id`,
        [parentId, seasonNumber, title],
      );
      return rows[0].id;
    },

    /** Reads the ranking as an ordered list, for assertions. */
    async ranking(userId, category = 'movies') {
      const { rows } = await db.query(
        `select r.position, r.bucket, m.title
           from rankings r join media_items m on m.id = r.media_item_id
          where r.user_id = $1 and r.category = $2::ranking_category
          order by r.position`,
        [userId, category],
      );
      return rows;
    },

    /** Raises if any of I1, I2, or I3 is violated. */
    async assertValid(userId, category = 'movies') {
      await db.query(`select assert_ranking_valid($1, $2::ranking_category)`, [
        userId,
        category,
      ]);
    },

    /**
     * Runs a full insertion to completion, answering each comparison with the
     * supplied decision function, and returns the final position plus the number
     * of comparisons it took.
     */
    async rankToCompletion(mediaItemId, bucket, decide) {
      let result = await one(db, `select rank_start($1, $2::taste_bucket) as r`, [
        mediaItemId,
        bucket,
      ]);
      let comparisons = 0;

      while (!result.done) {
        const winner = await decide(result.pivot, mediaItemId);
        comparisons += 1;
        result = await one(db, `select rank_answer($1, $2) as r`, [result.session_id, winner]);
        if (comparisons > 64) throw new Error('insertion did not converge');
      }

      return { position: result.position, comparisons, adjustable: result.adjustable };
    },

    async close() {
      await db.close();
    },
  };
}

async function one(db, query, params) {
  const { rows } = await db.query(query, params);
  return rows[0].r;
}

export { one };
