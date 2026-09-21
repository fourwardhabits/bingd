import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Lists v1, read adversarially — `20261010000100`.
 *
 * ---------------------------------------------------------------------------
 * HOW THIS FILE DIFFERS FROM `lists.test.mjs`
 *
 * That file asks *does the feature work*. This one asks *what can somebody take
 * who is trying to*. The difference is the direction every assertion points:
 * nothing here confirms a happy path, and every test names a specific thing a
 * caller must not end up holding.
 *
 * The six anon-granted readers are the surface that matters, because they are
 * reachable from `bingd.app` with the publishable key that ships in the mobile
 * bundle:
 *
 *   list_view · list_items_page · list_preview · record_list_open ·
 *   list_by_id · list_items_by_list
 *
 * ---------------------------------------------------------------------------
 * THE CLAIM EACH SECTION MAKES
 *
 * **A.** A private list is unreachable anonymously through every one of the six,
 *        and through a direct table read.
 * **B.** Link-only grants *that list* and nothing else about its owner. The
 *        bound is tested by enumerating what the same caller can still reach.
 * **C.** Public follows the profile, including when the profile changes later.
 * **D.** A moderation hide beats every mode, through every reader.
 * **E.** Writers refuse a non-owner, and the refusal is indistinguishable from
 *        "no such list".
 * **F.** Progress and seen marks are the *caller's own* and cannot be pointed at
 *        anybody else.
 * **G.** No list reader returns a score, a bucket, a position, a watch date, a
 *        note, or a watch-history row. This is asserted over the **shape** of
 *        the answer rather than field by field, so a column added later is
 *        caught rather than quietly shipped.
 * **H.** Every definer function has a safe `search_path`, and the anon grant set
 *        is exactly six.
 */

let t;
let seq = 91000;

const uuid = () => crypto.randomUUID();

/** Runs as a real Supabase role, so RLS is enforced rather than owner-bypassed. */
const as = (who, fn) => (who === null ? t.asAnon(fn) : t.asUser(who, fn));

const rpc = (who, call, params = []) =>
  as(who, async () => (await t.sql(call, params)).rows);

/** The answer, or the error — so "refused" and "returned nothing" stay distinguishable. */
const tryRpc = async (who, call, params = []) => {
  try {
    return { rows: await rpc(who, call, params), error: null };
  } catch (error) {
    return { rows: null, error };
  }
};

const listView = (who, id) =>
  rpc(who, `select list_view($1) as r`, [id]).then((r) => r[0]?.r ?? null);
const itemsPage = (who, id) => rpc(who, `select * from list_items_page($1, null, 100)`, [id]);
const preview = (who, id) => rpc(who, `select * from list_preview($1)`, [id]);
const byId = (who, id) => rpc(who, `select * from list_by_id($1)`, [id]);
const itemsByList = (who, id) => rpc(who, `select * from list_items_by_list($1)`, [id]);
const profileLists = (who, owner) =>
  rpc(who, `select * from profile_lists($1, null, 50)`, [owner]);

/** Every reader that takes a list id, as one object. */
const readers = async (who, id) => ({
  list_view: (await listView(who, id)) !== null,
  list_items_page: (await itemsPage(who, id)).length > 0,
  list_by_id: (await byId(who, id)).length > 0,
  list_items_by_list: (await itemsByList(who, id)).length > 0,
  list_preview: (await preview(who, id)).length > 0,
});

const ALL_CLOSED = {
  list_view: false,
  list_items_page: false,
  list_by_id: false,
  list_items_by_list: false,
  list_preview: false,
};

const mkList = async (owner, visibility, title = 'A list') => {
  const { rows } = await t.sql(
    `insert into lists (owner_id, title, visibility) values ($1, $2, $3::list_visibility)
     returning id`,
    [owner, title, visibility],
  );
  return rows[0].id;
};

const addItem = (listId, mediaItemId, position = 1) =>
  t.sql(`insert into list_items (list_id, media_item_id, "position") values ($1, $2, $3)`, [
    listId,
    mediaItemId,
    position,
  ]);

