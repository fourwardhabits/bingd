import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The Settings writers — 20260817000600.
 *
 * Four things that had complete machinery in the database and no entry point:
 * renaming, privacy, the inbox, and deletion. So most of what is asserted here is
 * that the *existing* semantics fire — the rename triggers, the visibility column
 * `can_view_profile` has always read, the `read_at` column declared in
 * `20260813000900`, and the cascade every foreign key was given a deliberate rule for.
 *
 * The one genuinely new decision is what deletion keeps, and it is the last section.
 */

let t;
const nextOp = async () => {
  const { rows } = await t.sql(`select gen_random_uuid() as id`);
  return rows[0].id;
};

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

// ---------------------------------------------------------------------------
// Display name
// ---------------------------------------------------------------------------

describe('editing a display name', () => {
  let alice;

  before(async () => {
    alice = await t.createUser({ username: 'alice_edit' });
  });

  beforeEach(async () => {
    await t.actAs(alice);
  });

  it('sets it', async () => {
    await t.asUser(alice, async () => {
      await t.sql(`select update_profile($1, 'Alice Anderson')`, [await nextOp()]);
    });
    await t.actAs(null);

    const { rows } = await t.sql(`select display_name from profiles where id = $1`, [alice]);
    assert.equal(rows[0].display_name, 'Alice Anderson');
  });

  it('trims, because a trailing space is not a name', async () => {
    await t.asUser(alice, async () => {
      await t.sql(`select update_profile($1, '  Alice  ')`, [await nextOp()]);
    });
    await t.actAs(null);

    const { rows } = await t.sql(`select display_name from profiles where id = $1`, [alice]);
    assert.equal(rows[0].display_name, 'Alice');
  });

  it('refuses an empty one', async () => {
    const error = await t.asUser(alice, async () =>
      t.errorFrom(`select update_profile($1, '   ')`, [await nextOp()]),
    );
    await t.actAs(null);

    assert.equal(error?.code, '22023');
  });

  it('refuses one over fifty characters', async () => {
    const error = await t.asUser(alice, async () =>
      t.errorFrom(`select update_profile($1, $2)`, [await nextOp(), 'x'.repeat(51)]),
    );
    await t.actAs(null);

    assert.equal(error?.code, '22023');
  });

  it('refuses a control character, because this renders on every social surface', async () => {
    const error = await t.asUser(alice, async () =>
      t.errorFrom(`select update_profile($1, $2)`, [await nextOp(), 'Alice\nAnderson']),
    );
    await t.actAs(null);

    assert.equal(error?.code, '22023');
  });

  it('is idempotent by operation id', async () => {
    const operation = await nextOp();
    const result = await t.asUser(alice, async () => {
      await t.sql(`select update_profile($1, 'First') as r`, [operation]);
      const { rows } = await t.sql(`select update_profile($1, 'Second') as r`, [operation]);
      return rows[0].r;
    });
    await t.actAs(null);

    assert.equal(result.status, 'already_applied');
    const { rows } = await t.sql(`select display_name from profiles where id = $1`, [alice]);
    assert.equal(rows[0].display_name, 'First');
  });

  it('is not reachable signed out', async () => {
    const error = await t.asAnon(async () =>
      t.errorFrom(`select update_profile($1, 'Nobody')`, [await nextOp()]),
    );

    assert.equal(error?.code, '42501');
  });
});

// ---------------------------------------------------------------------------
// Renaming
// ---------------------------------------------------------------------------

