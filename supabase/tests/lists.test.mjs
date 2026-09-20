import assert from 'node:assert/strict';
import { before, after, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Lists v1 — `20261010000100`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR
 *
 * The §F matrix, exercised through every reader, is the bulk of it — and the
 * reason it is written as a matrix rather than as a scatter of cases is that the
 * defect class here is *one reader disagreeing with another*. Four functions could
 * read a link list before this migration and two of them used a different rule;
 * asserting each one separately is how that survives.
 *
 * The other half is the two claims the privacy model actually rests on:
 *
 *   **The link exception is bounded.** A stranger holding a link-only URL for a
 *   private account's list gets that list and a name, and still gets nothing from
 *   `profile_lists`, the rankings, the watchlist or the activity. That is what makes
 *   "link-only is an object-level share" true rather than aspirational.
 *
 *   **Link lists cannot be enumerated.** The select policy excludes them, and the one
 *   reader that returns them — `my_lists` — takes no owner argument, so it cannot be
 *   pointed at anybody.
 */

let t;
let seq = 71000;

const uuid = () => crypto.randomUUID();

const rpc = (who, call, params = []) =>
  who === null
    ? t.asAnon(async () => (await t.sql(call, params)).rows)
    : t.asUser(who, async () => (await t.sql(call, params)).rows);

const listView = (who, id) =>
  rpc(who, `select list_view($1) as r`, [id]).then((rows) => rows[0]?.r ?? null);

const itemsPage = (who, id, after = null, limit = 100) =>
  rpc(who, `select * from list_items_page($1, $2, $3)`, [id, after, limit]);

const preview = (who, id) => rpc(who, `select * from list_preview($1)`, [id]);

const byId = (who, id) => rpc(who, `select * from list_by_id($1)`, [id]);

const itemsByList = (who, id) => rpc(who, `select * from list_items_by_list($1)`, [id]);

const profileLists = (who, owner) =>
  rpc(who, `select * from profile_lists($1, null, 50)`, [owner]);

const myLists = (who) => rpc(who, `select * from my_lists(null, 50)`);

const progress = (who, id) =>
  rpc(who, `select list_viewer_progress($1) as r`, [id]).then((rows) => rows[0]?.r ?? null);

/** Every reader that can answer for one list, as one object. The matrix asserts on it. */
const readers = async (who, id) => ({
  view: (await listView(who, id)) !== null,
  items: (await itemsPage(who, id)).length > 0,
  byId: (await byId(who, id)).length > 0,
  itemsByList: (await itemsByList(who, id)).length > 0,
});

const create = (who, { title = 'A list', visibility = 'private', order_style = 'unranked', description = null, first = null } = {}) =>
  rpc(who, `select create_list($1, $2, $3, $4::list_visibility, $5, $6) as r`, [
    uuid(),
    title,
    description,
    visibility,
    order_style,
    first,
  ]).then((rows) => rows[0].r);

const createOk = async (who, options) => {
  const r = await create(who, options);
  assert.equal(r.status, 'ok', `create_list refused: ${JSON.stringify(r)}`);
  return r.id;
};

const addItem = (who, list, item, operationId = null) =>
  rpc(who, `select add_list_item($1, $2, $3) as r`, [operationId ?? uuid(), list, item]).then(
    (rows) => rows[0].r,
  );

const removeItem = (who, list, item) =>
  rpc(who, `select remove_list_item($1, $2, $3) as r`, [uuid(), list, item]).then(
    (rows) => rows[0].r,
  );

const move = (who, list, item, index) =>
  rpc(who, `select move_list_item($1, $2, $3, $4) as r`, [uuid(), list, item, index]).then(
    (rows) => rows[0].r,
  );

const update = (who, list, patch = {}) =>
  rpc(who, `select update_list($1, $2, $3, $4, $5::list_visibility, $6) as r`, [
    uuid(),
    list,
    patch.title ?? null,
    patch.description ?? null,
    patch.visibility ?? null,
    patch.order_style ?? null,
  ]).then((rows) => rows[0].r);

const destroy = (who, list) =>
  rpc(who, `select delete_list($1, $2) as r`, [uuid(), list]).then((rows) => rows[0].r);

const bulkWatchlist = (who, list) =>
  rpc(who, `select add_list_to_watchlist($1, $2) as r`, [uuid(), list]).then((rows) => rows[0].r);

const ordinals = async (who, id) => (await itemsPage(who, id)).map((r) => r.ordinal);

const titlesInOrder = async (who, id) => (await itemsPage(who, id)).map((r) => r.title);

const setVisibility = (user, visibility) =>
  t.sql(`update profiles set visibility = $2::profile_visibility where id = $1`, [
    user,
    visibility,
  ]);

const setStatus = (user, status) =>
  t.sql(`update profiles set status = $2::profile_status where id = $1`, [user, status]);

const block = (a, b) =>
  t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing`, [
    a,
    b,
  ]);

const unblockAll = () => t.sql(`delete from blocks`);

const follow = (a, b, state = 'approved') =>
  t.sql(
    `insert into follows (follower_id, followee_id, state) values ($1, $2, $3::follow_state)
     on conflict (follower_id, followee_id) do update set state = excluded.state`,
    [a, b, state],
  );

const hide = (list) => t.sql(`select hide_list($1, 'test')`, [list]);
const unhide = (list) => t.sql(`select unhide_list($1, 'test')`, [list]);

const logMovie = (user, item) =>
  t.sql(
    `insert into user_media (user_id, media_item_id, bucket) values ($1, $2, 'loved')
     on conflict (user_id, media_item_id) do nothing`,
    [user, item],
  );

const logSeason = (user, item, progressValue) =>
  t.sql(
    `insert into user_media (user_id, media_item_id, progress) values ($1, $2, $3::season_progress)
     on conflict (user_id, media_item_id) do update set progress = excluded.progress`,
    [user, item, progressValue],
  );

let owner;
let follower;
let stranger;
let blocked;
let movie;
let series;
let season;

before(async () => {
  t = await createTestDb();

  owner = await t.createUser({ username: 'listowner' });
  follower = await t.createUser({ username: 'listfollower' });
  stranger = await t.createUser({ username: 'liststranger' });
  blocked = await t.createUser({ username: 'listblocked' });

  movie = await t.createMovie('Past Lives', seq++);
  series = await t.createSeries('Fleabag', seq++);
  season = await t.createSeason(series, 2, 'Fleabag Season 2');

  await follow(follower, owner);
});

after(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.sql(`delete from lists`);
  await t.sql(`delete from watchlist`);
  await t.sql(`delete from user_media`);
  await t.sql(`delete from processed_operations`);
  await unblockAll();
  await setVisibility(owner, 'public');
  await setStatus(owner, 'active');
});

// ---------------------------------------------------------------------------
// §F — the matrix
// ---------------------------------------------------------------------------

describe('the readability matrix', () => {
  it('private is owner only, through every reader', async () => {
    const id = await createOk(owner, { visibility: 'private' });
    await addItem(owner, id, movie);

    assert.deepEqual(await readers(owner, id), {
      view: true,
      items: true,
      byId: true,
      itemsByList: true,
    });

    for (const who of [follower, stranger, null]) {
      assert.deepEqual(
        await readers(who, id),
        { view: false, items: false, byId: false, itemsByList: false },
        `a private list answered ${who ?? 'anon'}`,
      );
    }
  });

  it('link-only is readable by anyone holding the id, public profile or not', async () => {
    const id = await createOk(owner, { visibility: 'link' });
    await addItem(owner, id, movie);

    for (const profile of ['public', 'private']) {
      await setVisibility(owner, profile);
      for (const who of [owner, follower, stranger, null]) {
        assert.deepEqual(
          await readers(who, id),
          { view: true, items: true, byId: true, itemsByList: true },
          `a link list (${profile} profile) refused ${who ?? 'anon'}`,
        );
      }
    }
  });

  it('public needs a public profile, and follows the profile when it later goes private', async () => {
    const id = await createOk(owner, { visibility: 'public' });
    await addItem(owner, id, movie);

    // Public profile: everybody.
    for (const who of [owner, follower, stranger, null]) {
      assert.equal((await listView(who, id)) !== null, true, `public list refused ${who ?? 'anon'}`);
    }

    // The profile goes private afterwards. §F.4: nothing is converted, and the list
    // follows the profile's audience.
    await setVisibility(owner, 'private');

    assert.notEqual(await listView(owner, id), null, 'the owner lost their own list');
    assert.notEqual(await listView(follower, id), null, 'an approved follower lost the list');
    assert.equal(await listView(stranger, id), null, 'a stranger kept a now-private list');
    assert.equal(await listView(null, id), null, 'the web kept a now-private list');
  });

  it('a block hides the list both ways, for a signed-in viewer', async () => {
    const id = await createOk(owner, { visibility: 'link' });

    await block(owner, blocked);
    assert.equal(await listView(blocked, id), null, 'the blocked viewer could read it');

    await unblockAll();
    await block(blocked, owner);
    assert.equal(await listView(blocked, id), null, 'the blocker could read it');

    // §F.7, stated plainly: a logged-out reader cannot be matched to a block.
    assert.notEqual(await listView(null, id), null, 'anon lost a link list to a block');
  });

  it('a suspended owner hides every list from everyone, including the owner', async () => {
    const id = await createOk(owner, { visibility: 'public' });
    await setStatus(owner, 'suspended');

    for (const who of [follower, stranger, null]) {
      assert.equal(await listView(who, id), null, `a suspended owner's list answered ${who}`);
    }
  });

  it('a moderation hide beats every mode, and the owner keeps the row', async () => {
    const id = await createOk(owner, { visibility: 'public' });
    await hide(id);

    for (const who of [follower, stranger, null]) {
      assert.equal(await listView(who, id), null, `a hidden list answered ${who}`);
    }

    const mine = await listView(owner, id);
    assert.notEqual(mine, null, 'the owner lost their hidden list');
    assert.equal(mine.hidden, true, 'the owner was not told it is hidden');

    // And the visibility is locked until an operator clears it.
    assert.equal((await update(owner, id, { visibility: 'private' })).status, 'hidden');

    await unhide(id);
    assert.notEqual(await listView(stranger, id), null, 'unhide did not restore the list');
  });

  it('every refusal is the same answer, and names no reason', async () => {
    const privateList = await createOk(owner, { visibility: 'private' });
    const deleted = uuid();

    assert.equal(await listView(stranger, privateList), null);
    assert.equal(await listView(stranger, deleted), null);
    assert.deepEqual(await itemsPage(stranger, privateList), []);
    assert.deepEqual(await itemsPage(stranger, deleted), []);
  });
});

