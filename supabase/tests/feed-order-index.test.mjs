import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * **A Feed read in its own order** (20261130000600).
 *
 * `feed_events_feed_order` is `(causal_at desc, causal_step desc, id)`, the Feed's sort key,
 * so a page can walk events newest-first and stop at its limit instead of sorting the whole
 * history of everyone the reader follows. docs/ops/feed-latency-2026-11-20.md has the
 * measurements.
 *
 * Three claims, one block each:
 *
 *   1. The index's key is the client's `.order(...)` chain, column for column and direction
 *      for direction. If either side changes alone, the index stops serving the Feed and
 *      nothing else would notice.
 *   2. The planner can serve the Feed's statement from it with no Sort, as `authenticated`,
 *      under row security, for the first page and for a keyset page.
 *   3. It changes nothing anyone can see. The Feed is paged to the end with the index in use
 *      and again with it dropped, for every kind of account the policy treats differently,
 *      and both walks must equal the rows the visibility rules say, in the same order.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const FEED_TYPES = [
  'title_ranked',
  'title_logged',
  'season_completed',
  'watchlist_added',
  'award_earned',
  'goal_completed',
  'follow_added',
  'ranking_batch',
];

/**
 * The statement PostgREST builds for `activityRows`, with its embeds: the media item, its
 * parent and the actor's profile (which carries `profiles_read`, so it is policed too). The
 * keyset is the client's `keyset()` expansion, written out the same way.
 */
const feedSql = (withCursor) => `
  select e.id, e.actor_id, e.causal_at, e.causal_step,
         row_to_json(m.*)::jsonb as media_items, row_to_json(p.*)::jsonb as profiles
    from feed_events e
    left join lateral (
      select m1.kind, m1.title, row_to_json(par.*)::jsonb as parent
        from media_items m1
        left join lateral (select m2.title from media_items m2 where m2.id = m1.parent_id limit 1) par on true
       where m1.id = e.media_item_id limit 1) m on true
    left join lateral (
      select p1.username, p1.display_name from profiles p1 where p1.id = e.actor_id limit 1) p on true
   where ${
     withCursor
       ? `(e.causal_at < $4 or (e.causal_at = $4 and e.causal_step < $5)
           or (e.causal_at = $4 and e.causal_step = $5 and e.id > $6)) and`
       : ''
   } e.actor_id = any($1::uuid[]) and e.type = any($2::text[])
   order by e.causal_at desc, e.causal_step desc, e.id asc
   limit $3`;

let t;
const who = {};
let film;

