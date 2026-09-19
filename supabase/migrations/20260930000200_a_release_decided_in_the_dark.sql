-- ===========================================================================
-- Release awareness, part 2: deciding who would hear about it, and telling nobody
--
-- Specification: docs/product/release-awareness.md (§E, §F). Founder decisions
-- 2026-09-19, which this file implements as SHADOW ONLY:
--
--   1. v1 events: new-season premieres and watchlisted-film US theatrical releases.
--   2. Cap: at most 2 proactive pushes per rolling 7 days, at least 36 hours apart.
--      Losing to the cap costs the push, never the inbox event.
--   3. Series tiers: CAUGHT UP (watched/ranked the most recent prior season) may be
--      pushed; BEHIND (some earlier season, not the most recent) is inbox only; NO
--      HISTORY gets nothing. No numeric score.
--   4. Real sending OFF, shadow evaluation ON. The first production deployment must be
--      INCAPABLE of sending a proactive push even when a release is detected.
--   5. Send window 10:00-20:00 in the account's own timezone. Unknown timezone: the
--      inbox event may exist, the push may not, and no timezone is ever guessed.
--
-- HOW DECISION 4 IS MADE STRUCTURAL RATHER THAN A SETTING
--
-- Nothing in this tranche can deliver anything. No function here, or in 20260930000100,
-- inserts into `notifications` or `push_outbox`, and neither release type is in
-- `_push_eligible`, so even a hand-written notification row of these types would not
-- enqueue. `release.push_enabled` is seeded false and is recorded on every decision as
-- `real_send_enabled`; flipping it changes that column and nothing else. Real delivery
-- needs a later migration, which needs founder approval after the shadow review. The
-- tests assert both halves: the whole pipeline run with the flag forced true still writes
-- zero notifications and zero outbox rows, and no release function body names either
-- table.
--
-- WHAT THE LEDGER IS FOR
--
-- One row per (account, release event), ever: the dedupe. Each row carries every
-- dimension the founder asked to be able to count (event type, tier, freshness, timezone
-- known, region, device, preference, cap, window) plus the outcome a live system would
-- have reached: would_push, inbox_only, or skipped, with the reason. It is per-account
-- operational data, so it is service_role only; release_shadow_summary is the aggregate
-- an operator reads.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. Switches and limits (operator-side; none readable by clients)
-- ---------------------------------------------------------------------------

insert into app_config (key, value) values
  -- Shadow evaluation: ON (founder decision 4).
  ('release.shadow_enabled', 'true'::jsonb),
  -- Real sending: OFF (founder decision 4). Recorded on every decision; consulted by no
  -- sending code, because in this tranche there is no sending code.
  ('release.push_enabled', 'false'::jsonb),
  ('release.push_cap_per_week', '2'::jsonb),
  ('release.push_min_gap_hours', '36'::jsonb),
  ('release.window_start_hour', '10'::jsonb),
  ('release.window_end_hour', '20'::jsonb),
  -- How long a would-push candidate waits for an open window and room under the cap.
  ('release.push_expiry_hours', '48'::jsonb)
on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- 1. The shadow ledger
-- ---------------------------------------------------------------------------