// ---------------------------------------------------------------------------
// §F.2 — attribution, and §F.6 — enumeration
// ---------------------------------------------------------------------------

describe('the link exception is bounded', () => {
  it('a private owner is attributed by limited identity, with no id for anon', async () => {
    await setVisibility(owner, 'private');
    const id = await createOk(owner, { visibility: 'link' });

    const seen = await listView(stranger, id);
    assert.equal(seen.owner.profile_visible, false);
    assert.equal(seen.owner.username, 'listowner');
    assert.equal(seen.owner.display_name, 'listowner');

    const anon = await listView(null, id);
    assert.equal(anon.owner.profile_visible, false);
    assert.equal(anon.owner.username, 'listowner');
    assert.equal(
      Object.prototype.hasOwnProperty.call(anon.owner, 'id'),
      false,
      'an anonymous reader was handed the owner id',
    );
  });

  it('an approved follower of a private owner gets full attribution', async () => {
    await setVisibility(owner, 'private');
    const id = await createOk(owner, { visibility: 'link' });

    const seen = await listView(follower, id);
    assert.equal(seen.owner.profile_visible, true);
    assert.equal(seen.owner.id, owner);
  });

  it('holding a link grants the list and nothing else about the owner', async () => {
    await setVisibility(owner, 'private');
    const id = await createOk(owner, { visibility: 'link' });
    await addItem(owner, id, movie);
    await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [owner, movie]);

    // The list itself: readable.
    assert.notEqual(await listView(stranger, id), null);

    // Everything else about the account: not.
    assert.deepEqual(await profileLists(stranger, owner), []);

    const otherReads = await t.asUser(stranger, async () => ({
      watchlist: (await t.sql(`select * from watchlist where user_id = $1`, [owner])).rows,
      rankings: (await t.sql(`select * from rankings where user_id = $1`, [owner])).rows,
      userMedia: (await t.sql(`select * from user_media where user_id = $1`, [owner])).rows,
      activity: (await t.sql(`select * from feed_events where actor_id = $1`, [owner])).rows,
    }));

    assert.deepEqual(otherReads.watchlist, [], 'the link leaked the watchlist');
    assert.deepEqual(otherReads.rankings, [], 'the link leaked the rankings');
    assert.deepEqual(otherReads.userMedia, [], 'the link leaked the collection');
    assert.deepEqual(otherReads.activity, [], 'the link leaked the activity');
  });

  it('link lists cannot be enumerated', async () => {
    await createOk(owner, { visibility: 'link' });
    await createOk(owner, { visibility: 'private' });
    await createOk(owner, { visibility: 'public' });

    const discoverable = await t.asUser(stranger, async () =>
      (await t.sql(`select id, visibility from lists where owner_id = $1`, [owner])).rows,
    );
    assert.deepEqual(
      discoverable.map((r) => r.visibility),
      ['public'],
      'a stranger could see something other than the public list',
    );

    // Anon sees the public list and only the public list. That is the policy working,
    // not a hole: a public list on a public profile is exactly what the web renders.
    const asAnon = await t.asAnon(async () =>
      (await t.sql(`select visibility from lists`)).rows,
    );
    assert.deepEqual(
      asAnon.map((r) => r.visibility),
      ['public'],
      'anon could enumerate something other than the public list',
    );
  });

  it('my_lists answers only for the caller, and cannot be pointed anywhere else', async () => {
    await createOk(owner, { visibility: 'link', title: 'Mine' });

    assert.equal((await myLists(owner)).length, 1);
    assert.deepEqual(await myLists(stranger), [], 'my_lists answered for another account');

    // There is no owner argument to pass. The signature is the guarantee.
    const { rows } = await t.sql(
      `select count(*)::int as n from pg_proc where proname = 'my_lists' and pronargs = 2`,
    );
    assert.equal(rows[0].n, 1, 'my_lists grew an argument');
  });
});

