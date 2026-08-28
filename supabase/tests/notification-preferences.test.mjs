import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The notification taxonomy, 20260819000300.
 *
 * Eight categories, one per notification kind, replacing the two that
 * `20260817000800` shipped. What is under test is the gate itself — a before-insert
 * trigger on `notifications` — rather than any one writer, because the trigger is
 * what every writer including the ones not written yet passes through.
 *
 * **Every "it was dropped" assertion has a control beside it.** Review 21's finding,
 * six rounds running, was that an empty result set proves the fixture was wrong at
 * least as often as it proves the code is right. So `gated` asserts both halves in
 * one call: the row is absent for the account that switched the category off, *and*
 * present for a second account that did not. If the trigger were stubbed to drop
 * everything, or to drop nothing, one of the two halves fails.
 */

let t;

/** The account under test — switches things off. */
let muted;
/** The control — identical in every way except that it changes no settings. */
let control;
/** Somebody to be the actor, so no row is ever a self-notification. */
let actor;

const prefs = async (userId) => {
  await t.actAs(userId);
  const { rows } = await t.sql(`select category, enabled from my_notification_preferences()`);
  return Object.fromEntries(rows.map((r) => [r.category, r.enabled]));
};

const setOne = async (userId, category, enabled) => {
  await t.actAs(userId);
  const { rows } = await t.sql(`select set_notification_preference($1, $2) as r`, [
    category,
    enabled,
  ]);
  return rows[0].r;
};

const setMany = async (userId, categories, enabled) => {
  await t.actAs(userId);
  const { rows } = await t.sql(`select set_notification_preferences($1::text[], $2) as r`, [
    categories,
    enabled,
  ]);
  return rows[0].r;
};

/** Files one notification of `type` at `recipient`, and says whether it survived. */
const deliver = async (recipient, type) => {
  await t.sql(
    `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
     values ($1, $2, $3, 'profile', $3)`,
    [recipient, type, actor],
  );
  const { rows } = await t.sql(
    `select count(*)::int as n from notifications where recipient_id = $1 and type = $2`,
    [recipient, type],
  );
  return rows[0].n > 0;
};

const clear = async (recipient) => {
  await t.sql(`delete from notifications where recipient_id = $1`, [recipient]);
};

/**
 * The two-sided assertion. `muted` must not receive it and `control` must.
 *
 * The control is the whole point: it fails if the gate is stubbed either way, and it
 * fails if the fixture stopped being able to produce a row for reasons that have
 * nothing to do with the preference.
 */
const gated = async (type, expectedForMuted) => {
  await clear(muted);
  await clear(control);
  assert.equal(
    await deliver(muted, type),
    expectedForMuted,
    `${type} for the account that switched it off`,
  );
  assert.equal(await deliver(control, type), true, `${type} for the control account`);
};

before(async () => {
  t = await createTestDb();
  muted = await t.createUser({ username: 'muted_prefs' });
  control = await t.createUser({ username: 'control_prefs' });
  actor = await t.createUser({ username: 'actor_prefs' });
});

after(async () => {
  await t?.close();
});

