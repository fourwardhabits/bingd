import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { createTestDb, createTestDbBefore } from './harness.mjs';

/**
 * `comment_reactions` after 20260827000500: the same six meanings an activity takes.
 *
 * The migration overturns a decision 20260826000600 made on purpose — a comment used to
 * carry a boolean like, because the six meanings were held to be about a whole activity
 * rather than a remark about one. The founder overturned it on a device: holding the
 * control offered six on a feed row and nothing on a comment one swipe away, and the
 * same gesture doing different things in two places is the inconsistency.
 *
 * What is pinned here, in order of what it would cost to lose:
 *
 *   1. **Every existing heart survives as `love`.** This is the only irreversible part
 *      of the migration, and it is tested against a database in the state that actually
 *      had hearts in it — see `createTestDbBefore`.
 *   2. **One reaction per person per comment**, so changing your mind is an update and
 *      never a second row.
 *   3. **The privacy rule is unchanged**: a reaction from somebody the reader may not
 *      see is absent from the count, from the glyphs and from "mine" — all three, since
 *      they now come from one filtered set.
 *   4. **The boolean signature still works**, because an OTA reaches a phone on its next
 *      launch and the migration lands first.
 *   5. **Nothing notifies.** The inbox row `set_reaction` writes has no counterpart, and
 *      that difference is deliberate rather than pending.
 */

const MIGRATION = '20260827000500_one_reaction_wherever_it_is_attached.sql';

