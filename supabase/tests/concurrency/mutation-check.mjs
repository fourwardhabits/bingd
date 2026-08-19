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
 * Two mutants:
 *
 *   1. `add_comment` with `_lock_pair` deleted. The blocker must stop waiting, and a
 *      notification must survive the block. (Hardening blocker B.)
 *   2. `add_comment` with the visibility check moved after the lock. The refusal must
 *      become timeable — a `57014` where the honest version answers `P0002` at once.
 *      (Review 25's MAJOR.)
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

await stopCluster();
let ok = true;
for (const [name, passed] of results) {
  console.log(`${passed ? 'DETECTED ' : 'MISSED   '} ${name}`);
  if (!passed) ok = false;
}
process.exit(ok ? 0 : 1);
