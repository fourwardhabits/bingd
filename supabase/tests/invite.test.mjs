import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The invitation resolver, 20260819000500.
 *
 * `invite_attributions` had carried `accepted_at` and `activated_at` since
 * `20260813001300` with nothing writing either, so this is the first file in the
 * repository that can assert anything about them.
 *
 * The properties that carry these three functions:
 *
 *   1. **One inviter, for good.** The primary key on `invitee_id` is the rule, not a
 *      check any function makes. A replay, a second token and a second device must all
 *      leave the first attribution exactly where it is — a redemption that could move
 *      credit is the defect this whole design is shaped around.
 *   2. **Unknown, revoked and cross-environment are one answer.** Telling them apart
 *      confirms that a token was once real, which is precisely what 128 bits of entropy
 *      exists to withhold.
 *   3. **Refusals cost a slot.** They are returned rather than raised, so the operation
 *      claim survives and a wrong token is spent from the same budget as a right one.
 *      This is the one writer in the schema where a refused attempt is what an attack
 *      looks like.
 *   4. **Activation is once, and it is not the notification.** `activated_at` is set
 *      even when the inviter is gone, suspended or has blocked the invitee, because it
 *      is a fact about the invitee. The inbox row is a message between two people and
 *      is not.
 *   5. **`record_invite_open` answers nothing.** It returns void for a live token and
 *      for a fabricated one alike, or the anonymous page that calls it becomes a way to
 *      test tokens.
 *
 * Concurrency is not asserted here — PGlite is one connection, so no race can be
 * constructed. `supabase/tests/concurrency/races/invite-redeem.mjs` covers it against a
 * real PostgreSQL with independent sessions.
 */

let t;

const call = async (sql, params = []) => {
  const { rows } = await t.sql(`select ${sql} as r`, params);
  return rows[0].r;
};

const newUser = (username, visibility = 'public') => t.createUser({ username, visibility });

/** The caller's own live invite link, minted through the shipped writer. */
const mintLink = async (owner) => {
  await t.actAs(owner);
  const result = await call(`create_invite_link(gen_random_uuid())`);
  assert.equal(result.status, 'ok');
  return result.token;
};

const redeem = (token) => call(`redeem_invite(gen_random_uuid(), $1)`, [token]);

const attribution = async (invitee) => {
  const { rows } = await t.sql(
    `select inviter_id, token_id, accepted_at, activated_at
       from invite_attributions where invitee_id = $1`,
    [invitee],
  );
  return rows[0] ?? null;
};

const inbox = async (recipient) => {
  const { rows } = await t.sql(
    `select type, actor_id, subject_type, subject_id from notifications
      where recipient_id = $1 and type = 'invite_activated'`,
    [recipient],
  );
  return rows;
};

/**
 * Ranks one title for the acting user, driving the comparison walk to a placement.
 *
 * Only the first title in a band places directly; every one after it opens a binary
 * search, so a fixture that called `rank_start` and assumed `done` would stop at one
 * ranking and every activation assertion here would be vacuous. The subject wins each
 * comparison, which is arbitrary and is the point — what is under test is that a
 * placement happened, not where.
 *
 * Returns the finalising step, so a caller can read `activated` off the real answer.
 */
const rankOne = async (user, film) => {
  await t.actAs(user);
  await t.sql(
    `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')
     on conflict (user_id, media_item_id) do nothing`,
    [user, film],
  );

  let step = await call(`rank_start($1, 'loved')`, [film]);
  // Bounded, so a walk that stopped terminating fails here rather than hanging the
  // suite. Ten titles need four comparisons; twenty is far above any real depth.
  for (let guard = 0; !step.done && guard < 20; guard += 1) {
    step = await call(`rank_answer($1, $2)`, [step.session_id, film]);
  }
  assert.equal(step.done, true, 'the ranking walk did not terminate');
  return step;
};

const rankTitles = async (user, count, from = 0) => {
  for (let i = 0; i < count; i += 1) {
    await rankOne(user, await t.createMovie(`Fixture ${from + i}`, 900000 + from + i));
  }
};

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t.db.close();
});

