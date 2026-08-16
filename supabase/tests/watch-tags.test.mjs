import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Who I watched with (PRD §14), 20260816000300.
 *
 * The safety argument for this feature is structural — a tag is a row on the
 * tagger's watch and `watch_tags` references neither `user_media` nor `rankings`, so
 * "no effect on the tagged user's collection" has no column to violate. What is
 * testable, and what these tests are about, is everything the table cannot express:
 * who may tag whom, the cap, and the asymmetry between the tagger's control and the
 * tagged person's.
 */

let t;
let alice; // the tagger
let bob; // follows alice, so taggable
let seq = 50000;

const movie = (title) => t.createMovie(title, seq++);

const follow = (a, b) =>
  t.sql(`insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`, [a, b]);

/** A logged watch of `id` by the acting user, which a tag requires. */
const logWatch = (id) =>
  t.sql(`select log_watched(gen_random_uuid(), $1, null, null)`, [id]);

const setTags = async (mediaItemId, tagged) => {
  const { rows } = await t.sql(`select set_watch_tags(gen_random_uuid(), $1, $2::uuid[]) as r`, [
    mediaItemId,
    tagged,
  ]);
  return rows[0].r;
};

const tagsOn = async (mediaItemId, tagger = alice) => {
  const { rows } = await t.sql(
    `select id, tagged_id, removed_by_tagged from watch_tags
      where tagger_id = $1 and media_item_id = $2 order by created_at`,
    [tagger, mediaItemId],
  );
  return rows;
};

before(async () => {
  t = await createTestDb();
  alice = await t.createUser({ username: 'alice_tag' });
  bob = await t.createUser({ username: 'bob_tag' });
  await follow(bob, alice); // bob follows alice
  await t.actAs(alice);
});

after(async () => {
  await t?.close();
});

describe('who may be tagged', () => {
  it('accepts someone who follows the tagger', async () => {
    const id = await movie('tag_follower');
    await logWatch(id);

    assert.equal((await setTags(id, [bob])).tagged, 1);
    assert.deepEqual(
      (await tagsOn(id)).map((r) => r.tagged_id),
      [bob],
    );
  });

  it('accepts someone the tagger follows', async () => {
    const carol = await t.createUser({ username: 'carol_tag' });
    await follow(alice, carol);
    const id = await movie('tag_followee');
    await logWatch(id);

    assert.equal((await setTags(id, [carol])).tagged, 1);
  });

  it('refuses a stranger', async () => {
    const dave = await t.createUser({ username: 'dave_tag' });
    const id = await movie('tag_stranger');
    await logWatch(id);

    const error = await t.errorFrom(`select set_watch_tags(gen_random_uuid(), $1, $2::uuid[])`, [
      id,
      [dave],
    ]);
    assert.equal(error?.code, '42501');
    assert.deepEqual(await tagsOn(id), [], 'and nothing was written');
  });

  it('refuses a pending follow request, which is not a follow', async () => {
    // Otherwise requesting a private account would be a way into their inbox
    // before they had let you in.
    const erin = await t.createUser({ username: 'erin_tag', visibility: 'private' });
    await t.sql(
      `insert into follows (follower_id, followee_id, state) values ($1, $2, 'pending')`,
      [alice, erin],
    );
    const id = await movie('tag_pending');
    await logWatch(id);

    assert.equal(
      (await t.errorFrom(`select set_watch_tags(gen_random_uuid(), $1, $2::uuid[])`, [id, [erin]]))
        ?.code,
      '42501',
    );
  });

  it('refuses across a block, in either direction', async () => {
    const frank = await t.createUser({ username: 'frank_tag' });
    await follow(frank, alice);
    const id = await movie('tag_block');
    await logWatch(id);
    assert.equal((await setTags(id, [frank])).tagged, 1);

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [frank, alice]);
    const again = await movie('tag_block_after');
    await logWatch(again);
    assert.equal(
      (await t.errorFrom(`select set_watch_tags(gen_random_uuid(), $1, $2::uuid[])`, [
        again,
        [frank],
      ]))?.code,
      '42501',
    );

    const gina = await t.createUser({ username: 'gina_tag' });
    await follow(gina, alice);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [alice, gina]);
    assert.equal(
      (await t.errorFrom(`select set_watch_tags(gen_random_uuid(), $1, $2::uuid[])`, [
        again,
        [gina],
      ]))?.code,
      '42501',
    );
  });

  it('refuses a suspended account', async () => {
    const hank = await t.createUser({ username: 'hank_tag' });
    await follow(hank, alice);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [hank]);
    const id = await movie('tag_suspended');
    await logWatch(id);

    assert.equal(
      (await t.errorFrom(`select set_watch_tags(gen_random_uuid(), $1, $2::uuid[])`, [id, [hank]]))
        ?.code,
      '42501',
    );
  });

  it('refuses tagging yourself', async () => {
    const id = await movie('tag_self');
    await logWatch(id);

    assert.equal(
      (await t.errorFrom(`select set_watch_tags(gen_random_uuid(), $1, $2::uuid[])`, [id, [alice]]))
        ?.code,
      '42501',
    );
  });

  it('refuses the whole call rather than dropping the one bad name', async () => {
    // Partial application would leave the picker showing a tag that does not
    // exist, and the screen would agree until it next reloaded.
    const ida = await t.createUser({ username: 'ida_tag' });
    const id = await movie('tag_partial');
    await logWatch(id);

    await t.errorFrom(`select set_watch_tags(gen_random_uuid(), $1, $2::uuid[])`, [id, [bob, ida]]);
    assert.deepEqual(await tagsOn(id), []);
  });
});

