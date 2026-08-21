import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';
import pkg from 'pg';

import { buildShim, migrationFiles, migrationSql } from '../harness.mjs';

const { Client } = pkg;

/**
 * A concurrency harness against a **real** PostgreSQL.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists at all
 * ---------------------------------------------------------------------------
 *
 * `../harness.mjs` runs the same migrations under PGlite, and 736 tests depend on
 * it. It cannot be used for anything here, and the reason is structural rather
 * than a matter of effort: **PGlite is a single connection**. There is no second
 * backend, so there is no second transaction, so `pg_advisory_xact_lock` never
 * contends with anything and a race cannot be constructed. Every concurrency
 * claim in this schema — `_lock_pair`, `_claim_operation`, the rate limiter's
 * per-account lock, `invite_tokens_one_live` — was therefore *argued in a comment*
 * and never demonstrated. Some of those arguments turn out to be wrong.
 *
 * So: real PostgreSQL 17, native binaries, no Docker, N independent client
 * connections, and the migrations applied verbatim from `supabase/migrations`.
 *
 * ---------------------------------------------------------------------------
 * The three primitives, and why each is necessary
 * ---------------------------------------------------------------------------
 *
 * **1. Independent sessions.** `db.session()` opens a separate TCP connection with
 * its own backend process and its own transaction. `session.pid` is that backend's
 * real pid, read back from `pg_backend_pid()` — which is what makes the blocking
 * assertions below observations of PostgreSQL rather than of this file.
 *
 * **2. Proof of blocking, not proof of source text.** A test that greps a function
 * body for `_lock_pair` asserts that somebody typed something. `awaitBlocked`
 * instead polls `pg_stat_activity` from a *third* connection until the target
 * backend is genuinely waiting on a lock, and **throws if it never blocks**. That
 * inversion is the point: remove the lock from the migration and the test fails
 * loudly rather than passing on a race that happens to resolve the friendly way.
 *
 * **3. A pause at a chosen SQL step.** Several writers here have a window between
 * a visibility check and an insert, and the window is *inside a SECURITY DEFINER
 * function*. It cannot be reached by ordering client calls. So the harness installs
 * a **barrier trigger** on the target table, in the disposable test database only,
 * which takes an advisory lock a controller connection is holding. The function
 * under test is not modified, not re-implemented, and not stubbed; it simply stops
 * at the moment it reaches that table, while another transaction is let past.
 *
 * The barrier is opt-in **per session**, through a GUC the racing session sets. A
 * trigger armed for everybody would also stop the fixture setup, and — worse — the
 * second transaction in the very race being constructed. Keyed by session, only
 * the transaction that asked to be paused is paused.
 *
 * ---------------------------------------------------------------------------
 * Isolation
 * ---------------------------------------------------------------------------
 *
 * One cluster per process, on a port claimed from the OS rather than a constant, in
 * a data directory named for the pid. Migrations are applied once into a template
 * database; every test calls `createRaceDb()` and gets a fresh `create database …
 * template …` clone. Nothing is shared between tests, no identity is hardcoded, and
 * two runs of this suite at once cannot collide.
 */

const CLUSTER_USER = 'postgres';
const CLUSTER_PASSWORD = 'postgres';
const TEMPLATE_DB = 'bingd_template';

let cluster = null;
let dbCounter = 0;

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const connect = async (database) => {
  const client = new Client({
    host: '127.0.0.1',
    port: cluster.port,
    user: CLUSTER_USER,
    password: CLUSTER_PASSWORD,
    database,
  });
  await client.connect();
  return client;
};

/**
 * Polls until a real connection to the postmaster succeeds — the readiness signal
 * `boot()` trusts, since the library's own is fragile (see there). Rejection of an
 * individual attempt is expected while the postmaster is still coming up; only the
 * deadline turns it into a failure.
 */
