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
 * One known gap:
 *
 *   citext  — unavailable in PGlite, shimmed as plain text. Case-insensitive
 *             uniqueness therefore is not exercised. It has no practical
 *             consequence here because profiles.username_format already forbids
 *             uppercase from being stored at all, so two rows cannot differ by
 *             case alone regardless of the column type.
 *
 * RLS used to be a second gap, and it was the expensive one: every query ran as
 * the table owner, and **an owner bypasses row security**, so no policy was ever
 * evaluated. The suite could pass with the policies deleted. An independent
 * review found four holes in exactly that blind spot on 2026-08-13.
 *
 * The fix is to stop being the owner. The three Supabase roles are created here
 * and `asRole` switches into them, at which point Postgres enforces policies
 * normally. Nothing about PGlite prevented this.
 *
 * Two details make the simulation faithful rather than approximate:
 *
 *   - `auth.uid()` reads `request.jwt.claims`, which is what the real one does.
 *     The previous shim invented a `test.user_id` setting, so tests agreed with
 *     the harness instead of with production.
 *
 *   - Default privileges grant table and function access to `anon` and
 *     `authenticated`, because Supabase does. Copying that matters most for what
 *     it *reveals*: `EXECUTE` reaching those roles by default is precisely how
 *     `resolve_capabilities` became callable for arbitrary users, so a lockdown
 *     has to be written explicitly and can then be tested.
 */
const SHIM = `
  create schema if not exists auth;
  create table auth.users (id uuid primary key);
  create domain citext as text;

  create role anon         nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role  nologin noinherit bypassrls;

  grant usage on schema public to anon, authenticated, service_role;
  grant usage on schema auth   to anon, authenticated, service_role;

  alter default privileges in schema public
    grant all on tables    to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on functions to anon, authenticated, service_role;

  -- The real auth.uid(): the 'sub' claim of the request JWT, or null when there
  -- is no JWT at all. The guard is needed because an unset GUC reads as the
  -- empty string, and ''::json raises.
  create or replace function auth.uid() returns uuid
  language sql stable as $shim$
    select case
      when coalesce(current_setting('request.jwt.claims', true), '') = '' then null
      else nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
    end;
  $shim$;

  grant execute on function auth.uid() to anon, authenticated, service_role;

  -- Storage, in the two tables and one function the avatars migration touches.
  --
  -- Thin on purpose, and the thinness is the point: the avatar rules are
  -- ordinary row policies over an ordinary table, so once the table exists
  -- Postgres enforces them here exactly as it does in production. What is not
  -- simulated is Supabase's upload path -- the size and mime limits on the
  -- bucket row are theirs to apply, and a test asserting them would be
  -- asserting this shim.
  create schema if not exists storage;

  create table storage.buckets (
    id                 text primary key,
    name               text not null,
    public             boolean not null default false,
    file_size_limit    bigint,
    allowed_mime_types text[],
    created_at         timestamptz not null default now()
  );

  create table storage.objects (
    id         uuid primary key default gen_random_uuid(),
    bucket_id  text not null references storage.buckets(id),
    name       text not null,
    owner      uuid,
    metadata   jsonb,
    created_at timestamptz not null default now(),
    unique (bucket_id, name)
  );

  alter table storage.objects enable row level security;

  -- Supabase's own definition. Everything before the final slash, split on
  -- slashes -- so 'uid/face.jpg' yields {uid} and a bare 'face.jpg' yields {}.
  create or replace function storage.foldername(name text) returns text[]
  language plpgsql immutable as $shim$
  declare
    parts text[];
  begin
    parts := string_to_array(name, '/');
    return parts[1 : array_length(parts, 1) - 1];
  end;
  $shim$;

  grant usage on schema storage to anon, authenticated, service_role;
  grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
  grant execute on function storage.foldername(text) to anon, authenticated, service_role;
`;

/**
 * The migrated database, dumped once and reloaded for each test database.
 *
 * Applying the migrations is no longer cheap: the seed catalogue is two thousand rows,
 * and replaying it per test file took the suite from forty seconds to nearly two
 * minutes — the sort of cost that quietly stops people running tests. A PGlite data
 * directory dump reloads in a fraction of the time.
 *
 * What matters for trust: this is a snapshot of the real migrations, applied in the real
 * order, taken in this process. It is not a schema dump maintained beside them, which is
 * the version of this idea that rots and starts disagreeing with production. If a
 * migration is broken, the first `createTestDb` still fails, and it names the file.
 */
let migratedSnapshot;

