/**
 * The mutation check — `npm run test:race:mutants`. Deliberately not part of
 * `test:race`, and deliberately not a `.test.mjs`.
 *
 * A race suite that passes proves the database behaves; it does not prove the suite
 * would notice if the database stopped behaving. So each defect this run found is
 * reintroduced into a disposable database — as a wrong version of the function, which
 * is why these bodies do not need to track the real ones — and the corresponding
 * assertion is required to go red.
 *
 * Five mutants:
 *
 *   1. `add_comment` with `_lock_pair` deleted. The blocker must stop waiting, and a
 *      notification must survive the block. (Hardening blocker B.)
 *   2. `add_comment` with the visibility check moved after the lock. The refusal must
 *      become timeable — a `57014` where the honest version answers `P0002` at once.
 *      (Review 25's MAJOR.)
 *   3. `_maybe_activate_invite` with the `activated_at is null` guard dropped from its
 *      UPDATE. Activation must become repeatable — a second `activated: true`, a second
 *      inbox row, and an Invite Instigator count that grows with every ranking. This is
 *      the mutant whose damage stays *plausible in the schema*: `activated_at` still
 *      holds a real timestamp, and only the counts are wrong.
 *   4. `redeem_invite` with `on conflict do nothing` weakened to an upsert. Attribution
 *      must become movable — a second token takes the credit — which is the defect the
 *      whole redemption design is shaped around.
 *   5. `redeem_invite` with the row lock dropped from its token read — the version
 *      independent review 26 rejected. The revocation must stop waiting, so a link its
 *      owner has just withdrawn still pays out to them.
 */
import { createRaceDb, fixtures, startCluster, stopCluster } from './harness.mjs';

const NO_LOCK = `
create or replace function add_comment(p_operation_id uuid, p_feed_event_id uuid, p_body text, p_has_spoilers boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_body text := btrim(coalesce(p_body,'')); v_id uuid;
begin
  perform assert_can_write();
  if not _claim_operation(p_operation_id,'add_comment') then return jsonb_build_object('status','already_applied'); end if;
  perform _assert_operation_rate('add_comment','comments.max_per_day',100);
  perform _assert_comment_length(v_body);
  select e.actor_id into v_actor from feed_events e where e.id = p_feed_event_id and can_view_profile(auth.uid(), e.actor_id);
  if v_actor is null then raise exception 'no such activity' using errcode='P0002'; end if;
  insert into comments (feed_event_id, author_id, body, has_spoilers) values (p_feed_event_id, auth.uid(), v_body, coalesce(p_has_spoilers,false)) returning id into v_id;
  if v_actor <> auth.uid() then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_actor,'comment',auth.uid(),'feed_event',p_feed_event_id, jsonb_build_object('comment_id', v_id));
  end if;
  return jsonb_build_object('status','ok','comment_id',v_id);
end; $$;`;

const SPLIT_LOOKUP = `
create or replace function add_comment(p_operation_id uuid, p_feed_event_id uuid, p_body text, p_has_spoilers boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_body text := btrim(coalesce(p_body,'')); v_id uuid;
begin
  perform assert_can_write();
  if not _claim_operation(p_operation_id,'add_comment') then return jsonb_build_object('status','already_applied'); end if;
  perform _assert_operation_rate('add_comment','comments.max_per_day',100);
  perform _assert_comment_length(v_body);
  select e.actor_id into v_actor from feed_events e where e.id = p_feed_event_id;
  if v_actor is null then raise exception 'no such activity' using errcode='P0002'; end if;
  if v_actor <> auth.uid() then perform _lock_pair(auth.uid(), v_actor); end if;
  if not can_view_profile(auth.uid(), v_actor) then raise exception 'no such activity' using errcode='P0002'; end if;
  insert into comments (feed_event_id, author_id, body, has_spoilers) values (p_feed_event_id, auth.uid(), v_body, coalesce(p_has_spoilers,false)) returning id into v_id;
  if v_actor <> auth.uid() then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_actor,'comment',auth.uid(),'feed_event',p_feed_event_id, jsonb_build_object('comment_id', v_id));
  end if;
  return jsonb_build_object('status','ok','comment_id',v_id);
end; $$;`;