describe('the shape of the call', () => {
  it('needs a watch to hang the tag on', async () => {
    const id = await movie('tag_unlogged');
    const error = await t.errorFrom(`select set_watch_tags(gen_random_uuid(), $1, $2::uuid[])`, [
      id,
      [bob],
    ]);
    assert.equal(error?.code, 'P0002');
  });

  it('clears the list on an empty array and refuses a null one', async () => {
    const id = await movie('tag_clear');
    await logWatch(id);
    await setTags(id, [bob]);
    assert.equal((await tagsOn(id)).length, 1);

    await setTags(id, []);
    assert.deepEqual(await tagsOn(id), []);

    // Null is a client bug, not an instruction. Treating it as empty would let an
    // omitted field silently erase somebody's companions.
    assert.equal(
      (await t.errorFrom(`select set_watch_tags(gen_random_uuid(), $1, null::uuid[])`, [id]))?.code,
      '22023',
    );
  });

  it('counts a repeated name once', async () => {
    const id = await movie('tag_duplicate');
    await logWatch(id);

    assert.equal((await setTags(id, [bob, bob, bob])).tagged, 1);
    assert.equal((await tagsOn(id)).length, 1);
  });

  it('caps the list at the configured maximum', async () => {
    const id = await movie('tag_cap');
    await logWatch(id);
    const many = [];
    for (let i = 0; i < 11; i += 1) {
      const friend = await t.createUser({ username: `cap_friend_${i}` });
      await follow(friend, alice);
      many.push(friend);
    }

    const error = await t.errorFrom(`select set_watch_tags(gen_random_uuid(), $1, $2::uuid[])`, [
      id,
      many,
    ]);
    assert.equal(error?.code, '22023');
    assert.match(error?.message ?? '', /up to 10/);

    assert.equal((await setTags(id, many.slice(0, 10))).tagged, 10);
  });

  it('replaces rather than accumulating', async () => {
    const jack = await t.createUser({ username: 'jack_tag' });
    await follow(jack, alice);
    const id = await movie('tag_replace');
    await logWatch(id);

    await setTags(id, [bob, jack]);
    await setTags(id, [jack]);

    assert.deepEqual(
      (await tagsOn(id)).map((r) => r.tagged_id),
      [jack],
    );
  });

  it('treats a repeated operation id as the retry it is', async () => {
    const id = await movie('tag_idempotent');
    await logWatch(id);
    const { rows } = await t.sql(`select gen_random_uuid() as op`);

    await t.sql(`select set_watch_tags($1, $2, $3::uuid[])`, [rows[0].op, id, [bob]]);
    const second = await t.sql(`select set_watch_tags($1, $2, $3::uuid[]) as r`, [
      rows[0].op,
      id,
      [],
    ]);

    assert.equal(second.rows[0].r.status, 'already_applied');
    assert.equal((await tagsOn(id)).length, 1, 'the replay did not clear the list');
  });
});

