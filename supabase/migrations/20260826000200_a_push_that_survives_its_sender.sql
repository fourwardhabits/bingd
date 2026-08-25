-- ---------------------------------------------------------------------------
-- A push that survives its sender
--
-- THE DEFECT, EXACTLY
--
-- `20260825000300` counts one thing and uses it for two. `attempts` is incremented **when a
-- row is claimed**, and it is then read as though it meant "how many times delivery has
-- been tried and failed":
--
--   claim:  where o.attempts < 3
--   settle: delete ... where delivered or o.attempts >= 3
--
-- Those two readings agree for as long as every claim is followed by a settle. They come
-- apart the moment a sender dies:
--
--   1. the row is claimed for the third time — `attempts` becomes 3;
--   2. the Edge Function is killed, times out, or loses its network before `settle`;
--   3. five minutes later the lease expires, so the row is `claimed` and stale —
--      **and `attempts < 3` is false, so no sender will ever claim it again.**
--
-- Two things are wrong with that and only one of them was written down. The push is not
-- delivered, which is survivable — the in-app notification is the record and it arrived.
-- The row is also **never deleted**: `settle_push_batch` is the only thing that deletes,
-- and it will never see this row again. `push_outbox` is documented as a queue that stays
-- bounded with no pruner, and a crash at the wrong moment leaves a permanent row in it.
--
-- It is worse than "one stranded row" reads, too. The crash does not have to be on the
-- third *failure*: a row that has never failed at all, claimed twice by senders that died
-- before sending anything, is on its last life through no fault of the notification.
--
-- ---------------------------------------------------------------------------
-- THE FIX: COUNT THE TWO THINGS SEPARATELY, AND MAKE THE CEILING DELETE
--
--   `failures`  — settled delivery failures. The provider was reached and said no, or the
--                 send threw. Three of these and the notification is given up on, which is
--                 the bound `20260825000300` intended and is unchanged in effect.
--
--   `attempts`  — claims. Keeps its name and its meaning; it is now a **crash ceiling**
--                 rather than the retry bound. Six, which is three deliveries' worth of
--                 failure plus three senders dying, and it exists only so that a row which
--                 kills every sender that touches it cannot be retried for ever.
--
-- And the part that is easy to leave out: **something has to delete a row that hits either
-- ceiling.** `settle_push_batch` cannot, because the exhausted-by-crash row is precisely
-- the one it never sees. So `claim_push_batch` reaps at the top of every drain — one extra
-- `delete` in a function that already ends with one, running on a schedule
-- (`20260826000300`) rather than needing a process of its own.
--
-- A row is only reaped when nothing holds it: `pending`, or `claimed` with an expired
-- lease. A sender working on a row is never reaped out from under itself.
--
-- ---------------------------------------------------------------------------
-- WHAT DOES NOT CHANGE
--
-- The lease is still five minutes, the claim is still `for update skip locked`, delivery is
-- still at-least-once, and the sender still chooses nothing. `push-sender/index.ts` needs no
-- edit: it calls the same two functions with the same arguments and reads the same shapes.
-- ---------------------------------------------------------------------------

alter table push_outbox
  add column if not exists failures integer not null default 0;

comment on column push_outbox.failures is
  'Settled delivery failures. Three and the row is given up on. Separate from attempts, which counts CLAIMS -- a sender that dies before settling burns an attempt without having learned anything about deliverability, and conflating the two is what stranded a row permanently.';

comment on column push_outbox.attempts is
  'How many times this row has been claimed, including claims by senders that then died. A crash ceiling (six), not the retry bound -- see failures. A row at either ceiling is deleted by the next claim_push_batch rather than left in the queue.';

-- ---------------------------------------------------------------------------
-- Claiming, with a reaper in front of it
-- ---------------------------------------------------------------------------

