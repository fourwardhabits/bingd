-- Push delivery: a device token with an owner, and an outbox that can only ever carry
-- notifications the database itself wrote.
-- Specification: docs/architecture/data-model.md §7 · AD-10 · PRD §15 ·
-- deferred-roadmap.md §4
--
-- ===========================================================================
-- WHAT EXISTED BEFORE THIS, AND WHAT DID NOT
--
-- `device_tokens` has been in the schema since `20260813000900` with **no writer on any
-- client**, no read policy, and a comment explaining that it was populated early so that
-- enabling push would not begin with an empty table. It was never populated, because
-- nothing has ever written to it.
--
-- Everything else the inbox needs is real and stays exactly as it is: ten notification
-- types, eight preference categories, a before-insert trigger that drops a row whose
-- category is off, `my_notifications` as the only way to read an inbox, and a routing
-- table on the client. **This migration adds transport and changes nothing about any of
-- that.**
--
-- ===========================================================================
-- THE PREFERENCE AXIS, DECIDED — ONE AXIS, ENFORCED STRUCTURALLY
--
-- `20260819000300` left this open in writing: "when push arrives it must decide for
-- itself whether these switches govern it too or whether delivery needs its own axis".
--
-- The answer is **one axis**, and the mechanism is not a second check.
--
-- `_apply_notification_preference` is a **before**-insert trigger that returns null for a
-- category the recipient switched off. When a before-row trigger returns null, PostgreSQL
-- skips the row entirely — the insert does not happen and **no after-row trigger fires**.
-- So an after-insert trigger enqueueing a push cannot observe a suppressed notification.
-- It is not that push agrees to honour the preference; it is that a suppressed
-- notification does not exist to be pushed.
--
-- That is worth stating because the alternative — reading the preference again in the
-- sender — is the shape of bug this schema keeps finding: two expressions of one rule,
-- and the second one is the one that gets it wrong. There is no push preference to
-- bypass because there is no second axis.
--
-- The one thing that remains genuinely independent is the **operating system's** own
-- permission, which is the platform's to hold and not this database's.
--
-- ===========================================================================
-- WHY AN OUTBOX AND NOT A DIRECT CALL
--
-- Postgres cannot reach an Edge Function on its own here. `pg_net` and `pg_cron` are not
-- installed — `create extension` appears exactly once in this whole migration set, for
-- `citext` — and installing a networking extension so that a trigger can make an HTTP
-- call inside a social write is a large change with a bad failure mode: a follow that
-- rolls back because a notification service was slow.
--
-- So the row is queued transactionally with the notification, and a sender drains it.
-- Three properties follow, and each one is a requirement rather than a consequence:
--
--   · **A push corresponds to a notification row that legitimately exists.** The outbox's
--     primary key *is* the notification id, with `on delete cascade`. There is no way to
--     put a row in this table except by writing a notification, and no way to keep one
--     after the notification is gone — which matters because `block()` deletes
--     notifications in both directions.
--
--   · **No caller names a recipient.** `claim_push_batch` takes a batch size. The
--     recipient, the copy and the tokens are all resolved from the notification row. The
--     word "recipient" does not appear in any parameter reachable by a client, and the
--     two functions that do resolve recipients are granted to `service_role` alone.
--
--   · **Push failure cannot roll back the social action.** The enqueue is a local insert
--     into a table with no constraints beyond its own key; everything that can fail —
--     the network, the provider, the token — happens later, in a different process.
--
-- **What is deliberately not built:** nothing schedules the drain. The sender is invoked
-- by the app (see `supabase/functions/push-sender/README.md`), which covers the ordinary
-- case because the person who caused a notification is holding a phone at that moment.
-- A row nobody drains simply waits. When a scheduler is wanted, it drains this same table
-- through this same function and nothing here changes.

-- ---------------------------------------------------------------------------
-- 1. The token, and what makes one belong to an account
--
-- The table shape from `20260813000900` is kept: a globally unique token, a platform, a
-- `revoked_at`. The uniqueness is the load-bearing part and it is worth saying why it is
-- right rather than merely convenient.
--
-- A push token identifies **a physical installation**, not a person. One phone that two
-- people sign into in turn produces one token, and that token must name whoever is signed
-- in *now*. A per-user unique key would let A and B both hold live rows for the same
-- device, and the sender would then deliver B's notifications to a phone A is looking at.
-- A globally unique token makes that state unrepresentable: registering moves the row.
-- ---------------------------------------------------------------------------

alter table device_tokens
  add column updated_at timestamptz not null default now();