/**
 * Mutant 3. The guard is what makes the transition happen once; without it every ranking
 * past the tenth re-activates.
 */
const REPEATABLE_ACTIVATION = `
create or replace function _maybe_activate_invite(p_user uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_needed integer; v_inviter uuid;
begin
  select ia.inviter_id into v_inviter from invite_attributions ia
   where ia.invitee_id = p_user and ia.accepted_at is not null;
  if not found then return false; end if;
  select coalesce((select (value)::integer from app_config where key = 'invite.activation_rankings'), 10) into v_needed;
  if (select count(*) from rankings r where r.user_id = p_user) < v_needed then return false; end if;
  update invite_attributions set activated_at = now() where invitee_id = p_user;
  if not found then return false; end if;
  if v_inviter is null then return true; end if;
  perform _lock_pair(p_user, v_inviter);
  if blocked_between(p_user, v_inviter) then return true; end if;
  insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
  values (v_inviter, 'invite_activated', p_user, 'profile', p_user);
  return true;
end; $$;`;

/**
 * Mutant 5. The token read without its row lock — the version independent review 26
 * rejected. A revocation commits inside the window and the attribution lands against a
 * link its owner had already withdrawn.
 */
const UNLOCKED_TOKEN = `
create or replace function redeem_invite(p_operation_id uuid, p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_self uuid := auth.uid(); v_token_id uuid; v_inviter uuid; v_env text;
begin
  perform assert_can_write();
  if not _claim_operation(p_operation_id,'redeem_invite') then return jsonb_build_object('status','already_applied'); end if;
  perform _assert_operation_rate('redeem_invite','invite.max_redeem_attempts_per_day',10);
  select coalesce((select value #>> '{}' from app_config where key = 'env.name'), 'nonprod') into v_env;
  select t.id, t.owner_id into v_token_id, v_inviter from invite_tokens t
   where t.token = p_token and t.revoked_at is null and t.env = v_env;
  if v_token_id is null then return jsonb_build_object('status','refused','reason','invalid'); end if;
  if v_inviter = v_self then return jsonb_build_object('status','refused','reason','self'); end if;
  perform _lock_pair(v_self, v_inviter);
  if blocked_between(v_self, v_inviter) then return jsonb_build_object('status','refused','reason','blocked'); end if;
  insert into invite_attributions (invitee_id, inviter_id, token_id, accepted_at)
  values (v_self, v_inviter, v_token_id, now())
  on conflict (invitee_id) do nothing;
  return jsonb_build_object('status','ok','inviter_id',v_inviter);
end; $$;`;

/** Mutant 4. An upsert instead of a no-op conflict: a second token moves the credit. */
const MOVABLE_ATTRIBUTION = `
create or replace function redeem_invite(p_operation_id uuid, p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_self uuid := auth.uid(); v_token_id uuid; v_inviter uuid; v_env text;
begin
  perform assert_can_write();
  if not _claim_operation(p_operation_id,'redeem_invite') then return jsonb_build_object('status','already_applied'); end if;
  perform _assert_operation_rate('redeem_invite','invite.max_redeem_attempts_per_day',10);
  select coalesce((select value #>> '{}' from app_config where key = 'env.name'), 'nonprod') into v_env;
  select t.id, t.owner_id into v_token_id, v_inviter from invite_tokens t
   where t.token = p_token and t.revoked_at is null and t.env = v_env;
  if v_token_id is null then return jsonb_build_object('status','refused','reason','invalid'); end if;
  if v_inviter = v_self then return jsonb_build_object('status','refused','reason','self'); end if;
  perform _lock_pair(v_self, v_inviter);
  if blocked_between(v_self, v_inviter) then return jsonb_build_object('status','refused','reason','blocked'); end if;
  insert into invite_attributions (invitee_id, inviter_id, token_id, accepted_at)
  values (v_self, v_inviter, v_token_id, now())
  on conflict (invitee_id) do update set inviter_id = excluded.inviter_id, token_id = excluded.token_id;
  return jsonb_build_object('status','ok','inviter_id',v_inviter);
end; $$;`;

