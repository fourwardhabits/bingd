import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Follow activity, and the mutual connection a redeemed invite creates.
 * `20260912000100`, founder tranche 2026-09-08 §§A7-A14.
 *
 * Three things are being asserted here and they fail in three different ways, which is
 * why they are one file:
 *
 *   **Aggregation.** One story per actor per window, appended to rather than repeated,
 *   with `causal_at` held still because the Feed is paged by a keyset over it. The
 *   failure mode is a Feed that one social session floods.
 *
 *   **Suppression.** A follow back inside the window adds no second story, and a follow,
 *   unfollow and re-follow of the same person adds no second mention. The failure mode is
 *   two rows saying the same thing about one relationship.
 *
 *   **Privacy.** `feed_follow_targets` has no policy at all, so the only way to learn who
 *   a story is about is `follow_activity_people`, and that function has to be provably
 *   viewer-relative: a member the caller may not identify must be absent from the answer
 *   rather than merely undrawn by the client. The failure mode here is the one that
 *   matters, because it is silent and it is somebody else's account.
 */

let t;
let seq = 90000;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

beforeEach(() => {
  seq += 1;
});

const user = (name, visibility = 'public') =>
  t.createUser({ username: `fa_${name}_${(seq += 1)}`, visibility });

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;

/** `follow` as the caller. Returns the RPC's own answer. */
const follow = async (viewer, target) => {
  await t.actAs(viewer);
  const { rows } = await t.sql(`select follow($1, $2) as answer`, [await uuid(), target]);
  return rows[0].answer;
};

const unfollow = async (viewer, target) => {
  await t.actAs(viewer);
  await t.sql(`select unfollow($1, $2)`, [await uuid(), target]);
};

/** The follow stories one actor has, newest first, with their membership counted raw. */
const stories = async (actor) => {
  const { rows } = await t.sql(
    `select e.id, e.causal_at, e.causal_step, e.payload,
            (select count(*) from feed_follow_targets ft where ft.event_id = e.id)::int as members
       from feed_events e
      where e.actor_id = $1 and e.type = 'follow_added'
      order by e.causal_at desc`,
    [actor],
  );
  return rows;
};

/** `follow_activity_people` as one viewer, grouped by event. */
const named = async (viewer, eventIds) => {
  await t.actAs(viewer);
  const { rows } = await t.sql(
    `select event_id, username, visibility, ordinal
       from follow_activity_people($1::uuid[])
      order by event_id, ordinal`,
    [eventIds],
  );
  return rows;
};

/** A live personal invite link for somebody, and its token. */
const mintLink = async (owner) => {
  await t.actAs(owner);
  const { rows } = await t.sql(`select create_invite_link($1, null) as answer`, [await uuid()]);
  return rows[0].answer.token;
};

const redeem = async (invitee, token) => {
  await t.actAs(invitee);
  const { rows } = await t.sql(`select redeem_invite($1, $2) as answer`, [await uuid(), token]);
  return rows[0].answer;
};

const edge = async (follower, followee) => {
  const { rows } = await t.sql(
    `select state from follows where follower_id = $1 and followee_id = $2`,
    [follower, followee],
  );
  return rows[0]?.state ?? null;
};

// ---------------------------------------------------------------------------