create table release_shadow_ledger (
  id                uuid primary key default gen_random_uuid(),
  release_event_id  uuid not null references release_events(id) on delete cascade,
  user_id           uuid not null references profiles(id) on delete cascade,
  event_kind        text not null check (event_kind in ('season_premiere', 'theatrical_release')),
  -- caught_up / behind / no_history for a premiere (decision 3); watchlist for a film.
  tier              text not null check (tier in ('caught_up', 'behind', 'no_history', 'watchlist')),
  -- Evaluation date minus release date, in whole days (UTC). -1 is possible: a date is
  -- reached once it has begun anywhere, which can be tomorrow in UTC.
  freshness_days    integer not null check (freshness_days >= -1),
  timezone_known    boolean not null,
  -- The account's region relative to the event's: match / unknown / mismatch, or
  -- not_applicable for a premiere. The region itself is not copied here.
  region_status     text not null check (region_status in ('match', 'unknown', 'mismatch', 'not_applicable')),
  has_device        boolean not null,
  preference_on     boolean not null,
  outcome           text not null check (outcome in ('pending', 'would_push', 'inbox_only', 'skipped')),
  reason            text not null check (reason in (
                      -- pending: a push candidate waiting for its window and the cap.
                      'pending',
                      -- would_push.
                      'would_send',
                      -- skipped: no inbox event and no push.
                      'no_history', 'already_watched', 'region_mismatch', 'preference_off',
                      -- inbox_only: the event exists, the push does not.
                      'behind_tier', 'no_timezone', 'region_unknown',
                      'quiet_window', 'global_cap', 'cap_spacing', 'lost_to_priority',
                      'before_local_release', 'expired')),
  -- For a pending row: what kept it from being pushed on the latest tick. Becomes the
  -- reason if it expires.
  last_block_reason text,
  expires_at        timestamptz,
  created_at        timestamptz not null,
  decided_at        timestamptz,
  would_push_at     timestamptz,
  -- release.push_enabled as read at the decision. Always false in this tranche, and
  -- nothing acts on it.
  real_send_enabled boolean not null default false,

  constraint release_shadow_once unique (user_id, release_event_id),
  constraint release_shadow_would_push check ((outcome = 'would_push') = (would_push_at is not null)),
  constraint release_shadow_decided check ((outcome = 'pending') = (decided_at is null))
);

create index release_shadow_pending on release_shadow_ledger (user_id) where outcome = 'pending';
create index release_shadow_pushes  on release_shadow_ledger (user_id, would_push_at) where outcome = 'would_push';

comment on table release_shadow_ledger is
  'SHADOW. One row per (account, release event), ever: what a live release notification would have done — would_push, inbox_only or skipped, with the reason and every dimension behind it. Nothing reads it to send; nothing in this tranche sends. Per-account operational data: service_role only, never returned to a client. Aggregate through release_shadow_summary.';


-- ---------------------------------------------------------------------------
-- 2. Stage one: an event that has just been released becomes ledger rows
-- ---------------------------------------------------------------------------

create or replace function _release_fanout_event(p_event uuid, p_now timestamptz)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  e          release_events%rowtype;
  v_fresh    integer;
  v_expiry   interval;
  v_push     boolean;
  v_inserted integer;
