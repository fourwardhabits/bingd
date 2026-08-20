import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * The founder's acceptance corrections — 20260817000800.
 *
 * Four things, and three of them are about not inventing a second version of something
 * Bingd already has: a bio is a profile column like a display name, a review is a public
 * Note, and a notification preference is a table that has existed since day one with
 * nothing reading it.
 *
 * The fourth is `save_profile`, which exists because a screen with two saves can leave
 * the name written and the handle refused. Its whole value is that it cannot.
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
// The bio
// ---------------------------------------------------------------------------

describe('a bio', () => {
  let alice;

  before(async () => {
    alice = await t.createUser({ username: 'alice_bio' });
  });

  it('is null until somebody writes one, not an empty string', async () => {
    // The header renders nothing at all for null. '' would be a line of no height that
    // still moves everything below it.
    const { rows } = await t.sql(`select bio from profiles where id = $1`, [alice]);
    assert.equal(rows[0].bio, null);
  });

  it('saves', async () => {
    await t.asUser(alice, async () => {
      await t.sql(`select save_profile($1, null, null, 'Mostly horror and Studio Ghibli.')`, [
        await nextOp(),
      ]);
    });
    await t.actAs(null);

    const { rows } = await t.sql(`select bio from profiles where id = $1`, [alice]);
    assert.equal(rows[0].bio, 'Mostly horror and Studio Ghibli.');
  });

  it('is cleared by an empty string, which is the only thing that can clear it', async () => {
    // Null means "leave this alone", which is what lets a caller change one field
    // without restating the others — so clearing needs its own value.
    await t.asUser(alice, async () => {
      await t.sql(`select save_profile($1, null, null, '   ')`, [await nextOp()]);
    });
    await t.actAs(null);

    const { rows } = await t.sql(`select bio from profiles where id = $1`, [alice]);
    assert.equal(rows[0].bio, null);
  });

  it('refuses more than 120 characters', async () => {
    const error = await t.asUser(alice, async () =>
      t.errorFrom(`select save_profile($1, null, null, $2)`, [await nextOp(), 'x'.repeat(121)]),
    );
    await t.actAs(null);

    assert.equal(error?.code, '22023');
  });

  it('refuses a newline, because this renders on one line in a header', async () => {
    const error = await t.asUser(alice, async () =>
      t.errorFrom(`select save_profile($1, null, null, $2)`, [await nextOp(), 'One\nTwo']),
    );
    await t.actAs(null);

    assert.equal(error?.code, '22023');
  });

  it('cannot be written past the function, even by a direct update', async () => {
    // The constraint is the rule; the function's check is the message. Both exist for
    // the reason `display_name_shape` does.
    const error = await t.errorFrom(`update profiles set bio = $2 where id = $1`, [
      alice,
      'y'.repeat(200),
    ]);

    assert.equal(error?.code, '23514');
  });

  it('is published by public_profiles, like the display name', async () => {
    await t.asUser(alice, async () => {
      await t.sql(`select save_profile($1, null, null, 'A line about me.')`, [await nextOp()]);
    });
    await t.actAs(null);

    const { rows } = await t.sql(`select bio from public_profiles where id = $1`, [alice]);
    assert.equal(rows[0].bio, 'A line about me.');
  });

  it('is not published for a suspended account', async () => {
    // The view filters on status, and recreating it had to carry that over along with
    // security_invoker.
    const bob = await t.createUser({ username: 'bob_bio' });
    await t.sql(`update profiles set status = 'suspended', bio = 'Hidden' where id = $1`, [bob]);

    const { rows } = await t.sql(`select count(*)::int as n from public_profiles where id = $1`, [
      bob,
    ]);
    assert.equal(rows[0].n, 0);
  });
});

// ---------------------------------------------------------------------------
// One save
// ---------------------------------------------------------------------------

