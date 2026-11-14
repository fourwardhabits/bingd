import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { raceContext } from './_shared.mjs';

/**
 * Username sign-in, the cooldown resend against an in-flight verify — `20261123000100`.
 *
 * ---------------------------------------------------------------------------
 * THE RACE
 *
 * `username_sign_in_send` inside the 60-second cooldown does not email a new code. It
 * supersedes the live challenge and mints a replacement that *inherits* the old one's
 * `attempts`, so a resend cannot hand an attacker five fresh guesses against the code
 * already in the inbox.
 *
 * `username_sign_in_verify_begin` spends an attempt with a plain UPDATE and holds that
 * row lock until it commits. The two functions share no advisory lock (the account key
 * is taken by `send` alone, and the IP key only collides when both come from one IP),
 * so without a row lock on `send`'s read it copies the last *committed* count — the
 * attempt being spent right now is lost, and every verify that overlaps a resend is a
 * free guess. With `for update`, the read waits for the verify to commit and re-reads
 * the row, so the replacement carries the attempt.
 *
 * THE INVARIANT
 *
 * **US1. A cooldown replacement inherits every committed attempt.** T1's verify holds an
 * uncommitted attempt; T2's cooldown send is OBSERVED waiting on it; after T1 commits
 * and T2 returns, the one live challenge is T2's, and its `attempts` equals the count
 * T1 committed. `../mutation-check.mjs` mutant 18 removes the `for update` and requires
 * this to go red.
 */

const hex = (s) => createHash('sha256').update(s).digest('hex');
let seq = 0;
const fresh = (label) => hex(`${label}:${process.pid}:${++seq}:${Math.random()}`);

/**
 * The race, as a function of a database, so the mutation check runs exactly this
 * scenario against the mutant rather than a paraphrase of it.
 *
 * Returns the committed attempt count, the outcomes, whether T2 was seen blocked, and
 * every challenge row for the account.
 */
export async function cooldownRace(db, fx) {
  const username = `us${fresh('name').slice(0, 10)}`;
  const userId = await fx.createUser({ username });
  await db.sql(`update auth.users set email = $2, email_confirmed_at = now() where id = $1`, [
    userId,
    `${username}@example.test`,
  ]);

  const identifier = fresh('identifier');
  // Three IPs, so no advisory key is shared between the halves: the only thing that can
  // order T2 after T1 is the challenge row itself.
  const sendIp = fresh('ip-send');
  const verifyIp = fresh('ip-verify');
  const resendIp = fresh('ip-resend');
  const first = fresh('challenge-1');
  const second = fresh('challenge-2');

  const sendSql = `select username_sign_in_send($1, $2, $3, $4) as r`;
  const beginSql = `select username_sign_in_verify_begin($1, $2) as r`;

  const sent = (await db.rows(sendSql, [username, identifier, sendIp, first]))[0].r;
  // One committed guess before the race, so a lost update is 1 instead of 2 rather than
  // 0 instead of 1: a replacement that merely defaulted would be caught either way.
  const warm = (await db.rows(beginSql, [first, verifyIp]))[0].r;

  const t1 = await db.session('verify');
  const t2 = await db.session('resend');
  try {
    await t1.begin();
    const verify = (await t1.q(beginSql, [first, verifyIp])).rows[0].r;

    await t2.begin();
    const pending = t2.start(sendSql, [username, identifier, resendIp, second]);
    let blocked = true;
    try {
      await t2.awaitBlocked();
    } catch {
      blocked = false;
    }

    await t1.commit();
    const resend = (await pending).rows[0].r;
    await t2.commit();

    const [{ attempts: committed }] = await db.rows(
      `select attempts from auth_username_challenges where id_hash = $1`,
      [first],
    );
    const rows = await db.rows(
      `select id_hash, attempts, sent_at, expires_at, consumed_at is not null as consumed
         from auth_username_challenges where user_id = $1 order by created_at, id_hash`,
      [userId],
    );
    return { first, second, sent, warm, verify, resend, blocked, committed, rows };
  } finally {
    await t1.end();
    await t2.end();
  }
}

export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('username sign-in races', () => {
    before(() => rc.open());
    after(() => rc.close());

    it('US1: a cooldown resend waits for an in-flight verify and inherits its attempt', async () => {
      const r = await cooldownRace(ctx.db, ctx.fx);

      assert.equal(r.sent.outcome, 'send');
      assert.equal(r.warm.outcome, 'check');
      assert.equal(r.verify.outcome, 'check');
      assert.equal(r.resend.outcome, 'cooldown');
      assert.ok(r.blocked, 'the cooldown send never waited for the uncommitted verify');
      assert.equal(r.committed, 2, 'T1 committed the second attempt');

      const live = r.rows.filter((row) => !row.consumed);
      assert.equal(live.length, 1, 'exactly one live challenge for the account');
      assert.equal(live[0].id_hash, r.second, 'the live challenge is the replacement');
      assert.equal(
        live[0].attempts,
        r.committed,
        'the replacement lost an attempt spent while it was being minted',
      );

      const old = r.rows.find((row) => row.id_hash === r.first);
      assert.ok(old.consumed, 'the superseded challenge is dead');
      assert.equal(+live[0].sent_at, +old.sent_at, 'the replacement shares the code already sent');
      assert.equal(+live[0].expires_at, +old.expires_at, 'and its expiry');
    });
  });
}
