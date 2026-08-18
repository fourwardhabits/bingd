import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Recommending a title to a friend (20260817001300).
 *
 * The whole feature is one authorization rule and one duplicate rule, so nearly every
 * test here is about a refusal. The rule is **mutual follow**: both edges, both
 * approved, neither party blocked, the recipient active.
 *
 * `recommendations_to_me` is `security invoker`, which means an owner-run query would
 * bypass the policy it depends on for its entire safety argument. Every read below
 * therefore goes through `viewAs`, and the two tests that assert somebody *cannot* see
 * a recommendation would pass against a broken policy if they did not.
 */

let t;
let alice; // the sender
let bob; // mutual with alice
let seq = 90000;

const movie = (title) => t.createMovie(title, seq++);

const follow = (a, b) =>
  t.sql(`insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`, [a, b]);

const mutual = async (a, b) => {
  await follow(a, b);
  await follow(b, a);
};

const recommend = async (recipient, mediaItemId) => {
  const { rows } = await t.sql(
    `select recommend_title(gen_random_uuid(), $1, $2) as r`,
    [recipient, mediaItemId],
  );
  return rows[0].r;
};

const recommendError = (recipient, mediaItemId) =>
  t.errorFrom(`select recommend_title(gen_random_uuid(), $1, $2)`, [recipient, mediaItemId]);

/**
 * A read performed as somebody, with the acting identity put back afterwards.
 *
 * `asRole` resets the Postgres role and deliberately leaves `request.jwt.claims`
 * where it put them, so a bare `viewAs(bob, …)` silently makes bob the actor for
 * every following statement in the file. The first draft of these tests did that and
 * six of them passed for the wrong reason.
 */
const viewAs = async (viewer, fn) => {
  try {
    return await t.asUser(viewer, fn);
  } finally {
    await t.actAs(alice);
  }
};

const viewAnon = async (fn) => {
  try {
    return await t.asAnon(fn);
  } finally {
    await t.actAs(alice);
  }
};

/** What the recipient's own client would receive. */
const inbox = (viewer) =>
  viewAs(viewer, async () => {
    const { rows } = await t.sql(`select * from recommendations_to_me(100)`);
    return rows;
  });

const notificationsOf = async (recipient, type = 'recommendation') => {
  const { rows } = await t.sql(
    `select actor_id, subject_type, subject_id, payload from notifications
      where recipient_id = $1 and type = $2 order by created_at`,
    [recipient, type],
  );
  return rows;
};

before(async () => {
  t = await createTestDb();
  alice = await t.createUser({ username: 'alice_rec' });
  bob = await t.createUser({ username: 'bob_rec' });
  await mutual(alice, bob);
  await t.actAs(alice);
});

after(async () => {
  await t?.close();
});