create or replace function claim_push_batch(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed uuid[];
  v_jobs    jsonb;
  v_dead    uuid[];
begin
  -- Exhausted rows leave the queue here, because the row stranded by a crash is the one
  -- `settle_push_batch` never gets to see. Only rows nothing is holding: a live lease means
  -- a sender is working, and the ceiling it is about to cross is not this statement's to
  -- enforce.
  delete from push_outbox o
   where (o.failures >= 3 or o.attempts >= 6)
     and (o.state = 'pending' or o.claimed_at < now() - interval '5 minutes');

  with due as (
    select o.notification_id
      from push_outbox o
     where o.failures < 3
       and o.attempts  < 6
       and (
         o.state = 'pending'
         or (o.state = 'claimed' and o.claimed_at < now() - interval '5 minutes')
       )
     order by o.created_at
     limit least(greatest(coalesce(p_limit, 20), 1), 100)
     for update skip locked
  ),
  taken as (
    update push_outbox o
       set state      = 'claimed',
           claimed_at = now(),
           attempts   = o.attempts + 1
      from due
     where o.notification_id = due.notification_id
    returning o.notification_id
  )
  select coalesce(array_agg(notification_id), '{}'::uuid[]) into v_claimed from taken;

  if array_length(v_claimed, 1) is null then
    return jsonb_build_array();
  end if;

  -- Rows that were claimed but have nothing to deliver to, or nobody it would be right to
  -- deliver about. Collected before the payload query so that both statements read the
  -- same set, and deleted below.
  select coalesce(array_agg(n.id), '{}'::uuid[]) into v_dead
    from notifications n
   where n.id = any (v_claimed)
     and (
       (n.actor_id is not null and not can_discover_profile(n.recipient_id, n.actor_id))
       or not exists (
         select 1 from device_tokens d
          where d.user_id = n.recipient_id and d.revoked_at is null
       )
     );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'notification_id', j.id,
        'type',            j.type,
        'actor_username',  j.actor_username,
        'actor_name',      j.actor_name,
        'media_item_id',   j.media_item_id,
        'media_kind',      j.media_kind,
        'media_title',     j.media_title,
        'series_title',    j.series_title,
        'tokens',          j.tokens
      )
      order by j.created_at
    ),
    jsonb_build_array()
  )
  into v_jobs
  from (
    select n.id,
           n.type,
           n.created_at,
           p.username::text                        as actor_username,
           coalesce(p.display_name, p.username::text) as actor_name,
           m.id                                    as media_item_id,
           m.kind::text                            as media_kind,
           m.title                                 as media_title,
           parent.title                            as series_title,
           (
             select jsonb_agg(jsonb_build_object('token', d.token, 'platform', d.platform))
               from device_tokens d
              where d.user_id = n.recipient_id
                and d.revoked_at is null
           )                                       as tokens
      from notifications n
      -- Left, because an actorless system notice must not be dropped by the join that
      -- exists to name a person. None of the eligible types has a null actor today.
      left join profiles p
             on p.id = n.actor_id
            and p.status = 'active'
      -- The recipient's own feed event, and only ever theirs -- the same restriction
      -- `my_notifications` writes as `fe.actor_id = auth.uid()`, said in the one way
      -- available to a definer function with no caller.
      left join feed_events fe
             on n.subject_type = 'feed_event'
            and fe.id = n.subject_id
            and fe.actor_id = n.recipient_id
      left join media_items m
             on m.id = case
                         when n.subject_type = 'media_item' then n.subject_id
                         else fe.media_item_id
                       end
      left join media_items parent
             on parent.id = m.parent_id
     where n.id = any (v_claimed)
       and not (n.id = any (v_dead))
       -- An actor who cannot be named is not pushed. Every eligible type says somebody
       -- did something, and a notification that cannot say who is not one worth a buzz.
       and p.id is not null
  ) j;

  -- Everything claimed that produced no job: undeliverable, or nobody to deliver about.
  delete from push_outbox o
   where o.notification_id = any (v_claimed)
     and o.notification_id not in (
       select (job ->> 'notification_id')::uuid from jsonb_array_elements(v_jobs) as job
     );

  return v_jobs;
end;
$$;

comment on function claim_push_batch(integer) is
  'Claims up to p_limit queued pushes and returns everything needed to send them, recipients and tokens resolved server-side. Takes no recipient and cannot be pointed at one. Applies can_discover_profile exactly as my_notifications does, so a notification that raced a block is not pushed. Five-minute lease with skip locked, so delivery is at least once, bounded at three settled failures and six claims. Reaps rows that have hit either ceiling, because a sender that died before settling leaves a row settle_push_batch will never see again.';

-- ---------------------------------------------------------------------------
-- Settling, counting failures rather than claims
--
-- `failures + 1 >= 3` rather than `failures >= 2`, said the long way round because the two
-- read differently to somebody checking the bound: this failure is the one being recorded,
-- and it has not been counted yet.
-- ---------------------------------------------------------------------------

create or replace function settle_push_batch(p_results jsonb, p_invalid_tokens text[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settled integer := 0;
  v_retry   integer := 0;
  v_revoked integer := 0;
begin
  if p_results is null or jsonb_typeof(p_results) <> 'array' then
    raise exception 'results must be a json array' using errcode = '22023';
  end if;

  -- Delivered, or failed for the third time. Either way there is nothing further to do
  -- with the row, and the notification itself is untouched and still in the inbox.
  with settled as (
    delete from push_outbox o
     using jsonb_array_elements(p_results) as r
     where o.notification_id = (r.value ->> 'notification_id')::uuid
       and (coalesce((r.value ->> 'delivered')::boolean, false) or o.failures + 1 >= 3)
    returning 1
  )
  select count(*) into v_settled from settled;

  -- Failed with lives left. Back to pending, carrying why and one more failure, so the next
  -- drain picks it up rather than waiting for the lease to expire.
  with retried as (
    update push_outbox o
       set state      = 'pending',
           claimed_at = null,
           failures   = o.failures + 1,
           last_error = left(r.value ->> 'error', 500)
      from jsonb_array_elements(p_results) as r
     where o.notification_id = (r.value ->> 'notification_id')::uuid
       and not coalesce((r.value ->> 'delivered')::boolean, false)
    returning 1
  )
  select count(*) into v_retry from retried;

  if p_invalid_tokens is not null and array_length(p_invalid_tokens, 1) is not null then
    with dead as (
      update device_tokens d
         set revoked_at = now(),
             updated_at = now()
       where d.token = any (p_invalid_tokens)
         and d.revoked_at is null
      returning 1
    )
    select count(*) into v_revoked from dead;
  end if;

  return jsonb_build_object(
    'status',  'ok',
    'settled', v_settled,
    'retry',   v_retry,
    'revoked', v_revoked
  );
end;
$$;

comment on function settle_push_batch(jsonb, text[]) is
  'Records the outcome of one send. Delivered rows and rows that have now failed three times are deleted; the rest go back to pending with the error and one more failure. Counts FAILURES rather than claims, so a sender that died mid-flight does not spend a life it never used. Tokens the provider reported as unregistered are revoked, not deleted, so a reinstall can bring one back. service_role only.';

-- Re-issued because `create or replace function` does not carry privileges over from a
-- dropped signature and it costs nothing to be sure. Both signatures are unchanged.
revoke execute on function claim_push_batch(integer)               from public, anon, authenticated;
revoke execute on function settle_push_batch(jsonb, text[])        from public, anon, authenticated;
grant  execute on function claim_push_batch(integer)               to service_role;
grant  execute on function settle_push_batch(jsonb, text[])        to service_role;