describe('a follow becomes activity', () => {
  it('writes one story naming the person followed', async () => {
    const abi = await user('abi');
    const ravi = await user('ravi');

    assert.equal((await follow(abi, ravi)).state, 'approved');

    const rows = await stories(abi);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].members, 1);
    // The payload carries nothing. A count on the row would be a count of people some
    // readers are not allowed to open, which is why the reader derives its own.
    assert.deepEqual(rows[0].payload, {});
    assert.equal(rows[0].causal_step, 0);

    const raviName = (await t.sql(`select username from profiles where id = $1`, [ravi])).rows[0]
      .username;
    assert.deepEqual(
      (await named(abi, [rows[0].id])).map((r) => r.username),
      [raviName],
      'the actor reads their own story: they are the one who did the following',
    );
  });

  it('excludes the reader from a story that is about them', async () => {
    const abi = await user('you_abi');
    const you = await user('you_reader');
    await follow(abi, you);
    const story = (await stories(abi))[0];

    /**
     * `can_identify_profile` admits the caller by design -- you belong on your own
     * friend's follower list -- and that is the wrong answer here. This list is a list of
     * people to discover and follow, and a row for yourself in it is a control that cannot
     * exist. Somebody who was followed already has the `follow` notification that says so.
     */
    assert.deepEqual(await named(you, [story.id]), []);
  });

  it('aggregates a session of follows into one story, oldest member first', async () => {
    const abi = await user('bulk_abi');
    const targets = [];
    for (let i = 0; i < 5; i += 1) targets.push(await user(`bulk_t${i}`));

    for (const target of targets) await follow(abi, target);

    const rows = await stories(abi);
    assert.equal(rows.length, 1, 'five follows must not be five rows in the Feed');
    assert.equal(rows[0].members, 5);

    // A viewer who follows Abi and can see everybody.
    const viewer = await user('bulk_viewer');
    const seen = await named(viewer, [rows[0].id]);
    assert.equal(seen.length, 5);
    assert.deepEqual(
      seen.map((r) => r.ordinal),
      [1, 2, 3, 4, 5],
      'ordered by when each follow joined the story, so the named one is stable',
    );
  });

  it('holds causal_at still while the story grows', async () => {
    const abi = await user('still_abi');
    const first = await user('still_first');
    const second = await user('still_second');

    await follow(abi, first);
    const before = (await stories(abi))[0];
    await follow(abi, second);
    const after = (await stories(abi))[0];

    assert.equal(after.id, before.id);
    assert.equal(after.members, 2);
    /**
     * The Feed is a keyset over `(causal_at, causal_step, id)`. A row that moved its sort
     * position while somebody was paging past it is the duplicate-and-skip `useFeed` gave
     * up `OFFSET` to avoid, so an append must not bump the timestamp.
     */
    assert.equal(
      after.causal_at.getTime(),
      before.causal_at.getTime(),
      'appending must not move the row in the keyset',
    );
  });

  it('opens a new story once the window has passed', async () => {
    const abi = await user('window_abi');
    const first = await user('window_first');
    const second = await user('window_second');

    await follow(abi, first);
    // Age the open story past `feed.follow_aggregation_minutes` (60).
    await t.sql(
      `update feed_events set causal_at = causal_at - interval '90 minutes'
        where actor_id = $1 and type = 'follow_added'`,
      [abi],
    );
    await follow(abi, second);

    const rows = await stories(abi);
    assert.equal(rows.length, 2, 'a day of follows is not one unbounded story');
    assert.deepEqual(
      rows.map((r) => r.members),
      [1, 1],
    );
  });

  it('still writes a story when the window is not configured', async () => {
    // The documented fallback is 60. `coalesce` over a query returning no rows is never
    // evaluated, which is the defect `config-defaults.test.mjs` exists for.
    await t.sql(`delete from app_config where key = 'feed.follow_aggregation_minutes'`);
    try {
      const abi = await user('nocfg_abi');
      const ravi = await user('nocfg_ravi');
      await follow(abi, ravi);
      assert.equal((await stories(abi)).length, 1);
    } finally {
      await t.sql(
        `insert into app_config (key, value) values ('feed.follow_aggregation_minutes', '60'::jsonb)
           on conflict (key) do nothing`,
      );
    }
  });
});

describe('what does not become activity', () => {
  it('says nothing about a follow request', async () => {
    const abi = await user('req_abi');
    const priv = await user('req_private', 'private');

    assert.equal((await follow(abi, priv)).state, 'pending');
    assert.equal(await edge(abi, priv), 'pending');
    assert.deepEqual(
      await stories(abi),
      [],
      'announcing a pending request would publish a relationship its target has not agreed to',
    );
  });

  it('says nothing about an approval, and creates the edge anyway', async () => {
    const abi = await user('appr_abi');
    const priv = await user('appr_private', 'private');

    await follow(abi, priv);
    await t.actAs(priv);
    await t.sql(`select respond_follow_request($1, $2, true)`, [await uuid(), abi]);

    assert.equal(await edge(abi, priv), 'approved');
    assert.deepEqual(
      await stories(abi),
      [],
      'an approval is the private account`s own act, days later, and is already notified',
    );
  });

  it('says nothing twice about a re-follow of the same person', async () => {
    const abi = await user('re_abi');
    const ravi = await user('re_ravi');

    await follow(abi, ravi);
    await unfollow(abi, ravi);
    await follow(abi, ravi);

    const rows = await stories(abi);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].members, 1, 'the primary key is what keeps one person one mention');
  });

  it('says nothing when a tap changed nothing', async () => {
    const abi = await user('noop_abi');
    const ravi = await user('noop_ravi');

    await follow(abi, ravi);
    await t.sql(
      `update feed_events set causal_at = causal_at - interval '90 minutes'
        where actor_id = $1 and type = 'follow_added'`,
      [abi],
    );
    // Already following. The RPC answers ok and must not reopen a story.
    assert.equal((await follow(abi, ravi)).state, 'approved');
    assert.equal((await stories(abi)).length, 1);
  });
});

