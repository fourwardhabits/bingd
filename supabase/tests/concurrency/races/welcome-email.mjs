import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { newOp, raceContext } from './_shared.mjs';
import { AUTH_COLUMNS_SQL, OPEN_COHORT_SQL, welcomeSource, welcomeSqlToApply } from '../../welcome-email-support.mjs';

/**
 * The welcome email's claim, under two connections.
 *
 * `welcome_email.sql` is not a migration until the automation is switched on, so this
 * suite applies it on top of the migrated template, exactly as the PGlite suite does.
 *
 * ---------------------------------------------------------------------------
 * The invariants
 * ---------------------------------------------------------------------------
 *
 * **W1. Two runs never own the same person.** A second worker that reads the same
 * candidates before the first commits blocks on the ledger's primary key, then does
 * nothing. Together they claim each person once, and the loser returns nobody rather than
 * an error: a scheduled run that overlaps a manual one must not fail either of them.
 *
 * **W2. Two runs never retry the same failure.** The retry is a compare-and-set on
 * `status = 'failed'`. The second runner waits for the row lock, re-reads the row, finds
 * it `claimed`, and takes nothing. With the status guard deleted it takes the row a second
 * time as attempt 3, which the last test demonstrates, so W2 is not passing by accident.
 *
 * **W3. Two overlapping sends never mint two invite identities.** Both runs select a
 * person with no invite link; the second waits on the first's claim and its invite lock,
 * and afterwards the person has exactly one live personal token, carried by the one run
 * that owns them.
 *
 * **W4. A send and a Share tap in the app agree on one token, in either order.** The
 * ensure step takes create_invite_link's own per-account lock, so whichever arrives
 * second waits, then reads the token the first committed. With that lock deleted, the
 * send reaches invite_tokens_one_live while the app's mint is uncommitted and fails with
 * 23505, which the last test demonstrates.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('welcome email races', () => {
    before(async () => {
      await rc.open();
      await ctx.db.sql(AUTH_COLUMNS_SQL);
      const sql = await welcomeSqlToApply();
      if (sql) await ctx.db.sql(sql);
      await ctx.db.sql(OPEN_COHORT_SQL);
    });
    after(() => rc.close());

    /**
     * An account with a confirmed address that signed up 60 hours ago. With `token`, it
     * already holds a live personal invite link, written directly because W1 and W2 are
     * about the ledger; W3 and W4 start without one, because they are about minting it.
     */
    const eligible = async ({ token = true } = {}) => {
      const { db, fx } = ctx;
      const id = await fx.createUser();
      await db.sql(`update auth.users set email = $2, email_confirmed_at = now() where id = $1`, [id, `${id}@example.com`]);
      await db.sql(`update profiles set created_at = now() - interval '60 hours' where id = $1`, [id]);
      if (token) {
        await db.sql(
          `insert into invite_tokens (owner_id, token, short_code, env)
           values ($1, replace(gen_random_uuid()::text, '-', ''), upper(substr(md5(random()::text), 1, 8)),
                   coalesce((select value #>> '{}' from app_config where key = 'env.name'), 'nonprod'))`,
          [id],
        );
      }
      return id;
    };

    const liveTokens = (db, owner) =>
      db.rows(`select token, kind, env from invite_tokens where owner_id = $1 and revoked_at is null`, [owner]);

    const claimSql = `select recipient_id, attempt from welcome_email_claim()`;

    /**
     * An empty ledger, and every account from an earlier scenario aged out of the signup
     * window. Emptying the ledger alone makes those accounts claimable again, and a
     * scenario would then be counting another scenario's people.
     */
    const fresh = async (db) => {
      await db.sql(`delete from welcome_emails`);
      await db.sql(`update profiles set created_at = now() - interval '400 days'`);
    };

    it('W1: two overlapping runs claim each person exactly once, and neither fails', async () => {
      const { db } = ctx;
      await fresh(db);
      const people = [await eligible(), await eligible(), await eligible()];

      const a = await db.session('run-a');
      const b = await db.session('run-b');
      try {
        await a.begin();
        const first = (await a.q(claimSql)).rows;

        await b.begin();
        const pending = b.start(claimSql);
        await b.awaitBlocked();

        await a.commit();
        const second = (await pending).rows;
        await b.commit();

        assert.deepEqual(first.map((r) => r.recipient_id).sort(), [...people].sort());
        assert.deepEqual(second, [], 'the overlapping run owns nobody');

        const rows = await db.rows(`select user_id, attempts from welcome_emails where user_id = any($1::uuid[])`, [people]);
        assert.equal(rows.length, 3);
        assert.ok(rows.every((r) => r.attempts === 1));
      } finally {
        await a.end();
        await b.end();
      }
    });

    const retryRace = async () => {
      const { db } = ctx;
      await fresh(db);
      const person = await eligible();
      await db.sql(`insert into welcome_emails (user_id, status, attempts, failed_reason) values ($1, 'failed', 1, '500 {}')`, [person]);

      const a = await db.session('retry-a');
      const b = await db.session('retry-b');
      try {
        await a.begin();
        const first = (await a.q(claimSql)).rows;

        await b.begin();
        const pending = b.start(claimSql);
        await b.awaitBlocked();

        await a.commit();
        const second = (await pending).rows;
        await b.commit();

        const [row] = await db.rows(`select status, attempts from welcome_emails where user_id = $1`, [person]);
        return { person, first, second, row };
      } finally {
        await a.end();
        await b.end();
      }
    };

    it('W2: two overlapping runs retry a failure once', async () => {
      const { person, first, second, row } = await retryRace();
      assert.deepEqual(first.map((r) => [r.recipient_id, r.attempt]), [[person, 2]]);
      assert.deepEqual(second, [], 'the overlapping run retries nothing');
      assert.deepEqual([row.status, row.attempts], ['claimed', 2]);
    });

    it('W2 bites: with the status guard deleted, the second run retries the same failure again', async () => {
      const { db } = ctx;
      const original = await welcomeSource();
      const guard = /(\n\s+where w\.user_id = v_row\.rid)\r?\n\s+and w\.status = 'failed'/;
      assert.match(original, guard, 'the guard this test deletes is where it expects');
      const claimFunction = original.match(/create function welcome_email_claim\([\s\S]*?\n\$fn\$;/)[0];

      try {
        await db.sql(claimFunction.replace('create function', 'create or replace function').replace(guard, '$1'));
        const { second, row } = await retryRace();
        assert.equal(second.length, 1, 'the mutant must double-claim, or W2 proves nothing');
        assert.equal(row.attempts, 3);
      } finally {
        await db.sql(claimFunction.replace('create function', 'create or replace function'));
      }
    });

    it('W3: two overlapping sends to a person with no invite link mint exactly one token', async () => {
      const { db } = ctx;
      await fresh(db);
      const person = await eligible({ token: false });

      const a = await db.session('send-a');
      const b = await db.session('send-b');
      try {
        await a.begin();
        const first = (await a.q(`select recipient_id, invite_token from welcome_email_claim()`)).rows;

        await b.begin();
        const pending = b.start(`select recipient_id, invite_token from welcome_email_claim()`);
        await b.awaitBlocked();

        await a.commit();
        const second = (await pending).rows;
        await b.commit();

        assert.equal(first.length, 1);
        assert.match(first[0].invite_token, /^[0-9a-f]{32}$/);
        assert.deepEqual(second, [], 'the overlapping send owns nobody and mints nothing');

        const tokens = await liveTokens(db, person);
        assert.deepEqual(tokens.map((t) => [t.token, t.kind]), [[first[0].invite_token, 'personal']]);
      } finally {
        await a.end();
        await b.end();
      }
    });

    /** A send and the app's create_invite_link, one holding its transaction open while the other arrives. */
    const sendAgainstShare = async ({ shareFirst }) => {
      const { db } = ctx;
      await fresh(db);
      const person = await eligible({ token: false });

      const app = await db.session('share');
      const send = await db.session('send');
      await app.actAs(person);
      const shareSql = `select create_invite_link($1) as r`;
      const claimSql = `select recipient_id, invite_token from welcome_email_claim()`;

      try {
        let shared;
        let sent;
        if (shareFirst) {
          await app.begin();
          shared = (await app.q(shareSql, [await newOp(db)])).rows[0].r;
          await send.begin();
          const pending = send.start(claimSql);
          await send.awaitBlocked({ on: 'advisory', advisoryKey: await db.accountKey(person, 'invite_link') });
          await app.commit();
          sent = (await pending).rows;
          await send.commit();
        } else {
          await send.begin();
          sent = (await send.q(claimSql)).rows;
          await app.begin();
          const pending = app.start(shareSql, [await newOp(db)]);
          await app.awaitBlocked({ on: 'advisory', advisoryKey: await db.accountKey(person, 'invite_link') });
          await send.commit();
          shared = (await pending).rows[0].r;
          await app.commit();
        }
        return { person, shared, sent, tokens: await liveTokens(db, person) };
      } finally {
        await app.end();
        await send.end();
      }
    };

    for (const shareFirst of [true, false]) {
      it(`W4: a send and a Share tap agree on one token (${shareFirst ? 'Share first' : 'send first'})`, async () => {
        const { shared, sent, tokens } = await sendAgainstShare({ shareFirst });
        assert.equal(shared.status, 'ok');
        assert.equal(sent.length, 1);
        assert.equal(sent[0].invite_token, shared.token, 'the email carries the link the app shares');
        assert.equal(tokens.length, 1, 'one live token');
        assert.equal(tokens[0].token, shared.token);
      });
    }

    it('W4 bites: without the shared invite lock, a send arriving during a Share tap fails on the unique index', async () => {
      const { db } = ctx;
      const original = await welcomeSource();
      const lock = /\n\s+perform pg_advisory_xact_lock\(hashtextextended\(coalesce\(p_user::text, ''\) \|\| 'invite_link', 0\)\);/;
      assert.match(original, lock, 'the lock this test deletes is where it expects');
      const ensureFunction = original.match(/create function _welcome_email_ensure_invite_token\([\s\S]*?\n\$fn\$;/)[0];

      try {
        await db.sql(ensureFunction.replace('create function', 'create or replace function').replace(lock, ''));
        await fresh(db);
        const person = await eligible({ token: false });
        const app = await db.session('share');
        const send = await db.session('send');
        await app.actAs(person);
        try {
          await app.begin();
          await app.q(`select create_invite_link($1) as r`, [await newOp(db)]);
          await send.begin();
          const pending = send.start(`select recipient_id, invite_token from welcome_email_claim()`).then(
            () => null,
            (error) => error,
          );
          await send.awaitBlocked();
          await app.commit();
          const error = await pending;
          assert.equal(error?.code, '23505', 'the mutant must collide, or W4 proves nothing');
          await send.rollback();
        } finally {
          await app.end();
          await send.end();
        }
      } finally {
        await db.sql(ensureFunction.replace('create function', 'create or replace function'));
      }
    });
  });
}