describe('who may be recommended to', () => {
  it('accepts a mutual follow', async () => {
    const id = await movie('rec_mutual');
    const result = await recommend(bob, id);

    assert.equal(result.status, 'ok');
    assert.equal(result.created, true);

    const rows = await inbox(bob);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].media_item_id, id);
    assert.equal(rows[0].sender_id, alice);
    assert.equal(rows[0].sender_username, 'alice_rec');
  });

  it('refuses a one-way follow in either direction', async () => {
    const carol = await t.createUser({ username: 'carol_rec' });
    await follow(alice, carol); // alice follows carol, who does not follow back
    assert.equal((await recommendError(carol, await movie('rec_outbound')))?.code, '42501');

    const carla = await t.createUser({ username: 'carla_rec' });
    await follow(carla, alice); // carla follows alice, who does not follow back
    assert.equal((await recommendError(carla, await movie('rec_inbound')))?.code, '42501');
  });

  it('refuses a stranger', async () => {
    const dave = await t.createUser({ username: 'dave_rec' });
    assert.equal((await recommendError(dave, await movie('rec_stranger')))?.code, '42501');
  });

  it('refuses a pending request, which is not a follow', async () => {
    const erin = await t.createUser({ username: 'erin_rec', visibility: 'private' });
    await follow(erin, alice);
    await t.sql(`insert into follows (follower_id, followee_id, state) values ($1, $2, 'pending')`, [
      alice,
      erin,
    ]);
    assert.equal((await recommendError(erin, await movie('rec_pending')))?.code, '42501');
  });

  it('refuses across a block, and says the same thing as a missing account', async () => {
    const frank = await t.createUser({ username: 'frank_rec' });
    await mutual(alice, frank);
    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [frank, alice]);

    const blocked = await recommendError(frank, await movie('rec_blocked'));
    const missing = await recommendError(
      '00000000-0000-4000-8000-000000000000',
      await movie('rec_missing'),
    );

    // Both P0002, and deliberately the same message: telling them apart tells a
    // blocked caller they are blocked.
    assert.equal(blocked?.code, 'P0002');
    assert.equal(missing?.code, 'P0002');
    assert.equal(blocked?.message, missing?.message);
  });

  it('refuses a suspended recipient', async () => {
    const hank = await t.createUser({ username: 'hank_rec' });
    await mutual(alice, hank);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [hank]);

    assert.equal((await recommendError(hank, await movie('rec_suspended')))?.code, 'P0002');
  });

  it('refuses a suspended sender', async () => {
    const ivan = await t.createUser({ username: 'ivan_rec' });
    await mutual(ivan, bob);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [ivan]);
    await t.actAs(ivan);

    const error = await recommendError(bob, await movie('rec_suspended_sender'));
    await t.actAs(alice);
    assert.equal(error?.code, '42501');
  });

  it('refuses recommending to yourself', async () => {
    assert.equal((await recommendError(alice, await movie('rec_self')))?.code, '22023');
  });
});

describe('what may be recommended', () => {
  it('refuses a whole series, because a series is not a thing anybody watched', async () => {
    const series = await t.createSeries('rec_series', seq++);
    const error = await recommendError(bob, series);
    assert.equal(error?.code, '22023');
    assert.match(error?.message ?? '', /not a whole series/);
  });

  it('accepts an exact season, and names the show it belongs to', async () => {
    const series = await t.createSeries('Parks and Recreation', seq++);
    const season = await t.createSeason(series, 2, 'Season 2');

    assert.equal((await recommend(bob, season)).status, 'ok');

    const row = (await inbox(bob)).find((r) => r.media_item_id === season);
    assert.equal(row.media_kind, 'season');
    assert.equal(row.media_title, 'Season 2');
    assert.equal(row.series_title, 'Parks and Recreation', 'or the row names nothing');
  });

  it('refuses a title that does not exist', async () => {
    assert.equal(
      (await recommendError(bob, '00000000-0000-4000-8000-000000000001'))?.code,
      'P0002',
    );
  });
});

