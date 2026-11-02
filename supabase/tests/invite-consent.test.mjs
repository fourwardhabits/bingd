import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Opening an invitation grants nothing. Security audit 2026-11-01, B-1.
 *
 * The attack, verbatim: an attacker sends their personal link to a private account. The
 * app stored the token on open and redeemed it behind the person when they left, with
 * `redeem_invite`, and the attacker became an approved follower.
 *
 * `redeem_invite` is what every installed build still sends, for a tap and for that
 * background call alike. So everything below about it is a statement about **phones that
 * have not updated**, and it has to hold for them on the day the migration lands.
 */

let t;
let seq = 0;

const op = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const name = (prefix) => `${prefix}_${(seq += 1)}`;

/** An account old enough that nobody could mistake it for one signing up through a link. */
const established = async (prefix, visibility = 'public') => {
  const id = await t.createUser({ username: name(prefix), visibility });
  await t.sql(`update profiles set created_at = now() - interval '30 days' where id = $1`, [id]);
  return id;
};
const fresh = (prefix, visibility = 'public') =>
  t.createUser({ username: name(prefix), visibility });

const linkOf = (owner) =>
  t.asUser(owner, async () => {
    const { rows } = await t.sql(`select create_invite_link($1) as r`, [await op()]);
    return rows[0].r.token;
  });

/** What an installed build sends when the person opens a link and leaves. */
const silently = (who, token) =>
  t.asUser(who, async () => {
    const { rows } = await t.sql(`select redeem_invite($1, $2) as r`, [await op(), token]);
    return rows[0].r;
  });

const accept = (who, token, id = null) =>
  t.asUser(who, async () => {
    const { rows } = await t.sql(`select accept_invite($1, $2) as r`, [id ?? (await op()), token]);
    return rows[0].r;
  });

const preview = (who, token) =>
  t.asUser(who, async () => {
    const { rows } = await t.sql(`select invite_preview($1) as r`, [token]);
    return rows[0].r;
  });

/** Everything an attacker would read off the victim, as the attacker. */
const reach = (attacker, victim) =>
  t.asUser(attacker, async () => {
    const one = async (sql) => (await t.sql(sql, [victim])).rows[0].n;
    return {
      canView: (await t.sql(`select can_i_view($1) as v`, [victim])).rows[0].v,
      profile: await one(`select count(*)::int as n from profiles where id = $1`),
      rankings: await one(`select count(*)::int as n from rankings where user_id = $1`),
      watchlist: await one(`select count(*)::int as n from watchlist where user_id = $1`),
      collection: await one(`select count(*)::int as n from logged_collection where user_id = $1`),
      activity: await one(`select count(*)::int as n from feed_events where actor_id = $1`),
    };
  });

const CLOSED = { canView: false, profile: 0, rankings: 0, watchlist: 0, collection: 0, activity: 0 };

const edges = async (a, b) => {
  const { rows } = await t.sql(
    `select follower_id, state from follows
      where (follower_id = $1 and followee_id = $2) or (follower_id = $2 and followee_id = $1)`,
    [a, b],
  );
  return rows;
};

const traces = async (invitee, inviter) => ({
  attribution: (await t.sql(`select 1 from invite_attributions where invitee_id = $1`, [invitee])).rows.length,
  invitedBy: (await t.sql(`select invited_by from profiles where id = $1`, [invitee])).rows[0].invited_by,
  notices: (
    await t.sql(
      `select count(*)::int as n from notifications
        where (recipient_id = $1 and actor_id = $2) or (recipient_id = $2 and actor_id = $1)`,
      [invitee, inviter],
    )
  ).rows[0].n,
  stories: (
    await t.sql(`select count(*)::int as n from feed_events where actor_id = $1 and type = 'follow_added'`, [inviter])
  ).rows[0].n,
});

const seedPrivateActivity = async (victim) => {
  const film = await t.createMovie(`Secret Film ${seq}`, 7_000_000 + (seq += 1));
  const listed = await t.createMovie(`Listed Film ${seq}`, 7_000_000 + (seq += 1));
  await t.asUser(victim, async () => {
    await t.rankToCompletion(film, 'loved', async () => film);
    await t.sql(`select set_watchlist($1, $2, true)`, [await op(), listed]);
  });
};

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t.close();
});