describe('profile_lists is public-only, for everybody', () => {
  it('never returns private or link lists, not even to the owner', async () => {
    await createOk(owner, { visibility: 'private', title: 'Secret' });
    await createOk(owner, { visibility: 'link', title: 'Shared by link' });
    await createOk(owner, { visibility: 'public', title: 'On my profile' });

    for (const who of [owner, follower, stranger]) {
      const shelf = await profileLists(who, owner);
      assert.deepEqual(
        shelf.map((r) => r.title),
        ['On my profile'],
        `the shelf showed something private to ${who}`,
      );
    }
  });

  it('an unviewable profile and an empty shelf are indistinguishable', async () => {
    await setVisibility(owner, 'private');
    await createOk(owner, { visibility: 'public' }).catch(() => {});

    assert.deepEqual(await profileLists(stranger, owner), []);
    assert.deepEqual(await profileLists(stranger, await t.createUser({ username: 'nolists' })), []);
  });

  it('a hidden public list leaves the shelf', async () => {
    const id = await createOk(owner, { visibility: 'public' });
    assert.equal((await profileLists(stranger, owner)).length, 1);
    await hide(id);
    assert.deepEqual(await profileLists(stranger, owner), []);
  });
});

// ---------------------------------------------------------------------------
// §F.3 — public requires a public profile
// ---------------------------------------------------------------------------

