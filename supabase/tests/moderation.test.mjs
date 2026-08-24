import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Reporting, suspension, and the guard that makes suspension mean something.
 *
 * The last two suites matter most. A suspended account that is merely hidden
 * still ranks, follows and tags into a void, and everything it did appears at
 * once the moment the suspension lifts — so the tests here check that writes are
 * actually refused, and that every write RPC invokes the guard rather than
 * merely coexisting with it.
 */

let t;
let reporter;
let offender;
let bystander;

let seq = 60000;

before(async () => {
  t = await createTestDb();
  reporter = await t.createUser({ username: 'reporter' });
  offender = await t.createUser({ username: 'offender' });
  bystander = await t.createUser({ username: 'bystander' });
  await t.actAs(reporter);
});

after(async () => {
  await t?.close();
});

const rpc = async (query, params) => (await t.sql(query, params)).rows[0].r;

describe('filing a report', () => {
  it('records one, resolving the owner server-side', async () => {
    await t.actAs(reporter);
    const r = await rpc(`select report('profile', $1, 'harassment', 'said a mean thing') as r`, [
      offender,
    ]);
    assert.equal(r.received, true);

    const { rows } = await t.sql(
      `select reporter_id, subject_owner, state, reason from reports where subject_id = $1`,
      [offender],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reporter_id, reporter);
    assert.equal(rows[0].subject_owner, offender, 'the owner must be resolved, not supplied');
    assert.equal(rows[0].state, 'open');
  });

  it('is idempotent, so reporting twice cannot be used to pile on', async () => {
    await t.actAs(bystander);
    await rpc(`select report('profile', $1, 'spam') as r`, [offender]);
    await rpc(`select report('profile', $1, 'spam') as r`, [offender]);
    const { rows } = await t.sql(
      `select count(*)::integer as n from reports where reporter_id = $1 and subject_id = $2`,
      [bystander, offender],
    );
    assert.equal(rows[0].n, 1);
  });

  it('refuses a report of your own content', async () => {
    await t.actAs(reporter);
    await assert.rejects(
      () => t.sql(`select report('profile', $1, 'spam') as r`, [reporter]),
      /your own content/i,
    );
  });

  it('refuses an unknown subject without revealing whether it exists', async () => {
    await t.actAs(reporter);
    await assert.rejects(
      () => t.sql(`select report('list', gen_random_uuid(), 'spam') as r`),
      /no such subject/i,
    );
  });

  it('rejects a reason outside the taxonomy', async () => {
    await t.actAs(reporter);
    await assert.rejects(
      () => t.sql(`select report('profile', $1, 'i just do not like them') as r`, [offender]),
      /reports_known_reason/i,
    );
  });

  it('enforces the daily ceiling', async () => {
    const spammer = await t.createUser({ username: 'over_reporter' });
    await t.sql(`update app_config set value = '2'::jsonb where key = 'report.max_per_day'`);
    await t.actAs(spammer);

    for (let i = 0; i < 2; i += 1) {
      const target = await t.createUser({ username: `target_${i}` });
      await rpc(`select report('profile', $1, 'spam') as r`, [target]);
    }

    const last = await t.createUser({ username: 'one_too_many' });
    await assert.rejects(
      () => t.sql(`select report('profile', $1, 'spam') as r`, [last]),
      /limit reached/i,
    );

    await t.sql(`update app_config set value = '20'::jsonb where key = 'report.max_per_day'`);
  });

  it('resolves the owner of a reported list rather than trusting the caller', async () => {
    const { rows } = await t.sql(
      `insert into lists (owner_id, title, visibility) values ($1, 'Bad List', 'public') returning id`,
      [offender],
    );
    await t.actAs(reporter);
    await rpc(`select report('list_title', $1, 'hate_speech') as r`, [rows[0].id]);
    const { rows: got } = await t.sql(
      `select subject_owner from reports where subject_id = $1`,
      [rows[0].id],
    );
    assert.equal(got[0].subject_owner, offender);
  });
});

/**
 * The two subjects 20260825000100 added, and the one it deliberately did not.
 *
 * These are the surfaces that carry most of the writing in the product, and until that
 * migration neither had a value in `report_subject` — so the whole spine above existed
 * for usernames and list titles and for nothing anybody writes a paragraph in.
 *
 * What is worth testing here is not that the enum grew. It is that the owner is
 * resolved from the *canonical authorship column* in both cases, that a private note
 * stays outside the system entirely, and that the duplicate guarantee survives the one
 * case that would have broken it — two authors reviewing the same film.
 */
