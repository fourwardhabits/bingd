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

    /**
     * FE2. Q1's freeze against a follow that races the first engagement (20261201000200,
     * Codex on #390).
     *
     * The first reaction (and, in a second case, the first comment) is held open after it
     * recorded the freeze. The author then follows somebody new. That follow must wait on the
     * author's `follow_story:` key, the one `_post_follow_activity` takes before it looks for
     * an open story, and once the engagement commits it must open a NEW story. Without the
     * lock in the writers, the follow's lookup reads "not frozen" from its snapshot, waits
     * only on the story row's key-share lock and then appends to the engaged story.
     */
    for (const [label, engage] of [
      ['reaction', (story) => [`set_reaction($1, $2, 'love')`, story]],
      ['comment', (story) => [`add_comment($1, $2, 'first', false, null, '{}'::uuid[])`, story]],
    ]) {
      it(`FE2: a follow racing the first ${label} opens a new story, and the engaged one keeps its people`, async () => {
        const { db, fx } = ctx;
        const author = await fx.createUser();
        const member = await fx.createUser();
        const late = await fx.createUser();
        const fan = await fx.createUser();

        const setup = await db.session('setup');
        await setup.actAs(fan);
        await call(setup, `follow($1, $2)`, [await newOp(db), author]);
        await setup.actAs(author);
        await call(setup, `follow($1, $2)`, [await newOp(db), member]);
        await setup.end();
        const [{ id: story }] = await db.rows(
          `select id from feed_events where actor_id = $1 and type = 'follow_added'`,
          [author],
        );
        const [{ k: storyKey }] = await db.rows(
          `select hashtextextended('follow_story:' || $1::text, 0)::text as k`,
          [author],
        );

        const engager = await db.session('engager');
        const follower = await db.session('author');
        try {
          await engager.actAs(fan);
          await engager.begin();
          const [sql, id] = engage(story);
          await call(engager, sql, [await newOp(db), id]);

          await follower.actAs(author);
          await follower.begin();
          const following = fire(follower, `follow($1, $2)`, [await newOp(db), late]);
          await follower.awaitBlocked({ on: 'advisory', advisoryKey: storyKey });

          await engager.commit();
          assert.equal((await following).rows[0].r.state, 'approved');
          await follower.commit();
        } finally {
          await engager.end();
          await follower.end();
        }

        const people = await db.rows(
          `select ft.event_id, ft.followed_id from feed_follow_targets ft
             join feed_events e on e.id = ft.event_id
            where e.actor_id = $1 and e.type = 'follow_added'`,
          [author],
        );
        const inEngaged = people.filter((p) => p.event_id === story).map((p) => p.followed_id);
        assert.deepEqual(inEngaged, [member], 'the engaged story still names only who it named');
        const lateStory = people.find((p) => p.followed_id === late)?.event_id;
        assert.ok(lateStory && lateStory !== story, 'the new follow is a new story');
      });
    }
  });
}
