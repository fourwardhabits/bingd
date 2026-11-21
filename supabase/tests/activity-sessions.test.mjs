import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * **An activity session is one post** (founder spec, 2026-11-21; 20261130000900).
 *
 * A person's eligible first-time rankings (reviewed ones included) and watchlist additions
 * inside one fixed 30-minute window are one Feed post, newest title first. The post keeps its
 * id and conversation as it grows, moves to its newest activity (never backwards), and
 * notifies nobody. Everything that kept an event apart still does.
 */
let t;
let user;
let friend;
let stranger;
let seq = 0;
let tmdb = 3_100_000;

before(async () => {
  t = await createTestDb();
  friend = await t.createUser({ username: 'as_friend' });
  stranger = await t.createUser({ username: 'as_stranger' });
});

after(async () => t?.close());

beforeEach(async () => {
  seq += 1;
  user = await t.createUser({ username: `as_user_${seq}` });
  await t.sql(
    `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
    [friend, user],
  );
  await t.actAs(user);
});

const uuid = async () => (await t.sql(`select gen_random_uuid() as id`)).rows[0].id;
const call = async (sql, params) => (await t.sql(`select ${sql} as r`, params)).rows[0].r;

async function title(kind, name) {
  if (kind === 'season') {
    const show = await t.createSeries(`${name} ${seq}`, (tmdb += 1));
    return t.createSeason(show, 1, `${name} ${seq} S1`);
  }
  if (kind === 'show') return t.createSeries(`${name} ${seq}`, (tmdb += 1));
  return t.createMovie(`${name} ${seq}`, (tmdb += 1));
}

/** A first ranking from the title page: log "Today", optional review, rank, then the note. */
async function rank(name, { kind = 'movie', id = null, text = null, note = true } = {}) {
  const mediaItemId = id ?? (await title(kind, name));
  await call(`log_title($1, $2, 'loved', current_date, 'today_default'::watch_date_basis)`, [
    await uuid(),
    mediaItemId,
  ]);
  if (text) {
    await call(`save_note($1, $2, $3, null, 'public'::note_visibility, false)`, [
      await uuid(),
      mediaItemId,
      text,
    ]);
  }
  await t.rankToCompletion(mediaItemId, 'loved', (pivot, subject) => subject);
  const result = note
    ? await call(`rank_group_note($1, $2)`, [await uuid(), mediaItemId])
    : null;
  return { id: mediaItemId, result };
}

async function save(name, { id = null } = {}) {
  const mediaItemId = id ?? (await title('movie', name));
  await call(`set_watchlist($1, $2, true)`, [await uuid(), mediaItemId]);
  return mediaItemId;
}

/** Moves every one of the actor's posts, and any window they anchor, `minutes` back. */
async function age(minutes) {
  await t.sql(
    `update feed_events
        set created_at = created_at - make_interval(mins => $2::int),
            causal_at  = causal_at  - make_interval(mins => $2::int),
            payload = payload
              || case when payload ? 'started_at'
                      then jsonb_build_object('started_at',
                             (payload ->> 'started_at')::timestamptz - make_interval(mins => $2::int))
                      else '{}'::jsonb end
              || case when payload ? 'last_activity_at'
                      then jsonb_build_object('last_activity_at',
                             (payload ->> 'last_activity_at')::timestamptz - make_interval(mins => $2::int))
                      else '{}'::jsonb end
      where actor_id = $1`,
    [user, minutes],
  );
  await t.sql(
    `update feed_watchlist_titles set added_at = added_at - make_interval(mins => $2::int)
      where actor_id = $1`,
    [user, minutes],
  );
}

/** Runs `fn` as `viewer` under RLS, then acts as the author again. */
const as = async (viewer, fn) => {
  try {
    return await t.asUser(viewer, fn);
  } finally {
    await t.actAs(user);
  }
};

const posts = async () =>
  (
    await t.sql(
      `select id, type, media_item_id, payload, presented_in, created_at, causal_at, causal_step
         from feed_events where actor_id = $1 order by causal_at, id`,
      [user],
    )
  ).rows;

const visibleTo = (viewer) =>
  as(viewer, async () => {
    const { rows } = await t.sql(
      `select id, type, media_item_id, payload from feed_events where actor_id = $1
        order by causal_at desc, causal_step desc, id`,
      [user],
    );
    return rows;
  });

const railAs = (viewer, eventId) =>
  as(
    viewer,
    async () =>
      (
        await t.sql(
          `select media_item_id, action, score, ranked from feed_group_previews(array[$1]::uuid[], 12)
          order by ordinal`,
          [eventId],
        )
      ).rows,
  );

const sheetAs = (viewer, eventId) =>
  as(
    viewer,
    async () =>
      (
        await t.sql(
          `select media_item_id, action, position, score from ranking_batch_titles($1)`,
          [eventId],
        )
      ).rows,
  );

const notificationCount = async () =>
  Number((await t.sql(`select count(*)::int as n from notifications`)).rows[0].n);

describe('one session, in any order', () => {
  it('3:00 rank A, 3:07 save B and C, 3:12 rank D: one post, four titles, D leading', async () => {
    const before = await notificationCount();
    const a = await rank('A');
    assert.equal(a.result.status, 'solo');
    await age(7);
    const b = await save('B');
    const c = await save('C');
    await age(5);
    const d = await rank('D');
    assert.equal(d.result.status, 'joined');

    const seen = await visibleTo(friend);
    assert.equal(seen.length, 1, 'one post');
    const [post] = seen;
    assert.equal(post.type, 'ranking_batch');
    assert.equal(post.media_item_id, d.id, 'the newest title leads');
    assert.equal(post.payload.count, 4);
    assert.equal(post.payload.ranked, 2);
    assert.equal(post.payload.saved, 2);
    assert.equal(post.payload.lead_action, 'ranked');
    assert.equal(post.payload.session, true);

    const rail = await railAs(friend, post.id);
    assert.deepEqual(
      rail.map((r) => [r.media_item_id, r.action]),
      [
        [d.id, 'ranked'],
        [c, 'saved'],
        [b, 'saved'],
        [a.id, 'ranked'],
      ],
      'newest first, each with its own action',
    );
    assert.ok(rail.filter((r) => r.action === 'ranked').every((r) => r.score !== null));
    assert.ok(
      rail.filter((r) => r.action === 'saved').every((r) => r.score === null && !r.ranked),
    );
    assert.deepEqual(
      (await sheetAs(friend, post.id)).map((r) => [
        r.media_item_id,
        r.action,
        r.position === null,
      ]),
      [
        [d.id, 'ranked', false],
        [c, 'saved', true],
        [b, 'saved', true],
        [a.id, 'ranked', false],
      ],
      'the sheet lists all four, saves without a standing',
    );
    assert.equal(await notificationCount(), before, 'nobody is notified as it grows');
  });

  it('rank, save, rank: the first ranking anchors the window; the post forms at the save', async () => {
    const a = await rank('A');
    await age(3);
    const b = await save('B');
    const all = await posts();
    const g = all.find((p) => p.type === 'ranking_batch');
    assert.ok(g, 'a ranking and a save make one session post');
    assert.equal(g.payload.origin, 'session');
    assert.equal(
      new Date(g.payload.started_at).getTime(),
      all.find((p) => p.type === 'title_ranked').created_at.getTime(),
      'fixed from the first event',
    );
    assert.equal(g.media_item_id, b);
    assert.equal(g.payload.lead_action, 'saved');
    const d = await rank('D');
    assert.equal(d.result.status, 'joined');
    assert.equal(d.result.event_id, g.id);
    const [post] = await visibleTo(friend);
    assert.equal(post.id, g.id);
    assert.equal(post.payload.count, 3);
    assert.equal(post.payload.lead_action, 'ranked');
    assert.ok(a.id);
  });

  it('save, rank, save: the watchlist post becomes the session, keeping its id', async () => {
    const b = await save('B');
    const [w] = await posts();
    assert.equal(w.type, 'watchlist_added');
    assert.equal(w.payload.session, true);
    const a = await rank('A');
    assert.equal(a.result.status, 'joined');
    assert.equal(a.result.event_id, w.id, 'the same post');
    const c = await save('C');
    const seen = await visibleTo(friend);
    assert.deepEqual(
      seen.map((p) => [p.id, p.type]),
      [[w.id, 'ranking_batch']],
      'one post, a ranking group since it holds a ranking',
    );
    assert.equal(seen[0].media_item_id, c);
    assert.equal(seen[0].payload.lead_action, 'saved', 'the newest action was a save');
    assert.equal(seen[0].payload.count, 3);
    assert.deepEqual(
      (await railAs(friend, w.id)).map((r) => r.media_item_id),
      [c, a.id, b],
    );
  });

  it('a save alone, then more saves: still a watchlist post, newest first', async () => {
    const a = await save('A');
    const b = await save('B');
    const [post] = await visibleTo(friend);
    assert.equal(post.type, 'watchlist_added');
    assert.equal(post.media_item_id, b);
    assert.equal(post.payload.lead_action, 'saved');
    assert.equal(post.payload.saved, 2);
    assert.equal(post.payload.ranked, 0);
    const members = await as(friend, async () =>
      (await t.sql(`select media_item_id from watchlist_group_titles($1)`, [post.id])).rows.map(
        (r) => r.media_item_id,
      ),
    );
    assert.deepEqual(members, [b, a]);
  });

  it('a reviewed first ranking inside a session joins it, and its review stays readable', async () => {
    await save('Saved');
    const reviewed = await rank('Reviewed', { text: 'A review that rides along.' });
    assert.equal(reviewed.result.status, 'joined');
    const [post] = await visibleTo(friend);
    assert.equal(post.payload.count, 2);
    const note = await as(
      friend,
      async () =>
        (
          await t.sql(
            `select note from public_notes(array[$1]::uuid[], array[$2]::uuid[], 10)`,
            [user, reviewed.id],
          )
        ).rows[0]?.note,
    );
    assert.equal(note, 'A review that rides along.');
  });

  it('the same title saved and then ranked is one poster, ranked, with both events kept', async () => {
    const x = await save('X');
    const y = await save('Y');
    const ranked = await rank('X', { id: x });
    assert.equal(ranked.result.status, 'joined');
    const [post] = await visibleTo(friend);
    assert.equal(post.payload.count, 2, 'two titles, not three');
    assert.equal(post.payload.ranked, 1);
    assert.equal(post.payload.saved, 1);
    const rail = await railAs(friend, post.id);
    assert.deepEqual(
      rail.map((r) => [r.media_item_id, r.action]),
      [
        [x, 'ranked'],
        [y, 'saved'],
      ],
    );
    assert.notEqual(rail[0].score, null, 'in its ranked state');
    const { rows } = await t.sql(
      `select (select count(*)::int from feed_watchlist_titles where actor_id = $1 and media_item_id = $2) as saves,
              (select count(*)::int from feed_events where actor_id = $1 and media_item_id = $2 and type = 'title_ranked') as rankings`,
      [user, x],
    );
    assert.deepEqual(rows[0], { saves: 1, rankings: 1 }, 'the underlying events stay');
  });
});

describe('the fixed window', () => {
  /** Anchors the actor's open session `interval` before `at`. */
  const anchor = (eventId, interval, at = 'now()') =>
    t.sql(
      `update feed_events
          set created_at = ${at} - $2::interval,
              causal_at = ${at} - $2::interval,
              payload = payload || jsonb_build_object('started_at', ${at} - $2::interval,
                                                      'last_activity_at', ${at} - $2::interval)
        where id = $1`,
      [eventId, interval],
    );

  it('a save at 29:59 joins; a save at 30:00 starts the next session', async () => {
    await save('First');
    const [w] = await posts();
    await anchor(w.id, '29 minutes 59 seconds');
    await save('At 29:59');
    assert.equal((await visibleTo(friend)).length, 1, '29:59 is inside');

    await anchor(w.id, '30 minutes');
    await save('At 30:00');
    const seen = await visibleTo(friend);
    assert.equal(seen.length, 2, '30:00 is outside');
    assert.equal(seen[0].payload.count, 1, 'the next session starts with it');
    assert.equal(seen[1].id, w.id);
    assert.equal(seen[1].payload.count, 2);
  });

  it('a ranking at exactly 30:00 after the start does not join; one at 29:59 does', async () => {
    await save('Opens');
    const [w] = await posts();
    const late = await rank('Edge', { note: false });
    const { rows } = await t.sql(
      `select created_at from feed_events where actor_id = $1 and type = 'title_ranked'`,
      [user],
    );
    const rankedAt = rows[0].created_at.toISOString();
    await anchor(w.id, '30 minutes', `'${rankedAt}'::timestamptz`);
    const r = await call(`rank_group_note($1, $2)`, [await uuid(), late.id]);
    assert.equal(r.status, 'solo', 'exactly 30:00 is the next session');

    const inside = await rank('Inside', { note: false });
    const { rows: r2 } = await t.sql(
      `select created_at from feed_events where actor_id = $1 and type = 'title_ranked' and media_item_id = $2`,
      [user, inside.id],
    );
    await anchor(
      w.id,
      '29 minutes 59 seconds',
      `'${r2[0].created_at.toISOString()}'::timestamptz`,
    );
    const joined = await call(`rank_group_note($1, $2)`, [await uuid(), inside.id]);
    assert.equal(joined.status, 'joined');
    assert.equal(joined.event_id, w.id);
  });

  it('it never slides: steady activity still splits at 30 minutes from the first event', async () => {
    await rank('R1');
    await age(20);
    await save('S1');
    await age(11); // 31 minutes after R1, 11 after S1
    const r2 = await rank('R2');
    assert.equal(r2.result.status, 'solo', 'not a sliding window');
    const seen = await visibleTo(friend);
    assert.deepEqual(
      seen.map((p) => p.type),
      ['title_ranked', 'ranking_batch'],
    );
  });
});

describe('what keeps its own card', () => {
  it('a rewatch and a TV update are never session members', async () => {
    const old = await rank('Seen before', { note: false });
    await age(120);
    await save('Saved now');
    const logged = await call(`log_rewatch($1, $2, current_date, 'today_default')`, [
      await uuid(),
      old.id,
    ]);
    assert.ok(logged);
    const again = await call(`rank_group_note($1, $2)`, [await uuid(), old.id]);
    assert.notEqual(again.status, 'joined');
  });

  it('a referenced single ranking stays standalone; a save after it starts its own post', async () => {
    const a = await rank('Liked', { note: false });
    const [post] = await posts();
    await t.actAs(friend);
    await t.sql(`select set_reaction($1, $2, 'love')`, [await uuid(), post.id]);
    await t.actAs(user);
    const r = await call(`rank_group_note($1, $2)`, [await uuid(), a.id]);
    assert.equal(r.reason, 'referenced');
    await save('After');
    const seen = await visibleTo(friend);
    assert.deepEqual(
      new Set(seen.map((p) => p.type)),
      new Set(['title_ranked', 'watchlist_added']),
    );
  });

  it('a reaction on a hidden ranking gives it its card back; a session of saves alone is a watchlist post again', async () => {
    const s = await save('Saved');
    const a = await rank('Ranked');
    const member = (await posts()).find((p) => p.type === 'title_ranked');
    assert.notEqual(member.presented_in, null);
    await t.sql(
      `insert into reactions (feed_event_id, user_id, kind) values ($1, $2, 'love')`,
      [member.id, friend],
    );
    const all = await posts();
    assert.equal(all.find((p) => p.id === member.id).presented_in, null);
    const carrier = all.find((p) => p.id === member.presented_in);
    assert.equal(carrier.type, 'watchlist_added', 'only saves remain');
    assert.equal(carrier.media_item_id, s);
    assert.equal(carrier.payload.count, 1);
    assert.ok(a.id);
  });

  it('with sessions switched off, families group only with themselves and nothing moves', async () => {
    await t.sql(
      `update app_config set value = 'false'::jsonb where key = 'feed.activity_sessions_enabled'`,
    );
    try {
      await save('S1');
      await rank('R1');
      await rank('R2');
      const seen = await visibleTo(friend);
      assert.deepEqual(
        new Set(seen.map((p) => p.type)),
        new Set(['watchlist_added', 'ranking_batch']),
      );
    } finally {
      await t.sql(
        `update app_config set value = 'true'::jsonb where key = 'feed.activity_sessions_enabled'`,
      );
    }
  });
});

describe('engagement, privacy and links', () => {
  it('an engaged session gains members: one card, its reactions and comments kept, nobody notified', async () => {
    await save('First');
    const [w] = await posts();
    await t.actAs(friend);
    await t.sql(`select add_comment($1, $2, 'nice list', false)`, [await uuid(), w.id]);
    await t.sql(`select set_reaction($1, $2, 'love')`, [await uuid(), w.id]);
    await t.actAs(user);
    const notified = await notificationCount();

    await save('Second');
    const r = await rank('Third');
    assert.equal(r.result.event_id, w.id);

    const seen = await visibleTo(friend);
    assert.deepEqual(
      seen.map((p) => p.id),
      [w.id],
    );
    assert.equal(seen[0].payload.count, 3);
    const { rows } = await t.sql(
      `select (select count(*)::int from comments where feed_event_id = $1) as comments,
              (select count(*)::int from reactions where feed_event_id = $1) as reactions`,
      [w.id],
    );
    assert.deepEqual(rows[0], { comments: 1, reactions: 1 });
    assert.equal(await notificationCount(), notified, 'growth writes no notification');
  });

  it('a stale link to an absorbed member resolves to the session; the session id itself stays good', async () => {
    const a = await rank('A');
    const b = await rank('B');
    assert.equal(b.result.status, 'grouped');
    await save('C');
    const member = (await posts()).find(
      (p) => p.type === 'title_ranked' && p.media_item_id === a.id,
    );
    const resolved = await as(
      friend,
      async () =>
        (await t.sql(`select feed_event_presentation($1) as g`, [member.id])).rows[0].g,
    );
    assert.equal(resolved, b.result.event_id);
    const direct = await as(
      friend,
      async () =>
        (await t.sql(`select id from feed_events where id = $1`, [b.result.event_id])).rows,
    );
    assert.equal(direct.length, 1);
  });

  it('a private author: approved followers see the session, a stranger nothing; a block hides it', async () => {
    await t.sql(`update profiles set visibility = 'private' where id = $1`, [user]);
    await save('P1');
    await rank('P2');
    const [post] = await visibleTo(friend);
    assert.equal(post.payload.count, 2);
    assert.equal((await railAs(friend, post.id)).length, 2);

    assert.deepEqual(await visibleTo(stranger), []);
    assert.deepEqual(await railAs(stranger, post.id), []);
    assert.deepEqual(await sheetAs(stranger, post.id), []);
    assert.equal(
      await as(
        stranger,
        async () =>
          (await t.sql(`select feed_event_presentation(id) as g from feed_events limit 1`))
            .rows[0]?.g ?? null,
      ),
      null,
    );

    await t.sql(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [user, friend]);
    try {
      assert.deepEqual(await visibleTo(friend), []);
      assert.deepEqual(await railAs(friend, post.id), []);
      assert.deepEqual(await sheetAs(friend, post.id), []);
    } finally {
      await t.sql(`delete from blocks where blocker_id = $1`, [user]);
    }
  });
});

describe('a catalogue delete', () => {
  it('of a session’s ranked representative keeps the post and its conversation (Codex, PR 354)', async () => {
    const saved = await save('Kept');
    const ranked = await rank('Deleted');
    const [post] = await visibleTo(friend);
    assert.equal(post.media_item_id, ranked.id, 'the ranking leads');
    await t.actAs(friend);
    await t.sql(`select add_comment($1, $2, 'keep this', false)`, [await uuid(), post.id]);
    await t.actAs(user);

    await t.sql(`delete from media_items where id = $1`, [ranked.id]);

    const after = await posts();
    const kept = after.find((p) => p.id === post.id);
    assert.ok(kept, 'the post survived');
    assert.equal(kept.media_item_id, saved, 'its surviving title leads');
    assert.equal(kept.payload.count, 1);
    const { rows } = await t.sql(
      `select count(*)::int as n from comments where feed_event_id = $1`,
      [post.id],
    );
    assert.equal(rows[0].n, 1, 'and its conversation');
  });
});

describe('a catalogue delete of the newest title', () => {
  it('recomputes the whole summary from the survivors (Codex, PR 354)', async () => {
    await save('A');
    const b = await rank('B');
    const c = await save('C');
    const [post] = await visibleTo(friend);
    assert.equal(post.payload.lead_action, 'saved');
    await t.sql(`delete from media_items where id = $1`, [c]);
    const kept = (await posts()).find((p) => p.id === post.id);
    assert.equal(kept.media_item_id, b.id, 'the ranking leads now');
    assert.equal(kept.payload.lead_action, 'ranked');
    assert.equal(kept.payload.count, 2);
    assert.equal(kept.payload.ranked, 1);
    assert.equal(kept.payload.saved, 1);
    assert.equal(kept.type, 'ranking_batch');
  });
});

describe('a catalogue delete of a member that does not lead', () => {
  it('refreshes the session too (Codex, PR 354)', async () => {
    await save('A');
    const b = await rank('B');
    await save('C');
    const [post] = await visibleTo(friend);
    assert.equal(post.payload.count, 3);
    await t.sql(`delete from media_items where id = $1`, [b.id]);
    const kept = (await posts()).find((p) => p.id === post.id);
    assert.equal(kept.payload.count, 2);
    assert.equal(kept.payload.ranked, 0);
    assert.equal(kept.payload.saved, 2);
    assert.equal(kept.type, 'watchlist_added', 'saves alone again');
    const members = await as(
      friend,
      async () =>
        (await t.sql(`select media_item_id from watchlist_group_titles($1)`, [post.id])).rows,
    );
    assert.equal(members.length, 2, 'the readers agree with the count');
  });
});

describe('a catalogue delete inside a presented post', () => {
  it('keeps the hidden watchlist post and its surviving save (Codex, PR 354)', async () => {
    const s = await uuid();
    const film = await title('movie', 'Backlog');
    await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [
      user,
      film,
    ]);
    await t.rankToCompletion(film, 'loved', (pivot, subject) => subject);
    await call(`rank_batch_note($1, $2, $3)`, [await uuid(), s, film]);
    await t.sql(
      `update feed_ranking_titles set placed_at = placed_at - interval '2 minutes'
        where event_id = (select id from feed_events where actor_id = $1 and type = 'ranking_batch_draft')`,
      [user],
    );
    const a = await save('Kept save');
    const b = await save('Deleted save');
    await call(`rank_batch_finalize($1, $2)`, [await uuid(), s]);
    const [post] = await visibleTo(friend);
    assert.equal(post.payload.count, 3);
    const hidden = (await posts()).find((p) => p.type === 'watchlist_added');
    assert.equal(hidden.presented_in, post.id);
    assert.equal(hidden.media_item_id, b, 'the hidden post leads with the title to delete');

    await t.sql(`delete from media_items where id = $1`, [b]);

    const after = await posts();
    const child = after.find((p) => p.id === hidden.id);
    assert.ok(child, 'the hidden post survived');
    assert.equal(child.media_item_id, a);
    assert.equal(child.presented_in, post.id, 'still shown through its session');
    const session = after.find((p) => p.id === post.id);
    assert.equal(session.payload.count, 2);
    const sheet = await sheetAs(friend, post.id);
    assert.equal(sheet.length, 2, 'the readers agree with the count');
    assert.ok(sheet.some((r) => r.media_item_id === a));
  });
});

describe('a delayed ranking note (Codex, PR 354)', () => {
  it('joins as the session’s first event and moves the start back, so the window still ends 30 minutes after it', async () => {
    const r = await rank('Ranked first, noted late', { note: false });
    await t.sql(
      `update feed_events set created_at = created_at - interval '5 minutes',
              causal_at = causal_at - interval '5 minutes'
        where actor_id = $1 and type = 'title_ranked'`,
      [user],
    );
    await save('Saved meanwhile');
    const w = (await posts()).find((p) => p.type === 'watchlist_added');
    const joined = await call(`rank_group_note($1, $2)`, [await uuid(), r.id]);
    assert.equal(joined.status, 'joined');
    assert.equal(joined.event_id, w.id);
    const all = await posts();
    const ranking = all.find((p) => p.type === 'title_ranked');
    const session = all.find((p) => p.id === w.id);
    assert.equal(
      new Date(session.payload.started_at).getTime(),
      ranking.created_at.getTime(),
      'the start is the ranking, the first event',
    );
    // 30 minutes after the ranking, not after the save: the next save starts a new post.
    await t.sql(
      `update feed_events set payload = payload || jsonb_build_object('started_at',
              now() - interval '30 minutes') where id = $1`,
      [w.id],
    );
    await save('Too late');
    assert.equal((await visibleTo(friend)).length, 2);
  });
});

describe('recency and pagination', () => {
  /** The Feed's own keyset, as `activityRows` sends it, for `viewer`. */
  const page = (viewer, actors, cursor, limit) =>
    as(viewer, async () => {
      const where = cursor
        ? `and (causal_at < $3 or (causal_at = $3 and causal_step < $4)
                or (causal_at = $3 and causal_step = $4 and id > $5))`
        : '';
      const params = cursor
        ? [actors, limit, cursor.causal_at, cursor.causal_step, cursor.id]
        : [actors, limit];
      const { rows } = await t.sql(
        `select id, causal_at, causal_step from feed_events
          where actor_id = any ($1::uuid[]) ${where}
          order by causal_at desc, causal_step desc, id
          limit $2`,
        params,
      );
      return rows;
    });

  it('a growing session moves forward, never back, and keeps created_at and started_at', async () => {
    await save('One');
    const [w0] = await posts();
    await age(10);
    await save('Two');
    const [w1] = await posts();
    assert.ok(w1.causal_at > w0.causal_at - 10 * 60_000, 'moved forward');
    assert.equal(w1.created_at.getTime(), w0.created_at.getTime() - 10 * 60_000);
    assert.equal(
      new Date(w1.payload.started_at).getTime(),
      new Date(w0.payload.started_at).getTime() - 10 * 60_000,
      'started_at is the anchor and never moves on its own',
    );
    assert.equal(w1.causal_step, 0);
  });

  it('a card that moves while a reader pages is never served twice, and is at the top on refresh', async () => {
    // Three people: the session's author and two others, interleaved in time.
    const other = await t.createUser({ username: `as_other_${seq}` });
    await t.sql(
      `insert into follows (follower_id, followee_id, state) values ($1, $2, 'approved')`,
      [friend, other],
    );
    const actors = [user, other];
    await save('Session start');
    const [session] = await posts();
    await age(20);
    await t.actAs(other);
    for (let i = 0; i < 4; i += 1) {
      await call(`set_watchlist($1, $2, true)`, [await uuid(), await title('movie', `O${i}`)]);
      // One post each: no window can hold them.
      await t.sql(
        `update feed_events set created_at = created_at - interval '1 hour',
                causal_at = causal_at - make_interval(mins => 10 - $2::int),
                payload = payload || jsonb_build_object('started_at', now() - interval '1 hour')
          where actor_id = $1 and causal_at > now() - interval '1 minute'`,
        [other, i],
      );
    }
    await t.actAs(user);

    const first = await page(friend, actors, null, 2);
    const seenIds = new Set(first.map((r) => r.id));
    assert.ok(!seenIds.has(session.id), 'the session starts below the first page');

    // The reader is mid-scroll; the session gains a member and moves to the top.
    await save('Joins later');
    const second = await page(friend, actors, first.at(-1), 2);
    const third = await page(friend, actors, second.at(-1), 10);
    const later = [...second, ...third].map((r) => r.id);
    assert.ok(
      later.every((id) => !seenIds.has(id)),
      'no duplicate across the boundary',
    );
    assert.equal(new Set(later).size, later.length);

    const refreshed = await page(friend, actors, null, 2);
    assert.equal(refreshed[0].id, session.id, 'on refresh it leads, with the same id');
  });

  it('a card already read that then moves is not served again below the cursor', async () => {
    await save('Top');
    const [session] = await posts();
    const first = await page(friend, [user], null, 1);
    assert.equal(first[0].id, session.id);
    await save('Grows');
    const rest = await page(friend, [user], first[0], 10);
    assert.ok(!rest.some((r) => r.id === session.id));
  });
});

describe('an Unranked sitting in the same half hour', () => {
  it('a sitting that ends after a save of its half hour presents that watchlist post', async () => {
    const s = await uuid();
    const film = await title('movie', 'Backlog');
    await t.sql(`insert into user_media (user_id, media_item_id) values ($1, $2)`, [
      user,
      film,
    ]);
    await t.rankToCompletion(film, 'loved', (pivot, subject) => subject);
    await call(`rank_batch_note($1, $2, $3)`, [await uuid(), s, film]);
    // The draft began before the save, so the save could not join a published post.
    await t.sql(
      `update feed_ranking_titles set placed_at = placed_at - interval '2 minutes'
        where event_id = (select id from feed_events where actor_id = $1 and type = 'ranking_batch_draft')`,
      [user],
    );
    const saved = await save('Saved mid-sitting');
    const done = await call(`rank_batch_finalize($1, $2)`, [await uuid(), s]);
    assert.equal(done.status, 'ok');
    const seen = await visibleTo(friend);
    assert.equal(seen.length, 1, 'one post for the half hour');
    assert.equal(seen[0].type, 'ranking_batch');
    assert.equal(seen[0].payload.count, 2);
    assert.equal(seen[0].media_item_id, saved);
  });
});
