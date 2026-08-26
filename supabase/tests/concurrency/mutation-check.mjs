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
 * The mutants:
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
 *   6. `set_bucket` with `_lock_media` deleted — M3, exactly as the register describes
 *      it. The bucketer must stop waiting, and `user_media.bucket` must end up
 *      disagreeing with `rankings.bucket`: invariant I3, from one account on two
 *      devices doing two ordinary things.
 *   7. `rank_answer` with its operation claim deleted. A replay must become a second
 *      genuine answer — a second comparison recorded, and a session narrowed twice for
 *      one judgement. This is the mutant that would otherwise pass a naive test: the
 *      *rows* still look plausible afterwards, and only the count of them is wrong.
 *   8. `_release_recommendations` with its state guard dropped. A dismissal stops being
 *      final.
 *   9. `add_comment` locking the activity's actor and **not** the person being replied
 *      to — which is what `20260826000600`'s first draft did once it had the actor's
 *      lock back. Mutants 1 and 2 both pass against it, because both are about the
 *      first pair. The reply target's blocker must stop waiting, and the reply notice
 *      must survive the block.
 *  10. `add_comment` taking both pair locks in *semantic* order — the activity's actor
 *      first, then the person replied to — instead of ascending uuid order. This is the
 *      mutant that looks most obviously correct: two locks, both taken, both re-checked.
 *      What it loses is the global ordering, and with it the guarantee that a reply and
 *      a companion save wanting the same two pairs cannot hold what the other wants.
 *
 * Mutants 1, 2, 9 and 10 all replace the *five*-argument `add_comment`. `20260826000600`
 * drops the four-argument form deliberately, and a mutant declared against the old
 * signature would create a second candidate rather than a wrong version of the real one
 * — leaving every call ambiguous and every result meaningless.
 */
import { createRaceDb, fixtures, startCluster, stopCluster } from './harness.mjs';

const NO_LOCK = `
create or replace function add_comment(p_operation_id uuid, p_feed_event_id uuid, p_body text, p_has_spoilers boolean default false, p_parent_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_body text := btrim(coalesce(p_body,'')); v_id uuid; v_root uuid := null; v_reply_to uuid := null;
begin
  perform assert_can_write();
  if not _claim_operation(p_operation_id,'add_comment') then return jsonb_build_object('status','already_applied'); end if;
  perform _assert_operation_rate('add_comment','comments.max_per_day',100);
  perform _assert_comment_length(v_body);
  select e.actor_id into v_actor from feed_events e where e.id = p_feed_event_id and can_view_profile(auth.uid(), e.actor_id);
  if v_actor is null then raise exception 'no such activity' using errcode='P0002'; end if;
  if p_parent_id is not null then
    v_root := _comment_root(p_parent_id, p_feed_event_id);
    if v_root is null then raise exception 'no such comment' using errcode='P0002'; end if;
    select c.author_id into v_reply_to from comments c where c.id = p_parent_id and c.deleted_at is null;
  end if;
  insert into comments (feed_event_id, author_id, body, has_spoilers, parent_id) values (p_feed_event_id, auth.uid(), v_body, coalesce(p_has_spoilers,false), v_root) returning id into v_id;
  if v_actor <> auth.uid() then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_actor,'comment',auth.uid(),'feed_event',p_feed_event_id, jsonb_build_object('comment_id', v_id));
  end if;
  if v_reply_to is not null and v_reply_to <> auth.uid() and v_reply_to <> v_actor then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_reply_to,'comment',auth.uid(),'feed_event',p_feed_event_id, jsonb_build_object('comment_id', v_id, 'reply_to', p_parent_id));
  end if;
  return jsonb_build_object('status','ok','comment_id',v_id,'parent_id',v_root);
end; $$;`;

