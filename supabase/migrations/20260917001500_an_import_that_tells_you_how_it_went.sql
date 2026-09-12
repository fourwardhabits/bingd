-- An import that tells you how it went.
--
-- The importer says "you can close the app" and means it: after `import_ready` the work is a
-- pg_cron tick with no client attached. Until now nothing then told anybody it had finished,
-- or that it had failed. Somebody who took the screen at its word found out by remembering to
-- come back. That is a promise with no second half.
--
-- ===========================================================================
-- THREE NOTIFICATIONS, TIED TO THE JOB AND NOT TO THE WORKER
--
--   import_started     the job left `pending` for `matching`, which only `import_ready`
--                      does: the rows are staged and the worker owns it. Not on
--                      `import_create`, which is a slot, not an import.
--   import_completed   `completed_at` was set and the status is `done`.
--   import_failed      `completed_at` was set and the status is `failed`, **for a job that
--                      had started**. A job swept as abandoned was still `pending`: its
--                      owner never finished sending it and was never told it had begun, so
--                      telling them it failed would be news about something they walked
--                      away from.
--
-- All three are written by one trigger on `import_jobs`, on the transitions themselves.
-- Worker attempts, lease reclaims and retries update `claimed_at`, `attempts` and `failures`,
-- which is none of these, so they write nothing. `_import_settle`, the dead letter and the
-- sweep all set `completed_at` guarded on `completed_at is null`, so the terminal transition
-- happens once whichever of them gets there.
--
-- The trigger is the first guarantee and the indexes are the second: one `started` per job,
-- and one terminal notification per job, shared between `completed` and `failed`, so a job
-- can never be reported as both. Writers use `on conflict do nothing`, the convention every
-- other once-only notification here follows. A re-import is a new job and so a new set.
--
-- The job's id is in both `subject_id` (with `subject_type = 'import_job'`) and
-- `payload.job_id`. The first is what the inbox and the push route on; the second is what
-- the indexes key on, the way `notifications_one_goal_congrats` keys on its payload.
--
-- ===========================================================================
-- THE IMPORT'S OWN SILENCE WOULD HAVE EATEN THEM
--
-- `_import_settle` sets the `bingd.import_running` marker for its whole transaction so the
-- thirteen award tracks it evaluates announce nothing, and `notifications_silent_during_import`
-- cancels every notification insert under it. The completion notification is written inside
-- that same transaction, and a dead letter or sweep that shares a cron statement with a
-- settle is under it too. So the notifications gate now lets these three types through by
-- name and keeps silencing everything else exactly as before. The feed gate is untouched:
-- none of this is activity.
--
-- ===========================================================================
-- PREFERENCES: NONE, ON PURPOSE
--
-- There is no Settings switch for these and no category. They report on an action the
-- recipient took and was told to leave running; they are not engagement. `follow_request`
-- and `invite_welcome` are the existing exemptions and this is the same shape. They are
-- push-eligible like every other notification.
-- ===========================================================================


create unique index notifications_one_import_start
  on notifications ((payload ->> 'job_id'))
  where type = 'import_started';

-- Shared by both outcomes: a job that completed cannot also fail, and the other way round.
create unique index notifications_one_import_outcome
  on notifications ((payload ->> 'job_id'))
  where type in ('import_completed', 'import_failed');


create or replace function _import_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text;
begin
  if old.status = 'pending' and new.status = 'matching' and new.completed_at is null then
    v_type := 'import_started';
  elsif old.completed_at is null and new.completed_at is not null then
    if new.status = 'done' then
      v_type := 'import_completed';
    elsif new.status = 'failed' and old.status <> 'pending' then
      v_type := 'import_failed';
    end if;
  end if;

  if v_type is null then
    return null;
  end if;

  insert into notifications (recipient_id, type, subject_type, subject_id, payload)
  values (
    new.user_id,
    v_type,
    'import_job',
    new.id,
    jsonb_build_object('job_id', new.id)
      -- The summary, on the one notification that has one. Counts only: no film name ever
      -- enters a notification.
      || case when v_type = 'import_completed' then
           jsonb_build_object(
             'watched',   coalesce((new.counts ->> 'watched')::integer, 0),
             'watchlist', coalesce((new.counts ->> 'watchlist')::integer, 0))
         else '{}'::jsonb end
  )
  on conflict do nothing;

  return null;
end;
$$;

