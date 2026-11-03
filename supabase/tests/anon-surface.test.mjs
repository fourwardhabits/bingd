import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Exactly what the anon key can reach. Security audit 2026-11-01, M-3 and M-4.
 *
 * The anon key is on every bingd.app page, so this is what an unauthenticated stranger
 * holds. Written as whole-schema sweeps against allow-lists, for the reason
 * `function-grants.test.mjs` gives: the failure mode is a table nobody thought to check,
 * and a list of the ones somebody did think of is the same set that was already safe.
 *
 * **A new table fails here until somebody decides what it is.** That is the point.
 */

/** Every relation anon may read, with the columns. Nothing else, ever, by accident. */
const ANON_COLUMNS = {
  media_items: [
    'episode_count',
    'genres',
    'id',
    'kind',
    'overview',
    'parent_id',
    'poster_path',
    'release_date',
    'runtime_minutes',
    'season_number',
    'title',
  ],
  // For the operator's freshness probe, which holds only an anon key. Not the payload.
  provider_list_cache: ['fetched_at', 'list_key'],
};

/** Every function anon may execute. Each one's reason is in `function-grants.test.mjs`. */
const ANON_FUNCTIONS = [
  'environment_name()',
  'list_items_page(p_list_id uuid, p_after_position integer, p_limit integer)',
  'list_preview(p_list_id uuid)',
  'list_view(p_list_id uuid)',
  'public_profile_card(p_handle text)',
  'record_invite_open(p_token text, p_platform text)',
  'record_list_open(p_list_id uuid, p_platform text)',
];

/**
 * Every `profiles` column, and which side of the line it is on.
 *
 * The positive list is the grant. This second list exists so that a column added later has
 * to be sorted into one or the other, rather than being private by accident and then
 * granted in a hurry without anybody asking whether it should be.
 */
const PROFILE_COLUMNS_FOR_CLIENTS = [
  'avatar_path',
  'bio',
  'created_at',
  'display_name',
  'founding_member',
  'id',
  'link_instagram',
  'link_tiktok',
  'link_website',
  'link_x',
  'link_youtube',
  'status',
  'username',
  'username_changed_at',
  'visibility',
];
const PROFILE_COLUMNS_FOR_NOBODY = ['invited_by'];

let t;
let alice;
let bob;
let inviter;
let film;

const refused = async (query, params) => {
  const error = await t.asAnon(() => t.errorFrom(query, params));
  assert.equal(error?.code, '42501', `anon was not refused: ${query}`);
};

before(async () => {
  t = await createTestDb();
  alice = await t.createUser({ username: 'alice_pub' });
  bob = await t.createUser({ username: 'bob_pub' });
  inviter = await t.createUser({ username: 'hidden_inviter', visibility: 'private' });
  film = await t.createMovie('Surface Film', 7_200_001);
  const listed = await t.createMovie('Listed Film', 7_200_002);

  await t.sql(`update profiles set invited_by = $1 where id = $2`, [inviter, alice]);
  await t.asUser(alice, async () => {
    await t.rankToCompletion(film, 'loved', async () => film);
    await t.sql(`select set_watchlist(gen_random_uuid(), $1, true)`, [listed]);
    await t.sql(`select follow(gen_random_uuid(), $1)`, [bob]);
  });
});

after(async () => {
  await t.close();
});

