import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Sent to You read state (20261121000100, FU1113-E).
 *
 * `seen_at` is "the recipient saw it listed", and it is deliberately the weaker sibling of
 * `opened_at`: it clears the tab's dot and the row's tint, and it touches nothing else —
 * not `opened_at`, not the order, not the state, not a notification.
 *
 * Every mark and every read below runs as a real `authenticated` role (`viewAs`), so the
 * grants are exercised exactly as a client meets them. Setup runs as the owner.
 */

let t;
let seq = 97000;
let sender;
let recipient;

const movie = (title) => t.createMovie(title, seq++);

const followRow = (a, b) =>
  t.sql(
    `insert into follows (follower_id, followee_id, state, approved_at)
     values ($1, $2, 'approved', now()) on conflict (follower_id, followee_id) do nothing`,
    [a, b],
  );

const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

const viewAs = async (who, fn) => {
  try {
    return await t.asUser(who, fn);
  } finally {
    await t.actAs(null);
  }
};

const send = async (from, to, mediaItemId) => {
  await t.actAs(from);
  try {
    const { rows } = await t.sql(`select recommend_title(gen_random_uuid(), $1, $2) as r`, [
      to,
      mediaItemId,
    ]);
    return rows[0].r;
  } finally {
    await t.actAs(null);
  }
};

const markSeen = (who, ids, operationId) =>
  viewAs(who, async () => {
    const { rows } = await t.sql(`select mark_recommendations_seen($1, $2::uuid[]) as r`, [
      operationId ?? (await op()),
      ids,
    ]);
    return rows[0].r;
  });

const markOpened = (who, id) =>
  viewAs(who, () => t.sql(`select mark_recommendation_opened($1)`, [id]));

const sentToYou = (who) =>
  viewAs(who, async () => (await t.sql(`select * from recommendations_to_me(200)`)).rows);

/** The stored row, read as the owner: what actually changed, whatever a client can see. */
const stored = async (id) =>
  (
    await t.sql(
      `select seen_at, opened_at, state, recommended_at, message
         from title_recommendations where id = $1`,
      [id],
    )
  ).rows[0];

before(async () => {
  t = await createTestDb();
  await t.sql(
    `update app_config set value = '10000'::jsonb where key like 'recommendations.max_per_%'`,
  );
});

after(async () => {
  await t?.close();
});

/** A fresh mutual pair per test, so no test depends on what ran before it. */
beforeEach(async () => {
  sender = await t.createUser({ username: `ss${seq++}` });
  recipient = await t.createUser({ username: `sr${seq++}` });
  await followRow(sender, recipient);
  await followRow(recipient, sender);
});

describe('recommendations_to_me carries seen_at', () => {
  it('as the last column, null until marked', async () => {
    const { id } = await send(sender, recipient, await movie('seen_shape'));

    const rows = await sentToYou(recipient);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id);
    assert.equal(rows[0].seen_at, null);
    assert.equal(Object.keys(rows[0]).at(-1), 'seen_at', 'appended, so older clients ignore it');
  });

  it('keeps the order unopened first, newest within — seen does not move a row', async () => {
    const a = (await send(sender, recipient, await movie('seen_order_a'))).id;
    const b = (await send(sender, recipient, await movie('seen_order_b'))).id;
    const c = (await send(sender, recipient, await movie('seen_order_c'))).id;
    // c newest, then b, then a. Open b, see a: a is still unopened, so it stays above b.
    await markOpened(recipient, b);
    await markSeen(recipient, [a]);

    const order = (await sentToYou(recipient)).map((row) => row.id);
    assert.deepEqual(order, [c, a, b]);
  });
});