describe('B-1: an established private account opens a link and leaves', () => {
  it('gives the attacker nothing, and leaves no trace on either account', async () => {
    const attacker = await established('attacker');
    const victim = await established('victim', 'private');
    await seedPrivateActivity(victim);
    const token = await linkOf(attacker);

    const before = await reach(attacker, victim);
    assert.deepEqual(before, CLOSED, 'the fixture must start closed');

    const answer = await silently(victim, token);

    assert.deepEqual(answer, { status: 'refused', reason: 'consent_required' });
    assert.deepEqual(await reach(attacker, victim), CLOSED);
    assert.deepEqual(await edges(attacker, victim), []);
    assert.deepEqual(await traces(victim, attacker), {
      attribution: 0,
      invitedBy: null,
      notices: 0,
      stories: 0,
    });
  });

  it('leaves the account free to accept an invitation it actually wants', async () => {
    // The old redemption burned the one attribution an account ever has on the attacker.
    const attacker = await established('attacker');
    const friend = await established('friend');
    const victim = await established('victim', 'private');

    await silently(victim, await linkOf(attacker));
    const answer = await accept(victim, await linkOf(friend));

    assert.equal(answer.status, 'ok');
    assert.equal(answer.connected, true);
  });

  it('does not approve a request the attacker already had open', async () => {
    // The old body upgraded a pending edge in either direction, so this path needed no
    // token-created edge at all.
    const attacker = await established('attacker');
    const victim = await established('victim', 'private');
    await t.asUser(attacker, async () => {
      await t.sql(`select follow($1, $2)`, [await op(), victim]);
    });

    await silently(victim, await linkOf(attacker));

    assert.deepEqual(await edges(attacker, victim), [{ follower_id: attacker, state: 'pending' }]);
    assert.equal((await reach(attacker, victim)).canView, false);
    const { rows } = await t.sql(
      `select count(*)::int as n from notifications where recipient_id = $1 and type = 'follow_request'`,
      [victim],
    );
    assert.equal(rows[0].n, 1, 'their request is still there to be answered');
  });

  it('does not force a public account into a mutual follow or a wrong attribution either', async () => {
    const attacker = await established('attacker');
    const victim = await established('victim');

    assert.equal((await silently(victim, await linkOf(attacker))).reason, 'consent_required');

    assert.deepEqual(await edges(attacker, victim), []);
    assert.equal((await traces(victim, attacker)).attribution, 0);
  });
});

describe('B-1: an account too new to be anything but a signup through the link', () => {
  it('is attributed, and still grants nobody anything', async () => {
    const inviter = await established('inviter');
    const newcomer = await fresh('newcomer', 'private');
    await seedPrivateActivity(newcomer);

    const answer = await silently(newcomer, await linkOf(inviter));

    assert.equal(answer.status, 'ok');
    assert.equal(answer.connected, false);
    assert.equal(answer.follow_state, null, 'an installed build then says nothing about following');
    assert.deepEqual(await reach(inviter, newcomer), CLOSED);
    assert.deepEqual(await edges(inviter, newcomer), []);

    const left = await traces(newcomer, inviter);
    assert.equal(left.attribution, 1);
    assert.equal(left.invitedBy, inviter);
    assert.equal(left.stories, 0, 'a story would announce a relationship that does not exist');
    assert.equal(left.notices, 2, 'one welcome, one invite_joined');
  });

  it('still refuses what it always refused', async () => {
    const inviter = await established('inviter');
    const newcomer = await fresh('newcomer');
    const token = await linkOf(inviter);

    assert.equal((await silently(inviter, token)).reason, 'self');
    assert.equal((await silently(newcomer, '0'.repeat(32))).reason, 'invalid');

    await t.asUser(newcomer, async () => {
      await t.sql(`select block($1, $2)`, [await op(), inviter]);
    });
    assert.equal((await silently(newcomer, token)).reason, 'blocked');
  });
});