describe('recommending the same thing twice', () => {
  it('refreshes the existing row instead of adding another', async () => {
    const gwen = await t.createUser({ username: 'gwen_rec' });
    await mutual(alice, gwen);
    const id = await movie('rec_duplicate');

    const first = await recommend(gwen, id);
    // Backdated so the refresh is observable without waiting.
    await t.sql(`update title_recommendations set recommended_at = now() - interval '2 days'
                  where id = $1`, [first.id]);

    const second = await recommend(gwen, id);
    assert.equal(second.created, false);
    assert.equal(second.id, first.id, 'the same row');

    const { rows } = await t.sql(
      `select count(*)::int as n, max(recommended_at) > max(created_at) as refreshed
         from title_recommendations where sender_id = $1 and recipient_id = $2`,
      [alice, gwen],
    );
    assert.equal(rows[0].n, 1);
    assert.equal(rows[0].refreshed, true);
  });

  it('does not file a second notification', async () => {
    const hugo = await t.createUser({ username: 'hugo_rec' });
    await mutual(alice, hugo);
    const id = await movie('rec_duplicate_notice');

    await recommend(hugo, id);
    await recommend(hugo, id);

    assert.equal((await notificationsOf(hugo)).length, 1);
  });

  it('does not make an already-opened recommendation unread again', async () => {
    const iris = await t.createUser({ username: 'iris_rec' });
    await mutual(alice, iris);
    const id = await movie('rec_duplicate_opened');
    const { id: recId } = await recommend(iris, id);

    await t.actAs(iris);
    await t.sql(`select mark_recommendation_opened($1)`, [recId]);
    await t.actAs(alice);

    await recommend(iris, id);

    const { rows } = await t.sql(`select opened_at from title_recommendations where id = $1`, [
      recId,
    ]);
    assert.notEqual(rows[0].opened_at, null, 'a re-send must not re-badge somebody’s inbox');
  });

  it('is idempotent against a replayed operation id', async () => {
    const jane = await t.createUser({ username: 'jane_rec' });
    await mutual(alice, jane);
    const id = await movie('rec_replay');
    const { rows } = await t.sql(`select gen_random_uuid() as op`);
    const op = rows[0].op;

    await t.sql(`select recommend_title($1, $2, $3)`, [op, jane, id]);
    const { rows: again } = await t.sql(`select recommend_title($1, $2, $3) as r`, [op, jane, id]);

    assert.equal(again[0].r.status, 'already_applied');
    assert.equal((await notificationsOf(jane)).length, 1);
  });
});

describe('the rate limit', () => {
  it('is a ceiling on attempts, not on rows, so naming new titles does not widen it', async () => {
    const kim = await t.createUser({ username: 'kim_rec' });
    await mutual(alice, kim);
    await t.sql(`update app_config set value = '1'::jsonb where key = 'recommendations.max_per_hour'`);
    // A fresh sender, so the ceiling is not already spent by the tests above.
    const scripted = await t.createUser({ username: 'scripted_rec' });
    await mutual(scripted, kim);
    await t.actAs(scripted);

    try {
      assert.equal((await recommend(kim, await movie('rate_a'))).status, 'ok');
      // A different title, which is the bypass the founder named. Same kind, same
      // counter.
      const error = await recommendError(kim, await movie('rate_b'));
      assert.equal(error?.code, '53400');
    } finally {
      await t.actAs(alice);
      await t.sql(
        `update app_config set value = '20'::jsonb where key = 'recommendations.max_per_hour'`,
      );
    }
  });
});

describe('the notification', () => {
  it('names the actor and points at the exact title', async () => {
    const liam = await t.createUser({ username: 'liam_rec' });
    await mutual(alice, liam);
    const id = await movie('rec_notification');
    const { id: recId } = await recommend(liam, id);

    const [row] = await notificationsOf(liam);
    assert.equal(row.actor_id, alice);
    assert.equal(row.subject_type, 'media_item');
    assert.equal(row.subject_id, id);
    assert.equal(row.payload.recommendation_id, recId);
  });

  it('reaches the inbox reader with the kind and the show', async () => {
    const mona = await t.createUser({ username: 'mona_rec' });
    await mutual(alice, mona);
    const series = await t.createSeries('Severance', seq++);
    const season = await t.createSeason(series, 1, 'Season 1');
    await recommend(mona, season);

    const rows = await viewAs(mona, async () => {
      const { rows } = await t.sql(`select * from my_notifications(50)`);
      return rows;
    });
    const row = rows.find((r) => r.kind === 'recommendation');
    assert.equal(row.media_kind, 'season');
    assert.equal(row.series_title, 'Severance');
    assert.equal(row.actor_username, 'alice_rec');
  });

  it('is cleared from both inboxes by a block', async () => {
    const nora = await t.createUser({ username: 'nora_rec' });
    await mutual(alice, nora);
    await recommend(nora, await movie('rec_block_clears'));
    assert.equal((await notificationsOf(nora)).length, 1);

    await t.actAs(nora);
    await t.sql(`select block(gen_random_uuid(), $1)`, [alice]);
    await t.actAs(alice);

    assert.equal((await notificationsOf(nora)).length, 0);
  });
});

