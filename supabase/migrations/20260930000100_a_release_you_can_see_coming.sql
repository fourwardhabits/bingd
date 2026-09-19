-- ===========================================================================
-- Release awareness, part 1: knowing when something comes out
--
-- Specification: docs/product/release-awareness.md (§C, §D). Founder decisions
-- 2026-09-19. This file notifies nobody. It keeps a durable, correctable record of
-- when a watched-for season premieres and when a watchlisted film opens in US
-- theaters, refreshed on a database schedule, and it is the input to the shadow
-- evaluation in 20260930000200.
--
-- WHY NOT media_items.release_date
--
-- Every catalogue write is `release_date = coalesce(excluded, old)` (20260815000000,
-- 20260820000400), which is right for a cache and wrong for a release: a date TMDB
-- takes back to TBD can never be cleared, and a date that moves leaves no trace of
-- having moved. A notification built on it would say "out today" on a day that was
-- abandoned weeks ago. So release state lives here, where a date can be null again
-- and every change is logged, and media_items is left exactly as it is (the series
-- watchlist rule, 20260906000100, reads it and is not this file's to change).
--
-- WHY THE DATABASE SCHEDULES IT
--
-- GitHub Actions runs this repository's schedules hours late (measured 4.5-5.5h on
-- trending-refresh). A release is a date, and a refresh that arrives after it is the
-- failure this whole design exists to prevent. pg_cron posts the due ids to
-- tmdb-adapter through pg_net, the pattern _import_enrich_nudge (20260917001400)
-- already runs in production; the adapter fetches and normalizes, and every state
-- transition happens in SQL, here, against an explicit clock.
--
-- The schedule itself is installed by schedule_release_awareness() in the next file,
-- by an operator, AFTER tmdb-adapter is deployed with its `release-refresh` action.
-- Applying this migration schedules nothing and fetches nothing.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. Configuration. Operator-side: no key starts with `public.`, so the
-- app_config_read policy hides every one of them from clients.
-- ---------------------------------------------------------------------------

insert into app_config (key, value) values
  -- The scheduled refresh. On unless this row is the JSON boolean false.
  ('release.refresh_enabled', 'true'::jsonb),
  -- A release transition needs a TMDB read at most this old (founder: 12 hours).
  ('release.freshness_hours', '12'::jsonb),
  -- A release first observed more than this many days after its date is recorded and
  -- never evaluated (founder: 7 days).
  ('release.stale_after_days', '7'::jsonb),
  -- Subjects posted to the adapter per tick.
  ('release.refresh_batch', '40'::jsonb)
on conflict (key) do nothing;

create or replace function _release_setting(p_key text, p_default jsonb)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value from app_config where key = p_key), p_default);
$$;

comment on function _release_setting(text, jsonb) is
  'One release.* app_config value, or the default when the row is absent. Internal.';


-- ---------------------------------------------------------------------------
-- 1. What is polled: one row per movie or series somebody has a reason to hear about
-- ---------------------------------------------------------------------------

create table release_subjects (
  media_item_id   uuid primary key references media_items(id) on delete cascade,
  subject_kind    text not null check (subject_kind in ('movie', 'series')),
  -- TMDB's own words, kept as text: 'Returning Series', 'Ended', 'Canceled', 'Released',
  -- 'Post Production' and so on. Read by the cadence, never shown.
  tmdb_status     text,
  in_production   boolean,
  -- The last normalized observation, whole. The US release events a film detail carries
  -- (theatrical, limited, digital, premiere) and a series' season dates, which the
  -- catalogue write path used to discard.
  facts           jsonb,
  next_check_at   timestamptz not null,
  last_attempt_at timestamptz,
  -- When TMDB last answered for this subject. The freshness a transition is judged by.
  last_read_at    timestamptz,
  failures        integer not null default 0 check (failures >= 0),
  last_error      text,
  created_at      timestamptz not null default now()
);

create index release_subjects_due on release_subjects (next_check_at);

comment on table release_subjects is
  'Movies and series the release refresh polls, reconciled from explicit interest (watch signals on a season, a watchlist entry). Written by _release_reconcile and release_observe only. service_role only.';


-- ---------------------------------------------------------------------------
-- 2. The events, and their state machine
-- ---------------------------------------------------------------------------