describe('B-1: pressing Accept', () => {
  it('connects a private account, because this time it decided to', async () => {
    const inviter = await established('inviter');
    const invitee = await established('invitee', 'private');
    await seedPrivateActivity(invitee);

    const answer = await accept(invitee, await linkOf(inviter));

    assert.equal(answer.status, 'ok');
    assert.equal(answer.follow_state, 'approved');
    assert.equal(answer.connected, true);
    assert.equal((await reach(inviter, invitee)).canView, true);
    assert.equal((await reach(inviter, invitee)).rankings, 1);
  });

  it('is not undone or repeated by the same press replayed', async () => {
    const inviter = await established('inviter');
    const invitee = await established('invitee', 'private');
    const token = await linkOf(inviter);
    const id = await op();

    assert.equal((await accept(invitee, token, id)).status, 'ok');
    assert.deepEqual(await accept(invitee, token, id), { status: 'already_applied', attributed: true });
    assert.equal((await edges(inviter, invitee)).length, 2);
  });

  it('cannot reach the internal entry from a client', async () => {
    // `p_accepted` is the consent, so whoever could call this could assert it for themselves
    // and nobody else, but the grant would still be a second door to review.
    const someone = await established('someone');
    for (const run of [(q) => t.asUser(someone, q), (q) => t.asAnon(q)]) {
      const error = await run(() =>
        t.errorFrom(`select _redeem_invite(gen_random_uuid(), $1, 'accept_invite', true)`, ['0'.repeat(32)]),
      );
      assert.equal(error?.code, '42501');
    }
  });

  it('is refused to an anonymous caller', async () => {
    const error = await t.asAnon(() =>
      t.errorFrom(`select accept_invite(gen_random_uuid(), $1)`, ['0'.repeat(32)]),
    );
    assert.equal(error?.code, '42501');
  });

  it('keeps a spent legacy id from answering an acceptance, and the other way round', async () => {
    const inviter = await established('inviter');
    const invitee = await established('invitee');
    const token = await linkOf(inviter);
    const id = await op();

    assert.equal((await silently(invitee, token)).reason, 'consent_required');
    assert.equal((await accept(invitee, token, id)).status, 'ok');
  });
});

describe('invite_preview', () => {
  it('names the person before anything is granted, and writes nothing', async () => {
    const inviter = await established('inviter');
    await t.sql(`update profiles set display_name = 'Ada Lovelace' where id = $1`, [inviter]);
    const invitee = await established('invitee', 'private');

    const answer = await preview(invitee, await linkOf(inviter));

    assert.equal(answer.status, 'ok');
    assert.equal(answer.kind, 'personal');
    assert.equal(answer.inviter_display_name, 'Ada Lovelace');
    assert.match(answer.inviter_username, /^inviter_/);
    assert.deepEqual(await edges(inviter, invitee), []);
    assert.equal((await traces(invitee, inviter)).attribution, 0);
  });

  it('gives one answer for a block and for an account that has gone', async () => {
    // A separate answer for a block is a way to detect one.
    const blocker = await established('blocker');
    const suspended = await established('suspended');
    const reader = await established('reader');
    const blockedLink = await linkOf(blocker);
    const suspendedLink = await linkOf(suspended);

    await t.asUser(blocker, async () => {
      await t.sql(`select block($1, $2)`, [await op(), reader]);
    });
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [suspended]);

    const expected = { status: 'refused', reason: 'unavailable' };
    assert.deepEqual(await preview(reader, blockedLink), expected);
    assert.deepEqual(await preview(reader, suspendedLink), expected);
  });

  it('answers the other refusals accepting would give, without a name', async () => {
    const inviter = await established('inviter');
    const other = await established('other');
    const reader = await established('reader');
    const token = await linkOf(inviter);

    assert.deepEqual(await preview(inviter, token), { status: 'refused', reason: 'self' });
    assert.deepEqual(await preview(reader, 'f'.repeat(32)), { status: 'refused', reason: 'invalid' });

    await accept(reader, await linkOf(other));
    assert.deepEqual(await preview(reader, token), { status: 'refused', reason: 'already_attributed' });
  });

  it('says nothing to a caller with no account', async () => {
    const error = await t.asAnon(() => t.errorFrom(`select invite_preview($1)`, ['0'.repeat(32)]));
    assert.equal(error?.code, '42501');
  });
});