describe('the token', () => {
  it('is 32 lowercase hex characters, drawn from a CSPRNG', async () => {
    /**
     * `create_invite_link` builds it from `gen_random_uuid()` with the dashes removed.
     * The shape matters beyond aesthetics: it is what `tokenFromPath` in the web router
     * and `isInviteToken` on the client validate against, and it is what makes a token
     * safe to concatenate into a `bingd://` URL. The alphabet contains no character that
     * means anything in a URL, in HTML or in SQL.
     */
    const token = await mintLink(await newUser('minter'));
    assert.match(token, /^[0-9a-f]{32}$/);
  });

  it('encodes nothing about its owner', async () => {
    // Two tokens from the same account share no prefix and no structure. A token that
    // leaked its owner would make the link a way to name an account from outside.
    const owner = await newUser('twice');
    const first = await mintLink(owner);
    await t.sql(`update invite_tokens set revoked_at = now() where owner_id = $1`, [owner]);
    const second = await mintLink(owner);

    assert.notEqual(first, second);
    assert.ok(!second.startsWith(first.slice(0, 8)));
  });

  it('does not let a short code be a head start on the token', async () => {
    // Drawn from a separate uuid rather than sliced off the token (20260817001300), so
    // somebody who was read the code aloud has learned nothing about the link.
    const owner = await newUser('shortcode');
    await t.actAs(owner);
    const result = await call(`create_invite_link(gen_random_uuid())`);
    assert.ok(!result.token.includes(result.short_code.toLowerCase()));
  });
});

