-- ROLLBACK of 20261130001100_a_friend_you_actually_talk_to. STAGING ONLY unless separately
-- approved by the founder.
--
-- NOT THE EMERGENCY STOP. To stop proactive pushes now: proactive.push_enabled false
-- (push-operations.md §12). To stop the social pilot creating anything:
-- proactive.social_enabled false (or proactive.generation_enabled false). Neither needs this.
--
-- Restores, verbatim, the five functions the migration rebuilt, with their comments (grants
-- were never changed, `create or replace` keeps them):
--
--   * `_proactive_social_on_activity`, `_proactive_invalid`, `_proactive_tick` and
--     `proactive_status` as 20261031000100 left them;
--   * `_proactive_social_actors` as 20261028000100 left it.
--
-- And removes what only they used: the trigger `proactive_candidates_pilot_scope`, the
-- functions `_proactive_candidates_pilot_scope`, `_proactive_pilot_allows`,
-- `_proactive_pilot_recipients`, `_proactive_friend_qualifies`, `_proactive_friend_min_affinity`,
-- `_proactive_social_enabled` and `_proactive_theatrical_enabled`, and the app_config keys
-- `proactive.social_enabled`, `proactive.theatrical_enabled`, `proactive.friend_min_affinity`
-- and `proactive.pilot_recipients`.
--
-- KEPT, deliberately: `_proactive_reasons()` with its three extra words (`social_disabled`,
-- `theatrical_disabled`, `outside_pilot`). Candidates decided while the migration was in place
-- carry them, and the two check constraints on `proactive_candidates` call this function, so
-- removing the words would make those rows fail their own check on their next update. A
-- superset vocabulary changes no behaviour.
--
-- REFUSES while `proactive.generation_enabled` is true. The restored trigger qualifies a friend
-- on mutual follow alone, has no allowlist and no social switch, and the restored tick starts
-- theatrical with generation: rolling back with generation on would turn a pilot into exactly
-- the general rollout the doctrine forbids. Turn generation off first.
--
-- Data: nothing is deleted. Candidates, inbox rows and clusters stay as they are; pending ones
-- are judged by the restored functions from the next tick.
--
-- The `supabase_migrations.schema_migrations` row for 20261130001100 is the operator's to
-- delete in the same transaction, as for every rollback here; this script does not touch it.
--
-- Rehearsed in PGlite by supabase/tests/proactive-pilot-rollback.test.mjs.
--
-- One transaction, so a failure leaves the migration fully in place.
begin;

do $guard$
begin
  if (select value from app_config where key = 'proactive.generation_enabled') = 'true'::jsonb then
    raise exception 'proactive pilot rollback refused: proactive.generation_enabled is true'
      using errcode = '55000',
            hint = 'Set proactive.generation_enabled to false first; the restored trigger would qualify friends on mutual follow alone.';
  end if;
end;
$guard$;

drop trigger if exists proactive_candidates_pilot_scope on proactive_candidates;


