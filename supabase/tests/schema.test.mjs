import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Structural guarantees from docs/architecture/data-model.md §14. Each of these
 * is a PRD requirement that the schema is supposed to make *impossible* to
 * violate rather than merely forbid, so each test tries to violate it and
 * expects to be stopped by the database.
 */

let t;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

describe('migrations', () => {
  it('all apply cleanly in order', () => {
    assert.ok(t.appliedMigrations.length >= 7, 'expected the full migration set');
  });

  it('every user-owned table has row level security enabled', async () => {
    const { rows } = await t.sql(`
      select c.relname
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and not c.relrowsecurity
    `);
    assert.deepEqual(
      rows.map((r) => r.relname),
      [],
      'these tables are missing RLS',
    );
  });

  it('no table grants insert, update, or delete to client roles', async () => {
    // AD-4: every write goes through a SECURITY DEFINER function.
    const { rows } = await t.sql(`
      select table_name, privilege_type
        from information_schema.role_table_grants
       where table_schema = 'public'
         and grantee in ('anon', 'authenticated', 'public')
         and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
    `);
    assert.deepEqual(rows, []);
  });
});

describe('two titles never share a position', () => {
  it('rejects a duplicate position outright', async () => {
    const u = await t.createUser({ username: 'dup_user' });
    const a = await t.createMovie('A', 9001);
    const b = await t.createMovie('B', 9002);

    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket)
       values ($1, $2, 'loved'), ($1, $3, 'loved')`,
      [u, a, b],
    );
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved', 1)`,
      [u, a],
    );

    await assert.rejects(
      () =>
        t.sql(
          `insert into rankings (user_id, media_item_id, category, bucket, position)
           values ($1, $2, 'movies', 'loved', 1)`,
          [u, b],
        ),
      /rankings_position_unique|duplicate key/i,
    );
  });
});

describe('Early Access grants cannot become permanent', () => {
  it('rejects an alpha_early_access grant with no expiry', async () => {
    const u = await t.createUser({ username: 'grant_user' });
    await assert.rejects(
      () =>
        t.sql(
          `insert into capability_grants (user_id, capability, source)
           values ($1, 'alpha_early_access', 'alpha_early_access')`,
          [u],
        ),
      /early_access_must_expire/i,
      'PRD §20 requires that grants cannot silently become permanent',
    );
  });

  it('accepts the same grant with an expiry', async () => {
    const u = await t.createUser({ username: 'grant_user2' });
    await t.sql(
      `insert into capability_grants (user_id, capability, source, expires_at)
       values ($1, 'alpha_early_access', 'alpha_early_access', now() + interval '30 days')`,
      [u],
    );
    const { rows } = await t.sql(`select resolve_capabilities($1) as caps`, [u]);
    assert.ok(rows[0].caps.includes('base_free'));
    assert.ok(rows[0].caps.includes('alpha_early_access'));
  });
});

describe('reactions carry no moderation surface', () => {
  it('has no text column beyond the reaction kind', async () => {
    const { rows } = await t.sql(`
      select column_name from information_schema.columns
       where table_name = 'reactions' and table_schema = 'public'
    `);
    const columns = rows.map((r) => r.column_name).sort();
    assert.deepEqual(columns, ['created_at', 'feed_event_id', 'kind', 'user_id']);
  });

  it('permits only one reaction per user per event', async () => {
    const u = await t.createUser({ username: 'reactor' });
    const m = await t.createMovie('Reacted', 9100);
    const { rows } = await t.sql(
      `insert into feed_events (actor_id, type, media_item_id)
       values ($1, 'title_logged', $2) returning id`,
      [u, m],
    );
    const event = rows[0].id;

    await t.sql(`insert into reactions (feed_event_id, user_id, kind) values ($1,$2,'love')`, [
      event,
      u,
    ]);
    await assert.rejects(
      () =>
        t.sql(`insert into reactions (feed_event_id, user_id, kind) values ($1,$2,'agree')`, [
          event,
          u,
        ]),
      /duplicate key/i,
    );
  });
});