await startCluster();
const results = [];

// --- Mutant 1: the pair lock removed. The block must stop waiting, and a row must survive.
{
  const db = await createRaceDb();
  const fx = fixtures(db);
  await db.sql(NO_LOCK);
  const actor = await fx.createUser();
  const victim = await fx.createUser();
  const movie = await fx.createMovie('Mutant 1');
  const event = await fx.feedEvent(victim, movie);

  await db.armBarrier('notifications', 'm1');
  const ctl = await db.controller();
  await ctl.hold('m1');
  const t1 = await db.session('writer');
  const t2 = await db.session('blocker');
  await t1.actAs(actor); await t1.begin(); await t1.pauseAt('m1');
  const p = t1.start(`select add_comment($1,$2,$3) as r`, [crypto.randomUUID(), event, 'x']);
  await t1.awaitBlocked();
  await t2.actAs(victim); await t2.begin();
  const b = t2.start(`select block($1,$2) as r`, [crypto.randomUUID(), actor]);

  let blockedOnPair = true;
  try { await t2.awaitBlocked({ on: 'advisory', advisoryKey: await db.pairKey(actor, victim), timeoutMs: 1500 }); }
  catch { blockedOnPair = false; }

  await b; await t2.commit();
  await ctl.release('m1'); await p; await t1.commit();
  const rows = await db.rows(`select 1 from notifications where recipient_id=$1 and actor_id=$2`, [victim, actor]);

  results.push(['pair lock removed -> blocker no longer waits', blockedOnPair === false]);
  results.push(['pair lock removed -> notification survives the block', rows.length === 1]);
  await t1.end(); await t2.end(); await ctl.end(); await db.close();
}

// --- Mutant 2: the split lookup. The refusal must become timeable.
{
  const db = await createRaceDb();
  const fx = fixtures(db);
  await db.sql(SPLIT_LOOKUP);
  const attacker = await fx.createUser();
  const target = await fx.createUser();
  const movie = await fx.createMovie('Mutant 2');
  const event = await fx.feedEvent(target, movie);
  await db.sql(`insert into blocks (blocker_id, blocked_id) values ($1,$2)`, [target, attacker]);

  const holder = await db.session('holder');
  await holder.actAs(attacker); await holder.begin();
  await holder.q(`select unfollow($1,$2)`, [crypto.randomUUID(), target]);

  const probe = await db.session('probe');
  await probe.actAs(attacker);
  await probe.q(`set statement_timeout = '1500ms'`);
  const err = await probe.errorFrom(`select add_comment($1,$2,$3)`, [crypto.randomUUID(), event, 'p']);

  results.push(['split lookup -> the refusal waits (57014), i.e. the oracle is back', err?.code === '57014']);
  await holder.rollback(); await holder.end(); await probe.end(); await db.close();
}

// --- Mutant 3: activation repeats. One person is counted as several.
{
  const db = await createRaceDb();
  const fx = fixtures(db);
  const inviter = await fx.createUser();
  const invitee = await fx.createUser();

  const minter = await db.session('minter');
  await minter.actAs(inviter);
  const token = (await minter.one(`select create_invite_link($1) as r`, [crypto.randomUUID()])).r.token;
  await minter.end();

  const s = await db.session('invitee');
  await s.actAs(invitee);
  await s.q(`select redeem_invite($1,$2)`, [crypto.randomUUID(), token]);

  const rankOne = async (n) => {
    const film = (
      await db.rows(
        `insert into media_items (kind, tmdb_id, title, provenance)
         values ('movie', $1, $2, 'manual') returning id`,
        [-n, `Mutant 3 number ${n}`],
      )
    )[0].id;
    await db.sql(`insert into user_media (user_id, media_item_id, bucket) values ($1,$2,'loved')`, [
      invitee,
      film,
    ]);
    let step = (await s.one(`select rank_start($1,'loved') as r`, [film])).r;
    for (let g = 0; !step.done && g < 20; g += 1) {
      step = (await s.one(`select rank_answer($1,$2) as r`, [step.session_id, film])).r;
    }
    return step;
  };

  // Nine honestly, then the mutant, so the tenth and the eleventh both activate.
  for (let i = 0; i < 9; i += 1) await rankOne(700000 + i);
  await db.sql(REPEATABLE_ACTIVATION);
  const tenth = await rankOne(700010);
  const eleventh = await rankOne(700011);

  const notices = await db.rows(
    `select 1 from notifications where recipient_id=$1 and type='invite_activated'`,
    [inviter],
  );

  results.push([
    'activation guard dropped -> a later ranking reports activated again',
    tenth.activated === true && eleventh.activated === true,
  ]);
  results.push(['activation guard dropped -> the inviter is told twice', notices.length > 1]);
  await s.end();
  await db.close();
}