create table release_events (
  id                   uuid primary key default gen_random_uuid(),
  -- The season for a premiere, the film for a theatrical release.
  media_item_id        uuid not null references media_items(id) on delete cascade,
  -- The polled subject: the series for a premiere, the film itself for a release.
  subject_id           uuid not null references media_items(id) on delete cascade,
  event_kind           text not null check (event_kind in ('season_premiere', 'theatrical_release')),
  -- '' for a premiere (TMDB season dates carry no region); ISO 3166 for a film. v1 keeps US.
  region               text not null default '',
  season_number        integer,
  state                text not null check (state in ('announced', 'scheduled', 'released', 'withdrawn')),
  -- The date as last observed. Unlike media_items, it CAN be null again (TBD).
  scheduled_date       date,
  -- When the current scheduled_date was first seen: how long a date has held.
  date_first_seen_at   timestamptz,
  previous_date        date,
  -- A move or a clearing of a date that existed. Setting a first date is not a change.
  date_changes         integer not null default 0 check (date_changes >= 0),
  released_on          date,
  released_observed_at timestamptz,
  -- none: not released. pending: released fresh, awaiting evaluation. done: evaluated.
  -- skipped_stale: released, but first seen more than release.stale_after_days late.
  evaluation           text not null default 'none'
                         check (evaluation in ('none', 'pending', 'done', 'skipped_stale')),
  evaluated_at         timestamptz,
  first_observed_at    timestamptz not null,
  last_observed_at     timestamptz not null,

  constraint release_events_one unique (media_item_id, event_kind, region),
  -- released is the only state with a release date, and a released event keeps it.
  constraint release_events_released_on check ((state = 'released') = (released_on is not null)),
  constraint release_events_kind_shape check (
    (event_kind = 'season_premiere'    and region = '' and season_number > 0) or
    (event_kind = 'theatrical_release' and region ~ '^[A-Z]{2}$' and season_number is null)
  ),
  constraint release_events_evaluation check ((evaluation = 'none') = (state <> 'released'))
);

create index release_events_subject on release_events (subject_id);
create index release_events_pending on release_events (released_observed_at) where evaluation = 'pending';

comment on table release_events is
  'One row per (season premiere) or (film, US theatrical release): the release state machine. The unique key is the event-level dedupe: however many refreshes observe Season 3, there is one row. released is terminal. service_role only.';

create table release_event_log (
  id               bigint generated always as identity primary key,
  release_event_id uuid not null references release_events(id) on delete cascade,
  observed_at      timestamptz not null,
  change           text not null check (change in (
                     'created', 'date_set', 'date_changed', 'date_cleared',
                     'released', 'released_stale', 'withdrawn', 'restored',
                     'moved_after_release', 'cleared_after_release')),
  from_state       text,
  to_state         text not null,
  old_date         date,
  new_date         date
);

create index release_event_log_event on release_event_log (release_event_id, observed_at);

comment on table release_event_log is
  'Append-only history of every change release_observe makes to a release event: dates set, moved, cleared; releases; withdrawals; and the anomaly the shadow period measures (a date that moves after its release was recorded). Written only on a change, so a refresh that learns nothing writes nothing. service_role only.';


-- ---------------------------------------------------------------------------
-- 3. Where a person is, coarsely: owner-private
--
-- Timezone decides the local send window (founder decision 5: unknown means no push,
-- and it is never guessed from server location). Region decides whether a US theatrical
-- date is the reader's date. Not on profiles, which other people can read: a timezone
-- plus a country is coarse location. No read policy at all, like device_tokens.
-- ---------------------------------------------------------------------------

create table account_context (
  user_id     uuid primary key references profiles(id) on delete cascade,
  timezone    text,
  region      text check (region ~ '^[A-Z]{2}$'),
  reported_at timestamptz not null default now()
);

comment on table account_context is
  'The device timezone and locale region an account last reported (report_device_context). Read server-side for release evaluation only. No read policy: never returned to any client, including its owner.';