const SPLIT_LOOKUP = `
create or replace function add_comment(p_operation_id uuid, p_feed_event_id uuid, p_body text, p_has_spoilers boolean default false, p_parent_id uuid default null)
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
 * Mutant 9. The actor's pair locked and re-checked exactly as `20260819000400` left it,
 * and the reply target's pair not locked at all. Everything mutants 1 and 2 assert still
 * holds here — which is the point: the first pair was never the part that was missing
 * once the rebuild was noticed.
 */
const ACTOR_ONLY_LOCK = `
create or replace function add_comment(p_operation_id uuid, p_feed_event_id uuid, p_body text, p_has_spoilers boolean default false, p_parent_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_body text := btrim(coalesce(p_body,'')); v_id uuid; v_root uuid := null; v_reply_author uuid := null; v_reply_to uuid := null; v_deleted_at timestamptz;
begin
  perform assert_can_write();
  if not _claim_operation(p_operation_id,'add_comment') then return jsonb_build_object('status','already_applied'); end if;
  perform _assert_operation_rate('add_comment','comments.max_per_day',100);
  perform _assert_comment_length(v_body);
  select e.actor_id into v_actor from feed_events e where e.id = p_feed_event_id and can_view_profile(auth.uid(), e.actor_id);
  if v_actor is null then raise exception 'no such activity' using errcode='P0002'; end if;
  if p_parent_id is not null then
    v_root := _comment_root(p_parent_id, p_feed_event_id);
    if v_root is null then raise exception 'no such comment' using errcode='P0002'; end if;
    select c.author_id, c.deleted_at into v_reply_author, v_deleted_at from comments c where c.id = p_parent_id;
    if v_reply_author is null or not can_view_profile(auth.uid(), v_reply_author) then raise exception 'no such comment' using errcode='P0002'; end if;
    if v_deleted_at is null then v_reply_to := v_reply_author; end if;
  end if;
  if v_actor <> auth.uid() then perform _lock_pair(auth.uid(), v_actor); end if;
  if not can_view_profile(auth.uid(), v_actor) then raise exception 'no such activity' using errcode='P0002'; end if;
  insert into comments (feed_event_id, author_id, body, has_spoilers, parent_id) values (p_feed_event_id, auth.uid(), v_body, coalesce(p_has_spoilers,false), v_root) returning id into v_id;
  if v_actor <> auth.uid() then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_actor,'comment',auth.uid(),'feed_event',p_feed_event_id, jsonb_build_object('comment_id', v_id));
  end if;
  if v_reply_to is not null and v_reply_to <> auth.uid() and v_reply_to <> v_actor then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_reply_to,'comment',auth.uid(),'feed_event',p_feed_event_id, jsonb_build_object('comment_id', v_id, 'reply_to', p_parent_id));
  end if;
  return jsonb_build_object('status','ok','comment_id',v_id,'parent_id',v_root);
end; $$;`;

/**
 * Mutant 10. Both locks, both re-checks, and the order taken from the semantics rather
 * than from the uuids. This is the version that passes every N1 assertion in the suite
 * and still breaks the schema's one global lock order.
 */
const SEMANTIC_ORDER = `
create or replace function add_comment(p_operation_id uuid, p_feed_event_id uuid, p_body text, p_has_spoilers boolean default false, p_parent_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_body text := btrim(coalesce(p_body,'')); v_id uuid; v_root uuid := null; v_reply_author uuid := null; v_reply_to uuid := null; v_deleted_at timestamptz;
begin
  perform assert_can_write();
  if not _claim_operation(p_operation_id,'add_comment') then return jsonb_build_object('status','already_applied'); end if;
  perform _assert_operation_rate('add_comment','comments.max_per_day',100);
  perform _assert_comment_length(v_body);
  select e.actor_id into v_actor from feed_events e where e.id = p_feed_event_id and can_view_profile(auth.uid(), e.actor_id);
  if v_actor is null then raise exception 'no such activity' using errcode='P0002'; end if;
  if p_parent_id is not null then
    v_root := _comment_root(p_parent_id, p_feed_event_id);
    if v_root is null then raise exception 'no such comment' using errcode='P0002'; end if;
    select c.author_id, c.deleted_at into v_reply_author, v_deleted_at from comments c where c.id = p_parent_id;
    if v_reply_author is null or not can_view_profile(auth.uid(), v_reply_author) then raise exception 'no such comment' using errcode='P0002'; end if;
    if v_deleted_at is null then v_reply_to := v_reply_author; end if;
  end if;
  if v_actor <> auth.uid() then perform _lock_pair(auth.uid(), v_actor); end if;
  if v_reply_author is not null and v_reply_author <> auth.uid() and v_reply_author <> v_actor then perform _lock_pair(auth.uid(), v_reply_author); end if;
  if not can_view_profile(auth.uid(), v_actor) then raise exception 'no such activity' using errcode='P0002'; end if;
  if v_reply_author is not null and not can_view_profile(auth.uid(), v_reply_author) then raise exception 'no such comment' using errcode='P0002'; end if;
  insert into comments (feed_event_id, author_id, body, has_spoilers, parent_id) values (p_feed_event_id, auth.uid(), v_body, coalesce(p_has_spoilers,false), v_root) returning id into v_id;
  if v_actor <> auth.uid() then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_actor,'comment',auth.uid(),'feed_event',p_feed_event_id, jsonb_build_object('comment_id', v_id));
  end if;
  if v_reply_to is not null and v_reply_to <> auth.uid() and v_reply_to <> v_actor then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_reply_to,'comment',auth.uid(),'feed_event',p_feed_event_id, jsonb_build_object('comment_id', v_id, 'reply_to', p_parent_id));
  end if;
  return jsonb_build_object('status','ok','comment_id',v_id,'parent_id',v_root);
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