// --- Mutant 4: attribution moves. A second token steals the credit.
{
  const db = await createRaceDb();
  const fx = fixtures(db);
  const first = await fx.createUser();
  const second = await fx.createUser();
  const invitee = await fx.createUser();

  const tokens = [];
  for (const owner of [first, second]) {
    const m = await db.session('minter');
    await m.actAs(owner);
    tokens.push((await m.one(`select create_invite_link($1) as r`, [crypto.randomUUID()])).r.token);
    await m.end();
  }

  await db.sql(MOVABLE_ATTRIBUTION);
  const s = await db.session('invitee');
  await s.actAs(invitee);
  await s.q(`select redeem_invite($1,$2)`, [crypto.randomUUID(), tokens[0]]);
  await s.q(`select redeem_invite($1,$2)`, [crypto.randomUUID(), tokens[1]]);

  const rows = await db.rows(`select inviter_id from invite_attributions where invitee_id=$1`, [
    invitee,
  ]);

  results.push([
    'conflict-do-nothing weakened to an upsert -> a second token steals the credit',
    rows[0]?.inviter_id === second,
  ]);
  await s.end();
  await db.close();
}

// --- Mutant 5: the token read without its row lock. A revoked link still pays out.
{
  const db = await createRaceDb();
  const fx = fixtures(db);
  const inviter = await fx.createUser();
  const invitee = await fx.createUser();

  const minter = await db.session('minter');
  await minter.actAs(inviter);
  const token = (await minter.one(`select create_invite_link($1) as r`, [crypto.randomUUID()])).r
    .token;
  await minter.end();

  await db.sql(UNLOCKED_TOKEN);

  // Same shape as mutant 1: the writer is stopped mid-body and the other transaction
  // must be found *waiting*. With the row lock removed there is nothing to wait on, so
  // the revocation commits straight through the window the redemption is sitting in.
  await db.armBarrier('invite_attributions', 'm5');
  const ctl = await db.controller();
  await ctl.hold('m5');

  const t1 = await db.session('redeemer');
  const t2 = await db.session('revoker');
  await t1.actAs(invitee);
  await t2.actAs(inviter);

  await t1.begin();
  await t1.pauseAt('m5');
  const p = t1.start(`select redeem_invite($1,$2) as r`, [crypto.randomUUID(), token]);
  await t1.awaitBlocked();

  await t2.begin();
  const r = t2.start(`select revoke_invite_link($1) as r`, [crypto.randomUUID()]);

  let waitedOnTheToken = true;
  try {
    await t2.awaitBlocked({ on: 'transactionid', timeoutMs: 1500 });
  } catch {
    waitedOnTheToken = false;
  }

  await r;
  await t2.commit();
  await ctl.release('m5');
  await p;
  await t1.commit();

  results.push([
    'token read without its row lock -> a revocation commits through the redemption',
    waitedOnTheToken === false,
  ]);

  await t1.end();
  await t2.end();
  await ctl.end();
  await db.close();
}

await stopCluster();
let ok = true;
for (const [name, passed] of results) {
  console.log(`${passed ? 'DETECTED ' : 'MISSED   '} ${name}`);
  if (!passed) ok = false;
}
process.exit(ok ? 0 : 1);