describe('reciprocal suppression', () => {
  it('adds no second story for a follow back inside the window', async () => {
    const abi = await user('recip_abi');
    const ravi = await user('recip_ravi');

    await follow(abi, ravi);
    await follow(ravi, abi);

    assert.equal((await stories(abi)).length, 1);
    assert.deepEqual(
      await stories(ravi),
      [],
      'the relationship was already announced; a second story would restate it',
    );
    // Presentation only. Both edges exist.
    assert.equal(await edge(abi, ravi), 'approved');
    assert.equal(await edge(ravi, abi), 'approved');
  });

  it('does announce a follow back once the window has passed', async () => {
    const abi = await user('late_abi');
    const ravi = await user('late_ravi');

    await follow(abi, ravi);
    await t.sql(
      `update feed_events set causal_at = causal_at - interval '90 minutes'
        where actor_id = $1 and type = 'follow_added'`,
      [abi],
    );
    await follow(ravi, abi);

    assert.equal((await stories(ravi)).length, 1, 'suppression is window-bounded, not for ever');
  });

  it('suppresses only the reciprocal pair, not the whole story', async () => {
    const abi = await user('part_abi');
    const ravi = await user('part_ravi');
    const other = await user('part_other');

    await follow(abi, ravi);
    // Ravi follows Abi back — suppressed — and then somebody else, which is not.
    await follow(ravi, abi);
    await follow(ravi, other);

    const rows = await stories(ravi);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].members, 1);
    const viewer = await user('part_viewer');
    assert.deepEqual(
      (await named(viewer, [rows[0].id])).map((r) => r.username),
      [(await t.sql(`select username from profiles where id = $1`, [other])).rows[0].username],
      'the follow back is suppressed; the unrelated follow in the same session is not',
    );
  });
});