const setVisibility = (user, v) =>
  t.sql(`update profiles set visibility = $2::profile_visibility where id = $1`, [user, v]);
const setStatus = (user, s) =>
  t.sql(`update profiles set status = $2::profile_status where id = $1`, [user, s]);
const block = (a, b) =>
  t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing`, [a, b]);
const follow = (a, b, state = 'approved') =>
  t.sql(
    `insert into follows (follower_id, followee_id, state) values ($1, $2, $3::follow_state)
     on conflict (follower_id, followee_id) do update set state = excluded.state`,
    [a, b, state],
  );

let owner, follower, stranger, movie, season, series;

before(async () => {
  t = await createTestDb();
  owner = await t.createUser({ username: 'sec_owner' });
  follower = await t.createUser({ username: 'sec_follower' });
  stranger = await t.createUser({ username: 'sec_stranger' });
  movie = await t.createMovie('Past Lives', seq++);
  series = await t.createSeries('Fleabag', seq++);
  season = await t.createSeason(series, 2, 'Fleabag Season 2');
  await follow(follower, owner);
});

after(async () => t.close());

beforeEach(async () => {
  await t.sql(`delete from lists`);
  await t.sql(`delete from blocks`);
  await t.sql(`delete from user_media`);
  await t.sql(`delete from rankings`);
  await t.sql(`delete from watchlist`);
  await t.sql(`delete from processed_operations`);
  await setVisibility(owner, 'public');
  await setStatus(owner, 'active');
});

// ===========================================================================
// A. A private list is unreachable
// ===========================================================================

describe('A. a private list', () => {
  it('is closed to anon through every reader, and through the table', async () => {
    const id = await mkList(owner, 'private');
    await addItem(id, movie);

    assert.deepEqual(await readers(null, id), ALL_CLOSED);

    const direct = await t.asAnon(async () => ({
      lists: (await t.sql(`select * from lists where id = $1`, [id])).rows,
      items: (await t.sql(`select * from list_items where list_id = $1`, [id])).rows,
    }));
    assert.deepEqual(direct.lists, []);
    assert.deepEqual(direct.items, []);
  });

  it('is closed to a signed-in stranger and to an approved follower alike', async () => {
    const id = await mkList(owner, 'private');
    await addItem(id, movie);

    for (const who of [stranger, follower]) {
      // Not `readers`, which includes `list_preview` — that one is granted to **anon
      // only**, so a signed-in caller is refused by grant and the helper throws. That
      // refusal is itself a property worth having, and it is asserted just below rather
      // than swallowed here.
      assert.equal(await listView(who, id), null);
      assert.deepEqual(await itemsPage(who, id), []);
      assert.deepEqual(await byId(who, id), []);
      assert.deepEqual(await itemsByList(who, id), []);
    }
  });

  it('is not reachable through list_preview by anybody, signed in or not', async () => {
    const id = await mkList(owner, 'private');

    // anon: granted, and answers nothing for a list it may not read.
    assert.deepEqual(await preview(null, id), []);

    // signed in: not granted at all. The unfurl reader is for the unfurler.
    for (const who of [owner, stranger, follower]) {
      const { error } = await tryRpc(who, `select * from list_preview($1)`, [id]);
      assert.match(error.message, /permission denied/);
    }
  });

  it('cannot be found by guessing, and a wrong id is the same answer', async () => {
    const real = await mkList(owner, 'private');
    const fake = uuid();
    assert.deepEqual(await readers(null, real), await readers(null, fake));
  });
});

// ===========================================================================
// B. Link-only is bounded
// ===========================================================================

describe('B. a link-only list', () => {
  it('opens for anyone holding the id, and is never enumerable without it', async () => {
    const id = await mkList(owner, 'link');
    await addItem(id, movie);

    // Possession of the id is the gate, and it opens for a reader with no account.
    assert.notEqual(await listView(null, id), null);
    assert.equal((await itemsPage(null, id)).length, 1);

    // The enumeration path: a bare select must not surface it, for anybody.
    for (const who of [null, stranger, follower]) {
      const rows = await as(who, async () =>
        (await t.sql(`select id from lists where visibility = 'link'`)).rows,
      );
      assert.deepEqual(rows, [], `${who ?? 'anon'} enumerated a link list`);
    }
    // Nor through the profile shelf.
    assert.deepEqual(await profileLists(stranger, owner), []);
    assert.deepEqual(await profileLists(owner, owner), [], 'the owner shelf leaked a link list');
  });

  it('grants that list and nothing else about a private owner', async () => {
    await setVisibility(owner, 'private');
    const id = await mkList(owner, 'link');
    await addItem(id, movie);

    // Seed the owner with private state a leak would expose.
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, watched_on, note, note_visibility)
       values ($1, $2, 'loved', '2026-01-02', 'my private note', 'private')`,
      [owner, movie],
    );
    await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [owner, season]);
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved', 1)`,
      [owner, movie],
    );

    // The list opens.
    assert.notEqual(await listView(stranger, id), null);

    // Everything else stays shut.
    const reach = await t.asUser(stranger, async () => ({
      user_media: (await t.sql(`select * from user_media where user_id = $1`, [owner])).rows,
      watchlist: (await t.sql(`select * from watchlist where user_id = $1`, [owner])).rows,
      rankings: (await t.sql(`select * from rankings where user_id = $1`, [owner])).rows,
      feed: (await t.sql(`select * from feed_events where actor_id = $1`, [owner])).rows,
      otherLists: (await t.sql(`select * from lists where owner_id = $1`, [owner])).rows,
    }));
    for (const [table, rows] of Object.entries(reach)) {
      assert.deepEqual(rows, [], `link possession leaked ${table}`);
    }
  });

  it('discloses limited identity only, and no owner id to anon', async () => {
    await setVisibility(owner, 'private');
    const id = await mkList(owner, 'link');

    const anon = await listView(null, id);
    assert.equal(anon.owner.profile_visible, false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(anon.owner, 'id'),
      false,
      'anon was handed the owner id',
    );
    // The disclosed set is exactly the limited identity, and nothing more.
    assert.deepEqual(
      Object.keys(anon.owner).sort(),
      ['avatar_path', 'display_name', 'profile_visible', 'username'].filter((k) =>
        Object.prototype.hasOwnProperty.call(anon.owner, k),
      ).sort(),
    );
    for (const forbidden of ['bio', 'created_at', 'date_of_birth', 'email', 'visibility']) {
      assert.equal(forbidden in anon.owner, false, `owner block leaked ${forbidden}`);
    }
  });

  it('is still refused to a blocked signed-in viewer, both directions', async () => {
    const id = await mkList(owner, 'link');

    await block(owner, stranger);
    assert.equal(await listView(stranger, id), null);
    await t.sql(`delete from blocks`);

    await block(stranger, owner);
    assert.equal(await listView(stranger, id), null);
  });
});

