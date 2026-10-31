-- ===========================================================================
-- Proactive notifications, part 3: a season worth waiting for, and friends worth naming
--
-- Specification: docs/product/proactive-notifications.md (§Q, §R and the sections each
-- names). Authority: founder brief of 2026-10-31 and the Codex final decision on it
-- (decision-log.md §6, "Proactive notifications v1, second tranche"). A forward migration
-- on top of 20261028000100 and 20261028000200, which stay exactly as they were reviewed.
--
--   season_premiere      a new season of a series the reader saved, or whose immediately
--                        preceding season they watched, is available in the US. Built
--                        whole and switched OFF: proactive.season_enabled (seeded false)
--                        gates creation, selection and the claim. A TMDB season date has
--                        no region and is not evidence of availability, so nothing is
--                        created without an operator-written verification row
--                        (proactive_season_availability), which nothing fills automatically.
--   affinity             an internal, read-only, deterministic score of how much a reader
--                        interacts with one friend (_proactive_affinity). It decides which of
--                        two competing social clusters wins the evening, and which two
--                        friends a social row and push name. Nothing else. No client can
--                        read it, and it is never stored.
--   priority             season_premiere 1, theatrical_release 2, watchlist_social 3,
--                        watchlist_resurface 4; a season and its series share one title
--                        cooldown (_proactive_cooldown_title).
--   reactions default    OFF for every account with no explicit row, existing and new
--                        (founder, 2026-10-31). Explicit rows win. No backfill.
--   client version       proactive.min_client_version 2: the first build that can route
--                        and render season_premiere. Version-1 tokens get no proactive push.
--   one event per txn    the social trigger now enforces the premise its lock order rests
--                        on (Fable final review, MINOR 1).
--
-- PROACTIVE INERTNESS. All four switches are false after this migration
-- (proactive.generation_enabled, push_enabled, resurface_enabled, season_enabled), so no
-- proactive candidate, inbox row or push exists until an operator turns one on. Two things
-- in this release are NOT behind those switches, deliberately: the Reactions default
-- (above), and the goal_completed push copy that the push-sender deploy activates
-- (20261028000100 §N). So the release as a whole is not behaviourally inert.
--
-- LOCK HIERARCHY (20261028000100 §5) is unchanged. The season collector runs only inside
-- _proactive_tick, after the global lock, inserts new rows only (on conflict do nothing)
-- and updates only the row it just inserted; it takes no release-event lock. Affinity and
-- season interest are reads. Nothing here adds a lock on a candidate row.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. Configuration
-- ---------------------------------------------------------------------------

insert into app_config (key, value) values
  -- THE SEASON SWITCH (operator-only, not a user setting). Off until the founder has a
  -- reliability review of the season shadow and market evidence of availability.
  ('proactive.season_enabled', 'false'::jsonb),
  -- A season's release event and its series must both have been read this recently.
  ('proactive.season_max_read_age_hours', '12'::jsonb),
  -- How long after the release is confirmed a season may still be collected.
  ('proactive.season_collect_hours', '48'::jsonb)
on conflict (key) do nothing;

-- The 20261028000100 seeds, moved on. Neither has been applied anywhere, but each update
-- only replaces the exact seed, so an operator's own value would survive it.
update app_config
   set value = '{"season_premiere": 1, "theatrical_release": 2, "watchlist_social": 3, "watchlist_resurface": 4}'::jsonb
 where key = 'proactive.priority'
   and value = '{"theatrical_release": 1, "watchlist_social": 2, "watchlist_resurface": 3}'::jsonb;

update app_config
   set value = '2'::jsonb
 where key = 'proactive.min_client_version'
   and value = '1'::jsonb;

-- Fail closed, like the other three: on only when the row is exactly the JSON boolean true.
create or replace function _proactive_season_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select _proactive_setting('proactive.season_enabled', 'false'::jsonb) = 'true'::jsonb;
$$;

comment on function _proactive_season_enabled() is
  'The operator switch for season_premiere alone. True only when app_config proactive.season_enabled is the JSON boolean true (seeded false). Read by _proactive_season_collect before creating anything, by _proactive_invalid (season_disabled) at selection and at the claim, and by _release_next_check for the post-release cadence. Not a user setting. Internal.';

-- Rebuilt from 20261028000100 with one change: the fallback minimum is 2, matching the
-- seed above, so a missing row never readmits version-1 builds.
create or replace function _proactive_capable_token(p_token device_tokens)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_token.revoked_at is null
     and coalesce(p_token.proactive_version, 0) >= _proactive_int('proactive.min_client_version', 2);
$$;

comment on function _proactive_capable_token(device_tokens) is
  'Whether one device token may receive a proactive push: live, and registered by a build at or above proactive.min_client_version (2 since 20261031000100: the first build that renders season_premiere). Internal.';


-- ---------------------------------------------------------------------------
-- 1. Reactions default off (founder, 2026-10-31)
--
-- Supersedes the 2026-08-20 decision (20260820000100). The 20260819000300 mechanism: an
-- account with no row gets the category's default, an account with a row chose, and
-- _notifies coalesces to the row without reaching this. So every account that never
-- touched Reactions, existing or new, stops getting reaction notifications (inbox and
-- push: one preference gates both at insert time), and every explicit choice, on or off,
-- is untouched. No DML: a backfill is exactly the thing that would blur the two.
--
-- Rows and pushes created before this migration keep their lifecycle. Awards stay on.
-- ---------------------------------------------------------------------------

create or replace function _notification_default(p_category text)
returns boolean
language sql immutable
set search_path = public
as $$
  -- Absence means *this*. True for every category except `reactions`, which the founder
  -- turned back off on 2026-10-31 after 20260820000100 had turned it on.
  select case when p_category = 'reactions' then false else true end;
$$;

comment on function _notification_default(text) is
  'What a category means when the account has no row for it: on, except reactions (off since 20261031000100, superseding 20260820000100). awards has been on since 20260828000100. Accounts with an explicit row are unaffected -- _notifies coalesces to the row and never reaches this. Internal.';

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
    -- 20261028000100. Everything proactive is one switch: Watching › Watchlist & discovery.
    when 'watchlist_social'      then 'watchlist_discovery'
    when 'theatrical_release'    then 'watchlist_discovery'
    when 'watchlist_resurface'   then 'watchlist_discovery'
    -- 20261031000100. The fourth proactive type, under the same one switch.
    when 'season_premiere'       then 'watchlist_discovery'
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
  'invites with invite_activated (20260831000100); the proactive types share '
  'watchlist_discovery (20261028000100; season_premiere since 20261031000100). An '
  'unmapped type is delivered.';


-- ---------------------------------------------------------------------------
-- 2. The ledger learns the fourth type
-- ---------------------------------------------------------------------------

alter table proactive_candidates drop constraint if exists proactive_candidates_type_check;
alter table proactive_candidates add constraint proactive_candidates_type_check
  check (type in ('watchlist_social', 'theatrical_release', 'watchlist_resurface', 'season_premiere'));

-- Rebuilt from 20261028000100 with three words at the end. The two check constraints on
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
    'season_disabled', 'availability_unverified', 'no_season_interest'
  ]::text[];
$$;

comment on table proactive_candidates is
  'The shared proactive-notification ledger (20261028000100): one row per (recipient, type, dedupe key), ever. pending → selected → sent, or suppressed / expired with a reason from _proactive_reasons(). Four types since 20261031000100 (season_premiere). Written only by internal functions (the arbiter, the type collectors, claim_push_batch). service_role only; aggregate through proactive_summary.';


-- ---------------------------------------------------------------------------
-- 3. Season availability, verified by an operator
--
-- What a row says: the WHOLE normal season is available to watch in that market on
-- available_on, and somebody checked the distributor's or platform's own page at
-- verified_at. Not "its first episode aired": a weekly show's premiere is not a season
-- that is available. TMDB's season air_date has no region and cannot say either, which is
-- why this exists and why nothing fills it automatically (Codex final decision).
--
-- v1 market is the US only. A row is good for at most 48 hours after it was checked; an
-- operator renews it by writing it again. Missing, expired, future-dated or inconsistent
-- with the release event: the season is not announced. The table may stay empty in
-- production, and with proactive.season_enabled false nothing reads it for delivery.
-- ---------------------------------------------------------------------------

create table proactive_season_availability (
  release_event_id uuid not null references release_events(id) on delete cascade,
  region           text not null check (region = 'US'),
  available_on     date not null,
  verified_at      timestamptz not null,
  valid_until      timestamptz not null,
  -- Where it was checked. Operator-only, like the table; never shown to anybody.
  evidence_url     text not null check (evidence_url ~ '^https://[^[:space:]]+$' and char_length(evidence_url) <= 500),
  primary key (release_event_id, region),
  constraint proactive_season_availability_window check (
    valid_until > verified_at and valid_until <= verified_at + interval '48 hours')
);

comment on table proactive_season_availability is
  'Operator-written evidence that a whole normal season is available in a market (US only in v1) from available_on, checked at verified_at against the distributor''s or platform''s own page (evidence_url), good until valid_until (at most 48 hours later). season_premiere is created and sent only while a row is valid and agrees with its release event. Nothing writes it automatically. RLS on, no policies, no client privileges (20261031000100).';

