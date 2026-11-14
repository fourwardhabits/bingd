import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Sent to You, unread first and paged (20261121000400, #290 Codex P2 #5).
 *
 * `recommendations_to_me` orders by "opened or not" only, so a row the reader has *seen*
 * stays in its 200-row unopened prefix, and an unread row past 200 can never arrive.
 * `recommendations_to_me_page` orders unread -> seen -> opened (newest first within each, id
 * desc on ties) and pages with a keyset cursor. The old function is left exactly as it was.
 *
 * Every read runs as a real `authenticated` role (`viewAs`), so RLS and the column grants
 * apply as a client meets them. Setup — including pinning `recommended_at` — runs as the
 * owner.
 */

let t;
let seq = 99000;
let sender;
let recipient;

const movie = (title) => t.createMovie(title, seq++);

const followRow = (a, b) =>
  t.sql(
    `insert into follows (follower_id, followee_id, state, approved_at)
     values ($1, $2, 'approved', now()) on conflict (follower_id, followee_id) do nothing`,
    [a, b],
  );

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

const markSeen = (who, ids) =>
  viewAs(who, () =>
    t.sql(`select mark_recommendations_seen($1, $2::uuid[])`, [crypto.randomUUID(), ids]),
  );

const markOpened = (who, id) =>
  viewAs(who, () => t.sql(`select mark_recommendation_opened($1)`, [id]));

/** Owner-only: pins a row's place in time, which no client can do. */
const pin = (id, at) =>
  t.sql(`update title_recommendations set recommended_at = $2 where id = $1`, [id, at]);

const at = (minutes) => new Date(Date.UTC(2026, 10, 1, 12, minutes)).toISOString();

const page = (who, limit = 200, cursor = null) =>
  viewAs(who, async () => {
    const { rows } = await t.sql(
      `select * from recommendations_to_me_page($1, $2::smallint, $3::timestamptz, $4::uuid)`,
      [limit, cursor?.rank ?? null, cursor?.recommendedAt ?? null, cursor?.id ?? null],
    );
    return rows;
  });

const legacy = (who, limit = 200) =>
  viewAs(who, async () => (await t.sql(`select * from recommendations_to_me($1)`, [limit])).rows);

const cursorOf = (row) => ({ rank: row.read_rank, recommendedAt: row.recommended_at, id: row.id });

/** Sends one title and pins it to `minutes`. Returns the recommendation id. */
const sendAt = async (minutes, label, from = sender) => {
  const { id } = await send(from, recipient, await movie(`uf_${label}_${seq}`));
  await pin(id, at(minutes));
  return id;
};

/**
 * `n` delivered rows for the recipient in one statement, newest = highest i. Inserted as the
 * owner because 205 `recommend_title` calls would only test the send path again, slowly.
 */
const bulk = async (n) => {
  const base = seq;
  seq += n + 1;
  const { rows } = await t.sql(
    `with titles as (
       insert into media_items (kind, tmdb_id, title, provenance)
       select 'movie', -($1::int + i), 'uf_bulk_' || ($1::int + i), 'manual'
         from generate_series(1, $2::int) i
       returning id, -tmdb_id - $1::int as i
     )
     insert into title_recommendations (sender_id, recipient_id, media_item_id, recommended_at, state)
     select $3, $4, titles.id, timestamptz '2026-10-01 00:00Z' + make_interval(mins => titles.i), 'delivered'
       from titles
     returning id, recommended_at`,
    [base, n, sender, recipient],
  );
  return rows;
};

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
  sender = await t.createUser({ username: `us${seq++}` });
  recipient = await t.createUser({ username: `ur${seq++}` });
  await followRow(sender, recipient);
  await followRow(recipient, sender);
});

describe('recommendations_to_me_page order', () => {
  it('(a) unread, then seen, then opened; newest first within each', async () => {
    // A seen row newer than both unread ones, so "opened only" would put it first.
    const unreadOld = await sendAt(1, 'unread_old');
    const unreadNew = await sendAt(3, 'unread_new');
    const seen = await sendAt(4, 'seen');
    const opened = await sendAt(5, 'opened');
    await markSeen(recipient, [seen]);
    await markOpened(recipient, opened);

    const rows = await page(recipient);
    assert.deepEqual(
      rows.map((r) => r.id),
      [unreadNew, unreadOld, seen, opened],
    );
    assert.deepEqual(
      rows.map((r) => r.read_rank),
      [0, 0, 1, 2],
    );
  });

  it('(b) has recommendations_to_me’s columns in order, plus read_rank last', async () => {
    await sendAt(1, 'shape');
    const { rows } = await t.sql(`
      select pg_get_function_result('recommendations_to_me(integer)'::regprocedure) as old,
             pg_get_function_result(
               'recommendations_to_me_page(integer,smallint,timestamptz,uuid)'::regprocedure
             ) as new
    `);
    assert.equal(rows[0].new, rows[0].old.replace(/\)$/, ', read_rank smallint)'));

    const [mine] = await page(recipient);
    const [old] = await legacy(recipient);
    assert.deepEqual(Object.keys(mine), [...Object.keys(old), 'read_rank']);
    const { read_rank: _rank, ...rest } = mine;
    assert.deepEqual(rest, old, 'the shared columns carry the same values');
  });

  it('(c) breaks a recommended_at tie by id desc', async () => {
    const a = await sendAt(7, 'tie_a');
    const b = await sendAt(7, 'tie_b');
    const c = await sendAt(7, 'tie_c');
    const expected = [a, b, c].sort().reverse();

    assert.deepEqual(
      (await page(recipient)).map((r) => r.id),
      expected,
    );
  });

  it('(d) leaves recommendations_to_me as it was: a seen row stays in the unopened prefix', async () => {
    const older = await sendAt(1, 'legacy_older');
    const seen = await sendAt(2, 'legacy_seen');
    const opened = await sendAt(3, 'legacy_opened');
    await markSeen(recipient, [seen]);
    await markOpened(recipient, opened);

    assert.deepEqual(
      (await legacy(recipient)).map((r) => r.id),
      [seen, older, opened],
    );
    assert.deepEqual(
      (await page(recipient)).map((r) => r.id),
      [older, seen, opened],
    );
  });
});