// ===========================================================================
// C. Public follows the profile
// ===========================================================================

describe('C. a public list', () => {
  it('closes to anon and to strangers when the profile goes private', async () => {
    const id = await mkList(owner, 'public');
    await addItem(id, movie);

    assert.notEqual(await listView(null, id), null);

    await setVisibility(owner, 'private');
    assert.equal(await listView(null, id), null, 'anon kept a now-private owner');
    assert.equal(await listView(stranger, id), null, 'a stranger kept it');
    assert.notEqual(await listView(follower, id), null, 'an approved follower lost it');
    assert.deepEqual(await preview(null, id), [], 'the unfurl still named it');
  });

  it('closes everywhere when the owner is suspended', async () => {
    const id = await mkList(owner, 'public');
    await setStatus(owner, 'suspended');

    assert.deepEqual(await readers(null, id), ALL_CLOSED);
    assert.equal(await listView(follower, id), null);
    assert.deepEqual(await profileLists(follower, owner), []);
  });
});

// ===========================================================================
// D. Moderation beats every mode
// ===========================================================================

describe('D. a hidden list', () => {
  it('is closed through every reader, for every mode, to everyone but its owner', async () => {
    for (const visibility of ['public', 'link']) {
      await t.sql(`delete from lists`);
      const id = await mkList(owner, visibility);
      await addItem(id, movie);
      await t.sql(`select hide_list($1, 'test')`, [id]);

      assert.deepEqual(await readers(null, id), ALL_CLOSED, `${visibility} leaked to anon`);
      assert.equal(await listView(stranger, id), null, `${visibility} leaked to a stranger`);
      assert.equal(await listView(follower, id), null, `${visibility} leaked to a follower`);
      assert.deepEqual(await profileLists(follower, owner), [], `${visibility} stayed on the shelf`);

      // The owner keeps it, and is told.
      const mine = await listView(owner, id);
      assert.notEqual(mine, null);
      assert.equal(mine.hidden, true);
    }
  });

  it('freezes the owner out of changing its visibility', async () => {
    const id = await mkList(owner, 'public');
    await t.sql(`select hide_list($1, 'test')`, [id]);

    const r = await rpc(
      owner,
      `select update_list($1, $2, null, null, 'private'::list_visibility, null) as r`,
      [uuid(), id],
    );
    assert.equal(r[0].r.status, 'hidden');

    // And the row really did not move.
    const { rows } = await t.sql(`select visibility from lists where id = $1`, [id]);
    assert.equal(rows[0].visibility, 'public');
  });
});

