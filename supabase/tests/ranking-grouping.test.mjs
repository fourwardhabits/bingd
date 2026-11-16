import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * **A backlog half hour is one post** (Feed Activity Grouping, PR B, 20261126000100).
 *
 * An Unranked sitting that *begins* within 30 minutes of the first placement of the actor's
 * latest published grouped ranking post, on the same ladder, joins that post when it ends.
 * The post keeps its id, conversation, place and representative; only membership and count
 * grow. A sitting is never split, never joins while it runs, and history is never combined.
 * The single-sitting lifecycle itself is `ranking-batch-feed.test.mjs`.
 */
let t;
let user;
let friend;
let seq = 0;
let tmdb = 970_000;

before(async () => {
  t = await createTestDb();
  friend = await t.createUser({ username: 'rg_friend' });
});

after(async () => t?.close());

beforeEach(async () => {
  seq += 1;
  user = await t.createUser({ username: `rg_${seq}` });
  await t.actAs(user);
});

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const note = async (s, id) =>
  (await t.sql(`select rank_batch_note($1, $2, $3) as r`, [await uuid(), s, id])).rows[0].r;
const finalize = async (s, operation) =>
  (await t.sql(`select rank_batch_finalize($1, $2) as r`, [operation ?? (await uuid()), s]))
    .rows[0].r;

async function rankedMovie(name) {
  const id = await t.createMovie(`${name} ${seq}`, (tmdb += 1));
  await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [user, id]);
  await t.rankToCompletion(id, 'loved', (pivot, subject) => subject);
  return id;
}

async function rankedSeason(name) {
  const show = await t.createSeries(`${name} ${seq}`, (tmdb += 1));
  const id = await t.createSeason(show, 1, `${name} ${seq} S1`);
  await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [user, id]);
  await t.rankToCompletion(id, 'loved', (pivot, subject) => subject);
  return id;
}

/** One finished sitting of the given titles. */
async function sitting(titles) {
  const s = await uuid();
  for (const id of titles) await note(s, id);
  return { id: s, result: await finalize(s) };
}

const posts = async () =>
  (
    await t.sql(
      `select id, type, media_item_id, payload, causal_at from feed_events
        where actor_id = $1 and type in ('ranking_batch', 'ranking_batch_draft')
        order by causal_at, id`,
      [user],
    )
  ).rows;

const members = async (eventId) =>
  (
    await t.sql(
      `select media_item_id from feed_ranking_titles where event_id = $1 order by placed_at, id`,
      [eventId],
    )
  ).rows.map((row) => row.media_item_id);

/** Moves a published group's start back, as the clock would. */
const ageGroup = (eventId, minutes) =>
  t.sql(
    `update feed_events
        set payload = jsonb_set(payload, '{started_at}',
              to_jsonb((payload ->> 'started_at')::timestamptz - make_interval(mins => $2)))
      where id = $1`,
    [eventId, minutes],
  );