describe('Sent to you', () => {
  it('puts unopened first and newest within that', async () => {
    const opal = await t.createUser({ username: 'opal_rec' });
    await mutual(alice, opal);

    const older = await movie('rec_order_older');
    const newer = await movie('rec_order_newer');
    const seen = await movie('rec_order_seen');

    const a = await recommend(opal, older);
    const b = await recommend(opal, seen);
    const c = await recommend(opal, newer);

    await t.sql(`update title_recommendations set recommended_at = now() - interval '3 days' where id = $1`, [a.id]);
    await t.sql(`update title_recommendations set recommended_at = now() - interval '1 day'  where id = $1`, [c.id]);
    // The one that has been opened is also the most recent, so ordering by recency
    // alone would put it first — which is what this asserts it does not do.
    await t.sql(`update title_recommendations set opened_at = now() where id = $1`, [b.id]);

    const rows = (await inbox(opal)).filter((r) => [older, newer, seen].includes(r.media_item_id));
    assert.deepEqual(
      rows.map((r) => r.media_item_id),
      [newer, older, seen],
    );
  });

  it('drops a sender who has blocked the recipient', async () => {
    const pete = await t.createUser({ username: 'pete_rec' });
    await mutual(alice, pete);
    const id = await movie('rec_hidden_by_block');
    await recommend(pete, id);
    assert.equal((await inbox(pete)).some((r) => r.media_item_id === id), true);

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [alice, pete]);
    assert.equal(
      (await inbox(pete)).some((r) => r.media_item_id === id),
      false,
      'profiles_read is what makes this true; the function has no visibility logic of its own',
    );
  });

  it('drops a sender who has been suspended', async () => {
    const quinn = await t.createUser({ username: 'quinn_rec' });
    const rex = await t.createUser({ username: 'rex_rec' });
    await mutual(rex, quinn);
    await t.actAs(rex);
    const id = await movie('rec_hidden_by_suspension');
    await recommend(quinn, id);
    await t.actAs(alice);

    assert.equal((await inbox(quinn)).some((r) => r.media_item_id === id), true);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [rex]);
    assert.equal((await inbox(quinn)).some((r) => r.media_item_id === id), false);
  });

  it('is not readable by a third party', async () => {
    const sam = await t.createUser({ username: 'sam_rec' });
    await mutual(alice, sam);
    const id = await movie('rec_private');
    await recommend(sam, id);

    const nosy = await t.createUser({ username: 'nosy_rec' });
    const seen = await viewAs(nosy, () =>
      t.sql(`select id from title_recommendations where media_item_id = $1`, [id]),
    );
    assert.equal(seen.rows.length, 0);

    const theirs = await viewAs(nosy, () => t.sql(`select * from recommendations_to_me(100)`));
    assert.equal(theirs.rows.length, 0, 'and the function cannot be pointed at somebody else');
  });

  it('is readable by the sender, who needs to know they sent it', async () => {
    const tara = await t.createUser({ username: 'tara_rec' });
    await mutual(alice, tara);
    const id = await movie('rec_sender_read');
    await recommend(tara, id);

    const seen = await viewAs(alice, () =>
      t.sql(`select id from title_recommendations where media_item_id = $1`, [id]),
    );
    assert.equal(seen.rows.length, 1);
  });

  it('is not readable signed out', async () => {
    const seen = await viewAnon(() => t.errorFrom(`select * from title_recommendations`));
    // Either no rows or no privilege; both are acceptable and neither leaks a row.
    if (!seen) {
      const { rows } = await viewAnon(() => t.sql(`select * from title_recommendations`));
      assert.equal(rows.length, 0);
    }
  });
});