describe('redeem_invite', () => {
  it('attributes an invitee to the token owner, once', async () => {
    const inviter = await newUser('inviter1');
    const invitee = await newUser('invitee1');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    const result = await redeem(token);

    assert.equal(result.status, 'ok');
    assert.equal(result.inviter_username, 'inviter1');

    const row = await attribution(invitee);
    assert.equal(row.inviter_id, inviter);
    assert.ok(row.accepted_at);
    assert.equal(row.activated_at, null, 'redemption is not activation');
  });

  it('records the growth provenance PRD §17 requires on every account', async () => {
    // `profiles.invited_by` has existed since 20260813000200 and this is its first
    // writer. It is impossible to reconstruct later, which is why the PRD asks for it
    // from day one rather than when a reward exists.
    const inviter = await newUser('inviter2');
    const invitee = await newUser('invitee2');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    await redeem(token);

    const { rows } = await t.sql(`select invited_by from profiles where id = $1`, [invitee]);
    assert.equal(rows[0].invited_by, inviter);
  });

  it('gives one answer for a token that never existed, was revoked, or is another env', async () => {
    /**
     * Property 2. `revoked` would confirm that a token was once real; `wrong_env` would
     * confirm that somebody is running a non-production build. Both are facts a holder
     * of a random string should not be able to establish.
     */
    const inviter = await newUser('inviter3');
    const invitee = await newUser('invitee3');
    const live = await mintLink(inviter);

    await t.sql(`update invite_tokens set revoked_at = now() where token = $1`, [live]);

    const other = await newUser('inviter3b');
    const foreign = await mintLink(other);
    await t.sql(`update invite_tokens set env = 'production' where token = $1`, [foreign]);

    await t.actAs(invitee);
    for (const token of ['0'.repeat(32), live, foreign]) {
      const result = await redeem(token);
      assert.deepEqual(result, { status: 'refused', reason: 'invalid' });
    }
    assert.equal(await attribution(invitee), null);
  });

  it('refuses somebody their own link, as an answer rather than a constraint failure', async () => {
    // `no_self_invite` would catch this as a 23514, and opening your own link is the
    // ordinary way a person checks what they just shared.
    const owner = await newUser('selfer');
    const token = await mintLink(owner);

    await t.actAs(owner);
    assert.deepEqual(await redeem(token), { status: 'refused', reason: 'self' });
  });

  it('refuses across a block, in either direction', async () => {
    for (const [name, blocker] of [
      ['inviter blocked the invitee', 'inviter'],
      ['invitee blocked the inviter', 'invitee'],
    ]) {
      const inviter = await newUser(`b_inviter_${blocker}`);
      const invitee = await newUser(`b_invitee_${blocker}`);
      const token = await mintLink(inviter);

      await t.actAs(blocker === 'inviter' ? inviter : invitee);
      await call(`block(gen_random_uuid(), $1)`, [blocker === 'inviter' ? invitee : inviter]);

      await t.actAs(invitee);
      assert.deepEqual(await redeem(token), { status: 'refused', reason: 'blocked' }, name);
      assert.equal(await attribution(invitee), null, name);
    }
  });

  it('refuses a suspended inviter without saying which of the two it was', async () => {
    const inviter = await newUser('suspended_inviter');
    const invitee = await newUser('invitee_of_suspended');
    const token = await mintLink(inviter);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [inviter]);

    await t.actAs(invitee);
    assert.deepEqual(await redeem(token), { status: 'refused', reason: 'unavailable' });
  });

  it('refuses a suspended invitee, like every other writer', async () => {
    const inviter = await newUser('inviter_of_suspended');
    const invitee = await newUser('suspended_invitee');
    const token = await mintLink(inviter);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [invitee]);

    await t.actAs(invitee);
    const error = await t.errorFrom(`select redeem_invite(gen_random_uuid(), $1)`, [token]);
    assert.equal(error?.code, '42501');
  });

  it('is idempotent on a replayed operation id, and answers with what happened', async () => {
    const inviter = await newUser('inviter4');
    const invitee = await newUser('invitee4');
    const token = await mintLink(inviter);
    const op = (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

    await t.actAs(invitee);
    assert.equal((await call(`redeem_invite($1, $2)`, [op, token])).status, 'ok');

    const replay = await call(`redeem_invite($1, $2)`, [op, token]);
    assert.deepEqual(replay, { status: 'already_applied', attributed: true });

    const { rows } = await t.sql(
      `select count(*)::int as n from invite_attributions where invitee_id = $1`,
      [invitee],
    );
    assert.equal(rows[0].n, 1);
  });

  it('never moves an attribution to a second inviter', async () => {
    /**
     * Property 1, and the single most important assertion in this file. A second token
     * is a genuinely different call with a different operation id — not a replay — and
     * it still must not change who gets the credit.
     */
    const first = await newUser('first_inviter');
    const second = await newUser('second_inviter');
    const invitee = await newUser('invitee5');
    const firstToken = await mintLink(first);
    const secondToken = await mintLink(second);

    await t.actAs(invitee);
    await redeem(firstToken);
    const answer = await redeem(secondToken);

    assert.deepEqual(answer, { status: 'refused', reason: 'already_attributed' });
    assert.equal((await attribution(invitee)).inviter_id, first);
  });

  it('does not name the existing inviter when it refuses a second one', async () => {
    // It may be an account this caller cannot see — one that has since blocked them, or
    // been suspended. The refusal carries a reason and nothing else.
    const first = await newUser('unnamed_inviter');
    const second = await newUser('other_inviter');
    const invitee = await newUser('invitee6');
    // Both tokens minted before acting as the invitee: `mintLink` acts as the owner.
    const firstToken = await mintLink(first);
    const secondToken = await mintLink(second);

    await t.actAs(invitee);
    assert.equal((await redeem(firstToken)).status, 'ok');
    const answer = await redeem(secondToken);

    assert.deepEqual(answer, { status: 'refused', reason: 'already_attributed' });
    assert.equal(JSON.stringify(answer).includes(first), false);
    assert.equal(JSON.stringify(answer).includes('unnamed_inviter'), false);
  });

  it('spends a slot on a refusal, so a wrong token is not free', async () => {
    /**
     * Property 3. Refusals are returned rather than raised precisely so the operation
     * claim survives — a raise would roll it back and brute force would cost nothing.
     * The ceiling is deliberately low: a legitimate account redeems once, ever.
     */
    const invitee = await newUser('brute');
    await t.sql(`update app_config set value = '3'::jsonb
                  where key = 'invite.max_redeem_attempts_per_day'`);

    await t.actAs(invitee);
    // Three wrong tokens, each answered rather than raised — so each keeps its claim.
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(await redeem('0'.repeat(32)), { status: 'refused', reason: 'invalid' });
    }

    const error = await t.errorFrom(`select redeem_invite(gen_random_uuid(), $1)`, ['0'.repeat(32)]);
    assert.equal(error?.code, '53400', 'a wrong token must count against the ceiling');

    await t.sql(`update app_config set value = '10'::jsonb
                  where key = 'invite.max_redeem_attempts_per_day'`);
  });

  it('a spent operation id is answered already_applied, whatever the token now says', async () => {
    /**
     * Independent review 26b's first Major, at the layer where it is a *fact* rather
     * than a client policy. `_claim_operation` commits for every settled answer,
     * including a refusal — so an id spent on a refused attempt can never be used to
     * try again, and the server does not look at the token, the block or the suspension
     * a second time.
     *
     * This is why `recordRecoverableRefusal` releases the id. Asserted here so the
     * client's reason for doing so is a demonstrated behaviour rather than a comment.
     */
    const inviter = await newUser('ledger_inviter');
    const invitee = await newUser('ledger_invitee');
    const token = await mintLink(inviter);

    await t.actAs(inviter);
    await call(`block(gen_random_uuid(), $1)`, [invitee]);

    const op = (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
    await t.actAs(invitee);
    assert.deepEqual(await call(`redeem_invite($1, $2)`, [op, token]), {
      status: 'refused',
      reason: 'blocked',
    });

    // The block is lifted, which is exactly the case the client retries for.
    await t.actAs(inviter);
    await call(`unblock(gen_random_uuid(), $1)`, [invitee]);
    await t.actAs(invitee);

    // The same id learns nothing.
    assert.deepEqual(await call(`redeem_invite($1, $2)`, [op, token]), {
      status: 'already_applied',
      attributed: false,
    });
    assert.equal(await attribution(invitee), null);

    // A fresh one succeeds, which is what makes the client's release the whole fix.
    assert.equal((await redeem(token)).status, 'ok');
    assert.equal((await attribution(invitee)).inviter_id, inviter);
  });

  it('is not callable by anon', async () => {
    // PRD §17: the recipient must have an account. There is nothing for an anonymous
    // caller to attribute, and a grant would only widen the surface.
    const error = await t.asAnon(() =>
      t.errorFrom(`select redeem_invite(gen_random_uuid(), $1)`, ['0'.repeat(32)]),
    );
    assert.equal(error?.code, '42501');
  });
});