describe('saving a profile', () => {
  let carol;

  before(async () => {
    carol = await t.createUser({ username: 'carol_save' });
  });

  it('writes name, handle and bio together', async () => {
    await t.asUser(carol, async () => {
      await t.sql(`select save_profile($1, 'Carol C', 'carol_renamed', 'Westerns.')`, [
        await nextOp(),
      ]);
    });
    await t.actAs(null);

    const { rows } = await t.sql(
      `select display_name, username::text as username, bio from profiles where id = $1`,
      [carol],
    );
    assert.deepEqual(rows[0], {
      display_name: 'Carol C',
      username: 'carol_renamed',
      bio: 'Westerns.',
    });
  });

  it('leaves a field alone when it is null', async () => {
    await t.asUser(carol, async () => {
      await t.sql(`select save_profile($1, 'Carol Only', null, null)`, [await nextOp()]);
    });
    await t.actAs(null);

    const { rows } = await t.sql(
      `select display_name, username::text as username, bio from profiles where id = $1`,
      [carol],
    );
    assert.equal(rows[0].display_name, 'Carol Only');
    assert.equal(rows[0].username, 'carol_renamed');
    assert.equal(rows[0].bio, 'Westerns.');
  });

  it('does not charge a cooldown for sending the handle you already have', async () => {
    // The case that made this function necessary: somebody saving a bio sends every
    // field, including the handle they are not changing.
    const result = await t.asUser(carol, async () => {
      const { rows } = await t.sql(
        `select save_profile($1, null, 'carol_renamed', 'Westerns and noir.') as r`,
        [await nextOp()],
      );
      return rows[0].r;
    });
    await t.actAs(null);

    assert.equal(result.status, 'ok');
    assert.equal(result.renamed, false);

    const { rows } = await t.sql(`select bio from profiles where id = $1`, [carol]);
    assert.equal(rows[0].bio, 'Westerns and noir.');
  });

  it('refuses a second rename inside the cooldown', async () => {
    const error = await t.asUser(carol, async () =>
      t.errorFrom(`select save_profile($1, null, 'carol_again', null)`, [await nextOp()]),
    );
    await t.actAs(null);

    assert.equal(error?.code, '53400');
  });

  it('writes nothing at all when the handle is taken', async () => {
    // The entire reason this is one function. A screen with two saves would have
    // committed the name and then reported the handle refused.
    const dave = await t.createUser({ username: 'dave_save' });
    await t.sql(`update profiles set username_changed_at = null where id = $1`, [carol]);

    const error = await t.asUser(carol, async () =>
      t.errorFrom(`select save_profile($1, 'Should Not Stick', 'dave_save', 'Nor should this.')`, [
        await nextOp(),
      ]),
    );
    await t.actAs(null);

    assert.equal(error?.code, '23505');
    assert.ok(dave);

    const { rows } = await t.sql(
      `select display_name, bio from profiles where id = $1`,
      [carol],
    );
    assert.equal(rows[0].display_name, 'Carol Only');
    assert.equal(rows[0].bio, 'Westerns and noir.');
  });

  it('still writes the redirect when the handle does change', async () => {
    // The trigger from 20260813002000 fires on the update; this function does not
    // reimplement any of it.
    await t.asUser(carol, async () => {
      await t.sql(`select save_profile($1, null, 'carol_third', null)`, [await nextOp()]);
    });
    await t.actAs(null);

    const { rows } = await t.sql(
      `select profile_id, redirect_until > now() as redirecting
         from username_history where username = 'carol_renamed'`,
    );
    assert.equal(rows[0].profile_id, carol);
    assert.equal(rows[0].redirecting, true);
  });

  it('is idempotent by operation id', async () => {
    const operation = await nextOp();
    const result = await t.asUser(carol, async () => {
      await t.sql(`select save_profile($1, 'First', null, null)`, [operation]);
      const { rows } = await t.sql(`select save_profile($1, 'Second', null, null) as r`, [operation]);
      return rows[0].r;
    });
    await t.actAs(null);

    assert.equal(result.status, 'already_applied');
    const { rows } = await t.sql(`select display_name from profiles where id = $1`, [carol]);
    assert.equal(rows[0].display_name, 'First');
  });

  it('replaced the two writers it came from', async () => {
    // Dropped rather than left as overloads: PostgREST resolves by argument name and
    // nesting argument sets resolve ambiguously.
    const { rows } = await t.sql(`
      select count(*)::int as n from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('update_profile', 'change_username')
    `);
    assert.equal(rows[0].n, 0);
  });

  it('is not reachable signed out', async () => {
    const error = await t.asAnon(async () =>
      t.errorFrom(`select save_profile($1, 'Nobody', null, null)`, [await nextOp()]),
    );

    assert.equal(error?.code, '42501');
  });
});

// ---------------------------------------------------------------------------
// Bingd Reviews
// ---------------------------------------------------------------------------