/**
 * Mutant 6. `set_bucket` as it stood before `20260825000200`: the unranked check and
 * the upsert with nothing serialising them against a ranking on the same title.
 */
const UNLOCKED_BUCKET = `
create or replace function set_bucket(p_operation_id uuid, p_media_item_id uuid, p_bucket taste_bucket)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform assert_can_write();
  if not _claim_operation(p_operation_id,'set_bucket') then return jsonb_build_object('status','already_applied'); end if;
  if p_bucket is null then raise exception 'bucket is required' using errcode='22023'; end if;
  perform _assert_loggable(p_media_item_id);
  perform _assert_unranked(p_media_item_id);
  insert into user_media (user_id, media_item_id, bucket)
  values (auth.uid(), p_media_item_id, p_bucket)
  on conflict (user_id, media_item_id) do update set bucket = excluded.bucket;
  return jsonb_build_object('status','ok');
end; $$;`;

/**
 * Mutant 7. `rank_answer` with the claim dropped and everything else kept, including
 * the media lock — so this isolates idempotency from locking rather than removing both
 * and calling the result a finding.
 */
const UNCLAIMED_ANSWER = `
create or replace function rank_answer(p_session_id uuid, p_winner uuid, p_operation_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid(); v_item uuid; v_s record; v_pivot_item uuid;
  v_new_lo integer; v_new_hi integer; v_next integer;
begin
  perform assert_can_write();
  select rs.media_item_id into v_item from ranking_sessions rs
   where rs.id = p_session_id and rs.user_id = v_user;
  if v_item is null then raise exception 'no such ranking session' using errcode='P0002'; end if;
  perform _lock_media(v_user, v_item);
  select * into v_s from _rank_session_state(p_session_id, v_user);
  if v_s.lo >= v_s.hi then
    return _rank_finalize(v_user, v_s.media_item_id, v_s.category, v_s.bucket, v_s.band_lo + v_s.lo, v_s.session_id);
  end if;
  v_pivot_item := _rank_pivot_at(v_user, v_s.category, v_s.band_lo + v_s.pivot);
  if p_winner <> v_s.media_item_id and p_winner <> v_pivot_item then
    raise exception 'winner must be one of the two titles being compared' using errcode='22023';
  end if;
  if p_winner = v_s.media_item_id then
    v_new_lo := v_s.lo; v_new_hi := v_s.pivot;
    insert into comparisons (user_id, winner_id, loser_id) values (v_user, v_s.media_item_id, v_pivot_item);
  else
    v_new_lo := v_s.pivot + 1; v_new_hi := v_s.hi;
    insert into comparisons (user_id, winner_id, loser_id) values (v_user, v_pivot_item, v_s.media_item_id);
  end if;
  if v_new_lo >= v_new_hi then
    return _rank_finalize(v_user, v_s.media_item_id, v_s.category, v_s.bucket, v_s.band_lo + v_new_lo, v_s.session_id);
  end if;
  v_next := (v_new_lo + v_new_hi) / 2;
  update ranking_sessions set lo = v_new_lo, hi = v_new_hi, pivot = v_next,
    history = history || jsonb_build_object('lo', v_s.lo, 'hi', v_s.hi, 'pivot', v_s.pivot),
    updated_at = now() where id = v_s.session_id;
  return jsonb_build_object('done', false, 'session_id', v_s.session_id,
    'pivot', _rank_pivot_at(v_user, v_s.category, v_s.band_lo + v_next));
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

// --- Mutant 6: M3 itself. set_bucket with no media lock.
{
  const db = await createRaceDb();
  const fx = fixtures(db);
  await db.sql(UNLOCKED_BUCKET);
  const user = await fx.createUser();
  const film = await fx.createMovie('Mutant 6');

  await db.armBarrier('rankings', 'm6');
  const ctl = await db.controller();
  await ctl.hold('m6');

  const ranker = await db.session('ranker');
  const bucketer = await db.session('bucketer');
  await ranker.actAs(user);
  await bucketer.actAs(user);

  await ranker.begin();
  await ranker.pauseAt('m6');
  const ranking = ranker.start(`select rank_start($1, 'loved') as r`, [film]);
  await ranker.awaitBlocked();

  await bucketer.begin();
  const bucketing = bucketer.start(`select set_bucket($1, $2, 'fine') as r`, [
    crypto.randomUUID(),
    film,
  ]);

  // With the lock, this is where the bucketer waits. Without it, `_assert_unranked`
  // passes — the ranking is not committed yet — and it walks straight into the upsert.
  let blockedOnMedia = true;
  try {
    await bucketer.awaitBlocked({
      on: 'advisory',
      advisoryKey: await db.mediaKey(user, film),
      timeoutMs: 1500,
    });
  } catch {
    blockedOnMedia = false;
  }

  await ctl.release('m6');
  await ranking;
  await ranker.commit();
  await bucketing;
  await bucketer.commit();

  const rows = await db.rows(
    `select r.bucket as ranked, um.bucket as logged
       from rankings r join user_media um
         on um.user_id = r.user_id and um.media_item_id = r.media_item_id
      where r.user_id = $1 and r.media_item_id = $2`,
    [user, film],
  );

  // The damage, in the schema's own words. `assert_ranking_valid` has checked I3 since
  // the first ranking migration and had no writer maintaining it until now.
  let i3Broken = false;
  try {
    await db.sql(`select assert_ranking_valid($1, 'movies'::ranking_category)`, [user]);
  } catch {
    i3Broken = true;
  }

  results.push(['media lock removed -> set_bucket no longer waits for a ranking', blockedOnMedia === false]);
  results.push([
    'media lock removed -> user_media.bucket disagrees with rankings.bucket (I3)',
    i3Broken && rows[0]?.ranked !== rows[0]?.logged,
  ]);

  await ranker.end();
  await bucketer.end();
  await ctl.end();
  await db.close();
}

// --- Mutant 7: rank_answer with no operation claim. A replay becomes a second answer.
{
  const db = await createRaceDb();
  const fx = fixtures(db);
  const user = await fx.createUser();
  const anchor = await fx.createMovie('Mutant 7 anchor');
  const film = await fx.createMovie('Mutant 7');

  const s = await db.session('client');
  await s.actAs(user);
  await s.q(`select rank_start($1, 'loved')`, [anchor]);

  const started = (await s.one(`select rank_start($1, 'loved') as r`, [film])).r;

  await db.sql(UNCLAIMED_ANSWER);

  const op = crypto.randomUUID();
  await s.q(`select rank_answer($1, $2, $3)`, [started.session_id, film, op]);
  const replayed = await s.errorFrom(`select rank_answer($1, $2, $3)`, [
    started.session_id,
    film,
    op,
  ]);

  const comparisons = await db.rows(`select 1 from comparisons where user_id = $1`, [user]);

  /**
   * Two shapes of damage, and either one is the mutant being caught.
   *
   * The band here is one title deep, so the first answer finalises and deletes the
   * session — and the unclaimed replay then finds nothing and raises P0002, where the
   * honest version answers with the placement the caller lost. That alone is the
   * defect: a reader retrying after a dropped reply is told their session has ended
   * over a title that is ranked.
   *
   * On a wider band the replay would not raise at all; it would record a second
   * comparison for one judgement. The count is checked too, so this stays a real
   * assertion if the fixture ever grows.
   */
  results.push([
    'rank_answer claim removed -> a replay is not answered with the first answer',
    Boolean(replayed) || comparisons.length > 1,
  ]);

  await s.end();
  await db.close();
}

// --- Mutant 8: _release_recommendations with its state guard dropped. A dismissal
//     stops being final.
//
//     This is the mutant whose damage is *invisible in the schema*: every row still
//     holds a legal state and the counts still look plausible. What has changed is that
//     a recommendation the reader threw away is back on their list, because they later
//     followed the person who sent it — which is the one thing Dismiss is for.
{
  const db = await createRaceDb();
  const fx = fixtures(db);
  const sender = await fx.createUser();
  const recipient = await fx.createUser();
  await db.sql(
    `insert into follows (follower_id, followee_id, state, approved_at)
     values ($1, $2, 'approved', now())`,
    [sender, recipient],
  );
  const dropped = await fx.createMovie('Mutant 8 dismissed');
  const kept = await fx.createMovie('Mutant 8 kept');

  const s = await db.session('sender');
  await s.actAs(sender);
  for (const film of [dropped, kept]) {
    await s.q(`select recommend_title($1, $2, $3)`, [crypto.randomUUID(), recipient, film]);
  }
  await s.end();

  const held = await db.rows(
    `select id from title_recommendations where recipient_id = $1 and media_item_id = $2`,
    [recipient, dropped],
  );

  const r = await db.session('recipient');
  await r.actAs(recipient);
  await r.q(`select dismiss_recommendation($1)`, [held[0].id]);

  await db.sql(`
    create or replace function _release_recommendations(p_sender uuid, p_recipient uuid)
    returns integer language plpgsql security definer set search_path = public as $fn$
    declare v_released integer;
    begin
      if p_sender is null or p_recipient is null or p_sender = p_recipient then return 0; end if;
      if blocked_between(p_sender, p_recipient) then return 0; end if;
      update title_recommendations set state = 'delivered'
       where sender_id = p_sender and recipient_id = p_recipient;
      get diagnostics v_released = row_count;
      return v_released;
    end; $fn$;`);

  await r.q(`select follow($1, $2)`, [crypto.randomUUID(), sender]);
  const { rows: list } = await r.q(`select media_item_id from recommendations_to_me(100)`);
  await r.end();

  results.push([
    'release guard dropped -> a dismissed recommendation comes back on a later follow',
    list.some((row) => row.media_item_id === dropped),
  ]);

  await db.close();
}

// --- Mutant 9: the actor's pair locked, the reply target's not. The half of N1 that
//     `20260826000600` created and that mutants 1 and 2 cannot see.
{
  const db = await createRaceDb();
  const fx = fixtures(db);
  const owner = await fx.createUser();
  const author = await fx.createUser();
  const commenter = await fx.createUser();
  const movie = await fx.createMovie('Mutant 9');
  const event = await fx.feedEvent(owner, movie);

  // The root comment is written by the honest function, so the fixture is the shipped
  // behaviour and only the call under test is mutated.
  const rootWriter = await db.session('root-author');
  await rootWriter.actAs(author);
  const root = (
    await rootWriter.one(`select add_comment($1,$2,$3) as r`, [crypto.randomUUID(), event, 'root'])
  ).r.comment_id;
  await rootWriter.end();
  await db.sql(`delete from notifications where actor_id = $1`, [author]);

  await db.sql(ACTOR_ONLY_LOCK);

  await db.armBarrier('notifications', 'm9');
  const ctl = await db.controller();
  await ctl.hold('m9');
  const t1 = await db.session('replier');
  const t2 = await db.session('reply-target');
  await t1.actAs(commenter);
  await t1.begin();
  await t1.pauseAt('m9');
  const p = t1.start(`select add_comment($1,$2,$3,$4,$5) as r`, [
    crypto.randomUUID(),
    event,
    'reply',
    false,
    root,
  ]);
  await t1.awaitBlocked();

  await t2.actAs(author);
  await t2.begin();
  const b = t2.start(`select block($1,$2) as r`, [crypto.randomUUID(), commenter]);

  let blockedOnPair = true;
  try {
    await t2.awaitBlocked({
      on: 'advisory',
      advisoryKey: await db.pairKey(commenter, author),
      timeoutMs: 1500,
    });
  } catch {
    blockedOnPair = false;
  }

  await b;
  await t2.commit();
  await ctl.release('m9');
  await p;
  await t1.commit();

  const rows = await db.rows(
    `select 1 from notifications where recipient_id=$1 and actor_id=$2`,
    [author, commenter],
  );

  results.push([
    'reply-target pair lock removed -> the blocker no longer waits',
    blockedOnPair === false,
  ]);
  results.push([
    'reply-target pair lock removed -> the reply notice survives the block',
    rows.length === 1,
  ]);

  await t1.end();
  await t2.end();
  await ctl.end();
  await db.close();
}

// --- Mutant 10: both pairs locked, in semantic order. The one global lock order is
//     lost, and with it the deadlock freedom `races/lock-pair.mjs` asserts.
//
//     Detected by observation rather than by waiting for 40P01. With the honest
//     function the companion save is found waiting on the *lower* uuid's key, because
//     the reply took that one first; with the mutant it is waiting on the higher one,
//     and the correlated `awaitBlocked` times out. That is deterministic, where racing
//     the two to an actual deadlock depends on which waiter the postmaster wakes.
{
  const db = await createRaceDb();
  const fx = fixtures(db);
  const caller = await fx.createUser();
  const [lo, hi] = [await fx.createUser(), await fx.createUser()].sort();

  await fx.mutualFollow(caller, lo);
  await fx.mutualFollow(caller, hi);

  const movie = await fx.createMovie('Mutant 10');
  const event = await fx.feedEvent(hi, movie);
  const rootWriter = await db.session('root-author');
  await rootWriter.actAs(lo);
  const root = (
    await rootWriter.one(`select add_comment($1,$2,$3) as r`, [crypto.randomUUID(), event, 'root'])
  ).r.comment_id;
  await rootWriter.end();

  const tagged = await fx.createMovie('Mutant 10 watched');
  await fx.logWatch(caller, tagged);

  await db.sql(SEMANTIC_ORDER);

  const ctl = await db.controller();
  await ctl.holdPair(caller, hi);
  const t1 = await db.session('replying');
  const t2 = await db.session('saving-companions');
  await t1.actAs(caller);
  await t2.actAs(caller);

  const replying = t1
    .start(`select add_comment($1,$2,$3,$4,$5) as r`, [
      crypto.randomUUID(),
      event,
      'reply',
      false,
      root,
    ])
    .then((r) => r.rows[0].r, (e) => e);
  await t1.awaitBlocked({ on: 'advisory', advisoryKey: await db.pairKey(caller, hi) });

  const saving = t2
    .start(`select set_watch_tags($1,$2,$3) as r`, [crypto.randomUUID(), tagged, [hi, lo]])
    .then((r) => r.rows[0].r, (e) => e);

  let tookTheLowerFirst = true;
  try {
    await t2.awaitBlocked({
      on: 'advisory',
      advisoryKey: await db.pairKey(caller, lo),
      timeoutMs: 1500,
    });
  } catch {
    tookTheLowerFirst = false;
  }

  await ctl.releasePair(caller, hi);
  const [r1, r2] = await Promise.all([replying, saving]);

  results.push([
    'semantic lock order -> the reply no longer takes the lower uuid first',
    tookTheLowerFirst === false,
  ]);
  // Not required for the mutant to count as caught — which waiter PostgreSQL wakes
  // decides whether the cycle closes — but reported when it does, because a 40P01 here
  // is the damage itself rather than a proxy for it.
  if (r1?.code === '40P01' || r2?.code === '40P01') {
    console.log('         (and PostgreSQL reported the deadlock outright)');
  }

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
