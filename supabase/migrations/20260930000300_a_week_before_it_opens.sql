-- ===========================================================================
-- Release awareness, part 3: the founder's review of the shadow policy
--
-- 20260930000100 and 20260930000200 have run on staging, so they are history and are
-- not edited. This is the correction, and it changes policy only: the release state,
-- the TMDB refresh and the shadow architecture are untouched, and real sending stays
-- impossible (nothing here writes notifications or push_outbox either).
--
-- WHAT CHANGED, AND WHY
--
-- 1. A FILM IS ANNOUNCED BEFORE IT OPENS, NOT ON THE DAY. The awareness event for a
--    watchlisted film now fires about a week ahead (release.movie_lead_days, 7), so a
--    reader can make a plan. There is exactly ONE awareness event per film release and
--    no day-of notification at all. A film first seen inside the week fires at once with
--    fewer days of notice; one first seen on or after its release day never fires
--    (evaluation `skipped_late`) rather than becoming the day-of push this replaces.
--
-- 2. A SEASON STILL LANDS ON RELEASE MORNING, and the day-before alternative is
--    measured beside it rather than argued about: every season row records `plan_at`
--    (what the chosen policy does) and `alt_plan_at` (what the alternative would have
--    done). A season is watchable the moment it is out, so the notification is the
--    event itself; a day-early notice would be a reminder about a reminder. T-7 is
--    deliberately NOT copied from films.
--
-- 3. THE CAP NO LONGER SUPPRESSES ANYTHING. Explicit interest is not spam, and a
--    release a reader asked for should not be discarded because another one arrived
--    first. The shadow now records BOTH: the uncapped eligible result (`outcome`), and
--    what the former 2-per-7-days and 36-hour rules WOULD have suppressed
--    (`cap_would_suppress`, `cap_reason`). Evidence first, then a decision.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. Configuration
-- ---------------------------------------------------------------------------

insert into app_config (key, value) values
  -- How far ahead a film's awareness fires. Seven days: far enough to make a plan,
  -- close enough that the date is unlikely to move again.
  ('release.movie_lead_days', '7'::jsonb),
  -- The season policy in force, and the one measured beside it.
  ('release.season_timing', '"release_morning"'::jsonb),
  ('release.season_timing_alternative', '"day_before"'::jsonb)
on conflict (key) do nothing;

comment on function _release_setting(text, jsonb) is
  'One release.* app_config value, or the default when the row is absent. Since 20260930000300 this also carries movie_lead_days and the season timing pair. The former cap keys (push_cap_per_week, push_min_gap_hours) are now MEASURED, not applied: see _release_arbitrate. Internal.';


-- ---------------------------------------------------------------------------
-- 1. The events learn when their awareness is due
-- ---------------------------------------------------------------------------

alter table release_events add column if not exists awareness_on date;

comment on column release_events.awareness_on is
  'The date this event''s awareness is due: the release date minus release.movie_lead_days for a film, the release date itself for a season premiere. Null while there is no date to count back from.';

-- `skipped_late` joins the evaluation vocabulary: a film first seen on or after its
-- release day, where the pre-release week has already gone. It is not `skipped_stale`,
-- which means "released long before we ever saw it"; the two have different fixes.
alter table release_events drop constraint if exists release_events_evaluation_check;
alter table release_events drop constraint if exists release_events_evaluation;

alter table release_events add constraint release_events_evaluation_check
  check (evaluation in ('none', 'pending', 'done', 'skipped_stale', 'skipped_late'));

-- A released event has always been decided one way or another. A scheduled one may now
-- also carry `pending` or `done`, which is the whole point of a pre-release awareness.
alter table release_events add constraint release_events_evaluation
  check (state <> 'released' or evaluation <> 'none');