describe('changing a handle', () => {
  let bob;

  before(async () => {
    bob = await t.createUser({ username: 'bob_rename' });
  });

  it('renames, and files the old name as a redirect', async () => {
    // The machinery this exercises is `reserve_username_on_rename`, built in
    // 20260813002000 and unreachable until now because no rename RPC existed.
    await t.asUser(bob, async () => {
      await t.sql(`select change_username($1, 'bob_renamed')`, [await nextOp()]);
    });
    await t.actAs(null);

    const { rows } = await t.sql(
      `select username::text, username_changed_at is not null as stamped
         from profiles where id = $1`,
      [bob],
    );
    assert.equal(rows[0].username, 'bob_renamed');
    assert.equal(rows[0].stamped, true);

    const { rows: history } = await t.sql(
      `select profile_id, redirect_until > now() as redirecting
         from username_history where username = 'bob_rename'`,
    );
    assert.equal(history[0].profile_id, bob);
    assert.equal(history[0].redirecting, true);
  });

  it('refuses a second change inside the cooldown', async () => {
    // Every rename burns a name permanently: username_history retains the row past
    // redirect_until precisely so the name never returns to the pool. Without this,
    // one account could exhaust every short handle in an afternoon.
    const error = await t.asUser(bob, async () =>
      t.errorFrom(`select change_username($1, 'bob_again')`, [await nextOp()]),
    );
    await t.actAs(null);

    assert.equal(error?.code, '53400');
  });

  it('allows it once the cooldown has passed', async () => {
    await t.sql(
      `update profiles set username_changed_at = now() - interval '31 days' where id = $1`,
      [bob],
    );

    await t.asUser(bob, async () => {
      await t.sql(`select change_username($1, 'bob_third')`, [await nextOp()]);
    });
    await t.actAs(null);

    const { rows } = await t.sql(`select username::text from profiles where id = $1`, [bob]);
    assert.equal(rows[0].username, 'bob_third');
  });

  it('treats the name you already have as a no-op rather than a rename', async () => {
    // Refusing it would burn a cooldown on nothing, and it is what a retry looks like.
    const result = await t.asUser(bob, async () => {
      const { rows } = await t.sql(`select change_username($1, 'bob_third') as r`, [await nextOp()]);
      return rows[0].r;
    });
    await t.actAs(null);

    assert.equal(result.status, 'ok');
    assert.equal(result.username, 'bob_third');
  });

  it('refuses a malformed handle before it touches eligibility', async () => {
    const error = await t.asUser(bob, async () =>
      t.errorFrom(`select change_username($1, 'Bob Third!')`, [await nextOp()]),
    );
    await t.actAs(null);

    assert.equal(error?.code, '22023');
  });

  it('refuses a name somebody else is using', async () => {
    const carol = await t.createUser({ username: 'carol_rename' });
    await t.sql(`update profiles set username_changed_at = null where id = $1`, [bob]);

    const error = await t.asUser(bob, async () =>
      t.errorFrom(`select change_username($1, 'carol_rename')`, [await nextOp()]),
    );
    await t.actAs(null);

    assert.equal(error?.code, '23505');
    assert.ok(carol);
  });

  it('lets you take back a handle that was yours', async () => {
    // `assert_username_available` refuses history belonging to *somebody else* and
    // deliberately admits your own, which 20260813002000 called out explicitly. The
    // test used to be titled as a refusal while asserting a success — independent
    // review 14 caught the mismatch, and the behaviour is the one worth keeping: a
    // handle you retired yesterday is still yours to take back.
    const error = await t.asUser(bob, async () =>
      t.errorFrom(`select change_username($1, 'bob_rename')`, [await nextOp()]),
    );
    await t.actAs(null);

    assert.equal(error, null);

    const { rows } = await t.sql(`select username::text from profiles where id = $1`, [bob]);
    assert.equal(rows[0].username, 'bob_rename');
  });
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

describe('privacy', () => {
  let dave;
  let erin;

  before(async () => {
    dave = await t.createUser({ username: 'dave_priv' });
    erin = await t.createUser({ username: 'erin_priv' });
  });

  it('sets the column can_view_profile has read since day one', async () => {
    await t.asUser(dave, async () => {
      await t.sql(`select set_profile_visibility($1, 'private')`, [await nextOp()]);
    });
    await t.actAs(null);

    const { rows } = await t.sql(`select visibility from profiles where id = $1`, [dave]);
    assert.equal(rows[0].visibility, 'private');
  });

  it('makes a new follow a request rather than a follow', async () => {
    // The whole point of the setting, and the first time anything could turn it on.
    await t.asUser(erin, async () => {
      await t.sql(`select follow($1, $2)`, [await nextOp(), dave]);
    });
    await t.actAs(null);

    const { rows } = await t.sql(
      `select state from follows where follower_id = $1 and followee_id = $2`,
      [erin, dave],
    );
    assert.equal(rows[0].state, 'pending');
  });

  it('approves everybody waiting when the account goes public', async () => {
    // Leaving them pending produces a state nothing else in the schema can create: a
    // public account where a new follower is approved instantly and the ones who asked
    // first are still queued.
    const result = await t.asUser(dave, async () => {
      const { rows } = await t.sql(`select set_profile_visibility($1, 'public') as r`, [
        await nextOp(),
      ]);
      return rows[0].r;
    });
    await t.actAs(null);

    assert.equal(result.approved, 1);
    const { rows } = await t.sql(
      `select state, approved_at is not null as stamped
         from follows where follower_id = $1 and followee_id = $2`,
      [erin, dave],
    );
    assert.equal(rows[0].state, 'approved');
    assert.equal(rows[0].stamped, true);
  });

  it('does so silently, because nobody decided about those people', async () => {
    // respond_follow_request sends follow_approved because somebody made a decision
    // about a specific person. Here the account stopped requiring one, and firing
    // "X approved your request" would attribute an act the user did not perform.
    const { rows } = await t.sql(
      `select count(*)::int as n from notifications
        where recipient_id = $1 and type = 'follow_approved'`,
      [erin],
    );
    assert.equal(rows[0].n, 0);
  });

  it('clears the requests from the inbox, since there is nothing left to answer', async () => {
    const { rows } = await t.sql(
      `select count(*)::int as n from notifications
        where recipient_id = $1 and type = 'follow_request'`,
      [dave],
    );
    assert.equal(rows[0].n, 0);
  });

  it('does not remove existing followers when going private again', async () => {
    // Going private means "from now on, ask". A retroactive revocation would sever
    // relationships the user did not name — that is what remove_follower is for.
    await t.asUser(dave, async () => {
      await t.sql(`select set_profile_visibility($1, 'private')`, [await nextOp()]);
    });
    await t.actAs(null);

    const { rows } = await t.sql(
      `select state from follows where follower_id = $1 and followee_id = $2`,
      [erin, dave],
    );
    assert.equal(rows[0].state, 'approved');
  });

  it('is not reachable signed out', async () => {
    const error = await t.asAnon(async () =>
      t.errorFrom(`select set_profile_visibility($1, 'public')`, [await nextOp()]),
    );

    assert.equal(error?.code, '42501');
  });
});

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

describe('the inbox', () => {
  let frank;
  let grace;

  before(async () => {
    frank = await t.createUser({ username: 'frank_inbox', visibility: 'private' });
    grace = await t.createUser({ username: 'grace_inbox', visibility: 'private' });

    await t.asUser(grace, async () => {
      await t.sql(`select follow($1, $2)`, [await nextOp(), frank]);
    });
    await t.actAs(null);
  });

  it('shows a private account’s request to another private account', async () => {
    // The reason this function is definer, and the reason it had to exist. Grace is
    // private and Frank does not follow her, so can_view_profile(frank, grace) is
    // false — an invoker query returns a notification with no name attached, and the
    // one control that resolves it cannot be drawn. The request would be permanently
    // unanswerable, which makes the private setting a trap rather than a choice.
    const rows = await t.asUser(frank, async () => {
      const { rows } = await t.sql(`select * from my_notifications(50)`);
      return rows;
    });
    await t.actAs(null);

    const request = rows.find((row) => row.kind === 'follow_request');
    assert.ok(request, 'the request should be in the inbox');
    assert.equal(request.actor_username, 'grace_inbox');
    assert.equal(request.actor_id, grace);
  });

  it('can be answered, which is the point of showing it', async () => {
    await t.asUser(frank, async () => {
      await t.sql(`select respond_follow_request($1, $2, true)`, [await nextOp(), grace]);
    });
    await t.actAs(null);

    const { rows } = await t.sql(
      `select state from follows where follower_id = $1 and followee_id = $2`,
      [grace, frank],
    );
    assert.equal(rows[0].state, 'approved');
  });

  it('answers only about the caller’s own inbox, and cannot be pointed elsewhere', async () => {
    const rows = await t.asUser(grace, async () => {
      const { rows } = await t.sql(`select * from my_notifications(50)`);
      return rows;
    });
    await t.actAs(null);

    // Grace sees her approval, and nothing addressed to Frank.
    assert.ok(rows.every((row) => row.kind !== 'follow_request'));
    assert.ok(rows.some((row) => row.kind === 'follow_approved'));
  });

  it('drops a row whose actor has been suspended', async () => {
    // Consistent with public_profiles, search_users and the feed: everything in this
    // schema filters on status = 'active'.
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [grace]);

    const rows = await t.asUser(frank, async () => {
      const { rows } = await t.sql(`select * from my_notifications(50)`);
      return rows;
    });
    await t.actAs(null);

    assert.ok(rows.every((row) => row.actor_id !== grace));
    await t.sql(`update profiles set status = 'active' where id = $1`, [grace]);
  });

  it('names the title behind a comment, and only the recipient’s own event', async () => {
    const film = await t.createMovie('Inbox Film', 880001);
    const { rows: event } = await t.sql(
      `insert into feed_events (actor_id, type, media_item_id)
       values ($1, 'title_ranked', $2) returning id`,
      [frank, film],
    );
    await t.sql(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'comment', $2, 'feed_event', $3)`,
      [frank, grace, event[0].id],
    );

    const rows = await t.asUser(frank, async () => {
      const { rows } = await t.sql(`select * from my_notifications(50)`);
      return rows;
    });
    await t.actAs(null);

    const comment = rows.find((row) => row.kind === 'comment');
    assert.equal(comment.media_title, 'Inbox Film');
    assert.equal(comment.media_item_id, film);
  });

  it('names no title for an event that is not the recipient’s own', async () => {
    // The join is constrained to fe.actor_id = auth.uid(). Both writers that use this
    // subject type set recipient_id to the event's own actor, so this is belt and
    // braces — but it is the difference between a resolver and an oracle.
    const film = await t.createMovie('Somebody Else’s Film', 880002);
    const { rows: event } = await t.sql(
      `insert into feed_events (actor_id, type, media_item_id)
       values ($1, 'title_ranked', $2) returning id`,
      [grace, film],
    );
    await t.sql(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'reaction', $2, 'feed_event', $3)`,
      [frank, grace, event[0].id],
    );

    const rows = await t.asUser(frank, async () => {
      const { rows } = await t.sql(`select * from my_notifications(50)`);
      return rows;
    });
    await t.actAs(null);

    const reaction = rows.find((row) => row.kind === 'reaction');
    assert.equal(reaction.media_title, null);
    assert.equal(reaction.media_item_id, null);
  });

  it('marks everything read, and says how many', async () => {
    const marked = await t.asUser(frank, async () => {
      const { rows } = await t.sql(`select mark_notifications_read() as n`);
      return rows[0].n;
    });
    await t.actAs(null);

    assert.ok(marked > 0);

    const again = await t.asUser(frank, async () => {
      const { rows } = await t.sql(`select mark_notifications_read() as n`);
      return rows[0].n;
    });
    await t.actAs(null);

    // Idempotent by construction: the `read_at is null` filter makes a second call a
    // no-op rather than a second timestamp.
    assert.equal(again, 0);
  });

  it('marks nobody else’s', async () => {
    const { rows } = await t.sql(
      `select count(*)::int as n from notifications
        where recipient_id <> $1 and read_at is not null`,
      [frank],
    );
    assert.equal(rows[0].n, 0);
  });

  it('is not reachable signed out', async () => {
    const error = await t.asAnon(() => t.errorFrom(`select * from my_notifications(10)`));

    assert.equal(error?.code, '42501');
  });
});

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