const migrationFiles = async () =>
  (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

const applyOne = async (db, file) => {
  let sql = await readFile(join(migrationsDir, file), 'utf8');
  // The shim already defines citext as a domain.
  sql = sql.replace(/create extension if not exists citext;/g, '');
  try {
    await db.exec(sql);
  } catch (e) {
    throw new Error(`Migration ${file} failed: ${e.message}`);
  }
};

const applyMigrations = async (db, upTo) => {
  const all = await migrationFiles();
  // Filenames are timestamp-prefixed and applied in sort order, so "everything
  // before file X" is a plain string comparison over that same order.
  const files = upTo ? all.filter((f) => f < upTo) : all;

  for (const file of files) await applyOne(db, file);

  return files;
};

/**
 * A database with the migrations applied only up to (and not including) `stopBefore`.
 *
 * This exists so a migration that *transforms existing rows* can be tested for what it
 * does to them. The ordinary `createTestDb` reloads a snapshot in which every migration
 * has already run, so a backfill has necessarily already executed — against an empty
 * database, where it is a guaranteed no-op. Asserting anything about it afterwards
 * measures the triggers instead and passes whether or not the backfill works at all.
 *
 * Deliberately uncached: the whole point is a database in a state the snapshot cannot
 * represent, and one uncached run in one file is a few seconds.
 */
export async function createTestDbBefore(stopBefore) {
  // Checked before any work, and before the filter below silently applies a prefix:
  // a renamed or mistyped migration would otherwise produce a database missing an
  // arbitrary tail of the schema, and the failure would surface much later as a
  // confusing "relation does not exist".
  if (!(await migrationFiles()).includes(stopBefore)) {
    throw new Error(`createTestDbBefore: no migration named ${stopBefore}`);
  }

  const db = await PGlite.create();
  await db.exec(SHIM);
  const files = await applyMigrations(db, stopBefore);

  return { ...testApi(db, files), applyMigration: (file) => applyOne(db, file) };
}

export async function createTestDb() {
  let db;
  let files;

  if (migratedSnapshot) {
    db = await PGlite.create({ loadDataDir: migratedSnapshot.dump.slice() });
    files = migratedSnapshot.files;
  } else {
    db = await PGlite.create();
    await db.exec(SHIM);
    files = await applyMigrations(db);
    migratedSnapshot = { dump: await db.dumpDataDir('none'), files };
  }

  return testApi(db, files);
}

function testApi(db, files) {
  return {
    db,
    appliedMigrations: files,

    async sql(query, params) {
      return params ? db.query(query, params) : db.query(query);
    },

    async exec(query) {
      return db.exec(query);
    },

    /**
     * Sets the acting identity for auth.uid() while staying the table owner, so
     * setup and the functional suites can still write directly. RLS is *not*
     * enforced in this mode — use asUser or asAnon for anything asserting a policy.
     */
    async actAs(userId) {
      const claims = userId ? JSON.stringify({ sub: userId, role: 'authenticated' }) : '';
      await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
    },

    /**
     * Runs fn as a real Supabase role, which is what makes RLS apply: policies
     * are skipped for the owner and enforced for everyone else. The role is
     * always reset, including when fn throws, or one failure would silently
     * de-privilege the rest of the file.
     */
    async asRole(role, userId, fn) {
      const claims = userId ? JSON.stringify({ sub: userId, role }) : '';
      await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
      await db.exec(`set role ${role}`);
      try {
        return await fn();
      } finally {
        await db.exec('reset role');
      }
    },

    /** A signed-in client. The ordinary case for a policy test. */
    async asUser(userId, fn) {
      return this.asRole('authenticated', userId, fn);
    },

    /** A signed-out client, as on the public web pages. */
    async asAnon(fn) {
      return this.asRole('anon', null, fn);
    },

    /**
     * Returns the error a query raises, or null if it succeeded. Reads better
     * than a try/catch in each test, and makes "this must be refused" explicit.
     */
    async errorFrom(query, params) {
      try {
        await db.query(query, params);
        return null;
      } catch (e) {
        return e;
      }
    },

    /** Creates an auth user and a profile, and returns the id. */
    async createUser({ username, visibility = 'public', dob = '1990-01-01' }) {
      const { rows } = await db.query(`select gen_random_uuid() as id`);
      const id = rows[0].id;
      await db.query(`insert into auth.users (id) values ($1)`, [id]);
      await db.query(
        `insert into profiles (id, username, display_name, visibility)
         values ($1, $2, $3, $4::profile_visibility)`,
        [id, username, username, visibility],
      );
      // date_of_birth lives in its own table with no read policy, so that the
      // "never returned by any API" guarantee is structural rather than asserted
      // in a comment (20260813001400 §1).
      await db.query(`insert into profile_private (profile_id, date_of_birth) values ($1, $2)`, [
        id,
        dob,
      ]);
      return id;
    },

    /**
     * Creates a movie and returns its id.
     *
     * The tmdb id a test passes is negated. Since the seed catalogue arrived, the
     * positive range holds real titles, and a fixture asking for 1018 collided with a
     * real film and failed on a unique index — a test failing because of what someone
     * else's catalogue happens to contain. Negative ids cannot be real, so a fixture
     * and the catalogue can no longer meet, and the numbers tests pass keep their only
     * job: telling one fixture apart from another. `provenance` is stated for the same
     * reason it exists: a fixture is not TMDB's and must not be treated as expiring.
     */
    async createMovie(title, tmdbId) {
      const { rows } = await db.query(
        `insert into media_items (kind, tmdb_id, title, provenance)
         values ('movie', $1, $2, 'manual') returning id`,
        [-Math.abs(tmdbId), title],
      );
      return rows[0].id;
    },

    async createSeries(title, tmdbId) {
      const { rows } = await db.query(
        `insert into media_items (kind, tmdb_id, title, provenance)
         values ('series', $1, $2, 'manual') returning id`,
        [-Math.abs(tmdbId), title],
      );
      return rows[0].id;
    },

    /**
     * The parent must itself be a fixture. Negating tmdb ids protects films and series
     * from colliding with the seed catalogue, but a season's identity is its parent plus
     * its number, so handing this a *seeded* series id reproduces the same unique-index
     * failure one table over — and it would look like a bug in whatever was being tested.
     */
    async createSeason(parentId, seasonNumber, title) {
      const { rows } = await db.query(
        `insert into media_items (kind, parent_id, season_number, title, provenance)
         select 'season', p.id, $2, $3, 'manual'
           from media_items p
          where p.id = $1 and p.kind = 'series' and p.provenance = 'manual'
         returning id`,
        [parentId, seasonNumber, title],
      );
      if (!rows[0]) {
        throw new Error(
          'createSeason needs a fixture series as its parent: pass an id from createSeries, ' +
            'not a seeded one, or its season numbers will collide with the catalogue',
        );
      }
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

      return {
        position: result.position,
        score: result.score,
        comparisons,
        adjustable: result.adjustable,
      };
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