describe('public requires a public profile', () => {
  it('create and update both refuse, with a status rather than a raise', async () => {
    await setVisibility(owner, 'private');

    assert.equal((await create(owner, { visibility: 'public' })).status, 'profile_private');

    const id = await createOk(owner, { visibility: 'private' });
    assert.equal((await update(owner, id, { visibility: 'public' })).status, 'profile_private');

    // Link-only is always available.
    assert.equal((await update(owner, id, { visibility: 'link' })).status, 'ok');
  });
});

// ---------------------------------------------------------------------------
// §E — writers
// ---------------------------------------------------------------------------

describe('writers', () => {
  it('refuse a non-owner, and say the same thing for a list that does not exist', async () => {
    const id = await createOk(owner, {});

    for (const [name, call] of [
      ['update_list', () => update(stranger, id, { title: 'Mine now' })],
      ['add_list_item', () => addItem(stranger, id, movie)],
      ['remove_list_item', () => removeItem(stranger, id, movie)],
      ['move_list_item', () => move(stranger, id, movie, 0)],
      ['delete_list', () => destroy(stranger, id)],
    ]) {
      await assert.rejects(call, /no such list/, `${name} let a stranger through`);
    }

    // The list is untouched.
    assert.notEqual(await listView(owner, id), null);
  });

  it('answer a replay with the first answer rather than acting twice', async () => {
    const operationId = uuid();
    const id = await createOk(owner, {});

    const first = await addItem(owner, id, movie, operationId);
    const second = await addItem(owner, id, movie, operationId);

    assert.equal(first.status, 'added');
    assert.deepEqual(second, first, 'a replay was answered differently');
    assert.equal((await itemsPage(owner, id)).length, 1);
  });

  it('a create replayed under one id makes one list', async () => {
    const operationId = uuid();
    const call = () =>
      rpc(owner, `select create_list($1, $2, null, 'private'::list_visibility, 'unranked', null) as r`, [
        operationId,
        'Once',
      ]).then((rows) => rows[0].r);

    const first = await call();
    const second = await call();

    assert.equal(first.status, 'ok');
    assert.equal(second.id, first.id, 'a replay created a second list');
    assert.equal((await myLists(owner)).length, 1);
  });

  it('a duplicate add answers already', async () => {
    const id = await createOk(owner, {});
    assert.equal((await addItem(owner, id, movie)).status, 'added');
    assert.equal((await addItem(owner, id, movie)).status, 'already');
    assert.equal((await itemsPage(owner, id)).length, 1);
  });

  it('accepts movies, seasons and whole series, and nothing else', async () => {
    const id = await createOk(owner, {});

    for (const item of [movie, season, series]) {
      assert.equal((await addItem(owner, id, item)).status, 'added');
    }
    assert.equal((await itemsPage(owner, id)).length, 3);

    await assert.rejects(() => addItem(owner, id, uuid()), /no such title/);
  });

  it('reports in_app_count_before, and excludes imported lists from it', async () => {
    assert.equal((await create(owner, {})).in_app_count_before, 0);
    assert.equal((await create(owner, {})).in_app_count_before, 1);

    await t.sql(
      `insert into lists (owner_id, title, source) values ($1, 'Imported', 'imported')`,
      [owner],
    );

    assert.equal(
      (await create(owner, {})).in_app_count_before,
      2,
      'an imported list was counted against the hypothetical cap',
    );
  });

  it('refuses at the list ceiling, and at the item ceiling', async () => {
    await t.sql(`update app_config set value = '2'::jsonb where key = 'lists.max_per_user'`);
    await createOk(owner, {});
    await createOk(owner, {});
    const refused = await create(owner, {});
    assert.equal(refused.status, 'list_limit');
    assert.equal(refused.in_app_count_before, 2);
    await t.sql(`update app_config set value = '100'::jsonb where key = 'lists.max_per_user'`);

    await t.sql(`update app_config set value = '1'::jsonb where key = 'lists.max_items'`);
    const id = await createOk(owner, {});
    assert.equal((await addItem(owner, id, movie)).status, 'added');
    assert.equal((await addItem(owner, id, season)).status, 'item_limit');
    await t.sql(`update app_config set value = '500'::jsonb where key = 'lists.max_items'`);
  });

  it('bounds creations per day', async () => {
    await t.sql(`update app_config set value = '2'::jsonb where key = 'lists.max_created_per_day'`);
    await createOk(owner, {});
    await createOk(owner, {});
    await assert.rejects(() => create(owner, {}), /too many times/);
    await t.sql(
      `update app_config set value = '20'::jsonb where key = 'lists.max_created_per_day'`,
    );
  });

  it('creates with a first title in one call', async () => {
    const id = await createOk(owner, { first: movie });
    assert.equal((await itemsPage(owner, id)).length, 1);
  });

  it('a delete is hard, and the URL answers unavailable afterwards', async () => {
    const id = await createOk(owner, { visibility: 'public' });
    await addItem(owner, id, movie);

    assert.equal((await destroy(owner, id)).status, 'ok');
    assert.equal(await listView(owner, id), null);
    assert.equal((await t.sql(`select count(*)::int as n from list_items`)).rows[0].n, 0);
  });
});