describe('comment reactions carry the six', () => {
  let t;
  let alice;
  let bob;
  let carol;
  let event;
  let comment;

  const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

  /** Sets `who`'s reaction on the shared comment, through the canonical signature. */
  const react = async (who, kind, target = comment) =>
    t.asUser(who, async () =>
      JSON.parse(
        (
          await t.sql(`select set_comment_reaction($1, $2, $3::text)::text as r`, [
            await uuid(),
            target,
            kind,
          ])
        ).rows[0].r,
      ),
    );

  /** One comment row as `activity_comments` returns it to `who`. */
  const rowFor = async (who, target = comment) =>
    t.asUser(who, async () =>
      (
        await t.sql(
          `select reaction_count, reacted_by_me, reaction_kinds, my_reaction
             from activity_comments($1) where id = $2`,
          [event, target],
        )
      ).rows[0],
    );

  before(async () => {
    t = await createTestDb();
    alice = await t.createUser({ username: 'alice' });
    bob = await t.createUser({ username: 'bob' });
    carol = await t.createUser({ username: 'carol' });

    const movie = await t.createMovie('Stalker', 920001);
    // The event is inserted directly, as every comment suite does: what is under test
    // is the reaction, and a ranking flow would only add ways for setup to fail.
    event = (
      await t.sql(
        `insert into feed_events (actor_id, type, media_item_id, payload)
         values ($1, 'title_ranked', $2, '{"position":1,"bucket":"loved","category":"movies","score":10}')
         returning id`,
        [alice, movie],
      )
    ).rows[0].id;

    await t.actAs(bob);
    comment = (
      await t.sql(`select (add_comment(gen_random_uuid(), $1, $2, false)->>'comment_id') as id`, [
        event,
        'The zone is a state of mind.',
      ])
    ).rows[0].id;
  });

  after(async () => t.close());

  it('stores a meaning rather than a flag', async () => {
    const result = await react(bob, 'funny');
    assert.equal(result.status, 'ok');
    assert.equal(result.kind, 'funny');

    const row = await rowFor(bob);
    assert.equal(row.reaction_count, 1);
    assert.equal(row.reacted_by_me, true);
    assert.equal(row.my_reaction, 'funny');
    assert.deepEqual(row.reaction_kinds, ['funny']);
  });

  it('changes a mind without minting a second row', async () => {
    await react(bob, 'wow');

    const row = await rowFor(bob);
    assert.equal(row.reaction_count, 1, 'still one reaction, not two');
    assert.equal(row.my_reaction, 'wow');
    assert.deepEqual(row.reaction_kinds, ['wow']);

    const { rows } = await t.sql(
      `select count(*)::int as n from comment_reactions where comment_id = $1 and user_id = $2`,
      [comment, bob],
    );
    assert.equal(rows[0].n, 1, 'the primary key is the invariant, not the client');
  });

  it('takes it back on a null kind, idempotently', async () => {
    assert.equal((await react(bob, null)).kind, null);
    let row = await rowFor(bob);
    assert.equal(row.reaction_count, 0);
    assert.equal(row.reacted_by_me, false);
    assert.equal(row.my_reaction, null);
    assert.deepEqual(row.reaction_kinds, []);

    // Removing nothing is not an error: removal is a state being reached.
    assert.equal((await react(bob, null)).kind, null);
    row = await rowFor(bob);
    assert.equal(row.reaction_count, 0);
  });

  it('refuses a meaning that is not one of the six', async () => {
    const error = await t.asUser(bob, () =>
      t.errorFrom(`select set_comment_reaction(gen_random_uuid(), $1, 'thumbsup'::text)`, [comment]),
    );
    assert.equal(error?.code, '22023', 'a field error the client can act on, not a 23514');
  });

  it('orders the glyphs most common first, and breaks ties stably', async () => {
    await react(alice, 'love');
    await react(bob, 'love');
    await react(carol, 'agree');

    const row = await rowFor(alice);
    assert.equal(row.reaction_count, 3);
    assert.deepEqual(row.reaction_kinds, ['love', 'agree'], 'two loves outrank one agree');
    assert.equal(row.my_reaction, 'love');
  });

  it('answers each reader about their own reaction, not somebody else’s', async () => {
    assert.equal((await rowFor(carol)).my_reaction, 'agree');
    assert.equal((await rowFor(bob)).my_reaction, 'love');
  });

  /**
   * The privacy rule, and the reason it is one assertion over three columns.
   *
   * Independent review 43 found the count including a blocked account's like, because
   * the count was a bare `count(*)` while the visibility join lived elsewhere. The
   * migration answers that by deriving the count, the glyphs and "mine" from one
   * filtered set — so this test checks all three rather than the number alone, which is
   * the assertion that would have caught the original defect.
   */
  it('leaves a blocked account out of the count, the glyphs and mine alike', async () => {
    // Its own third party rather than `carol`: a block is the one act in this file that
    // cannot be undone for later tests, and reusing a shared fixture here would make
    // every assertion below depend on this one having run.
    const dave = await t.createUser({ username: 'dave' });
    await react(dave, 'moved');

    const before = await rowFor(alice);
    assert.equal(before.reaction_count, 4);
    assert.ok(before.reaction_kinds.includes('moved'), 'CONTROL: dave’s reaction is visible');

    const blockId = await uuid();
    await t.asUser(alice, () => t.sql(`select block($1, $2)`, [blockId, dave]));

    const row = await rowFor(alice);
    assert.equal(row.reaction_count, 3, 'dave is absent rather than counted anonymously');
    assert.ok(!row.reaction_kinds.includes('moved'), 'and his meaning is gone from the cluster');

    // The row itself survives; it is the reading of it that is filtered.
    const { rows } = await t.sql(
      `select count(*)::int as n from comment_reactions where comment_id = $1`,
      [comment],
    );
    assert.equal(rows[0].n, 4, 'nothing was deleted — the filter is a read rule');
  });

  /**
   * The author predicate, which is the half a private *reader* would not exercise.
   *
   * Making the caller private proves nothing — a private account still sees public
   * activity. What must be refused is a caller the comment's **author** has blocked, and
   * it must be refused with the same P0002 a missing comment gets: telling "gone" apart
   * from "not for you" is the disclosure.
   */
  it('refuses a comment the caller may not see, the same way a missing one is refused', async () => {
    const stranger = await t.createUser({ username: 'stranger' });
    const blockId = await uuid();
    await t.asUser(bob, () => t.sql(`select block($1, $2)`, [blockId, stranger]));

    const refused = await t.asUser(stranger, () =>
      t.errorFrom(`select set_comment_reaction(gen_random_uuid(), $1, 'love'::text)`, [comment]),
    );
    const missing = await t.asUser(stranger, () =>
      t.errorFrom(`select set_comment_reaction(gen_random_uuid(), gen_random_uuid(), 'love'::text)`),
    );

    assert.equal(refused?.code, 'P0002');
    assert.equal(refused?.message, missing?.message, 'and indistinguishable from a missing one');
  });

  it('replays under one operation id without spending a second', async () => {
    const id = await uuid();
    const once = await t.asUser(bob, async () =>
      JSON.parse(
        (
          await t.sql(`select set_comment_reaction($1, $2, 'moved'::text)::text as r`, [id, comment])
        ).rows[0].r,
      ),
    );
    const twice = await t.asUser(bob, async () =>
      JSON.parse(
        (
          await t.sql(`select set_comment_reaction($1, $2, 'moved'::text)::text as r`, [id, comment])
        ).rows[0].r,
      ),
    );

    assert.equal(once.status, 'ok');
    assert.equal(twice.status, 'already_applied', 'the ledger answers, the row is not rewritten');
  });

  /**
   * The signature every published phone is still calling.
   *
   * An over-the-air update reaches a device on its next launch — hours or days — and the
   * migration lands first by the runbook's order. If this stopped working, the heart on
   * a comment would break for every tester who had not relaunched.
   */
  it('still answers the boolean signature, in the shape that caller expects', async () => {
    const on = await t.asUser(carol, async () =>
      JSON.parse(
        (
          await t.sql(`select set_comment_reaction($1, $2, true)::text as r`, [
            await uuid(),
            comment,
          ])
        ).rows[0].r,
      ),
    );
    assert.equal(on.status, 'ok');
    assert.equal(on.on, true, 'the old key, not the new one');

    // And it means the canonical heart, which is what the old control was pressing.
    const { rows } = await t.sql(
      `select kind from comment_reactions where comment_id = $1 and user_id = $2`,
      [comment, carol],
    );
    assert.equal(rows[0].kind, 'love');

    const off = await t.asUser(carol, async () =>
      JSON.parse(
        (
          await t.sql(`select set_comment_reaction($1, $2, false)::text as r`, [
            await uuid(),
            comment,
          ])
        ).rows[0].r,
      ),
    );
    assert.equal(off.on, false);
    assert.equal(
      (
        await t.sql(`select count(*)::int as n from comment_reactions where comment_id = $1 and user_id = $2`, [
          comment,
          carol,
        ])
      ).rows[0].n,
      0,
    );
  });

  /**
   * The difference that is deliberate.
   *
   * `set_reaction` writes a PRD §15 inbox row for the activity's actor. This writer does
   * not, and the founder's instruction for this tranche was explicit that unifying the
   * interaction must not widen the inbox. A later migration that adds one should have to
   * delete this test and say why.
   */
  it('writes no notification, which is the one thing it does not share with set_reaction', async () => {
    const before = (await t.sql(`select count(*)::int as n from notifications`)).rows[0].n;
    await react(carol, 'love');
    const now = (await t.sql(`select count(*)::int as n from notifications`)).rows[0].n;
    assert.equal(now, before, 'a comment reaction is silent, deliberately');
  });

  it('is not reachable through the internal helper, which claims nothing', async () => {
    const error = await t.asUser(bob, () =>
      t.errorFrom(`select _set_comment_reaction($1, 'love'::text)`, [comment]),
    );
    assert.equal(error?.code, '42501', 'no client role may call it');
  });
});

