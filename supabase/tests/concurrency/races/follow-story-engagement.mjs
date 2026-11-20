import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { call, fire, newOp, raceContext } from './_shared.mjs';

/**
 * Engagement on follow stories racing a block (Workstream C, 20261201000100).
 *
 * `_add_comment` checks the shared engagement predicate under the commenter's pair locks.
 * A block between the commenter and the story's only MEMBER takes a different pair lock, so
 * nothing serialises the two. The barrier holds the comment after its check passed and
 * before its insert, and lets the block commit in that gap.
 *
 * FE1. The comment lands, because it was made while the story was open to its author. It is
 * then hidden on every read path from the commenter, for whom the story is now closed, and
 * from the member who blocked them. It stays visible to everybody the story is still open to.
 * Nothing errors and nothing deadlocks.
 */
export default function suite() {
  const rc = raceContext();
  const { ctx } = rc;

  describe('follow story engagement races', () => {
    before(() => rc.open());
    after(() => rc.close());

    const as = async (db, who, sql, params = []) => {
      const s = await db.session(`reader-${who.slice(0, 6)}`);
      await s.actAs(who);
      try {
        return await s.one(sql, params);
      } finally {
        await s.end();
      }
    };

    it('FE1: a comment racing a block from the only member lands, then is hidden where it must be', async () => {
      const { db, fx } = ctx;
      const author = await fx.createUser();
      const member = await fx.createUser();
      const fan = await fx.createUser();
      const other = await fx.createUser();

      const setup = await db.session('setup');
      await setup.actAs(fan);
      await call(setup, `follow($1, $2)`, [await newOp(db), author]);
      await setup.actAs(other);
      await call(setup, `follow($1, $2)`, [await newOp(db), author]);
      await setup.actAs(author);
      await call(setup, `follow($1, $2)`, [await newOp(db), member]);
      await setup.end();
      const [{ id: story }] = await db.rows(
        `select id from feed_events where actor_id = $1 and type = 'follow_added'`,
        [author],
      );

      await db.armBarrier('comments', 'fe1');
      const ctl = await db.controller();
      await ctl.hold('fe1');

      const commenter = await db.session('commenter');
      await commenter.actAs(fan);
      await commenter.begin();
      await commenter.pauseAt('fe1');
      const commenting = fire(commenter, `add_comment($1, $2, 'racing', false, null, '{}'::uuid[])`, [
        await newOp(db),
        story,
      ]);
      await commenter.awaitBlocked();

      // The member blocks the fan while the comment is past its check.
      const blocker = await db.session('blocker');
      await blocker.actAs(member);
      await call(blocker, `block($1, $2)`, [await newOp(db), fan]);
      await blocker.end();

      await ctl.release('fe1');
      const reply = (await commenting).rows[0].r;
      await commenter.commit();
      await commenter.end();
      await ctl.end();
      await db.disarmBarrier('comments');

      assert.equal(reply.status, 'ok', 'checked while open, so it lands');
      const visible = async (who) =>
        (await as(db, who, `select count(*)::int as n from activity_comments($1)`, [story])).n;
      assert.equal(await visible(fan), 0, 'closed to the commenter now');
      assert.equal(await visible(member), 0, 'and never shown to the member who blocked them');
      assert.equal(await visible(other), 1, 'still open to everybody else');
      assert.equal(await visible(author), 1, 'and to the author');
    });
  });
}
