import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The read state is the recipient's (20261121000100, FU1113-E O2, founder decision t180u).
 *
 * `title_recommendations_sender` admits a sender to their own rows, so every column granted
 * to `authenticated` is a column the sender can select. `opened_at` was in that grant
 * (20260826000400 §2), which made it a read receipt. Now neither `opened_at` nor `seen_at` is
 * granted; the recipient reads both through definer helpers, and the two recipient RPCs
 * return them exactly as before.
 *
 * Every read below runs as a real `authenticated` role (`as`), because the owner bypasses
 * column privileges and RLS and would prove nothing.
 */

let t;
let seq = 98000;
let sender;
let recipient;

/** The grant, exactly. Anything added later must be added here deliberately. */
const GRANTED = [
  'created_at',
  'id',
  'media_item_id',
  'message',
  'recipient_id',
  'recommended_at',
  'sender_id',
];

const movie = (title) => t.createMovie(title, seq++);

const as = async (who, fn) => {
  try {
    return await t.asUser(who, fn);
  } finally {
    await t.actAs(null);
  }
};

const send = async (mediaItemId) => {
  await t.actAs(sender);
  try {
    const { rows } = await t.sql(`select recommend_title(gen_random_uuid(), $1, $2) as r`, [
      recipient,
      mediaItemId,
    ]);
    return rows[0].r;
  } finally {
    await t.actAs(null);
  }
};

const openedAtVia = (who, id) =>
  as(who, async () => (await t.sql(`select recommendation_opened_at($1) as v`, [id])).rows[0].v);

const markOpened = (id) =>
  as(recipient, () => t.sql(`select mark_recommendation_opened($1)`, [id]));

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
  sender = await t.createUser({ username: `ps${seq++}` });
  recipient = await t.createUser({ username: `pr${seq++}` });
  for (const [a, b] of [
    [sender, recipient],
    [recipient, sender],
  ]) {
    await t.sql(
      `insert into follows (follower_id, followee_id, state, approved_at)
       values ($1, $2, 'approved', now())`,
      [a, b],
    );
  }
});

describe('the column grant on title_recommendations', () => {
  it('is exactly the allow-list, with no table-wide select, for authenticated and anon', async () => {
    const { rows } = await t.sql(`
      select a.attname as col
        from pg_attribute a
       where a.attrelid = 'public.title_recommendations'::regclass
         and a.attnum > 0 and not a.attisdropped
         and has_column_privilege('authenticated', a.attrelid, a.attnum, 'select')
       order by 1
    `);
    assert.deepEqual(
      rows.map((r) => r.col),
      GRANTED,
    );

    const { rows: anon } = await t.sql(`
      select count(*)::int as n
        from pg_attribute a
       where a.attrelid = 'public.title_recommendations'::regclass
         and a.attnum > 0 and not a.attisdropped
         and has_column_privilege('anon', a.attrelid, a.attnum, 'select')
    `);
    assert.equal(anon[0].n, 0);

    const table = await t.sql(`
      select has_table_privilege('authenticated', 'public.title_recommendations', 'select') as auth,
             has_table_privilege('anon', 'public.title_recommendations', 'select') as anon
    `);
    assert.deepEqual(table.rows[0], { auth: false, anon: false });
  });
});