comment on function _import_notify() is
  'After-update trigger on import_jobs. Writes import_started when a job leaves pending for matching (import_ready), import_completed when completed_at is set on a done job, and import_failed when it is set on a failed job that had started. Once each, by the transitions themselves and by notifications_one_import_start / notifications_one_import_outcome. Internal.';

revoke execute on function _import_notify() from public, anon, authenticated;

create trigger import_jobs_notify
  after update of status, completed_at on import_jobs
  for each row execute function _import_notify();


create or replace function _no_notifications_while_importing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The import's own outcome is the one thing an import is allowed to say.
  if new.type in ('import_started', 'import_completed', 'import_failed') then
    return new;
  end if;
  if _importing() then return null; end if;
  return new;
end;
$$;

comment on function _no_notifications_while_importing() is
  'The notifications half of _no_activity_while_importing: cancels a notification written during a bulk import, except the import''s own three lifecycle notifications, which are written inside the settle transaction on purpose. Internal.';

revoke execute on function _no_notifications_while_importing() from public, anon, authenticated;

drop trigger notifications_silent_during_import on notifications;
create trigger notifications_silent_during_import
  before insert on notifications
  for each row execute function _no_notifications_while_importing();


-- ---------------------------------------------------------------------------
-- Preferences: exempt, like follow_request and invite_welcome.
-- Rebuilt from 20260831000100; the only change is the import branch.
-- ---------------------------------------------------------------------------

create or replace function _apply_notification_preference()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_category text;
begin
  if new.type = 'follow_request' then
    return new;
  end if;

  if new.type = 'invite_welcome' then
    return new;
  end if;

  -- 20260917001500. About something the recipient started and was told they could walk
  -- away from. Operational, not engagement, so no category switches it off: an import that
  -- finishes or fails in silence after 'you can close the app' is the failure these exist
  -- to prevent.
  if new.type in ('import_started', 'import_completed', 'import_failed') then
    return new;
  end if;

  v_category := case new.type
    when 'follow'                then 'follows'
    when 'follow_approved'       then 'follow_accepted'
    when 'comment'               then 'comments'
    -- 20260830000100. A mention is somebody talking to you in a comment, and it
    -- is silenced by the control that says Comments.
    when 'mention'               then 'comments'
    when 'reaction'              then 'reactions'
    when 'watch_tag'             then 'watch_tags'
    when 'recommendation'        then 'recommendations'
    when 'recommendation_ranked' then 'recommendations'
    when 'invite_activated'      then 'invites'
    -- 20260831000100. The other half of the invite story, and the half that arrives
    -- first. Same category, same switch.
    when 'invite_joined'         then 'invites'
    when 'award_earned'          then 'awards'
    when 'goal_completed'        then 'awards'
  end;

  -- An unmapped type is delivered rather than dropped. A notification kind added later
  -- and forgotten here should reach its recipient, not vanish -- the failure mode of the
  -- other default is silent and undetectable.
  if v_category is null then
    return new;
  end if;

  if _notifies(new.recipient_id, v_category) then
    return new;
  end if;

  return null;
end;
$fn$;

comment on function _apply_notification_preference() is
  'Before-insert gate on notifications. Drops a row whose category the recipient has '
  'switched off. follow_request, invite_welcome and the three import lifecycle types '
  '(20260917001500) are exempt and always delivered. recommendation_ranked shares the '
  'recommendations category (20260827000600); goal_completed shares awards '
  '(20260829000200); mention shares comments (20260830000100); invite_joined shares '
  'invites with invite_activated (20260831000100). An unmapped type is delivered.';


-- ---------------------------------------------------------------------------
-- Push. Rebuilt from 20260901000100 with the three import types added.
-- ---------------------------------------------------------------------------

create or replace function _push_eligible(p_type text)
returns boolean
language sql immutable
set search_path = public
as $$
  select p_type = any (array[
    'follow', 'follow_request', 'comment', 'mention', 'reaction', 'watch_tag',
    'recommendation', 'recommendation_ranked', 'invite_activated', 'invite_joined',
    'award_earned', 'goal_completed',
    'import_started', 'import_completed', 'import_failed'
  ]::text[]);
$$;


