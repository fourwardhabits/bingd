import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * rank_cancel.
 *
 * The function api.md §2 has always described and nobody wrote. It went unnoticed because
 * nothing called it — there was no comparison screen, so nothing needed a way out of a
 * session. What matters is that cancelling ends the session and costs the user nothing
 * else: the bucket survives, the title stays Logged, and the answers already given stay,
 * because they were real judgements.
 */

let t;
let user;

const rpc = async (query, params) => (await t.sql(query, params)).rows[0].r;

before(async () => {
  t = await createTestDb();
  user = await t.createUser({ username: 'canceller' });
  await t.actAs(user);
});

after(async () => t?.close());

let seq = 90000;
const movie = (title) => t.createMovie(title, seq++);

/** A band with enough members that starting a session opens comparisons. */
const populate = async (count) => {
  for (let i = 0; i < count; i += 1) {
    const id = await movie(`cancel_base_${seq}_${i}`);
    await t.rankToCompletion(id, 'loved', async (pivot) => pivot);
  }
};

const sessionCount = async () => {
  const { rows } = await t.sql(
    `select count(*)::int as n from ranking_sessions where user_id = $1`,
    [user],
  );
  return rows[0].n;
};

describe('rank_cancel', () => {
  it('ends the session', async () => {
    await populate(3);
    const subject = await movie('cancel_subject');
    const started = await rpc(`select rank_start($1, 'loved') as r`, [subject]);

    assert.equal(started.done, false, 'the fixture must actually open a session');
    const before = await sessionCount();

    const cancelled = await rpc(`select rank_cancel($1) as r`, [started.session_id]);
    assert.deepEqual(cancelled, { done: true, cancelled: true });
    assert.equal(await sessionCount(), before - 1);
  });

  it('leaves the title Logged with its bucket, and unranked', async () => {
    const subject = await movie('cancel_keeps_bucket');
    const started = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    await rpc(`select rank_cancel($1) as r`, [started.session_id]);

    const { rows } = await t.sql(
      `select um.bucket, r.position
         from user_media um
         left join rankings r on r.user_id = um.user_id and r.media_item_id = um.media_item_id
        where um.user_id = $1 and um.media_item_id = $2`,
      [user, subject],
    );

    assert.equal(rows[0].bucket, 'loved', 'the bucket is the user\u2019s opinion, not the session\u2019s');
    assert.equal(rows[0].position, null, 'and cancelling must not leave a position behind');
  });

  it('keeps the comparisons already answered', async () => {
    // They are real judgements the user made about two titles. PRD §10 keeps them, and
    // discarding them would make an abandoned session cost more than it should.
    const subject = await movie('cancel_keeps_comparisons');
    const started = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    const answered = await rpc(`select rank_answer($1, $2) as r`, [
      started.session_id,
      started.pivot,
    ]);

    const { rows: before } = await t.sql(
      `select count(*)::int as n from comparisons where user_id = $1`,
      [user],
    );
    assert.ok(before[0].n > 0, 'the fixture must have recorded a comparison');

    if (!answered.done) await rpc(`select rank_cancel($1) as r`, [started.session_id]);

    const { rows: after } = await t.sql(
      `select count(*)::int as n from comparisons where user_id = $1`,
      [user],
    );
    assert.equal(after[0].n, before[0].n);
  });

  it('lets the same title be started fresh afterwards, rather than resuming', async () => {
    // The reason this exists at all. rank_start resumes an open session, so an abandoned
    // one would reappear mid-search the next time that title was ranked, with no
    // explanation to the user of why they were being asked again.
    const subject = await movie('cancel_then_restart');
    const first = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    await rpc(`select rank_cancel($1) as r`, [first.session_id]);

    const second = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    assert.notEqual(second.session_id, first.session_id);
    assert.ok(!second.resumed, 'a cancelled session must not come back');

    if (!second.done) await rpc(`select rank_cancel($1) as r`, [second.session_id]);
  });

  it('refuses a session that is not the caller\u2019s, as absent rather than forbidden', async () => {
    const subject = await movie('cancel_other_user');
    const started = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    const before = await sessionCount();

    const stranger = await t.createUser({ username: 'stranger' });
    await t.actAs(stranger);
    const err = await t.errorFrom(`select rank_cancel($1)`, [started.session_id]);
    await t.actAs(user);

    assert.ok(err, 'another account must not be able to cancel this session');
    // Not "forbidden": distinguishing the two tells a guesser that the id exists.
    assert.match(err.message, /no such ranking session/);
    assert.equal(await sessionCount(), before, 'and the session must still be there');

    await rpc(`select rank_cancel($1) as r`, [started.session_id]);
  });

  it('refuses an id that never existed', async () => {
    const err = await t.errorFrom(`select rank_cancel($1)`, [
      '00000000-0000-4000-8000-000000000000',
    ]);
    assert.ok(err);
    assert.match(err.message, /no such ranking session/);
    // The code, not just the wording: session.ts treats P0002 as success, on the grounds
    // that a session already gone is the outcome the caller asked for. Every other test in
    // this file matches on the message, which a change of SQLSTATE would leave untouched.
    assert.equal(err.code, 'P0002', 'the client keys its already-gone tolerance off this');
  });

  it('is callable by a real authenticated client, not only by the owner', async () => {
    // Every test above runs through actAs, which stays the table owner. `authenticated`
    // holds SELECT on ranking_sessions and nothing else, so a rank_cancel that lost its
    // security definer would fail with "permission denied" for every real client while
    // this whole file stayed green.
    const subject = await movie('cancel_as_authenticated');
    const started = await rpc(`select rank_start($1, 'loved') as r`, [subject]);
    assert.equal(started.done, false, 'the fixture must actually open a session');
    const before = await sessionCount();

    const cancelled = await t.asUser(user, async () => {
      const { rows } = await t.sql(`select rank_cancel($1) as r`, [started.session_id]);
      return rows[0].r;
    });

    assert.deepEqual(cancelled, { done: true, cancelled: true });
    assert.equal(await sessionCount(), before - 1, 'and the session is gone for good');
  });

  it('is guarded, so a suspended account cannot call it', async () => {
    const subject = await movie('cancel_suspended');
    const started = await rpc(`select rank_start($1, 'loved') as r`, [subject]);

    await t.sql(`update profiles set status = 'suspended' where id = $1`, [user]);
    const err = await t.errorFrom(`select rank_cancel($1)`, [started.session_id]);
    await t.sql(`update profiles set status = 'active' where id = $1`, [user]);

    assert.ok(err, 'assert_can_write must run before the delete');
    assert.match(err.message, /suspend/i);

    await rpc(`select rank_cancel($1) as r`, [started.session_id]);
  });

  it('is not executable by anon', async () => {
    await t.asAnon(async () => {
      const err = await t.errorFrom(`select rank_cancel($1)`, [
        '00000000-0000-4000-8000-000000000000',
      ]);
      assert.ok(err);
      assert.match(err.message, /permission denied/i);
    });
  });
});