describe('marking one opened', () => {
  it('is once, forwards, and only the recipient’s own', async () => {
    const uma = await t.createUser({ username: 'uma_rec' });
    await mutual(alice, uma);
    const { id: recId } = await recommend(uma, await movie('rec_open'));

    // The sender cannot mark their own recommendation opened.
    await viewAs(alice, () => t.sql(`select mark_recommendation_opened($1)`, [recId]));
    let { rows } = await t.sql(`select opened_at from title_recommendations where id = $1`, [recId]);
    assert.equal(rows[0].opened_at, null);

    const first = await viewAs(uma, async () => {
      const { rows } = await t.sql(`select mark_recommendation_opened($1) as r`, [recId]);
      return rows[0].r;
    });
    assert.equal(first.opened, true);

    ({ rows } = await t.sql(`select opened_at from title_recommendations where id = $1`, [recId]));
    const stamped = rows[0].opened_at;

    const second = await viewAs(uma, async () => {
      const { rows } = await t.sql(`select mark_recommendation_opened($1) as r`, [recId]);
      return rows[0].r;
    });
    assert.equal(second.opened, false, 'a second call is a no-op');

    ({ rows } = await t.sql(`select opened_at from title_recommendations where id = $1`, [recId]));
    assert.deepEqual(rows[0].opened_at, stamped, 'and does not move the timestamp');
  });

  it('does not raise for a recommendation that is not the caller’s', async () => {
    const nosy = await t.createUser({ username: 'nosy_open_rec' });
    const result = await viewAs(nosy, async () => {
      const { rows } = await t.sql(`select mark_recommendation_opened(gen_random_uuid()) as r`);
      return rows[0].r;
    });
    assert.equal(result.opened, false);
  });
});

describe('the invite link', () => {
  it('mints one personal link and then reuses it', async () => {
    const vic = await t.createUser({ username: 'vic_rec' });
    await t.actAs(vic);
    const id = await movie('invite_context');

    const { rows: one } = await t.sql(`select create_invite_link(gen_random_uuid(), $1) as r`, [id]);
    const { rows: two } = await t.sql(`select create_invite_link(gen_random_uuid(), null) as r`);
    await t.actAs(alice);

    assert.equal(one[0].r.status, 'ok');
    assert.equal(two[0].r.token, one[0].r.token, 'a personal link that rotates detaches everybody');
    assert.match(one[0].r.token, /^[0-9a-f]{32}$/);

    const { rows: tokens } = await t.sql(
      `select count(*)::int as n from invite_tokens where owner_id = $1 and revoked_at is null`,
      [vic],
    );
    assert.equal(tokens[0].n, 1);
  });

  it('records each creation, with the title that was in view', async () => {
    const wes = await t.createUser({ username: 'wes_rec' });
    await t.actAs(wes);
    const id = await movie('invite_context_two');
    await t.sql(`select create_invite_link(gen_random_uuid(), $1)`, [id]);
    await t.sql(`select create_invite_link(gen_random_uuid(), null)`);
    await t.actAs(alice);

    const { rows } = await t.sql(
      `select media_item_id from invite_link_creations where inviter_id = $1 order by created_at`,
      [wes],
    );
    assert.deepEqual(
      rows.map((r) => r.media_item_id),
      [id, null],
      'two creations, one of which named a title',
    );
  });

  it('ignores a media item that does not exist rather than failing the share', async () => {
    const xena = await t.createUser({ username: 'xena_rec' });
    await t.actAs(xena);
    const { rows } = await t.sql(
      `select create_invite_link(gen_random_uuid(), '00000000-0000-4000-8000-000000000002') as r`,
    );
    await t.actAs(alice);
    assert.equal(rows[0].r.status, 'ok');
  });

  it('does not let anybody count somebody else’s invites', async () => {
    const yves = await t.createUser({ username: 'yves_rec' });
    await t.actAs(yves);
    await t.sql(`select create_invite_link(gen_random_uuid(), null)`);
    await t.actAs(alice);

    const nosy = await t.createUser({ username: 'nosy_invite_rec' });
    const seen = await viewAs(nosy, () =>
      t.sql(`select count(*)::int as n from invite_link_creations where inviter_id = $1`, [yves]),
    );
    assert.equal(seen.rows[0].n, 0);
  });
});