describe('acceptance semantics (PRD §17)', () => {
  /**
   * Added after independent review 26.
   *
   * The first version of `redeem_invite` wrote the attribution and stopped, and the
   * omission was recorded in the PRD as a deliberate narrowing. That was rejected, and
   * correctly: a specification is not amended by a note saying it was not implemented.
   * These are §17's clauses 2, 3 and 4, one test each.
   */
  const followRow = async (follower, followee) => {
    const { rows } = await t.sql(
      `select state, approved_at from follows where follower_id = $1 and followee_id = $2`,
      [follower, followee],
    );
    return rows[0] ?? null;
  };

  const noticesTo = async (recipient, actor) => {
    const { rows } = await t.sql(
      `select type from notifications where recipient_id = $1 and actor_id = $2 order by created_at`,
      [recipient, actor],
    );
    return rows.map((r) => r.type);
  };

  it('clause 2: acceptance follows a public inviter, one way', async () => {
    const inviter = await newUser('accept_public');
    const invitee = await newUser('accepter_public');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    assert.equal((await redeem(token)).follow_state, 'approved');

    const edge = await followRow(invitee, inviter);
    assert.equal(edge.state, 'approved');
    assert.ok(edge.approved_at);
    // One way. Clause 4: the inviter is prompted to follow back, never auto-followed.
    assert.equal(await followRow(inviter, invitee), null);
  });

  it('clause 3: a private inviter receives a request, not a follow', async () => {
    // The private setting is honoured rather than bypassed, which is the whole reason
    // §17 spells this clause out separately.
    const inviter = await newUser('accept_private', 'private');
    const invitee = await newUser('accepter_private');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    assert.equal((await redeem(token)).follow_state, 'pending');

    const edge = await followRow(invitee, inviter);
    assert.equal(edge.state, 'pending');
    assert.equal(edge.approved_at, null);
  });

  it('clause 4: the inviter is told, and told the right thing', async () => {
    const publicInviter = (await t.sql(`select id from profiles where username = 'accept_public'`))
      .rows[0].id;
    const publicInvitee = (
      await t.sql(`select id from profiles where username = 'accepter_public'`)
    ).rows[0].id;
    assert.deepEqual(await noticesTo(publicInviter, publicInvitee), ['follow']);

    const privateInviter = (
      await t.sql(`select id from profiles where username = 'accept_private'`)
    ).rows[0].id;
    const privateInvitee = (
      await t.sql(`select id from profiles where username = 'accepter_private'`)
    ).rows[0].id;
    // A request, because it is a task rather than news — and `follow_request` is
    // exempt from the preference map for exactly that reason (20260819000300).
    assert.deepEqual(await noticesTo(privateInviter, privateInvitee), ['follow_request']);
  });

  it('never downgrades an existing approved follow, and files no second notice', async () => {
    /**
     * The invitee already following their inviter is ordinary — they were sent the link
     * by somebody they know. `follow`'s own "never downgraded" rule applies here for the
     * same reason: re-adding a follow after the account went private must not demote an
     * approved edge to pending, or anybody could revoke their own access by accepting an
     * invitation twice.
     */
    const inviter = await newUser('already_followed');
    const invitee = await newUser('already_follower');
    const token = await mintLink(inviter);

    await t.actAs(invitee);
    await call(`follow(gen_random_uuid(), $1)`, [inviter]);
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [inviter]);

    const result = await redeem(token);

    assert.equal(result.status, 'ok');
    assert.equal(result.follow_state, 'approved', 'the state reported is the one that exists');
    assert.equal((await followRow(invitee, inviter)).state, 'approved');
    // One notice, from the follow. Redemption added none.
    assert.deepEqual(await noticesTo(inviter, invitee), ['follow']);
  });

  it('writes the attribution even when the follow already existed', async () => {
    // Clause 7: attribution is recorded independently of the follow.
    const invitee = (await t.sql(`select id from profiles where username = 'already_follower'`))
      .rows[0].id;
    const inviter = (await t.sql(`select id from profiles where username = 'already_followed'`))
      .rows[0].id;
    assert.equal((await attribution(invitee)).inviter_id, inviter);
  });

  it('creates no follow when the invitation was refused', async () => {
    // Every refusal returns before the follow, so a wrong token cannot be used to
    // manufacture an edge against somebody who never shared a link.
    const stranger = await newUser('never_shared');
    const prober = await newUser('prober');

    await t.actAs(prober);
    assert.deepEqual(await redeem('0'.repeat(32)), { status: 'refused', reason: 'invalid' });
    assert.equal(await followRow(prober, stranger), null);
  });
});