describe('reporting a comment', () => {
  let eventId;
  let commentId;

  before(async () => {
    const movie = await t.createMovie('a film with a comment under it', 60101);
    const { rows: ev } = await t.sql(
      `insert into feed_events (actor_id, type, media_item_id, payload)
       values ($1, 'title_ranked', $2, '{"position":1,"bucket":"loved","category":"movies","score":10}')
       returning id`,
      [bystander, movie],
    );
    eventId = ev[0].id;

    await t.actAs(offender);
    const { rows } = await t.sql(
      `select add_comment(gen_random_uuid(), $1, 'something abusive', false) as r`,
      [eventId],
    );
    commentId = rows[0].r.id ?? rows[0].r.comment_id;
  });

  it('resolves the author from comments.author_id, not from the event actor', async () => {
    await t.actAs(reporter);
    const r = await rpc(`select report('comment', $1, 'harassment') as r`, [commentId]);
    assert.equal(r.received, true);

    const { rows } = await t.sql(
      `select subject_owner, subject_type from reports where subject_id = $1`,
      [commentId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subject_type, 'comment');
    assert.equal(
      rows[0].subject_owner,
      offender,
      'a comment belongs to whoever wrote it, not to whoever it was written under',
    );
  });

  it('refuses a comment that no longer exists, the way every stale row is refused', async () => {
    await t.actAs(reporter);
    await assert.rejects(
      () => t.sql(`select report('comment', gen_random_uuid(), 'spam') as r`),
      /no such subject/i,
    );
  });

  it('refuses your own comment', async () => {
    await t.actAs(offender);
    await assert.rejects(
      () => t.sql(`select report('comment', $1, 'spam') as r`, [commentId]),
      /your own content/i,
    );
  });
});

describe('reporting a review', () => {
  let film;
  let reviewId;

  const publicNote = async (user, mediaItemId, text) => {
    await t.actAs(user);
    await t.sql(`select log_watched(gen_random_uuid(), $1, null, $2) as r`, [mediaItemId, text]);
    await t.sql(
      `select save_note(gen_random_uuid(), $1, $2, null, 'public'::note_visibility) as r`,
      [mediaItemId, text],
    );
    const { rows } = await t.sql(`select id from user_media where user_id = $1 and media_item_id = $2`, [
      user,
      mediaItemId,
    ]);
    return rows[0].id;
  };

  before(async () => {
    film = await t.createMovie('a film two people reviewed', 60102);
    reviewId = await publicNote(offender, film, 'an abusive review');
  });

  it('resolves the author from the user_media row the review lives on', async () => {
    await t.actAs(reporter);
    const r = await rpc(`select report('review', $1, 'hate_speech') as r`, [reviewId]);
    assert.equal(r.received, true);

    const { rows } = await t.sql(
      `select subject_owner, subject_type from reports where subject_id = $1`,
      [reviewId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subject_type, 'review');
    assert.equal(rows[0].subject_owner, offender, 'the owner must be resolved, not supplied');
  });

  /**
   * The defect the surrogate id exists to prevent.
   *
   * Reporting a review by its `media_item_id` would have made these two reports collide
   * on `reports_one_open_per_reporter`, so the second would hit `on conflict do nothing`
   * and vanish — while the reporter was told it had been received. Two distinct rows is
   * the whole justification for `user_media.id`.
   */
  it('keeps two authors reviewing one film as two reportable subjects', async () => {
    const second = await publicNote(bystander, film, 'a different abusive review');
    assert.notEqual(second, reviewId);

    await t.actAs(reporter);
    await rpc(`select report('review', $1, 'spam') as r`, [second]);

    const { rows } = await t.sql(
      `select count(*)::integer as n from reports
        where reporter_id = $1 and subject_type = 'review'`,
      [reporter],
    );
    assert.equal(rows[0].n, 2, 'one complaint per review, not one per title');
  });

  it('is still idempotent for one reporter against one review', async () => {
    const third = await t.createMovie('a film reported twice', 60103);
    const id = await publicNote(offender, third, 'more of the same');

    await t.actAs(reporter);
    await rpc(`select report('review', $1, 'spam') as r`, [id]);
    await rpc(`select report('review', $1, 'spam') as r`, [id]);

    const { rows } = await t.sql(
      `select count(*)::integer as n from reports where reporter_id = $1 and subject_id = $2`,
      [reporter, id],
    );
    assert.equal(rows[0].n, 1);
  });

  /**
   * A private note has exactly one reader — its author — so there is nobody it could
   * harm and nobody who could report it. The subject must not become the probe that
   * asks the server whether a row carries private writing.
   */
  it('refuses a note that is private, so a private note stays unreportable', async () => {
    const secret = await t.createMovie('a film with a private note', 60104);
    await t.actAs(offender);
    await t.sql(`select log_watched(gen_random_uuid(), $1, null, 'a private thought') as r`, [
      secret,
    ]);
    await t.sql(
      `select save_note(gen_random_uuid(), $1, 'a private thought', null, 'private'::note_visibility) as r`,
      [secret],
    );
    const { rows } = await t.sql(
      `select id from user_media where user_id = $1 and media_item_id = $2`,
      [offender, secret],
    );

    await t.actAs(reporter);
    await assert.rejects(
      () => t.sql(`select report('review', $1, 'spam') as r`, [rows[0].id]),
      /no such subject/i,
    );
  });

  it('has no subject for a private note at all', async () => {
    const { rows } = await t.sql(
      `select enumlabel from pg_enum e
         join pg_type ty on ty.oid = e.enumtypid
        where ty.typname = 'report_subject'`,
    );
    const labels = rows.map((r) => r.enumlabel);
    assert.ok(labels.includes('comment'), 'comment must be reportable');
    assert.ok(labels.includes('review'), 'review must be reportable');
    assert.ok(!labels.includes('note'), 'a private note must have no reporting path');
    assert.ok(!labels.includes('private_note'), 'a private note must have no reporting path');
  });

  it('rejects a subject outside the taxonomy entirely', async () => {
    await t.actAs(reporter);
    await assert.rejects(
      () => t.sql(`select report('reaction', $1, 'spam') as r`, [reviewId]),
      /invalid input value for enum/i,
    );
  });
});

describe('who can see a report', () => {
  it('shows a reporter only their own', async () => {
    const { rows } = await t.asUser(reporter, () => t.sql(`select subject_id from reports`));
    assert.ok(rows.length > 0, 'the reporter must see what they filed');
    assert.ok(
      rows.every((r) => r.subject_id !== null),
      'sanity',
    );
    const { rows: others } = await t.asUser(reporter, () =>
      t.sql(`select id from reports where reporter_id <> $1`, [reporter]),
    );
    assert.equal(others.length, 0, 'a reporter must not see other people reports');
  });

  it('never tells the reported user they were reported', async () => {
    const { rows } = await t.asUser(offender, () => t.sql(`select id from reports`));
    assert.equal(rows.length, 0);
  });

  it('keeps the moderation log operator-only', async () => {
    await t.sql(
      `insert into moderation_actions (subject_type, subject_id, action, rationale)
       values ('profile', $1, 'warn', 'first offence')`,
      [offender],
    );
    const { rows } = await t.asUser(reporter, () => t.sql(`select id from moderation_actions`));
    assert.equal(rows.length, 0);
  });
});

describe('suspension hides the account everywhere at once', () => {
  let suspended;

  before(async () => {
    suspended = await t.createUser({ username: 'suspended_one' });
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [suspended]);
  });

  it('hides a suspended public profile from other users', async () => {
    const { rows } = await t.asUser(bystander, () =>
      t.sql(`select id from profiles where id = $1`, [suspended]),
    );
    assert.equal(rows.length, 0);
  });

  it('hides it from anonymous readers too', async () => {
    const { rows } = await t.asAnon(() =>
      t.sql(`select id from profiles where id = $1`, [suspended]),
    );
    assert.equal(rows.length, 0, 'the public web pages must not serve a suspended account');
  });

  it('still lets the suspended user load their own profile', async () => {
    // So the interface can explain what happened rather than looking broken.
    const { rows } = await t.asUser(suspended, () =>
      t.sql(`select id from profiles where id = $1`, [suspended]),
    );
    assert.equal(rows.length, 1);
  });

  it('reaches every surface through the one visibility rule', async () => {
    // AD-5: feed, lists and tags all authorize through can_view_profile, so this
    // asserts the single rule rather than seven separate policies.
    const { rows } = await t.sql(`select can_view_profile($1, $2) as ok`, [bystander, suspended]);
    assert.equal(rows[0].ok, false);
  });
});

describe('a suspended account cannot write', () => {
  let suspended;
  let film;

  before(async () => {
    suspended = await t.createUser({ username: 'no_writing' });
    film = await t.createMovie('Suspended Film', seq++);
    await t.sql(`update profiles set status = 'suspended' where id = $1`, [suspended]);
    await t.actAs(suspended);
  });

  after(async () => {
    await t.actAs(reporter);
  });

  it('refuses to start a ranking', async () => {
    await assert.rejects(
      () => t.sql(`select rank_start($1, 'loved') as r`, [film]),
      /suspended/i,
      'suspension must stop ranking, not merely hide it',
    );
  });

  it('refuses to file a report', async () => {
    await assert.rejects(
      () => t.sql(`select report('profile', $1, 'spam') as r`, [offender]),
      /suspended/i,
    );
  });

  it('refuses every other ranking mutation', async () => {
    for (const call of [
      `select rank_answer(gen_random_uuid(), gen_random_uuid()) as r`,
      `select rank_skip(gen_random_uuid()) as r`,
      `select rank_back(gen_random_uuid()) as r`,
      `select rank_unrank(gen_random_uuid()) as r`,
      `select rank_reorder(gen_random_uuid(), 1) as r`,
      `select rank_rebucket(gen_random_uuid(), 'fine') as r`,
    ]) {
      await assert.rejects(() => t.sql(call), /suspended/i, `${call} was not guarded`);
    }
  });

  it('lets the account write again once restored', async () => {
    await t.sql(`update profiles set status = 'active' where id = $1`, [suspended]);
    await t.actAs(suspended);
    const r = await rpc(`select rank_start($1, 'loved') as r`, [film]);
    assert.equal(r.done, true, 'an empty band places directly');
  });
});

describe('the guard is wired in, not merely present', () => {
  /**
   * The first draft of this migration defined assert_can_write and never called
   * it, so suspension stopped nothing while the documentation said otherwise.
   * Asserting the wiring structurally is what stops that returning: a new write
   * RPC that forgets the guard fails here rather than in production.
   */
  /**
   * Two earlier versions of this assertion tried to identify which functions write,
   * and both were defeated on inspection.
   *
   * The first matched the name prefix `rank\_%` against a `prosrc` substring, so the
   * first write RPC not called `rank_something` — `follow`, `block`, `react`, all on
   * the roadmap — went unchecked, and a bare comment mentioning the guard satisfied
   * it. The second detected writes by regex, and a review broke it three ways in a
   * few minutes: `INSERT INTO` in uppercase slipped past a case-sensitive operator;
   * a read-only function returning the string `'please update your app'` was flagged
   * as a write; and a wrapper that writes only by calling an internal function was
   * missed entirely, which matters because delegating to a `_*_unguarded` body is
   * this schema's own architecture.
   *
   * So this no longer tries to detect writes. Every function a client can execute
   * must either call the guard or be named below as read-only. A new function is
   * therefore a test failure by default, and the author has to say which it is. That
   * is immune to letter case, to dynamic SQL, and to delegation, because it does not
   * inspect the body for anything except the guard call.
   */
  const READ_ONLY = [
    'can_i_view',
    'watch_tag_visible',
    'list_by_id',
    'list_items_by_list',
    'my_capabilities',
    'unranked_queue',
    'username_available',
    'search_titles',
    // Reachable only because search_titles runs as the caller and folds the query through
    // it. Pure, and writes nothing.
    'media_fold',
    // 20260816000000. Both are stable reads that apply AD-5 from the caller's own
    // perspective. A suspended account calling either changes nothing and learns
    // nothing it could not learn while active — can_view_profile already refuses a
    // suspended *subject*, which is the direction that matters.
    'public_notes',
    'community_score',
    // 20260816001100. A stable read whose entire population is the caller's own
    // approved followees, filtered by can_view_profile from the caller's side. A
    // suspended account calling it learns nothing new: can_view_profile already
    // refuses a suspended *subject*, so a suspended followee is absent from anybody's
    // number, and a suspended *caller* only ever sees their own following list — which
    // suspension does not hide from the person it was applied to.
    'following_score',
    // 20260817000300, widened by 20260819000100. A stable read filtered through
    // can_discover_profile from the caller's own side. A suspended account calling it
    // learns nothing new — and a suspended *subject* is still absent from everybody's
    // results, which is the direction that matters and which the new predicate keeps.
    'search_users',
    // 20260819000100. Identity only — handle, display name, avatar, visibility — for an
    // account the caller may find. It exists so a private account discovered in search
    // leads somewhere a follow request can be made from. Same predicate, same silence
    // for a blocked or suspended account.
    'profile_identity',
    // 20260817000200. security invoker, so it reads only the caller's own edges
    // through follows_read and blocks_read. Suspension does not hide a person's own
    // follow list from them, and this reports nothing else.
    'follow_state_with',
    // 20260817000200. Reads the caller's own block rows and projects the handle. A
    // suspended account can still see who it blocked, which is its own data.
    'my_blocks',
    // 20260817000400. A stable pairwise read, filtered by can_view_profile from the
    // caller's own side. A suspended *subject* is already absent from it.
    'taste_match',
    // 20260817000600. The caller's own inbox and nothing else. Suspension is about
    // what an account may do *to other people*; it does not make somebody unable to
    // read what was sent to them, and hiding a pending follow request from a
    // suspended account would leave it unanswerable if the suspension is lifted.
    'my_notifications',
    // 20260817001300. security invoker, so it can only ever return rows
    // title_recommendations_read already admits — which is the caller's own inbox.
    // Suspension is about what an account may do to other people; it does not make
    // somebody unable to read what was sent to them.
    'recommendations_to_me',
    // 20260817000800. A stable read of public notes on one title, filtered through
    // can_view_profile from the caller's own side. A suspended *author* is already
    // absent from it, which is the direction that matters.
    'title_reviews',
    // 20260817000800. The caller's own two switches, defaulted on. Suspension does not
    // hide somebody's own settings from them.
    'my_notification_preferences',
    // 20260817000600, and the one entry here that is not a read.
    //
    // `delete_account` skips the guard **deliberately**, which is why it is declared
    // here rather than fixed. Suspension is a moderation state about what somebody may
    // do to other people; erasure is not that. Refusing it would mean the accounts
    // most likely to want out are precisely the ones that cannot leave, and it would
    // make a suspension into an indefinite hold on somebody's data.
    //
    // It is the only writer in the schema that skips it, and it is safe to: it takes
    // no target, acts only on auth.uid(), and its effect is to remove the account
    // rather than to reach anybody else.
    'delete_account',
  ];

  /** Client-executable functions whose body does not call the guard. */
  const unguarded = async () => {
    const { rows } = await t.sql(
      `
      select p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         -- prokind is not filtered: a procedure is just as callable as a function.
         and (has_function_privilege('authenticated', p.oid, 'execute')
              or has_function_privilege('anon', p.oid, 'execute'))
         and not exists (
           select 1 from pg_depend d
            where d.objid = p.oid
              and d.classid = 'pg_proc'::regclass
              and d.deptype = 'e'
         )
         -- Comments stripped, so prose mentioning the guard cannot stand in for
         -- calling it.
         and regexp_replace(
               regexp_replace(p.prosrc, '/\\*.*?\\*/', ' ', 'gs'),
               '--[^\\n]*', ' ', 'g'
             ) !~* 'assert_can_write\\s*\\('
         and not (p.proname = any ($1))
       order by p.proname
    `,
      [READ_ONLY],
    );
    return rows.map((r) => r.proname);
  };

  it('has every client-callable function either guarded or declared read-only', async () => {
    assert.deepEqual(
      await unguarded(),
      [],
      'these are reachable by a suspended account and do not call the guard. Either ' +
        'call assert_can_write() or add the name to READ_ONLY above, deliberately.',
    );
  });

  it('would notice a new client-callable function that skips the guard', async () => {
    // Guards the guard. If the assertion above ever stops testing anything — which
    // is how both previous versions failed — this fails too.
    //
    // Deliberately shaped like the cases that defeated the old regex: it writes in
    // uppercase, and only by delegating to another function.
    await t.sql(`
      create function _probe_writer(p_note text)
      returns void language plpgsql security definer set search_path = public as $fn$
      begin
        INSERT INTO app_config (key, value) VALUES ('probe', to_jsonb(p_note))
          ON CONFLICT (key) DO UPDATE SET value = to_jsonb(p_note);
      end; $fn$;
    `);
    await t.sql(`
      create function _probe_delegating_rpc(p_note text)
      returns void language plpgsql security definer set search_path = public as $fn$
      begin
        -- assert_can_write(auth.uid()) is emphatically not called here
        perform _probe_writer(p_note);
      end; $fn$;
    `);
    await t.sql(`grant execute on function _probe_delegating_rpc(text) to authenticated`);

    try {
      assert.deepEqual(
        await unguarded(),
        ['_probe_delegating_rpc'],
        'an unguarded client-callable function must be caught even when it writes ' +
          'in uppercase through another function',
      );
    } finally {
      await t.sql(`drop function _probe_delegating_rpc(text)`);
      await t.sql(`drop function _probe_writer(text)`);
    }
  });

  it('does not expose the unguarded implementations to clients', async () => {
    const { rows } = await t.sql(`
      select p.proname, r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join unnest(array['anon','authenticated']) as r(rolname)
       where n.nspname = 'public'
         and p.proname like '%\\_unguarded'
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    `);
    assert.deepEqual(
      rows.map((r) => `${r.rolname} can call ${r.proname}`),
      [],
      'the unguarded implementation is directly reachable, which defeats the guard',
    );
  });
});