describe('one reusable invite link per user', () => {
  it('permits many revoked tokens but only one live one', async () => {
    const u = await t.createUser({ username: 'inviter' });

    await t.sql(
      `insert into invite_tokens (owner_id, token, short_code, env, revoked_at)
       values ($1, 'tok-old', 'OLD123', 'nonprod', now())`,
      [u],
    );
    await t.sql(
      `insert into invite_tokens (owner_id, token, short_code, env)
       values ($1, 'tok-live', 'LIVE01', 'nonprod')`,
      [u],
    );

    await assert.rejects(
      () =>
        t.sql(
          `insert into invite_tokens (owner_id, token, short_code, env)
           values ($1, 'tok-second', 'LIVE02', 'nonprod')`,
          [u],
        ),
      /duplicate key/i,
      'PRD §17 specifies one reusable personal link per user',
    );
  });
});

describe('a block overrides public visibility', () => {
  it('hides a public profile from someone it has blocked', async () => {
    const alex = await t.createUser({ username: 'alex_pub' });
    const sam = await t.createUser({ username: 'sam_pub' });

    let { rows } = await t.sql(`select can_view_profile($1, $2) as ok`, [sam, alex]);
    assert.equal(rows[0].ok, true, 'a public profile is visible before any block');

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [alex, sam]);

    ({ rows } = await t.sql(`select can_view_profile($1, $2) as ok`, [sam, alex]));
    assert.equal(rows[0].ok, false, 'the block test must precede the public test');

    // And symmetrically: the blocker cannot see the blocked party either.
    ({ rows } = await t.sql(`select can_view_profile($1, $2) as ok`, [alex, sam]));
    assert.equal(rows[0].ok, false);
  });

  it('keeps a private profile hidden from a non-follower and visible to a follower', async () => {
    const priv = await t.createUser({ username: 'priv_user', visibility: 'private' });
    const other = await t.createUser({ username: 'other_user' });

    let { rows } = await t.sql(`select can_view_profile($1, $2) as ok`, [other, priv]);
    assert.equal(rows[0].ok, false);

    await t.sql(
      `insert into follows (follower_id, followee_id, state, approved_at)
       values ($1, $2, 'approved', now())`,
      [other, priv],
    );

    ({ rows } = await t.sql(`select can_view_profile($1, $2) as ok`, [other, priv]));
    assert.equal(rows[0].ok, true);
  });

  it('shows only public profiles to an unauthenticated viewer', async () => {
    const pub = await t.createUser({ username: 'anon_visible' });
    const priv = await t.createUser({ username: 'anon_hidden', visibility: 'private' });

    let { rows } = await t.sql(`select can_view_profile(null, $1) as ok`, [pub]);
    assert.equal(rows[0].ok, true);

    ({ rows } = await t.sql(`select can_view_profile(null, $1) as ok`, [priv]));
    assert.equal(rows[0].ok, false);
  });
});

describe('the 13+ gate', () => {
  it('never exposes date of birth, only the derived boolean', async () => {
    const child = await t.createUser({ username: 'too_young', dob: '2020-01-01' });
    const adult = await t.createUser({ username: 'old_enough', dob: '1990-01-01' });

    let { rows } = await t.sql(`select is_over_13($1) as ok`, [child]);
    assert.equal(rows[0].ok, false);

    ({ rows } = await t.sql(`select is_over_13($1) as ok`, [adult]));
    assert.equal(rows[0].ok, true);
  });
});