describe('revoke_invite_link', () => {
  /**
   * Added after independent review 26. `invite_tokens.revoked_at` and the
   * `invite_tokens_one_live` partial index have supported revocation since
   * `20260813001300` with no writer, and PRD §17 has promised it since v0.6.
   *
   * It becomes urgent with this migration rather than earlier for a specific reason: a
   * leaked link used to resolve to nothing, and now it is a live attribution vector.
   */
  const liveToken = async (owner) => {
    const { rows } = await t.sql(
      `select token from invite_tokens where owner_id = $1 and revoked_at is null`,
      [owner],
    );
    return rows[0]?.token ?? null;
  };

  it('replaces the link in one call, so an account is never left without one', async () => {
    const owner = await newUser('revoker');
    const before = await mintLink(owner);

    await t.actAs(owner);
    const result = await call(`revoke_invite_link(gen_random_uuid())`);

    assert.equal(result.status, 'ok');
    assert.match(result.token, /^[0-9a-f]{32}$/);
    assert.notEqual(result.token, before);
    assert.equal(await liveToken(owner), result.token);
  });

  it('makes the old link refuse, with the same answer a token that never existed gets', async () => {
    const owner = await newUser('revoker2');
    const invitee = await newUser('too_late');
    const old = await mintLink(owner);

    await t.actAs(owner);
    await call(`revoke_invite_link(gen_random_uuid())`);

    await t.actAs(invitee);
    // Not `revoked`. Telling them apart would confirm the token was once real.
    assert.deepEqual(await redeem(old), { status: 'refused', reason: 'invalid' });
  });

  it('leaves attributions already accepted against the old link alone', async () => {
    /**
     * Revoking withdraws the *invitation*; it does not un-invite the people who
     * accepted it. `token_id` is `on delete set null` rather than a cascade for the
     * same reason, and this asserts the softer case: the row is not even touched.
     */
    const owner = await newUser('revoker3');
    const invitee = await newUser('joined_before_revoke');
    const old = await mintLink(owner);

    await t.actAs(invitee);
    await redeem(old);
    const before = await attribution(invitee);

    await t.actAs(owner);
    await call(`revoke_invite_link(gen_random_uuid())`);

    const after = await attribution(invitee);
    assert.equal(after.inviter_id, before.inviter_id);
    assert.equal(after.token_id, before.token_id);
    assert.ok(after.accepted_at);
  });

  it('keeps exactly one live token however many times it is called', async () => {
    const owner = await newUser('rotator');
    await mintLink(owner);

    await t.actAs(owner);
    for (let i = 0; i < 3; i += 1) await call(`revoke_invite_link(gen_random_uuid())`);

    const { rows } = await t.sql(
      `select count(*)::int as live,
              (select count(*)::int from invite_tokens where owner_id = $1) as total
         from invite_tokens where owner_id = $1 and revoked_at is null`,
      [owner],
    );
    assert.equal(rows[0].live, 1);
    assert.equal(rows[0].total, 4, 'every revoked row is kept, which is what the index permits');
  });

  it('does not rotate twice on a replayed operation id', async () => {
    // A retry after a lost reply must not rotate again: that would detach everybody who
    // was given the link minted in between.
    const owner = await newUser('replayer');
    await mintLink(owner);
    const op = (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

    await t.actAs(owner);
    const first = await call(`revoke_invite_link($1)`, [op]);
    const replay = await call(`revoke_invite_link($1)`, [op]);

    assert.equal(replay.status, 'already_applied');
    assert.equal(replay.token, first.token, 'the replay answers with the link that is live now');
    assert.equal(await liveToken(owner), first.token);
  });

  it('is rate-limited tightly, because rotating detaches people', async () => {
    const owner = await newUser('spinner');
    await mintLink(owner);

    await t.actAs(owner);
    for (let i = 0; i < 5; i += 1) await call(`revoke_invite_link(gen_random_uuid())`);

    const error = await t.errorFrom(`select revoke_invite_link(gen_random_uuid())`);
    assert.equal(error?.code, '53400');
  });

  it('revokes only the caller’s own link', async () => {
    const mine = await newUser('mine');
    const theirs = await newUser('theirs');
    await mintLink(mine);
    const theirToken = await mintLink(theirs);

    await t.actAs(mine);
    await call(`revoke_invite_link(gen_random_uuid())`);

    assert.equal(await liveToken(theirs), theirToken);
  });
});

describe('activation', () => {
  it('lands on the tenth ranked title and not the ninth', async () => {
    const inviter = await newUser('act_inviter');
    const invitee = await newUser('act_invitee');
    const token = await mintLink(inviter);
    await t.actAs(invitee);
    await redeem(token);

    await rankTitles(invitee, 9);
    assert.equal((await attribution(invitee)).activated_at, null, 'nine is not activation');
    assert.equal((await inbox(inviter)).length, 0);

    await rankTitles(invitee, 1, 9);
    assert.ok((await attribution(invitee)).activated_at, 'the tenth activates');
  });

  it('files exactly one notification, and no more as ranking continues', async () => {
    const rows = await inbox(
      (await t.sql(`select id from profiles where username = 'act_inviter'`)).rows[0].id,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subject_type, 'profile');

    const invitee = (await t.sql(`select id from profiles where username = 'act_invitee'`)).rows[0]
      .id;
    assert.equal(rows[0].actor_id, invitee);

    // Eleven, twelve, thirteen. The guard is on the column, so the transition happened
    // once and nothing after it can happen again.
    await rankTitles(invitee, 3, 10);
    assert.equal(
      (
        await inbox(
          (await t.sql(`select id from profiles where username = 'act_inviter'`)).rows[0].id,
        )
      ).length,
      1,
    );
  });

  it('reports the transition to the caller exactly once', async () => {
    // What `RankingSheet` emits `invite_activated` from. True for the ranking that
    // flipped the column and false for every one after it.
    const inviter = await newUser('flag_inviter');
    const invitee = await newUser('flag_invitee');
    // Minted first: `mintLink` acts as the owner, so taking the token inline after
    // `actAs` would run the redemption as the inviter and be answered `self`.
    const token = await mintLink(inviter);
    await t.actAs(invitee);
    await redeem(token);

    await rankTitles(invitee, 9, 2000);

    const tenth = await rankOne(invitee, await t.createMovie('The tenth', 902100));
    assert.equal(tenth.activated, true);

    const eleventh = await rankOne(invitee, await t.createMovie('The eleventh', 902101));
    assert.equal(eleventh.activated, false);
  });

  it('reports false for an account that was never invited', async () => {
    // Most rankings. The read is on the primary key, so this costs one index probe.
    const nobody = await newUser('uninvited');
    await rankTitles(nobody, 9, 3000);

    const tenth = await rankOne(nobody, await t.createMovie('Tenth for nobody', 903100));
    assert.equal(tenth.activated, false);
    assert.equal(await attribution(nobody), null);
  });

  it('activates late for somebody who was already past ten when they redeemed', async () => {
    /**
     * The reason the count is `>=` and not `=`. Redeeming after ranking is ordinary —
     * an existing user is sent a link by a friend — and an `=` would mean their next
     * ranking is the eleventh, and activation never happens at all.
     */
    const inviter = await newUser('late_inviter');
    const invitee = await newUser('late_invitee');
    await rankTitles(invitee, 12, 4000);

    // Minted first: `mintLink` acts as the owner, so taking the token inline after
    // `actAs` would run the redemption as the inviter and be answered `self`.
    const token = await mintLink(inviter);
    await t.actAs(invitee);
    await redeem(token);
    assert.equal((await attribution(invitee)).activated_at, null, 'redemption is not activation');

    await rankTitles(invitee, 1, 4012);
    assert.ok((await attribution(invitee)).activated_at);
    assert.equal((await inbox(inviter)).length, 1);
  });

  it('records the activation and files no notification when the inviter has gone', async () => {
    /**
     * Property 4. `inviter_id` is set null by the foreign key (20260813001500) and the
     * attribution survives on purpose: destroying it when the inviter leaves corrupts
     * the invite metrics rather than protecting anybody. There is simply nobody to tell.
     */
    const inviter = await newUser('leaving_inviter');
    const invitee = await newUser('left_invitee');
    // Minted first: `mintLink` acts as the owner, so taking the token inline after
    // `actAs` would run the redemption as the inviter and be answered `self`.
    const token = await mintLink(inviter);
    await t.actAs(invitee);
    await redeem(token);

    await t.sql(`delete from profiles where id = $1`, [inviter]);

    await rankTitles(invitee, 10, 5000);
    const row = await attribution(invitee);
    assert.ok(row.activated_at, 'the activation is a fact about the invitee');
    assert.equal(row.inviter_id, null);
  });

  it('records the activation and files no notification across a block', async () => {
    // `block` voids only *unaccepted* attributions (20260817000200), deliberately: an
    // accepted one is historical fact about how somebody joined. So the activation still
    // lands, and only the message between the two people does not.
    const inviter = await newUser('blocking_inviter');
    const invitee = await newUser('blocked_invitee');
    // Minted first: `mintLink` acts as the owner, so taking the token inline after
    // `actAs` would run the redemption as the inviter and be answered `self`.
    const token = await mintLink(inviter);
    await t.actAs(invitee);
    await redeem(token);

    await t.actAs(inviter);
    await call(`block(gen_random_uuid(), $1)`, [invitee]);

    await rankTitles(invitee, 10, 6000);
    assert.ok((await attribution(invitee)).activated_at);
    assert.equal((await inbox(inviter)).length, 0);
  });

  it('honours the inviter switching invite notifications off', async () => {
    // Mapped to the `invites` category by 20260819000300, ahead of this writer, so the
    // before-insert trigger drops the row. The activation is unaffected.
    const inviter = await newUser('quiet_inviter');
    const invitee = await newUser('quiet_invitee');
    // Minted first: `mintLink` acts as the owner, so taking the token inline after
    // `actAs` would run the redemption as the inviter and be answered `self`.
    const token = await mintLink(inviter);
    await t.actAs(invitee);
    await redeem(token);

    await t.actAs(inviter);
    await t.sql(`select set_notification_preference('invites', false)`);

    await rankTitles(invitee, 10, 7000);
    assert.ok((await attribution(invitee)).activated_at);
    assert.equal((await inbox(inviter)).length, 0);
  });

  it('is not reachable by a client', async () => {
    // It reads a third party's attribution and writes somebody else's inbox row.
    for (const role of ['authenticated', 'anon']) {
      const { rows } = await t.sql(
        `select has_function_privilege($1, '_maybe_activate_invite(uuid)', 'execute') as ok`,
        [role],
      );
      assert.equal(rows[0].ok, false, `${role} must not execute _maybe_activate_invite`);
    }
  });
});

describe('record_invite_open', () => {
  it('answers nothing at all, whatever the token was', async () => {
    /**
     * Property 5. The page that calls this is anonymous and static, so the only defence
     * against it being used to test tokens is that there is no answer to read. `void` is
     * that defence, and it is asserted here rather than argued in the migration.
     */
    const token = await mintLink(await newUser('opener'));

    // Compared against each other rather than against a literal: what matters is that a
    // live token and a fabricated one are **indistinguishable**, and pinning the exact
    // rendering of `void` would be asserting a driver detail instead of the property.
    const answers = await t.asAnon(async () => {
      const seen = [];
      for (const candidate of [token, '0'.repeat(32), 'not-a-token', null]) {
        const { rows } = await t.sql(`select record_invite_open($1, 'ios') as r`, [candidate]);
        seen.push(rows[0].r);
      }
      return seen;
    });

    assert.equal(new Set(answers.map((a) => JSON.stringify(a))).size, 1, answers.join(' | '));
  });

  it('records an open for a live token and nothing for anything else', async () => {
    const owner = await newUser('opened');
    const token = await mintLink(owner);

    await t.asAnon(async () => {
      await t.sql(`select record_invite_open($1, 'ios')`, [token]);
      await t.sql(`select record_invite_open($1, 'android')`, ['0'.repeat(32)]);
      await t.sql(`select record_invite_open($1, 'other')`, ['../../etc/passwd']);
    });

    const { rows } = await t.sql(
      `select o.platform from invite_link_opens o
         join invite_tokens k on k.id = o.token_id where k.owner_id = $1`,
      [owner],
    );
    assert.deepEqual(rows, [{ platform: 'ios' }]);
  });

  it('counts one link opened by five people as five rows', async () => {
    // The reason it is a table and not a column. A column would be a counter, and a
    // counter is a second copy of a fact that can drift from the first.
    const owner = await newUser('popular');
    const token = await mintLink(owner);

    await t.asAnon(async () => {
      for (let i = 0; i < 5; i += 1) await t.sql(`select record_invite_open($1)`, [token]);
    });

    const { rows } = await t.sql(
      `select count(*)::int as n from invite_link_opens o
         join invite_tokens k on k.id = o.token_id where k.owner_id = $1`,
      [owner],
    );
    assert.equal(rows[0].n, 5);
  });

  it('stops writing past the hourly ceiling, and still says nothing about it', async () => {
    /**
     * The only throttle available against a caller with no identity. Bounded rather than
     * raised: a page that reported "too many opens" would be telling a real invitee that
     * their link is broken, and the caller can do nothing with the answer either way.
     */
    const owner = await newUser('flooded');
    const token = await mintLink(owner);
    await t.sql(`update app_config set value = '3'::jsonb
                  where key = 'invite.max_opens_per_token_per_hour'`);

    const answers = await t.asAnon(async () => {
      const seen = [];
      for (let i = 0; i < 10; i += 1) {
        const { rows } = await t.sql(`select record_invite_open($1) as r`, [token]);
        seen.push(rows[0].r);
      }
      return seen;
    });

    // Before and after the ceiling answer identically, so the cap is not observable
    // either — a caller cannot learn where it is by watching for a change.
    assert.equal(new Set(answers.map((a) => JSON.stringify(a))).size, 1);

    const { rows } = await t.sql(
      `select count(*)::int as n from invite_link_opens o
         join invite_tokens k on k.id = o.token_id where k.owner_id = $1`,
      [owner],
    );
    assert.equal(rows[0].n, 3);

    await t.sql(`update app_config set value = '60'::jsonb
                  where key = 'invite.max_opens_per_token_per_hour'`);
  });

  it('stores no platform value it was not offered', async () => {
    // The check constraint is the guarantee; this asserts the coercion in front of it,
    // so an unexpected string lands as 'other' rather than failing the call.
    const owner = await newUser('platform');
    const token = await mintLink(owner);

    await t.asAnon(() => t.sql(`select record_invite_open($1, $2)`, [token, 'windows-phone']));

    const { rows } = await t.sql(
      `select o.platform from invite_link_opens o
         join invite_tokens k on k.id = o.token_id where k.owner_id = $1`,
      [owner],
    );
    assert.deepEqual(rows, [{ platform: 'other' }]);
  });

  it('is readable by nobody', async () => {
    // No select policy and no grant. An inviter learning that their link was opened four
    // times is a product decision nobody has taken, and an open is not an arrival.
    for (const role of ['authenticated', 'anon']) {
      const { rows } = await t.sql(
        `select has_table_privilege($1, 'invite_link_opens', 'select') as ok`,
        [role],
      );
      assert.equal(rows[0].ok, false, `${role} must not read invite_link_opens`);
    }
  });
});

describe('the Invite Instigator query', () => {
  it('counts activated invitees and nothing else', async () => {
    /**
     * The exact read `use-awards.ts` makes, asserted here because it is the one place a
     * number reaches a person. It counted `invite_link_creations` until 2026-08-18,
     * which made it a badge for pressing a button; it has read `activated_at is not
     * null` since, and has been a true zero for every account until this migration.
     *
     * Three invitees, one activated. Redeemed-but-not-activated must not count, or the
     * award becomes farmable with throwaway accounts — which is the whole reason
     * `20260813001300` put the column there.
     */
    const inviter = await newUser('counted');
    const token = await mintLink(inviter);

    const activated = await newUser('has_activated');
    const redeemed = await newUser('has_redeemed');
    const stranger = await newUser('never_redeemed');

    for (const user of [activated, redeemed]) {
      await t.actAs(user);
      await redeem(token);
    }
    await rankTitles(activated, 10, 8000);
    await rankTitles(redeemed, 4, 8100);
    await rankTitles(stranger, 10, 8200);

    const { rows } = await t.sql(
      `select count(*)::int as n from invite_attributions
        where inviter_id = $1 and activated_at is not null`,
      [inviter],
    );
    assert.equal(rows[0].n, 1);
  });

  it('shows the invitee only their own attribution, and the inviter only theirs', async () => {
    // `invite_attributions_read` has been `inviter_id = auth.uid() or invitee_id =
    // auth.uid()` since 20260813001300, and nothing here changes it — asserted because
    // the award drill-down is a client read straight through that policy.
    const inviter = (await t.sql(`select id from profiles where username = 'counted'`)).rows[0].id;
    const outsider = await newUser('outsider');

    const seen = await t.asUser(outsider, async () => {
      const { rows } = await t.sql(`select invitee_id from invite_attributions where inviter_id = $1`, [
        inviter,
      ]);
      return rows;
    });
    assert.deepEqual(seen, []);
  });
});