describe('what anon can reach', () => {
  it('is exactly this list of relations and columns', async () => {
    const { rows } = await t.sql(`
      select c.relname as rel, a.attname as col
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       where n.nspname = 'public'
         and c.relkind in ('r', 'p', 'v', 'm', 'f')
         and has_column_privilege('anon', c.oid, a.attnum, 'select')
       order by 1, 2
    `);
    const actual = {};
    for (const { rel, col } of rows) (actual[rel] ??= []).push(col);
    assert.deepEqual(actual, ANON_COLUMNS);
  });

  it('holds no other privilege on any relation', async () => {
    const { rows } = await t.sql(`
      select c.relname, p.privilege
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       cross join unnest(array['insert','update','delete','truncate','references','trigger']) as p(privilege)
       where n.nspname = 'public'
         and c.relkind in ('r', 'p', 'v', 'm', 'f')
         and has_table_privilege('anon', c.oid, p.privilege)
    `);
    assert.deepEqual(rows, []);
  });

  it('is exactly this list of functions', async () => {
    const { rows } = await t.sql(`
      select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and has_function_privilege('anon', p.oid, 'execute')
         and not exists (
           select 1 from pg_depend d
            where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
         )
       order by 1
    `);
    assert.deepEqual(rows.map((r) => r.sig), ANON_FUNCTIONS);
  });

  it('stays that way for a table created tomorrow', async () => {
    // The default privileges are what make this durable: the sweep above would catch a
    // miss, but only on the next run after somebody wrote it.
    await t.sql(`create table public.probe_tomorrow (id integer primary key)`);
    try {
      await refused(`select id from probe_tomorrow`);
    } finally {
      await t.sql(`drop table public.probe_tomorrow`);
    }
  });
});

describe('M-3: the bulk reads the audit made', () => {
  for (const [what, query] of [
    ['profiles', `select id from profiles`],
    ['the public profile view', `select id from public_profiles`],
    ['the follow graph', `select follower_id from follows`],
    ['rankings', `select user_id from rankings`],
    ['watchlists', `select user_id from watchlist`],
    ['activity', `select id from feed_events`],
    ['reactions', `select user_id from reactions`],
    ['former handles', `select username from username_history`],
    ['comment mentions', `select mentioned_id from comment_mentions`],
    ['lists', `select id from lists`],
    ['watch tags', `select id from watch_tags`],
    ['invite attributions', `select invitee_id from invite_attributions`],
  ]) {
    it(`refuses ${what}`, () => refused(query));
  }

  it('does not list the avatars bucket, whose folders are account ids', async () => {
    await t.sql(
      `insert into storage.objects (bucket_id, name, owner) values ('avatars', $1, $2)`,
      [`${alice}/face.jpg`, alice],
    );
    const { rows } = await t.asAnon(() => t.sql(`select name from storage.objects`));
    assert.deepEqual(rows, []);
  });
});