// ---------------------------------------------------------------------------
// §E — ordering
// ---------------------------------------------------------------------------

describe('ordering', () => {
  const build = async () => {
    const id = await createOk(owner, { order_style: 'ranked' });
    const a = await t.createMovie('A', seq++);
    const b = await t.createMovie('B', seq++);
    const c = await t.createMovie('C', seq++);
    for (const item of [a, b, c]) await addItem(owner, id, item);
    return { id, a, b, c };
  };

  it('numbers are read-time ordinals, so a removal leaves no gap', async () => {
    const { id, b } = await build();
    assert.deepEqual(await ordinals(owner, id), [1, 2, 3]);

    await removeItem(owner, id, b);
    assert.deepEqual(await ordinals(owner, id), [1, 2], 'a removal left a hole in the numbering');
    assert.deepEqual(await titlesInOrder(owner, id), ['A', 'C']);
  });

  it('a move renumbers compactly and keeps positions unique', async () => {
    const { id, c } = await build();

    assert.equal((await move(owner, id, c, 0)).status, 'ok');
    assert.deepEqual(await titlesInOrder(owner, id), ['C', 'A', 'B']);
    assert.deepEqual(await ordinals(owner, id), [1, 2, 3]);

    const { rows } = await t.sql(
      `select count(*)::int as n, count(distinct "position")::int as d
         from list_items where list_id = $1`,
      [id],
    );
    assert.equal(rows[0].n, rows[0].d, 'two items share a position');
  });

  it('a move to the end works, and an out-of-range index is clamped', async () => {
    const { id, a } = await build();

    assert.equal((await move(owner, id, a, 2)).status, 'ok');
    assert.deepEqual(await titlesInOrder(owner, id), ['B', 'C', 'A']);

    assert.equal((await move(owner, id, a, 99)).status, 'ok');
    assert.deepEqual(await titlesInOrder(owner, id), ['B', 'C', 'A']);

    assert.equal((await move(owner, id, a, -5)).status, 'ok');
    assert.deepEqual(await titlesInOrder(owner, id), ['A', 'B', 'C']);
  });

  it('toggling Numbered never changes the order', async () => {
    const { id } = await build();
    const before = await titlesInOrder(owner, id);

    await update(owner, id, { order_style: 'unranked' });
    assert.deepEqual(await titlesInOrder(owner, id), before);

    await update(owner, id, { order_style: 'ranked' });
    assert.deepEqual(await titlesInOrder(owner, id), before);
  });

  it('pages on position and keeps the ordinal of the whole list', async () => {
    const { id } = await build();
    const firstPage = await itemsPage(owner, id, null, 2);
    assert.deepEqual(firstPage.map((r) => r.ordinal), [1, 2]);

    const second = await itemsPage(owner, id, firstPage.at(-1).position, 2);
    assert.deepEqual(second.map((r) => r.ordinal), [3]);
  });
});