describe('the tagged person’s side', () => {
  it('hides a tag without altering the tagger’s log', async () => {
    const id = await movie('tag_hide');
    await logWatch(id);
    await setTags(id, [bob]);
    const [tag] = await tagsOn(id);

    await t.actAs(bob);
    await t.sql(`select hide_watch_tag(gen_random_uuid(), $1)`, [tag.id]);
    await t.actAs(alice);

    const [after] = await tagsOn(id);
    assert.equal(after.removed_by_tagged, true);
    assert.equal(after.tagged_id, bob, 'the row is still on the tagger’s watch');
  });

  it('cannot be reversed by the tagger re-saving the same list', async () => {
    // `do nothing` rather than `do update` on the upsert. Otherwise reopening the
    // picker and pressing save would un-hide a tag the tagged person hid, which is
    // the one party PRD §14 says cannot reverse it.
    const id = await movie('tag_unhide');
    await logWatch(id);
    await setTags(id, [bob]);
    const [tag] = await tagsOn(id);
    await t.actAs(bob);
    await t.sql(`select hide_watch_tag(gen_random_uuid(), $1)`, [tag.id]);
    await t.actAs(alice);

    await setTags(id, [bob]);
    assert.equal((await tagsOn(id))[0].removed_by_tagged, true);
  });

  it('cannot hide a tag pointed at somebody else', async () => {
    const kate = await t.createUser({ username: 'kate_tag' });
    await follow(kate, alice);
    const id = await movie('tag_not_yours');
    await logWatch(id);
    await setTags(id, [kate]);
    const [tag] = await tagsOn(id);

    await t.actAs(bob);
    const error = await t.errorFrom(`select hide_watch_tag(gen_random_uuid(), $1)`, [tag.id]);
    await t.actAs(alice);

    assert.equal(error?.code, 'P0002', 'reported as absent, not as forbidden');
    assert.equal((await tagsOn(id))[0].removed_by_tagged, false);
  });

  it('reports a tag that does not exist exactly as one that is not theirs', async () => {
    const { rows } = await t.sql(`select gen_random_uuid() as id`);
    await t.actAs(bob);
    const missing = await t.errorFrom(`select hide_watch_tag(gen_random_uuid(), $1)`, [rows[0].id]);
    await t.actAs(alice);

    assert.equal(missing?.code, 'P0002');
  });
});

describe('what a tag does not do', () => {
  it('puts nothing in the tagged person’s collection', async () => {
    const id = await movie('tag_no_collection');
    await logWatch(id);
    await setTags(id, [bob]);

    const { rows: media } = await t.sql(
      `select 1 from user_media where user_id = $1 and media_item_id = $2`,
      [bob, id],
    );
    const { rows: ranked } = await t.sql(
      `select 1 from rankings where user_id = $1 and media_item_id = $2`,
      [bob, id],
    );
    const { rows: list } = await t.sql(
      `select 1 from watchlist where user_id = $1 and media_item_id = $2`,
      [bob, id],
    );

    assert.equal(media.length, 0);
    assert.equal(ranked.length, 0);
    assert.equal(list.length, 0);
  });

  it('cannot be written directly by a client', async () => {
    const id = await movie('tag_no_policy');
    await logWatch(id);

    const error = await t.asUser(alice, () =>
      t.errorFrom(
        `insert into watch_tags (tagger_id, tagged_id, media_item_id) values ($1, $2, $3)`,
        [alice, bob, id],
      ),
    );
    await t.actAs(alice);
    assert.ok(error, 'watch_tags has no insert policy and client roles have no privileges');
  });
});