describe('M-3: what the website still does', () => {
  const card = (handle) =>
    t.asAnon(async () => (await t.sql(`select * from public_profile_card($1)`, [handle])).rows);

  it('opens one public profile by exact handle, with three columns', async () => {
    assert.deepEqual(await card('alice_pub'), [
      { username: 'alice_pub', display_name: 'alice_pub', avatar_path: null },
    ]);
  });

  it('answers a private account, a suspended one and a stranger’s guess identically', async () => {
    const gone = await t.createUser({ username: 'gone_user' });
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [gone]);

    assert.deepEqual(await card('hidden_inviter'), []);
    assert.deepEqual(await card('gone_user'), []);
    assert.deepEqual(await card('no_such_handle'), []);
  });

  it('refuses anything shaped like a pattern, so it cannot be turned into a list', async () => {
    for (const probe of ['%', '_lice_pub', 'alice%', '*', '', 'ALICE_PUB', `alice_pub' or '1'='1`]) {
      assert.deepEqual(await card(probe), [], probe);
    }
    assert.deepEqual(await card(null), []);
  });

  it('is not there for a signed-in client, which has the real read', async () => {
    const error = await t.asUser(bob, () =>
      t.errorFrom(`select * from public_profile_card('alice_pub')`),
    );
    assert.equal(error?.code, '42501');
  });

  it('still serves the title page the columns it asks for, parent included', async () => {
    const select = `select m.kind, m.title, m.release_date, m.season_number, m.poster_path,
                           m.overview, m.runtime_minutes, m.genres, m.episode_count,
                           p.title as parent_title, p.genres as parent_genres
                      from media_items m left join media_items p on p.id = m.parent_id
                     where m.id = $1`;
    const { rows } = await t.asAnon(() => t.sql(select, [film]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Surface Film');
  });

  it('refuses a catalogue column nobody named', async () => {
    await refused(`select * from media_items where id = $1`, [film]);
  });
});

describe('M-4: invited_by', () => {
  it('sorts every column of profiles into one list or the other', async () => {
    const { rows } = await t.sql(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'profiles'`,
    );
    assert.deepEqual(
      rows.map((r) => r.column_name).sort(),
      [...PROFILE_COLUMNS_FOR_CLIENTS, ...PROFILE_COLUMNS_FOR_NOBODY].sort(),
      'a new column on profiles has to be put in one of the two lists above',
    );
  });

  it('grants exactly the allow-list, and table SELECT to nobody client-side', async () => {
    const { rows } = await t.sql(`
      select a.attname as col
        from pg_attribute a
       where a.attrelid = 'public.profiles'::regclass and a.attnum > 0 and not a.attisdropped
         and has_column_privilege('authenticated', a.attrelid, a.attnum, 'select')
       order by 1
    `);
    assert.deepEqual(rows.map((r) => r.col), PROFILE_COLUMNS_FOR_CLIENTS);

    const table = await t.sql(`
      select has_table_privilege('authenticated', 'public.profiles', 'select') as auth,
             has_table_privilege('anon', 'public.profiles', 'select') as anon
    `);
    assert.deepEqual(table.rows[0], { auth: false, anon: false });
  });

  for (const [role, run] of [
    ['anon', (q) => t.asAnon(q)],
    ['a signed-in stranger', (q) => t.asUser(bob, q)],
    ['the invitee', (q) => t.asUser(alice, q)],
    ['the inviter', (q) => t.asUser(inviter, q)],
  ]) {
    it(`cannot be read by ${role}`, async () => {
      const error = await run(() => t.errorFrom(`select invited_by from profiles limit 1`));
      assert.equal(error?.code, '42501');
    });

    it(`cannot be filtered on by ${role}`, async () => {
      const error = await run(() =>
        t.errorFrom(`select id from profiles where invited_by = $1`, [inviter]),
      );
      assert.equal(error?.code, '42501');
    });

    it(`cannot be sorted on by ${role}, which would leak it one comparison at a time`, async () => {
      const error = await run(() =>
        t.errorFrom(`select id from profiles order by invited_by limit 1`),
      );
      assert.equal(error?.code, '42501');
    });
  }

  it('is not read through select *, by a client that asked for everything', async () => {
    const error = await t.asUser(bob, () => t.errorFrom(`select * from profiles limit 1`));
    assert.equal(error?.code, '42501');
  });

  it('is not on the public view', async () => {
    const { rows } = await t.sql(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'public_profiles'`,
    );
    assert.ok(!rows.some((r) => r.column_name === 'invited_by'));
  });

  it('leaves the app’s own reads working', async () => {
    // The two literal column lists the client sends, and its view.
    const mine = await t.asUser(alice, () =>
      t.sql(
        `select id, username, display_name, bio, avatar_path, visibility, link_instagram,
                link_tiktok, link_youtube, link_x, link_website
           from profiles where id = $1`,
        [alice],
      ),
    );
    assert.equal(mine.rows.length, 1);

    const privacy = await t.asUser(alice, () =>
      t.sql(`select visibility from profiles where id = $1`, [alice]),
    );
    assert.equal(privacy.rows[0].visibility, 'public');

    const view = await t.asUser(bob, () =>
      t.sql(`select id, username from public_profiles where id = $1`, [alice]),
    );
    assert.equal(view.rows.length, 1);

    const canView = await t.asUser(bob, () => t.sql(`select can_i_view($1) as v`, [alice]));
    assert.equal(canView.rows[0].v, true);
  });

  it('still reaches the two parties through the table meant for it', async () => {
    const someone = await t.createUser({ username: 'attributed_user' });
    await t.sql(
      `insert into invite_attributions (invitee_id, inviter_id, accepted_at) values ($1, $2, now())`,
      [someone, inviter],
    );
    const read = (who) =>
      t.asUser(who, async () =>
        (await t.sql(`select invitee_id from invite_attributions where invitee_id = $1`, [someone])).rows.length,
      );

    assert.equal(await read(someone), 1);
    assert.equal(await read(inviter), 1);
    assert.equal(await read(bob), 0, 'a third party must not reach it this way either');
  });
});
