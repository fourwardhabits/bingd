import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * A recommendation that says why (20260929000100).
 *
 * The note is one column, and nearly every assertion here is about who may read it. The
 * reads therefore go through `viewAs` — a real `authenticated` role, so RLS and the column
 * grant apply — because an owner-run query bypasses both and would pass against a policy
 * that leaked every pending note.
 */

let t;
let seq = 97000;
let sender;
let recipient;

const movie = (title) => t.createMovie(title, seq++);

const followRow = (a, b) =>
  t.sql(
    `insert into follows (follower_id, followee_id, state, approved_at)
     values ($1, $2, 'approved', now())
     on conflict (follower_id, followee_id) do update set state = 'approved'`,
    [a, b],
  );

const as = async (who, fn) => {
  await t.actAs(who);
  try {
    return await fn();
  } finally {
    await t.actAs(sender);
  }
};

const viewAs = async (who, fn) => {
  try {
    return await t.asUser(who, fn);
  } finally {
    await t.actAs(sender);
  }
};

const send = (from, to, mediaItemId, message) =>
  as(from, async () => {
    const { rows } =
      message === undefined
        ? await t.sql(`select recommend_title(gen_random_uuid(), $1, $2) as r`, [
            to,
            mediaItemId,
          ])
        : await t.sql(`select recommend_title(gen_random_uuid(), $1, $2, $3) as r`, [
            to,
            mediaItemId,
            message,
          ]);
    return rows[0].r;
  });

const sentToYou = (who) =>
  viewAs(who, async () => (await t.sql(`select * from recommendations_to_me(200)`)).rows);

const forTitle = (who, mediaItemId) =>
  viewAs(
    who,
    async () =>
      (await t.sql(`select * from title_recommendations_for_me($1)`, [mediaItemId])).rows,
  );

const storedMessage = async (id) =>
  (await t.sql(`select message from title_recommendations where id = $1`, [id])).rows[0]
    ?.message ?? null;

const operationCount = async (who) =>
  Number(
    (
      await t.sql(
        `select count(*) as n from processed_operations
          where user_id = $1 and kind = 'recommend_title'`,
        [who],
      )
    ).rows[0].n,
  );

const report = (who, id) =>
  viewAs(who, () =>
    t.sql(`select report('recommendation'::report_subject, $1, 'harassment') as r`, [id]),
  );

before(async () => {
  t = await createTestDb();
  await t.sql(
    `update app_config set value = '10000'::jsonb where key like 'recommendations.max_per_%'`,
  );
});

after(async () => {
  await t?.close();
});

beforeEach(async () => {
  sender = await t.createUser({ username: `ns${seq++}` });
  recipient = await t.createUser({ username: `nr${seq++}` });
  await followRow(sender, recipient);
  await followRow(recipient, sender); // delivered unless a test says otherwise
  await t.actAs(sender);
});

describe('writing a note', () => {
  it('stores the note normalised to one trimmed paragraph', async () => {
    const r = await send(
      sender,
      recipient,
      await movie('n_norm'),
      '  You have\n\nto   watch\tthis.  ',
    );
    assert.equal(r.status, 'ok');
    assert.equal(await storedMessage(r.id), 'You have to watch this.');
  });

  it('stores an all-blank note as no note', async () => {
    const r = await send(sender, recipient, await movie('n_blank'), ' \n\t ');
    assert.equal(await storedMessage(r.id), null);
  });

  it('accepts exactly 140 characters, counting characters rather than bytes', async () => {
    const note = 'é'.repeat(140);
    const r = await send(sender, recipient, await movie('n_140'), note);
    assert.equal(r.status, 'ok');
    assert.equal(await storedMessage(r.id), note);
  });

  it('refuses 141 characters with 22023, before the claim, storing nothing', async () => {
    const id = await movie('n_141');
    const before = await operationCount(sender);

    const error = await as(sender, () =>
      t.errorFrom(`select recommend_title(gen_random_uuid(), $1, $2, $3)`, [
        recipient,
        id,
        'x'.repeat(141),
      ]),
    );
    assert.equal(error?.code, '22023');
    assert.equal(await operationCount(sender), before, 'a malformed note spends no quota');

    const { rows } = await t.sql(
      `select 1 from title_recommendations where media_item_id = $1`,
      [id],
    );
    assert.equal(rows.length, 0);
  });

  it('refuses a control character that is not whitespace', async () => {
    const error = await as(sender, () =>
      t.errorFrom(`select recommend_title(gen_random_uuid(), $1, $2, $3)`, [
        recipient,
        null,
        `ring${String.fromCharCode(7)}the bell`,
      ]),
    );
    assert.equal(error?.code, '22023');
  });

  it('keeps the three-argument signature every shipped binary calls, with no note', async () => {
    const r = await send(sender, recipient, await movie('n_legacy'));
    assert.equal(r.status, 'ok');
    assert.equal(r.delivered, true);
    assert.equal(await storedMessage(r.id), null);
  });

  it('refuses a malformed note stored by any writer, structurally', async () => {
    const r = await send(sender, recipient, await movie('n_check'));
    const error = await t.errorFrom(
      `update title_recommendations set message = ' padded ' where id = $1`,
      [r.id],
    );
    assert.equal(error?.code, '23514');
  });
});