describe('recommendations_to_me_page paging', () => {
  it('(e) a keyset walk of two visits every row once, across groups and equal times', async () => {
    const ids = {
      u1: await sendAt(10, 'walk_u1'),
      u2: await sendAt(10, 'walk_u2'), // tie with u1
      u3: await sendAt(9, 'walk_u3'),
      s1: await sendAt(12, 'walk_s1'),
      s2: await sendAt(12, 'walk_s2'), // tie with s1
      o1: await sendAt(11, 'walk_o1'),
      o2: await sendAt(8, 'walk_o2'),
    };
    await markSeen(recipient, [ids.s1, ids.s2]);
    await markOpened(recipient, ids.o1);
    await markOpened(recipient, ids.o2);

    const whole = (await page(recipient)).map((r) => r.id);
    assert.equal(whole.length, 7);

    const walked = [];
    let cursor = null;
    for (let i = 0; i < 10; i += 1) {
      const rows = await page(recipient, 2, cursor);
      if (rows.length === 0) break;
      assert.ok(rows.length <= 2);
      walked.push(...rows.map((r) => r.id));
      cursor = cursorOf(rows.at(-1));
    }

    assert.deepEqual(walked, whole, 'same order as one call, every row exactly once');
    assert.equal(new Set(walked).size, 7);
  });

  it('(f) refuses half a cursor with 22023', async () => {
    const id = await sendAt(1, 'half');
    for (const args of [
      [0, null, null],
      [null, at(1), null],
      [null, null, id],
      [0, at(1), null],
      [null, at(1), id],
    ]) {
      const error = await viewAs(recipient, () =>
        t.errorFrom(
          `select * from recommendations_to_me_page(10, $1::smallint, $2::timestamptz, $3::uuid)`,
          args,
        ),
      );
      assert.equal(error?.code, '22023', JSON.stringify(args));
    }
  });

  it('(g) clamps p_limit to 1..200, and a null limit means 100', async () => {
    await bulk(205);
    assert.equal((await page(recipient, 0)).length, 1);
    assert.equal((await page(recipient, -5)).length, 1);
    assert.equal((await page(recipient, 1000)).length, 200);
    assert.equal((await page(recipient, null)).length, 100);
  });

  it('(h) reaches the unread rows the old function can never return past 200 seen', async () => {
    const rows = await bulk(205);
    const firstTwoHundred = (await legacy(recipient)).map((r) => r.id);
    assert.equal(firstTwoHundred.length, 200);
    await markSeen(recipient, firstTwoHundred);

    const old = await legacy(recipient);
    assert.equal(old.length, 200);
    assert.equal(old.filter((r) => r.seen_at === null && r.opened_at === null).length, 0);

    const seenSet = new Set(firstTwoHundred);
    const unread = rows.filter((r) => !seenSet.has(r.id));
    assert.equal(unread.length, 5);

    const fresh = await page(recipient);
    assert.equal(fresh.length, 200);
    assert.deepEqual(
      new Set(fresh.slice(0, 5).map((r) => r.id)),
      new Set(unread.map((r) => r.id)),
    );
    assert.deepEqual(
      fresh.slice(0, 5).map((r) => r.read_rank),
      [0, 0, 0, 0, 0],
    );
    assert.ok(fresh.slice(5).every((r) => r.read_rank === 1));
  });
});

describe('recommendations_to_me_page visibility and privilege', () => {
  it('(i) answers [] to the sender and a third party, and never lists a pending request', async () => {
    await sendAt(1, 'mine_only');
    const eve = await t.createUser({ username: `ue${seq++}` });

    assert.deepEqual(await page(sender), []);
    assert.deepEqual(await page(eve), []);

    const stranger = await t.createUser({ username: `ux${seq++}` });
    await followRow(stranger, recipient); // one-way: held as a request
    const held = await send(stranger, recipient, await movie('uf_pending'));
    assert.equal(held.delivered, false);

    const listed = (await page(recipient)).map((r) => r.id);
    assert.equal(listed.length, 1);
    assert.ok(!listed.includes(held.id));
  });

  it('(j) is security invoker, executable by authenticated only', async () => {
    const { rows } = await t.sql(`
      select p.prosecdef,
             has_function_privilege('authenticated', p.oid, 'execute') as auth,
             has_function_privilege('anon', p.oid, 'execute') as anon
        from pg_proc p
       where p.oid = 'recommendations_to_me_page(integer,smallint,timestamptz,uuid)'::regprocedure
    `);
    assert.deepEqual(rows[0], { prosecdef: false, auth: true, anon: false });

    const error = await t
      .asAnon(() => t.errorFrom(`select * from recommendations_to_me_page(1)`))
      .finally(() => t.actAs(null));
    assert.equal(error?.code, '42501');
  });

  it('(k) leaves the column grant on title_recommendations exactly as 20261121000100 set it', async () => {
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
      ['created_at', 'id', 'media_item_id', 'message', 'recipient_id', 'recommended_at', 'sender_id'],
    );
  });
});