alter table proactive_season_availability enable row level security;
revoke all on proactive_season_availability from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. What the season checks are made of
-- ---------------------------------------------------------------------------

-- One title for the cross-type title cooldown: a season counts as its series, so a
-- season premiere, a friend ranking that season and a resurfacing of the series cannot
-- reach one reader inside a week by taking turns. Subjects and deep links keep the exact
-- media item; only the cooldown compares these.
create or replace function _proactive_cooldown_title(p_media uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select case when m.kind = 'season' then coalesce(m.parent_id, m.id) else m.id end
                     from media_items m where m.id = p_media),
                  p_media);
$$;

comment on function _proactive_cooldown_title(uuid) is
  'The title a proactive cooldown counts: a season''s series, otherwise the item itself. Used by the arbiter''s title cooldown and resurfacing''s 30-day exclusion (20261031000100). Internal.';

-- Whether the reader already has anything to do with the new season itself: ranked it,
-- or any user_media row for it (logged, watching, bucketed). Then "it is available" is
-- not news.
create or replace function _proactive_season_touched(p_user uuid, p_season uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from rankings r where r.user_id = p_user and r.media_item_id = p_season)
      or exists (select 1 from user_media um where um.user_id = p_user and um.media_item_id = p_season);
$$;

/**
 * Why this reader may hear about this season, or null if they may not (Codex final
 * decision, the eligibility table):
 *
 *   'watchlist'  the exact season or its series is on their Watchlist. Explicit interest,
 *                whatever their history: a reader behind, or with none, who saved it.
 *   'caught_up'  a meaningful watch signal (_proactive_title_watched: a ranking, or a log
 *                with a bucket, a watch date or progress completed) on the IMMEDIATELY
 *                PRECEDING NORMAL SEASON of the series (_proactive_season_prior), not the
 *                last season this reader happened to watch. Merely `watching` it is not.
 *                Specials (season 0) never count, and with the predecessor unknown or
 *                missing from the catalogue there is nobody caught up.
 *   null         anything weaker: behind without a save, no history without a save.
 *
 * Asked by the collector, and again before selection and at the claim through
 * _proactive_invalid, so a reader who removes the save in between is not told.
 */

/**
 * The immediately preceding normal season of a season premiere, or null (Codex
 * re-review, MAJOR). The NUMBER comes from the series' latest observation
 * (release_subjects.facts.seasons, what TMDB listed at the last read), never from
 * whichever lower seasons happen to be in our catalogue: if TMDB lists 1, 2 and 3 and
 * Season 2 was never fetched, the predecessor of 3 is 2, and with no Season 2 item it is
 * null. Missing data fails closed rather than making Season 1's viewers "caught up".
 */