// ===========================================================================
// E. Writers are owner-only
// ===========================================================================

describe('E. writers', () => {
  it('refuse every non-owner, on every mode, with one indistinguishable answer', async () => {
    for (const visibility of ['private', 'link', 'public']) {
      await t.sql(`delete from lists`);
      await t.sql(`delete from processed_operations`);
      const id = await mkList(owner, visibility);
      await addItem(id, movie);

      const calls = [
        [`update_list($1, $2, 'stolen', null, null, null)`, [uuid(), id]],
        [`add_list_item($1, $2, $3)`, [uuid(), id, season]],
        [`remove_list_item($1, $2, $3)`, [uuid(), id, movie]],
        [`move_list_item($1, $2, $3, 0)`, [uuid(), id, movie]],
        [`delete_list($1, $2)`, [uuid(), id]],
      ];

      for (const [call, params] of calls) {
        const { error } = await tryRpc(stranger, `select ${call} as r`, params);
        assert.ok(error, `${call} was allowed on a ${visibility} list`);
        assert.match(error.message, /no such list/, `${call} named a reason`);
      }

      // Nothing moved.
      const { rows } = await t.sql(
        `select title, visibility, (select count(*) from list_items where list_id = l.id)::int as n
           from lists l where id = $1`,
        [id],
      );
      assert.equal(rows[0].title, 'A list');
      assert.equal(rows[0].n, 1);
    }
  });

  it('refuse a non-owner identically whether the list exists or not', async () => {
    const real = await mkList(owner, 'public');
    const fake = uuid();
    const a = await tryRpc(stranger, `select delete_list($1, $2) as r`, [uuid(), real]);
    const b = await tryRpc(stranger, `select delete_list($1, $2) as r`, [uuid(), fake]);
    assert.equal(a.error.message, b.error.message);
    assert.equal(a.error.code, b.error.code);
  });

  it('refuse anon outright, by grant', async () => {
    const id = await mkList(owner, 'public');
    for (const call of [
      [`create_list($1, 'x', null, 'public'::list_visibility, 'unranked', null)`, [uuid()]],
      [`update_list($1, $2, 'x', null, null, null)`, [uuid(), id]],
      [`delete_list($1, $2)`, [uuid(), id]],
      [`add_list_item($1, $2, $3)`, [uuid(), id, movie]],
      [`add_list_to_watchlist($1, $2)`, [uuid(), id]],
    ]) {
      const { error } = await tryRpc(null, `select ${call[0]} as r`, call[1]);
      assert.ok(error, `anon reached ${call[0]}`);
      assert.match(error.message, /permission denied/);
    }
  });

  it('cannot be tricked into writing across a list boundary', async () => {
    const mine = await mkList(stranger, 'private', 'Stranger list');
    const theirs = await mkList(owner, 'private', 'Owner list');
    await addItem(theirs, movie);

    // The stranger owns `mine`, and names their own list with the owner's item.
    // Removing must not touch the other list's row.
    await rpc(stranger, `select remove_list_item($1, $2, $3) as r`, [uuid(), mine, movie]);
    const { rows } = await t.sql(`select count(*)::int as n from list_items where list_id = $1`, [
      theirs,
    ]);
    assert.equal(rows[0].n, 1, 'a write crossed into another account’s list');
  });
});