async function untilConnectable(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = new Client({
      host: '127.0.0.1',
      port,
      user: CLUSTER_USER,
      password: CLUSTER_PASSWORD,
      database: 'postgres',
      connectionTimeoutMillis: 2_000,
    });
    try {
      await probe.connect();
      await probe.end();
      return;
    } catch {
      await probe.end().catch(() => {});
      if (Date.now() >= deadline) {
        throw new Error(`postgres on port ${port} did not accept connections within ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/**
 * Boots the cluster and builds the template database. Idempotent, and awaited by
 * every caller through the same promise, so `node --test` running several files in
 * one process does not start several PostgreSQLs.
 */
let bootPromise = null;

export function startCluster() {
  if (!bootPromise) bootPromise = boot();
  return bootPromise;
}

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), `bingd-race-${process.pid}-`));

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: CLUSTER_USER,
    password: CLUSTER_PASSWORD,
    // Placeholder. The real port is claimed after `initialise()`, immediately
    // before `start()` binds it — initdb takes ~20 seconds and never uses the
    // port, and in that window the sibling test file's client connections draw
    // ephemeral ports from the same OS range. A port claimed before initdb was
    // occasionally gone by the time postgres bound it, and the library reports
    // that as a bare `undefined` rejection with the file's suites never run.
    port: 1,
    // Cleanup is ours: `persistent: false` removes the directory on stop, and on
    // Windows that races the postmaster's own file handles and throws EBUSY out of
    // an exit handler, which fails a suite that has already passed.
    persistent: true,
    /**
     * Both flags are load-bearing and neither is a preference.
     *
     * `--encoding=UTF8`, because `initdb` on a Windows host otherwise takes the
     * system locale and builds a **WIN1252** cluster — in which
     * `20260814040000_search.sql` fails outright on a macron in a seeded title.
     * Supabase is UTF8; a cluster that is not is a different database.
     *
     * `--locale-provider=icu`, because the alternative that also avoids WIN1252 is
     * `--locale=C`, and a C ctype does not case-fold anything outside ASCII. That
     * would quietly change `lower()`, `citext` and the search normalisation for
     * exactly the inputs those were written to handle.
     */
    initdbFlags: ['--encoding=UTF8', '--locale-provider=icu', '--icu-locale=en-US'],
    onLog: () => {},
    onError: () => {},
  });

  await pg.initialise();

  const port = await freePort();
  pg.options.port = port;

  /**
   * `pg.start()` resolves only when a single stderr chunk contains the whole
   * "database system is ready to accept connections" sentinel, and rejects with
   * `undefined` if the process exits early. A chunk boundary through the sentinel
   * therefore left a healthy cluster running while this promise stayed pending
   * forever — a hung run with zero CPU and no error, observed 2026-08-21. The
   * cluster's actual readiness is decided here by connecting to it; the library's
   * own settlement is raced against that probe, and its rejection is translated
   * into an error that names the port. `Promise.race` attaches handlers to both,
   * so a late library rejection after the probe wins is still a handled one.
   */
  const started = pg.start().then(
    () => undefined,
    () => {
      throw new Error(`postgres exited during startup on port ${port} — likely a port collision`);
    },
  );
  await Promise.race([started, untilConnectable(port, 30_000)]);

  cluster = { pg, port, dataDir };

  const admin = await connect('postgres');
  await admin.query(`create database ${TEMPLATE_DB}`);
  await admin.end();

  const template = await connect(TEMPLATE_DB);
  try {
    await template.query(buildShim({ citext: 'extension' }));
    for (const file of await migrationFiles()) {
      const sql = await migrationSql(file, { citext: 'extension' });
      try {
        await template.query(sql);
      } catch (e) {
        throw new Error(`Migration ${file} failed: ${e.message}`);
      }
    }
    await template.query(BARRIER_SQL);
  } finally {
    await template.end();
  }

  return cluster;
}

export async function stopCluster() {
  if (!cluster) return;
  const { pg, dataDir } = cluster;
  cluster = null;
  bootPromise = null;
  await pg.stop();
  // Best effort, and deliberately not fatal. A leftover directory under the OS temp
  // path is untidy; a passing suite reported as failed because Windows had not yet
  // released a file handle is worse.
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* ignore */
  }
}

/**
 * The barrier, installed into the template so every clone has it.
 *
 * `pg_advisory_xact_lock` and not a sleep: a sleep is a guess about scheduling, and
 * a guess is how a race test becomes flaky. The controller holds a *session*-level
 * advisory lock on the same key; the paused transaction waits on it for as long as
 * the test wants and not one millisecond longer.
 *
 * The GUC carries the key, so one trigger definition serves every table and every
 * concurrent test, and a session that has not set it is not affected at all.
 *
 * **The trigger name is load-bearing.** `notifications` already carries
 * `notifications_respect_preference`, also BEFORE INSERT, which returns null to drop
 * a row whose category the recipient has switched off. Same-timing triggers fire in
 * alphabetical order by trigger name, and `_race_barrier_notifications` sorts before
 * `n…` — so the barrier is reached first and a dropped row still pauses. Rename it to
 * something starting past `n` and the reaction tests would stop pausing at all, which
 * would look like a missing lock rather than a renamed trigger.
 */
const BARRIER_SQL = `
  create or replace function _race_barrier() returns trigger
  language plpgsql as $barrier$
  declare
    v_key text := coalesce(current_setting('race.barrier', true), '');
    v_here text := tg_argv[0];
  begin
    if v_key <> '' and v_key = v_here then
      perform pg_advisory_xact_lock(hashtextextended('race:' || v_key, 0));
    end if;
    -- NEW is null in a BEFORE DELETE row trigger, and returning null there cancels
    -- the delete. A barrier that silently changed what the function under test did
    -- would invalidate every assertion made through it.
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end;
  $barrier$;
`;

/**
 * A disposable database cloned from the template, with the session factory.
 */
export async function createRaceDb() {
  await startCluster();

  const name = `race_${process.pid}_${++dbCounter}`;
  const admin = await connect('postgres');
  await admin.query(`create database ${name} template ${TEMPLATE_DB}`);
  await admin.end();

  const open = [];
  const observer = await connect(name);

  const api = {
    name,

    /** An independent connection, with its own backend and its own transaction. */
    async session(label = `s${open.length + 1}`) {
      const client = await connect(name);
      const { rows } = await client.query('select pg_backend_pid() as pid');
      const s = makeSession(client, rows[0].pid, label, observer);
      open.push(s);
      return s;
    },

    /**
     * A connection that holds session-level advisory locks on behalf of the test —
     * the thing on the other side of a barrier. Separate from the racing sessions
     * because a transaction-scoped lock would be released by their commits.
     */
    async controller() {
      const client = await connect(name);
      const held = new Set();
      const ctl = {
        async hold(key) {
          await client.query(`select pg_advisory_lock(hashtextextended('race:' || $1, 0))`, [key]);
          held.add(key);
        },
        async release(key) {
          await client.query(`select pg_advisory_unlock(hashtextextended('race:' || $1, 0))`, [key]);
          held.delete(key);
        },
        /**
         * Holds the very key `_lock_pair` computes, so a test can stop any writer at
         * its own pair lock without a barrier trigger.
         *
         * The expression is `_lock_pair`'s, called rather than copied — `select
         * _lock_pair(...)` would take a *transaction*-scoped lock that this
         * connection's implicit commit would drop, so the key is recomputed and taken
         * at session scope. That the two agree is not assumed: `lock-pair.mjs`
         * asserts a real writer blocks on exactly this key.
         */
        async holdPair(a, b) {
          const key = `pair:${a}:${b}`;
          await client.query(
            `select pg_advisory_lock(
               hashtextextended(least($1::text, $2::text) || ':' || greatest($1::text, $2::text), 0))`,
            [a, b],
          );
          held.add(key);
          return key;
        },
        /**
         * The key `_assert_operation_rate` computes for one account and one kind, and
         * the one `create_invite_link` computes for its mint — the two share a shape.
         * Held at session scope for the same reason `holdPair` is.
         */
        async holdAccount(userId, kind) {
          await client.query(
            `select pg_advisory_lock(hashtextextended(coalesce($1::text, '') || $2, 0))`,
            [userId, kind],
          );
          held.add(`account:${userId}:${kind}`);
        },
        async releaseAccount(userId, kind) {
          await client.query(
            `select pg_advisory_unlock(hashtextextended(coalesce($1::text, '') || $2, 0))`,
            [userId, kind],
          );
          held.delete(`account:${userId}:${kind}`);
        },
        async releasePair(a, b) {
          await client.query(
            `select pg_advisory_unlock(
               hashtextextended(least($1::text, $2::text) || ':' || greatest($1::text, $2::text), 0))`,
            [a, b],
          );
          held.delete(`pair:${a}:${b}`);
        },
        async end() {
          for (const key of held) {
            if (key.startsWith('pair:')) {
              const [, a, b] = key.split(':');
              await ctl.releasePair(a, b);
            } else if (key.startsWith('account:')) {
              const [, userId, kind] = key.split(':');
              await ctl.releaseAccount(userId, kind);
            } else {
              await ctl.release(key);
            }
          }
          await client.end();
        },
      };
      open.push(ctl);
      return ctl;
    },

    /**
     * Arms the barrier trigger on a table. The trigger fires for every session, but
     * only pauses one that has set `race.barrier` to this key — see `session.pauseAt`.
     */
    /**
     * The bigint `_lock_pair` computes for a pair, and the one `_race_barrier` uses
     * for a named barrier. Returned as a string, because a 64-bit key does not fit a
     * JavaScript number and rounding it would silently make the correlation in
     * `awaitBlocked` match the wrong lock.
     */
    async pairKey(a, b) {
      const { rows } = await observer.query(
        `select hashtextextended(
           least($1::text, $2::text) || ':' || greatest($1::text, $2::text), 0)::text as k`,
        [a, b],
      );
      return rows[0].k;
    },

    async barrierKey(name) {
      const { rows } = await observer.query(
        `select hashtextextended('race:' || $1, 0)::text as k`,
        [name],
      );
      return rows[0].k;
    },

    /** The key `_assert_operation_rate` computes for one account and one kind. */
    async accountKey(userId, kind) {
      const { rows } = await observer.query(
        `select hashtextextended(coalesce($1::text, '') || $2, 0)::text as k`,
        [userId, kind],
      );
      return rows[0].k;
    },

    async armBarrier(table, key, { timing = 'before', event = 'insert' } = {}) {
      /**
       * `lock_timeout` is not tidiness. Installing a trigger needs ACCESS EXCLUSIVE
       * on the table, and any transaction a previous test left open holds a
       * conflicting lock on it — so without this, one failed race turns every
       * later test in the file into a silent hang, and the report says "timed out"
       * about the wrong test. Failing here says what actually happened.
       */
      try {
        await observer.query(`set lock_timeout = '5s'`);
        await observer.query(`
          drop trigger if exists _race_barrier_${table} on ${table};
          create trigger _race_barrier_${table}
            ${timing} ${event} on ${table}
            for each row execute function _race_barrier('${key}');
        `);
      } catch (e) {
        if (e.code === '55P03') {
          throw new Error(
            `could not arm a barrier on ${table}: a transaction from an earlier test is ` +
              `still open and holding a lock on it. The earlier test is the failure.`,
          );
        }
        throw e;
      } finally {
        await observer.query(`set lock_timeout = 0`);
      }
    },

    async disarmBarrier(table) {
      await observer.query(`drop trigger if exists _race_barrier_${table} on ${table}`);
    },

    /** Runs a query as the owner: fixture setup, and final-state assertions. */
    async sql(query, params) {
      return observer.query(query, params);
    },

    async rows(query, params) {
      return (await observer.query(query, params)).rows;
    },

    async close() {
      for (const s of open) {
        try {
          await s.end();
        } catch {
          /* a session killed mid-race has nothing left to close cleanly */
        }
      }
      await observer.end();
      const drop = await connect('postgres');
      await drop.query(`drop database if exists ${name} with (force)`);
      await drop.end();
    },
  };

  return api;
}

function makeSession(client, pid, label, observer) {
  let identity = null;

  const applyIdentity = async () => {
    const claims = identity ? JSON.stringify({ sub: identity, role: 'authenticated' }) : '';
    await client.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
    if (identity) await client.query('set role authenticated');
    else await client.query('reset role');
  };

  return {
    label,
    pid,
    client,

    /**
     * Acts as a signed-in user, exactly as `../harness.mjs` `asUser` does — the
     * `sub` claim of `request.jwt.claims`, plus the real `authenticated` role so
     * row level security is enforced rather than bypassed by ownership.
     *
     * Re-applied by `begin`, because `SET ROLE` is transactional: a rolled-back
     * race would otherwise silently return the session to superuser and the next
     * assertion in the file would run with RLS off.
     */
    async actAs(userId) {
      identity = userId;
      await applyIdentity();
    },

    async begin() {
      await client.query('begin');
      if (identity) await applyIdentity();
    },

    async commit() {
      await client.query('commit');
      if (identity) await applyIdentity();
    },

    async rollback() {
      await client.query('rollback');
      if (identity) await applyIdentity();
    },

    /**
     * Opts this session's current transaction into the named barrier. Anything the
     * transaction goes on to do that fires the armed trigger stops there until the
     * controller releases the key.
     */
    async pauseAt(key) {
      await client.query(`select set_config('race.barrier', $1, true)`, [key]);
    },

    /** Awaited. The ordinary case. */
    async q(sql, params) {
      return client.query(sql, params);
    },

    async one(sql, params) {
      return (await client.query(sql, params)).rows[0];
    },

    /**
     * Fired and **not** awaited, so the test can go on to drive another session
     * while this one is blocked. The returned promise settles when the statement
     * finally completes; a test that never awaits it is a test that has not proved
     * what happened, so every caller here does.
     */
    start(sql, params) {
      return client.query(sql, params);
    },

    /** The error a statement raised, or null. */
    async errorFrom(sql, params) {
      try {
        await client.query(sql, params);
        return null;
      } catch (e) {
        return e;
      }
    },

    /**
     * Waits until this backend is genuinely blocked on a lock, observed from a
     * different connection, and **throws if it never blocks**.
     *
     * This is the assertion that carries the whole suite. Every "takes a lock first"
     * comment in the migrations is checked here against `pg_stat_activity`, so
     * deleting the lock turns the corresponding test red instead of leaving it green
     * on a race that happened to interleave harmlessly.
     */
    async awaitBlocked({ timeoutMs = 5000, on = null, advisoryKey = null } = {}) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        const { rows } = await observer.query(
          `select state, wait_event_type, wait_event, query
             from pg_stat_activity where pid = $1`,
          [pid],
        );
        last = rows[0] ?? null;
        if (last && last.wait_event_type === 'Lock' && (!on || last.wait_event === on)) {
          if (!advisoryKey) return last;
          /**
           * Review 25, minor: `wait_event = 'advisory'` proves the backend is waiting
           * on *an* advisory lock, not on the one the test names. Correlating with
           * `pg_locks` closes that gap, and it is the difference between "something
           * serialised these two" and "`_lock_pair` serialised these two".
           *
           * The key is compared as its two halves rather than reassembled: `classid`
           * and `objid` are 32-bit oids, and shifting one back into a bigint
           * overflows for any key with the high bit set — which is half of them.
           *
           * `objsubid = 1` distinguishes the one-bigint advisory namespace from the
           * two-integer one, which uses 2. Nothing in this schema takes the
           * two-integer form, so the filter is not currently load-bearing — but
           * without it the two halves of a bigint key could be matched by a
           * two-integer lock that happened to use the same pair of ints, and a claim
           * of exactness that is only true by luck is the thing this whole option
           * exists to avoid.
           */
          const { rows: locks } = await observer.query(
            `select 1 from pg_locks
              where pid = $1 and locktype = 'advisory' and not granted and objsubid = 1
                and classid = ((($2::bigint >> 32) & 4294967295))::oid
                and objid   = (($2::bigint & 4294967295))::oid`,
            [pid, advisoryKey],
          );
          if (locks.length) return last;
        }
        await sleep(10);
      }
      throw new Error(
        `${label} (pid ${pid}) never blocked on ` +
          (advisoryKey ? `advisory key ${advisoryKey}` : 'a lock') +
          ` within ${timeoutMs}ms — ` +
          `last seen state=${last?.state} wait=${last?.wait_event_type}/${last?.wait_event}. ` +
          `If a lock was removed from the function under test, this is the failure.`,
      );
    },

    /**
     * The complement, and it is not redundant. Several tests here must show that two
     * calls do *not* contend — that one account's rate-limit lock does not serialise
     * another's — and an assertion that something stays running needs a settling
     * period rather than a single sample.
     */
    async assertRunning({ forMs = 300 } = {}) {
      const deadline = Date.now() + forMs;
      while (Date.now() < deadline) {
        const { rows } = await observer.query(
          `select wait_event_type, wait_event from pg_stat_activity where pid = $1`,
          [pid],
        );
        if (rows[0]?.wait_event_type === 'Lock') {
          throw new Error(
            `${label} (pid ${pid}) blocked on ${rows[0].wait_event} when it should not have`,
          );
        }
        await sleep(20);
      }
    },

    async end() {
      await client.end();
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export { sleep };

/**
 * Fixture helpers, deliberately mirroring `../harness.mjs` so a race test and a
 * functional test describe the same world. Ids are always generated, never named:
 * two runs of this suite in parallel share a cluster only by accident of the same
 * machine, and never share a database.
 */
export function fixtures(db) {
  return {
    async createUser({ username, visibility = 'public', dob = '1990-01-01' } = {}) {
      const id = (await db.rows(`select gen_random_uuid() as id`))[0].id;
      const name = username ?? `u${id.slice(0, 8)}`;
      await db.sql(`insert into auth.users (id) values ($1)`, [id]);
      await db.sql(
        `insert into profiles (id, username, display_name, visibility)
         values ($1, $2, $3, $4::profile_visibility)`,
        [id, name, name, visibility],
      );
      await db.sql(`insert into profile_private (profile_id, date_of_birth) values ($1, $2)`, [
        id,
        dob,
      ]);
      return id;
    },

    async createMovie(title = 'Fixture', tmdbId = Math.floor(Math.random() * 1e6) + 1) {
      const { rows } = await db.sql(
        `insert into media_items (kind, tmdb_id, title, provenance)
         values ('movie', $1, $2, 'manual') returning id`,
        [-Math.abs(tmdbId), title],
      );
      return rows[0].id;
    },

    /** A mutual, approved follow — the precondition for recommending and tagging. */
    async mutualFollow(a, b) {
      await db.sql(
        `insert into follows (follower_id, followee_id, state, approved_at)
         values ($1, $2, 'approved', now()), ($2, $1, 'approved', now())`,
        [a, b],
      );
    },

    async follow(a, b, state = 'approved') {
      await db.sql(
        `insert into follows (follower_id, followee_id, state, approved_at)
         values ($1, $2, $3::follow_state, case when $3 = 'approved' then now() end)`,
        [a, b, state],
      );
    },

    /** A feed event to comment on or react to, owned by `actor`. */
    async feedEvent(actor, mediaItemId, type = 'title_logged') {
      const { rows } = await db.sql(
        `insert into feed_events (actor_id, media_item_id, type)
         values ($1, $2, $3) returning id`,
        [actor, mediaItemId, type],
      );
      return rows[0].id;
    },

    /** The collection row `set_watch_tags` requires before it will accept companions. */
    async logWatch(userId, mediaItemId, bucket = 'loved') {
      await db.sql(
        `insert into user_media (user_id, media_item_id, bucket)
         values ($1, $2, $3::taste_bucket)
         on conflict (user_id, media_item_id) do nothing`,
        [userId, mediaItemId, bucket],
      );
    },
  };
}
