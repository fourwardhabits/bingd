import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestDb } from './harness.mjs';

/**
 * `supabase/backfills/invite-activation-2026-09-11.sql`, run rather than described.
 *
 * The file is read from disk and executed verbatim. A test that re-typed the statement
 * would assert that somebody typed something twice; this asserts that the thing an
 * operator will paste into a production SQL editor does what the report says it does.
 *
 * ---------------------------------------------------------------------------
 * What the backfill is for
 * ---------------------------------------------------------------------------
 *
 * `20260916000100` lowered `invite.activation_rankings` from ten to five. It changes the
 * rule and nothing else, because `activated_at` is written only by
 * `_maybe_activate_invite` and that runs only from `_rank_finalize` — so an invitee who
 * was already past five on the day the rule changed stays unactivated until their next
 * ranking, which for somebody who finished onboarding and closed the app is never.
 *
 * ---------------------------------------------------------------------------
 * How the backlog is reproduced, and why it is not faked
 * ---------------------------------------------------------------------------
 *
 * Every fixture here is built **with the bar still at ten**, which is the history it is
 * simulating: five titles ranked through the real writers, no activation, because ten was
 * the rule at the time. Then the bar moves to five, exactly as the migration moves it, and
 * the backfill runs. Nothing sets `activated_at` by hand, so a backfill that only appeared
 * to work because the fixture pre-arranged its answer would fail here.
 *
 * `age()` then shifts the fixture's rankings and its `accepted_at` backwards by the same
 * interval, which preserves their order. Shifting only one would invert the very ordering
 * the `greatest` exists to get right.
 *
 * ---------------------------------------------------------------------------
 * The properties
 * ---------------------------------------------------------------------------
 *
 *   B1. **Four does not qualify, five does**, and the bar is read from `app_config`.
 *   B2. **The timestamp is when they qualified, not when the script ran** — the later of
 *       the fifth ranking and `accepted_at`, asserted in both orderings, because in
 *       production the second half wins every row (onboarding ranks, then the invitation
 *       is redeemed a minute later).
 *   B3. **Idempotent.** A second run matches nothing, writes nothing, fires no trigger.
 *   B4. **The award trigger fires, and announces.** `award_on_invite_activation` does not
 *       care that the UPDATE came from a script. A tier crossed is a ledger row with
 *       `value_at_unlock` frozen, a public feed post, a congratulations notification, and
 *       `announced = true` — not the quiet `announced = false` shape `20260828000100`'s
 *       own rollout used.
 *   B5. **No `invite_activated` notification.** That row lives inside
 *       `_maybe_activate_invite`, which this never calls. Deliberate: it is push-eligible
 *       and would announce something that happened days ago.
 *   B6. **An unaccepted attribution is left alone**, matching the function's own predicate.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BACKFILL = readFileSync(
  join(here, '..', 'backfills', 'invite-activation-2026-09-11.sql'),
  'utf8',
);

let t;

const call = async (sql, params = []) => {
  const { rows } = await t.sql(`select ${sql} as r`, params);
  return rows[0].r;
};

const newUser = (username) => t.createUser({ username, visibility: 'public' });

const mintLink = async (owner) => {
  await t.actAs(owner);
  const result = await call(`create_invite_link(gen_random_uuid())`);
  assert.equal(result.status, 'ok');
  return result.token;
};

const redeem = async (invitee, token) => {
  await t.actAs(invitee);
  const result = await call(`redeem_invite(gen_random_uuid(), $1)`, [token]);
  assert.equal(result.status, 'ok');
};

const rankOne = async (user, film) => {
  await t.actAs(user);
  await t.sql(
    `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')
     on conflict (user_id, media_item_id) do nothing`,
    [user, film],
  );
  let step = await call(`rank_start($1, 'loved')`, [film]);
  for (let guard = 0; !step.done && guard < 20; guard += 1) {
    step = await call(`rank_answer($1, $2)`, [step.session_id, film]);
  }
  assert.equal(step.done, true, 'the ranking walk did not terminate');
};

let seq = 960000;
const rankTitles = async (user, count) => {
  for (let i = 0; i < count; i += 1) {
    seq += 1;
    await rankOne(user, await t.createMovie(`Backfill fixture ${seq}`, seq));
  }
};

/** The bar, moved the way the migration moves it. Ten is the history; five is the rule. */
const setBar = (n) =>
  t.sql(`update app_config set value = to_jsonb($1::integer) where key = 'invite.activation_rankings'`, [
    n,
  ]);