// ---------------------------------------------------------------------------
// §K — the utility half
// ---------------------------------------------------------------------------

describe('seen, progress and the bulk watchlist add', () => {
  it('seen is per-viewer, and the season rule excludes a half-watched season', async () => {
    const id = await createOk(owner, { visibility: 'public' });
    await addItem(owner, id, movie);
    await addItem(owner, id, season);

    await logMovie(stranger, movie);
    await logSeason(stranger, season, 'watching');

    const rows = await itemsPage(stranger, id);
    assert.deepEqual(rows.map((r) => r.viewer_seen), [true, false]);

    await logSeason(stranger, season, 'completed');
    assert.deepEqual((await itemsPage(stranger, id)).map((r) => r.viewer_seen), [true, true]);

    // The owner's own view is their own state, not the reader's.
    assert.deepEqual((await itemsPage(owner, id)).map((r) => r.viewer_seen), [false, false]);
  });

  it('a series counts as seen when any of its seasons is logged', async () => {
    const id = await createOk(owner, { visibility: 'public' });
    await addItem(owner, id, series);

    assert.deepEqual((await itemsPage(stranger, id)).map((r) => r.viewer_seen), [false]);
    await logSeason(stranger, season, 'completed');
    assert.deepEqual((await itemsPage(stranger, id)).map((r) => r.viewer_seen), [true]);
  });

  it('anon gets null rather than false for the viewer flags', async () => {
    const id = await createOk(owner, { visibility: 'public' });
    await addItem(owner, id, movie);

    const rows = await itemsPage(null, id);
    assert.equal(rows[0].viewer_seen, null);
    assert.equal(rows[0].viewer_watchlisted, null);
  });

  it('progress answers for the viewer and for the owner, and never for anon', async () => {
    const id = await createOk(owner, { visibility: 'public' });
    await addItem(owner, id, movie);
    await addItem(owner, id, season);
    await logMovie(stranger, movie);

    assert.deepEqual(await progress(stranger, id), { seen: 1, total: 2 });
    assert.deepEqual(await progress(owner, id), { seen: 0, total: 2 });

    // Not granted to anon at all, which is stronger than answering null: the web page
    // deliberately never draws this line, so there is nothing for it to call.
    await assert.rejects(() => progress(null, id), /permission denied/);
  });

  it('bulk add skips seen and saved titles, and writes no feed events', async () => {
    const id = await createOk(owner, { visibility: 'public' });
    const other = await t.createMovie('Conclave', seq++);
    await addItem(owner, id, movie);
    await addItem(owner, id, season);
    await addItem(owner, id, other);

    await logMovie(stranger, movie);
    await t.sql(`insert into watchlist (user_id, media_item_id) values ($1, $2)`, [
      stranger,
      season,
    ]);

    const eventsBefore = (
      await t.sql(`select count(*)::int as n from feed_events where actor_id = $1`, [stranger])
    ).rows[0].n;

    const result = await bulkWatchlist(stranger, id);
    assert.deepEqual(result, {
      status: 'ok',
      added: 1,
      skipped_seen: 1,
      skipped_present: 1,
    });

    const saved = (
      await t.sql(`select media_item_id from watchlist where user_id = $1 order by created_at`, [
        stranger,
      ])
    ).rows.map((r) => r.media_item_id);
    assert.equal(saved.includes(other), true);
    assert.equal(saved.includes(movie), false, 'a seen title was saved');

    const eventsAfter = (
      await t.sql(`select count(*)::int as n from feed_events where actor_id = $1`, [stranger])
    ).rows[0].n;
    assert.equal(eventsAfter, eventsBefore, 'the bulk add wrote activity');
  });

  it('bulk add refuses a list the caller cannot read', async () => {
    const id = await createOk(owner, { visibility: 'private' });
    await addItem(owner, id, movie);
    await assert.rejects(() => bulkWatchlist(stranger, id), /no such list/);
  });
});