describe('the defaults', () => {
  /**
   * All eight on, since 20260828000100.
   *
   * `reactions` moved on 20260820 (founder Preview pass); `awards` was the last
   * holdout, off only because nothing wrote one. The award-unlock ledger gave
   * `award_earned` its writer, so the reasoning that kept it off — do not pretend
   * the functionality exists — now keeps it on: a congratulations that arrives
   * unwanted is a setting somebody turns off, and one that never arrives is a bug
   * nobody can see.
   */
  it('answers for all eight categories, all on', async () => {
    assert.deepEqual(await prefs(control), {
      follows: true,
      follow_accepted: true,
      comments: true,
      reactions: true,
      watch_tags: true,
      recommendations: true,
      invites: true,
      awards: true,
    });
  });

  it('writes no row until a switch is touched', async () => {
    const { rows } = await t.sql(
      `select count(*)::int as n from notification_preferences where user_id = $1`,
      [control],
    );
    assert.equal(rows[0].n, 0, 'a default must not cost a row');
  });

  it('delivers every default-on kind, award_earned now among them', async () => {
    for (const type of [
      'follow',
      'follow_approved',
      'comment',
      'reaction',
      'watch_tag',
      'recommendation',
      'invite_activated',
      'award_earned',
    ]) {
      await clear(control);
      assert.equal(await deliver(control, type), true, `${type} defaults on`);
    }
    await clear(control);
  });

  /**
   * **The founder's hard requirement, and the reason this needed no backfill.**
   *
   * Changing a product default must not reach into an account that already chose. It
   * cannot here, structurally: `_notifies` coalesces to the account's own row and only
   * falls through to `_notification_default` when there is no row. This asserts the
   * property rather than trusting the structure, because the whole class of bug being
   * avoided is a migration that helpfully 'fixes up' existing accounts.
   */
  it('leaves an account that switched reactions off switched off', async () => {
    const chose = await t.createUser({ username: 'chose_prefs' });
    await setOne(chose, 'reactions', false);

    // The new default is on. This account said otherwise, so it stays off — and the
    // control beside it proves the gate is still capable of delivering a reaction.
    assert.equal((await prefs(chose)).reactions, false);
    await clear(chose);
    assert.equal(await deliver(chose, 'reaction'), false);
    await clear(control);
    assert.equal(await deliver(control, 'reaction'), true);
  });

  it('leaves an account that switched an already-on category off alone too', async () => {
    // The same guarantee in the direction the default did not move, so the test is
    // about explicit rows rather than about `reactions` specifically.
    const chose = await t.createUser({ username: 'chose_comments' });
    await setOne(chose, 'comments', false);
    assert.equal((await prefs(chose)).comments, false);
    await clear(chose);
    assert.equal(await deliver(chose, 'comment'), false);
  });

  it('still writes no row for an account that has chosen nothing', async () => {
    // The default is a function, not a backfill. If this migration had written rows,
    // the next default change would have to write them again — and would overwrite the
    // choices this one was careful not to touch.
    const { rows } = await t.sql(
      `select count(*)::int as n from notification_preferences where user_id = $1`,
      [control],
    );
    assert.equal(rows[0].n, 0);
  });
});

describe('each category gates exactly its own kind', () => {
  const cases = [
    ['follows', 'follow'],
    ['follow_accepted', 'follow_approved'],
    ['comments', 'comment'],
    ['watch_tags', 'watch_tag'],
    ['recommendations', 'recommendation'],
    ['invites', 'invite_activated'],
  ];

  for (const [category, type] of cases) {
    it(`${category} off drops ${type}`, async () => {
      await setOne(muted, category, false);
      await gated(type, false);
      await setOne(muted, category, true);
      await gated(type, true);
    });
  }

  it('reactions off drops a reaction, and back on delivers one', async () => {
    await setOne(muted, 'reactions', true);
    await clear(muted);
    assert.equal(await deliver(muted, 'reaction'), true);
    await setOne(muted, 'reactions', false);
    await clear(muted);
    assert.equal(await deliver(muted, 'reaction'), false);
  });

  it('awards off drops a congratulations, and back on delivers one', async () => {
    await setOne(muted, 'awards', true);
    await clear(muted);
    assert.equal(await deliver(muted, 'award_earned'), true);
    await setOne(muted, 'awards', false);
    await clear(muted);
    assert.equal(await deliver(muted, 'award_earned'), false);
  });

  it('silencing one category leaves the other seven alone', async () => {
    await setOne(muted, 'comments', false);
    await clear(muted);

    assert.equal(await deliver(muted, 'comment'), false);
    assert.equal(await deliver(muted, 'follow'), true);
    assert.equal(await deliver(muted, 'watch_tag'), true);
    assert.equal(await deliver(muted, 'recommendation'), true);

    await setOne(muted, 'comments', true);
    await clear(muted);
  });
});