describe('mark_recommendations_seen', () => {
  it('marks only the caller’s delivered rows in p_ids, and nothing else on them', async () => {
    const one = await send(sender, recipient, await movie('seen_one'));
    const two = await send(sender, recipient, await movie('seen_two'));
    const before1 = await stored(one.id);

    const result = await markSeen(recipient, [one.id]);
    assert.deepEqual(result, { status: 'ok', marked: 1 });

    const after1 = await stored(one.id);
    assert.notEqual(after1.seen_at, null);
    assert.equal(after1.opened_at, null, 'seeing a row is not opening it');
    assert.equal(after1.state, 'delivered');
    assert.equal(+after1.recommended_at, +before1.recommended_at);
    assert.equal((await stored(two.id)).seen_at, null, 'an id not passed stays unseen');

    const listed = await sentToYou(recipient);
    assert.notEqual(listed.find((row) => row.id === one.id).seen_at, null);
  });

  it('ignores another user’s ids, silently', async () => {
    const theirs = await send(sender, recipient, await movie('seen_other'));
    const mallory = await t.createUser({ username: `sm${seq++}` });

    assert.deepEqual(await markSeen(mallory, [theirs.id]), { status: 'ok', marked: 0 });
    assert.equal((await stored(theirs.id)).seen_at, null);
  });

  it('does not let the sender mark what they sent', async () => {
    const sent = await send(sender, recipient, await movie('seen_sender'));
    assert.deepEqual(await markSeen(sender, [sent.id]), { status: 'ok', marked: 0 });
    assert.equal((await stored(sent.id)).seen_at, null);
  });

  it('does not mark a pending request, which is not in Sent to You', async () => {
    const stranger = await t.createUser({ username: `sp${seq++}` });
    await followRow(stranger, recipient); // one-way: held as a request
    const held = await send(stranger, recipient, await movie('seen_pending'));
    assert.equal(held.delivered, false);

    assert.deepEqual(await markSeen(recipient, [held.id]), { status: 'ok', marked: 0 });
    const row = await stored(held.id);
    assert.equal(row.seen_at, null);
    assert.equal(row.state, 'pending');
  });

  it('answers already_applied for a repeated operation id', async () => {
    const { id } = await send(sender, recipient, await movie('seen_replay'));
    const operationId = await op();

    assert.deepEqual(await markSeen(recipient, [id], operationId), { status: 'ok', marked: 1 });
    assert.deepEqual(await markSeen(recipient, [id], operationId), {
      status: 'already_applied',
    });
  });

  it('marks nothing the second time, and keeps the first time', async () => {
    const { id } = await send(sender, recipient, await movie('seen_twice'));
    await markSeen(recipient, [id]);
    const first = (await stored(id)).seen_at;

    assert.deepEqual(await markSeen(recipient, [id]), { status: 'ok', marked: 0 });
    assert.equal(+(await stored(id)).seen_at, +first, 'forward-only and once');
  });

  it('refuses more than 200 ids before claiming anything, and accepts exactly 200', async () => {
    const { id } = await send(sender, recipient, await movie('seen_bound'));
    const filler = (n) =>
      t.sql(`select array_agg(gen_random_uuid()) as ids from generate_series(1, $1)`, [n]);

    const tooMany = [id, ...(await filler(200)).rows[0].ids];
    const operationId = await op();
    const error = await viewAs(recipient, () =>
      t.errorFrom(`select mark_recommendations_seen($1, $2::uuid[])`, [operationId, tooMany]),
    );
    assert.equal(error?.code, '22023');
    assert.equal((await stored(id)).seen_at, null);
    const { rows: claims } = await t.sql(
      `select 1 from processed_operations where operation_id = $1`,
      [operationId],
    );
    assert.equal(claims.length, 0, 'a refused batch spends no operation id');

    const exactly = [id, ...(await filler(199)).rows[0].ids];
    assert.deepEqual(await markSeen(recipient, exactly), { status: 'ok', marked: 1 });
  });

  it('treats an empty or null batch as nothing to do', async () => {
    assert.deepEqual(await markSeen(recipient, []), { status: 'ok', marked: 0 });
    assert.deepEqual(await markSeen(recipient, null), { status: 'ok', marked: 0 });
  });

  it('files no notification and changes no watchlist, ranking or dismissal', async () => {
    const title = await movie('seen_side_effects');
    const { id } = await send(sender, recipient, title);
    const count = async (table, column = 'user_id') =>
      (await t.sql(`select count(*)::int as n from ${table} where ${column} = $1`, [recipient]))
        .rows[0].n;
    const before = {
      notifications: await count('notifications', 'recipient_id'),
      watchlist: await count('watchlist'),
      rankings: await count('rankings'),
      userMedia: await count('user_media'),
    };

    await markSeen(recipient, [id]);

    assert.deepEqual(
      {
        notifications: await count('notifications', 'recipient_id'),
        watchlist: await count('watchlist'),
        rankings: await count('rankings'),
        userMedia: await count('user_media'),
      },
      before,
    );
    assert.equal((await stored(id)).state, 'delivered');
  });

  it('is independent of opening: seen then opened, and opened then seen', async () => {
    const a = (await send(sender, recipient, await movie('seen_then_open'))).id;
    const b = (await send(sender, recipient, await movie('open_then_seen'))).id;

    await markSeen(recipient, [a]);
    await markOpened(recipient, a);
    assert.notEqual((await stored(a)).opened_at, null, 'seen does not stop the open being recorded');

    await markOpened(recipient, b);
    const openedB = (await stored(b)).opened_at;
    await markSeen(recipient, [b]);
    assert.equal(+(await stored(b)).opened_at, +openedB, 'marking seen never moves opened_at');
  });

  it('refuses a signed-out caller on privilege, and a suspended one on the write guard', async () => {
    const { id } = await send(sender, recipient, await movie('seen_privilege'));
    const operationId = await op();

    const anon = await t
      .asAnon(() =>
        t.errorFrom(`select mark_recommendations_seen($1, $2::uuid[])`, [operationId, [id]]),
      )
      .finally(() => t.actAs(null));
    assert.equal(anon?.code, '42501');

    await t.sql(`update profiles set status = 'suspended' where id = $1`, [recipient]);
    const suspended = await viewAs(recipient, () =>
      t.errorFrom(`select mark_recommendations_seen($1, $2::uuid[])`, [operationId, [id]]),
    );
    assert.equal(suspended?.code, '42501');
    assert.equal((await stored(id)).seen_at, null);
  });
});