describe('who a story may name', () => {
  it('is unreadable except through follow_activity_people', async () => {
    const abi = await user('deny_abi');
    const ravi = await user('deny_ravi');
    await follow(abi, ravi);

    // Two locks, and both are asserted. The grant is revoked, which is what
    // `notifications` settled on in 20260819000300 because Supabase's default privileges
    // hand `select` to both client roles on every new table; row security with no policy
    // is the second.
    for (const role of ['authenticated', 'anon']) {
      const { rows } = await t.sql(
        `select has_table_privilege($1, 'feed_follow_targets', 'select') as ok`,
        [role],
      );
      assert.equal(rows[0].ok, false, `${role} must not hold select on feed_follow_targets`);
    }

    const { rows } = await t.sql(
      `select relrowsecurity as on,
              (select count(*) from pg_policies
                where tablename = 'feed_follow_targets')::int as policies
         from pg_class where relname = 'feed_follow_targets'`,
    );
    assert.equal(rows[0].on, true);
    assert.equal(rows[0].policies, 0, 'the read path is follow_activity_people, not a policy');

    // And the function does answer, so the lock is not hiding a broken feature. A third
    // account, because Ravi is the member and is excluded from a story about themselves.
    const viewer = await user('deny_viewer');
    assert.equal((await named(viewer, [(await stories(abi))[0].id])).length, 1);
  });

  it('names a private account the viewer may discover, as identity only', async () => {
    const abi = await user('pv_abi');
    const priv = await user('pv_private', 'private');
    const viewer = await user('pv_viewer');

    // Abi follows a private account. The edge is a request, so nothing is posted — so the
    // story is built the other way round: the private account is the *subject* of a story
    // authored by Abi about a public follow plus a private one is impossible by that rule.
    // What is possible, and is the real case, is a private account being followed *after*
    // it approved: approval posts nothing, so the story that names a private account comes
    // from a redeemed invite. Assert that shape directly.
    const token = await mintLink(abi);
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [priv]);
    const answer = await redeem(priv, token);
    assert.equal(answer.status, 'ok');

    const rows = await stories(abi);
    assert.equal(rows.length, 1, 'the invite posts one story, authored by the inviter');

    const seen = await named(viewer, [rows[0].id]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].visibility, 'private');
    // Identity only: the row carries the private marker so the client offers Request and
    // the tap lands on the locked shell (20260828000400 §21B).
    assert.ok(seen[0].username);
  });

  it('hides a member the viewer has blocked, and one who has blocked them', async () => {
    const abi = await user('blk_abi');
    const blocked = await user('blk_blocked');
    const blocker = await user('blk_blocker');
    const viewer = await user('blk_viewer');

    await follow(abi, blocked);
    await follow(abi, blocker);
    const story = (await stories(abi))[0];

    await t.actAs(viewer);
    await t.sql(`select block($1, $2)`, [await uuid(), blocked]);
    await t.actAs(blocker);
    await t.sql(`select block($1, $2)`, [await uuid(), viewer]);

    const seen = await named(viewer, [story.id]);
    assert.equal(seen.length, 0, 'a block in either direction removes the member');
  });

  it('hides a suspended member', async () => {
    const abi = await user('susp_abi');
    const gone = await user('susp_gone');
    const kept = await user('susp_kept');
    const viewer = await user('susp_viewer');

    await follow(abi, gone);
    await follow(abi, kept);
    const story = (await stories(abi))[0];

    await t.sql(`update profiles set status = 'suspended' where id = $1`, [gone]);

    const seen = await named(viewer, [story.id]);
    assert.deepEqual(
      seen.map((r) => r.username),
      [(await t.sql(`select username from profiles where id = $1`, [kept])).rows[0].username],
    );
  });

  it('answers nothing for a story whose actor the viewer may not read', async () => {
    const priv = await user('act_private');
    const ravi = await user('act_ravi');
    const stranger = await user('act_stranger');

    // A private actor's own follow is approved (Ravi is public), so the story exists.
    await follow(priv, ravi);
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [priv]);
    const story = (await stories(priv))[0];

    assert.equal(
      (await named(stranger, [story.id])).length,
      0,
      'security definer bypasses feed_events_read, so the actor gate is restated in the body',
    );
    // And it does answer for somebody the private account has approved.
    await t.actAs(stranger);
    await t.sql(`select follow($1, $2)`, [await uuid(), priv]);
    await t.actAs(priv);
    await t.sql(`select respond_follow_request($1, $2, true)`, [await uuid(), stranger]);
    assert.equal((await named(stranger, [story.id])).length, 1);
  });

  it('answers nothing at all to a signed-out caller', async () => {
    const abi = await user('anon_abi');
    const ravi = await user('anon_ravi');
    await follow(abi, ravi);
    const story = (await stories(abi))[0];

    await t.actAs(null);
    const { rows } = await t.sql(`select * from follow_activity_people($1::uuid[])`, [[story.id]]);
    assert.equal(rows.length, 0, '`auth.uid() is not null` is a floor, not left to the grant');
  });

  it('ignores an id that is not a follow story', async () => {
    const abi = await user('type_abi');
    const ravi = await user('type_ravi');
    await follow(abi, ravi);
    const { rows } = await t.sql(
      `insert into feed_events (actor_id, type) values ($1, 'title_logged') returning id`,
      [abi],
    );
    assert.equal((await named(ravi, [rows[0].id])).length, 0);
  });
});