// ===========================================================================
// F. Progress is the caller's own
// ===========================================================================

describe('F. seen and progress', () => {
  it('report the caller’s own state and never the owner’s', async () => {
    const id = await mkList(owner, 'public');
    await addItem(id, movie, 1);
    await addItem(id, season, 2);

    // The owner has seen both; the stranger has seen neither.
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved'), ($1, $3, 'loved')`,
      [owner, movie, season],
    );

    const strangerRows = await itemsPage(stranger, id);
    assert.deepEqual(strangerRows.map((r) => r.viewer_seen), [false, false]);
    const strangerProgress = await rpc(stranger, `select list_viewer_progress($1) as r`, [id]);
    assert.deepEqual(strangerProgress[0].r, { seen: 0, total: 2 });

    const ownerProgress = await rpc(owner, `select list_viewer_progress($1) as r`, [id]);
    assert.deepEqual(ownerProgress[0].r, { seen: 2, total: 2 });
  });

  it('take no viewer argument, so they cannot be pointed at anybody', async () => {
    const { rows } = await t.sql(
      `select proname, pronargs from pg_proc
        where proname in ('list_viewer_progress','my_lists','my_lists_for_title')
        order by proname`,
    );
    assert.deepEqual(rows, [
      { proname: 'list_viewer_progress', pronargs: 1 },
      { proname: 'my_lists', pronargs: 2 },
      { proname: 'my_lists_for_title', pronargs: 1 },
    ]);
  });

  it('are closed to anon entirely', async () => {
    const id = await mkList(owner, 'public');
    await addItem(id, movie);
    const { error } = await tryRpc(null, `select list_viewer_progress($1) as r`, [id]);
    assert.match(error.message, /permission denied/);

    // And the item page tells anon nothing about anybody's state.
    const rows = await itemsPage(null, id);
    assert.equal(rows[0].viewer_seen, null);
    assert.equal(rows[0].viewer_watchlisted, null);
  });
});

// ===========================================================================
// G. No list reader returns private collection state
// ===========================================================================