describe('reviews on a title', () => {
  let film;
  let erin;
  let frank;
  let grace;
  let viewer;

  const review = async (user, text) => {
    await t.sql(
      `insert into user_media (user_id, media_item_id, note, note_visibility, note_has_spoilers, note_updated_at)
       values ($1, $2, $3, 'public', false, now())
       on conflict (user_id, media_item_id) do update
         set note = excluded.note, note_visibility = 'public', note_updated_at = now()`,
      [user, film, text],
    );
  };

  before(async () => {
    film = await t.createMovie('Reviewed Twice', 770001);
    erin = await t.createUser({ username: 'erin_rev' });
    frank = await t.createUser({ username: 'frank_rev' });
    grace = await t.createUser({ username: 'grace_rev', visibility: 'private' });
    viewer = await t.createUser({ username: 'viewer_rev' });

    for (const [user, text] of [
      [erin, 'Erin thought it was fine.'],
      [frank, 'Frank loved it.'],
      [grace, 'Grace is private.'],
    ]) {
      await review(user, text);
    }

    // Frank ranks it, so he has a score and a feed event to react to.
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved', 1)`,
      [frank, film],
    );
    const { rows: event } = await t.sql(
      `insert into feed_events (actor_id, type, media_item_id)
       values ($1, 'title_ranked', $2) returning id`,
      [frank, film],
    );
    await t.sql(`insert into reactions (user_id, feed_event_id, kind) values ($1, $2, 'love')`, [
      erin,
      event[0].id,
    ]);
    await t.sql(`insert into reactions (user_id, feed_event_id, kind) values ($1, $2, 'agree')`, [
      viewer,
      event[0].id,
    ]);
  });

  it('returns the public notes on the title, with the author named', async () => {
    const rows = await t.asUser(viewer, async () => {
      const { rows } = await t.sql(`select * from title_reviews($1, 'recent', 25)`, [film]);
      return rows;
    });
    await t.actAs(null);

    const authors = rows.map((row) => row.username).sort();
    assert.deepEqual(authors, ['erin_rev', 'frank_rev']);
    assert.ok(rows.every((row) => row.note && row.display_name));
  });

  it('hides a private account’s note from somebody who does not follow them', async () => {
    // The same predicate `public_notes` uses, deliberately the same expression.
    const rows = await t.asUser(viewer, async () => {
      const { rows } = await t.sql(`select * from title_reviews($1, 'recent', 25)`, [film]);
      return rows;
    });
    await t.actAs(null);

    assert.ok(rows.every((row) => row.username !== 'grace_rev'));
  });

  it('carries the author’s live score, not the feed event’s snapshot', async () => {
    // A snapshot drifts every time the author ranks anything else — the same reason
    // the founder ruled it out for Taste Match.
    const rows = await t.asUser(viewer, async () => {
      const { rows } = await t.sql(`select * from title_reviews($1, 'recent', 25)`, [film]);
      return rows;
    });
    await t.actAs(null);

    const frankRow = rows.find((row) => row.username === 'frank_rev');
    assert.equal(Number(frankRow.score), 10);
  });

  it('shows a note with no ranking behind it, with a null score', async () => {
    // Logging and ranking are separate actions, and refusing to show somebody's words
    // because there is no number would be the wrong way round.
    const rows = await t.asUser(viewer, async () => {
      const { rows } = await t.sql(`select * from title_reviews($1, 'recent', 25)`, [film]);
      return rows;
    });
    await t.actAs(null);

    const erinRow = rows.find((row) => row.username === 'erin_rev');
    assert.equal(erinRow.score, null);
    assert.equal(erinRow.note, 'Erin thought it was fine.');
  });

  it('counts reactions to the activity the note belongs to', async () => {
    const rows = await t.asUser(viewer, async () => {
      const { rows } = await t.sql(`select * from title_reviews($1, 'recent', 25)`, [film]);
      return rows;
    });
    await t.actAs(null);

    assert.equal(rows.find((row) => row.username === 'frank_rev').reaction_count, 2);
    assert.equal(rows.find((row) => row.username === 'erin_rev').reaction_count, 0);
  });

  it('counts only the latest ranking’s reactions, not every one they ever had', async () => {
    // Independent review 16's Major. `_rank_finalize` writes a *new* `title_ranked`
    // event every time a ranking completes, and unranking, reranking and rebucketing
    // all complete one — so the old event stays and so do its reactions. Summing across
    // all of them is a lifetime total that a rebucket inflates, and under `top` those
    // stale reactions push a review above one that earned its own.
    const { rows: reranked } = await t.sql(
      `insert into feed_events (actor_id, type, media_item_id, created_at)
       values ($1, 'title_ranked', $2, now() + interval '1 minute') returning id`,
      [frank, film],
    );

    const before = await t.asUser(viewer, async () => {
      const { rows } = await t.sql(`select * from title_reviews($1, 'recent', 25)`, [film]);
      return rows.find((row) => row.username === 'frank_rev').reaction_count;
    });
    await t.actAs(null);

    // Nobody has reacted to the new activity yet, so the count is zero rather than the
    // two the previous ranking collected.
    assert.equal(before, 0);

    await t.sql(`insert into reactions (user_id, feed_event_id, kind) values ($1, $2, 'love')`, [
      erin,
      reranked[0].id,
    ]);

    const after = await t.asUser(viewer, async () => {
      const { rows } = await t.sql(`select * from title_reviews($1, 'recent', 25)`, [film]);
      return rows.find((row) => row.username === 'frank_rev').reaction_count;
    });
    await t.actAs(null);

    assert.equal(after, 1, 'the new activity’s own reaction, and not the old two as well');

    // Put it back, so the ordering tests below read the state they were written for.
    await t.sql(`delete from feed_events where id = $1`, [reranked[0].id]);
  });

  it('puts the most-reacted review first under Top', async () => {
    const rows = await t.asUser(viewer, async () => {
      const { rows } = await t.sql(`select * from title_reviews($1, 'top', 25)`, [film]);
      return rows;
    });
    await t.actAs(null);

    assert.equal(rows[0].username, 'frank_rev');
  });

  it('orders by recency under Recent', async () => {
    await t.sql(
      `update user_media set note_updated_at = now() + interval '1 minute'
        where user_id = $1 and media_item_id = $2`,
      [erin, film],
    );

    const rows = await t.asUser(viewer, async () => {
      const { rows } = await t.sql(`select * from title_reviews($1, 'recent', 25)`, [film]);
      return rows;
    });
    await t.actAs(null);

    assert.equal(rows[0].username, 'erin_rev');
  });

  it('returns the same order twice, so a list does not reorder under a still reader', async () => {
    const read = async () => {
      const rows = await t.asUser(viewer, async () => {
        const { rows } = await t.sql(`select * from title_reviews($1, 'top', 25)`, [film]);
        return rows;
      });
      await t.actAs(null);
      return rows.map((row) => row.username);
    };

    assert.deepEqual(await read(), await read());
  });

  it('omits a note the author made private', async () => {
    await t.sql(
      `update user_media set note_visibility = 'private'
        where user_id = $1 and media_item_id = $2`,
      [erin, film],
    );

    const rows = await t.asUser(viewer, async () => {
      const { rows } = await t.sql(`select * from title_reviews($1, 'recent', 25)`, [film]);
      return rows;
    });
    await t.actAs(null);

    assert.ok(rows.every((row) => row.username !== 'erin_rev'));
  });

  it('is not reachable signed out, following the rule public_notes set', async () => {
    const error = await t.asAnon(() => t.errorFrom(`select * from title_reviews($1, 'top', 5)`, [film]));

    assert.equal(error?.code, '42501');
  });
});