describe('joining the open group', () => {
  it('a sitting that begins inside the window joins the published post when it ends', async () => {
    const [heat, ronin] = [await rankedMovie('Heat'), await rankedMovie('Ronin')];
    const first = await sitting([heat, ronin]);
    const [group] = await posts();
    assert.ok(group.payload.started_at, 'a post published now records its start');

    await ageGroup(group.id, 10);
    const [collateral, thief] = [await rankedMovie('Collateral'), await rankedMovie('Thief')];
    const second = await sitting([collateral, thief]);

    assert.equal(second.result.joined, true);
    assert.equal(second.result.event_id, group.id);
    const all = await posts();
    assert.equal(all.length, 1, 'one post for the half hour, and no draft left behind');
    assert.equal(all[0].id, group.id);
    assert.equal(all[0].type, 'ranking_batch');
    assert.equal(all[0].payload.count, 4);
    assert.equal(all[0].media_item_id, group.media_item_id, 'the representative is unchanged');
    assert.equal(
      all[0].causal_at.getTime(),
      group.causal_at.getTime(),
      'causal_at unchanged, so the post keeps its place',
    );
    assert.deepEqual(await members(group.id), [heat, ronin, collateral, thief]);
    assert.equal(first.result.status, 'ok');
  });

  it('a placement still in flight when its sitting joined follows it into the group (Codex, PR 311)', async () => {
    await sitting([await rankedMovie('Heat')]);
    const [group] = await posts();
    await ageGroup(group.id, 5);

    // The app fires the note without waiting for it: the sitting ends, joins, and only then
    // does its last placement's note arrive.
    const s = await uuid();
    await note(s, await rankedMovie('Ronin'));
    const ended = await finalize(s);
    assert.equal(ended.joined, true);
    const late = await rankedMovie('Collateral');
    const landed = await note(s, late);

    assert.equal(landed.status, 'ok');
    assert.equal(
      landed.event_id,
      group.id,
      'the late title went to the group the sitting joined',
    );
    assert.equal(landed.joined, true);
    const all = await posts();
    assert.equal(all.length, 1, 'no invisible draft is left that nothing will ever finalise');
    assert.equal(all[0].payload.count, 3);
    assert.equal(all[0].media_item_id, group.media_item_id, 'the representative is unchanged');
    assert.deepEqual((await members(group.id)).at(-1), late);

    // And it is idempotent: the same title again adds nothing.
    assert.equal((await note(s, late)).count, 3);
  });

  it('keeps the post’s comments and reactions as it grows', async () => {
    await sitting([await rankedMovie('Alien')]);
    const [group] = await posts();
    await t.actAs(friend);
    await t.sql(`select add_comment($1, $2, 'go on', false)`, [await uuid(), group.id]);
    await t.sql(`select set_reaction($1, $2, 'love')`, [await uuid(), group.id]);
    await t.actAs(user);

    await sitting([await rankedMovie('Aliens')]);

    const [grown] = await posts();
    assert.equal(grown.id, group.id);
    assert.equal(grown.payload.count, 2);
    const { rows: c } = await t.sql(`select 1 from comments where feed_event_id = $1`, [
      group.id,
    ]);
    const { rows: r } = await t.sql(`select 1 from reactions where feed_event_id = $1`, [
      group.id,
    ]);
    assert.equal(c.length, 1);
    assert.equal(r.length, 1);
  });

  it('never grows a published post while a sitting runs: the draft stays invisible until it ends', async () => {
    await sitting([await rankedMovie('Up')]);
    const [group] = await posts();

    const running = await uuid();
    await note(running, await rankedMovie('Coco'));
    await note(running, await rankedMovie('Soul'));

    const mid = (await posts()).find((row) => row.id === group.id);
    assert.equal(mid.payload.count, 1, 'the published post is unchanged mid-sitting');
    assert.deepEqual(await members(group.id), [group.media_item_id]);

    await finalize(running);
    const [after] = await posts();
    assert.equal(after.payload.count, 3);
  });

  it('a sitting that began inside the window and ran past it joins whole; it is never split', async () => {
    await sitting([await rankedMovie('Before')]);
    const [group] = await posts();
    // The group began 25 minutes ago; this sitting starts now, inside the window, and its
    // later titles land after the 30-minute mark.
    await ageGroup(group.id, 25);
    const s = await uuid();
    await note(s, await rankedMovie('Inside'));
    await t.sql(
      `update feed_ranking_titles set placed_at = placed_at - interval '1 minute'
        where event_id = (select id from feed_events where type = 'ranking_batch_draft' and actor_id = $1)`,
      [user],
    );
    await note(s, await rankedMovie('Past the mark'));
    await finalize(s);

    const all = await posts();
    assert.equal(all.length, 1);
    assert.equal(all[0].payload.count, 3);
  });

  it('the member list reads the joined titles in placed order, matching the count', async () => {
    const a = await rankedMovie('First');
    await sitting([a]);
    const b = await rankedMovie('Second');
    await sitting([b]);
    const [group] = await posts();

    const rows = await t.asUser(friend, async () => {
      await t.actAs(friend);
      return (await t.sql(`select * from ranking_batch_titles($1)`, [group.id])).rows;
    });
    await t.actAs(user);
    assert.deepEqual(
      rows.map((row) => row.media_item_id),
      [a, b],
    );
    assert.equal(rows.length, group.payload.count);
  });
});