describe('a redeemed invite is one relationship', () => {
  it('connects both parties and posts one story, authored by the inviter', async () => {
    const suraj = await user('inv_suraj');
    const abi = await user('inv_abi');
    const token = await mintLink(suraj);

    const answer = await redeem(abi, token);
    assert.equal(answer.status, 'ok');
    assert.equal(answer.connected, true);

    assert.equal(await edge(abi, suraj), 'approved');
    assert.equal(await edge(suraj, abi), 'approved');

    // One story. Two edges are one relationship (§A14), and the actor is the inviter
    // because that is the direction with an audience.
    assert.deepEqual(await stories(abi), []);
    const rows = await stories(suraj);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].members, 1);

    const viewer = await user('inv_viewer');
    assert.deepEqual(
      (await named(viewer, [rows[0].id])).map((r) => r.username),
      [(await t.sql(`select username from profiles where id = $1`, [abi])).rows[0].username],
      'the new account is what the inviter`s network is shown',
    );
  });

  it('is idempotent across a retry with the same operation id', async () => {
    const suraj = await user('idem_suraj');
    const abi = await user('idem_abi');
    const token = await mintLink(suraj);
    const operation = await uuid();

    await t.actAs(abi);
    const first = (await t.sql(`select redeem_invite($1, $2) as answer`, [operation, token]))
      .rows[0].answer;
    const second = (await t.sql(`select redeem_invite($1, $2) as answer`, [operation, token]))
      .rows[0].answer;

    assert.equal(first.status, 'ok');
    assert.equal(second.status, 'already_applied');
    assert.equal((await stories(suraj)).length, 1);
    assert.equal((await stories(suraj))[0].members, 1);
  });

  it('is idempotent across a retry with a fresh operation id', async () => {
    const suraj = await user('idem2_suraj');
    const abi = await user('idem2_abi');
    const token = await mintLink(suraj);

    assert.equal((await redeem(abi, token)).status, 'ok');
    const again = await redeem(abi, token);
    assert.equal(again.status, 'refused');
    assert.equal(again.reason, 'already_attributed');
    assert.equal((await stories(suraj)).length, 1);
  });

  it('leaves an existing edge alone rather than downgrading it', async () => {
    const suraj = await user('exist_suraj');
    const abi = await user('exist_abi');
    // The inviter already follows the invitee, which is ordinary: they know each other.
    await follow(suraj, abi);
    const token = await mintLink(suraj);

    assert.equal((await redeem(abi, token)).connected, true);
    assert.equal(await edge(suraj, abi), 'approved');
    // The story the earlier follow opened is still the only one, with one member.
    const rows = await stories(suraj);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].members, 1);
  });

  it('creates no follow and no story for an invalid or revoked token', async () => {
    const suraj = await user('bad_suraj');
    const abi = await user('bad_abi');
    const token = await mintLink(suraj);
    await t.sql(`update invite_tokens set revoked_at = now() where token = $1`, [token]);

    assert.equal((await redeem(abi, token)).reason, 'invalid');
    assert.equal(await edge(suraj, abi), null);
    assert.equal(await edge(abi, suraj), null);
    assert.deepEqual(await stories(suraj), []);

    assert.equal((await redeem(abi, 'not-a-token')).reason, 'invalid');
    assert.deepEqual(await stories(suraj), []);
  });

  it('creates nothing for the owner opening their own link', async () => {
    const suraj = await user('self_suraj');
    const token = await mintLink(suraj);
    assert.equal((await redeem(suraj, token)).reason, 'self');
    assert.deepEqual(await stories(suraj), []);
  });

  it('creates nothing across a block, in either direction', async () => {
    const suraj = await user('blkinv_suraj');
    const abi = await user('blkinv_abi');
    const token = await mintLink(suraj);

    await t.actAs(suraj);
    await t.sql(`select block($1, $2)`, [await uuid(), abi]);

    assert.equal((await redeem(abi, token)).reason, 'blocked');
    assert.equal(await edge(suraj, abi), null);
    assert.equal(await edge(abi, suraj), null);
    assert.deepEqual(await stories(suraj), []);
  });

  it('creates nothing for a suspended inviter', async () => {
    const suraj = await user('susinv_suraj');
    const abi = await user('susinv_abi');
    const token = await mintLink(suraj);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [suraj]);

    assert.equal((await redeem(abi, token)).reason, 'unavailable');
    assert.equal(await edge(suraj, abi), null);
    assert.deepEqual(await stories(suraj), []);
  });

  it('connects nobody for a non-personal token, and still attributes', async () => {
    /**
     * §A7's forward-compatibility clause, asserted rather than promised. `referral` has no
     * writer, so this test mints a personal token and relabels it -- which is exactly the
     * state a future campaign token would be in, and the only way to prove the gate is a
     * property of the token rather than a rule nobody can change.
     */
    const suraj = await user('ref_suraj');
    const abi = await user('ref_abi');
    const token = await mintLink(suraj);
    await t.sql(`update invite_tokens set kind = 'referral' where token = $1`, [token]);

    const answer = await redeem(abi, token);
    assert.equal(answer.status, 'ok');
    assert.equal(answer.connected, false);

    // The invitee's own follow is an act they performed and is unaffected.
    assert.equal(await edge(abi, suraj), 'approved');
    // The reverse edge is what a referral must not create.
    assert.equal(await edge(suraj, abi), null);
    assert.deepEqual(await stories(suraj), []);
  });

  it('refuses an unknown token kind at the constraint', async () => {
    const suraj = await user('kind_suraj');
    const token = await mintLink(suraj);
    const err = await t.errorFrom(`update invite_tokens set kind = 'whatever' where token = $1`, [
      token,
    ]);
    assert.ok(err, 'the taxonomy is a check constraint, not a convention');
  });
});