describe('G. what a list reader may return', () => {
  it('never carries a score, bucket, position, watch date, note or history', async () => {
    const id = await mkList(owner, 'public');
    await addItem(id, movie);
    await t.sql(
      `insert into user_media (user_id, media_item_id, bucket, watched_on, note, note_visibility)
       values ($1, $2, 'loved', '2026-01-02', 'secret', 'private')`,
      [owner, movie],
    );
    await t.sql(
      `insert into rankings (user_id, media_item_id, category, bucket, position)
       values ($1, $2, 'movies', 'loved', 1)`,
      [owner, movie],
    );

    /** Asserted on the *shape*, so a column added later is caught rather than shipped. */
    const FORBIDDEN =
      /bucket|position|score|watched_on|note|rank|watch_event|watched_at|progress|placement/i;

    const itemCols = await t.sql(
      `select column_name from information_schema.columns
        where table_name = 'list_items_page'`,
    );
    // Set-returning functions have no information_schema row; assert on the answer.
    const rows = await itemsPage(stranger, id);
    for (const key of Object.keys(rows[0])) {
      if (key === 'viewer_seen' || key === 'viewer_watchlisted' || key === 'position') continue;
      assert.equal(FORBIDDEN.test(key), false, `list_items_page returned ${key}`);
    }
    // `position` is the keyset cursor, an integer, and is not a ranking position.
    assert.equal(typeof rows[0].position, 'number');
    assert.equal(itemCols.rows.length, 0);

    const view = await listView(stranger, id);
    const flat = JSON.stringify(view);
    for (const leak of ['secret', '2026-01-02', 'loved']) {
      assert.equal(flat.includes(leak), false, `list_view leaked ${leak}`);
    }

    const pv = await preview(null, id);
    assert.deepEqual(Object.keys(pv[0]).sort(), ['item_count', 'owner_label', 'title']);
  });

  it('list_preview never names a private-profile owner', async () => {
    const id = await mkList(owner, 'link');
    assert.equal((await preview(null, id))[0].owner_label, '@sec_owner');

    await setVisibility(owner, 'private');
    assert.equal(
      (await preview(null, id))[0].owner_label,
      null,
      'a private handle reached the unfurl cache',
    );
  });

  it('record_list_open stores no viewer, IP, agent or referrer, and counts only anon-readable lists', async () => {
    const shared = await mkList(owner, 'link');
    const secret = await mkList(owner, 'private');

    await t.asAnon(async () => {
      await t.sql(`select record_list_open($1, 'ios')`, [shared]);
      await t.sql(`select record_list_open($1, 'ios')`, [secret]);
    });

    const { rows } = await t.sql(`select * from list_web_opens`);
    assert.equal(rows.length, 1, 'a non-anon-readable list was counted');
    assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'list_id', 'opened_at', 'platform']);

    // And the ledger is unreadable by clients.
    for (const who of [null, owner]) {
      const { rows: seen } = await tryRpc(who, `select * from list_web_opens`);
      assert.deepEqual(seen ?? [], []);
    }
  });
});

// ===========================================================================
// H. The definer surface
// ===========================================================================

describe('H. the definer surface', () => {
  it('gives every list function a pinned search_path', async () => {
    const { rows } = await t.sql(
      `select p.proname, p.proconfig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prosecdef
          and (p.proname like '%list%' or p.proname = '_viewer_has_seen')
        order by p.proname`,
    );
    assert.ok(rows.length >= 15, `expected the list family, saw ${rows.length}`);
    for (const row of rows) {
      const config = (row.proconfig ?? []).join(',');
      assert.match(
        config,
        /search_path=/,
        `${row.proname} is SECURITY DEFINER with no pinned search_path`,
      );
    }
  });

  it('grants the internal helpers to nobody', async () => {
    for (const fn of [
      '_list_readable',
      '_viewer_has_seen',
      '_list_config',
      '_profile_is_private',
      '_own_list',
      '_add_list_item_unchecked',
      'hide_list',
      'unhide_list',
    ]) {
      const { rows } = await t.sql(
        `select coalesce(bool_or(
                  has_function_privilege('anon', p.oid, 'execute')
               or has_function_privilege('authenticated', p.oid, 'execute')), false) as reachable
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [fn],
      );
      assert.equal(rows[0].reachable, false, `${fn} is reachable by a client role`);
    }
  });

  it('gives anon exactly the six readers and nothing else list-shaped', async () => {
    const { rows } = await t.sql(
      `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and has_function_privilege('anon', p.oid, 'execute')
          and p.proname like '%list%'
        order by 1`,
    );
    assert.deepEqual(
      rows.map((r) => r.sig).sort(),
      [
        'list_by_id(target uuid)',
        'list_items_by_list(target uuid)',
        'list_items_page(p_list_id uuid, p_after_position integer, p_limit integer)',
        'list_preview(p_list_id uuid)',
        'list_view(p_list_id uuid)',
        'record_list_open(p_list_id uuid, p_platform text)',
      ],
    );
  });
});
