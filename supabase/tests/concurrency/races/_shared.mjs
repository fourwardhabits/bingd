import { createRaceDb, fixtures } from '../harness.mjs';

/**
 * The shape every race suite here uses.
 *
 * `raceContext` hands back a lazily-created database plus fixtures, so a suite's
 * `before` is one line and every suite is isolated from every other by an actual
 * PostgreSQL database rather than by a naming convention.
 */
export function raceContext() {
  const ctx = { db: null, fx: null };

  return {
    ctx,
    async open() {
      ctx.db = await createRaceDb();
      ctx.fx = fixtures(ctx.db);
    },
    async close() {
      if (ctx.db) await ctx.db.close();
    },
  };
}

/** A fresh operation id, drawn from the database so it is a real uuid. */
export const newOp = async (db) => (await db.rows(`select gen_random_uuid() as id`))[0].id;

/**
 * Calls an RPC and returns its jsonb result. The `as r` wrapper matches the style
 * `../../social-writers.test.mjs` uses, so a race and a functional test read alike.
 */
export const call = async (session, sql, params = []) =>
  (await session.one(`select ${sql} as r`, params)).r;

/** The same call, fired and not awaited — the racing half. */
export const fire = (session, sql, params = []) => session.start(`select ${sql} as r`, params);

/**
 * Every notification between an ordered pair. Scoped to the pair rather than to the
 * recipient for the reason `social-writers.test.mjs` records: a per-recipient count
 * accumulates across tests and starts depending on what ran before.
 */
export const inbox = (db, recipient, actor) =>
  db.rows(
    `select type, subject_type, subject_id, created_at from notifications
      where recipient_id = $1 and actor_id = $2 order by created_at`,
    [recipient, actor],
  );

/** What the recipient can actually see, through the one read path clients have. */
export async function visibleInbox(db, recipient) {
  const s = await db.session('reader');
  try {
    await s.actAs(recipient);
    const { rows } = await s.q(`select * from my_notifications(100)`);
    return rows;
  } finally {
    await s.end();
  }
}

export const follows = (db, a, b) =>
  db.rows(`select state from follows where follower_id = $1 and followee_id = $2`, [a, b]);

export const blocks = (db, a, b) =>
  db.rows(`select 1 from blocks where blocker_id = $1 and blocked_id = $2`, [a, b]);