comment on column device_tokens.updated_at is
  'When this token was last registered or revoked. Not a delivery record -- nothing here says a notification was sent, and see push_outbox for why no such record is kept.';

-- A bound rather than a format. An Expo push token is about forty characters and the
-- format check belongs in `register_device_token`, where a refusal can say what was
-- wrong; this is the floor that stops the column being used as storage.
alter table device_tokens
  add constraint device_tokens_token_length check (char_length(token) between 1 and 512);

comment on table device_tokens is
  'One row per physical installation that may receive a push, owned by whoever is signed in on it. Written only by register_device_token and revoke_device_token; no read policy since 20260813000900, and deliberately still none -- a push token is an operational secret with no reason to reach a client, including its owner''s. The token is globally unique so that a device cannot be live for two accounts at once, which is what makes signing out and signing back in as somebody else safe.';

-- ---------------------------------------------------------------------------
-- 2. Registering a token
--
-- `_claim_operation` for the same reason every other writer here has it, and the shape of
-- the ledger is what makes the account-switch case safe without any extra thought:
-- `processed_operations` is keyed on **(user_id, operation_id)** since `20260813002300`,
-- so B re-registering a device A used cannot be answered `already_applied` by A's claim.
--
-- `assert_can_write()` first, so a suspended account cannot arrange to be notified.
-- ---------------------------------------------------------------------------

create or replace function register_device_token(
  p_operation_id uuid,
  p_token        text,
  p_platform     text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text := btrim(coalesce(p_token, ''));
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'register_device_token') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  if p_platform is null or p_platform not in ('ios', 'android') then
    raise exception 'platform must be ios or android' using errcode = '22023';
  end if;

  -- The provider's own shape, checked here rather than as a column constraint so the
  -- refusal names the problem. Expo push tokens are `ExponentPushToken[...]`; the older
  -- `ExpoPushToken[...]` spelling is accepted because the client is not the place to
  -- decide which of the two the SDK returns.
  --
  -- A raw APNs or FCM token would pass a length check and fail silently at the provider,
  -- which is the failure this refusal exists to convert into an error somebody sees.
  if v_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_%\-]+\]$' then
    raise exception 'not an Expo push token' using errcode = '22023';
  end if;

  -- `on conflict (token)` is what moves a device between accounts, and it is one
  -- statement so there is no window in which the device belongs to nobody or to both.
  -- `revoked_at = null` un-revokes, which is what re-registering a token that was
  -- released at sign-out has to mean.
  insert into device_tokens (user_id, token, platform)
  values (auth.uid(), v_token, p_platform)
  on conflict (token) do update
    set user_id    = excluded.user_id,
        platform   = excluded.platform,
        revoked_at = null,
        updated_at = now();

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function register_device_token(uuid, text, text) is
  'Registers the caller''s device for push, or moves an existing device to the caller. Idempotent through _claim_operation. The token is globally unique, so re-registering a device that another account used transfers it in one statement -- which is what stops a second person on a shared phone inheriting the first one''s notifications.';

-- ---------------------------------------------------------------------------
-- 3. Releasing one
--
-- **No `assert_can_write`, deliberately.** Every other writer refuses a suspended
-- account, and here that would be backwards: signing out is precisely what a suspended
-- account should still be able to do, and leaving a live token behind because the
-- suspension arrived first is the one outcome this function exists to prevent.
--
-- It answers `ok` whether or not a row moved. A caller learning that a token exists and
-- belongs to somebody else would be a small oracle over other people's devices, and there
-- is nothing a client would do differently with the answer.
-- ---------------------------------------------------------------------------