describe('the resend rule', () => {
  it('a resend moves recommended_at and never clears seen_at', async () => {
    const title = await movie('seen_resend');
    const { id } = await send(sender, recipient, title);
    await markSeen(recipient, [id]);
    const seen = await stored(id);

    const again = await send(sender, recipient, title);
    assert.equal(again.created, false);

    const row = await stored(id);
    assert.equal(+row.seen_at, +seen.seen_at, 'a sender cannot re-badge somebody’s tab');
    assert.ok(+row.recommended_at >= +seen.recommended_at);
  });

  it('a recommendation that arrives after the mark stays unseen', async () => {
    const first = (await send(sender, recipient, await movie('seen_before'))).id;
    await markSeen(recipient, [first]);
    const later = (await send(sender, recipient, await movie('seen_after'))).id;

    const rows = await sentToYou(recipient);
    assert.equal(rows.find((row) => row.id === later).seen_at, null);
    assert.notEqual(rows.find((row) => row.id === first).seen_at, null);
  });
});

describe('who can read seen_at', () => {
  it('not the sender: the column is granted to nobody, so it is no read receipt', async () => {
    const { id } = await send(sender, recipient, await movie('seen_receipt'));
    await markSeen(recipient, [id]);

    const direct = await viewAs(sender, () =>
      t.errorFrom(`select seen_at from title_recommendations where id = $1`, [id]),
    );
    assert.equal(direct?.code, '42501', 'a direct select of the column is refused');

    const viaHelper = await viewAs(sender, async () => {
      const { rows } = await t.sql(`select recommendation_seen_at($1) as s`, [id]);
      return rows[0].s;
    });
    assert.equal(viaHelper, null, 'and the helper answers only the recipient');
  });

  it('not a third party, and not the recipient for a row that is not delivered to them', async () => {
    const { id } = await send(sender, recipient, await movie('seen_third'));
    await markSeen(recipient, [id]);
    const eve = await t.createUser({ username: `se${seq++}` });

    const asEve = await viewAs(eve, async () => {
      const { rows } = await t.sql(`select recommendation_seen_at($1) as s`, [id]);
      return rows[0].s;
    });
    assert.equal(asEve, null);

    const asRecipient = await viewAs(recipient, async () => {
      const { rows } = await t.sql(`select recommendation_seen_at($1) as s`, [id]);
      return rows[0].s;
    });
    assert.notEqual(asRecipient, null);
  });

  it('not signed out', async () => {
    const { id } = await send(sender, recipient, await movie('seen_anon'));
    const error = await t
      .asAnon(() => t.errorFrom(`select recommendation_seen_at($1)`, [id]))
      .finally(() => t.actAs(null));
    assert.equal(error?.code, '42501');
  });
});
