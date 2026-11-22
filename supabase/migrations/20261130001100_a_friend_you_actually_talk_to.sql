-- A friend you actually talk to, and a pilot before a crowd (founder request, 2026-11-22).
--
-- Makes `watchlist_social` safe to pilot. Specification and audit:
-- docs/product/proactive-pilot-2026-11-22.md. Nothing here turns anything on: every new
-- switch is seeded off or empty, and production already has `proactive.generation_enabled`
-- and `proactive.push_enabled` false, so applying this changes nothing anybody sees.
--
-- ---------------------------------------------------------------------------
-- WHAT CHANGES
-- ---------------------------------------------------------------------------
--
-- 1. MEANINGFUL AFFINITY QUALIFIES A FRIEND (approved doctrine: "not mutual following
--    alone"). Until now a mutual follow was the whole qualification and `_proactive_affinity`
--    only ordered clusters and chose names. Now a friend counts toward a reader's
--    watchlist_social cluster only while the reader's affinity toward them is STRICTLY ABOVE
--    `proactive.friend_min_affinity` (seeded 1.5). The score's structure makes 1.5 the floor
--    that means something (proactive-notifications.md §R.1): a mutual follow is 0.5 and the
--    reactions family caps at 1, and reactions earn no reciprocity bonus, so mutual follow
--    plus any amount of reacting is at most 1.5. Above it there is always a comment, a reply,
--    a mention, a delivered recommendation or a co-watch inside the 90-day window. A block or
--    an inactive account is 0 (20261112000100). Fail closed: a value that is not a JSON
--    number qualifies nobody.
--
--    Applied in two places, nowhere else:
--      * the feed_events trigger joins a reader's cluster only for a qualifying actor, so a
--        non-qualifying friend writes nothing (no cluster, no inbox row, no member);
--      * `_proactive_social_actors`, the one authority for who is in a cluster, keeps only
--        members who still qualify. So the threshold count (eligibility, the arbiter's and
--        the claim's revalidation), the names in the push and in the inbox, and the push's
--        count all agree. A friend whose affinity decays below it mid-window drops out the
--        way a friend who unfollows does.
--    Two distinct qualifying friends inside the fixed 7-day window still make the push
--    (`proactive.social_threshold` 2, unchanged).
--
-- 2. A TYPE SWITCH FOR SOCIAL, AND ONE FOR THEATRICAL. `proactive.generation_enabled` used to
--    start social and theatrical together; seasons and resurfacing already had their own
--    switches. Now:
--      * `proactive.social_enabled` (seeded false) gates the social trigger, and is
--        re-checked at selection and at the claim (`social_disabled`), as seasons are;
--      * `proactive.theatrical_enabled` (seeded false) gates the theatrical collector, and
--        is re-checked the same way (`theatrical_disabled`).
--    So a pilot can turn on generation for social alone, and theatrical stays dark until it
--    is decided separately. Both fail closed: only the JSON boolean true is on.
--
-- 3. A PILOT ALLOWLIST. `proactive.pilot_recipients` (seeded `[]`): a JSON array of account
--    ids. Empty means no restriction (the behaviour before this migration). Non-empty means
--    only those readers can get a proactive candidate, inbox row or push, of any type:
--      * the social trigger considers listed readers only, so the fan-out of a ranking is
--        the allowlist, not every watchlister of the title;
--      * a BEFORE INSERT trigger on `proactive_candidates` drops any other recipient's row,
--        whichever collector wrote it. Every writer already treats "no row came back" as
--        "already decided" and writes no inbox row;
--      * `_proactive_invalid` answers `outside_pilot` for anybody not listed, so a candidate
--        made before the list was set (or for somebody later removed from it) is suppressed
--        at selection and dropped at the claim.
--    Fail closed: anything but an array of uuid strings (a string, an object, JSON null, a
--    malformed id) allows nobody.
--
-- 4. `proactive_status()` reports the two new switches, the threshold, and whether the
--    pilot restricts and to how many accounts (a count, never an id).
--
-- ---------------------------------------------------------------------------
-- WHAT DOES NOT CHANGE
-- ---------------------------------------------------------------------------
--
-- No signature changes; every rebuilt function is its latest body (20261028000100,
-- 20261031000100) with additions only. No lock is added, removed or reordered: the social
-- writer, the mute, the arbiter and the claim take exactly the locks they took (the new
-- checks are reads). The ledger, caps, window, cooldowns, dedupe, client-version gate,
-- `claim_push_batch`, `my_notifications`, `_proactive_social_add` and the push payload are
-- untouched. Reactive notifications read none of this.
--
-- No backfill, by construction: the social trigger only ever sees a feed_events row at the
-- moment it is inserted (and refuses one dated more than a day back), so ranking activity
-- from before `proactive.social_enabled` is turned on never joins a cluster. The first tick
-- after enablement finds no social candidate to arbitrate.
--
-- Rollback: docs/release/proactive-pilot/rollback-20261130001100.sql, rehearsed by
-- supabase/tests/proactive-pilot-rollback.test.mjs. Kill switch unchanged:
-- `proactive.push_enabled` false (push-operations.md §12); `proactive.social_enabled` false
-- now also stops social at the claim.

insert into app_config (key, value) values
  ('proactive.social_enabled', 'false'::jsonb),
  ('proactive.theatrical_enabled', 'false'::jsonb),
  ('proactive.friend_min_affinity', '1.5'::jsonb),
  ('proactive.pilot_recipients', '[]'::jsonb)
on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- 1. The switches, the threshold and the allowlist, read in one place each
-- ---------------------------------------------------------------------------

create or replace function _proactive_social_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select _proactive_setting('proactive.social_enabled', 'false'::jsonb) = 'true'::jsonb;
$$;

comment on function _proactive_social_enabled() is
  'True only when app_config proactive.social_enabled is exactly the JSON boolean true (20261130001100; seeded false). Gates the watchlist_social trigger, and selection and the claim (social_disabled). Internal.';

create or replace function _proactive_theatrical_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select _proactive_setting('proactive.theatrical_enabled', 'false'::jsonb) = 'true'::jsonb;
$$;

comment on function _proactive_theatrical_enabled() is
  'True only when app_config proactive.theatrical_enabled is exactly the JSON boolean true (20261130001100; seeded false). Gates the theatrical collector, and selection and the claim (theatrical_disabled). Internal.';

create or replace function _proactive_friend_min_affinity()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric end
    from (select _proactive_setting('proactive.friend_min_affinity', '1.5'::jsonb) as v) s;
$$;

comment on function _proactive_friend_min_affinity() is
  'The affinity a friend must exceed to count toward watchlist_social (20261130001100; seeded 1.5, absent means 1.5). Null, which qualifies nobody, for anything that is not a JSON number. Internal.';

/**
 * Whether `p_actor` is a friend who counts for `p_reader` now: the reader's affinity toward
 * them is strictly above the threshold. Mutual follow and visibility are the callers' to
 * check, as they always were; a block or an inactive account is already 0 here.
 */
create or replace function _proactive_friend_qualifies(p_reader uuid, p_actor uuid, p_now timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(_proactive_affinity(p_reader, p_actor, p_now) > _proactive_friend_min_affinity(), false);
$$;

comment on function _proactive_friend_qualifies(uuid, uuid, timestamptz) is
  'True when p_reader''s _proactive_affinity toward p_actor is strictly above proactive.friend_min_affinity (20261130001100). Above 1.5 that always means a comment, reply, mention, delivered recommendation or co-watch, never reactions alone. False for a malformed threshold. Internal.';

/**
 * The pilot allowlist. NULL means "no restriction" (the key absent, or the empty array);
 * otherwise the listed ids, and an empty array for anything malformed, which allows nobody.
 */
create or replace function _proactive_pilot_recipients()
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v   jsonb := _proactive_setting('proactive.pilot_recipients', '[]'::jsonb);
  ids uuid[];
begin
  if jsonb_typeof(v) = 'array' and jsonb_array_length(v) = 0 then
    return null;
  end if;
  if jsonb_typeof(v) is distinct from 'array' then
    return '{}'::uuid[];
  end if;
  if exists (select 1 from jsonb_array_elements(v) e
              where jsonb_typeof(e) <> 'string'
                 or not ((e #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    return '{}'::uuid[];
  end if;
  select array_agg(distinct (e #>> '{}')::uuid) into ids from jsonb_array_elements(v) e;
  return ids;
end;
$$;

comment on function _proactive_pilot_recipients() is
  'proactive.pilot_recipients as ids (20261130001100): null when the list is absent or empty (no restriction), the ids when it is a non-empty array of uuid strings, and an empty array (nobody) for anything else. Internal.';

create or replace function _proactive_pilot_allows(p_recipient uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case when r is null then true else p_recipient = any (r) end
    from (select _proactive_pilot_recipients() as r) s;
$$;

comment on function _proactive_pilot_allows(uuid) is
  'Whether the pilot allowlist lets this recipient have a proactive candidate (20261130001100): always while the list is empty, otherwise only when listed. Internal.';


-- ---------------------------------------------------------------------------
-- 2. The reasons vocabulary learns three words
-- ---------------------------------------------------------------------------

-- Rebuilt from 20261031000100 with three words at the end. The two check constraints on
-- proactive_candidates call this, so a new row may use them from now on.
create or replace function _proactive_reasons()
returns text[]
language sql immutable
as $$
  select array[
    -- No longer true (suppressed at once).
    'preference_off', 'not_on_watchlist', 'already_watched', 'inactive_recipient',
    'below_threshold', 'release_changed', 'release_stale', 'too_late', 'region_unknown',
    -- Holding it back while it is still timely (recorded as last_block_reason; becomes the
    -- suppression reason if the candidate expires while held).
    'kill_switch', 'no_timezone', 'client_unsupported', 'no_device', 'quiet_window',
    'higher_priority_selected', 'daily_cap', 'weekly_cap', 'type_cooldown', 'title_cooldown',
    -- Expired with nothing in particular holding it.
    'expired',
    -- Selected, but by the time the sender claimed it the reader's evening window (or the
    -- local day it was selected for) had passed: a stalled drain recovering late. Terminal.
    'outside_window',
    -- A US theatrical candidate whose reader no longer reports a US region.
    'region_mismatch',
    -- A claim of a job whose candidate was already handed to the sender: at most once.
    -- Reported by the claim and never written over the `sent` state.
    'already_sent',
    -- 20261031000100, season_premiere: the operator switch is off; no valid operator
    -- verification of US availability; the reader no longer has a saved series or season
    -- or a watch of the season before.
    'season_disabled', 'availability_unverified', 'no_season_interest',
    -- 20261130001100: the type's operator switch is off; the recipient is not on a
    -- non-empty pilot allowlist.
    'social_disabled', 'theatrical_disabled', 'outside_pilot'
  ]::text[];
$$;


-- ---------------------------------------------------------------------------
-- 3. Who is in a cluster: only friends who still qualify
-- ---------------------------------------------------------------------------

-- Rebuilt from 20261028000100 with one condition added: the member still qualifies
-- (section 1). Everything else, including the order, is as it was.
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
     -- 20261130001100: meaningful affinity, not mutual following alone.
     and _proactive_friend_qualifies(p_recipient, a.actor_id, now())
   group by p.id, p.username, p.display_name, p.avatar_path
   order by min(a.joined_at), p.id;
$$;

comment on function _proactive_social_actors(uuid, uuid) is
  'The members of one watchlist_social cluster the recipient may be told about now: active, mutual follows, viewable, not the recipient, and (20261130001100) still a qualifying friend by affinity (_proactive_friend_qualifies). Earliest first. Internal.';


-- ---------------------------------------------------------------------------
-- 4. The social trigger: its own switch, the allowlist, and qualifying friends only
-- ---------------------------------------------------------------------------

-- Rebuilt from 20261031000100. Added: the social switch (before the per-transaction claim,
-- so a switched-off ranking claims nothing), the allowlist in the reader query (so the
-- fan-out is the allowlist during a pilot), and the affinity qualification per reader,
-- asked only of readers who passed every cheaper check.
create or replace function _proactive_social_on_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reader uuid;
  v_first  text;
  v_pilot  uuid[];
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
  -- 20261130001100. The type's own switch, also seeded false.
  if not _proactive_social_enabled() then
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

  -- 20261130001100. Null: no pilot restriction. Empty: nobody (a malformed list).
  v_pilot := _proactive_pilot_recipients();

  for v_reader in
    select w.user_id
      from watchlist w
      join profiles rp on rp.id = w.user_id and rp.status = 'active'
     where w.media_item_id = new.media_item_id
       and w.user_id <> new.actor_id
       and (v_pilot is null or w.user_id = any (v_pilot))
       and exists (select 1 from follows f
                    where f.follower_id = w.user_id and f.followee_id = new.actor_id and f.state = 'approved')
       and exists (select 1 from follows f
                    where f.follower_id = new.actor_id and f.followee_id = w.user_id and f.state = 'approved')
       and can_view_profile(w.user_id, new.actor_id)
       and not _proactive_title_watched(w.user_id, new.media_item_id)
     order by w.user_id
  loop
    begin
      -- 20261130001100. Meaningful affinity, asked last because it is the dearest check.
      if not _proactive_friend_qualifies(v_reader, new.actor_id, now()) then
        continue;
      end if;
      perform _proactive_social_add(v_reader, new.actor_id, new.media_item_id, new.id, now());
    exception when others then
      raise warning 'watchlist_social: % (%)', sqlerrm, sqlstate;
    end;
  end loop;

  return null;
end;
$$;

comment on function _proactive_social_on_activity() is
  'After-insert trigger on feed_events: a title_ranked or title_logged row written now (not during an import, not a backfill) joins the watchlist_social cluster of every active mutual friend who has that title saved, can view the actor and has not watched it. Since 20261031000100 only the first qualifying event of a transaction does (transaction-local bingd.proactive.social_event_id); a later one is skipped with the warning second_qualifying_event_in_transaction. Since 20261130001100 only while proactive.social_enabled is also exactly true, only for readers on a non-empty proactive.pilot_recipients, and only for an actor who is a qualifying friend by affinity (_proactive_friend_qualifies). Never fails the write it rides on. Internal.';


-- ---------------------------------------------------------------------------
-- 5. The allowlist at the ledger's door
-- ---------------------------------------------------------------------------

/**
 * Every proactive candidate of every type is an insert into proactive_candidates, so this is
 * the one place a non-empty allowlist is enforced whoever writes. A dropped row is what every
 * collector already reads as "somebody already decided this reader": the social writer
 * answers `raced`, the theatrical and season collectors `continue`, and none of them writes an
 * inbox row without its candidate. Takes no lock.
 */
create or replace function _proactive_candidates_pilot_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not _proactive_pilot_allows(new.recipient_id) then
    return null;
  end if;
  return new;
end;
$$;

comment on function _proactive_candidates_pilot_scope() is
  'BEFORE INSERT trigger on proactive_candidates (20261130001100): while proactive.pilot_recipients is non-empty, a candidate for anybody not listed is not written. Internal.';

drop trigger if exists proactive_candidates_pilot_scope on proactive_candidates;
create trigger proactive_candidates_pilot_scope
  before insert on proactive_candidates
  for each row execute function _proactive_candidates_pilot_scope();


-- ---------------------------------------------------------------------------
-- 6. Revalidation: the type switches and the allowlist, at selection and at the claim
-- ---------------------------------------------------------------------------

-- Rebuilt from 20261031000100. Added, after the preference: outside_pilot; and per type,
-- social_disabled and theatrical_disabled, as season_disabled already was. Nothing else moves.
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
  -- 20261130001100. A non-empty pilot allowlist that does not list this reader.
  if not _proactive_pilot_allows(c.recipient_id) then
    return 'outside_pilot';
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

  -- 20261130001100. The type's operator switch, as for seasons above: off means none of
  -- that type reaches anybody, including one already selected for tonight.
  if c.type = 'watchlist_social' and not _proactive_social_enabled() then
    return 'social_disabled';
  end if;
  if c.type = 'theatrical_release' and not _proactive_theatrical_enabled() then
    return 'theatrical_disabled';
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
  'Null if a proactive candidate is still true, else the permanent reason it is not: recipient inactive, preference off, title off the Watchlist, already watched, a social cluster below its threshold, or a film whose date moved, went stale or has arrived, or whose reader no longer reports a US region (region_mismatch / region_unknown). Since 20261031000100, for season_premiere: season_disabled (operator switch off), already_watched (the season touched), no_season_interest (no saved series or season, no watch of the season before), _proactive_season_release_reason, region_unknown / region_mismatch, availability_unverified (no valid US verification agreeing with the candidate). Since 20261130001100: outside_pilot (a non-empty proactive.pilot_recipients that does not list the recipient), social_disabled and theatrical_disabled (the type''s operator switch off); and a social cluster counts only qualifying friends. Asked before selection and again at send. Internal.';


-- ---------------------------------------------------------------------------
-- 7. The tick: theatrical behind its own switch
-- ---------------------------------------------------------------------------

-- Rebuilt from 20261031000100 with the theatrical collector behind
-- proactive.theatrical_enabled. Lock order unchanged.
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
    -- 20261130001100. Theatrical needs its own switch too (seeded false).
    if _proactive_theatrical_enabled() then
      v_theatrical := _proactive_theatrical_collect(p_now);
    end if;
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
  'The scheduled proactive pass: collect theatrical (also gated by proactive.theatrical_enabled, 20261130001100), season (also gated by proactive.season_enabled, 20261031000100) and resurfacing candidates (only while proactive.generation_enabled is exactly true; seeded false), then arbitrate. A non-empty proactive.pilot_recipients limits every collector to the listed readers (20261130001100). One transaction: a failure rolls the whole tick back and the next repeats it; the ledger''s unique keys keep a repeat from doubling anything. Internal; scheduled as bingd-proactive-tick.';


-- ---------------------------------------------------------------------------
-- 8. Status
-- ---------------------------------------------------------------------------

-- Rebuilt from 20261031000100 with four more keys in its answer. Counts only: the pilot is
-- reported as how many accounts it lists, never which.
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
  v_pilot    uuid[] := _proactive_pilot_recipients();
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
    -- 20261130001100.
    'social_enabled', _proactive_social_enabled(),
    'theatrical_enabled', _proactive_theatrical_enabled(),
    'friend_min_affinity', _proactive_friend_min_affinity(),
    'pilot', jsonb_build_object('restricted', v_pilot is not null,
                                'recipients', coalesce(cardinality(v_pilot), 0)),
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
  'Proactive delivery at a glance: the push, generation, resurfacing and season (20261031000100) switches, the social and theatrical switches, the friend affinity threshold and the pilot allowlist as {restricted, recipients} counts (20261130001100), the job, the tick''s last run / last success / last failure from cron.job_run_details (last_tick_failed is a problem), candidate counts by type and state, anything selected but not claimed for 15 minutes (a stalled drain), jobs handed to push-sender and push opens in 24 hours. service_role only.';


-- ---------------------------------------------------------------------------
-- 9. Grants: every new function is internal
-- ---------------------------------------------------------------------------

revoke execute on function _proactive_social_enabled()                          from public, anon, authenticated;
revoke execute on function _proactive_theatrical_enabled()                      from public, anon, authenticated;
revoke execute on function _proactive_friend_min_affinity()                     from public, anon, authenticated;
revoke execute on function _proactive_friend_qualifies(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke execute on function _proactive_pilot_recipients()                        from public, anon, authenticated;
revoke execute on function _proactive_pilot_allows(uuid)                        from public, anon, authenticated;
revoke execute on function _proactive_candidates_pilot_scope()                  from public, anon, authenticated;