describe('Match is public-only', () => {
  /**
   * §A5. The rule held emergently before `20260912000100` -- `can_view_profile` excludes a
   * private account the caller has not been approved by, and one that *has* approved them
   * is excluded for being already followed -- and it is now stated in the function. This is
   * the test that makes the statement load-bearing: it builds the one case the old
   * intersection did not cover on its own, an approved private account the caller does
   * *not* follow, which `respond_follow_request` makes reachable in one direction.
   */
  const rank = async (viewer, mediaItemId) => {
    await t.actAs(viewer);
    await t.rankToCompletion(mediaItemId, 'loved', (pivot) => pivot);
  };

  it('never recommends a private account, however well its taste correlates', async () => {
    await t.sql(`update app_config set value = '2'::jsonb where key = 'taste.min_common'`);

    const alice = await user('m_alice');
    const priv = await user('m_private', 'private');
    const pub = await user('m_public');

    const films = [];
    for (let i = 0; i < 4; i += 1) films.push(await t.createMovie(`M${seq}_${i}`, (seq += 1)));

    for (const film of films) {
      await rank(alice, film);
      await rank(priv, film);
      await rank(pub, film);
    }

    // The private account has approved Alice as a *follower of them*? No: the reachable
    // shape is the other way. Alice is approved to read the private account only by
    // following it, and following it excludes it from suggestions. So the case that has to
    // be built is the private account following Alice, which grants Alice nothing and
    // leaves `can_view_profile(alice, priv)` false. Either way the answer is the same, and
    // the explicit predicate is what makes it stay the same.
    await t.actAs(priv);
    await t.sql(`select follow($1, $2)`, [await uuid(), alice]);

    await t.actAs(alice);
    const { rows } = await t.sql(
      `select p.username, p.visibility
         from people_taste_matches(10) m join profiles p on p.id = m.user_id`,
    );
    const names = rows.map((r) => r.username);
    const privName = (await t.sql(`select username from profiles where id = $1`, [priv])).rows[0]
      .username;
    const pubName = (await t.sql(`select username from profiles where id = $1`, [pub])).rows[0]
      .username;

    assert.ok(names.includes(pubName), 'a public account with shared taste is a match');
    assert.ok(!names.includes(privName), 'a private account is never algorithmically suggested');
    assert.deepEqual(
      rows.filter((r) => r.visibility !== 'public'),
      [],
      'every row Match returns is a public account',
    );
  });

  it('still surfaces an eligible private account through Mutuals', async () => {
    // The other half of the pair of decisions, asserted here so the two cannot be read as
    // one rule: relationship-driven discovery may name a private account (§A4,
    // 20260828000400) where algorithmic discovery may not (§A5).
    const alice = await user('mu_alice');
    const via = await user('mu_via');
    const priv = await user('mu_private', 'private');

    await follow(alice, via);
    await t.sql(
      `insert into follows (follower_id, followee_id, state, approved_at)
       values ($1, $2, 'approved', now())`,
      [via, priv],
    );

    await t.actAs(alice);
    const { rows } = await t.sql(`select username, visibility from people_mutuals(10)`);
    assert.deepEqual(
      rows.map((r) => r.visibility),
      ['private'],
    );
  });
});