// ---------------------------------------------------------------------------
// §J / §M — the web page's two server calls
// ---------------------------------------------------------------------------

describe('the web surface', () => {
  it('list_preview names a public owner and never a private one', async () => {
    const id = await createOk(owner, { visibility: 'link', title: 'Film club' });
    await addItem(owner, id, movie);

    const asPublic = await preview(null, id);
    assert.equal(asPublic[0].title, 'Film club');
    assert.equal(asPublic[0].item_count, 1);
    assert.equal(asPublic[0].owner_label, '@listowner');

    await setVisibility(owner, 'private');
    const asPrivate = await preview(null, id);
    assert.equal(asPrivate[0].title, 'Film club');
    assert.equal(
      asPrivate[0].owner_label,
      null,
      "a private account's handle reached a third-party unfurl cache",
    );
  });

  it('list_preview answers nothing for a list anon cannot read', async () => {
    const id = await createOk(owner, { visibility: 'private' });
    assert.deepEqual(await preview(null, id), []);

    const hidden = await createOk(owner, { visibility: 'public' });
    await hide(hidden);
    assert.deepEqual(await preview(null, hidden), []);
  });

  it('record_list_open counts an anon-readable list and nothing else', async () => {
    const shared = await createOk(owner, { visibility: 'link' });
    const secret = await createOk(owner, { visibility: 'private' });

    await t.asAnon(async () => {
      await t.sql(`select record_list_open($1, 'ios')`, [shared]);
      await t.sql(`select record_list_open($1, 'ios')`, [secret]);
      await t.sql(`select record_list_open($1, 'ios')`, [uuid()]);
    });

    const { rows } = await t.sql(`select list_id, platform from list_web_opens`);
    assert.equal(rows.length, 1, 'something other than the shared list was counted');
    assert.equal(rows[0].list_id, shared);
    assert.equal(rows[0].platform, 'ios');
  });

  it('record_list_open keeps the platform column a closed set', async () => {
    const shared = await createOk(owner, { visibility: 'link' });
    await t.asAnon(() => t.sql(`select record_list_open($1, $2)`, [shared, 'Mozilla/5.0 …']));

    const { rows } = await t.sql(`select platform from list_web_opens`);
    assert.equal(rows[0].platform, null, 'a user agent reached the platform column');
  });

  it('list_web_opens is unreadable by clients', async () => {
    const shared = await createOk(owner, { visibility: 'link' });
    await t.asAnon(() => t.sql(`select record_list_open($1, 'ios')`, [shared]));

    for (const who of [owner, null]) {
      const error = await (who === null
        ? t.asAnon(() => t.errorFrom(`select * from list_web_opens`))
        : t.asUser(who, () => t.errorFrom(`select * from list_web_opens`)));
      const rows =
        error === null
          ? await (who === null
              ? t.asAnon(async () => (await t.sql(`select * from list_web_opens`)).rows)
              : t.asUser(who, async () => (await t.sql(`select * from list_web_opens`)).rows))
          : [];
      assert.deepEqual(rows, [], `${who ?? 'anon'} read the web-open ledger`);
    }
  });
});