describe('resending', () => {
  it('replaces the note when the resend carries one, and files no second notification', async () => {
    const id = await movie('n_resend');
    const first = await send(sender, recipient, id, 'The first half is slow.');
    await viewAs(recipient, () => t.sql(`select mark_recommendation_opened($1)`, [first.id]));

    const second = await send(sender, recipient, id, 'You have to watch this before Saturday.');
    assert.equal(second.id, first.id, 'still one row per pair and title');
    assert.equal(await storedMessage(first.id), 'You have to watch this before Saturday.');

    const { rows } = await t.sql(`select opened_at from title_recommendations where id = $1`, [
      first.id,
    ]);
    assert.notEqual(rows[0].opened_at, null, 'a resend never makes it unread again');

    const notices = await t.sql(
      `select 1 from notifications where recipient_id = $1 and type = 'recommendation'`,
      [recipient],
    );
    assert.equal(notices.rows.length, 1, 'the anti-ping rule holds for a new note too');
  });

  it('keeps the note when the resend has none, by either signature', async () => {
    const id = await movie('n_keep');
    const first = await send(sender, recipient, id, 'The second half is insane.');

    await send(sender, recipient, id);
    assert.equal(await storedMessage(first.id), 'The second half is insane.');

    await send(sender, recipient, id, '   ');
    assert.equal(await storedMessage(first.id), 'The second half is insane.');
  });
});

describe('who may read a note', () => {
  it('shows a delivered note to its recipient in Sent to you and on the title', async () => {
    const id = await movie('n_read');
    await send(sender, recipient, id, 'This is the movie I was talking about.');

    const list = await sentToYou(recipient);
    assert.equal(list.length, 1);
    assert.equal(list[0].message, 'This is the movie I was talking about.');

    const page = await forTitle(recipient, id);
    assert.equal(page.length, 1);
    assert.equal(page[0].message, 'This is the movie I was talking about.');
    assert.equal(page[0].sender_id, sender);
  });

  it('lets the sender read their own note directly', async () => {
    const r = await send(sender, recipient, await movie('n_sender'), 'Mine.');
    const rows = await viewAs(
      sender,
      async () =>
        (await t.sql(`select message from title_recommendations where id = $1`, [r.id])).rows,
    );
    assert.equal(rows[0]?.message, 'Mine.');
  });

  it('shows a third party nothing, by any path', async () => {
    const stranger = await t.createUser({ username: `nx${seq++}` });
    const id = await movie('n_third');
    const r = await send(sender, recipient, id, 'Private.');

    const direct = await viewAs(
      stranger,
      async () =>
        (await t.sql(`select message from title_recommendations where id = $1`, [r.id])).rows,
    );
    assert.equal(direct.length, 0);
    assert.equal((await forTitle(stranger, id)).length, 0);
    assert.equal((await sentToYou(stranger)).length, 0);
  });

  it('hides a pending note from its recipient by every path until it is added', async () => {
    // One-way: the recipient does not follow back, so the send is held as a request.
    await t.sql(`delete from follows where follower_id = $1 and followee_id = $2`, [
      recipient,
      sender,
    ]);
    const id = await movie('n_pending');
    const r = await send(sender, recipient, id, 'From somebody you have not followed back.');
    assert.equal(r.delivered, false);

    const direct = await viewAs(
      recipient,
      async () =>
        (await t.sql(`select message from title_recommendations where id = $1`, [r.id])).rows,
    );
    assert.equal(direct.length, 0, 'the recipient policy admits no pending row');
    assert.equal((await sentToYou(recipient)).length, 0);
    assert.equal((await forTitle(recipient, id)).length, 0);

    const requests = await viewAs(
      recipient,
      async () => (await t.sql(`select * from recommendation_requests(100)`)).rows,
    );
    assert.equal(requests.length, 1);
    assert.equal('message' in requests[0], false, 'the Requests read never carries the note');

    await viewAs(recipient, () => t.sql(`select add_recommendation($1)`, [r.id]));
    const page = await forTitle(recipient, id);
    assert.equal(page[0]?.message, 'From somebody you have not followed back.');
  });

  it('hides a delivered note while a block stands, and shows it again after', async () => {
    const id = await movie('n_block');
    await send(sender, recipient, id, 'Before the block.');

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [
      recipient,
      sender,
    ]);
    assert.equal((await sentToYou(recipient)).length, 0);
    assert.equal((await forTitle(recipient, id)).length, 0);

    await t.sql(`delete from blocks where blocker_id = $1 and blocked_id = $2`, [
      recipient,
      sender,
    ]);
    assert.equal((await forTitle(recipient, id))[0]?.message, 'Before the block.');
  });

  it('deletes a pending note when either party blocks', async () => {
    await t.sql(`delete from follows where follower_id = $1 and followee_id = $2`, [
      recipient,
      sender,
    ]);
    const r = await send(sender, recipient, await movie('n_block_pending'), 'Held.');

    await as(recipient, () => t.sql(`select block(gen_random_uuid(), $1)`, [sender]));
    const { rows } = await t.sql(`select 1 from title_recommendations where id = $1`, [r.id]);
    assert.equal(rows.length, 0);
  });

  it('disappears with a deleted account', async () => {
    const r = await send(sender, recipient, await movie('n_account'), 'Gone with me.');
    await t.sql(`delete from profiles where id = $1`, [sender]);
    const { rows } = await t.sql(`select 1 from title_recommendations where id = $1`, [r.id]);
    assert.equal(rows.length, 0);
  });
});