-- ---------------------------------------------------------------------------
-- The claim carries the job. Rebuilt from 20260904000100; the only change is the two
-- import fields, so the push can open this job and quote its summary.
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
        'attempt',         j.attempt,
        'type',            j.type,
        'actor_username',  j.actor_username,
        'actor_name',      j.actor_name,
        'media_item_id',   j.media_item_id,
        'media_kind',      j.media_kind,
        'media_title',     j.media_title,
        'series_title',    j.series_title,
        'feed_event_id',   j.feed_event_id,
        'comment_excerpt', j.comment_excerpt,
        -- 20260917001500. The job an import notification is about, and the summary its
        -- completion push quotes. Null for every other type.
        'import_job_id',   j.import_job_id,
        'import_counts',   j.import_counts,
        'tokens',          j.tokens
      )
      order by j.created_at
    ),
    jsonb_build_array()
  )
  into v_jobs
  from (
    select n.id,
           o.attempts                              as attempt,
           n.type,
           n.created_at,
           p.username::text                        as actor_username,
           coalesce(p.display_name, p.username::text) as actor_name,
           m.id                                    as media_item_id,
           m.kind::text                            as media_kind,
           m.title                                 as media_title,
           parent.title                            as series_title,
           case when n.subject_type = 'feed_event' then n.subject_id end as feed_event_id,
           case when n.subject_type = 'import_job' then n.subject_id end as import_job_id,
           case when n.type = 'import_completed' then n.payload end as import_counts,
           -- Comment jobs only, and `mention` is deliberately not one of them.
           -- See the header: a mention push says who and where, never what.
           case when n.type = 'comment' then (
             select left(c.body, 180)
               from comments c
              where c.id = (n.payload ->> 'comment_id')::uuid
                and c.deleted_at is null
                and not c.has_spoilers
           ) end                                   as comment_excerpt,
           (
             select jsonb_agg(jsonb_build_object('token', d.token, 'platform', d.platform))
               from device_tokens d
              where d.user_id = n.recipient_id
                and d.revoked_at is null
           )                                       as tokens
      from notifications n
      join push_outbox o on o.notification_id = n.id
      left join profiles p
             on p.id = n.actor_id
            and p.status = 'active'
      left join feed_events fe
             on n.subject_type = 'feed_event'
            and fe.id = n.subject_id
            -- The same three rules `my_notifications` states, in the same words, from
            -- the recipient's side -- including the read-time `can_view_profile` on a
            -- mention's activity owner, so a title whose owner has since blocked the
            -- recipient or gone private is not pushed to their lock screen.
            and case
                  when n.type = 'recommendation_ranked' then fe.actor_id = n.actor_id
                  when n.type = 'mention' then can_view_profile(n.recipient_id, fe.actor_id)
                  else fe.actor_id = n.recipient_id
                end
      left join media_items m
             on m.id = case
                         when n.subject_type = 'media_item' then n.subject_id
                         else fe.media_item_id
                       end
      left join media_items parent
             on parent.id = m.parent_id
     where n.id = any (v_claimed)
       and not (n.id = any (v_dead))
       -- **Restored 2026-08-30 (20260904000100).** An actorless notification has nobody
       -- to have gone, and this predicate was the actorless filter by accident until
       -- 20260828000100 wrote the escape. The 20260830000100 rebuild -- which added the
       -- mention join two lines up -- was assembled from an ancestor that predated that
       -- escape and dropped it again, silently: an award congratulations was claimed,
       -- filtered out here, and its outbox row deleted by the reap below, so it never
       -- retried and never sent. Exactly the failure 20260828000100 warns a
       -- create-or-replace can make invisible in a diff.
       and (p.id is not null or n.actor_id is null)
  ) j;

  delete from push_outbox o
   where o.notification_id = any (v_claimed)
     and o.notification_id not in (
       select (job ->> 'notification_id')::uuid from jsonb_array_elements(v_jobs) as job
     );

  return v_jobs;
end;
$$;

comment on function claim_push_batch(integer) is
  'Claims up to p_limit queued pushes and returns everything needed to send them, recipients and tokens resolved server-side. Takes no recipient and cannot be pointed at one. Applies can_discover_profile exactly as my_notifications does, so a notification that raced a block is not pushed; an actorless notification (award_earned, 20260828000100) has nobody to check and survives -- a predicate 20260830000100 dropped by accident and 20260904000100 restored, with a test behind it. Five-minute lease with skip locked, so delivery is at least once, bounded at three settled failures and six claims. Reaps rows that have hit either ceiling. Carries feed_event_id since 20260826000600, comment_excerpt since 20260827000300, the actor''s own event for recommendation_ranked since 20260827000600, award_name since 20260828000100, the mention branch since 20260830000100, and import_job_id / import_counts since 20260917001500. A job it returns may still be dropped before dispatch by live_push_jobs (20260904000100).';
