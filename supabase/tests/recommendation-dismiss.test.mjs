import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Removing a received recommendation from Sent to You (20261130001200).
 *
 * `dismissed_at` is the recipient's own, reversible decision about their own list. It is
 * not `state = 'dismissed'` (a pending request's tombstone), not For You's "not
 * interested", and not seen or opened. Everything below checks one side of that: what
 * leaves the recipient's lists, and everything that must stay exactly as it was.
 *
 * Every write and read runs as a real `authenticated` role (`viewAs`), so the policy and
 * the grants are exercised as a client meets them. Setup and the "what is actually
 * stored" reads run as the owner.
 */

let t;
let seq = 98000;
let ada;
let ben;
let me;

const movie = (title) => t.createMovie(title, seq++);
const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

const followRow = (a, b) =>
  t.sql(
    `insert into follows (follower_id, followee_id, state, approved_at)
     values ($1, $2, 'approved', now()) on conflict (follower_id, followee_id) do nothing`,
    [a, b],
  );
const mutual = async (a, b) => {
  await followRow(a, b);
  await followRow(b, a);
};

const viewAs = async (who, fn) => {
  try {
    return await t.asUser(who, fn);
  } finally {
    await t.actAs(null);
  }
};

const rpc = (who, call, params) =>
  viewAs(who, async () => (await t.sql(`select ${call} as r`, params)).rows[0].r);

const send = (from, to, mediaItemId) =>
  rpc(from, `recommend_title(gen_random_uuid(), $1, $2)`, [to, mediaItemId]);
const dismiss = async (who, id, operationId) =>
  rpc(who, `dismiss_received_recommendation($1, $2)`, [operationId ?? (await op()), id]);
const restore = async (who, id, operationId) =>
  rpc(who, `restore_received_recommendation($1, $2)`, [operationId ?? (await op()), id]);

const sentToYou = (who) =>
  viewAs(who, async () => (await t.sql(`select * from recommendations_to_me(200)`)).rows);
const sentToYouPage = (who) =>
  viewAs(who, async () => (await t.sql(`select * from recommendations_to_me_page(200)`)).rows);
const banner = (who, mediaItemId) =>
  viewAs(
    who,
    async () =>
      (await t.sql(`select * from title_recommendations_for_me($1)`, [mediaItemId])).rows,
  );
const ids = (rows) => rows.map((row) => row.id);

/** The stored row, as the owner: what actually changed, whatever a client can see. */
const stored = async (id) =>
  (
    await t.sql(
      `select id, sender_id, recipient_id, media_item_id, state, created_at, recommended_at,
              message, opened_at, seen_at, fulfilled_at, dismissed_at
         from title_recommendations where id = $1`,
      [id],
    )
  ).rows[0];

const notificationCount = async () =>
  (await t.sql(`select count(*)::int as n from notifications`)).rows[0].n;
const feedbackCount = async () =>
  (await t.sql(`select count(*)::int as n from recommendation_feedback`)).rows[0].n;

before(async () => {
  t = await createTestDb();
  await t.sql(
    `update app_config set value = '10000'::jsonb where key like 'recommendations.max_per_%'`,
  );
});

after(async () => {
  await t?.close();
});

/** Two senders, one recipient, all mutual, fresh per test. */
beforeEach(async () => {
  ada = await t.createUser({ username: `da${seq++}` });
  ben = await t.createUser({ username: `db${seq++}` });
  me = await t.createUser({ username: `dm${seq++}` });
  await mutual(ada, me);
  await mutual(ben, me);
});

describe('dismiss_received_recommendation', () => {
  it('takes it out of Sent to You (both readers) and leaves the stored row exactly as it was', async () => {
    const film = await movie('dismiss_basic');
    const keep = await movie('dismiss_basic_keep');
    const sent = await send(ada, me, film);
    const other = await send(ada, me, keep);
    const before1 = await stored(sent.id);

    assert.deepEqual(await dismiss(me, sent.id), { status: 'ok', dismissed: true });

    assert.deepEqual(ids(await sentToYou(me)), [other.id], 'legacy reader: shipped clients');
    assert.deepEqual(ids(await sentToYouPage(me)), [other.id], 'unread-first reader');

    const after1 = await stored(sent.id);
    assert.notEqual(after1.dismissed_at, null);
    const { dismissed_at: _d1, ...restBefore } = before1;
    const { dismissed_at: _d2, ...restAfter } = after1;
    assert.deepEqual(restAfter, restBefore, 'nothing but dismissed_at moved; nothing deleted');
  });

  it('persists on the server: a fresh read (another device, a restart) agrees', async () => {
    const sent = await send(ada, me, await movie('dismiss_persist'));
    await dismiss(me, sent.id);

    // Nothing client-side survives between these: each is a new statement as the reader.
    for (let i = 0; i < 2; i += 1) {
      assert.deepEqual(ids(await sentToYou(me)), []);
      assert.deepEqual(ids(await sentToYouPage(me)), []);
    }
  });

  it('with several senders, removes only the one dismissed', async () => {
    const film = await movie('dismiss_two_senders');
    const fromAda = await send(ada, me, film);
    const fromBen = await send(ben, me, film);

    await dismiss(me, fromAda.id);

    assert.deepEqual(ids(await sentToYou(me)), [fromBen.id]);
    assert.deepEqual(ids(await banner(me, film)), [fromBen.id]);
    assert.equal((await stored(fromBen.id)).dismissed_at, null);
  });

  it('stays dismissed through a resend by the same sender, which still notifies nobody', async () => {
    const film = await movie('dismiss_resend');
    const sent = await send(ada, me, film);
    await dismiss(me, sent.id);
    const before1 = await stored(sent.id);
    const notes = await notificationCount();

    const again = await send(ada, me, film);
    assert.equal(again.status, 'ok');
    assert.equal(again.id, sent.id, 'one row per sender, recipient and title');
    assert.equal(again.created, false);
    assert.equal(again.delivered, true, 'the sender’s answer is what it always was');

    const after1 = await stored(sent.id);
    assert.ok(after1.recommended_at > before1.recommended_at, 'the resend still moved it');
    assert.equal(+after1.dismissed_at, +before1.dismissed_at, 'a resend does not undo it');
    assert.deepEqual(ids(await sentToYou(me)), []);
    assert.equal(await notificationCount(), notes);
  });

  it('a different sender recommending the same title afterwards still arrives', async () => {
    const film = await movie('dismiss_then_other');
    const fromAda = await send(ada, me, film);
    await dismiss(me, fromAda.id);

    const fromBen = await send(ben, me, film);
    assert.deepEqual(ids(await sentToYou(me)), [fromBen.id]);
    assert.deepEqual(ids(await banner(me, film)), [fromBen.id]);
  });

  it('creates no notification and writes no For You feedback', async () => {
    const sent = await send(ada, me, await movie('dismiss_quiet'));
    const notes = await notificationCount();
    const feedback = await feedbackCount();

    await dismiss(me, sent.id);
    await restore(me, sent.id);
    await dismiss(me, sent.id);

    assert.equal(await notificationCount(), notes);
    assert.equal(await feedbackCount(), feedback);
  });

  it('is the recipient’s only: another user, and the sender, dismiss nothing', async () => {
    const sent = await send(ada, me, await movie('dismiss_not_yours'));
    const mallory = await t.createUser({ username: `dx${seq++}` });

    assert.deepEqual(await dismiss(mallory, sent.id), { status: 'ok', dismissed: false });
    assert.deepEqual(await dismiss(ada, sent.id), { status: 'ok', dismissed: false });
    assert.equal((await stored(sent.id)).dismissed_at, null);
    assert.deepEqual(ids(await sentToYou(me)), [sent.id]);

    // And once it is dismissed, nobody else can put it back either.
    await dismiss(me, sent.id);
    assert.deepEqual(await restore(mallory, sent.id), { status: 'ok', restored: false });
    assert.deepEqual(await restore(ada, sent.id), { status: 'ok', restored: false });
    assert.notEqual((await stored(sent.id)).dismissed_at, null);
  });

  it('answers the same for an unknown id and for an already-dismissed one', async () => {
    const sent = await send(ada, me, await movie('dismiss_twice'));
    assert.deepEqual(await dismiss(me, sent.id), { status: 'ok', dismissed: true });
    const first = (await stored(sent.id)).dismissed_at;

    assert.deepEqual(await dismiss(me, sent.id), { status: 'ok', dismissed: false });
    assert.equal(+(await stored(sent.id)).dismissed_at, +first, 'the first time stands');
    assert.deepEqual(await dismiss(me, await op()), { status: 'ok', dismissed: false });
  });

  it('does not act on a pending request, which keeps its own Add / Dismiss', async () => {
    const stranger = await t.createUser({ username: `dp${seq++}` });
    await followRow(stranger, me); // one way: a request, not a delivery
    const pending = await send(stranger, me, await movie('dismiss_pending'));
    assert.equal(pending.delivered, false);

    assert.deepEqual(await dismiss(me, pending.id), { status: 'ok', dismissed: false });
    const row = await stored(pending.id);
    assert.equal(row.state, 'pending');
    assert.equal(row.dismissed_at, null);
    const requests = await viewAs(
      me,
      async () => (await t.sql(`select id from recommendation_requests(100)`)).rows,
    );
    assert.deepEqual(ids(requests), [pending.id]);
  });
});

describe('Undo: restore_received_recommendation', () => {
  it('puts it back exactly where it was, with its read state and note', async () => {
    const a = await send(ada, me, await movie('undo_a'));
    const b = await send(ada, me, await movie('undo_b'));
    const c = await send(ada, me, await movie('undo_c'));
    await rpc(me, `mark_recommendations_seen($1, $2::uuid[])`, [await op(), [b.id]]);
    const orderBefore = ids(await sentToYouPage(me));
    const before1 = await stored(b.id);

    await dismiss(me, b.id);
    assert.deepEqual(
      ids(await sentToYouPage(me)),
      orderBefore.filter((id) => id !== b.id),
    );

    assert.deepEqual(await restore(me, b.id), { status: 'ok', restored: true });
    assert.deepEqual(ids(await sentToYouPage(me)), orderBefore);
    assert.deepEqual(await stored(b.id), before1, 'byte for byte the row it was');
    assert.ok(a && c);
  });

  it('is a no-op on a row that is not dismissed', async () => {
    const sent = await send(ada, me, await movie('undo_noop'));
    assert.deepEqual(await restore(me, sent.id), { status: 'ok', restored: false });
  });
});

describe('the operation id', () => {
  it('a replayed dismissal answers already_applied, even after an Undo', async () => {
    const sent = await send(ada, me, await movie('replay_after_undo'));
    const dismissOp = await op();

    assert.deepEqual(await dismiss(me, sent.id, dismissOp), { status: 'ok', dismissed: true });
    assert.deepEqual(await dismiss(me, sent.id, dismissOp), { status: 'already_applied' });

    assert.deepEqual(await restore(me, sent.id), { status: 'ok', restored: true });
    // The lost reply of the original dismissal, retried after the Undo: must not re-remove.
    assert.deepEqual(await dismiss(me, sent.id, dismissOp), { status: 'already_applied' });
    assert.equal((await stored(sent.id)).dismissed_at, null);
    assert.deepEqual(ids(await sentToYou(me)), [sent.id]);
  });

  it('a replayed restore answers already_applied and does not undo a later dismissal', async () => {
    const sent = await send(ada, me, await movie('replay_restore'));
    await dismiss(me, sent.id);
    const restoreOp = await op();
    assert.deepEqual(await restore(me, sent.id, restoreOp), { status: 'ok', restored: true });

    await dismiss(me, sent.id);
    assert.deepEqual(await restore(me, sent.id, restoreOp), { status: 'already_applied' });
    assert.notEqual((await stored(sent.id)).dismissed_at, null);
  });

  it('is required, and one id cannot be spent on both acts', async () => {
    const sent = await send(ada, me, await movie('replay_kind'));
    const missing = await viewAs(me, () =>
      t.errorFrom(`select dismiss_received_recommendation(null, $1)`, [sent.id]),
    );
    assert.equal(missing?.code, '22023');

    const shared = await op();
    await dismiss(me, sent.id, shared);
    const reused = await viewAs(me, () =>
      t.errorFrom(`select restore_received_recommendation($1, $2)`, [shared, sent.id]),
    );
    assert.equal(reused?.code, '22023');
  });
});

describe('independence from seen, opened and the watchlist', () => {
  it('seeing and opening never dismiss', async () => {
    const film = await movie('indep_seen_opened');
    const sent = await send(ada, me, film);

    await rpc(me, `mark_recommendations_seen($1, $2::uuid[])`, [await op(), [sent.id]]);
    await rpc(me, `mark_recommendation_opened($1)`, [sent.id]);

    const row = await stored(sent.id);
    assert.notEqual(row.seen_at, null);
    assert.notEqual(row.opened_at, null);
    assert.equal(row.dismissed_at, null);
    assert.deepEqual(ids(await sentToYou(me)), [sent.id]);
    assert.deepEqual(ids(await banner(me, film)), [sent.id]);
  });

  it('dismissing marks nothing seen or opened, and Undo brings it back unread', async () => {
    const sent = await send(ada, me, await movie('indep_unread'));
    await dismiss(me, sent.id);
    const row = await stored(sent.id);
    assert.equal(row.seen_at, null);
    assert.equal(row.opened_at, null);

    await restore(me, sent.id);
    const [listed] = await sentToYouPage(me);
    assert.equal(listed.read_rank, 0, 'still unread');
  });

  it('saving to the watchlist does not dismiss, and dismissing does not unsave', async () => {
    const film = await movie('indep_watchlist');
    const sent = await send(ada, me, film);
    const onWatchlist = async () =>
      (
        await t.sql(
          `select count(*)::int as n from watchlist where user_id = $1 and media_item_id = $2`,
          [me, film],
        )
      ).rows[0].n;

    await rpc(me, `set_watchlist($1, $2, true)`, [await op(), film]);
    assert.equal(await onWatchlist(), 1);
    assert.deepEqual(ids(await sentToYou(me)), [sent.id], 'saved, and still in Sent to You');

    await dismiss(me, sent.id);
    assert.equal(await onWatchlist(), 1, 'removed from Sent to You, still saved');
  });
});

describe('the sender’s side is unchanged', () => {
  it('sees the same row, cannot read dismissed_at, and cannot filter on it', async () => {
    const film = await movie('sender_view');
    const sent = await send(ada, me, film);
    const asSender = () =>
      viewAs(
        ada,
        async () =>
          (
            await t.sql(
              `select id, sender_id, recipient_id, media_item_id, created_at, recommended_at, message
                 from title_recommendations where sender_id = $1`,
              [ada],
            )
          ).rows,
      );
    const before1 = await asSender();

    await dismiss(me, sent.id);
    assert.deepEqual(await asSender(), before1);

    for (const sql of [
      `select dismissed_at from title_recommendations where id = $1`,
      `select id from title_recommendations where id = $1 and dismissed_at is not null`,
    ]) {
      const error = await viewAs(ada, () => t.errorFrom(sql, [sent.id]));
      assert.equal(error?.code, '42501', sql);
    }
    // And the recipient cannot read the column directly either: it is granted to nobody.
    const mine = await viewAs(me, () =>
      t.errorFrom(`select dismissed_at from title_recommendations where id = $1`, [sent.id]),
    );
    assert.equal(mine?.code, '42501');
  });

  it('a later ranking still fulfils it and tells the sender, as before', async () => {
    const film = await movie('sender_fulfilment');
    const sent = await send(ada, me, film);
    await dismiss(me, sent.id);

    await viewAs(me, () => t.rankToCompletion(film, 'fine', (_pivot, item) => item));

    const row = await stored(sent.id);
    assert.notEqual(row.fulfilled_at, null, 'attribution untouched by the dismissal');
    const { rows } = await t.sql(
      `select count(*)::int as n from notifications
        where type = 'recommendation_ranked' and (payload ->> 'recommendation_id')::uuid = $1`,
      [sent.id],
    );
    assert.equal(rows[0].n, 1);
  });
});

describe('the title page’s Recommended by card', () => {
  it('hides a dismissed recommendation’s attribution and keeps the other senders', async () => {
    const film = await movie('banner_rule');
    const fromAda = await send(ada, me, film);
    const fromBen = await send(ben, me, film);
    assert.equal((await banner(me, film)).length, 2);

    await dismiss(me, fromBen.id);
    assert.deepEqual(ids(await banner(me, film)), [fromAda.id]);

    await dismiss(me, fromAda.id);
    assert.deepEqual(await banner(me, film), [], 'every one dismissed: no card');

    await restore(me, fromBen.id);
    assert.deepEqual(ids(await banner(me, film)), [fromBen.id]);
  });
});

describe('privileges', () => {
  it('anon cannot call either writer, a suspended reader is refused by the write guard', async () => {
    const sent = await send(ada, me, await movie('priv'));
    for (const fn of ['dismiss_received_recommendation', 'restore_received_recommendation']) {
      const anon = await t
        .asAnon(() => t.errorFrom(`select ${fn}(gen_random_uuid(), $1)`, [sent.id]))
        .finally(() => t.actAs(null));
      assert.equal(anon?.code, '42501', fn);
    }

    await t.sql(`update profiles set status = 'suspended' where id = $1`, [me]);
    const suspended = await viewAs(me, () =>
      t.errorFrom(`select dismiss_received_recommendation(gen_random_uuid(), $1)`, [sent.id]),
    );
    assert.equal(suspended?.code, '42501');
    assert.equal((await stored(sent.id)).dismissed_at, null);
  });

  it('are security definer with a pinned search_path', async () => {
    const { rows } = await t.sql(`
      select p.proname, p.prosecdef, p.proconfig
        from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname in ('dismiss_received_recommendation', 'restore_received_recommendation')
       order by 1`);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.prosecdef, true, row.proname);
      assert.deepEqual(row.proconfig, ['search_path=public'], row.proname);
    }
  });
});