create or replace function report_device_context(p_timezone text, p_region text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_timezone text;
  v_region   text;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- A suspended account has nothing to be told about (release evaluation reads active
  -- accounts only), so it has nothing to report either.
  perform assert_can_write();

  -- Validated, never trusted, and a bad value is dropped rather than refused: a phone
  -- reporting a zone Postgres does not know must not surface an error on launch.
  select name into v_timezone from pg_timezone_names where name = nullif(trim(p_timezone), '') limit 1;
  v_region := case when upper(trim(coalesce(p_region, ''))) ~ '^[A-Z]{2}$'
                   then upper(trim(p_region)) end;

  insert into account_context as ac (user_id, timezone, region, reported_at)
  values (v_user, v_timezone, v_region, now())
  on conflict (user_id) do update
     set timezone    = coalesce(excluded.timezone, ac.timezone),
         region      = coalesce(excluded.region, ac.region),
         reported_at = excluded.reported_at
   where ac.timezone is distinct from coalesce(excluded.timezone, ac.timezone)
      or ac.region   is distinct from coalesce(excluded.region, ac.region)
      or ac.reported_at < now() - interval '1 day';

  return jsonb_build_object(
    'ok', true,
    'timezone_accepted', v_timezone is not null,
    'region_accepted', v_region is not null
  );
end;
$$;

comment on function report_device_context(text, text) is
  'Records the caller''s device timezone (an IANA name Postgres knows) and locale region (two letters). A value that does not validate is ignored, not refused, and never blanks a known one. Writes only when something changed or the row is a day old, so calling it every session is cheap. Returns nothing about the stored row. Calls assert_can_write: a suspended account is never evaluated, so it has nothing to report.';

revoke execute on function report_device_context(text, text) from public, anon;
grant execute on function report_device_context(text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. The clock rules
-- ---------------------------------------------------------------------------

-- A date has been reached once it has begun anywhere on Earth: 00:00 at UTC+14. Personal
-- delivery is gated later, per local date (20260930000200); this only says the event is
-- no longer in the future.
create or replace function _release_reached(p_date date, p_now timestamptz)
returns boolean
language sql
immutable
as $$
  select p_date is not null
     and p_now >= (p_date::timestamp at time zone 'UTC') - interval '14 hours';
$$;

-- When a subject should next be read. §D2 of the design, as written.
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

  -- Around a date, and while a date has passed without a fresh confirming read: every six
  -- hours, so every release is bracketed by at least two fresh reads.
  if exists (
    select 1 from release_events
     where subject_id = p_subject and state = 'scheduled' and scheduled_date <= v_today + 1
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
-- 5. One event, one observation
--
-- Returns the change it made ('unchanged' when there was none). Every change writes one
-- log row; an unchanged observation writes none. The rules:
--
--   * a new date state is: withdrawn (the caller says so) / announced (no date) /
--     released (date reached AND the read is fresh) / scheduled (anything else,
--     including a reached date on a stale read, which waits for a fresh one);
--   * released is terminal: a later date or a cleared date is logged as an anomaly and
--     the event stays released, so nothing can release it twice;
--   * a release more than p_stale_days old when first recorded is skipped_stale, and
--     evaluation never sees it.
-- ---------------------------------------------------------------------------

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
  p_stale_days    integer
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

  v_eval := case
    when v_state <> 'released' then 'none'
    when p_date >= v_today - p_stale_days then 'pending'
    else 'skipped_stale'
  end;

  if not v_exists then
    insert into release_events (
      media_item_id, subject_id, event_kind, region, season_number, state,
      scheduled_date, date_first_seen_at, released_on, released_observed_at,
      evaluation, first_observed_at, last_observed_at
    ) values (
      p_media_item_id, p_subject_id, p_kind, p_region, p_season_number, v_state,
      p_date, case when p_date is not null then p_now end,
      case when v_state = 'released' then p_date end,
      case when v_state = 'released' then p_now end,
      v_eval, p_now, p_now
    )
    returning * into e;

    v_change := case
      when v_state = 'released' and v_eval = 'pending' then 'released'
      when v_state = 'released' then 'released_stale'
      else 'created'
    end;

    insert into release_event_log (release_event_id, observed_at, change, from_state, to_state, old_date, new_date)
    values (e.id, p_now, v_change, null, v_state, null, p_date);
    return v_change;
  end if;

  -- Terminal. The date can still move in TMDB, and when it does that is worth knowing:
  -- it is the one thing that says the release we recorded may not have been one.
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

  v_change := case
    when v_state = 'released' and v_eval = 'pending' then 'released'
    when v_state = 'released' then 'released_stale'
    when v_state = 'withdrawn' and e.state <> 'withdrawn' then 'withdrawn'
    when e.state = 'withdrawn' and v_state <> 'withdrawn' then 'restored'
    when p_date is distinct from e.scheduled_date then
      case when e.scheduled_date is null then 'date_set'
           when p_date is null then 'date_cleared'
           else 'date_changed' end
    when v_state <> e.state then 'restored'
    else 'unchanged'
  end;

  if v_change = 'unchanged' then
    update release_events set last_observed_at = p_now where id = e.id;
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
         released_observed_at = case when v_state = 'released' then p_now end,
         evaluation           = v_eval,
         last_observed_at     = p_now
   where id = e.id;

  insert into release_event_log (release_event_id, observed_at, change, from_state, to_state, old_date, new_date)
  values (e.id, p_now, v_change, e.state, v_state, e.scheduled_date, p_date);
  return v_change;
end;
$$;

comment on function _release_event_apply(uuid, uuid, text, text, integer, date, boolean, boolean, timestamptz, integer) is
  'The release state machine for one event and one observation. announced / scheduled / released / withdrawn; released only on a reached date with a fresh read; released is terminal (later date moves are logged as anomalies); a release first recorded more than p_stale_days late is skipped_stale. Logs exactly one row per change and none when nothing changed. Internal.';


-- ---------------------------------------------------------------------------
-- 6. The observation entry point: what tmdb-adapter calls after every read
--
-- Payload (normalize.ts releaseObservation*):
--   { media_item_id, kind: 'series'|'movie', status, in_production, read_at,
--     seasons: [{ season_number, air_date }],                            -- series
--     regions: [{ region, theatrical, limited, digital, premiere }] }    -- movie, US
--
-- An untracked subject is answered 'untracked' and nothing is written, so the adapter's
-- detail path can offer every read it makes without growing this table.
-- ---------------------------------------------------------------------------

create or replace function release_observe(p_obs jsonb, p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id       uuid;
  v_kind     media_kind;
  v_read     timestamptz;
  v_fresh    boolean;
  v_stale    integer;
  v_status   text;
  v_season   record;
  v_season_id uuid;
  v_us       jsonb;
  v_date     date;
  v_change   text;
  v_changes  jsonb := '{}'::jsonb;
  v_missing  integer := 0;
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

  -- The detail path and the scheduled refresh can observe one subject at the same moment.
  perform pg_advisory_xact_lock(hashtextextended('release-subject:' || v_id::text, 0));

  -- A read claiming to be from the future is a clock problem, not a fresher read.
  v_read  := least(coalesce(nullif(p_obs ->> 'read_at', '')::timestamptz, p_now), p_now);
  v_fresh := v_read >= p_now - make_interval(
               hours => (_release_setting('release.freshness_hours', '12'::jsonb) #>> '{}')::integer);
  v_stale := (_release_setting('release.stale_after_days', '7'::jsonb) #>> '{}')::integer;
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
        -- A canceled show withdraws what has not aired; an aired season stays aired.
        v_status = 'Canceled' and not _release_reached(v_season.d, p_now),
        v_fresh, p_now, v_stale);
      v_changes := jsonb_set(v_changes, array[v_change],
                             to_jsonb(coalesce((v_changes ->> v_change)::integer, 0) + 1));
    end loop;
  elsif v_kind = 'movie' then
    select x into v_us
      from jsonb_array_elements(coalesce(p_obs -> 'regions', '[]'::jsonb)) as x
     where x ->> 'region' = 'US'
     limit 1;
    -- Type 3, wide theatrical. Limited (type 2), digital and premiere dates are kept in
    -- facts and never make a theatrical release.
    v_date := nullif(v_us ->> 'theatrical', '')::date;
    v_change := _release_event_apply(
      v_id, v_id, 'theatrical_release', 'US', null, v_date,
      v_status = 'Canceled' and not _release_reached(v_date, p_now),
      v_fresh, p_now, v_stale);
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

comment on function release_observe(jsonb, timestamptz) is
  'Applies one normalized TMDB observation of a tracked movie or series to its release events and reschedules its next read. The only writer of release state besides the failure path. p_now is the clock; production passes nothing. Untracked subjects are answered and ignored. service_role only (tmdb-adapter).';

create or replace function release_observe_failure(
  p_media_item_id uuid,
  p_error         text,
  p_now           timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_failures integer;
begin
  update release_subjects
     set failures        = failures + 1,
         last_error      = left(coalesce(p_error, 'unknown'), 300),
         last_attempt_at = p_now,
         next_check_at   = p_now + case least(failures + 1, 4)
                                     when 1 then interval '1 hour'
                                     when 2 then interval '3 hours'
                                     when 3 then interval '12 hours'
                                     else interval '24 hours' end
   where media_item_id = p_media_item_id
  returning failures into v_failures;

  return jsonb_build_object('status', case when v_failures is null then 'untracked' else 'recorded' end,
                            'failures', v_failures);
end;
$$;

comment on function release_observe_failure(uuid, text, timestamptz) is
  'Records a failed TMDB read of a tracked subject and backs it off: 1h, 3h, 12h, then 24h. A failed read never touches release state. service_role only (tmdb-adapter).';


-- ---------------------------------------------------------------------------
-- 7. Who is worth polling: explicit interest only
--
-- A series: any active account has a watch signal on one of its normal seasons (ranked,
-- or logged with a bucket, a date or a progress), or has the series or one of its
-- seasons on its watchlist. A film: on an active account's watchlist, dated within the
-- last year or undated or future, and not already released (US) more than two weeks ago.
-- Browsing, searching and opening a title page are not interest.
-- ---------------------------------------------------------------------------

create or replace function _release_reconcile(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today   date := (p_now at time zone 'UTC')::date;
  v_added   integer;
  v_removed integer;
begin
  with active as (
    select id from profiles where status = 'active'
  ),
  series_ids as (
    select s.parent_id as id
      from rankings r
      join active a on a.id = r.user_id
      join media_items s on s.id = r.media_item_id and s.kind = 'season' and s.season_number > 0
    union
    select s.parent_id
      from user_media um
      join active a on a.id = um.user_id
      join media_items s on s.id = um.media_item_id and s.kind = 'season' and s.season_number > 0
     where um.bucket is not null or um.watched_on is not null or um.progress is not null
    union
    select case when m.kind = 'season' then m.parent_id else m.id end
      from watchlist w
      join active a on a.id = w.user_id
      join media_items m on m.id = w.media_item_id and m.kind in ('series', 'season')
  ),
  interest as (
    select m.id, 'series'::text as kind
      from media_items m
      join series_ids si on si.id = m.id
     where m.kind = 'series' and m.tmdb_id > 0
    union
    select m.id, 'movie'
      from watchlist w
      join active a on a.id = w.user_id
      join media_items m on m.id = w.media_item_id and m.kind = 'movie'
     where m.tmdb_id > 0
       and (m.release_date is null or m.release_date >= v_today - 365)
       and not exists (
             select 1 from release_events e
              where e.media_item_id = m.id
                and e.event_kind = 'theatrical_release'
                and (e.state = 'withdrawn' or (e.state = 'released' and e.released_on < v_today - 14))
           )
  ),
  added as (
    insert into release_subjects (media_item_id, subject_kind, next_check_at)
    select id, kind, p_now from interest
    on conflict (media_item_id) do nothing
    returning 1
  ),
  removed as (
    delete from release_subjects rs
     where not exists (select 1 from interest i where i.id = rs.media_item_id)
    returning 1
  )
  select (select count(*) from added), (select count(*) from removed)
    into v_added, v_removed;

  return jsonb_build_object('added', v_added, 'removed', v_removed);
end;
$$;

comment on function _release_reconcile(timestamptz) is
  'Brings release_subjects in line with explicit interest: adds newly interesting movies and series (due immediately) and removes subjects nobody is interested in any more. Events are kept; a subject that returns resumes them. Internal.';


-- ---------------------------------------------------------------------------
-- 8. The tick: reconcile, then post what is due to tmdb-adapter
-- ---------------------------------------------------------------------------

create or replace function _release_refresh_tick(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reconciled jsonb;
  v_ids        uuid[];
  v_url        text;
  v_key        text;
  v_batch      integer;
begin
  if _release_setting('release.refresh_enabled', 'true'::jsonb) = 'false'::jsonb then
    return jsonb_build_object('status', 'disabled');
  end if;

  v_reconciled := _release_reconcile(p_now);
  v_batch := greatest(1, least(100,
               (_release_setting('release.refresh_batch', '40'::jsonb) #>> '{}')::integer));

  select coalesce(array_agg(media_item_id), '{}') into v_ids
    from (
      select media_item_id from release_subjects
       where next_check_at <= p_now
       order by next_check_at, media_item_id
       limit v_batch
       for update skip locked
    ) due;

  if coalesce(array_length(v_ids, 1), 0) = 0 then
    return jsonb_build_object('status', 'idle', 'reconciled', v_reconciled);
  end if;

  select nullif(value #>> '{}', '') into v_url from app_config where key = 'functions.base_url';
  begin
    select decrypted_secret into v_key
      from vault.decrypted_secrets where name = 'service_role_key';
  exception when others then
    v_key := null;
  end;

  -- Loud, unlike the poster nudge. A refresh that cannot reach the adapter is a release
  -- system that has stopped seeing dates, and cron must record that as a failure, not as
  -- 1,221 green runs (the push-drain incident, 20260826000700).
  if v_url is null or nullif(v_key, '') is null
     or to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null
  then
    raise exception 'release refresh has % due subjects and cannot reach tmdb-adapter (base_url %, vault key %, pg_net %)',
      array_length(v_ids, 1),
      case when v_url is null then 'missing' else 'set' end,
      case when nullif(v_key, '') is null then 'missing' else 'set' end,
      case when to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then 'missing' else 'present' end
      using errcode = 'P0001';
  end if;

  -- A lease. The adapter's answer (release_observe or release_observe_failure) reschedules
  -- each subject properly; a post that never arrives is simply tried again in two hours.
  update release_subjects
     set last_attempt_at = p_now,
         next_check_at   = p_now + interval '2 hours'
   where media_item_id = any (v_ids);

  perform net.http_post(
    url     := v_url || '/tmdb-adapter',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || v_key,
                 'apikey',        v_key
               ),
    body    := jsonb_build_object('action', 'release-refresh', 'ids', to_jsonb(v_ids)),
    timeout_milliseconds := 60000
  );

  return jsonb_build_object('status', 'posted', 'due', array_length(v_ids, 1),
                            'reconciled', v_reconciled);
end;
$$;

comment on function _release_refresh_tick(timestamptz) is
  'The scheduled release refresh: reconciles interest, then posts up to release.refresh_batch due subjects to tmdb-adapter (action release-refresh) through pg_net, leasing them for two hours. Raises when there is due work and the transport is not configured, so pg_cron records a failure. release.refresh_enabled = false stops it. Internal.';


-- ---------------------------------------------------------------------------
-- 9. Grants. Everything here is operator-side except report_device_context.
-- ---------------------------------------------------------------------------

alter table release_subjects  enable row level security;
alter table release_events    enable row level security;
alter table release_event_log enable row level security;
alter table account_context   enable row level security;

revoke all on release_subjects, release_events, release_event_log, account_context
  from anon, authenticated;

revoke execute on function _release_setting(text, jsonb)                from public, anon, authenticated;
revoke execute on function _release_reached(date, timestamptz)          from public, anon, authenticated;
revoke execute on function _release_next_check(uuid, timestamptz)       from public, anon, authenticated;
revoke execute on function _release_event_apply(uuid, uuid, text, text, integer, date, boolean, boolean, timestamptz, integer)
  from public, anon, authenticated;
revoke execute on function release_observe(jsonb, timestamptz)          from public, anon, authenticated;
revoke execute on function release_observe_failure(uuid, text, timestamptz) from public, anon, authenticated;
revoke execute on function _release_reconcile(timestamptz)              from public, anon, authenticated;
revoke execute on function _release_refresh_tick(timestamptz)           from public, anon, authenticated;

grant execute on function release_observe(jsonb, timestamptz)              to service_role;
grant execute on function release_observe_failure(uuid, text, timestamptz) to service_role;
grant execute on function _release_reconcile(timestamptz)                  to service_role;
grant execute on function _release_refresh_tick(timestamptz)               to service_role;