describe('who can see a tag', () => {
  it('is visible to the tagger, the tagged person, and the tagger’s audience', async () => {
    const id = await movie('tag_visible');
    await logWatch(id);
    await setTags(id, [bob]);

    for (const viewer of [alice, bob]) {
      const rows = await t.asUser(viewer, () =>
        t.sql(`select id from watch_tags where media_item_id = $1`, [id]),
      );
      await t.actAs(alice);
      assert.equal(rows.rows.length, 1, `visible to ${viewer === alice ? 'tagger' : 'tagged'}`);
    }

    const stranger = await t.createUser({ username: 'nosy_tag' });
    const seen = await t.asUser(stranger, () =>
      t.sql(`select id from watch_tags where media_item_id = $1`, [id]),
    );
    await t.actAs(alice);
    // Alice is public, so her tags are public. This is PRD §14's "tags inherit the
    // tagger's profile visibility", and the next test is the other half of it.
    assert.equal(seen.rows.length, 1);
  });

  it('disappears from everyone else once the tagged person hides it', async () => {
    const id = await movie('tag_hidden_from_others');
    await logWatch(id);
    await setTags(id, [bob]);
    const [tag] = await tagsOn(id);
    await t.actAs(bob);
    await t.sql(`select hide_watch_tag(gen_random_uuid(), $1)`, [tag.id]);
    await t.actAs(alice);

    const stranger = await t.createUser({ username: 'nosy_hidden_tag' });
    const seen = await t.asUser(stranger, () =>
      t.sql(`select id from watch_tags where media_item_id = $1`, [id]),
    );
    await t.actAs(alice);
    assert.equal(seen.rows.length, 0);

    // But both parties still see it: the tagger's log is unaltered, and the tagged
    // person needs to be able to find what they hid.
    for (const viewer of [alice, bob]) {
      const rows = await t.asUser(viewer, () =>
        t.sql(`select id from watch_tags where media_item_id = $1`, [id]),
      );
      await t.actAs(alice);
      assert.equal(rows.rows.length, 1);
    }
  });

  it('is hidden from a private tagger’s non-followers', async () => {
    const quiet = await t.createUser({ username: 'quiet_tag', visibility: 'private' });
    const friend = await t.createUser({ username: 'quiet_friend' });
    await follow(friend, quiet);
    const id = await movie('tag_private_tagger');
    await t.actAs(quiet);
    await logWatch(id);
    await t.sql(`select set_watch_tags(gen_random_uuid(), $1, $2::uuid[])`, [id, [friend]]);
    await t.actAs(alice);

    const stranger = await t.createUser({ username: 'nosy_private_tag' });
    const seen = await t.asUser(stranger, () =>
      t.sql(`select id from watch_tags where media_item_id = $1`, [id]),
    );
    await t.actAs(alice);
    assert.equal(seen.rows.length, 0);
  });
});

describe('what the tagged person is told', () => {
  it('files one inbox row per new tag', async () => {
    const id = await movie('tag_notify');
    await logWatch(id);
    await setTags(id, [bob]);

    const { rows } = await t.sql(
      `select recipient_id, actor_id, type from notifications
        where subject_id = $1 and type = 'watch_tag'`,
      [id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].recipient_id, bob);
    assert.equal(rows[0].actor_id, alice);
  });

  it('does not ring again when the same list is saved twice', async () => {
    const id = await movie('tag_notify_once');
    await logWatch(id);
    await setTags(id, [bob]);
    await setTags(id, [bob]);
    await setTags(id, [bob]);

    const { rows } = await t.sql(
      `select count(*)::int as n from notifications where subject_id = $1 and type = 'watch_tag'`,
      [id],
    );
    assert.equal(rows[0].n, 1);
  });

  it('rings for a person newly added to an existing list, and not for the others', async () => {
    const liam = await t.createUser({ username: 'liam_tag' });
    await follow(liam, alice);
    const id = await movie('tag_notify_added');
    await logWatch(id);
    await setTags(id, [bob]);
    await setTags(id, [bob, liam]);

    const { rows } = await t.sql(
      `select recipient_id from notifications where subject_id = $1 and type = 'watch_tag'
        order by created_at`,
      [id],
    );
    assert.deepEqual(rows.map((r) => r.recipient_id).sort(), [bob, liam].sort());
  });
});