describe('what cannot be silenced', () => {
  /**
   * A request is a task, not news. An account that could silence it would receive
   * requests it can never see and never answer, and the requester would wait for
   * ever — so there is no category that maps to it, and the trigger states the
   * exemption as its own condition rather than leaving it to the map.
   */
  it('delivers follow_request with every category switched off', async () => {
    const all = [
      'follows',
      'follow_accepted',
      'comments',
      'reactions',
      'watch_tags',
      'recommendations',
      'invites',
      'awards',
    ];
    await setMany(muted, all, false);
    await clear(muted);

    assert.equal(await deliver(muted, 'follow_request'), true);
    assert.equal(await deliver(muted, 'follow'), false, 'the control: everything else is off');

    await setMany(muted, all, true);
    await clear(muted);
  });

  /**
   * A kind added later and forgotten in the map reaches its recipient rather than
   * vanishing. The other default is silent and undetectable.
   */
  it('delivers a kind the map has never heard of', async () => {
    await setMany(
      muted,
      ['follows', 'comments', 'reactions', 'recommendations'],
      false,
    );
    await clear(muted);
    assert.equal(await deliver(muted, 'something_invented_later'), true);
    await setMany(muted, ['follows', 'comments', 'reactions', 'recommendations'], true);
    await clear(muted);
  });
});

describe('recommendations became silenceable', () => {
  /**
   * The regression this migration closes. `20260817000800`'s `case` had no arm for
   * `recommendation`, so `v_category` came out null and the unmapped-type rule
   * delivered it unconditionally. It was unsilenceable by accident rather than by
   * decision — the only kind in that position that was not `follow_request`.
   */
  it('drops a recommendation for an account that switched them off', async () => {
    await setOne(muted, 'recommendations', false);
    await gated('recommendation', false);
    await setOne(muted, 'recommendations', true);
  });
});

describe('the bulk writer, which is what a section master switch is', () => {
  it('sets a whole section in one call', async () => {
    await setMany(muted, ['follows', 'follow_accepted', 'comments', 'reactions', 'watch_tags'], false);

    const after = await prefs(muted);
    assert.equal(after.follows, false);
    assert.equal(after.follow_accepted, false);
    assert.equal(after.comments, false);
    assert.equal(after.reactions, false);
    assert.equal(after.watch_tags, false);
    // Untouched sections keep their own values, which is what makes the master a
    // section control rather than an app-wide one.
    assert.equal(after.recommendations, true);
    assert.equal(after.invites, true);
  });

  it('turns the same section back on', async () => {
    await setMany(muted, ['follows', 'follow_accepted', 'comments', 'reactions', 'watch_tags'], true);

    const after = await prefs(muted);
    assert.equal(after.follows, true);
    assert.equal(after.comments, true);
    // A master ON sets every configurable child on, including one that defaults off.
    // That is the deterministic reading of "all social notifications on", and it is
    // why the screen can render the master from the children without a third state.
    assert.equal(after.reactions, true);
  });

  /**
   * The lost-reply case. A master switch whose response never arrived is retried,
   * and the retry has to be the same write rather than a toggle.
   */
  it('is idempotent under retry', async () => {
    const section = ['recommendations', 'invites'];
    await setMany(muted, section, false);
    const once = await prefs(muted);
    await setMany(muted, section, false);
    await setMany(muted, section, false);
    const thrice = await prefs(muted);

    assert.deepEqual(thrice, once, 'three identical calls are one state');
    assert.equal(thrice.recommendations, false);
    assert.equal(thrice.invites, false);

    await setMany(muted, section, true);
  });

  /**
   * All-or-nothing. Validating inside the insert would apply the valid prefix and
   * then raise, which is precisely the half-applied master this function exists to
   * make impossible.
   */
  it('writes nothing at all when one category in the batch is unknown', async () => {
    const before = await prefs(muted);

    await t.actAs(muted);
    const error = await t.errorFrom(
      `select set_notification_preferences($1::text[], $2)`,
      [['comments', 'watch_tags', 'not_a_category'], false],
    );

    assert.ok(error, 'an unknown category must raise');
    assert.equal(error.code, '22023');
    assert.deepEqual(await prefs(muted), before, 'no category may have been written');
  });

  it('refuses the retired social category by name', async () => {
    await t.actAs(muted);
    const error = await t.errorFrom(`select set_notification_preference($1, $2)`, [
      'social',
      false,
    ]);
    assert.ok(error, '`social` was replaced by its three children');
    assert.equal(error.code, '22023');
  });

  /**
   * Independent review 23, first Minor. `not (null = any (...))` is **null, not true**,
   * so a null element slipped past the unknown-category check and failed later on the
   * table's own not-null constraint — 23502 where this function promises a statement
   * about its input. Nothing was ever written either way; the answer was wrong.
   */
  it('refuses a null element with its own error rather than a constraint violation', async () => {
    const before = await prefs(muted);

    await t.actAs(muted);
    const error = await t.errorFrom(`select set_notification_preferences($1::text[], $2)`, [
      ['comments', null, 'watch_tags'],
      false,
    ]);

    assert.ok(error, 'a null category must raise');
    assert.equal(error.code, '22023', 'and it must be this function saying so');
    assert.deepEqual(await prefs(muted), before, 'no category may have been written');
  });

  /**
   * Review 23's other half. `on conflict do update` cannot touch one row twice in a
   * single statement, so a repeated category raised 21000. Every copy asks for the
   * same value, so collapsing them is the same write.
   */
  it('accepts a repeated category, because every copy asks for the same thing', async () => {
    const result = await setMany(muted, ['comments', 'comments', 'watch_tags'], false);
    assert.equal(result.status, 'ok');

    const after = await prefs(muted);
    assert.equal(after.comments, false);
    assert.equal(after.watch_tags, false);

    await setMany(muted, ['comments', 'watch_tags'], true);
  });

  it('refuses an empty batch and a null value', async () => {
    await t.actAs(muted);

    const empty = await t.errorFrom(`select set_notification_preferences($1::text[], $2)`, [
      [],
      false,
    ]);
    assert.ok(empty, 'an empty batch is not a write');
    assert.equal(empty.code, '22023');

    const nullEnabled = await t.errorFrom(
      `select set_notification_preferences($1::text[], null)`,
      [['comments']],
    );
    assert.ok(nullEnabled, 'null is neither on nor off');
    assert.equal(nullEnabled.code, '22023');
  });
});