begin
  select * into e from release_events where id = p_event;
  v_fresh  := (p_now at time zone 'UTC')::date - e.released_on;
  v_expiry := make_interval(hours => (_release_setting('release.push_expiry_hours', '48'::jsonb) #>> '{}')::integer);
  v_push   := _release_setting('release.push_enabled', 'false'::jsonb) = 'true'::jsonb;

  if e.event_kind = 'season_premiere' then
    with seasons as (
      select id, season_number
        from media_items
       where parent_id = e.subject_id and kind = 'season' and season_number > 0
    ),
    -- The most recently released prior season: the highest normal season below this one.
    prior as (
      select max(season_number) as n from seasons where season_number < e.season_number
    ),
    -- WATCHED, per account and season: ranked, or logged with a bucket, a date or
    -- progress = 'completed'. Exactly the series-watchlist rule's watch signal
    -- (20260906000100). Decision 3 says "watched/ranked", so a season merely in progress
    -- does not make anybody caught up, or give them history.
    signal as (
      select r.user_id, s.season_number
        from rankings r join seasons s on s.id = r.media_item_id
      union
      select um.user_id, s.season_number
        from user_media um join seasons s on s.id = um.media_item_id
       where um.bucket is not null or um.watched_on is not null or um.progress = 'completed'
    ),
    -- Any collection row at all, including progress = 'watching'.
    touched as (
      select um.user_id, s.season_number
        from user_media um join seasons s on s.id = um.media_item_id
      union
      select user_id, season_number from signal
    ),
    -- Everybody with any explicit interest. Accounts with only a watchlist entry or only a
    -- season in progress are included so the shadow can count them, and are then skipped
    -- as no_history (decision 3).
    interested as (
      select user_id from touched
      union
      select user_id from watchlist where media_item_id in (e.subject_id, e.media_item_id)
    ),
    cand as (
      select i.user_id,
             exists (select 1 from touched g where g.user_id = i.user_id and g.season_number = e.season_number) as already,
             exists (select 1 from signal g where g.user_id = i.user_id and g.season_number < e.season_number) as any_prior,
             exists (select 1 from signal g, prior
                      where g.user_id = i.user_id and g.season_number = prior.n)                              as caught_up,
             ac.timezone is not null                                                                       as tz_known,
             exists (select 1 from device_tokens d where d.user_id = i.user_id and d.revoked_at is null)    as has_device,
             _notifies(i.user_id, 'new_seasons')                                                           as pref
        from interested i
        join profiles p on p.id = i.user_id and p.status = 'active'
        left join account_context ac on ac.user_id = i.user_id
    ),
    decided as (
      select c.*,
             case when c.caught_up then 'caught_up' when c.any_prior then 'behind' else 'no_history' end as tier,
             case
               when c.already         then 'skipped'
               when not c.any_prior   then 'skipped'
               when not c.pref        then 'skipped'
               when not c.caught_up   then 'inbox_only'
               when not c.tz_known    then 'inbox_only'
               else 'pending'
             end as outcome,
             case
               when c.already         then 'already_watched'
               when not c.any_prior   then 'no_history'
               when not c.pref        then 'preference_off'
               when not c.caught_up   then 'behind_tier'
               when not c.tz_known    then 'no_timezone'
               else 'pending'
             end as reason
        from cand c
    )
    insert into release_shadow_ledger (
      release_event_id, user_id, event_kind, tier, freshness_days, timezone_known,
      region_status, has_device, preference_on, outcome, reason, expires_at,
      created_at, decided_at, real_send_enabled
    )
    select e.id, d.user_id, e.event_kind, d.tier, v_fresh, d.tz_known,
           'not_applicable', d.has_device, d.pref, d.outcome, d.reason,
           case when d.outcome = 'pending' then p_now + v_expiry end,
           p_now, case when d.outcome = 'pending' then null else p_now end, v_push
      from decided d
    on conflict (user_id, release_event_id) do nothing;

  else
    with cand as (
      select w.user_id,
             (exists (select 1 from rankings r where r.user_id = w.user_id and r.media_item_id = e.media_item_id)
              or exists (select 1 from user_media um
                          where um.user_id = w.user_id and um.media_item_id = e.media_item_id
                            and (um.bucket is not null or um.watched_on is not null)))              as already,
             case when ac.region is null then 'unknown'
                  when ac.region = e.region then 'match'
                  else 'mismatch' end                                                             as region_status,
             ac.timezone is not null                                                              as tz_known,
             exists (select 1 from device_tokens d where d.user_id = w.user_id and d.revoked_at is null) as has_device,
             _notifies(w.user_id, 'watchlist_releases')                                           as pref
        from watchlist w
        join profiles p on p.id = w.user_id and p.status = 'active'
        left join account_context ac on ac.user_id = w.user_id
       where w.media_item_id = e.media_item_id
    ),
    decided as (
      select c.*,
             case
               when c.already                       then 'skipped'
               when c.region_status = 'mismatch'    then 'skipped'
               when not c.pref                      then 'skipped'
               when c.region_status = 'unknown'     then 'inbox_only'
               when not c.tz_known                  then 'inbox_only'
               else 'pending'
             end as outcome,
             case
               when c.already                       then 'already_watched'
               when c.region_status = 'mismatch'    then 'region_mismatch'
               when not c.pref                      then 'preference_off'
               when c.region_status = 'unknown'     then 'region_unknown'
               when not c.tz_known                  then 'no_timezone'
               else 'pending'
             end as reason
        from cand c
    )
    insert into release_shadow_ledger (
      release_event_id, user_id, event_kind, tier, freshness_days, timezone_known,
      region_status, has_device, preference_on, outcome, reason, expires_at,
      created_at, decided_at, real_send_enabled
    )
    select e.id, d.user_id, e.event_kind, 'watchlist', v_fresh, d.tz_known,
           d.region_status, d.has_device, d.pref, d.outcome, d.reason,
           case when d.outcome = 'pending' then p_now + v_expiry end,
           p_now, case when d.outcome = 'pending' then null else p_now end, v_push
      from decided d
    on conflict (user_id, release_event_id) do nothing;
  end if;

  get diagnostics v_inserted = row_count;

  update release_events set evaluation = 'done', evaluated_at = p_now where id = p_event;
  return v_inserted;
end;
$$;

comment on function _release_fanout_event(uuid, timestamptz) is
  'SHADOW. Turns one freshly released event into release_shadow_ledger rows, one per interested active account: tier (decision 3), timezone, region, device and preference recorded; skipped / inbox_only decided at once; push candidates left pending for arbitration. on conflict do nothing is the per-account dedupe. Writes no notification. Internal.';


-- ---------------------------------------------------------------------------
-- 3. Stage two: arbitration. Which pending candidate a live system would push now.
--
-- Per account, per tick: expired candidates settle inbox_only with the reason that kept
-- them waiting. Then, only inside 10:00-20:00 local, only once the release date has begun
-- locally (and, for a premiere, not before that date begins in America/Los_Angeles, so a
-- US premiere is never announced the evening before it airs), only with room under the
-- cap (fewer than 2 would-pushes in 7 days, the last at least 36 hours ago): the single
-- best candidate becomes would_push. Best is explicit, not a score: a caught-up premiere,
-- then a watchlisted film, then the most recent release.
-- ---------------------------------------------------------------------------

create or replace function _release_arbitrate(p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cap     integer := (_release_setting('release.push_cap_per_week', '2'::jsonb) #>> '{}')::integer;
  v_gap     interval := make_interval(hours => (_release_setting('release.push_min_gap_hours', '36'::jsonb) #>> '{}')::integer);
  v_start   integer := (_release_setting('release.window_start_hour', '10'::jsonb) #>> '{}')::integer;
  v_end     integer := (_release_setting('release.window_end_hour', '20'::jsonb) #>> '{}')::integer;
  v_push    boolean := _release_setting('release.push_enabled', 'false'::jsonb) = 'true'::jsonb;
  v_user    record;
  v_local   timestamp;
  v_count   integer;
  v_last    timestamptz;
  v_win     uuid;
  v_block   text;
  v_expired integer;
  v_pushed  integer := 0;
begin
  update release_shadow_ledger
     set outcome    = 'inbox_only',
         reason     = coalesce(last_block_reason, 'expired'),
         decided_at = p_now
   where outcome = 'pending' and expires_at <= p_now;
  get diagnostics v_expired = row_count;

  for v_user in
    select l.user_id, ac.timezone
      from (select distinct user_id from release_shadow_ledger where outcome = 'pending') l
      left join account_context ac on ac.user_id = l.user_id
     order by l.user_id
  loop
    v_block := null;
    v_win := null;

    if v_user.timezone is null then
      -- Known when the row was written, gone since. Never guessed.
      v_block := 'no_timezone';
    else
      v_local := p_now at time zone v_user.timezone;
      if extract(hour from v_local) < v_start or extract(hour from v_local) >= v_end then
        v_block := 'quiet_window';
      end if;
    end if;

    if v_block is null then
      select count(*), max(would_push_at) into v_count, v_last
        from release_shadow_ledger
       where user_id = v_user.user_id and outcome = 'would_push'
         and would_push_at > p_now - interval '7 days';
      if v_count >= v_cap then
        v_block := 'global_cap';
      elsif v_last is not null and v_last > p_now - v_gap then
        v_block := 'cap_spacing';
      end if;
    end if;

    if v_block is null then
      select l.id into v_win
        from release_shadow_ledger l
        join release_events e on e.id = l.release_event_id
       where l.user_id = v_user.user_id
         and l.outcome = 'pending'
         and v_local::date >= e.released_on
         and (e.event_kind <> 'season_premiere'
              or p_now >= (e.released_on::timestamp at time zone 'America/Los_Angeles'))
       order by case l.tier when 'caught_up' then 0 when 'watchlist' then 1 else 2 end,
                e.released_on desc,
                l.id
       limit 1;
      if v_win is null then
        v_block := 'before_local_release';
      end if;
    end if;

    if v_win is not null then
      update release_shadow_ledger
         set outcome           = 'would_push',
             reason            = 'would_send',
             would_push_at     = p_now,
             decided_at        = p_now,
             last_block_reason = null,
             real_send_enabled = v_push
       where id = v_win;
      v_pushed := v_pushed + 1;
      v_block := 'lost_to_priority';
    end if;

    update release_shadow_ledger
       set last_block_reason = v_block
     where user_id = v_user.user_id and outcome = 'pending';
  end loop;

  return jsonb_build_object('expired', v_expired, 'would_push', v_pushed);
end;
$$;

comment on function _release_arbitrate(timestamptz) is
  'SHADOW. Settles expired push candidates as inbox_only (reason: what kept them waiting) and, per account inside its 10:00-20:00 local window with room under the cap (2 per rolling 7 days, 36h apart), marks the single best pending candidate would_push. Priority is explicit: caught-up premiere, then watchlisted film, then most recent. Sends nothing. Internal.';


-- ---------------------------------------------------------------------------
-- 4. The evaluation tick
-- ---------------------------------------------------------------------------

create or replace function _release_evaluate(p_now timestamptz default now(), p_event_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event  uuid;
  v_events integer := 0;
  v_rows   integer := 0;
  v_arb    jsonb;
begin
  if _release_setting('release.shadow_enabled', 'true'::jsonb) = 'false'::jsonb then
    return jsonb_build_object('status', 'disabled');
  end if;

  for v_event in
    select id from release_events
     where evaluation = 'pending'
     order by released_observed_at, id
     limit greatest(1, coalesce(p_event_limit, 50))
     for update skip locked
  loop
    v_rows := v_rows + _release_fanout_event(v_event, p_now);
    v_events := v_events + 1;
  end loop;

  v_arb := _release_arbitrate(p_now);

  return jsonb_build_object('status', 'evaluated', 'events', v_events, 'ledger_rows', v_rows)
         || v_arb;
end;
$$;

comment on function _release_evaluate(timestamptz, integer) is
  'SHADOW. The scheduled evaluation: fans each pending release event out into release_shadow_ledger, then arbitrates pending push candidates. One transaction, so a failure rolls the whole tick back and the next tick repeats it; the ledger''s unique key keeps a repeat from doubling anything. release.shadow_enabled = false stops it. Sends nothing. Internal.';


-- ---------------------------------------------------------------------------
-- 5. What an operator reads
-- ---------------------------------------------------------------------------

create view release_shadow_summary with (security_invoker = true) as
select l.event_kind,
       l.tier,
       l.outcome,
       l.reason,
       count(*)                                         as decisions,
       count(distinct l.user_id)                        as accounts,
       count(distinct l.release_event_id)               as events,
       count(*) filter (where l.timezone_known)         as timezone_known,
       count(*) filter (where l.has_device)             as with_device,
       count(*) filter (where l.freshness_days <= 1)    as fresh_within_1d,
       count(*) filter (where l.real_send_enabled)      as real_send_enabled,
       min(l.created_at)                                as first_at,
       max(l.created_at)                                as last_at
  from release_shadow_ledger l
 group by l.event_kind, l.tier, l.outcome, l.reason;

comment on view release_shadow_summary is
  'SHADOW. The ledger in aggregate: decisions per (event kind, tier, outcome, reason) with the dimensions counted. What the 7-14 day review reads. service_role only.';

create view release_event_summary with (security_invoker = true) as
select e.event_kind,
       e.state,
       e.evaluation,
       count(*)                                       as events,
       count(*) filter (where e.date_changes > 0)     as with_date_changes,
       sum(e.date_changes)                            as date_changes,
       min(e.scheduled_date) filter (where e.state = 'scheduled') as next_date,
       max(e.released_on)                             as latest_release
  from release_events e
 group by e.event_kind, e.state, e.evaluation;

comment on view release_event_summary is
  'Release events per (kind, state, evaluation): how many, how many have moved, the next scheduled date and the latest release. service_role only.';


create or replace function release_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_problems  text[] := array[]::text[];
  v_jobs      jsonb := null;
  v_url       boolean;
  v_secret    boolean := false;
  v_net       boolean;
  v_proc      regprocedure;
  v_subjects  jsonb;
  v_events    jsonb;
  v_ledger    jsonb;
  v_sent      bigint;
  v_outbox    bigint;
  v_push      boolean := _release_setting('release.push_enabled', 'false'::jsonb) = 'true'::jsonb;
begin
  select exists (select 1 from app_config where key = 'functions.base_url'
                  and nullif(value #>> '{}', '') is not null) into v_url;
  if to_regclass('vault.decrypted_secrets') is not null then
    begin
      execute $q$ select exists (select 1 from vault.decrypted_secrets
                   where name = 'service_role_key' and nullif(decrypted_secret, '') is not null) $q$
        into v_secret;
    exception when others then
      v_secret := false;
    end;
  end if;
  v_proc := to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)');
  v_net := v_proc is not null and has_function_privilege(v_proc, 'execute');

  if to_regclass('cron.job') is not null then
    execute $q$
      select jsonb_object_agg(jobname, jsonb_build_object('schedule', schedule, 'active', active))
        from cron.job where jobname in ('bingd-release-refresh', 'bingd-release-evaluate')
    $q$ into v_jobs;
    if v_jobs is null or not v_jobs ? 'bingd-release-refresh' then
      v_problems := v_problems || 'refresh_job_missing'::text;
    end if;
    if v_jobs is null or not v_jobs ? 'bingd-release-evaluate' then
      v_problems := v_problems || 'evaluate_job_missing'::text;
    end if;
  end if;

  if not v_url then v_problems := v_problems || 'functions_base_url_missing'::text; end if;
  if not v_secret then v_problems := v_problems || 'vault_service_role_key_missing'::text; end if;
  if not v_net then v_problems := v_problems || 'pg_net_unavailable'::text; end if;

  select jsonb_build_object(
           'total',          count(*),
           'series',         count(*) filter (where subject_kind = 'series'),
           'movies',         count(*) filter (where subject_kind = 'movie'),
           'due',            count(*) filter (where next_check_at <= now()),
           'overdue_6h',     count(*) filter (where next_check_at <= now() - interval '6 hours'),
           'never_read',     count(*) filter (where last_read_at is null),
           'failing',        count(*) filter (where failures >= 3),
           'last_read_at',   max(last_read_at))
    into v_subjects
    from release_subjects;

  if (v_subjects ->> 'overdue_6h')::integer > 0 then
    v_problems := v_problems || 'refresh_stalled'::text;
  end if;
  if (v_subjects ->> 'failing')::integer > 0 then
    v_problems := v_problems || 'subjects_failing'::text;
  end if;

  select jsonb_build_object(
           'by_state',   coalesce((select jsonb_object_agg(state, n) from (select state, count(*) n from release_events group by state) s), '{}'),
           'pending_evaluation', count(*) filter (where evaluation = 'pending'),
           'oldest_pending', min(released_observed_at) filter (where evaluation = 'pending'))
    into v_events
    from release_events;

  if (v_events ->> 'oldest_pending')::timestamptz < now() - interval '1 hour' then
    v_problems := v_problems || 'evaluation_backlog'::text;
  end if;

  select coalesce(jsonb_object_agg(outcome, n), '{}') into v_ledger
    from (select outcome, count(*) n from release_shadow_ledger group by outcome) s;

  -- The proof column for decision 4. Both must be zero for as long as real sending is off.
  select count(*) into v_sent
    from notifications where type in ('season_premiere', 'theatrical_release');
  select count(*) into v_outbox
    from push_outbox o join notifications n on n.id = o.notification_id
   where n.type in ('season_premiere', 'theatrical_release');

  if v_sent > 0 or v_outbox > 0 then
    v_problems := v_problems || 'release_notifications_exist'::text;
  end if;
  if v_push then
    v_problems := v_problems || 'real_send_flag_on'::text;
  end if;

  return jsonb_build_object(
    'healthy',               cardinality(v_problems) = 0,
    'problems',              to_jsonb(v_problems),
    'mode',                  jsonb_build_object(
                               'refresh_enabled', _release_setting('release.refresh_enabled', 'true'::jsonb) <> 'false'::jsonb,
                               'shadow_enabled',  _release_setting('release.shadow_enabled', 'true'::jsonb) <> 'false'::jsonb,
                               'real_send_enabled', v_push),
    'jobs',                  v_jobs,
    'subjects',              v_subjects,
    'events',                v_events,
    'ledger',                v_ledger,
    'release_notifications', v_sent,
    'release_push_outbox',   v_outbox
  );
end;
$$;

comment on function release_status() is
  'One call that says whether release awareness is healthy: cron jobs present, transport configured, subjects being read on time and not failing, evaluation keeping up, and, for founder decision 4, how many release notifications and outbox rows exist (must be zero while real sending is off). service_role only.';


-- ---------------------------------------------------------------------------
-- 6. The installer, the off switch, and history pruning
-- ---------------------------------------------------------------------------

create or replace function _release_prune_cron_history()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer := 0;
begin
  if to_regclass('cron.job_run_details') is null or to_regclass('cron.job') is null then
    return 0;
  end if;
  execute $q$
    delete from cron.job_run_details d
     using cron.job j
     where j.jobid = d.jobid
       and j.jobname in ('bingd-release-refresh', 'bingd-release-evaluate')
       and d.end_time < now() - interval '14 days'
  $q$;
  get diagnostics v_deleted = row_count;
  return v_deleted;
exception when others then
  return 0;
end;
$$;

create or replace function schedule_release_awareness()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old     bigint;
  v_refresh bigint;
  v_eval    bigint;
begin
  if to_regclass('cron.job') is null then
    raise exception 'pg_cron is not installed on this database'
      using errcode = '55000',
            hint = 'Enable pg_cron and pg_net (Supabase dashboard, Database > Extensions), then call this again.';
  end if;

  for v_old in execute $q$
    select jobid from cron.job where jobname in ('bingd-release-refresh', 'bingd-release-evaluate')
  $q$
  loop
    execute $q$ select cron.unschedule($1) $q$ using v_old;
  end loop;

  -- Hourly, off the hour. The six-hour tier around a release date is what needs it.
  execute $q$ select cron.schedule('bingd-release-refresh', '7 * * * *',
    'select public._release_refresh_tick()') $q$ into v_refresh;
  -- Every fifteen minutes, so a local 10:00 window opens within a quarter hour.
  execute $q$ select cron.schedule('bingd-release-evaluate', '*/15 * * * *',
    'select public._release_evaluate(), public._release_prune_cron_history()') $q$ into v_eval;

  return jsonb_build_object('status', 'ok', 'refresh_jobid', v_refresh, 'evaluate_jobid', v_eval);
end;
$$;

comment on function schedule_release_awareness() is
  'Installs (or replaces) the two release jobs: bingd-release-refresh (hourly at :07, _release_refresh_tick) and bingd-release-evaluate (every 15 minutes, SHADOW evaluation). Call only after tmdb-adapter is deployed with its release-refresh action. Idempotent by job name. service_role only.';

create or replace function unschedule_release_awareness()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids bigint[] := '{}';
  v_id  bigint;
begin
  if to_regclass('cron.job') is null then
    return jsonb_build_object('status', 'absent');
  end if;
  for v_id in execute $q$
    select jobid from cron.job where jobname in ('bingd-release-refresh', 'bingd-release-evaluate')
  $q$
  loop
    execute $q$ select cron.unschedule($1) $q$ using v_id;
    v_ids := v_ids || v_id;
  end loop;
  if array_length(v_ids, 1) is null then
    return jsonb_build_object('status', 'absent');
  end if;
  return jsonb_build_object('status', 'ok', 'jobids', to_jsonb(v_ids));
end;
$$;

comment on function unschedule_release_awareness() is
  'Stops both release jobs. Nothing is lost: subjects, events and the ledger stay, and schedule_release_awareness() resumes them. Idempotent. service_role only.';


-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------

alter table release_shadow_ledger enable row level security;
revoke all on release_shadow_ledger from anon, authenticated;
revoke all on release_shadow_summary, release_event_summary from anon, authenticated;

revoke execute on function _release_fanout_event(uuid, timestamptz)    from public, anon, authenticated;
revoke execute on function _release_arbitrate(timestamptz)             from public, anon, authenticated;
revoke execute on function _release_evaluate(timestamptz, integer)     from public, anon, authenticated;
revoke execute on function release_status()                            from public, anon, authenticated;
revoke execute on function _release_prune_cron_history()               from public, anon, authenticated;
revoke execute on function schedule_release_awareness()                from public, anon, authenticated;
revoke execute on function unschedule_release_awareness()              from public, anon, authenticated;

grant execute on function _release_evaluate(timestamptz, integer) to service_role;
grant execute on function release_status()                        to service_role;
grant execute on function schedule_release_awareness()            to service_role;
grant execute on function unschedule_release_awareness()          to service_role;