create or replace function revoke_device_token(p_operation_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text := btrim(coalesce(p_token, ''));
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if not _claim_operation(p_operation_id, 'revoke_device_token') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  update device_tokens
     set revoked_at = now(),
         updated_at = now()
   where token      = v_token
     and user_id    = auth.uid()
     and revoked_at is null;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function revoke_device_token(uuid, text) is
  'Releases one of the caller''s devices, which is what sign-out does. Own rows only, and it answers ok either way so it cannot report whether a token exists. A revoked row is not deleted: register_device_token un-revokes it, so signing back in on the same phone is one update rather than a new row.';

-- ---------------------------------------------------------------------------
-- 4. Which kinds are worth a phone buzzing
--
-- Eight of the ten. The two absences are decisions rather than omissions:
--
--   `follow_approved`  PRD §15's event table says Push: **No**. The person already knows
--                      they asked; being told they were let in is news that can wait for
--                      the next time they open the app.
--   `award_earned`     Nothing writes one (`deferred-roadmap.md` §5), so pushing it would
--                      be transport for an event that does not occur.
--
-- Stated as a function rather than inline in the trigger so that the sender, the tests and
-- anything added later read the same list. An unmapped type is **not** eligible, which is
-- the opposite of `_apply_notification_preference`'s rule for unmapped categories — and
-- the asymmetry is deliberate. There, silence would be a notification nobody could see;
-- here, a mistake would be an unreviewed push, which is the more expensive direction.
-- ---------------------------------------------------------------------------

create or replace function _push_eligible(p_type text)
returns boolean
language sql immutable
set search_path = public
as $$
  select p_type = any (array[
    'follow',
    'follow_request',
    'comment',
    'reaction',
    'watch_tag',
    'recommendation',
    'invite_activated',
    'invite_welcome'
  ]::text[]);
$$;

comment on function _push_eligible(text) is
  'Which notification types are delivered as push. Eight of the ten: follow_approved is excluded by PRD §15, and award_earned has no writer. An unmapped type is not eligible -- the opposite of the preference trigger''s rule, because an unreviewed push costs more than a missing one. Internal.';

-- ---------------------------------------------------------------------------
-- 5. The outbox
--
-- Keyed on the notification, which is the whole design in one line: a row here **is** a
-- notification that was written, and it cannot outlive one.
--
-- Nothing records that a push was delivered. Once a row is settled it is deleted, and the
-- table stays a queue rather than becoming a log — which is what keeps it bounded with no
-- pruner, and keeps this schema from holding a second, weaker copy of somebody's inbox.
-- The in-app row remains the record of what happened.
-- ---------------------------------------------------------------------------

create table push_outbox (
  notification_id uuid primary key references notifications(id) on delete cascade,
  recipient_id    uuid not null references profiles(id) on delete cascade,
  -- `pending` or `claimed`, and nothing else: a settled row is a deleted row.
  state           text not null default 'pending' check (state in ('pending', 'claimed')),
  attempts        integer not null default 0,
  claimed_at      timestamptz,
  created_at      timestamptz not null default now(),
  last_error      text
);

-- The sender's only query: oldest first, over the rows that are due.
create index push_outbox_due on push_outbox (created_at);

alter table push_outbox enable row level security;

-- No policy, so no client role reaches it under RLS. The revoke is belt and braces on the
-- same reasoning `20260819000300` gave for `notifications`: a predicate in one read path
-- is not a predicate, and a table with no client surface is better expressed by not
-- granting one than by describing what may be seen.
revoke select on push_outbox from anon, authenticated;

comment on table push_outbox is
  'Notifications waiting to be delivered as push. Primary key is the notification id with on delete cascade, so a row cannot exist without a notification and cannot survive one -- which is what makes a fabricated push unrepresentable, and what makes block() take its pending pushes with it. Settled rows are deleted rather than marked, so this is a queue and not a delivery log.';

-- ---------------------------------------------------------------------------
-- 6. Enqueueing, as an after-insert trigger
--
-- `after`, and that is the load-bearing word. The preference gate is a `before` trigger
-- that returns null, and a row skipped by a before-row trigger fires no after-row
-- trigger at all — so a category somebody switched off cannot reach this function. See
-- the header.
--
-- Definer, and revoked from every client role, for the reason
-- `_apply_notification_preference` is: a client holding a trigger function that writes
-- the delivery queue could enqueue anything.
-- ---------------------------------------------------------------------------

create or replace function _enqueue_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not _push_eligible(new.type) then
    return null;
  end if;

  -- `do nothing` rather than `do update`: the key is the notification id, so a conflict
  -- can only mean this row is already queued, and re-queueing it would reset an attempt
  -- count that exists to stop a bad row being retried for ever.
  insert into push_outbox (notification_id, recipient_id)
  values (new.id, new.recipient_id)
  on conflict (notification_id) do nothing;

  return null;
end;
$fn$;

comment on function _enqueue_push() is
  'Queues an eligible notification for push delivery. An AFTER INSERT trigger, which is what makes the notification preference govern push too: _apply_notification_preference drops a suppressed row in a BEFORE trigger, and a skipped row fires no AFTER trigger. Internal.';

create trigger notifications_enqueue_push
  after insert on notifications
  for each row execute function _enqueue_push();

-- ---------------------------------------------------------------------------
-- 7. Claiming a batch
--
-- Everything the sender needs for one push, assembled here rather than in the function,
-- so the Edge Function holds no opinion about this schema and cannot get the visibility
-- rules subtly different from the inbox's.
--
-- Three filters drop a job rather than returning it, and each one deletes the outbox row:
--
--   · the actor is no longer discoverable to the recipient. Same predicate
--     `my_notifications` applies, and for the same reason `20260819000300` added it
--     there: `block()` deletes the notifications that exist at that moment, so a writer
--     that passed its visibility check and committed afterwards leaves a row behind. The
--     inbox already refuses to draw that row; this refuses to push it.
--   · the recipient has no live device. Not an error and not something to wait for — a
--     token arriving tomorrow should not produce a buzz about a follow from today.
--   · the row has been attempted too many times. Three, then it is given up on, because
--     the in-app notification is the one that has to arrive and it already has.
--
-- `for update skip locked` with a five-minute lease, so two senders running at once claim
-- disjoint work and a sender that dies mid-flight releases its rows rather than stranding
-- them. Delivery is therefore **at least once**: a process that sends and then dies before
-- settling will send again when the lease expires. That is the right side to fail on for a
-- notification, and it is bounded by the attempt ceiling.
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
  with due as (
    select o.notification_id
      from push_outbox o
     where o.attempts < 3
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
  'Claims up to p_limit queued pushes and returns everything needed to send them, recipients and tokens resolved server-side. Takes no recipient and cannot be pointed at one. Applies can_discover_profile exactly as my_notifications does, so a notification that raced a block is not pushed. Five-minute lease with skip locked, so delivery is at least once and bounded at three attempts. service_role only.';

-- ---------------------------------------------------------------------------
-- 8. Settling a batch
--
-- One call for the whole batch, so a sender that has finished its work records that fact
-- in one statement rather than in twenty that can half-succeed.
--
-- A settled row is **deleted** whether it was delivered or given up on. The distinction
-- is not recorded because nothing would read it: the in-app notification is the record of
-- the event, and a per-device delivery history is somebody's activity log in a table with
-- no reason to hold one.
--
-- `p_invalid_tokens` is the provider telling us a device is gone — an uninstall, a
-- reinstall, a token rolled by APNs or FCM. Those are revoked rather than deleted, so
-- `register_device_token` can bring one back with an update if the app returns.
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

  -- Delivered, or attempted for the third time. Either way there is nothing further to
  -- do with the row, and the notification itself is untouched and still in the inbox.
  with settled as (
    delete from push_outbox o
     using jsonb_array_elements(p_results) as r
     where o.notification_id = (r.value ->> 'notification_id')::uuid
       and (coalesce((r.value ->> 'delivered')::boolean, false) or o.attempts >= 3)
    returning 1
  )
  select count(*) into v_settled from settled;

  -- Failed with attempts left. Back to pending, carrying why, so the next drain picks it
  -- up rather than waiting for the lease to expire.
  with retried as (
    update push_outbox o
       set state      = 'pending',
           claimed_at = null,
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
  'Records the outcome of one send. Delivered rows and rows that have used their third attempt are deleted; the rest go back to pending with the error. Tokens the provider reported as unregistered are revoked, not deleted, so a reinstall can bring one back. service_role only.';

-- ---------------------------------------------------------------------------
-- 9. Privileges
--
-- Two writers for a client, two for the sender, and nothing else.
--
-- `claim_push_batch` and `settle_push_batch` resolve recipients and hand back tokens, so
-- they are exactly the functions a client must never reach. `service_role` bypasses RLS
-- anyway, which is why the Edge Function could read these tables directly — the functions
-- exist so that the visibility rules live in this file next to the inbox's, rather than
-- being re-derived in Deno.
--
-- `_push_eligible` and `_enqueue_push` join the internal side. The first is pure and
-- discloses nothing; the allow-list is the artefact that gets reviewed and an entry there
-- should follow a surface, and no client calls it.
-- ---------------------------------------------------------------------------

revoke execute on function register_device_token(uuid, text, text) from public, anon, authenticated;
revoke execute on function revoke_device_token(uuid, text)         from public, anon, authenticated;
revoke execute on function _push_eligible(text)                    from public, anon, authenticated;
revoke execute on function _enqueue_push()                         from public, anon, authenticated;
revoke execute on function claim_push_batch(integer)               from public, anon, authenticated;
revoke execute on function settle_push_batch(jsonb, text[])        from public, anon, authenticated;

grant execute on function register_device_token(uuid, text, text) to authenticated;
grant execute on function revoke_device_token(uuid, text)         to authenticated;

grant execute on function claim_push_batch(integer)        to service_role;
grant execute on function settle_push_batch(jsonb, text[]) to service_role;