/**
 * The backfill, against a database that actually had hearts in it.
 *
 * `createTestDb` reloads a snapshot in which every migration has already run, so the
 * backfill has necessarily executed against an empty table — where it is a guaranteed
 * no-op that proves nothing. This is the one shape that can fail.
 */
describe('the hearts that already existed', () => {
  let t;

  after(async () => t?.close());

  it('become the canonical love, every one of them', async () => {
    t = await createTestDbBefore(MIGRATION);

    const alice = await t.createUser({ username: 'ally' });
    const bob = await t.createUser({ username: 'bobby' });
    const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

    const movie = await t.createMovie('Solaris', 920002);
    const event = (
      await t.sql(
        `insert into feed_events (actor_id, type, media_item_id, payload)
         values ($1, 'title_ranked', $2, '{"position":1,"bucket":"loved","category":"movies","score":10}')
         returning id`,
        [alice, movie],
      )
    ).rows[0].id;

    await t.actAs(bob);
    const comment = (
      await t.sql(`select (add_comment(gen_random_uuid(), $1, $2, false)->>'comment_id') as id`, [
        event,
        'Ocean as mirror.',
      ])
    ).rows[0].id;

    // Two hearts, pressed through the only signature that existed at this point.
    for (const who of [alice, bob]) {
      await t.actAs(who);
      await t.sql(`select set_comment_reaction(gen_random_uuid(), $1, true)`, [comment]);
    }

    const before = (await t.sql(`select count(*)::int as n from comment_reactions`)).rows[0].n;
    assert.equal(before, 2, 'CONTROL: two hearts exist before the migration runs');

    await t.applyMigration(MIGRATION);

    const { rows } = await t.sql(
      `select user_id, kind from comment_reactions where comment_id = $1 order by kind`,
      [comment],
    );
    assert.equal(rows.length, 2, 'no heart was dropped');
    assert.deepEqual(
      rows.map((r) => r.kind),
      ['love', 'love'],
      'and each one means the reaction the old control was pressing',
    );
  });
});