describe('deleting an account', () => {
  let heidi;
  let ivan;
  let film;
  let event;

  /** Everything one account can leave behind, so the cascade has something to clear. */
  const populate = async (user, other, mediaItem) => {
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, watched_on, note)
       values ($1, $2, 'loved', current_date, 'A note of theirs')`,
      [user, mediaItem],
    );
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved', 1)`,
      [user, mediaItem],
    );
    await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [
      user,
      mediaItem,
    ]);
    await t.sql(`insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`, [
      user,
      other,
    ]);
    await t.sql(`insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`, [
      other,
      user,
    ]);
    const { rows: event } = await t.sql(
      `insert into feed_events (actor_id, type, media_item_id)
       values ($1, 'title_ranked', $2) returning id`,
      [user, mediaItem],
    );
    await t.sql(`insert into reactions (user_id, feed_event_id, kind) values ($1, $2, 'love')`, [
      other,
      event[0].id,
    ]);
    await t.sql(
      `insert into comments (feed_event_id, author_id, body) values ($1, $2, 'Words of theirs')`,
      [event[0].id, user],
    );
    await t.sql(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'follow', $2, 'profile', $2)`,
      [other, user],
    );
    await t.sql(`insert into watch_goals (user_id, year, category, target) values ($1, 2026, 'movies', 20)`, [
      user,
    ]);
    await t.sql(
      `insert into watch_tags (tagger_id, tagged_id, media_item_id) values ($1, $2, $3)`,
      [user, other, mediaItem],
    );
    return event[0].id;
  };

  before(async () => {
    heidi = await t.createUser({ username: 'heidi_gone' });
    ivan = await t.createUser({ username: 'ivan_stays' });
    film = await t.createMovie('Deletion Film', 880100);
    event = await populate(heidi, ivan, film);
  });

  it('refuses without the caller’s own handle', async () => {
    // A yes/no dialog is a mistap; typing the handle is not.
    const error = await t.asUser(heidi, () => t.errorFrom(`select delete_account('yes')`));
    await t.actAs(null);

    assert.equal(error?.code, '22023');
    const { rows } = await t.sql(`select count(*)::int as n from profiles where id = $1`, [heidi]);
    assert.equal(rows[0].n, 1);
  });

  it('refuses somebody else’s handle', async () => {
    const error = await t.asUser(heidi, () => t.errorFrom(`select delete_account('ivan_stays')`));
    await t.actAs(null);

    assert.equal(error?.code, '22023');
  });

  it('accepts the handle in any case, because keyboards capitalise', async () => {
    const result = await t.asUser(heidi, async () => {
      const { rows } = await t.sql(`select delete_account('Heidi_Gone') as r`);
      return rows[0].r;
    });
    await t.actAs(null);

    assert.equal(result.status, 'ok');
  });

  it('removes the auth user, which is where every cascade starts', async () => {
    const { rows } = await t.sql(`select count(*)::int as n from auth.users where id = $1`, [heidi]);
    assert.equal(rows[0].n, 0);
  });

  it('leaves nothing of theirs in any table that references an account', async () => {
    // Swept from the catalogue rather than enumerated, because the failure mode is
    // *a table nobody remembered*. A table added later with a CASCADE rule is covered
    // the day it is created; one added without a delete rule fails the delete itself,
    // loudly, which is the other half of the same guarantee.
    //
    // `pg_constraint` rather than `information_schema`: the latter's
    // `constraint_column_usage` does not distinguish `public.users` from
    // `auth.users`, so the first version of this matched any table called users in
    // any schema. Independent review 14 raised the missing schema filter.
    const { rows: keys } = await t.sql(`
      select child.relname       as child,
             att.attname         as child_column,
             parent_ns.nspname || '.' || parent.relname as parent,
             c.confdeltype       as rule
        from pg_constraint c
        join pg_class     child     on child.oid = c.conrelid
        join pg_namespace child_ns  on child_ns.oid = child.relnamespace
        join pg_class     parent    on parent.oid = c.confrelid
        join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
        join lateral unnest(c.conkey) as k(attnum) on true
        join pg_attribute att on att.attrelid = child.oid and att.attnum = k.attnum
       where c.contype = 'f'
         and child_ns.nspname = 'public'
         and (   (parent_ns.nspname = 'public' and parent.relname = 'profiles')
              or (parent_ns.nspname = 'auth'   and parent.relname = 'users'))
    `);

    assert.ok(keys.length > 30, 'the sweep should find the whole graph');
    // The delete rule is checked rather than assumed: a future key added with NO
    // ACTION would block the deletion outright, and one added with SET NULL would
    // silently retain a row this loop then wrongly reports as a survivor.
    const cascading = keys.filter((key) => key.rule === 'c');
    const detaching = keys.filter((key) => key.rule === 'n');
    assert.equal(
      cascading.length + detaching.length,
      keys.length,
      'every key to an account is either CASCADE or SET NULL; anything else blocks deletion',
    );

    const survivors = [];
    for (const key of cascading) {
      const { rows } = await t.sql(
        `select count(*)::int as n from ${key.child} where ${key.child_column} = $1`,
        [heidi],
      );
      if (rows[0].n > 0) survivors.push(`${key.child}.${key.child_column}`);
    }

    assert.deepEqual(survivors, [], 'no row referencing a deleted account may survive');

    // And every detaching key really did detach rather than retain the id.
    const attached = [];
    for (const key of detaching) {
      const { rows } = await t.sql(
        `select count(*)::int as n from ${key.child} where ${key.child_column} = $1`,
        [heidi],
      );
      if (rows[0].n > 0) attached.push(`${key.child}.${key.child_column}`);
    }
    assert.deepEqual(attached, [], 'a SET NULL key must not still name the deleted account');
  });

  it('takes the rows that hang off theirs, one table further out', async () => {
    // The direct sweep above cannot see these: `comments` and `reactions` reference
    // `feed_events`, not `profiles`, so a transitive failure would not appear in it.
    // Independent review 14 was right that the catalogue sweep does not prove the
    // whole closure — this is the part of the closure the fixture actually populated,
    // asserted by id rather than by catalogue walk.
    const { rows: comments } = await t.sql(
      `select count(*)::int as n from comments where feed_event_id = $1`,
      [event],
    );
    const { rows: reactions } = await t.sql(
      `select count(*)::int as n from reactions where feed_event_id = $1`,
      [event],
    );
    const { rows: events } = await t.sql(
      `select count(*)::int as n from feed_events where id = $1`,
      [event],
    );

    assert.equal(events[0].n, 0, 'the event itself');
    assert.equal(comments[0].n, 0, 'their comment, which referenced the event and not them');
    assert.equal(
      reactions[0].n,
      0,
      'somebody else’s reaction to their activity, which is about an event that no longer exists',
    );
  });

  it('leaves the other account entirely alone', async () => {
    const { rows } = await t.sql(`select count(*)::int as n from profiles where id = $1`, [ivan]);
    assert.equal(rows[0].n, 1);

    // Ivan's reaction was on Heidi's event, so it goes with the event. What must
    // survive is Ivan himself and anything of his that is not about her.
    const { rows: goals } = await t.sql(
      `select count(*)::int as n from watch_goals where user_id = $1`,
      [ivan],
    );
    assert.equal(goals[0].n, 0);
  });

  it('reserves the handle rather than returning it to the pool', async () => {
    // The INF-2 impersonation outcome 20260813002000 exists to prevent: old links to
    // bingd.app/u/heidi_gone must not resolve to whoever takes the name next.
    const { rows } = await t.sql(
      `select profile_id, redirect_until <= now() as stopped
         from username_history where username = 'heidi_gone'`,
    );
    assert.equal(rows[0].profile_id, null, 'the pointer goes; the reservation stays');
    assert.equal(rows[0].stopped, true, 'a redirect to a deleted account is worse than a dead link');
  });

  it('will not let the handle be taken by somebody new', async () => {
    const error = await t.errorFrom(
      `insert into auth.users (id) values (gen_random_uuid())`,
    );
    assert.equal(error, null);

    const { rows } = await t.sql(`select id from auth.users order by id desc limit 1`);
    const fresh = rows[0].id;
    const taken = await t.errorFrom(
      `insert into profiles (id, username, display_name) values ($1, 'heidi_gone', 'Impostor')`,
      [fresh],
    );

    assert.equal(taken?.code, '23505');
  });

  it('keeps the catalogue, which was never theirs', async () => {
    const { rows } = await t.sql(`select count(*)::int as n from media_items where id = $1`, [film]);
    assert.equal(rows[0].n, 1);
  });

  it('is idempotent: a second call reports it was already done', async () => {
    // `_claim_operation` cannot help here — it writes to processed_operations, which
    // this operation deletes by cascade, so the claim is destroyed by the thing it was
    // meant to make repeatable. The natural guard is stronger.
    const result = await t.asRole('authenticated', heidi, async () => {
      const { rows } = await t.sql(`select delete_account('heidi_gone') as r`);
      return rows[0].r;
    });
    await t.actAs(null);

    assert.equal(result.status, 'already_applied');
  });

  it('lets a suspended account leave', async () => {
    // The only writer in this schema that skips assert_can_write. Suspension is a
    // moderation state about what somebody may do to other people; erasure is not
    // that, and refusing it would mean the accounts most likely to want out are the
    // ones that cannot.
    const judy = await t.createUser({ username: 'judy_suspended' });
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [judy]);

    const result = await t.asUser(judy, async () => {
      const { rows } = await t.sql(`select delete_account('judy_suspended') as r`);
      return rows[0].r;
    });
    await t.actAs(null);

    assert.equal(result.status, 'ok');
    const { rows } = await t.sql(`select count(*)::int as n from profiles where id = $1`, [judy]);
    assert.equal(rows[0].n, 0);
  });

  it('cannot delete anybody but the caller', async () => {
    // It takes no target and cannot be given one. The signature is the guarantee.
    const { rows } = await t.sql(`
      select pg_get_function_identity_arguments(p.oid) as args
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'delete_account'
    `);
    assert.equal(rows.length, 1, 'exactly one delete_account');
    assert.equal(rows[0].args, 'p_confirmation text', 'one argument, and it is the confirmation');
  });

  it('is not reachable signed out', async () => {
    const error = await t.asAnon(() => t.errorFrom(`select delete_account('anybody')`));

    assert.equal(error?.code, '42501');
  });
});