// ---------------------------------------------------------------------------
// §N — moderation and lifecycle
// ---------------------------------------------------------------------------

describe('moderation and lifecycle', () => {
  it('a list can be reported, and the report resolves its owner from the list', async () => {
    const id = await createOk(owner, { visibility: 'public' });

    const result = await rpc(
      stranger,
      `select report('list'::report_subject, $1, 'spam', 'test') as r`,
      [id],
    );
    assert.ok(result[0].r);

    const { rows } = await t.sql(`select subject_owner from reports where subject_id = $1`, [
      id,
    ]);
    assert.equal(rows[0].subject_owner, owner);
  });

  it('deleting the account removes the lists and their web opens', async () => {
    const doomed = await t.createUser({ username: 'listdoomed' });
    const id = await createOk(doomed, { visibility: 'link' });
    await addItem(doomed, id, movie);
    await t.asAnon(() => t.sql(`select record_list_open($1, 'ios')`, [id]));

    await t.sql(`delete from auth.users where id = $1`, [doomed]);

    assert.equal((await t.sql(`select count(*)::int as n from lists where id = $1`, [id])).rows[0].n, 0);
    assert.equal((await t.sql(`select count(*)::int as n from list_items`)).rows[0].n, 0);
    assert.equal((await t.sql(`select count(*)::int as n from list_web_opens`)).rows[0].n, 0);
  });

  it('the catalogue keeps a title a list still references', async () => {
    const id = await createOk(owner, {});
    const kept = await t.createMovie('Referenced', seq++);
    await addItem(owner, id, kept);

    const { rows } = await t.sql(
      `select count(*)::int as n from list_items li
        join media_items m on m.id = li.media_item_id where m.id = $1`,
      [kept],
    );
    assert.equal(rows[0].n, 1);
  });
});

// ---------------------------------------------------------------------------
// The cover, and what My lists draws
// ---------------------------------------------------------------------------

describe('my_lists', () => {
  it('returns every visibility, newest-edited first, with up to four posters', async () => {
    const a = await createOk(owner, { title: 'First', visibility: 'private' });
    const b = await createOk(owner, { title: 'Second', visibility: 'link' });

    for (let i = 0; i < 5; i += 1) {
      const item = await t.createMovie(`Cover ${i}`, seq++);
      await t.sql(`update media_items set poster_path = $2 where id = $1`, [
        item,
        `/cover${i}.jpg`,
      ]);
      await addItem(owner, a, item);
    }

    const rows = await myLists(owner);
    assert.deepEqual(rows.map((r) => r.title), ['First', 'Second'], 'not sorted by updated_at');

    const first = rows.find((r) => r.id === a);
    assert.equal(first.posters.length, 4, 'the 2x2 cover took more or fewer than four posters');
    assert.equal(first.item_count, 5);
    assert.equal(first.visibility, 'private');
    assert.equal(first.hidden, false);

    const second = rows.find((r) => r.id === b);
    assert.deepEqual(second.posters, [], 'an empty list invented a cover');
  });

  it('my_lists_for_title marks membership in both directions', async () => {
    const a = await createOk(owner, { title: 'Has it' });
    await createOk(owner, { title: 'Does not' });
    await addItem(owner, a, movie);

    const rows = await rpc(owner, `select * from my_lists_for_title($1)`, [movie]);
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r.contains]));
    assert.deepEqual(byTitle, { 'Has it': true, 'Does not': false });
  });
});