/**
 * The check-then-insert race, independent review 23b.
 *
 * Every writer that files a notification checks the actor may reach the recipient
 * before inserting, and none holds a pair lock across the gap. So a block can commit
 * in between: `block()` deletes the notifications that exist, the writer's transaction
 * then commits a new one, and the delete never saw it.
 *
 * The interleaving is simulated by writing the row *after* the block, which is exactly
 * the state that ordering leaves behind — the point is what the inbox does with a row
 * that is already there, not how it got there.
 */
describe('a blocked actor stops being named, however their row arrived', () => {
  let reader;
  let blocked;

  const inboxOf = async (userId) => {
    await t.actAs(userId);
    const { rows } = await t.sql(`select id, kind, actor_username from my_notifications(100)`);
    return rows;
  };

  before(async () => {
    reader = await t.createUser({ username: 'reader_race' });
    blocked = await t.createUser({ username: 'blocked_race' });
  });

  it('hides a notification that landed after the block committed', async () => {
    await t.actAs(reader);
    await t.sql(`select block(gen_random_uuid(), $1)`, [blocked]);

    // The racing writer's insert, committing after `block()` already ran its delete.
    await t.actAs(null);
    await t.sql(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'comment', $2, 'profile', $2)`,
      [reader, blocked],
    );

    const { rows: present } = await t.sql(
      `select count(*)::int as n from notifications where recipient_id = $1 and actor_id = $2`,
      [reader, blocked],
    );
    assert.equal(present[0].n, 1, 'the row is really there — this is a read-side fix');

    assert.deepEqual(await inboxOf(reader), [], 'and the inbox must not name them');
  });

  /**
   * Review 23c. The predicate above lives in `my_notifications`, and until this run
   * `notifications_own` let a client select the table itself — so the raced row was
   * still reachable over PostgREST with its actor id, type, subject and payload, and a
   * realtime subscription would have carried it too. A predicate in one read path is
   * not a predicate.
   */
  it('does not let the recipient read the table around the function', async () => {
    const error = await t.asUser(reader, () =>
      t.errorFrom(`select * from notifications where recipient_id = $1`, [reader]),
    );
    await t.actAs(null);

    assert.ok(error, 'the inbox table is not a client surface');
    assert.equal(error.code, '42501');
  });

  /**
   * The backstop, asserted directly — independent review 23d.
   *
   * `notifications_own` is kept and is unreachable while the grant is gone, so no
   * behavioural test can see it: drop the policy and every assertion above still
   * passes. That is precisely the shape of a guard that quietly stops existing. If a
   * later migration re-grants `select`, this policy is the only thing standing between
   * one account and another's inbox, so it is asserted structurally.
   */
  it('keeps the recipient-only policy as a backstop behind the revoke', async () => {
    const { rows } = await t.sql(
      `select cmd, roles, qual from pg_policies
        where schemaname = 'public' and tablename = 'notifications' and policyname = 'notifications_own'`,
    );

    assert.equal(rows.length, 1, 'the policy must still exist');

    // `cmd` and `roles` as well as the predicate — review 23e. Asserting the
    // expression alone would pass for a policy silently changed to `for update`, or
    // narrowed to some role that is not the one which would regain select.
    assert.equal(rows[0].cmd, 'SELECT', 'it has to be a read policy to be a read backstop');
    assert.deepEqual([...rows[0].roles], ['public'], 'and it has to cover whoever regains the grant');

    /**
     * Equality, not a substring. `assert.match(/recipient_id=auth\.uid\(\)/)` is
     * satisfied by `recipient_id = auth.uid() or true`, which is the one rewrite a
     * backstop test exists to catch. Whitespace-only normalisation, because Postgres
     * re-renders the stored expression with its own spacing and outer parens.
     */
    assert.equal(String(rows[0].qual).replace(/\s/g, ''), '(recipient_id=auth.uid())');
  });

  /**
   * The control, and the reason the assertion above means anything. An identical row
   * from an unblocked account must still arrive — otherwise the test would pass with
   * `my_notifications` returning nothing at all.
   */
  it('still names an actor who is not blocked', async () => {
    const friend = await t.createUser({ username: 'friend_race' });
    await t.actAs(null);
    await t.sql(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'comment', $2, 'profile', $2)`,
      [reader, friend],
    );

    const rows = await inboxOf(reader);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_username, 'friend_race');
  });

  /**
   * The distinction `can_discover_profile` exists to draw. A private account's follow
   * request must still arrive and still be answerable — `can_view_profile` would hide
   * it, and the request would sit pending for ever with both parties waiting.
   */
  it('still delivers a follow request from a private account it cannot view', async () => {
    const shy = await t.createUser({ username: 'shy_race', visibility: 'private' });
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [reader]);

    await t.actAs(shy);
    await t.sql(`select follow(gen_random_uuid(), $1)`, [reader]);

    // The premise: the reader genuinely cannot view them.
    await t.actAs(null);
    const { rows: viewable } = await t.sql(`select can_view_profile($1, $2) as v`, [reader, shy]);
    assert.equal(viewable[0].v, false, 'the fixture must actually be unviewable');

    const rows = await inboxOf(reader);
    const request = rows.find((r) => r.kind === 'follow_request');
    assert.ok(request, 'a request that cannot be seen cannot be answered');
    assert.equal(request.actor_username, 'shy_race');
  });
});

describe('a preference is the caller\'s own and nobody else\'s', () => {
  it('reads only the caller, so two accounts do not see each other', async () => {
    await setOne(muted, 'comments', false);

    assert.equal((await prefs(muted)).comments, false);
    assert.equal((await prefs(control)).comments, true, 'the control was never changed');

    await setOne(muted, 'comments', true);
  });

  it('writes only the caller', async () => {
    /**
     * Before and after, rather than "no other account has a row at all".
     *
     * The absolute form passed until the default-preservation tests above created
     * accounts that deliberately hold explicit rows, and then it failed for a reason
     * that had nothing to do with what it is testing. What it means to assert is that
     * *this call* touched nobody else, so that is what it now compares — which is also
     * the stronger claim, since it would catch a writer that overwrote an existing row
     * belonging to somebody else rather than only one that inserted a new one.
     */
    const others = async () => {
      const { rows } = await t.sql(
        `select user_id, category, enabled from notification_preferences
          where user_id <> $1 order by user_id, category`,
        [muted],
      );
      return JSON.stringify(rows);
    };

    const before = await others();
    await setOne(muted, 'watch_tags', false);
    assert.equal(await others(), before, 'no other account was written to');

    await setOne(muted, 'watch_tags', true);
  });
});