describe('publishing on its own', () => {
  it('a sitting that begins after the window has closed is a second post', async () => {
    await sitting([await rankedMovie('Early')]);
    const [group] = await posts();
    await ageGroup(group.id, 31);

    const late = await sitting([await rankedMovie('Late')]);

    assert.notEqual(late.result.joined, true);
    const all = await posts();
    assert.equal(all.length, 2);
    assert.equal(all[0].payload.count, 1);
    assert.equal(all[1].payload.count, 1);
  });

  it('a sitting that began before the group, however recently it ended, publishes on its own', async () => {
    // Codex, PR 311: a sitting left open since yesterday must not join today's group.
    const early = await uuid();
    await note(early, await rankedMovie('Left open'));
    await t.sql(
      `update feed_ranking_titles set placed_at = placed_at - interval '1 day'
        where event_id = (select id from feed_events
                           where actor_id = $1 and type = 'ranking_batch_draft')`,
      [user],
    );
    await sitting([await rankedMovie('Today')]);
    const ended = await finalize(early);

    assert.notEqual(ended.joined, true);
    const all = await posts();
    assert.equal(all.filter((row) => row.type === 'ranking_batch').length, 2);
  });

  it('two sittings ended out of start order are two posts', async () => {
    const first = await uuid();
    await note(first, await rankedMovie('Started first'));
    await t.sql(
      `update feed_ranking_titles set placed_at = placed_at - interval '2 minutes'
        where event_id = (select id from feed_events
                           where actor_id = $1 and type = 'ranking_batch_draft')`,
      [user],
    );
    const second = await uuid();
    await note(second, await rankedMovie('Started second'));

    await finalize(second); // publishes, starting the group
    const result = await finalize(first); // began before that group: its own post
    assert.notEqual(result.joined, true);
    assert.equal((await posts()).length, 2);
  });

  /**
   * Reversed by 20261128000100 (founder spec 2026-11-16, §5C): grouping is a social
   * presentation, so a season sitting joins a movie post inside the window. Each title
   * keeps its own ladder, standing and score; the sheet labels each by its own list.
   */
  it('joins across ladders, while each title keeps its own ladder and score', async () => {
    const film = await rankedMovie('Film');
    const season = await rankedSeason('Show');
    await sitting([film]);
    const second = await sitting([season]);
    assert.equal(second.result.joined, true);
    const all = await posts();
    assert.equal(all.length, 1);
    assert.equal(all[0].payload.count, 2);
    const { rows } = await t.sql(
      `select media_item_id, category, score from ranking_batch_titles($1)`,
      [all[0].id],
    );
    const byId = Object.fromEntries(rows.map((row) => [row.media_item_id, row]));
    assert.equal(byId[film].category, 'movies');
    assert.equal(byId[season].category, 'tv_seasons');
    assert.equal(Number(byId[season].score), 10, 'top of its own ladder, not the movies');
  });

  it('never extends a post published before this migration (no recorded start)', async () => {
    await sitting([await rankedMovie('Old')]);
    const [group] = await posts();
    await t.sql(`update feed_events set payload = payload - 'started_at' where id = $1`, [
      group.id,
    ]);

    await sitting([await rankedMovie('New')]);
    assert.equal((await posts()).length, 2);
  });

  it('with grouping switched off, every sitting publishes on its own', async () => {
    await sitting([await rankedMovie('On')]);
    await t.sql(
      `insert into app_config (key, value) values ('feed.ranking_grouping_enabled', 'false'::jsonb)
       on conflict (key) do update set value = excluded.value`,
    );
    try {
      await sitting([await rankedMovie('Off')]);
    } finally {
      await t.sql(
        `update app_config set value = 'true'::jsonb where key = 'feed.ranking_grouping_enabled'`,
      );
    }
    assert.equal((await posts()).length, 2);
  });

  it('a draft somebody already reacted to keeps its own identity', async () => {
    await sitting([await rankedMovie('Group')]);
    const s = await uuid();
    const note1 = await note(s, await rankedMovie('Reacted'));
    await t.actAs(friend);
    await t.sql(`select set_reaction($1, $2, 'love')`, [await uuid(), note1.event_id]);
    await t.actAs(user);

    await finalize(s);
    const all = await posts();
    assert.equal(all.length, 2);
    assert.ok(all.some((row) => row.id === note1.event_id && row.type === 'ranking_batch'));
  });

  it('never joins anything but a published grouped ranking post', async () => {
    // A watchlist post carrying a start in its payload is still not a candidate.
    const film = await rankedMovie('Saved');
    await t.sql(
      `insert into feed_events (actor_id, type, media_item_id, payload)
       values ($1, 'watchlist_added', $2, jsonb_build_object('count', 3, 'started_at', now()))`,
      [user, film],
    );
    const result = await sitting([await rankedMovie('Ranked')]);
    assert.notEqual(result.result.joined, true);
    const { rows } = await t.sql(
      `select payload from feed_events where actor_id = $1 and type = 'watchlist_added'`,
      [user],
    );
    assert.equal(rows[0].payload.count, 3, 'the watchlist post is untouched');
  });
});

describe('everything else is unchanged', () => {
  it('an ordinary after-watch ranking keeps its own post while a group is open', async () => {
    await sitting([await rankedMovie('Grouped')]);
    const ordinary = await rankedMovie('Watched last night');
    const { rows } = await t.sql(
      `select 1 from feed_events where actor_id = $1 and type = 'title_ranked' and media_item_id = $2`,
      [user, ordinary],
    );
    assert.equal(rows.length, 1, 'its title_ranked post exists and is nobody’s member');
    const [group] = await posts();
    assert.equal(group.payload.count, 1);
  });

  it('finalising is idempotent, and a second end of the same sitting finds nothing', async () => {
    await sitting([await rankedMovie('A')]);
    const s = await uuid();
    await note(s, await rankedMovie('B'));
    const operation = await uuid();
    const first = await finalize(s, operation);
    const retry = await finalize(s, operation);
    assert.deepEqual(retry, first);
    assert.equal((await finalize(s)).status, 'empty');
    assert.equal((await posts()).length, 1);
  });
});