before(async () => {
  t = await createTestDb();
  const user = (username, visibility = 'public') => t.createUser({ username, visibility });

  who.reader = await user('fo_reader');
  who.followedPublic = await user('fo_public');
  who.followedPrivate = await user('fo_private', 'private');
  who.pendingPrivate = await user('fo_pending', 'private');
  who.strangerPublic = await user('fo_stranger');
  who.strangerPrivate = await user('fo_stranger_private', 'private');
  who.blockedByReader = await user('fo_blocked');
  who.blockedReader = await user('fo_blocker');
  who.suspended = await user('fo_suspended');
  who.deleted = await user('fo_deleted');
  film = await t.createMovie('Feed order fixture', 880_001);

  const follow = (followee, state = 'approved') =>
    t.sql(`insert into follows (follower_id, followee_id, state) values ($1, $2, $3)`, [
      who.reader,
      followee,
      state,
    ]);
  await follow(who.followedPublic);
  await follow(who.followedPrivate);
  await follow(who.pendingPrivate, 'pending');
  await follow(who.suspended);
  await follow(who.deleted);
  // A block in each direction. Neither has a follow left to cut: the point is that the
  // actor array names them anyway, and only the policy decides.
  await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2), ($3, $4)`, [
    who.reader,
    who.blockedByReader,
    who.blockedReader,
    who.reader,
  ]);
  await t.sql(`update profiles set status = 'suspended' where id = $1`, [who.suspended]);

  // Six events per account, interleaved in time across accounts, with the ties the sort key
  // exists for: one action's rows share an instant and differ by step, and two accounts
  // share instants with equal steps so only the id separates them.
  const actors = Object.values(who);
  await t.sql(
    `insert into feed_events (actor_id, type, media_item_id, created_at, causal_at, causal_step)
     select a.actor, $2, $3, ts, ts, k % 3
       from unnest($1::uuid[]) with ordinality a(actor, n),
            generate_series(1, 6) k,
            lateral (select timestamptz '2026-06-01' - ((k / 3) || ' days')::interval
                          - ((a.n % 4) || ' hours')::interval ts) s`,
    [actors, 'title_ranked', film],
  );
  // One event of the followed public account hidden behind another (a grouped post).
  await t.sql(
    `update feed_events set presented_in = (
        select id from feed_events where actor_id = $1 order by causal_at desc, causal_step desc, id limit 1)
      where id = (select id from feed_events where actor_id = $1 order by causal_at, causal_step, id limit 1)`,
    [who.followedPublic],
  );
  // An account that has since been deleted takes its events with it.
  await t.sql(`delete from auth.users where id = $1`, [who.deleted]);
  await t.exec('analyze feed_events');
});

after(async () => t?.close());

/** Every page of the Feed for `viewer`, keyset after keyset, as the client pages it. */
async function walk(viewer, actorIds, pageSize = 4) {
  const ids = [];
  let cursor = null;
  for (let page = 0; page < 100; page += 1) {
    const { rows } = await t.asUser(viewer, () =>
      t.sql(
        feedSql(Boolean(cursor)),
        cursor
          ? [actorIds, FEED_TYPES, pageSize, cursor.causal_at, cursor.causal_step, cursor.id]
          : [actorIds, FEED_TYPES, pageSize],
      ),
    );
    for (const row of rows) {
      // An event whose actor's profile embed came back empty would be dropped by `hydrate`;
      // with the policy as it is, a visible event always has a visible actor.
      assert.ok(row.profiles, 'a visible event arrived without its actor');
      ids.push(row.id);
    }
    if (rows.length < pageSize) return ids;
    cursor = rows[rows.length - 1];
  }
  throw new Error('the Feed never ended');
}

/** The plan for one Feed page as `viewer`, as text. */
async function plan(viewer, actorIds, withCursor) {
  const params = withCursor
    ? [
        actorIds,
        FEED_TYPES,
        20,
        '2026-05-31T00:00:00Z',
        1,
        '00000000-0000-0000-0000-000000000000',
      ]
    : [actorIds, FEED_TYPES, 20];
  const { rows } = await t.asUser(viewer, () =>
    t.sql(`explain (costs off) ${feedSql(withCursor)}`, params),
  );
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

/** Runs `fn` with sorting priced out, which leaves the ordered index as the only cheap plan. */
async function preferringTheIndex(fn) {
  await t.exec('set enable_sort = off');
  try {
    return await fn();
  } finally {
    await t.exec('reset enable_sort');
  }
}

/** Runs `fn` with the index dropped, in a transaction that is always rolled back. */
async function withoutTheIndex(fn) {
  await t.exec('begin');
  try {
    await t.exec('drop index feed_events_feed_order');
    return await fn();
  } finally {
    await t.exec('rollback');
  }
}

describe('the index is the Feed sort key', () => {
  it('has the columns and directions of the client .order() chain', async () => {
    const source = readFileSync(join(root, 'src/features/feed/use-feed.ts'), 'utf8');
    const body = source.slice(source.indexOf('async function activityRows'));
    const chain = [
      ...body
        .slice(0, body.indexOf('.limit(limit)'))
        .matchAll(/\.order\('(\w+)', \{ ascending: (true|false) \}\)/g),
    ].map(([, column, ascending]) => `${column}${ascending === 'true' ? '' : ' DESC'}`);
    assert.deepEqual(chain, ['causal_at DESC', 'causal_step DESC', 'id']);

    const { rows } = await t.sql(
      `select pg_get_indexdef('public.feed_events_feed_order'::regclass) as def`,
    );
    assert.match(rows[0].def, /USING btree \(causal_at DESC, causal_step DESC, id\)$/);
  });
});

describe('the planner can serve a Feed page from it', () => {
  const actorIds = () => [who.reader, who.followedPublic, who.followedPrivate];

  it('reads the first page in index order with no sort, under row security', async () => {
    const text = await preferringTheIndex(() => plan(who.reader, actorIds(), false));
    assert.match(text, /Index Scan using feed_events_feed_order on feed_events/);
    assert.doesNotMatch(text, /Sort/);
    assert.match(text, /can_i_view\(actor_id\)/, 'the policy is still applied to the scan');
  });

  it('reads a keyset page the same way', async () => {
    const text = await preferringTheIndex(() => plan(who.reader, actorIds(), true));
    assert.match(text, /Index Scan using feed_events_feed_order on feed_events/);
    assert.doesNotMatch(text, /Sort/);
  });
});

describe('it changes nothing anyone can see', () => {
  /** What the policy says each reader sees, in the Feed's order, from the table itself. */
  async function expected(visibleActors) {
    const { rows } = await t.sql(
      `select id from feed_events
        where actor_id = any($1::uuid[]) and presented_in is null
        order by causal_at desc, causal_step desc, id asc`,
      [visibleActors],
    );
    return rows.map((row) => row.id);
  }

  // Every account in the fixture: `actorIds` is a filter, never the authorisation, so the
  // strongest test asks for all of them and lets the policy decide.
  const everyone = () => Object.values(who);

  const cases = [
    {
      name: 'a signed-in reader',
      viewer: () => who.reader,
      // Themselves, an approved follow of a public and of a private account, and a public
      // stranger. Not a pending follow, a private stranger, either side of a block, a
      // suspended account, or a deleted one.
      visible: () => [who.reader, who.followedPublic, who.followedPrivate, who.strangerPublic],
    },
    {
      name: 'the account the reader blocked',
      viewer: () => who.blockedByReader,
      visible: () => [
        who.blockedByReader,
        who.followedPublic,
        who.strangerPublic,
        who.blockedReader,
      ],
    },
    {
      // (A signed-out client has no grant on feed_events at all, so it has no Feed to page.)
      name: 'the private account, reading as itself',
      viewer: () => who.followedPrivate,
      visible: () => [
        who.followedPrivate,
        who.reader,
        who.followedPublic,
        who.strangerPublic,
        who.blockedByReader,
        who.blockedReader,
      ],
    },
  ];

  for (const { name, viewer, visible } of cases) {
    it(`pages identically with and without the index, for ${name}`, async () => {
      const want = await expected(visible());
      assert.ok(want.length >= 15, 'the fixture is too small to page');

      const withIndex = await preferringTheIndex(() => walk(viewer(), everyone()));
      const without = await withoutTheIndex(() => walk(viewer(), everyone()));

      assert.deepEqual(withIndex, want, 'the indexed walk differs from the visibility rules');
      assert.deepEqual(without, want, 'the unindexed walk differs from the visibility rules');
    });
  }

  it('returns nothing of the hidden, deleted, suspended or blocked rows to the reader', async () => {
    const seen = new Set(await preferringTheIndex(() => walk(who.reader, everyone())));
    const { rows } = await t.sql(
      `select id from feed_events
        where presented_in is not null
           or actor_id = any($1::uuid[])`,
      [
        [
          who.pendingPrivate,
          who.strangerPrivate,
          who.blockedByReader,
          who.blockedReader,
          who.suspended,
        ],
      ],
    );
    assert.ok(rows.length > 20);
    for (const row of rows) assert.ok(!seen.has(row.id), 'a row the policy hides was returned');
    const { rows: gone } = await t.sql(
      `select count(*)::int as n from feed_events where actor_id = $1`,
      [who.deleted],
    );
    assert.equal(gone[0].n, 0, 'a deleted account kept its events');
  });
});