// ---------------------------------------------------------------------------
// Notification preferences
// ---------------------------------------------------------------------------

describe('notification preferences', () => {
  let heidi;
  let ivan;
  let film;
  let event;

  const inbox = async (kind) => {
    const { rows } = await t.sql(
      `select count(*)::int as n from notifications where recipient_id = $1 and type = $2`,
      [heidi, kind],
    );
    return rows[0].n;
  };

  before(async () => {
    heidi = await t.createUser({ username: 'heidi_pref' });
    ivan = await t.createUser({ username: 'ivan_pref' });
    film = await t.createMovie('Preference Film', 770002);
    const { rows } = await t.sql(
      `insert into feed_events (actor_id, type, media_item_id)
       values ($1, 'title_ranked', $2) returning id`,
      [heidi, film],
    );
    event = rows[0].id;
  });

  it('answers for every category, defaulted by the category rather than by absence', async () => {
    // 20260819000300 replaced the two categories with eight, and made absence mean
    // *the category's default* rather than a flat true. Six are still on; reactions
    // and awards are off, which is why the old flat assertion could not survive.
    const rows = await t.asUser(heidi, async () => {
      const { rows } = await t.sql(`select * from my_notification_preferences() order by category`);
      return rows;
    });
    await t.actAs(null);

    assert.deepEqual(rows, [
      { category: 'awards', enabled: false },
      { category: 'comments', enabled: true },
      { category: 'follow_accepted', enabled: true },
      { category: 'follows', enabled: true },
      { category: 'invites', enabled: true },
      { category: 'reactions', enabled: false },
      { category: 'recommendations', enabled: true },
      { category: 'watch_tags', enabled: true },
    ]);
  });

  it('delivers a reaction while reactions is on', async () => {
    // Explicitly on, because this category is the one that defaults off. Asserting a
    // delivery against the default would be asserting the default, not the gate.
    await t.asUser(heidi, async () => {
      await t.sql(`select set_notification_preference('reactions', true)`);
    });
    await t.actAs(null);

    await t.asUser(ivan, async () => {
      await t.sql(`select set_reaction($1, $2, 'love')`, [await nextOp(), event]);
    });
    await t.actAs(null);

    assert.equal(await inbox('reaction'), 1);
  });

  it('stops delivering once reactions is off', async () => {
    // The switch that had no effect until 20260817000800, and had no category of its
    // own until 20260819000300 — before which silencing a reaction meant silencing
    // every comment too.
    await t.asUser(heidi, async () => {
      await t.sql(`select set_notification_preference('reactions', false)`);
    });
    await t.actAs(null);
    await t.sql(`delete from notifications where recipient_id = $1`, [heidi]);

    const carol = await t.createUser({ username: 'carol_pref' });
    await t.asUser(carol, async () => {
      await t.sql(`select set_reaction($1, $2, 'love')`, [await nextOp(), event]);
    });
    await t.actAs(null);

    assert.equal(await inbox('reaction'), 0);
  });

  it('leaves the reaction itself alone — the setting is about the inbox', async () => {
    const { rows } = await t.sql(
      `select count(*)::int as n from reactions where feed_event_id = $1`,
      [event],
    );
    assert.equal(rows[0].n, 2);
  });

  it('does not touch the other category', async () => {
    await t.asUser(ivan, async () => {
      await t.sql(`select follow($1, $2)`, [await nextOp(), heidi]);
    });
    await t.actAs(null);

    assert.equal(await inbox('follow'), 1);
  });

  it('stops a follow notice once follows is off', async () => {
    await t.asUser(heidi, async () => {
      await t.sql(`select set_notification_preference('follows', false)`);
    });
    await t.actAs(null);
    await t.sql(`delete from notifications where recipient_id = $1`, [heidi]);

    const dave = await t.createUser({ username: 'dave_pref' });
    await t.asUser(dave, async () => {
      await t.sql(`select follow($1, $2)`, [await nextOp(), heidi]);
    });
    await t.actAs(null);

    assert.equal(await inbox('follow'), 0);
  });

  it('never silences a follow request, which is a task rather than news', async () => {
    // The one control this schema must not offer: an account that could would receive
    // requests it can never see and never answer, and the requester would wait for ever.
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [heidi]);
    await t.sql(`delete from notifications where recipient_id = $1`, [heidi]);

    const erin = await t.createUser({ username: 'erin_pref' });
    await t.asUser(erin, async () => {
      await t.sql(`select follow($1, $2)`, [await nextOp(), heidi]);
    });
    await t.actAs(null);

    assert.equal(await inbox('follow_request'), 1);
  });

  it('delivers a type nobody has mapped, rather than dropping it', async () => {
    // A notification kind added later and forgotten in the map should reach its
    // recipient. The failure mode of the other default is silent and undetectable.
    await t.sql(
      `insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
       values ($1, 'milestone', $2, 'profile', $2)`,
      [heidi, ivan],
    );

    assert.equal(await inbox('milestone'), 1);
  });

  it('refuses a category that is not one of the eight', async () => {
    const error = await t.asUser(heidi, () =>
      t.errorFrom(`select set_notification_preference('marketing', false)`),
    );
    await t.actAs(null);

    assert.equal(error?.code, '22023');
  });

  it('is not reachable signed out', async () => {
    const error = await t.asAnon(() =>
      t.errorFrom(`select set_notification_preference('comments', false)`),
    );

    assert.equal(error?.code, '42501');
  });

  it('keeps _notifies internal, because it answers about a third party', async () => {
    const alice = await t.createUser({ username: 'alice_pref' });
    const error = await t.asUser(alice, () =>
      t.errorFrom(`select _notifies($1, 'comments')`, [heidi]),
    );
    await t.actAs(null);

    assert.equal(error?.code, '42501');
  });
});