/**
 * Pushes one account's history into the past, rankings and redemption together, so their
 * order is preserved. There are no UPDATE triggers on `rankings` — the three that exist
 * are `after insert` and one `after delete` — so this moves timestamps and nothing else.
 */
const age = async (user, interval) => {
  await t.sql(`update rankings set created_at = created_at - $2::interval where user_id = $1`, [
    user,
    interval,
  ]);
  await t.sql(
    `update invite_attributions set accepted_at = accepted_at - $2::interval where invitee_id = $1`,
    [user, interval],
  );
};

const attribution = async (invitee) => {
  const { rows } = await t.sql(
    `select inviter_id, accepted_at, activated_at from invite_attributions where invitee_id = $1`,
    [invitee],
  );
  return rows[0] ?? null;
};

const nthRankingAt = async (user, n) =>
  (
    await t.sql(
      `select created_at from rankings where user_id = $1
        order by created_at, media_item_id offset $2 limit 1`,
      [user, n - 1],
    )
  ).rows[0]?.created_at ?? null;

const runBackfill = async () => (await t.sql(BACKFILL)).rows;

const ms = (value) => new Date(value).getTime();

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t.db.close();
});

describe('the invite activation backfill', () => {
  it('B1/B2: activates five, leaves four, and stamps the fifth ranking when it came last', async () => {
    // Invited first, onboarded afterwards — so the fifth ranking is the later of the two
    // and is the moment they qualified.
    await setBar(10);

    const inviter = await newUser('bf_inviter');
    const ready = await newUser('bf_ready');
    const short = await newUser('bf_short');
    const token = await mintLink(inviter);

    await redeem(ready, token);
    await redeem(short, token);
    await rankTitles(ready, 5);
    await rankTitles(short, 4);

    // Nothing activated, because ten was the rule when this happened. This is the backlog
    // the migration creates, reproduced rather than asserted into existence.
    assert.equal((await attribution(ready)).activated_at, null);

    await age(ready, '3 days');
    await age(short, '3 days');
    const fifth = await nthRankingAt(ready, 5);

    await setBar(5);
    const runAt = Date.now();
    const written = await runBackfill();

    assert.equal(written.length, 1, 'only the account past the bar is touched');
    assert.equal(written[0].invitee_id, ready);

    const row = await attribution(ready);
    assert.equal(ms(row.activated_at), ms(fifth), 'the fifth ranking is when they qualified');
    assert.ok(ms(row.activated_at) < runAt, 'activated_at records the person, not the run');
    assert.ok(ms(row.activated_at) >= ms(row.accepted_at));

    assert.equal((await attribution(short)).activated_at, null, 'four is still four');
  });

  it('B2: stamps accepted_at when the rankings came first, which is the production shape', async () => {
    /**
     * Both production rows on 2026-09-10 look like this: onboarding ranked five titles and
     * the invitation was redeemed twenty to eighty seconds later. Stamping the fifth
     * ranking alone would have recorded an activation *before* the attribution existed.
     * `greatest(..., accepted_at)` is what stops that, and here it is the ordinary path
     * rather than an edge case.
     */
    await setBar(10);

    const inviter = await newUser('bf_late_inviter');
    const invitee = await newUser('bf_late_invitee');

    await rankTitles(invitee, 5);
    const token = await mintLink(inviter);
    await redeem(invitee, token);
    await age(invitee, '1 day');

    const fifth = await nthRankingAt(invitee, 5);

    await setBar(5);
    const written = await runBackfill();
    assert.equal(written.length, 1);

    const row = await attribution(invitee);
    assert.equal(
      ms(row.activated_at),
      ms(row.accepted_at),
      'the redemption is the later of the two, so it is the moment they qualified',
    );
    assert.ok(ms(row.activated_at) > ms(fifth));
  });

  it('B3: a second run writes nothing', async () => {
    // Everything qualifying has already been taken by the two tests above.
    assert.deepEqual(await runBackfill(), []);
  });

  it('B5: files no invite_activated notification for anybody it activated', async () => {
    const { rows } = await t.sql(
      `select count(*)::int as n from notifications where type = 'invite_activated'`,
    );
    assert.equal(rows[0].n, 0, 'the backfill must not announce a cold fact');
  });

  it('B6: leaves an attribution that was never accepted alone', async () => {
    await setBar(10);

    const inviter = await newUser('bf_unaccepted_inviter');
    const invitee = await newUser('bf_unaccepted_invitee');
    const token = await mintLink(inviter);
    await redeem(invitee, token);
    await rankTitles(invitee, 5);

    // The state `data-model.md` calls "an attributed signup that has not yet accepted".
    await t.sql(`update invite_attributions set accepted_at = null where invitee_id = $1`, [
      invitee,
    ]);

    await setBar(5);
    assert.deepEqual(await runBackfill(), []);
    assert.equal((await attribution(invitee)).activated_at, null);
  });

  it('B4: the award trigger fires on the backfilled UPDATE, and announces', async () => {
    /**
     * Three invitees for one inviter, all past the bar, all activated by one statement.
     * Bronze is three, so the trigger's last firing crosses it — and what it does then is
     * the founder-facing consequence of running this: a ledger row, a **public** feed post
     * (`invite-instigator` is a social track), a congratulations notification, and
     * `announced = true`.
     *
     * `announced` is the detail worth pinning. `20260828000100`'s rollout inserted its rows
     * with `announced = false` *directly*, bypassing `_maybe_award_unlocks`, which is why
     * history produced no social event. Anything reaching the announcer announces, and a
     * backfill reaches the announcer.
     */
    await setBar(10);

    const inviter = await newUser('bf_award_inviter');
    const token = await mintLink(inviter);

    for (const name of ['bf_award_a', 'bf_award_b', 'bf_award_c']) {
      const invitee = await newUser(name);
      await redeem(invitee, token);
      await rankTitles(invitee, 5);
      await age(invitee, '5 days');
    }

    await setBar(5);
    const written = await runBackfill();
    assert.equal(written.length, 3);

    const unlocks = (
      await t.sql(
        `select tier_key, value_at_unlock, announced from award_unlocks
          where user_id = $1 and award_key = 'invite-instigator'`,
        [inviter],
      )
    ).rows;
    assert.deepEqual(
      unlocks.map((u) => u.tier_key),
      ['bronze'],
      'three invitees reaches bronze and no further',
    );
    assert.equal(Number(unlocks[0].value_at_unlock), 3, 'frozen at the crossing count');
    assert.equal(unlocks[0].announced, true, 'the announcer ran; announced is not left false');

    const posts = (
      await t.sql(
        `select count(*)::int as n from feed_events
          where actor_id = $1 and type = 'award_earned'
            and payload ->> 'award' = 'invite-instigator'`,
        [inviter],
      )
    ).rows[0].n;
    assert.equal(posts, 1, 'a public feed post, which is a founder decision not a side effect');

    const congrats = (
      await t.sql(
        `select count(*)::int as n from notifications
          where recipient_id = $1 and type = 'award_earned'
            and payload ->> 'award' = 'invite-instigator'`,
        [inviter],
      )
    ).rows[0].n;
    assert.equal(congrats, 1);

    // B5 again, at the point it matters most: the award announced, the invitation did not.
    const activated = (
      await t.sql(
        `select count(*)::int as n from notifications
          where recipient_id = $1 and type = 'invite_activated'`,
        [inviter],
      )
    ).rows[0].n;
    assert.equal(activated, 0);
  });

  it('B3: re-running after the award still writes nothing and announces nothing', async () => {
    assert.deepEqual(await runBackfill(), []);

    const inviter = (await t.sql(`select id from profiles where username = 'bf_award_inviter'`))
      .rows[0].id;
    const posts = (
      await t.sql(
        `select count(*)::int as n from feed_events
          where actor_id = $1 and type = 'award_earned'`,
        [inviter],
      )
    ).rows[0].n;
    assert.equal(posts, 1, 'one crossing, one post, however many times this is run');
  });

  it('reads the bar from app_config, so it is a no-op against the old contract', async () => {
    /**
     * The safety property that makes running this in the wrong order harmless: point it at
     * a database where `20260916000100` has not been applied and it uses ten, finds nobody
     * and writes nothing — rather than activating everybody at five against a schema that
     * still means ten.
     */
    await setBar(10);

    const inviter = await newUser('bf_bar_inviter');
    const invitee = await newUser('bf_bar_invitee');
    const token = await mintLink(inviter);
    await redeem(invitee, token);
    await rankTitles(invitee, 5);
    await age(invitee, '1 day');

    assert.deepEqual(await runBackfill(), [], 'five is not enough while the bar says ten');

    await setBar(5);
    const written = await runBackfill();
    assert.equal(written.length, 1);
    assert.equal(written[0].invitee_id, invitee);
  });
});