describe('the sender cannot read the read state', () => {
  for (const [label, sql] of [
    ['select opened_at', `select opened_at from title_recommendations where id = $1`],
    ['filter on opened_at', `select id from title_recommendations where id = $1 and opened_at is not null`],
    ['order by opened_at', `select id from title_recommendations where id = $1 order by opened_at`],
    ['select *', `select * from title_recommendations where id = $1`],
    ['select seen_at', `select seen_at from title_recommendations where id = $1`],
  ]) {
    it(`${label} is refused on privilege`, async () => {
      const { id } = await send(await movie(`privacy_${label}`));
      await markOpened(id);

      const error = await as(sender, () => t.errorFrom(sql, [id]));
      assert.equal(error?.code, '42501', `${label} must be refused, not answered`);
    });
  }

  it('recommendation_opened_at answers null to the sender, before and after the open', async () => {
    const { id } = await send(await movie('privacy_helper_sender'));
    assert.equal(await openedAtVia(sender, id), null);

    await markOpened(id);
    assert.equal(await openedAtVia(sender, id), null, 'still nothing once it is opened');
  });

  it('answers null to a third party, and the timestamp to the recipient', async () => {
    const { id } = await send(await movie('privacy_helper_third'));
    await markOpened(id);
    const eve = await t.createUser({ username: `pe${seq++}` });

    assert.equal(await openedAtVia(eve, id), null);
    const stored = (await t.sql(`select opened_at from title_recommendations where id = $1`, [id]))
      .rows[0].opened_at;
    assert.equal(+(await openedAtVia(recipient, id)), +stored);
  });

  it('is refused signed out', async () => {
    const { id } = await send(await movie('privacy_anon'));
    const error = await t
      .asAnon(() => t.errorFrom(`select recommendation_opened_at($1)`, [id]))
      .finally(() => t.actAs(null));
    assert.equal(error?.code, '42501');
  });
});

describe('what keeps working', () => {
  it('the shipped awards read: the sender’s own rows by id, recommended_at and recipient_id', async () => {
    const a = (await send(await movie('privacy_awards_a'))).id;
    const b = (await send(await movie('privacy_awards_b'))).id;

    const rows = await as(sender, async () =>
      (
        await t.sql(
          `select id, recommended_at, recipient_id from title_recommendations
            where sender_id = $1 order by id`,
          [sender],
        )
      ).rows,
    );
    assert.deepEqual(
      rows.map((r) => r.id),
      [a, b].sort(),
    );
    assert.ok(rows.every((r) => r.recipient_id === recipient && r.recommended_at));
  });

  it('recommendations_to_me returns opened_at to the recipient, unopened first', async () => {
    const opened = (await send(await movie('privacy_order_opened'))).id;
    const fresh = (await send(await movie('privacy_order_fresh'))).id;
    const older = (await send(await movie('privacy_order_older'))).id;
    // Newest is `older` by send order; open the newest-but-one so order is checked both ways.
    await markOpened(opened);

    const rows = await as(recipient, async () => (await t.sql(`select * from recommendations_to_me(200)`)).rows);
    assert.deepEqual(
      rows.map((r) => r.id),
      [older, fresh, opened],
      'unopened first, newest within that',
    );
    assert.notEqual(rows.find((r) => r.id === opened).opened_at, null);
    assert.equal(rows.find((r) => r.id === fresh).opened_at, null);
  });

  it('title_recommendations_for_me returns opened_at to the recipient', async () => {
    const title = await movie('privacy_title_page');
    const { id } = await send(title);

    const before = await as(recipient, async () =>
      (await t.sql(`select * from title_recommendations_for_me($1)`, [title])).rows,
    );
    assert.equal(before.length, 1);
    assert.equal(before[0].opened_at, null);

    await markOpened(id);
    const afterOpen = await as(recipient, async () =>
      (await t.sql(`select * from title_recommendations_for_me($1)`, [title])).rows,
    );
    assert.notEqual(afterOpen[0].opened_at, null);
  });

  it('mark_recommendation_opened still opens once, as the recipient only', async () => {
    const { id } = await send(await movie('privacy_mark_opened'));
    const asSender = await as(sender, async () =>
      (await t.sql(`select mark_recommendation_opened($1) as r`, [id])).rows[0].r,
    );
    assert.deepEqual(asSender, { status: 'ok', opened: false });

    const first = await as(recipient, async () =>
      (await t.sql(`select mark_recommendation_opened($1) as r`, [id])).rows[0].r,
    );
    const second = await as(recipient, async () =>
      (await t.sql(`select mark_recommendation_opened($1) as r`, [id])).rows[0].r,
    );
    assert.deepEqual([first.opened, second.opened], [true, false]);
  });
});