-- As 20261028000100 left it.
create or replace function _proactive_social_actors(p_candidate uuid, p_recipient uuid)
returns table (actor_id uuid, username text, display_name text, avatar_path text, first_joined timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.username::text, p.display_name, p.avatar_path, min(a.joined_at)
    from proactive_cluster_actors a
    join profiles p on p.id = a.actor_id and p.status = 'active'
   where a.candidate_id = p_candidate
     and a.actor_id <> p_recipient
     and exists (select 1 from follows f
                  where f.follower_id = p_recipient and f.followee_id = a.actor_id and f.state = 'approved')
     and exists (select 1 from follows f
                  where f.follower_id = a.actor_id and f.followee_id = p_recipient and f.state = 'approved')
     and can_view_profile(p_recipient, a.actor_id)
   group by p.id, p.username, p.display_name, p.avatar_path
   order by min(a.joined_at), p.id;
$$;

comment on function _proactive_social_actors(uuid, uuid) is
  'The members of one watchlist_social cluster the recipient may be told about now: active, mutual follows, viewable, not the recipient. Earliest first. Internal.';


-- As 20261031000100 left it.
create or replace function _proactive_social_on_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reader uuid;
  v_first  text;
begin
  if new.type not in ('title_ranked', 'title_logged') or new.media_item_id is null then
    return null;
  end if;
  if _importing() then
    return null;
  end if;
  if new.created_at < now() - interval '1 day' then
    return null;
  end if;
  -- Fail closed: only an explicit true generates anything (seeded false).
  if not _proactive_generation_enabled() then
    return null;
  end if;

  -- 20261031000100. ONE QUALIFYING EVENT PER TRANSACTION (section 9's header). The
  -- setting is transaction-local, so it is unset ('' or null) at the start of every
  -- transaction; the first qualifying event claims it and any other is skipped.
  v_first := nullif(current_setting('bingd.proactive.social_event_id', true), '');
  if v_first is not null and v_first <> new.id::text then
    raise warning 'watchlist_social: skipped (second_qualifying_event_in_transaction)';
    return null;
  end if;
  perform set_config('bingd.proactive.social_event_id', new.id::text, true);

  for v_reader in
    select w.user_id
      from watchlist w
      join profiles rp on rp.id = w.user_id and rp.status = 'active'
     where w.media_item_id = new.media_item_id
       and w.user_id <> new.actor_id
       and exists (select 1 from follows f
                    where f.follower_id = w.user_id and f.followee_id = new.actor_id and f.state = 'approved')
       and exists (select 1 from follows f
                    where f.follower_id = new.actor_id and f.followee_id = w.user_id and f.state = 'approved')
       and can_view_profile(w.user_id, new.actor_id)
       and not _proactive_title_watched(w.user_id, new.media_item_id)
     order by w.user_id
  loop
    begin
      perform _proactive_social_add(v_reader, new.actor_id, new.media_item_id, new.id, now());
    exception when others then
      raise warning 'watchlist_social: % (%)', sqlerrm, sqlstate;
    end;
  end loop;

  return null;
end;
$$;

comment on function _proactive_social_on_activity() is
  'After-insert trigger on feed_events: a title_ranked or title_logged row written now (not during an import, not a backfill) joins the watchlist_social cluster of every active mutual friend who has that title saved, can view the actor and has not watched it. Since 20261031000100 only the first qualifying event of a transaction does (transaction-local bingd.proactive.social_event_id); a later one is skipped with the warning second_qualifying_event_in_transaction. Never fails the write it rides on. Internal.';


-- As 20261031000100 left it.
create or replace function _proactive_invalid(p_candidate uuid, p_now timestamptz)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c        proactive_candidates%rowtype;
  e        release_events%rowtype;
  v_tz     text;
  v_region text;
  v_today  date;
  v_event  uuid;
  v_reason text;
begin
  select * into c from proactive_candidates where id = p_candidate;
  if not found then
    return 'inactive_recipient';
  end if;

  if not exists (select 1 from profiles where id = c.recipient_id and status = 'active') then
    return 'inactive_recipient';
  end if;
  if not _notifies(c.recipient_id, 'watchlist_discovery') then
    return 'preference_off';
  end if;

  if c.type = 'season_premiere' then
    -- The operator switch first: off means no season reaches anybody, including one
    -- already selected for tonight (Codex final decision).
    if not _proactive_season_enabled() then
      return 'season_disabled';
    end if;
    v_event := (c.metadata ->> 'release_event_id')::uuid;
    if _proactive_season_touched(c.recipient_id, c.media_item_id) then
      return 'already_watched';
    end if;
    if _proactive_season_interest(c.recipient_id, v_event) is null then
      return 'no_season_interest';
    end if;
    v_reason := _proactive_season_release_reason(v_event, p_now);
    if v_reason is not null then
      return v_reason;
    end if;
    -- The reader's CURRENT region, as for a film: availability in the US is a claim about
    -- the US, and a timezone is never taken for a country.
    select region into v_region from account_context where user_id = c.recipient_id;
    if v_region is null then
      return 'region_unknown';
    end if;
    if v_region is distinct from 'US' then
      return 'region_mismatch';
    end if;
    if _proactive_season_verified_on(v_event, 'US', p_now)
         is distinct from (c.metadata ->> 'available_on')::date then
      return 'availability_unverified';
    end if;
    return null;
  end if;

  if not exists (select 1 from watchlist w where w.user_id = c.recipient_id and w.media_item_id = c.media_item_id) then
    return 'not_on_watchlist';
  end if;
  if _proactive_title_watched(c.recipient_id, c.media_item_id) then
    return 'already_watched';
  end if;

  if c.type = 'watchlist_social' then
    if (select count(*) from _proactive_social_actors(c.id, c.recipient_id))
         < _proactive_int('proactive.social_threshold', 2) then
      return 'below_threshold';
    end if;

  elsif c.type = 'theatrical_release' then
    select * into e from release_events where id = (c.metadata ->> 'release_event_id')::uuid;
    if not found
       or e.state <> 'scheduled'
       or e.scheduled_date is distinct from (c.metadata ->> 'opens_on')::date then
      return 'release_changed';
    end if;
    if e.last_observed_at < p_now - make_interval(hours => _proactive_int('proactive.theatrical_max_read_age_hours', 36)) then
      return 'release_stale';
    end if;
    -- The reader's CURRENT region (Codex review): a US date is a claim about the US, so a
    -- reader who has since reported another country, or no country, is not told it.
    select timezone, region into v_tz, v_region from account_context where user_id = c.recipient_id;
    if v_region is null then
      return 'region_unknown';
    end if;
    if v_region is distinct from e.region then
      return 'region_mismatch';
    end if;
    v_today := (p_now at time zone coalesce(v_tz, 'UTC'))::date;
    -- The point is notice. On the day itself it is a day-of push, which v1 never sends.
    if v_today >= e.scheduled_date then
      return 'too_late';
    end if;
  end if;

  return null;
end;
$$;

comment on function _proactive_invalid(uuid, timestamptz) is
  'Null if a proactive candidate is still true, else the permanent reason it is not: recipient inactive, preference off, title off the Watchlist, already watched, a social cluster below its threshold, or a film whose date moved, went stale or has arrived, or whose reader no longer reports a US region (region_mismatch / region_unknown). Since 20261031000100, for season_premiere: season_disabled (operator switch off), already_watched (the season touched), no_season_interest (no saved series or season, no watch of the season before), _proactive_season_release_reason, region_unknown / region_mismatch, availability_unverified (no valid US verification agreeing with the candidate). Asked before selection and again at send. Internal.';


-- As 20261031000100 left it.
create or replace function _proactive_tick(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_theatrical integer := 0;
  v_season     integer := 0;
  v_resurface  integer := 0;
begin
  -- The global arbiter lock first (LOCK HIERARCHY, 20261028000100 section 5), before the
  -- collectors write anything: an overlapping tick waits here holding no candidate row,
  -- not after its collectors have inserted some. _proactive_arbitrate takes it again,
  -- which is a no-op inside the same transaction.
  perform pg_advisory_xact_lock(hashtextextended('bingd.proactive.arbiter', 0));

  -- Fail closed: no collector runs unless generation is explicitly on (seeded false).
  if _proactive_generation_enabled() then
    v_theatrical := _proactive_theatrical_collect(p_now);
    -- 20261031000100. Creates nothing unless proactive.season_enabled is also exactly true.
    v_season     := _proactive_season_collect(p_now);
    v_resurface  := _proactive_resurface_collect(p_now);
  end if;

  return jsonb_build_object('theatrical_candidates', v_theatrical,
                            'season_candidates', v_season,
                            'resurface_candidates', v_resurface)
         || _proactive_arbitrate(p_now);
end;
$$;

comment on function _proactive_tick(timestamptz) is
  'The scheduled proactive pass: collect theatrical, season (also gated by proactive.season_enabled, 20261031000100) and resurfacing candidates (only while proactive.generation_enabled is exactly true; seeded false), then arbitrate. One transaction: a failure rolls the whole tick back and the next repeats it; the ledger''s unique keys keep a repeat from doubling anything. Internal; scheduled as bingd-proactive-tick.';


-- As 20261031000100 left it.
create or replace function proactive_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job      jsonb := null;
  v_problems text[] := array[]::text[];
  v_counts   jsonb;
  v_stuck    bigint;
  v_runs     jsonb := null;
begin
  if to_regclass('cron.job') is not null then
    execute $q$
      select jsonb_build_object('schedule', schedule, 'active', active)
        from cron.job where jobname = 'bingd-proactive-tick'
    $q$ into v_job;
    if v_job is null then
      v_problems := v_problems || 'tick_job_missing'::text;
    end if;
  end if;

  -- The tick's own history, from pg_cron's run log (Fable review, MINOR): the last run,
  -- the last success, and the last failure with its message. A last run that failed is a
  -- problem; a tick that raises rolls back, so this is where a broken tick shows.
  if to_regclass('cron.job_run_details') is not null and to_regclass('cron.job') is not null then
    execute $q$
      with runs as (
        select d.status, d.start_time, d.end_time, d.return_message
          from cron.job_run_details d join cron.job j on j.jobid = d.jobid
         where j.jobname = 'bingd-proactive-tick'
      )
      select jsonb_build_object(
        'last_status',     (select status from runs order by start_time desc limit 1),
        'last_started_at', (select max(start_time) from runs),
        'last_success_at', (select max(end_time) from runs where status = 'succeeded'),
        'last_failure_at', (select max(end_time) from runs where status = 'failed'),
        'last_failure',    (select left(return_message, 300) from runs where status = 'failed'
                             order by start_time desc limit 1))
    $q$ into v_runs;
    if v_runs ->> 'last_status' = 'failed' then
      v_problems := v_problems || 'last_tick_failed'::text;
    end if;
  end if;

  select coalesce(jsonb_object_agg(type || ':' || state, n), '{}') into v_counts
    from (select type, state, count(*) n from proactive_candidates group by type, state) s;

  -- Selected and never claimed: the drain is not taking proactive work.
  select count(*) into v_stuck
    from proactive_candidates where state = 'selected' and selected_at < now() - interval '15 minutes';
  if v_stuck > 0 then
    v_problems := v_problems || 'selected_not_sent'::text;
  end if;

  return jsonb_build_object(
    'healthy',     cardinality(v_problems) = 0,
    'problems',    to_jsonb(v_problems),
    'push_enabled', _proactive_push_enabled(),
    'generation_enabled', _proactive_generation_enabled(),
    'resurface_enabled', _proactive_resurface_enabled(),
    'season_enabled', _proactive_season_enabled(),
    'job',         v_job,
    'tick',        v_runs,
    'candidates',  v_counts,
    'selected_not_sent', v_stuck,
    'sent_24h',    (select count(*) from proactive_candidates where sent_at > now() - interval '24 hours'),
    'opens_24h',   (select count(*) from notification_opens o
                     join proactive_candidates c on c.id = o.candidate_id
                    where o.opened_at > now() - interval '24 hours' and o.channel = 'push')
  );
end;
$$;

comment on function proactive_status() is
  'Proactive delivery at a glance: the push, generation, resurfacing and season (20261031000100) switches, the job, the tick''s last run / last success / last failure from cron.job_run_details (last_tick_failed is a problem), candidate counts by type and state, anything selected but not claimed for 15 minutes (a stalled drain), jobs handed to push-sender and push opens in 24 hours. service_role only.';


drop function if exists _proactive_candidates_pilot_scope();
drop function if exists _proactive_pilot_allows(uuid);
drop function if exists _proactive_pilot_recipients();
drop function if exists _proactive_friend_qualifies(uuid, uuid, timestamptz);
drop function if exists _proactive_friend_min_affinity();
drop function if exists _proactive_social_enabled();
drop function if exists _proactive_theatrical_enabled();

delete from app_config
 where key in ('proactive.social_enabled', 'proactive.theatrical_enabled',
               'proactive.friend_min_affinity', 'proactive.pilot_recipients');

commit;