create or replace function _proactive_season_prior(p_event uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.id
    from release_events e
    join release_subjects s on s.media_item_id = e.subject_id
    cross join lateral (
      select max((x ->> 'season_number')::integer) as n
        from jsonb_array_elements(
               case when jsonb_typeof(s.facts -> 'seasons') = 'array' then s.facts -> 'seasons'
                    else '[]'::jsonb end) x
       where (x ->> 'season_number') ~ '^[0-9]{1,4}$'
         and (x ->> 'season_number')::integer between 1 and e.season_number - 1
    ) p
    join media_items m
      on m.parent_id = e.subject_id and m.kind = 'season' and m.season_number = p.n
   where e.id = p_event
     and e.event_kind = 'season_premiere'
     and e.season_number > 1;
$$;

comment on function _proactive_season_prior(uuid) is
  'The catalogue item of the season immediately before a season premiere, numbered from the series'' latest observation (release_subjects.facts.seasons); null when that season is unknown or not in the catalogue, so a missing predecessor never makes an earlier season''s viewers caught up. Internal (20261031000100).';

create or replace function _proactive_season_interest(p_user uuid, p_event uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  with e as (
    select ev.media_item_id as season_id, ev.subject_id as series_id, ev.season_number
      from release_events ev
     where ev.id = p_event and ev.event_kind = 'season_premiere' and ev.season_number > 0
  )
  select case
           when exists (select 1 from watchlist w, e
                         where w.user_id = p_user and w.media_item_id in (e.season_id, e.series_id))
             then 'watchlist'
           when _proactive_title_watched(p_user, _proactive_season_prior(p_event))
             then 'caught_up'
         end;
$$;

comment on function _proactive_season_interest(uuid, uuid) is
  'Why a reader may be told a season is available: watchlist (the season or its series is saved) or caught_up (a ranking or completed watch signal on the immediately preceding normal season), else null. Internal (20261031000100).';

/**
 * Why a season's release event cannot be announced now, or null if it can. Every reason
 * is permanent for a candidate (it is suppressed, never held):
 *
 *   release_changed  not a released normal season premiere; its date moved or cleared after
 *                    release (scheduled_date no longer equals released_on, which is how the
 *                    terminal `released` state records a later change); the series' latest
 *                    read no longer listed the season; or the series is now Canceled.
 *   release_stale    the event was first seen long after it aired (skipped_stale), or the
 *                    event or its series was last read more than
 *                    proactive.season_max_read_age_hours (12) ago.
 */
create or replace function _proactive_season_release_reason(p_event uuid, p_now timestamptz)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  e       release_events%rowtype;
  s       release_subjects%rowtype;
  v_age   interval := make_interval(hours => _proactive_int('proactive.season_max_read_age_hours', 12));
begin
  select * into e from release_events where id = p_event;
  if not found
     or e.event_kind <> 'season_premiere'
     or e.state <> 'released'
     or coalesce(e.season_number, 0) < 1
     or e.scheduled_date is distinct from e.released_on then
    return 'release_changed';
  end if;
  if e.evaluation = 'skipped_stale' then
    return 'release_stale';
  end if;

  select * into s from release_subjects where media_item_id = e.subject_id;
  if not found or s.last_read_at is null then
    return 'release_stale';
  end if;
  -- The latest read of the series did not see this season: it is gone from TMDB's list.
  if e.last_observed_at < s.last_read_at then
    return 'release_changed';
  end if;
  if s.tmdb_status = 'Canceled' then
    return 'release_changed';
  end if;
  if e.last_observed_at < p_now - v_age or s.last_read_at < p_now - v_age then
    return 'release_stale';
  end if;

  return null;
end;
$$;

comment on function _proactive_season_release_reason(uuid, timestamptz) is
  'Null if a season premiere''s release event can be announced at p_now, else release_changed (not a released normal season, date moved or cleared after release, missing from the series'' latest read, series Canceled) or release_stale (skipped_stale, or event or series read more than proactive.season_max_read_age_hours ago). Internal (20261031000100).';

-- The verified availability date for a season in a market, or null. Valid now, written
-- no later than now, and agreeing with the release event's date.
create or replace function _proactive_season_verified_on(p_event uuid, p_region text, p_now timestamptz)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select v.available_on
    from proactive_season_availability v
    join release_events e on e.id = v.release_event_id
   where v.release_event_id = p_event
     and v.region = p_region
     and v.verified_at <= p_now
     and v.valid_until > p_now
     and v.valid_until <= v.verified_at + interval '48 hours'
     and e.state = 'released'
     and v.available_on = e.released_on
     and v.available_on = e.scheduled_date;
$$;

comment on function _proactive_season_verified_on(uuid, text, timestamptz) is
  'The available_on of a valid operator verification for a season''s release event in a market, at p_now, or null when there is none, it has expired, it postdates p_now, or it disagrees with the release event. Internal (20261031000100).';

-- Whether a season_premiere notification is one the ledger wrote: its candidate is the
-- same recipient's, about the same season, keyed by a season-premiere release event of
-- that season. release_status counts anything else as a leak.
create or replace function _proactive_season_row_authorised(p_notification uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from notifications n
      join proactive_candidates pc
        on pc.notification_id = n.id
       and pc.type = 'season_premiere'
       and pc.recipient_id = n.recipient_id
       and n.subject_type = 'media_item'
       and pc.media_item_id = n.subject_id
      join release_events re
        on re.id::text = pc.dedupe_key
       and re.id::text = pc.metadata ->> 'release_event_id'
       and re.event_kind = 'season_premiere'
       and re.media_item_id = pc.media_item_id
     where n.id = p_notification
       and n.type = 'season_premiere');
$$;

comment on function _proactive_season_row_authorised(uuid) is
  'Whether a season_premiere notification is correctly linked to the ledger: same recipient, same season, keyed by that season''s release event. release_status counts every other season row as unauthorised. Internal (20261031000100).';


-- ---------------------------------------------------------------------------
-- 5. Affinity: who this reader actually talks to (Codex final decision)
--
-- Deterministic, decayed, computed on demand, never stored and never returned to a
-- client. Ids, relationships, states and timestamps only: no comment body, message or
-- note is read. Directional: OUT is the reader towards the friend, IN the friend towards
-- the reader. Only the last 90 days, nothing dated in the future, each event decayed
-- continuously with a 30-day half-life: weight × 2^(-age_days / 30).
--
--   family          events (base weight)                                       cap
--   conversation    a comment on the other's activity 2; a reply to the       6
--                   other's comment 3; an active mention of the other 2.
--                   One comment counts once per pair, at its strongest role.
--   recommendations a delivered recommendation sent 3 (its original            6
--                   created_at; a re-send adds nothing); the recipient's
--                   response, in the reverse direction: opened 1 or fulfilled
--                   3, the stronger only.
--   co_watch        a live watched-with tag 3; a companion on a watch the       6
--                   READER owns 3 (another person's private diary never moves
--                   what this reader is shown). One per pair, title and day.
--   reactions       a reaction to the other's activity or comment 0.25          1
--
-- Each family and direction is capped at 4 a UTC day (reactions 0.5) before the days are
-- summed, so no single repeatable act can dominate. Then OUT + 0.5 × IN, then the family
-- cap. A follow is a weak baseline: 0.25 each way, 0.5 for a mutual follow. Reciprocity
-- adds 2 when, in the last 30 days, each direction has strong (non-reaction)
-- interactions on at least two distinct UTC days. Rounded to thousandths.
--
-- Not used, deliberately: notification opens, invitations, helpful votes, profile visits,
-- how much somebody posts, and any inferred similarity.
-- ---------------------------------------------------------------------------

create or replace function _proactive_affinity(p_reader uuid, p_actor uuid, p_now timestamptz)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  with conversation as (
    select case when c.author_id = p_reader then 'out' else 'in' end as dir,
           greatest(
             case when fe.actor_id = case when c.author_id = p_reader then p_actor else p_reader end
                  then 2 else 0 end,
             case when pc.author_id = case when c.author_id = p_reader then p_actor else p_reader end
                  then 3 else 0 end,
             case when exists (select 1 from comment_mentions cm
                                where cm.comment_id = c.id and cm.active
                                  and cm.mentioned_id = case when c.author_id = p_reader then p_actor else p_reader end)
                  then 2 else 0 end
           )::numeric as w,
           c.created_at as at
      from comments c
      join feed_events fe on fe.id = c.feed_event_id
      left join comments pc on pc.id = c.parent_id and pc.deleted_at is null
     where c.author_id in (p_reader, p_actor)
       and c.deleted_at is null
       and c.created_at > p_now - interval '90 days'
       and c.created_at <= p_now
       -- Activity the reader can no longer view says nothing about this friendship.
       and can_view_profile(p_reader, fe.actor_id)
  ),
  recommendations as (
    select case when r.sender_id = p_reader then 'out' else 'in' end as dir,
           3::numeric as w,
           r.created_at as at
      from title_recommendations r
     where ((r.sender_id = p_reader and r.recipient_id = p_actor)
         or (r.sender_id = p_actor and r.recipient_id = p_reader))
       and r.state = 'delivered'
    union all
    select case when r.recipient_id = p_reader then 'out' else 'in' end,
           case when r.fulfilled_at is not null then 3 else 1 end::numeric,
           coalesce(r.fulfilled_at, r.opened_at)
      from title_recommendations r
     where ((r.sender_id = p_reader and r.recipient_id = p_actor)
         or (r.sender_id = p_actor and r.recipient_id = p_reader))
       and r.state = 'delivered'
       and (r.fulfilled_at is not null or r.opened_at is not null)
  ),
  co_watch_raw as (
    select case when t.tagger_id = p_reader then 'out' else 'in' end as dir,
           t.media_item_id,
           t.created_at as at
      from watch_tags t
     where ((t.tagger_id = p_reader and t.tagged_id = p_actor)
         or (t.tagger_id = p_actor and t.tagged_id = p_reader))
       and not t.removed_by_tagged
       and not coalesce(t.removed_by_tagger, false)
    union all
    select 'out', w.media_item_id, wc.created_at
      from watch_event_companions wc
      join watch_events w on w.id = wc.watch_event_id
     where w.user_id = p_reader
       and wc.companion_id = p_actor
  ),
  co_watch as (
    -- One co-watch per pair, title and UTC day, however many ways it was recorded.
    select case when bool_or(dir = 'out') then 'out' else 'in' end as dir,
           3::numeric as w,
           min(at) as at
      from co_watch_raw
     where at > p_now - interval '90 days' and at <= p_now
     group by media_item_id, (at at time zone 'UTC')::date
  ),
  -- One arm per direction, each filtered on a single indexed column first (reactions_user,
  -- comment_reactions_user), so no arm joins the whole table (Fable re-review, MINOR).
  -- A reaction to a comment counts only while the reader can still view the activity the
  -- comment is on (Codex re-review, MAJOR): definer code gets no help from RLS here.
  reactions_both as (
    select 'out' as dir, 0.25::numeric as w, x.created_at as at
      from reactions x
      join feed_events fe on fe.id = x.feed_event_id
     where x.user_id = p_reader and fe.actor_id = p_actor
    union all
    select 'in', 0.25::numeric, x.created_at
      from reactions x
      join feed_events fe on fe.id = x.feed_event_id
     where x.user_id = p_actor and fe.actor_id = p_reader
    union all
    select 'out', 0.25::numeric, x.created_at
      from comment_reactions x
      join comments c on c.id = x.comment_id and c.deleted_at is null
      join feed_events fe on fe.id = c.feed_event_id
     where x.user_id = p_reader and c.author_id = p_actor
       and can_view_profile(p_reader, fe.actor_id)
    union all
    select 'in', 0.25::numeric, x.created_at
      from comment_reactions x
      join comments c on c.id = x.comment_id and c.deleted_at is null
      join feed_events fe on fe.id = c.feed_event_id
     where x.user_id = p_actor and c.author_id = p_reader
       and can_view_profile(p_reader, fe.actor_id)
  ),
  evidence as (
    select 'conversation' as family, dir, w, at from conversation where w > 0
    union all
    select 'recommendations', dir, w, at from recommendations
    union all
    select 'co_watch', dir, w, at from co_watch
    union all
    select 'reactions', dir, w, at from reactions_both
  ),
  decayed as (
    select family, dir, at,
           (at at time zone 'UTC')::date as day,
           w * power(2::numeric, (-(extract(epoch from (p_now - at)) / 86400.0) / 30.0)::numeric) as v
      from evidence
     where at > p_now - interval '90 days' and at <= p_now
  ),
  daily as (
    select family, dir, day,
           least(sum(v), case when family = 'reactions' then 0.5 else 4 end) as v
      from decayed
     group by family, dir, day
  ),
  families as (
    select family,
           least(coalesce(sum(v) filter (where dir = 'out'), 0)
                 + 0.5 * coalesce(sum(v) filter (where dir = 'in'), 0),
                 case when family = 'reactions' then 1 else 6 end) as v
      from daily
     group by family
  ),
  reciprocity as (
    select count(distinct day) filter (where dir = 'out') >= 2
       and count(distinct day) filter (where dir = 'in') >= 2 as ok
      from decayed
     where family <> 'reactions' and at > p_now - interval '30 days'
  )
  select case when p_reader is null or p_actor is null or p_reader = p_actor then 0::numeric
    else round(
      coalesce((select sum(v) from families), 0)
      + case when exists (select 1 from follows f where f.follower_id = p_reader and f.followee_id = p_actor and f.state = 'approved')
             then 0.25 else 0 end
      + case when exists (select 1 from follows f where f.follower_id = p_actor and f.followee_id = p_reader and f.state = 'approved')
             then 0.25 else 0 end
      + case when (select ok from reciprocity) then 2 else 0 end,
      3)
  end;
$$;

comment on function _proactive_affinity(uuid, uuid, timestamptz) is
  'INTERNAL relationship affinity, reader towards one actor, at p_now (20261031000100): conversation, recommendations, co-watch and reactions over 90 days with a 30-day half-life, per-day and per-family caps, OUT + 0.5 x IN, a follow baseline and a reciprocity bonus. Read-only; never stored, never returned to a client, never in a payload. Orders competing watchlist_social clusters and which friends a social row names. Internal.';

/**
 * The members of a social cluster this reader may be told about (exactly
 * _proactive_social_actors, which stays the visibility and mutual-follow authority), each
 * with its affinity and its place: strongest first, then the earliest to join, then id.
 */
create or replace function _proactive_ranked_social_actors(p_candidate uuid, p_recipient uuid, p_now timestamptz)
returns table (actor_id uuid, username text, display_name text, avatar_path text,
               first_joined timestamptz, affinity numeric, rn bigint)
language sql
stable
security definer
set search_path = public
as $$
  select s.actor_id, s.username, s.display_name, s.avatar_path, s.first_joined, s.affinity,
         row_number() over (order by s.affinity desc, s.first_joined, s.actor_id)
    from (select a.*, _proactive_affinity(p_recipient, a.actor_id, p_now) as affinity
            from _proactive_social_actors(p_candidate, p_recipient) a) s
   order by s.affinity desc, s.first_joined, s.actor_id;
$$;

comment on function _proactive_ranked_social_actors(uuid, uuid, timestamptz) is
  'The visible members of one watchlist_social cluster (_proactive_social_actors), ranked by _proactive_affinity, then first joined, then id. rn is the rank. Internal; the affinity column never leaves the database.';

-- A cluster's strength for the arbiter: the mean affinity of its two strongest visible
-- members. Equal or zero affinity falls back to the old order (eligible_at, then id).
create or replace function _proactive_cluster_affinity(p_candidate uuid, p_recipient uuid, p_now timestamptz)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(avg(r.affinity), 0)
    from (select affinity from _proactive_ranked_social_actors(p_candidate, p_recipient, p_now)
           order by rn limit 2) r;
$$;

comment on function _proactive_cluster_affinity(uuid, uuid, timestamptz) is
  'Mean affinity of a watchlist_social cluster''s two strongest visible members, for the arbiter''s order among competing social candidates. Internal (20261031000100).';


-- ---------------------------------------------------------------------------
-- 6. What is still true, for four types
--
-- Rebuilt from 20261028000100. The three existing types are judged exactly as before.
-- The one structural change: the exact-Watchlist requirement and the watched check are
-- per type now, because a season is wanted through its series or its predecessor
-- (_proactive_season_interest) and is "watched" if the reader has touched that season at
-- all (_proactive_season_touched).
-- ---------------------------------------------------------------------------

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


-- ---------------------------------------------------------------------------
-- 7. The arbiter, rebuilt from 20261028000100
--
-- The LOCK HIERARCHY and the walk are carried across unchanged. Two changes:
--
--   order   1. the live proactive.priority; 2. the canonical type order (season,
--           theatrical, social, resurfacing), so equal configured priorities never let
--           affinity compare unlike types; 3. seasons: a saved series or season before a
--           caught-up-only reader; 4. social: cluster affinity, strongest first;
--           5. eligible_at; 6. id. Still a total order.
--   title   the title cooldown compares _proactive_cooldown_title, so a season and its
--           series are one title.
-- ---------------------------------------------------------------------------

create or replace function _proactive_arbitrate(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start      integer  := _proactive_int('proactive.window_start_hour', 17);
  v_end        integer  := _proactive_int('proactive.window_end_hour', 20);
  v_daily      integer  := _proactive_int('proactive.daily_cap', 1);
  v_weekly     integer  := _proactive_int('proactive.weekly_cap', 2);
  v_type_cd    interval := make_interval(hours => _proactive_int('proactive.type_cooldown_hours', 72));
  v_res_cd     interval := make_interval(days  => _proactive_int('proactive.resurface_cooldown_days', 7));
  v_title_cd   interval := make_interval(days  => _proactive_int('proactive.title_cooldown_days', 7));
  v_push       boolean  := _proactive_push_enabled();
  v_user       uuid;
  v_tz         text;
  v_device     boolean;
  v_capable    boolean;
  v_local      timestamp;
  v_today      date;
  v_in_window  boolean;
  v_day_count  integer;
  v_week_count integer;
  v_picked     boolean;
  c            proactive_candidates%rowtype;
  v_reason     text;
  v_block      text;
  v_note       uuid;
  v_expired    integer := 0;
  v_n          integer;
  v_selected   integer := 0;
  v_suppressed integer := 0;
  v_held       integer := 0;
begin
  -- (1) One arbiter at a time, before anything else (LOCK HIERARCHY above). A second tick
  -- waits here holding nothing, then sees the first one's work.
  perform pg_advisory_xact_lock(hashtextextended('bingd.proactive.arbiter', 0));

  -- Every reader with a pending row that is due or past its expiry, in recipient order.
  for v_user in
    select distinct recipient_id
      from proactive_candidates
     where state = 'pending'
       and (expires_at <= p_now or (eligible_at is not null and eligible_at <= p_now))
     order by recipient_id
  loop
    -- (3) One arbiter per reader, and it excludes a mute of the same reader.
    perform pg_advisory_xact_lock(hashtextextended('bingd.proactive:' || v_user::text, 0));

    -- (4) Every row of this reader that is expired or due, by id, in one statement, before
    -- any of them is touched. Expiry and the walk below then wait on nothing.
    perform 1
       from proactive_candidates
      where recipient_id = v_user and state = 'pending'
        and (expires_at <= p_now or (eligible_at is not null and eligible_at <= p_now))
      order by id
        for update;

    -- 1. Expiry, for this reader only, under its lock.
    update proactive_candidates
       set state              = 'expired',
           suppression_reason = coalesce(last_block_reason, 'expired'),
           decided_at         = p_now
     where recipient_id = v_user and state = 'pending' and expires_at <= p_now;
    get diagnostics v_n = row_count;
    v_expired := v_expired + v_n;

    select ac.timezone into v_tz from account_context ac where ac.user_id = v_user;
    v_device := exists (select 1 from device_tokens d where d.user_id = v_user and d.revoked_at is null);
    -- Per device, not per account: at least one live token from a build that can route
    -- these kinds. The claim then sends to those tokens only (§6).
    v_capable := exists (select 1 from device_tokens d where d.user_id = v_user and _proactive_capable_token(d));
    v_picked := false;
    v_today := null;
    v_in_window := false;
    v_day_count := 0;

    if v_tz is not null then
      v_local     := p_now at time zone v_tz;
      v_today     := v_local::date;
      v_in_window := v_local::time >= make_time(v_start, 0, 0) and v_local::time < make_time(v_end, 0, 0);
      select count(*) into v_day_count
        from proactive_candidates
       where recipient_id = v_user and state in ('selected', 'sent') and selected_local_date = v_today;
    end if;

    select count(*) into v_week_count
      from proactive_candidates
     where recipient_id = v_user and state in ('selected', 'sent') and selected_at > p_now - interval '7 days';

    for c in
      select *
        from proactive_candidates
       where recipient_id = v_user and state = 'pending' and eligible_at is not null and eligible_at <= p_now
         and expires_at > p_now
       -- 20261031000100: the total order of section 7's header. Season interest and
       -- cluster affinity are re-read now, not snapshotted; both are reads.
       order by _proactive_priority(type),
                case type when 'season_premiere'     then 1
                          when 'theatrical_release'  then 2
                          when 'watchlist_social'    then 3
                          when 'watchlist_resurface' then 4
                          else 5 end,
                case when type = 'season_premiere'
                     then case when _proactive_season_interest(recipient_id, (metadata ->> 'release_event_id')::uuid) = 'watchlist'
                               then 0 else 1 end
                     else 0 end,
                case when type = 'watchlist_social'
                     then _proactive_cluster_affinity(id, recipient_id, p_now)
                     else 0 end desc,
                eligible_at, id
         for update
    loop
      v_reason := _proactive_invalid(c.id, p_now);
      if v_reason is not null then
        update proactive_candidates
           set state = 'suppressed', suppression_reason = v_reason, decided_at = p_now, last_block_reason = null
         where id = c.id;
        v_suppressed := v_suppressed + 1;
        continue;
      end if;

      v_block := case
        when not v_push                then 'kill_switch'
        when v_tz is null              then 'no_timezone'
        when not v_device              then 'no_device'
        when not v_capable             then 'client_unsupported'
        when not v_in_window           then 'quiet_window'
        when v_picked                  then 'higher_priority_selected'
        when v_day_count >= v_daily    then 'daily_cap'
        when v_week_count >= v_weekly  then 'weekly_cap'
        when exists (select 1 from proactive_candidates p
                      where p.recipient_id = v_user and p.type = c.type
                        and p.state in ('selected', 'sent')
                        and p.selected_at > p_now - case when c.type = 'watchlist_resurface'
                                                         then v_res_cd else v_type_cd end)
                                       then 'type_cooldown'
        when exists (select 1 from proactive_candidates p
                      where p.recipient_id = v_user
                        -- 20261031000100: a season and its series are one title.
                        and _proactive_cooldown_title(p.media_item_id) = _proactive_cooldown_title(c.media_item_id)
                        and p.state in ('selected', 'sent')
                        and p.selected_at > p_now - v_title_cd)
                                       then 'title_cooldown'
      end;

      if v_block is not null then
        update proactive_candidates set last_block_reason = v_block where id = c.id;
        v_held := v_held + 1;
        continue;
      end if;

      -- A resurfacing has no inbox row: it gets a hidden one now, because push_outbox is
      -- keyed on a notification and that is what makes a fabricated push unrepresentable.
      v_note := c.notification_id;
      if v_note is null then
        insert into notifications (recipient_id, type, subject_type, subject_id, payload)
        values (v_user, c.type, 'media_item', c.media_item_id, jsonb_build_object('candidate_id', c.id))
        returning id into v_note;
        -- The preference gate can still drop it, in the instant since _proactive_invalid.
        if v_note is null then
          update proactive_candidates
             set state = 'suppressed', suppression_reason = 'preference_off', decided_at = p_now
           where id = c.id;
          v_suppressed := v_suppressed + 1;
          continue;
        end if;
      end if;

      insert into push_outbox (notification_id, recipient_id)
      values (v_note, v_user)
      on conflict (notification_id) do nothing;

      update proactive_candidates
         set state               = 'selected',
             notification_id     = v_note,
             selected_at         = p_now,
             selected_local_date = v_today,
             last_block_reason   = null
       where id = c.id;

      v_picked := true;
      v_day_count := v_day_count + 1;
      v_week_count := v_week_count + 1;
      v_selected := v_selected + 1;
    end loop;
  end loop;

  return jsonb_build_object('expired', v_expired, 'selected', v_selected,
                            'suppressed', v_suppressed, 'held', v_held,
                            'push_enabled', v_push);
end;
$$;

comment on function _proactive_arbitrate(timestamptz) is
  'The central proactive budget (20261028000100). Under one global arbiter lock, then per recipient under that recipient''s advisory lock and with their expired and due rows locked in id order first: expires that recipient''s untimely candidates, then revalidates each due candidate (suppressing what is no longer true), holds what the kill switch, timezone, client version, device, the 17:00-20:00 local window, the daily cap (1 per local day), weekly cap (2 per rolling 7 days), type cooldown (72h; 7 days for resurfacing) or 7-day title cooldown forbid, and selects the single best remaining one, enqueuing its notification. Since 20261031000100 the order is proactive.priority, then the canonical type order (season, theatrical, social, resurfacing), then for seasons a saved series or season first, for social clusters the higher _proactive_cluster_affinity first, then eligible_at, then id; and the title cooldown counts a season as its series (_proactive_cooldown_title). Losers are not queued. Internal; scheduled through _proactive_tick.';


-- ---------------------------------------------------------------------------
-- 8. Season premiere, collected
--
-- Inside _proactive_tick only, after the global lock: inserts new candidates (on conflict
-- do nothing, so a repeat, a refresh or a renewed verification never makes a second), and
-- updates only the row it has just inserted. Reads release events; locks none.
--
--   which events  a released normal season (season_number > 0), confirmed in the last
--                 proactive.season_collect_hours (48) by released_observed_at, not
--                 skipped_stale, passing _proactive_season_release_reason, with a valid US
--                 verification. Never `scheduled` with a date that has arrived.
--   which readers active, Watchlist & discovery on, _proactive_season_interest not null,
--                 not touching the season, region US or unknown (anywhere else: nothing).
--   once          dedupe key = the release event: one per reader per season release, ever.
--                 Parts and weekly episodes are not events.
--   when          nothing, not even the inbox row, until the available date has begun in
--                 BOTH the reader's zone and America/Los_Angeles; then eligible at once,
--                 inside the usual 17:00-20:00 local window.
--   until         the earliest of the confirmation + 48 hours, the midnight that ends the
--                 reader's second local release day, and the verification's valid_until.
--                 Never extended by a later collection.
--   unknown region  the inbox row (which says "in the US"), and the candidate suppressed
--                 region_unknown: no push, as for a film.
-- ---------------------------------------------------------------------------

create or replace function _proactive_season_collect(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  e        record;
  r        record;
  c        proactive_candidates%rowtype;
  v_note   uuid;
  v_made   integer := 0;
  v_avail  date;
  v_until  timestamptz;
  v_prior  uuid;
  v_window interval := make_interval(hours => _proactive_int('proactive.season_collect_hours', 48));
begin
  if not _proactive_season_enabled() then
    return 0;
  end if;

  for e in
    select ev.*
      from release_events ev
     where ev.event_kind = 'season_premiere'
       and ev.state = 'released'
       and ev.season_number > 0
       and ev.evaluation in ('pending', 'done')
       and ev.released_observed_at > p_now - v_window
       and ev.released_observed_at <= p_now
     order by ev.released_on, ev.id
  loop
    if _proactive_season_release_reason(e.id, p_now) is not null then
      continue;
    end if;
    v_avail := _proactive_season_verified_on(e.id, 'US', p_now);
    if v_avail is null then
      continue;
    end if;
    select valid_until into v_until
      from proactive_season_availability where release_event_id = e.id and region = 'US';

    -- The immediately preceding normal season, numbered from the latest observation; null
    -- when it is unknown or not in the catalogue (Codex re-review, MAJOR).
    v_prior := _proactive_season_prior(e.id);

    for r in
      select q.*
        from (
          select i.user_id, ac.region, ac.timezone,
                 _proactive_season_interest(i.user_id, e.id) as interest
            from (
              select w.user_id from watchlist w where w.media_item_id in (e.media_item_id, e.subject_id)
              union
              select rk.user_id from rankings rk where v_prior is not null and rk.media_item_id = v_prior
              union
              select um.user_id from user_media um
               where v_prior is not null and um.media_item_id = v_prior
                 and (um.bucket is not null or um.watched_on is not null or um.progress = 'completed')
            ) i
            join profiles p on p.id = i.user_id and p.status = 'active'
            left join account_context ac on ac.user_id = i.user_id
           where (ac.region is null or ac.region = 'US')
             -- NOTHING BEFORE THE DAY (Codex re-review, MAJOR). The release state machine
             -- counts a date as reached from the earliest zone's midnight, 14 hours before
             -- UTC's, so a season can be `released` while it is still the day before in the
             -- US. Neither the candidate nor the inbox row is written until the date has
             -- begun in BOTH Los Angeles and the reader's own zone (UTC when unknown); a
             -- later tick collects them, inside the same 48 hours, under the same dedupe.
             and p_now >= v_avail::timestamp at time zone 'America/Los_Angeles'
             and p_now >= v_avail::timestamp at time zone coalesce(ac.timezone, 'UTC')
             and not _proactive_season_touched(i.user_id, e.media_item_id)
             -- Muted means untouched, as for a film: nothing is recorded, so turning the
             -- preference back on inside the two days still lets this release reach them once.
             and _notifies(i.user_id, 'watchlist_discovery')
        ) q
       where q.interest is not null
       order by q.user_id
    loop
      c := null;
      insert into proactive_candidates (
        recipient_id, type, dedupe_key, media_item_id, priority, state, metadata,
        created_at, eligible_at, expires_at
      ) values (
        r.user_id, 'season_premiere', e.id::text, e.media_item_id,
        _proactive_priority('season_premiere'), 'pending',
        jsonb_build_object('release_event_id', e.id, 'available_on', v_avail, 'region', 'US',
                           'season_number', e.season_number, 'interest', r.interest),
        -- Eligible now: the date has begun in both zones (the reader filter above).
        p_now, p_now,
        least(e.released_observed_at + v_window,
              (v_avail + 2)::timestamp at time zone coalesce(r.timezone, 'UTC'),
              v_until)
      )
      on conflict (recipient_id, type, dedupe_key) do nothing
      returning * into c;

      -- Somebody already decided this reader and this season. Once, ever.
      if c.id is null then
        continue;
      end if;
      v_made := v_made + 1;

      insert into notifications (recipient_id, type, subject_type, subject_id, payload, created_at)
      values (r.user_id, 'season_premiere', 'media_item', e.media_item_id,
              jsonb_build_object('candidate_id', c.id, 'available_on', v_avail, 'region', 'US',
                                 'season_number', e.season_number),
              p_now)
      returning id into v_note;

      update proactive_candidates
         set notification_id    = v_note,
             state              = case when r.region is null then 'suppressed' else 'pending' end,
             suppression_reason = case when r.region is null then 'region_unknown' end,
             decided_at         = case when r.region is null then p_now end
       where id = c.id;
    end loop;
  end loop;

  return v_made;
end;
$$;

comment on function _proactive_season_collect(timestamptz) is
  'Turns season premieres released (confirmed) in the last proactive.season_collect_hours, read within proactive.season_max_read_age_hours and verified available in the US by an operator into one season_premiere inbox row and candidate per active reader with a saved series or season or a watch of the season before, in the US or of unknown region, once ever per (reader, release). Nothing at all while proactive.season_enabled is not exactly true. Unknown region keeps the inbox row and suppresses the push. Internal (20261031000100).';


-- ---------------------------------------------------------------------------
-- 9. The social writer enforces one qualifying event per transaction
--
-- Rebuilt from 20261028000200 with one guard (Fable final review MINOR 1; Codex final
-- decision). The writer's freedom from lock cycles with the arbiter rests on each
-- qualifying transaction visiting readers once, in ascending order, holding one row per
-- reader. Every writer is one event per transaction today (_rank_finalize, log_rewatch).
-- A future writer that inserts two (a batch log, a repair) would visit readers twice, in
-- a second order. So the first qualifying event of a transaction is recorded in the
-- transaction-local setting bingd.proactive.social_event_id, and any later one is skipped
-- with a warning carrying a fixed reason code. The write it rides on still succeeds.
-- ---------------------------------------------------------------------------

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

-- Operator bulk mutes (Fable final review MINOR 2): _proactive_social_on_mute fires per
-- row in physical order, so a statement that switches watchlist_discovery off for many
-- readers at once could take reader locks out of order. One reader per transaction; see
-- push-operations.md §12. An ORDER BY in the update's input does not order its triggers.


-- ---------------------------------------------------------------------------
-- 10. Resurfacing's 30-day exclusion counts a season as its series
--
-- Rebuilt from 20261028000200. One change: the exclusion compares
-- _proactive_cooldown_title, so a season pushed this month keeps its series (and the
-- series its seasons) out of resurfacing too.
-- ---------------------------------------------------------------------------

create or replace function _proactive_resurface_pick(p_user uuid, p_now timestamptz)
returns table (media_item_id uuid, reason text, score integer, friends integer)
language sql
stable
security definer
set search_path = public
as $$
  -- Defensive (Fable review, MINOR): the cache is written by a scheduled job outside this
  -- file, and one malformed entry must not abort the whole proactive tick. A payload whose
  -- `ids` is not an array reads as empty, and an element that is not a uuid is skipped
  -- before the cast rather than raising on it.
  with trending as (
    select e.id::uuid as id
      from provider_list_cache l
     cross join lateral jsonb_array_elements_text(
             case when jsonb_typeof(l.payload -> 'ids') = 'array' then l.payload -> 'ids'
                  else '[]'::jsonb end) as e(id)
     where l.list_key in ('trending.movie.week', 'trending.series.week')
       and l.fetched_at > p_now - interval '168 hours'
       and e.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  eligible as (
    select w.media_item_id, w.created_at as saved_at, m.release_date, m.parent_id
      from watchlist w
      join media_items m on m.id = w.media_item_id
     where w.user_id = p_user
       and (m.release_date is null or m.release_date <= (p_now at time zone 'UTC')::date)
       and not _proactive_title_watched(p_user, w.media_item_id)
       and not exists (
         select 1 from proactive_candidates c
          where c.recipient_id = p_user
            -- 20261031000100: a season and its series are one title here too.
            and _proactive_cooldown_title(c.media_item_id) = _proactive_cooldown_title(w.media_item_id)
            and c.state in ('selected', 'sent')
            and c.selected_at > p_now - interval '30 days')
  ),
  signals as (
    select e.*,
           (select count(distinct fe.actor_id)::integer
              from feed_events fe
             where fe.media_item_id = e.media_item_id
               and fe.type in ('title_ranked', 'title_logged')
               and fe.created_at > p_now - interval '30 days'
               and fe.actor_id <> p_user
               and exists (select 1 from follows f where f.follower_id = p_user and f.followee_id = fe.actor_id and f.state = 'approved')
               and exists (select 1 from follows f where f.follower_id = fe.actor_id and f.followee_id = p_user and f.state = 'approved')
               and can_view_profile(p_user, fe.actor_id))                                  as friends,
           exists (select 1 from trending t where t.id in (e.media_item_id, e.parent_id))   as trending,
           coalesce(e.release_date >= (p_now at time zone 'UTC')::date - 60, false)         as recent,
           exists (select 1 from proactive_candidates c
                    where c.recipient_id = p_user and c.media_item_id = e.media_item_id
                      and c.type = 'watchlist_resurface' and c.state in ('selected', 'sent')) as resurfaced_before
      from eligible e
  )
  select s.media_item_id,
         case when s.friends > 0 then 'friends'
              when s.trending then 'trending'
              when s.recent then 'recent'
              else 'saved' end,
         (least(s.friends, 3) * 3
          + case when s.trending then 2 else 0 end
          + case when s.recent then 2 else 0 end
          + least(floor(extract(epoch from (p_now - s.saved_at)) / 86400 / 30)::integer, 3)
          - case when s.resurfaced_before then 2 else 0 end)::integer,
         s.friends
    from signals s
   order by 3 desc, s.saved_at asc, s.media_item_id
   limit 1;
$$;


-- ---------------------------------------------------------------------------
-- 11. The tick collects seasons
-- ---------------------------------------------------------------------------

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


-- ---------------------------------------------------------------------------
-- 12. The claim, rebuilt from 20261028000100
--
-- Carried across whole. Two changes, both in the job's `proactive` facts:
--
--   names     a social push names the two strongest visible friends
--             (_proactive_ranked_social_actors), not the two earliest; the count is still
--             everybody visible.
--   season    season_number and available_on, for the copy. A season job is judged like
--             every proactive job (_proactive_claim_reason → _proactive_invalid), so the
--             season switch, the verification and the reader's interest are rechecked at
--             the claim's clock.
-- ---------------------------------------------------------------------------

create or replace function claim_push_batch(p_limit integer default 20, p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed uuid[];
  v_jobs    jsonb;
  v_dead    uuid[];
  v_pro_dead uuid[];
  v_sent    uuid[];
  v_mine    uuid[];
  v_busy    uuid[];
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

  -- 20261028000100. LOCK FIRST, THEN JUDGE, AND NEVER WAIT (Codex final reviews, MAJOR).
  --
  -- Every proactive candidate behind this batch is locked before anything about it is
  -- checked, and stays locked until it is marked sent at the end of this transaction, so
  -- nothing (a mute, a social writer) can change it between the checks and the send.
  --
  -- SKIP LOCKED, so the claim never waits on a candidate row. A candidate another
  -- transaction owns at this moment (a mute suppressing it, a friend joining its cluster)
  -- is not judged, not sent and not charged: its job is put back in the queue exactly as
  -- it was before this claim (pending, no lease, the attempt given back), and the next
  -- drain judges it afresh with every check, dropping it if it was muted, suppressed or
  -- expired meanwhile. A claim that waits could close a lock cycle with a writer that
  -- holds rows of several readers; one that skips cannot be in any cycle. Optional
  -- delivery prefers late or missed over blocked, deadlocked or duplicated.
  --
  -- THIS DEPENDS ON claim_push_batch STAYING VOLATILE (the default; do not mark it stable
  -- or immutable). Under READ COMMITTED a volatile function takes a fresh snapshot for
  -- each statement, so the checks below read the very row version this statement locked,
  -- including a change committed an instant before. A stable function shares one snapshot
  -- across its whole body and could judge an older version than the one it holds.
  select coalesce(array_agg(s.notification_id), '{}'::uuid[]) into v_mine
    from (
      select pc.notification_id
        from proactive_candidates pc
       where pc.notification_id = any (v_claimed)
       order by pc.id
         for update skip locked
    ) s;

  select coalesce(array_agg(pc.notification_id), '{}'::uuid[]) into v_busy
    from proactive_candidates pc
   where pc.notification_id = any (v_claimed)
     and not (pc.notification_id = any (v_mine));

  if array_length(v_busy, 1) is not null then
    -- Back to a clean, claimable state, as if this claim had never taken it.
    update push_outbox o
       set state      = 'pending',
           claimed_at = null,
           attempts   = greatest(o.attempts - 1, 0)
     where o.notification_id = any (v_busy);
    v_claimed := array(select unnest(v_claimed) except select unnest(v_busy));
    if array_length(v_claimed, 1) is null then
      return jsonb_build_array();
    end if;
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

  -- 20261028000100 (a). The proactive jobs that must not go, and the candidate told why.
  -- At most once: a job whose candidate is already `sent` (an expired lease, a retry) is
  -- dropped and its outbox row deleted below; the candidate stays `sent`. Reactive jobs
  -- are not in this set and keep their at-least-once retries unchanged.
  with pro as (
    select pc.id, pc.notification_id, pc.state,
           _proactive_claim_reason(pc.id, p_now) as reason
      from proactive_candidates pc
     where pc.notification_id = any (v_claimed)
  ),
  settled as (
    update proactive_candidates pc
       set state              = case when pro.reason in ('expired', 'outside_window', 'no_timezone')
                                     then 'expired' else 'suppressed' end,
           suppression_reason = pro.reason,
           decided_at         = p_now
      from pro
     where pc.id = pro.id and pro.reason is not null and pc.state = 'selected'
    returning pc.id
  )
  select coalesce(array_agg(pro.notification_id) filter (where pro.reason is not null), '{}'::uuid[])
    into v_pro_dead
    from pro;

  v_dead := v_dead || v_pro_dead;

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
        -- 20260920000200. Which award and tier an award_earned push is about, and the
        -- names its row was written with. Null for every other type. Not `award_name`:
        -- see the header.
        'award_key',        j.award_key,
        'award_tier',       j.award_tier,
        'award_family',     j.award_family,
        'award_tier_label', j.award_tier_label,
        -- 20261028000100. goal_completed's year, medium and target. Null otherwise.
        'goal',            j.goal,
        -- 20261028000100. A proactive job's copy facts, resolved now. Null otherwise.
        'proactive',       j.proactive,
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
           -- award_earned only (20260920000200). The keys the celebration route takes and
           -- the push copy is looked up by; the names are the fallback for a key the
           -- sender does not know.
           case when n.type = 'award_earned' then n.payload ->> 'award' end      as award_key,
           case when n.type = 'award_earned' then n.payload ->> 'tier' end       as award_tier,
           case when n.type = 'award_earned' then n.payload ->> 'award_name' end as award_family,
           case when n.type = 'award_earned' then n.payload ->> 'tier_label' end as award_tier_label,
           -- goal_completed only (20261028000100).
           case when n.type = 'goal_completed' then jsonb_build_object(
             'year',     n.payload -> 'year',
             'category', n.payload ->> 'category',
             'target',   n.payload -> 'target'
           ) end                                   as goal,
           -- Proactive only (20261028000100). Ids, dates and display names: nothing
           -- anybody wrote.
           case when pc.id is not null then jsonb_build_object(
             'type',        pc.type,
             'opens_on',    pc.metadata ->> 'opens_on',
             'local_today', (p_now at time zone coalesce(ac.timezone, 'UTC'))::date,
             -- The last instant this push may reach a phone (Codex re-review, MAJOR): the
             -- earlier of the candidate's own expiry and the close of the evening it was
             -- selected for, in the reader's zone. push-sender sends it to Expo as the
             -- message's `expiration`, so a phone that is offline at 19:59 is not woken
             -- by it the next morning, and drops the message itself if it is already past.
             'deliver_by',  least(
                              pc.expires_at,
                              (pc.selected_local_date
                                 + make_time(_proactive_int('proactive.window_end_hour', 20), 0, 0))
                                at time zone coalesce(ac.timezone, 'UTC')),
             'reason',      pc.metadata ->> 'reason',
             'actor_count', case when pc.type = 'watchlist_social'
                              then (select count(*) from _proactive_social_actors(pc.id, n.recipient_id)) end,
             -- 20261031000100: the two STRONGEST visible friends by affinity, then the
             -- earliest. Names only; the affinity itself never leaves the database.
             'actor_names', case when pc.type = 'watchlist_social' then (
                              select jsonb_agg(coalesce(nullif(s.display_name, ''), s.username)
                                               order by s.rn)
                                from (select * from _proactive_ranked_social_actors(pc.id, n.recipient_id, p_now)
                                       order by rn limit 2) s
                            ) end,
             -- 20261031000100, season_premiere only: which season, and the verified date.
             'season_number', case when pc.type = 'season_premiere'
                                then (pc.metadata ->> 'season_number')::integer end,
             'available_on',  case when pc.type = 'season_premiere'
                                then pc.metadata ->> 'available_on' end
           ) end                                   as proactive,
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
                -- 20261028000100 (b). A proactive job goes only to devices whose build can
                -- route it; a reactive job, as always, to every live device.
                and (pc.id is null or _proactive_capable_token(d))
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
      left join proactive_candidates pc
             on pc.notification_id = n.id
      left join account_context ac
             on ac.user_id = n.recipient_id
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

  -- 20261028000100 (c). Handed to push-sender. Not Expo acceptance, not delivery.
  with sent as (
    update proactive_candidates pc
       set state               = 'sent',
           sent_at             = now(),
           actor_count_at_send = (job -> 'proactive' ->> 'actor_count')::integer
      from jsonb_array_elements(v_jobs) as job
     where pc.notification_id = (job ->> 'notification_id')::uuid
       and pc.state = 'selected'
    returning pc.notification_id
  )
  select coalesce(array_agg(notification_id), '{}'::uuid[]) into v_sent from sent;

  -- A proactive job goes out ONLY if its candidate went selected -> sent in this claim.
  -- Under the lock above that is every proactive job that passed the checks; this is the
  -- guarantee written down rather than inferred, so no future path can return a proactive
  -- job whose ledger row does not say it was sent (and so counted against the caps).
  -- Reactive jobs carry no proactive facts and are untouched.
  select coalesce(jsonb_agg(job order by ord), jsonb_build_array())
    into v_jobs
    from jsonb_array_elements(v_jobs) with ordinality as e(job, ord)
   where jsonb_typeof(job -> 'proactive') is distinct from 'object'
      or (job ->> 'notification_id')::uuid = any (v_sent);

  -- Everything claimed and not returned leaves the queue, including a proactive job the
  -- line above withheld, so it cannot be claimed again and leak later.
  delete from push_outbox o
   where o.notification_id = any (v_claimed)
     and o.notification_id not in (
       select (job ->> 'notification_id')::uuid from jsonb_array_elements(v_jobs) as job
     );

  return v_jobs;
end;
$$;

-- The 20261028000100 description, carried and extended rather than retyped.
do $$
begin
  execute format('comment on function claim_push_batch(integer, timestamptz) is %L',
    obj_description('claim_push_batch(integer, timestamptz)'::regprocedure, 'pg_proc')
    || ' Since 20261031000100: a social job names the two strongest visible friends by _proactive_affinity (_proactive_ranked_social_actors), and a season_premiere job carries proactive.season_number and proactive.available_on; season jobs are rechecked like every proactive job, including the season switch and the operator verification.');
end;
$$;


-- ---------------------------------------------------------------------------
-- 13. The inbox, rebuilt from 20261028000100
--
-- Carried across whole. Changes:
--
--   cluster_actors   ordered by affinity (_proactive_ranked_social_actors); the count is
--                    still everybody visible.
--   season_premiere  payload.available_on from the verification as it is now. A row
--                    whose verification was removed, or whose release date moved or was
--                    retracted (no longer equal to the verified date), is not drawn. A
--                    verification that merely expired keeps the row: it states a dated
--                    fact, and expiry only stops future delivery.
-- ---------------------------------------------------------------------------

create or replace function my_notifications(p_limit integer default 50)
returns table (
  id                 uuid,
  kind               text,
  created_at         timestamptz,
  read_at            timestamptz,
  actor_id           uuid,
  actor_username     text,
  actor_display_name text,
  actor_avatar_path  text,
  subject_type       text,
  subject_id         uuid,
  media_item_id      uuid,
  media_kind         media_kind,
  media_title        text,
  series_title       text,
  payload            jsonb,
  -- One line of what was written, or null. See the header for the three
  -- conditions and for why the server rather than the client withholds it.
  comment_excerpt    text,
  -- True when the live comment this row is about is spoiler-marked. The reason
  -- there is no excerpt, said out loud, so the row can draw "Contains spoilers"
  -- rather than an empty second line that reads as a rendering bug.
  comment_spoilers   boolean,
  -- `watch_tag` only: whether this reader has already ranked the title. Decides
  -- whether the row offers Rank, and goes true on the next refetch after they do.
  viewer_ranked      boolean,
  -- The subject feed event's own type, for the row's sentence (20260901000100).
  subject_activity_type text,
  -- watchlist_social only (20261028000100): up to three members, as
  -- [{username, display_name, avatar_path}], and how many there are in all. Strongest
  -- first by affinity, then earliest, since 20261031000100.
  cluster_actors     jsonb,
  cluster_count      integer
)
language sql stable security definer
set search_path = public
as $$
  select n.id,
         n.type,
         n.created_at,
         n.read_at,
         n.actor_id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         n.subject_type,
         n.subject_id,
         m.id,
         m.kind,
         m.title,
         parent.title,
         -- A theatrical row states the release's date as it stands NOW, not the date it
         -- was written with (Codex re-review): see the filter below.
         case when n.type = 'theatrical_release'
              then n.payload || jsonb_build_object('opens_on', rel.opens_on)
              -- 20261031000100. A season row states the verified date as it is now.
              when n.type = 'season_premiere'
              then n.payload || jsonb_build_object('available_on', sea.available_on)
              else n.payload end,
         case
           when n.type in ('comment', 'mention') then (
             select left(c.body, 140)
               from comments c
              where c.id = (n.payload ->> 'comment_id')::uuid
                and c.deleted_at is null
                and not c.has_spoilers
                and can_view_profile(auth.uid(), c.author_id)
           )
         end,
         coalesce(
           case
             when n.type in ('comment', 'mention') then (
               select c.has_spoilers
                 from comments c
                where c.id = (n.payload ->> 'comment_id')::uuid
                  and c.deleted_at is null
                  and can_view_profile(auth.uid(), c.author_id)
             )
           end,
           false
         ),
         case
           when n.type = 'watch_tag' then exists (
             select 1 from rankings r
              where r.user_id = auth.uid()
                and r.media_item_id = case
                                        when n.subject_type = 'media_item' then n.subject_id
                                        else null
                                      end
           )
           else false
         end,
         fe.type,
         cl.actors,
         cl.n
    from notifications n
    left join profiles p
           on p.id = n.actor_id
          and p.status = 'active'
    /**
     * Whose feed event this type means, as three rules rather than one. See
     * 20260901000100 for the full reasoning; carried across unchanged.
     */
    left join feed_events fe
           on n.subject_type = 'feed_event'
          and fe.id = n.subject_id
          and case
                when n.type = 'recommendation_ranked' then fe.actor_id = n.actor_id
                when n.type = 'mention' then can_view_profile(auth.uid(), fe.actor_id)
                else fe.actor_id = auth.uid()
              end
    left join media_items m
           on m.id = case
                       when n.subject_type = 'media_item' then n.subject_id
                       else fe.media_item_id
                     end
    left join media_items parent
           on parent.id = m.parent_id
    left join proactive_candidates pc
           on n.type in ('watchlist_social', 'theatrical_release', 'season_premiere')
          and pc.notification_id = n.id
    /**
     * theatrical_release: the date the release event holds now. A film still scheduled
     * opens on its current scheduled date; one that has opened, on the day it did. One
     * that was withdrawn, lost its date, or is gone has none, and its row is not drawn
     * (Codex re-review): a postponed film must not keep saying the old date, and a
     * cancelled one must not keep saying it opens at all. Read-time, so it is true
     * whenever the inbox is read, before or after the push, with one row throughout.
     */
    left join lateral (
      select case
               when re.state = 'scheduled' then re.scheduled_date
               when re.state = 'released'  then coalesce(re.released_on, re.scheduled_date)
             end as opens_on
        from release_events re
       where re.id = (pc.metadata ->> 'release_event_id')::uuid
    ) rel on pc.type = 'theatrical_release'
    /**
     * season_premiere (20261031000100): the verified date, while the verification row
     * still exists and still agrees with a release event that is still released on that
     * date. Removed, moved or retracted: no date, and the row is not drawn. Expiry of the
     * verification does not hide it (it is a dated fact); it only stops delivery.
     */
    left join lateral (
      select v.available_on
        from release_events re
        join proactive_season_availability v
          on v.release_event_id = re.id
         and v.region = coalesce(pc.metadata ->> 'region', 'US')
       where re.id = (pc.metadata ->> 'release_event_id')::uuid
         and re.state = 'released'
         and re.scheduled_date = re.released_on
         and v.available_on = re.released_on
    ) sea on pc.type = 'season_premiere'
    left join lateral (
      select count(*)::integer as n,
             jsonb_agg(jsonb_build_object('username', s.username,
                                          'display_name', s.display_name,
                                          'avatar_path', s.avatar_path)
                       order by s.rn) filter (where s.rn <= 3) as actors
        from _proactive_ranked_social_actors(pc.id, auth.uid(), now()) s
    ) cl on pc.type = 'watchlist_social'
   where n.recipient_id = auth.uid()
     and (n.actor_id is null
          or (p.id is not null and can_discover_profile(auth.uid(), n.actor_id)))
     -- 20261028000100. The push-only type's carrier row is never part of the inbox.
     and n.type <> 'watchlist_resurface'
     -- And a social row nobody is left in says nothing true.
     and (n.type <> 'watchlist_social' or coalesce(cl.n, 0) > 0)
     -- And a theatrical row whose release no longer has a date says nothing true.
     and (n.type <> 'theatrical_release' or rel.opens_on is not null)
     -- And a season row whose availability is no longer on record says nothing true.
     and (n.type <> 'season_premiere' or sea.available_on is not null)
   order by n.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

do $$
begin
  execute format('comment on function my_notifications(integer) is %L',
    obj_description('my_notifications(integer)'::regprocedure, 'pg_proc')
    || ' Since 20261031000100: cluster_actors are ordered by _proactive_affinity (strongest first, never returned), and a season_premiere row carries payload.available_on from its operator verification as it is now, and is not drawn once that verification is removed or no longer agrees with a released event on that date.');
end;
$$;


-- ---------------------------------------------------------------------------
-- 14. Release status: an unauthorised season row is the leak, not every season row
--
-- Rebuilt from 20261028000100. A season_premiere notification or outbox row is a problem
-- only when no season_premiere ledger row links to it: authorised history is not a leak
-- just because the season switch is later turned off.
-- ---------------------------------------------------------------------------

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

  -- 20261031000100: UNAUTHORISED season premieres only. A season row is delivered through
  -- the proactive ledger now; one that no season_premiere candidate links to is the leak.
  -- Authorised history stays healthy when the season switch is later turned off.
  -- Authorised means CORRECTLY linked (Codex re-review, MINOR): the candidate is the same
  -- recipient's, about the same season, keyed by a season-premiere release event of that
  -- season; and a queued push is to that same recipient.
  select count(*) into v_sent
    from notifications n
   where n.type = 'season_premiere'
     and not _proactive_season_row_authorised(n.id);
  select count(*) into v_outbox
    from push_outbox o join notifications n on n.id = o.notification_id
   where n.type = 'season_premiere'
     and (not _proactive_season_row_authorised(n.id) or o.recipient_id is distinct from n.recipient_id);

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
                               'cap_applied', false,
                               'theatrical_delivery', 'proactive_ledger',
                               'season_delivery', 'proactive_ledger'),
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
  'One call that says whether release awareness is healthy: jobs, transport, subjects read on time, evaluation keeping up, the shadow ledger''s outcomes, and how many UNAUTHORISED season premiere notifications and outbox rows exist (no season_premiere ledger row links to them; must be zero). Theatrical releases (20261028000100) and season premieres (20261031000100) are delivered through the proactive ledger and are reported by proactive_status(). service_role only.';


-- ---------------------------------------------------------------------------
-- 15. Proactive status reports the season switch
-- ---------------------------------------------------------------------------

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


-- ---------------------------------------------------------------------------
-- 16. The refresh keeps watching a released season for two days
--
-- Rebuilt from 20260930000300. One branch: while proactive.season_enabled is on, a series
-- with a season released in the last proactive.season_collect_hours stays on the six-hour
-- cadence, so a date moved or a season withdrawn after release is seen inside the window
-- the candidate can still be sent in. The released state is terminal, so without this the
-- cadence falls back to days the moment the release is confirmed.
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

  -- 20261031000100. A season released in the last two days, while season delivery is on:
  -- still six-hourly, so a move or a withdrawal is seen while its candidate can be sent.
  if _proactive_season_enabled() and exists (
    select 1 from release_events
     where subject_id = p_subject
       and event_kind = 'season_premiere'
       and state = 'released'
       and released_observed_at > p_now - make_interval(hours => _proactive_int('proactive.season_collect_hours', 48))
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
-- 17. The season shadow observes the preference that now governs seasons
--
-- Rebuilt from 20260930000300. One change in each branch: the preference recorded is
-- watchlist_discovery (the category every proactive type uses since 20261028000100),
-- not the never-created new_seasons / watchlist_releases. Historical shadow rows are not
-- rewritten. The shadow still writes no notification; it stays a counterfactual beside
-- the real delivery path, which is _proactive_season_collect.
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
             _notifies(i.user_id, 'watchlist_discovery')                                                     as pref
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
             _notifies(w.user_id, 'watchlist_discovery')                                          as pref
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


-- ---------------------------------------------------------------------------
-- 18. Grants
-- ---------------------------------------------------------------------------

revoke execute on function _proactive_season_enabled()                                from public, anon, authenticated;
revoke execute on function _proactive_capable_token(device_tokens)                     from public, anon, authenticated;
revoke execute on function _notification_default(text)                                 from public, anon, authenticated;
revoke execute on function _apply_notification_preference()                            from public, anon, authenticated;
revoke execute on function _proactive_reasons()                                        from public, anon, authenticated;
revoke execute on function _proactive_cooldown_title(uuid)                             from public, anon, authenticated;
revoke execute on function _proactive_season_touched(uuid, uuid)                       from public, anon, authenticated;
revoke execute on function _proactive_season_interest(uuid, uuid)                      from public, anon, authenticated;
revoke execute on function _proactive_season_release_reason(uuid, timestamptz)         from public, anon, authenticated;
revoke execute on function _proactive_season_verified_on(uuid, text, timestamptz)      from public, anon, authenticated;
revoke execute on function _proactive_season_prior(uuid)                               from public, anon, authenticated;
revoke execute on function _proactive_season_row_authorised(uuid)                      from public, anon, authenticated;
revoke execute on function _proactive_affinity(uuid, uuid, timestamptz)                from public, anon, authenticated;
revoke execute on function _proactive_ranked_social_actors(uuid, uuid, timestamptz)    from public, anon, authenticated;
revoke execute on function _proactive_cluster_affinity(uuid, uuid, timestamptz)        from public, anon, authenticated;
revoke execute on function _proactive_invalid(uuid, timestamptz)                       from public, anon, authenticated;
revoke execute on function _proactive_arbitrate(timestamptz)                           from public, anon, authenticated;
revoke execute on function _proactive_season_collect(timestamptz)                      from public, anon, authenticated;
revoke execute on function _proactive_social_on_activity()                             from public, anon, authenticated;
revoke execute on function _proactive_resurface_pick(uuid, timestamptz)                from public, anon, authenticated;
revoke execute on function _proactive_tick(timestamptz)                                from public, anon, authenticated;
revoke execute on function claim_push_batch(integer, timestamptz)                      from public, anon, authenticated;
revoke execute on function release_status()                                            from public, anon, authenticated;
revoke execute on function proactive_status()                                          from public, anon, authenticated;
revoke execute on function _release_next_check(uuid, timestamptz)                      from public, anon, authenticated;
revoke execute on function _release_fanout_event(uuid, timestamptz)                    from public, anon, authenticated;
revoke execute on function my_notifications(integer)                                   from public, anon;

grant execute on function claim_push_batch(integer, timestamptz) to service_role;
grant execute on function release_status()                      to service_role;
grant execute on function proactive_status()                    to service_role;
grant execute on function _proactive_tick(timestamptz)          to service_role;
grant execute on function my_notifications(integer)             to authenticated;