update release_events
   set awareness_on = case
         when event_kind = 'theatrical_release' and scheduled_date is not null
           then scheduled_date - (_release_setting('release.movie_lead_days', '7'::jsonb) #>> '{}')::integer
         when event_kind = 'season_premiere' then released_on
       end
 where awareness_on is null;


-- ---------------------------------------------------------------------------
-- 2. The state machine, rebuilt from 20260930000100 with the awareness rules
--
-- The old ten-argument form is dropped rather than left beside this one: two bodies for
-- one name is how a rebuild ships an older body by accident.
-- ---------------------------------------------------------------------------

drop function if exists _release_event_apply(uuid, uuid, text, text, integer, date, boolean, boolean, timestamptz, integer);

create or replace function _release_event_apply(
  p_media_item_id uuid,
  p_subject_id    uuid,
  p_kind          text,
  p_region        text,
  p_season_number integer,
  p_date          date,
  p_withdrawn     boolean,
  p_fresh         boolean,
  p_now           timestamptz,
  p_stale_days    integer,
  p_lead_days     integer
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  e        release_events%rowtype;
  v_today  date := (p_now at time zone 'UTC')::date;
  v_state  text;
  v_change text;
  v_eval   text;
  v_aware  date;
  v_exists boolean;
begin
  select * into e from release_events
   where media_item_id = p_media_item_id and event_kind = p_kind and region = p_region
   for update;
  v_exists := found;

  v_state := case
    when coalesce(p_withdrawn, false) then 'withdrawn'
    when p_date is null then 'announced'
    when _release_reached(p_date, p_now) and p_fresh then 'released'
    else 'scheduled'
  end;

  -- When this event's awareness is due. A film counts back from its date; a season's
  -- awareness is the release itself.
  v_aware := case
    when p_date is null then null
    when p_kind = 'theatrical_release' then p_date - p_lead_days
    else p_date
  end;

  -- What the evaluation should become, given it has never been armed. An event that has
  -- already been armed or decided is never re-armed: one awareness per release.
  v_eval := case
    when p_kind = 'season_premiere' then
      case when v_state <> 'released' then 'none'
           when p_date >= v_today - p_stale_days then 'pending'
           else 'skipped_stale' end
    -- A film, before it opens: the week is open and the read is fresh.
    when v_state = 'scheduled' and p_fresh and v_today >= v_aware and v_today < p_date then 'pending'
    -- A film we met on or after its opening day. The pre-release window is gone, and a
    -- day-of push is the thing this policy exists to not send.
    when v_state = 'released' then 'skipped_late'
    else 'none'
  end;

  if not v_exists then
    insert into release_events (
      media_item_id, subject_id, event_kind, region, season_number, state,
      scheduled_date, date_first_seen_at, released_on, released_observed_at,
      evaluation, awareness_on, first_observed_at, last_observed_at
    ) values (
      p_media_item_id, p_subject_id, p_kind, p_region, p_season_number, v_state,
      p_date, case when p_date is not null then p_now end,
      case when v_state = 'released' then p_date end,
      case when v_state = 'released' then p_now end,
      v_eval, v_aware, p_now, p_now
    )
    returning * into e;

    v_change := case
      when v_state = 'released' and v_eval = 'pending' then 'released'
      when v_state = 'released' and v_eval = 'skipped_stale' then 'released_stale'
      when v_state = 'released' then 'released_late'
      when v_eval = 'pending' then 'awareness_due'
      else 'created'
    end;

    insert into release_event_log (release_event_id, observed_at, change, from_state, to_state, old_date, new_date)
    values (e.id, p_now, v_change, null, v_state, null, p_date);
    return v_change;
  end if;

  -- Terminal. A date that moves after a release was recorded is worth knowing and
  -- changes nothing else.
  if e.state = 'released' then
    if p_date is distinct from e.scheduled_date then
      v_change := case when p_date is null then 'cleared_after_release' else 'moved_after_release' end;
      update release_events
         set scheduled_date     = p_date,
             previous_date      = e.scheduled_date,
             date_changes       = e.date_changes + 1,
             date_first_seen_at = case when p_date is not null then p_now end,
             last_observed_at   = p_now
       where id = e.id;
      insert into release_event_log (release_event_id, observed_at, change, from_state, to_state, old_date, new_date)
      values (e.id, p_now, v_change, 'released', 'released', e.scheduled_date, p_date);
      return v_change;
    end if;
    update release_events set last_observed_at = p_now where id = e.id;
    return 'unchanged';
  end if;

  -- An event only arms once. Anything already pending, done or skipped keeps its
  -- evaluation for ever: a postponed film does not announce itself twice, and a film
  -- that opens after its awareness went out is not announced again on the day.
  if e.evaluation <> 'none' then
    v_eval := e.evaluation;
  end if;

  v_change := case
    when v_state = 'released' and v_eval = 'pending' then 'released'
    when v_state = 'released' and v_eval = 'skipped_stale' then 'released_stale'
    when v_state = 'released' and e.evaluation = 'none' then 'released_late'
    when v_state = 'released' then 'released'
    when v_state = 'withdrawn' and e.state <> 'withdrawn' then 'withdrawn'
    when e.state = 'withdrawn' and v_state <> 'withdrawn' then 'restored'
    when v_eval = 'pending' and e.evaluation = 'none' then 'awareness_due'
    when p_date is distinct from e.scheduled_date then
      case when e.scheduled_date is null then 'date_set'
           when p_date is null then 'date_cleared'
           else 'date_changed' end
    when v_state <> e.state then 'restored'
    else 'unchanged'
  end;

  if v_change = 'unchanged' then
    update release_events
       set last_observed_at = p_now,
           awareness_on     = v_aware
     where id = e.id;
    return v_change;
  end if;

  update release_events
     set state                = v_state,
         scheduled_date       = p_date,
         previous_date        = case when p_date is distinct from e.scheduled_date
                                     then e.scheduled_date else e.previous_date end,
         date_changes         = e.date_changes
                                + case when e.scheduled_date is not null
                                        and p_date is distinct from e.scheduled_date then 1 else 0 end,
         date_first_seen_at   = case when p_date is null then null
                                     when p_date is distinct from e.scheduled_date then p_now
                                     else e.date_first_seen_at end,
         released_on          = case when v_state = 'released' then p_date end,
         released_observed_at = case when v_state = 'released' then p_now
                                     else e.released_observed_at end,
         evaluation           = v_eval,
         awareness_on         = v_aware,
         last_observed_at     = p_now
   where id = e.id;

  insert into release_event_log (release_event_id, observed_at, change, from_state, to_state, old_date, new_date)
  values (e.id, p_now, v_change, e.state, v_state, e.scheduled_date, p_date);
  return v_change;
end;
$$;

comment on function _release_event_apply(uuid, uuid, text, text, integer, date, boolean, boolean, timestamptz, integer, integer) is
  'The release state machine for one event and one observation (20260930000300). A season premiere arms its awareness when it is released; a film arms its awareness p_lead_days before it opens and never on or after the day (skipped_late). An event arms once, ever. released stays terminal. Logs one row per change. Internal.';

-- The log learns the two changes the awareness rules can make.
alter table release_event_log drop constraint if exists release_event_log_change_check;
alter table release_event_log add constraint release_event_log_change_check
  check (change in (
    'created', 'date_set', 'date_changed', 'date_cleared',
    'released', 'released_stale', 'released_late', 'awareness_due',
    'withdrawn', 'restored', 'moved_after_release', 'cleared_after_release'));


-- ---------------------------------------------------------------------------
-- 3. release_observe, rebuilt from 20260930000100: it passes the lead days through
-- ---------------------------------------------------------------------------

create or replace function release_observe(p_obs jsonb, p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id        uuid;
  v_kind      media_kind;
  v_read      timestamptz;
  v_fresh     boolean;
  v_stale     integer;
  v_lead      integer;
  v_status    text;
  v_season    record;
  v_season_id uuid;
  v_us        jsonb;
  v_date      date;
  v_change    text;
  v_changes   jsonb := '{}'::jsonb;
  v_missing   integer := 0;
begin
  v_id := nullif(p_obs ->> 'media_item_id', '')::uuid;
  select kind into v_kind from media_items where id = v_id;
  if v_kind is null then
    return jsonb_build_object('status', 'unknown_item');
  end if;
  if not exists (select 1 from release_subjects where media_item_id = v_id) then
    return jsonb_build_object('status', 'untracked');
  end if;
  if v_kind::text <> coalesce(p_obs ->> 'kind', '') then
    raise exception 'release_observe: % is a %, not a %', v_id, v_kind, p_obs ->> 'kind'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('release-subject:' || v_id::text, 0));

  v_read  := least(coalesce(nullif(p_obs ->> 'read_at', '')::timestamptz, p_now), p_now);
  v_fresh := v_read >= p_now - make_interval(
               hours => (_release_setting('release.freshness_hours', '12'::jsonb) #>> '{}')::integer);
  v_stale := (_release_setting('release.stale_after_days', '7'::jsonb) #>> '{}')::integer;
  v_lead  := (_release_setting('release.movie_lead_days', '7'::jsonb) #>> '{}')::integer;
  v_status := nullif(p_obs ->> 'status', '');

  if v_kind = 'series' then
    for v_season in
      select (x ->> 'season_number')::integer as n,
             nullif(x ->> 'air_date', '')::date as d
        from jsonb_array_elements(coalesce(p_obs -> 'seasons', '[]'::jsonb)) as x
       where (x ->> 'season_number') ~ '^[0-9]+$'
         and (x ->> 'season_number')::integer > 0
    loop
      select id into v_season_id
        from media_items
       where parent_id = v_id and kind = 'season' and season_number = v_season.n;
      if v_season_id is null then
        v_missing := v_missing + 1;
        continue;
      end if;
      v_change := _release_event_apply(
        v_season_id, v_id, 'season_premiere', '', v_season.n, v_season.d,
        v_status = 'Canceled' and not _release_reached(v_season.d, p_now),
        v_fresh, p_now, v_stale, v_lead);
      v_changes := jsonb_set(v_changes, array[v_change],
                             to_jsonb(coalesce((v_changes ->> v_change)::integer, 0) + 1));
    end loop;
  elsif v_kind = 'movie' then
    select x into v_us
      from jsonb_array_elements(coalesce(p_obs -> 'regions', '[]'::jsonb)) as x
     where x ->> 'region' = 'US'
     limit 1;
    v_date := nullif(v_us ->> 'theatrical', '')::date;
    v_change := _release_event_apply(
      v_id, v_id, 'theatrical_release', 'US', null, v_date,
      v_status = 'Canceled' and not _release_reached(v_date, p_now),
      v_fresh, p_now, v_stale, v_lead);
    v_changes := jsonb_build_object(v_change, 1);
  else
    raise exception 'release_observe: % is a season; observe its series', v_id using errcode = '22023';
  end if;

  update release_subjects
     set tmdb_status     = v_status,
         in_production   = (p_obs ->> 'in_production')::boolean,
         facts           = p_obs - 'media_item_id',
         last_read_at    = greatest(coalesce(last_read_at, v_read), v_read),
         last_attempt_at = p_now,
         failures        = 0,
         last_error      = null
   where media_item_id = v_id;

  update release_subjects
     set next_check_at = _release_next_check(v_id, p_now)
   where media_item_id = v_id;

  return jsonb_build_object('status', 'observed', 'fresh', v_fresh, 'changes', v_changes,
                            'missing_seasons', v_missing);
end;
$$;


-- ---------------------------------------------------------------------------
-- 4. The cadence, rebuilt: a film's awareness date is a date worth being early for
-- ---------------------------------------------------------------------------

create or replace function _release_next_check(p_subject uuid, p_now timestamptz)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_kind   text;
  v_status text;
  v_today  date := (p_now at time zone 'UTC')::date;
  v_next   date;
begin
  select subject_kind, tmdb_status into v_kind, v_status
    from release_subjects where media_item_id = p_subject;

  -- Six-hourly around a date that matters: a release, and now also the day a film's
  -- awareness is due, so T-7 is observed within hours of the morning it arrives.
  if exists (
    select 1 from release_events
     where subject_id = p_subject
       and state = 'scheduled'
       and (scheduled_date <= v_today + 1
            or (event_kind = 'theatrical_release' and evaluation = 'none'
                and awareness_on is not null and awareness_on <= v_today + 1))
  ) then
    return p_now + interval '6 hours';
  end if;

  select min(scheduled_date) into v_next
    from release_events
   where subject_id = p_subject and state = 'scheduled';

  if v_kind = 'series' then
    if v_next is null then
      return p_now + case when v_status in ('Ended', 'Canceled') then interval '30 days'
                          else interval '3 days' end;
    end if;
    return p_now + case when v_next - v_today <= 30 then interval '1 day' else interval '7 days' end;
  end if;

  return p_now + case when v_next is not null and v_next - v_today <= 60
                      then interval '1 day' else interval '7 days' end;
end;
$$;


-- ---------------------------------------------------------------------------
-- 5. The ledger learns timing and the counterfactual cap
-- ---------------------------------------------------------------------------

alter table release_shadow_ledger
  add column if not exists timing            text,
  add column if not exists plan_at           timestamptz,
  add column if not exists alt_timing        text,
  add column if not exists alt_plan_at       timestamptz,
  add column if not exists days_to_release   integer,
  add column if not exists cap_would_suppress boolean,
  add column if not exists cap_reason        text;

comment on column release_shadow_ledger.timing is
  'The policy that placed this one: theatrical_t7 (a film, about a week before it opens) or season_release_morning.';
comment on column release_shadow_ledger.plan_at is
  'When the chosen policy would push, in real time: the first send-window instant on or after the awareness became due, in this account''s zone.';
comment on column release_shadow_ledger.alt_plan_at is
  'When the alternative timing would have pushed, for comparison only: season_day_before for a premiere, theatrical_day_of for a film. Nothing acts on it.';
comment on column release_shadow_ledger.days_to_release is
  'Release date minus the day the awareness fired: 7 at a film''s T-7, 0 on a season''s release morning.';
comment on column release_shadow_ledger.cap_would_suppress is
  'THE COUNTERFACTUAL, not a decision. Whether the former 2-per-7-days and 36-hour rules would have discarded this push. The push itself is no longer capped: explicit interest is not spam.';

-- The film awareness fires BEFORE the release, so this is negative for every film row.
alter table release_shadow_ledger drop constraint if exists release_shadow_ledger_freshness_days_check;
alter table release_shadow_ledger add constraint release_shadow_ledger_freshness_days_check
  check (freshness_days between -3650 and 3650);


-- ---------------------------------------------------------------------------
-- 6. When a send window opens
-- ---------------------------------------------------------------------------

create or replace function _release_window_at(
  p_local_date date,
  p_tz         text,
  p_from       timestamptz,
  p_start      integer,
  p_end        integer
)
returns timestamptz
language plpgsql
immutable
as $$
declare
  v_open  timestamptz := (p_local_date + make_interval(hours => p_start)) at time zone p_tz;
  v_close timestamptz := (p_local_date + make_interval(hours => p_end))   at time zone p_tz;
begin
  if p_from is null or p_from <= v_open then return v_open; end if;
  if p_from < v_close then return p_from; end if;
  -- Past the window on that day: the next morning it opens.
  return ((p_local_date + 1) + make_interval(hours => p_start)) at time zone p_tz;
end;
$$;

comment on function _release_window_at(date, text, timestamptz, integer, integer) is
  'The first instant inside the 10:00-20:00 local send window, on p_local_date or the next day, at or after p_from. p_from null asks for the window''s own opening. Internal.';


-- ---------------------------------------------------------------------------
-- 7. Fan-out, rebuilt from 20260930000200
--
-- Two changes and no others: every row now carries when it would be pushed under the
-- chosen timing and under the alternative, and a film's awareness is its T-7 rather
-- than its release.
-- ---------------------------------------------------------------------------

create or replace function _release_fanout_event(p_event uuid, p_now timestamptz)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  e          release_events%rowtype;
  v_today    date;
  v_ref      date;      -- the date this awareness is about (release date)
  v_due      date;      -- the local date the awareness is due on
  v_alt      date;      -- the alternative timing's date
  v_alt_name text;
  v_timing   text;
  v_fresh    integer;
  v_days     integer;
  v_expiry   interval;
  v_push     boolean;
  v_start    integer := (_release_setting('release.window_start_hour', '10'::jsonb) #>> '{}')::integer;
  v_end      integer := (_release_setting('release.window_end_hour', '20'::jsonb) #>> '{}')::integer;
  v_from     timestamptz;
  v_inserted integer;
begin
  select * into e from release_events where id = p_event;
  v_today  := (p_now at time zone 'UTC')::date;
  v_ref    := coalesce(e.released_on, e.scheduled_date);
  v_due    := greatest(coalesce(e.awareness_on, v_today), v_today);
  v_fresh  := v_today - coalesce(e.released_on, v_today);
  v_days   := v_ref - v_today;
  v_expiry := make_interval(hours => (_release_setting('release.push_expiry_hours', '48'::jsonb) #>> '{}')::integer);
  v_push   := _release_setting('release.push_enabled', 'false'::jsonb) = 'true'::jsonb;

  if e.event_kind = 'season_premiere' then
    v_timing   := 'season_release_morning';
    v_alt_name := 'season_day_before';
    v_alt      := v_ref - 1;
    -- A season's date is the origin network's. 10:00 local in a zone far enough east
    -- would otherwise announce a US premiere the evening before it airs, so nothing goes
    -- out before that date has begun in Los Angeles.
    v_from     := greatest(p_now, v_ref::timestamp at time zone 'America/Los_Angeles');
  else
    v_timing   := 'theatrical_t7';
    v_alt_name := 'theatrical_day_of';
    v_alt      := v_ref;
    -- A film's awareness is about a date a week away; there is nothing to be early for.
    v_from     := p_now;
  end if;

  if e.event_kind = 'season_premiere' then
    with seasons as (
      select id, season_number
        from media_items
       where parent_id = e.subject_id and kind = 'season' and season_number > 0
    ),
    prior as (
      select max(season_number) as n from seasons where season_number < e.season_number
    ),
    signal as (
      select r.user_id, s.season_number
        from rankings r join seasons s on s.id = r.media_item_id
      union
      select um.user_id, s.season_number
        from user_media um join seasons s on s.id = um.media_item_id
       where um.bucket is not null or um.watched_on is not null or um.progress = 'completed'
    ),
    touched as (
      select um.user_id, s.season_number
        from user_media um join seasons s on s.id = um.media_item_id
      union
      select user_id, season_number from signal
    ),
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
             ac.timezone                                                                                     as tz,
             exists (select 1 from device_tokens d where d.user_id = i.user_id and d.revoked_at is null)      as has_device,
             _notifies(i.user_id, 'new_seasons')                                                             as pref
        from interested i
        join profiles p on p.id = i.user_id and p.status = 'active'
        left join account_context ac on ac.user_id = i.user_id
    ),
    decided as (
      select c.*,
             case when c.caught_up then 'caught_up' when c.any_prior then 'behind' else 'no_history' end as tier,
             case
               when c.already       then 'skipped'
               when not c.any_prior then 'skipped'
               when not c.pref      then 'skipped'
               when not c.caught_up then 'inbox_only'
               when c.tz is null    then 'inbox_only'
               else 'pending'
             end as outcome,
             case
               when c.already       then 'already_watched'
               when not c.any_prior then 'no_history'
               when not c.pref      then 'preference_off'
               when not c.caught_up then 'behind_tier'
               when c.tz is null    then 'no_timezone'
               else 'pending'
             end as reason
        from cand c
    )
    insert into release_shadow_ledger (
      release_event_id, user_id, event_kind, tier, freshness_days, timezone_known,
      region_status, has_device, preference_on, outcome, reason, expires_at,
      created_at, decided_at, real_send_enabled,
      timing, plan_at, alt_timing, alt_plan_at, days_to_release
    )
    select e.id, d.user_id, e.event_kind, d.tier, v_fresh, d.tz is not null,
           'not_applicable', d.has_device, d.pref, d.outcome, d.reason,
           case when d.outcome = 'pending' then p_now + v_expiry end,
           p_now, case when d.outcome = 'pending' then null else p_now end, v_push,
           v_timing,
           case when d.tz is not null then _release_window_at(v_due, d.tz, v_from, v_start, v_end) end,
           v_alt_name,
           case when d.tz is not null then _release_window_at(v_alt, d.tz, null, v_start, v_end) end,
           v_days
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
             ac.timezone                                                                          as tz,
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
               when c.already                    then 'skipped'
               when c.region_status = 'mismatch' then 'skipped'
               when not c.pref                   then 'skipped'
               when c.region_status = 'unknown'  then 'inbox_only'
               when c.tz is null                 then 'inbox_only'
               else 'pending'
             end as outcome,
             case
               when c.already                    then 'already_watched'
               when c.region_status = 'mismatch' then 'region_mismatch'
               when not c.pref                   then 'preference_off'
               when c.region_status = 'unknown'  then 'region_unknown'
               when c.tz is null                 then 'no_timezone'
               else 'pending'
             end as reason
        from cand c
    )
    insert into release_shadow_ledger (
      release_event_id, user_id, event_kind, tier, freshness_days, timezone_known,
      region_status, has_device, preference_on, outcome, reason, expires_at,
      created_at, decided_at, real_send_enabled,
      timing, plan_at, alt_timing, alt_plan_at, days_to_release
    )
    select e.id, d.user_id, e.event_kind, 'watchlist', v_fresh, d.tz is not null,
           d.region_status, d.has_device, d.pref, d.outcome, d.reason,
           case when d.outcome = 'pending' then p_now + v_expiry end,
           p_now, case when d.outcome = 'pending' then null else p_now end, v_push,
           v_timing,
           case when d.tz is not null then _release_window_at(v_due, d.tz, v_from, v_start, v_end) end,
           v_alt_name,
           case when d.tz is not null then _release_window_at(v_alt, d.tz, null, v_start, v_end) end,
           v_days
      from decided d
    on conflict (user_id, release_event_id) do nothing;
  end if;

  get diagnostics v_inserted = row_count;

  update release_events set evaluation = 'done', evaluated_at = p_now where id = p_event;
  return v_inserted;
end;
$$;

comment on function _release_fanout_event(uuid, timestamptz) is
  'SHADOW. Turns one due awareness into release_shadow_ledger rows, one per interested active account: tier, timezone, region, device and preference recorded, and both the chosen timing (plan_at) and the alternative (alt_plan_at). Rebuilt 20260930000300 for a film''s T-7. Writes no notification. Internal.';


-- ---------------------------------------------------------------------------
-- 8. Arbitration, rebuilt: nothing is suppressed, the old cap is only measured
--
-- Every eligible row is marked `would_push` at the first moment its window allows. The
-- former rules are then replayed over that same stream, in priority order, and each row
-- records whether they WOULD have discarded it. The counterfactual reads only rows the
-- counterfactual itself let through, so it is a faithful replay rather than a count of
-- everything.
-- ---------------------------------------------------------------------------

create or replace function _release_arbitrate(p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cap     integer  := (_release_setting('release.push_cap_per_week', '2'::jsonb) #>> '{}')::integer;
  v_gap     interval := make_interval(hours => (_release_setting('release.push_min_gap_hours', '36'::jsonb) #>> '{}')::integer);
  v_push    boolean  := _release_setting('release.push_enabled', 'false'::jsonb) = 'true'::jsonb;
  v_start   integer  := (_release_setting('release.window_start_hour', '10'::jsonb) #>> '{}')::integer;
  v_end     integer  := (_release_setting('release.window_end_hour', '20'::jsonb) #>> '{}')::integer;
  v_row     record;
  v_count   integer;
  v_last    timestamptz;
  v_sent    boolean;
  v_reason  text;
  v_expired integer;
  v_pushed  integer := 0;
  v_capped  integer := 0;
begin
  update release_shadow_ledger
     set outcome    = 'inbox_only',
         reason     = coalesce(last_block_reason, 'expired'),
         decided_at = p_now
   where outcome = 'pending' and expires_at <= p_now;
  get diagnostics v_expired = row_count;

  -- Due now, in the order the former rules would have ranked them, so the replay below
  -- suppresses the same ones it would have suppressed then.
  --
  -- The timezone and the window are re-read here rather than trusted from `plan_at`. An
  -- account that has lost its zone since the plan was made must not be pushed on a plan
  -- computed from a zone it no longer reports, and one that has moved must not be woken
  -- at the old zone's hour.
  for v_row in
    select l.id, l.user_id, l.tier
      from release_shadow_ledger l
      join account_context ac on ac.user_id = l.user_id
     where l.outcome = 'pending'
       and l.plan_at is not null
       and l.plan_at <= p_now
       and ac.timezone is not null
       and (p_now at time zone ac.timezone)::time >= make_time(v_start, 0, 0)
       and (p_now at time zone ac.timezone)::time <  make_time(v_end, 0, 0)
     order by l.user_id,
              case l.tier when 'caught_up' then 0 when 'watchlist' then 1 else 2 end,
              l.plan_at,
              l.id
  loop
    -- The counterfactual state, read from the rows the counterfactual itself passed.
    select count(*), max(would_push_at) into v_count, v_last
      from release_shadow_ledger
     where user_id = v_row.user_id
       and outcome = 'would_push'
       and cap_would_suppress is false
       and would_push_at > p_now - interval '7 days';

    if v_count >= v_cap then
      v_sent := false; v_reason := 'global_cap';
    elsif v_last is not null and v_last >= p_now then
      v_sent := false; v_reason := 'lost_to_priority';
    elsif v_last is not null and v_last > p_now - v_gap then
      v_sent := false; v_reason := 'cap_spacing';
    else
      v_sent := true; v_reason := null;
    end if;

    update release_shadow_ledger
       set outcome            = 'would_push',
           reason             = 'would_send',
           would_push_at      = p_now,
           decided_at         = p_now,
           last_block_reason  = null,
           real_send_enabled  = v_push,
           cap_would_suppress = not v_sent,
           cap_reason         = v_reason
     where id = v_row.id;

    v_pushed := v_pushed + 1;
    if not v_sent then v_capped := v_capped + 1; end if;
  end loop;

  -- Whatever is still pending is simply waiting for its window, which is not a
  -- suppression and is recorded as such. An account with no zone at all is the one case
  -- that is waiting for something else.
  update release_shadow_ledger l
     set last_block_reason = case
           when l.plan_at is null then 'no_timezone'
           when not exists (select 1 from account_context ac
                             where ac.user_id = l.user_id and ac.timezone is not null) then 'no_timezone'
           else 'quiet_window' end
   where l.outcome = 'pending';

  return jsonb_build_object('expired', v_expired, 'would_push', v_pushed,
                            'cap_would_have_suppressed', v_capped);
end;
$$;

comment on function _release_arbitrate(timestamptz) is
  'SHADOW, rebuilt 20260930000300. Marks EVERY eligible release would_push once its local send window allows: explicit interest is no longer capped. The former 2-per-7-days and 36-hour rules are replayed over the same stream and recorded per row in cap_would_suppress / cap_reason, as evidence for whether a cap is needed at all. Sends nothing. Internal.';


-- ---------------------------------------------------------------------------
-- 9. Status and summaries, rebuilt for the new vocabulary
-- ---------------------------------------------------------------------------

-- Dropped and recreated rather than replaced: a view's column list cannot be changed in
-- place, and this one gains the timing and counterfactual columns.
drop view if exists release_shadow_summary;
create view release_shadow_summary with (security_invoker = true) as
select l.event_kind,
       l.timing,
       l.tier,
       l.outcome,
       l.reason,
       count(*)                                                   as decisions,
       count(distinct l.user_id)                                  as accounts,
       count(distinct l.release_event_id)                         as events,
       count(*) filter (where l.timezone_known)                   as timezone_known,
       count(*) filter (where not l.timezone_known)               as timezone_missing,
       count(*) filter (where l.region_status = 'unknown')        as region_unknown,
       count(*) filter (where l.has_device)                       as with_device,
       count(*) filter (where l.cap_would_suppress)               as cap_would_suppress,
       count(*) filter (where l.cap_reason = 'global_cap')        as cap_global,
       count(*) filter (where l.cap_reason = 'cap_spacing')       as cap_spacing,
       count(*) filter (where l.cap_reason = 'lost_to_priority')  as cap_priority,
       min(l.days_to_release)                                     as days_to_release_min,
       max(l.days_to_release)                                     as days_to_release_max,
       count(*) filter (where l.real_send_enabled)                as real_send_enabled,
       min(l.created_at)                                          as first_at,
       max(l.created_at)                                          as last_at
  from release_shadow_ledger l
 group by l.event_kind, l.timing, l.tier, l.outcome, l.reason;

comment on view release_shadow_summary is
  'SHADOW. Decisions per (event kind, timing, tier, outcome, reason), with the uncapped result and what the former cap WOULD have suppressed counted beside each other. service_role only.';

/**
 * The timing comparison the founder asked for: what the chosen policy does against what
 * the alternative would have done, per event kind, in hours.
 */
drop view if exists release_timing_comparison;
create view release_timing_comparison with (security_invoker = true) as
select l.event_kind,
       l.timing,
       l.alt_timing,
       count(*)                                                                   as rows_compared,
       round(avg(extract(epoch from (l.plan_at - l.alt_plan_at)) / 3600.0)::numeric, 1) as avg_hours_later_than_alt,
       min(l.plan_at)                                                             as first_plan_at,
       max(l.plan_at)                                                             as last_plan_at
  from release_shadow_ledger l
 where l.plan_at is not null and l.alt_plan_at is not null
 group by l.event_kind, l.timing, l.alt_timing;

comment on view release_timing_comparison is
  'SHADOW. The chosen timing against the measured alternative (season_day_before, theatrical_day_of): how much later the policy in force would reach somebody. Evidence, not a decision. service_role only.';

drop view if exists release_event_summary;
create view release_event_summary with (security_invoker = true) as
select e.event_kind,
       e.state,
       e.evaluation,
       count(*)                                                    as events,
       count(*) filter (where e.date_changes > 0)                  as with_date_changes,
       sum(e.date_changes)                                         as date_changes,
       min(e.awareness_on) filter (where e.evaluation = 'none')    as next_awareness_on,
       min(e.scheduled_date) filter (where e.state = 'scheduled')  as next_date,
       max(e.released_on)                                          as latest_release
  from release_events e
 group by e.event_kind, e.state, e.evaluation;

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
           'total',        count(*),
           'series',       count(*) filter (where subject_kind = 'series'),
           'movies',       count(*) filter (where subject_kind = 'movie'),
           'due',          count(*) filter (where next_check_at <= now()),
           'overdue_6h',   count(*) filter (where next_check_at <= now() - interval '6 hours'),
           'never_read',   count(*) filter (where last_read_at is null),
           'failing',      count(*) filter (where failures >= 3),
           'last_read_at', max(last_read_at))
    into v_subjects
    from release_subjects;

  if (v_subjects ->> 'overdue_6h')::integer > 0 then
    v_problems := v_problems || 'refresh_stalled'::text;
  end if;
  if (v_subjects ->> 'failing')::integer > 0 then
    v_problems := v_problems || 'subjects_failing'::text;
  end if;

  select jsonb_build_object(
           'by_state',      coalesce((select jsonb_object_agg(state, n) from (select state, count(*) n from release_events group by state) s), '{}'),
           'by_evaluation', coalesce((select jsonb_object_agg(evaluation, n) from (select evaluation, count(*) n from release_events group by evaluation) s), '{}'),
           'pending_evaluation', count(*) filter (where evaluation = 'pending'),
           'awareness_armed_upcoming', count(*) filter (where evaluation = 'pending' and state = 'scheduled'),
           'next_awareness_on', min(awareness_on) filter (where evaluation = 'none' and state = 'scheduled'),
           'oldest_pending', min(coalesce(released_observed_at, last_observed_at)) filter (where evaluation = 'pending'))
    into v_events
    from release_events;

  if (v_events ->> 'oldest_pending')::timestamptz < now() - interval '1 hour' then
    v_problems := v_problems || 'evaluation_backlog'::text;
  end if;

  select jsonb_build_object(
           'by_outcome', coalesce((select jsonb_object_agg(outcome, n) from (select outcome, count(*) n from release_shadow_ledger group by outcome) s), '{}'),
           'would_push', count(*) filter (where outcome = 'would_push'),
           'cap_would_have_suppressed', count(*) filter (where cap_would_suppress),
           'timezone_missing', count(*) filter (where not timezone_known),
           'region_unknown', count(*) filter (where region_status = 'unknown'))
    into v_ledger
    from release_shadow_ledger;

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
                               'real_send_enabled', v_push,
                               'movie_lead_days', (_release_setting('release.movie_lead_days', '7'::jsonb) #>> '{}')::integer,
                               'season_timing', _release_setting('release.season_timing', '"release_morning"'::jsonb) #>> '{}',
                               'cap_applied', false),
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
  'One call that says whether release awareness is healthy: jobs, transport, subjects read on time, evaluation keeping up, the ledger''s uncapped outcomes and what the former cap would have suppressed, and - for the kill switch - how many release notifications and outbox rows exist (must be zero). service_role only.';


-- ---------------------------------------------------------------------------
-- 10. Grants for the new and rebuilt objects
-- ---------------------------------------------------------------------------

revoke all on release_timing_comparison from anon, authenticated;
revoke execute on function _release_window_at(date, text, timestamptz, integer, integer) from public, anon, authenticated;
revoke execute on function _release_event_apply(uuid, uuid, text, text, integer, date, boolean, boolean, timestamptz, integer, integer)
  from public, anon, authenticated;
revoke execute on function release_observe(jsonb, timestamptz) from public, anon, authenticated;
revoke execute on function _release_next_check(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function _release_fanout_event(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function _release_arbitrate(timestamptz) from public, anon, authenticated;
revoke execute on function release_status() from public, anon, authenticated;

grant execute on function release_observe(jsonb, timestamptz) to service_role;
grant execute on function release_status() to service_role;