describe('usernames', () => {
  it('rejects a username that is not lowercase, alphanumeric, or underscore', async () => {
    const { rows } = await t.sql(`select gen_random_uuid() as id`);
    const id = rows[0].id;
    await t.sql(`insert into auth.users (id) values ($1)`, [id]);

    for (const bad of ['Alex', 'al ex', 'ab', 'a'.repeat(25), 'al-ex', 'alex!']) {
      await assert.rejects(
        () =>
          t.sql(
            `insert into profiles (id, username, display_name)
             values ($1, $2, 'x')`,
            [id, bad],
          ),
        /username_format/i,
        `expected ${bad} to be refused`,
      );
    }
  });

  it('never returns a released username to the available pool', async () => {
    // The property that matters is that *a different account* cannot take the
    // name. Asserting only that username_history rejects a duplicate would test
    // the wrong table: that key is unique within the history and has no
    // connection to profiles.username, which is how a retired name stayed
    // claimable while a history row sat there looking reassuring.
    const original = await t.createUser({ username: 'released_one' });
    await t.sql(
      `insert into username_history (username, profile_id, redirect_until)
       values ('released_one', $1, now() + interval '90 days')`,
      [original],
    );

    const { rows } = await t.sql(`select gen_random_uuid() as id`);
    const impostor = rows[0].id;
    await t.sql(`insert into auth.users (id) values ($1)`, [impostor]);

    await assert.rejects(
      () =>
        t.sql(`insert into profiles (id, username, display_name) values ($1, 'released_one', 'x')`, [
          impostor,
        ]),
      /reserved|duplicate key/i,
      'a retired username was claimable by another account',
    );
  });

  it('reserves the username of a deleted account', async () => {
    const leaving = await t.createUser({ username: 'gone_away' });
    await t.sql(`delete from profiles where id = $1`, [leaving]);

    // The name must not simply become free. Every bingd.app/u/gone_away link
    // ever shared would otherwise point at whoever claimed it next, which is the
    // impersonation outcome INF-2 exists to prevent.
    const { rows: reserved } = await t.sql(
      `select profile_id from username_history where username = 'gone_away'`,
    );
    assert.equal(reserved.length, 1, 'the released name was not reserved');
    assert.equal(reserved[0].profile_id, null, 'a reservation has no redirect target');

    const { rows } = await t.sql(`select gen_random_uuid() as id`);
    const next = rows[0].id;
    await t.sql(`insert into auth.users (id) values ($1)`, [next]);
    await assert.rejects(
      () =>
        t.sql(`insert into profiles (id, username, display_name) values ($1, 'gone_away', 'x')`, [
          next,
        ]),
      /reserved/i,
    );
  });

  it('still lets an account keep its own name through an unrelated update', async () => {
    // The reservation trigger fires on update too, so a profile writing its own
    // unchanged username must not be refused by its own history rows.
    const u = await t.createUser({ username: 'keeps_name' });
    await t.sql(
      `insert into username_history (username, profile_id, redirect_until)
       values ('old_name', $1, now() + interval '90 days')`,
      [u],
    );
    await t.sql(`update profiles set display_name = 'Renamed' where id = $1`, [u]);
    await t.sql(`update profiles set username = 'keeps_name' where id = $1`, [u]);
  });
});

describe('the catalog', () => {
  it('requires a season to have a parent and a number', async () => {
    await assert.rejects(
      () =>
        t.sql(`insert into media_items (kind, title) values ('season', 'Orphan season')`),
      /season_has_parent/i,
    );
  });

  it('forbids a movie from carrying a parent or a season number', async () => {
    const series = await t.createSeries('Parent', 9200);
    await assert.rejects(
      () =>
        t.sql(
          `insert into media_items (kind, title, parent_id, season_number)
           values ('movie', 'Confused', $1, 1)`,
          [series],
        ),
      /season_has_parent/i,
    );
  });

  it('derives the rankable category and refuses series', async () => {
    const { rows } = await t.sql(`
      select rankable_category('movie')  as movie,
             rankable_category('season') as season,
             rankable_category('series') as series
    `);
    assert.equal(rows[0].movie, 'movies');
    assert.equal(rows[0].season, 'tv_seasons');
    assert.equal(rows[0].series, null, 'PRD §10 forbids ranking a whole series');
  });
});