describe('the title page lookup', () => {
  it('answers only for the exact item, newest first, at most ten', async () => {
    const series = await t.createSeries('n_series', seq++);
    const season = await t.createSeason(series, 1, 'Season 1');

    const others = [];
    for (let i = 0; i < 11; i += 1) {
      const friend = await t.createUser({ username: `nf${seq++}` });
      await followRow(friend, recipient);
      await followRow(recipient, friend);
      others.push(friend);
    }
    for (const [i, friend] of others.entries()) {
      await send(friend, recipient, season, `note ${i}`);
      await t.sql(
        `update title_recommendations set recommended_at = now() - make_interval(mins => $2)
          where sender_id = $1 and media_item_id = $3`,
        [friend, 100 - i, season],
      );
    }

    const page = await forTitle(recipient, season);
    assert.equal(page.length, 10);
    assert.equal(page[0].message, 'note 10', 'newest first');
    assert.equal((await forTitle(recipient, series)).length, 0, 'never the parent series');
  });

  it('drops a suspended sender', async () => {
    const id = await movie('n_suspended');
    await send(sender, recipient, id, 'Suspended soon.');
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [sender]);
    assert.equal((await forTitle(recipient, id)).length, 0);
  });

  it('is not executable by anon', async () => {
    const error = await t.asAnon(() =>
      t.errorFrom(`select * from title_recommendations_for_me(gen_random_uuid())`),
    );
    assert.equal(error?.code, '42501');
  });
});

describe('reporting a note', () => {
  it('lets the recipient report it, attributed to the sender', async () => {
    const r = await send(sender, recipient, await movie('n_report'), 'Something unkind.');

    await report(recipient, r.id);
    const { rows } = await t.sql(
      `select subject_owner, reporter_id from reports
        where subject_type = 'recommendation' and subject_id = $1`,
      [r.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subject_owner, sender);
    assert.equal(rows[0].reporter_id, recipient);
  });

  it('keeps one open report per reporter', async () => {
    const r = await send(sender, recipient, await movie('n_report_twice'), 'Twice.');
    await report(recipient, r.id);
    await report(recipient, r.id);
    const { rows } = await t.sql(`select 1 from reports where subject_id = $1`, [r.id]);
    assert.equal(rows.length, 1);
  });

  it('refuses a third party, the sender, and a recommendation with no note', async () => {
    const stranger = await t.createUser({ username: `ny${seq++}` });
    const noted = await send(sender, recipient, await movie('n_report_refuse'), 'Noted.');
    const bare = await send(sender, recipient, await movie('n_report_bare'));

    for (const [who, id] of [
      [stranger, noted.id],
      [sender, noted.id],
      [recipient, bare.id],
    ]) {
      const error = await viewAs(who, () =>
        t.errorFrom(`select report('recommendation'::report_subject, $1, 'spam')`, [id]),
      );
      assert.equal(error?.code, 'P0002');
    }
  });

  it('refuses a pending note, which its recipient has never been shown', async () => {
    await t.sql(`delete from follows where follower_id = $1 and followee_id = $2`, [
      recipient,
      sender,
    ]);
    const r = await send(sender, recipient, await movie('n_report_pending'), 'Unseen.');
    assert.equal(r.delivered, false);

    const error = await viewAs(recipient, () =>
      t.errorFrom(`select report('recommendation'::report_subject, $1, 'spam')`, [r.id]),
    );
    assert.equal(error?.code, 'P0002');
  });

  it('still lets the recipient report after blocking the sender', async () => {
    const r = await send(sender, recipient, await movie('n_report_blocked'), 'Then blocked.');
    await as(recipient, () => t.sql(`select block(gen_random_uuid(), $1)`, [sender]));

    await report(recipient, r.id);
    const { rows } = await t.sql(`select 1 from reports where subject_id = $1`, [r.id]);
    assert.equal(rows.length, 1, 'a block must not make the abuser unreportable');
  });
});
