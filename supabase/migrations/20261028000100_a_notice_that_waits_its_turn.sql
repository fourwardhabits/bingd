-- ===========================================================================
-- Proactive notifications, part 1: one ledger, one arbiter, one off switch
--
-- Specification: docs/product/proactive-notifications.md. Founder decisions 2026-10-28
-- (decision log §6). Part 2 (20261028000200) adds the three types that use this; this
-- file is the machinery they share and writes nothing on its own.
--
-- WHAT "PROACTIVE" MEANS HERE
--
-- A notification nobody sent to you. A follow, a comment, a reaction, a recommendation:
-- a person did something and the reader is told. Those are REACTIVE and nothing in this
-- file touches how they are written, gated or delivered. A proactive notification is
-- the app deciding to speak — a friend watched something you saved, a film you saved
-- opens next week, a title you saved and never got to. Those compete for one small
-- budget per reader, and this file is where that budget is kept.
--
-- THE SHAPE
--
--   proactive_candidates      one row per (reader, type, dedupe key), ever. Its state is
--                             the whole life of a would-be push:
--
--                               pending ──▶ selected ──▶ sent
--                                  │            │
--                                  ├──▶ suppressed (a reason)   ◀── at claim, if no longer true
--                                  └──▶ expired    (the last thing that held it)
--
--   _proactive_arbitrate      every tick, per reader, under a per-reader lock: expire the
--                             untimely, revalidate the rest, pick the single best one
--                             the budget allows, enqueue it. Losers are not queued.
--   claim_push_batch          rebuilt: a proactive job is re-checked at the moment it is
--                             sent (and the kill switch read again), its copy fields are
--                             resolved then, and the candidate becomes `sent`.
--
-- Proactive types are deliberately NOT in `_push_eligible`. The after-insert enqueue
-- trigger therefore never queues one; the arbiter is the only writer of their outbox
-- rows. That is what makes the cap central rather than a convention every writer keeps.
--
-- THE KILL SWITCH
--
-- `proactive.push_enabled` in app_config, seeded FALSE. While it is anything but the JSON
-- boolean true: the arbiter selects nothing (candidates wait, and expire if they stop
-- being timely), and claim_push_batch drops any proactive job already queued. Reactive
-- delivery reads neither. No deploy, no cron change, no DDL. app_config has no client
-- write path, and no `proactive.*` key is `public.`, so clients cannot read it either.
--
-- AND A GENERATION SWITCH. `proactive.generation_enabled`, also seeded FALSE: while it is
-- anything but true, no proactive candidate and no proactive inbox row is created at all.
-- So applying these two migrations changes nothing any reader can see. Both switches
-- are turned on deliberately, by a founder, after QA.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. Configuration, in one place
-- ---------------------------------------------------------------------------

insert into app_config (key, value) values
  -- THE KILL SWITCH. Off until a founder turns it on after Preview QA.
  ('proactive.push_enabled', 'false'::jsonb),
  -- THE GENERATION SWITCH. Candidates and the proactive inbox rows that go with them.
  -- Also off, so applying these migrations changes nothing anybody can see: no social or
  -- theatrical inbox row, no resurfacing, no candidate of any kind, until a founder turns
  -- it on. Independent of the push switch above: the inbox is the record, the push is
  -- transport, and QA can run either without the other.
  ('proactive.generation_enabled', 'false'::jsonb),
  -- THE RESURFACING SWITCH (operator-only, not a user setting). Watchlist resurfacing is
  -- the one type that is not caused by an event: switched on, every eligible reader
  -- becomes a candidate on the same evening. So it has its own gate, off, to be turned on
  -- only after social and theatrical have been watched in production.
  ('proactive.resurface_enabled', 'false'::jsonb),
  -- The local evening window. Proactive pushes go out inside it and nowhere else.
  ('proactive.window_start_hour', '17'::jsonb),
  ('proactive.window_end_hour', '20'::jsonb),
  -- The shared budget (founder, 2026-10-28).
  ('proactive.daily_cap', '1'::jsonb),
  ('proactive.weekly_cap', '2'::jsonb),
  ('proactive.type_cooldown_hours', '72'::jsonb),
  ('proactive.title_cooldown_days', '7'::jsonb),
  ('proactive.resurface_cooldown_days', '7'::jsonb),
  -- A resurfacing push yields to anything proactive that reached the reader this recently.
  ('proactive.resurface_quiet_hours', '72'::jsonb),
  -- Lower number wins. Adjust here, not in code.
  ('proactive.priority', '{"theatrical_release": 1, "watchlist_social": 2, "watchlist_resurface": 3}'::jsonb),
  -- Watchlist social: a fixed aggregation window, and how many people make it push-worthy.
  ('proactive.social_window_days', '7'::jsonb),
  ('proactive.social_threshold', '2'::jsonb),
  -- A film's date must have been read this recently when its push actually goes.
  ('proactive.theatrical_max_read_age_hours', '36'::jsonb),
  -- The client build that can route and render these kinds reports this (or higher).
  ('proactive.min_client_version', '1'::jsonb)
on conflict (key) do nothing;

create or replace function _proactive_setting(p_key text, p_default jsonb)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value from app_config where key = p_key), p_default);
$$;

comment on function _proactive_setting(text, jsonb) is
  'One proactive.* app_config value, or the default when the row is absent. Internal.';

create or replace function _proactive_int(p_key text, p_default integer)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((_proactive_setting(p_key, to_jsonb(p_default)) #>> '{}')::integer, p_default);
$$;

-- Fail closed: anything but the JSON boolean true is false, so a typo is an off switch.
create or replace function _proactive_push_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select _proactive_setting('proactive.push_enabled', 'false'::jsonb) = 'true'::jsonb;
$$;

comment on function _proactive_push_enabled() is
  'THE proactive kill switch. True only when app_config proactive.push_enabled is the JSON boolean true. Read by _proactive_arbitrate before selecting and by claim_push_batch before sending. Reactive delivery never reads it. Internal.';

-- Fail closed, the same way: generation happens only when the row is exactly true.
create or replace function _proactive_generation_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select _proactive_setting('proactive.generation_enabled', 'false'::jsonb) = 'true'::jsonb;
$$;

create or replace function _proactive_resurface_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select _proactive_setting('proactive.resurface_enabled', 'false'::jsonb) = 'true'::jsonb;
$$;

comment on function _proactive_resurface_enabled() is
  'The operator switch for Watchlist resurfacing alone. True only when app_config proactive.resurface_enabled is the JSON boolean true (seeded false). Read by _proactive_resurface_collect; social and theatrical do not read it. Not a user setting. Internal.';

comment on function _proactive_generation_enabled() is
  'THE proactive generation switch. True only when app_config proactive.generation_enabled is the JSON boolean true (seeded false). Read by the feed_events social trigger and by _proactive_tick before any collector runs; while false no proactive candidate or proactive inbox row is created. Reactive notifications never read it. Internal.';

create or replace function _proactive_priority(p_type text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((_proactive_setting('proactive.priority', '{}'::jsonb) ->> p_type)::integer, 99);
$$;


-- ---------------------------------------------------------------------------
-- 1. One new preference category: Watching › Watchlist & discovery
--
-- Governs all three proactive types. Default on, by omission, through
-- _notification_default (which is `true` for every category since 20260828000100).
-- No backfill: an account with no row gets the default, an account with a row chose.
-- ---------------------------------------------------------------------------

create or replace function _notification_categories()
returns text[]
language sql immutable
set search_path = public
as $$
  select array[
    'follows',             -- somebody started following you
    'follow_accepted',     -- somebody approved your request
    'comments',            -- somebody commented on your activity
    'reactions',           -- somebody reacted to your activity
    'watch_tags',          -- somebody tagged you as having watched with them
    'recommendations',     -- somebody recommended you a title
    'invites',             -- somebody you invited joined
    'awards',              -- you crossed an award tier
    'watchlist_discovery'  -- 20261028000100: friends, releases and reminders about your Watchlist
  ]::text[];
$$;

comment on function _notification_categories() is
  'The nine notification categories, in one place so the two writers and the reader cannot disagree. watchlist_discovery joined on 20261028000100. Internal.';

-- Rebuilt from 20260917001500. The only change is the three proactive types in the map.
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
  'invites with invite_activated (20260831000100); the three proactive types share '
  'watchlist_discovery (20261028000100). An unmapped type is delivered.';


-- ---------------------------------------------------------------------------
-- 2. Each device says what it can render
--
-- A build that predates these kinds hides them in the inbox and routes a tap on one to
-- the inbox, where the row is hidden: a push that leads nowhere. Timezone used to be the
-- old-client gate (release-awareness.md I1), and is not any more — every production build
-- now reports one.
--
-- So the gate is the DEVICE, not the account. A push is delivered to tokens, and one
-- account can hold a new phone and an old tablet at once; an account-level flag would let
-- the new phone vouch for the old tablet. Each `device_tokens` row records the
-- proactive-notification version of the build that registered it, and:
--
--   · the arbiter selects only for a recipient with at least one live token at or above
--     `proactive.min_client_version` (`client_unsupported` otherwise);
--   · claim_push_batch hands a proactive job ONLY those tokens, so the old tablet never
--     receives a kind it cannot route; a reactive job still gets every live token, exactly
--     as before.
--
-- Latest registration wins, per token. The client registers once per app process, so an
-- installation that updates to a capable build reports it on its next launch, and an old
-- build that registers the same token reports null and turns that one device off again.
-- A token is an installation, which is the unit that actually runs a given build.
-- ---------------------------------------------------------------------------

alter table device_tokens add column if not exists proactive_version smallint;

comment on column device_tokens.proactive_version is
  'The proactive-notification version of the build that last registered this token (register_device_token, 20261028000100). Null from a build that predates proactive kinds. claim_push_batch gives proactive jobs only tokens at or above proactive.min_client_version; reactive jobs are unaffected.';

-- Rebuilt from 20260825000300 with one defaulted argument and one column. An old client's
-- three-argument call resolves to this through the default and records null, which is the
-- truth about that build.
drop function if exists register_device_token(uuid, text, text);

create or replace function register_device_token(
  p_operation_id      uuid,
  p_token             text,
  p_platform          text,
  p_proactive_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token   text := btrim(coalesce(p_token, ''));
  -- Bounded, so a client cannot claim a capability from the future.
  v_version smallint := case when p_proactive_version between 1 and 100 then p_proactive_version end;
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
  -- released at sign-out has to mean. `proactive_version` is replaced, not coalesced:
  -- the build registering now is the build this installation runs.
  insert into device_tokens (user_id, token, platform, proactive_version)
  values (auth.uid(), v_token, p_platform, v_version)
  on conflict (token) do update
    set user_id           = excluded.user_id,
        platform          = excluded.platform,
        proactive_version = excluded.proactive_version,
        revoked_at        = null,
        updated_at        = now();

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function register_device_token(uuid, text, text, integer) is
  'Registers the caller''s device for push, or moves an existing device to the caller. Idempotent through _claim_operation. The token is globally unique, so re-registering a device that another account used transfers it in one statement -- which is what stops a second person on a shared phone inheriting the first one''s notifications. Since 20261028000100 it records the build''s proactive-notification version on the token (null from an older build, bounded 1-100), latest-wins.';

revoke execute on function register_device_token(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function register_device_token(uuid, text, text, integer) to authenticated;

-- Live tokens a proactive push may use for this recipient. One definition, used by the
-- arbiter, the resurfacing collector and the claim, so the three cannot disagree.
create or replace function _proactive_capable_token(p_token device_tokens)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_token.revoked_at is null
     and coalesce(p_token.proactive_version, 0) >= _proactive_int('proactive.min_client_version', 1);
$$;

comment on function _proactive_capable_token(device_tokens) is
  'Whether one device token may receive a proactive push: live, and registered by a build at or above proactive.min_client_version. Internal.';


-- ---------------------------------------------------------------------------
-- 3. The ledger
-- ---------------------------------------------------------------------------

-- The vocabulary for why a candidate did not (or has not yet) become a push. One list for
-- both columns, so analytics reads one set of words.
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
    'already_sent'
  ]::text[];
$$;

create table proactive_candidates (
  id                  uuid primary key default gen_random_uuid(),
  recipient_id        uuid not null references profiles(id) on delete cascade,
  type                text not null check (type in ('watchlist_social', 'theatrical_release', 'watchlist_resurface')),
  -- The stable dedupe key, unique per (recipient, type): the release event for a film, the
  -- aggregation window for a social cluster, the local date for a resurfacing.
  dedupe_key          text not null,
  -- The title this is about. Also the title cooldown's key.
  media_item_id       uuid not null references media_items(id) on delete cascade,
  -- The priority in force when the candidate was created, for analytics. The arbiter
  -- reads the live value from proactive.priority, so a change applies immediately.
  priority            integer not null,
  state               text not null default 'pending'
                        check (state in ('pending', 'selected', 'sent', 'suppressed', 'expired')),
  -- The inbox row, where there is one. A resurfacing has none until it is selected, and
  -- then it is a hidden row (my_notifications never returns it).
  notification_id     uuid references notifications(id) on delete set null,
  -- Ids and dates only. Never text anybody wrote, never names.
  metadata            jsonb not null default '{}',
  created_at          timestamptz not null,
  -- From when it may be pushed (still only inside the evening window). Null while a
  -- social cluster is below its threshold.
  eligible_at         timestamptz,
  expires_at          timestamptz not null,
  -- watchlist_social only: when the fixed aggregation window closes.
  window_ends_at      timestamptz,
  selected_at         timestamptz,
  -- The recipient's local date at selection: what the one-per-local-day index keys on.
  selected_local_date date,
  -- When claim_push_batch handed the job to push-sender. NOT Expo's acceptance and NOT
  -- delivery: the sender may still drop or fail it, and receipts are not polled (push-operations.md §9).
  sent_at             timestamptz,
  decided_at          timestamptz,
  suppression_reason  text,
  last_block_reason   text,
  actor_count_at_send integer,

  constraint proactive_candidates_once unique (recipient_id, type, dedupe_key),
  constraint proactive_candidates_selected check (
    state not in ('selected', 'sent') or (selected_at is not null and selected_local_date is not null)),
  constraint proactive_candidates_sent check ((state = 'sent') = (sent_at is not null)),
  constraint proactive_candidates_decided check (
    (state in ('suppressed', 'expired')) = (suppression_reason is not null and decided_at is not null)),
  constraint proactive_candidates_reason check (suppression_reason is null or suppression_reason = any (_proactive_reasons())),
  constraint proactive_candidates_block check (last_block_reason is null or last_block_reason = any (_proactive_reasons())),
  constraint proactive_candidates_window check ((type = 'watchlist_social') = (window_ends_at is not null))
);

-- STRUCTURAL: at most one proactive push per recipient per local day, whatever two
-- workers do. The arbiter's own lock makes this unreachable; this makes it impossible.
create unique index proactive_one_per_local_day
  on proactive_candidates (recipient_id, selected_local_date)
  where state in ('selected', 'sent');

create unique index proactive_candidates_notification
  on proactive_candidates (notification_id) where notification_id is not null;

create index proactive_candidates_due
  on proactive_candidates (eligible_at) where state = 'pending';

create index proactive_candidates_expiring
  on proactive_candidates (expires_at) where state = 'pending';

create index proactive_candidates_pushed
  on proactive_candidates (recipient_id, selected_at) where state in ('selected', 'sent');

create index proactive_candidates_social_open
  on proactive_candidates (recipient_id, media_item_id, window_ends_at) where type = 'watchlist_social';

comment on table proactive_candidates is
  'The shared proactive-notification ledger (20261028000100): one row per (recipient, type, dedupe key), ever. pending → selected → sent, or suppressed / expired with a reason from _proactive_reasons(). Written only by internal functions (the arbiter, the three type collectors, claim_push_batch). service_role only; aggregate through proactive_summary.';

-- A social cluster's members: one row per qualifying activity, so a person who both logs
-- and ranks a title is two rows and one actor. The activity's own foreign key means an
-- activity that is deleted takes its membership with it.
create table proactive_cluster_actors (
  candidate_id  uuid not null references proactive_candidates(id) on delete cascade,
  feed_event_id uuid not null references feed_events(id) on delete cascade,
  actor_id      uuid not null references profiles(id) on delete cascade,
  joined_at     timestamptz not null,
  primary key (candidate_id, feed_event_id)
);

create index proactive_cluster_actors_actor on proactive_cluster_actors (candidate_id, actor_id);

comment on table proactive_cluster_actors is
  'Who is in a watchlist_social cluster, by the activity that put them there. Read only through _proactive_social_actors, which re-applies visibility and the mutual-follow rule at read time. service_role only.';

-- Taps, from a push or from the inbox. The first per (notification, channel) only.
create table notification_opens (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references profiles(id) on delete cascade,
  notification_id uuid references notifications(id) on delete set null,
  candidate_id    uuid references proactive_candidates(id) on delete set null,
  kind            text not null,
  channel         text not null check (channel in ('push', 'inbox')),
  -- WHERE the tap led, as the kind of screen, never as a path: no ids, no usernames, no
  -- free text. The closed vocabulary is the client's NotificationTarget kinds plus `inbox`
  -- (the push fallback). Which title is already known from the notification itself.
  destination     text check (destination in (
                    'profile', 'title', 'activity', 'awards', 'award-celebration',
                    'goals', 'import', 'inbox')),
  opened_at       timestamptz not null default now()
);

create unique index notification_opens_once
  on notification_opens (notification_id, channel) where notification_id is not null;
create index notification_opens_user on notification_opens (user_id, opened_at);

comment on table notification_opens is
  'Notification taps (20261028000100): which notification, from a push or the inbox, where it led, when. The first per (notification, channel). Written only by record_notification_open, which refuses a notification that is not the caller''s. No read policy; aggregate through proactive_attribution.';

alter table proactive_candidates     enable row level security;
alter table proactive_cluster_actors enable row level security;
alter table notification_opens       enable row level security;
revoke all on proactive_candidates, proactive_cluster_actors, notification_opens from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. What the checks are made of
-- ---------------------------------------------------------------------------

-- The series-watchlist rule's watch signal (20260906000100), plus a ranking: the reader
-- has seen it, so a nudge to watch it is wrong.
create or replace function _proactive_title_watched(p_user uuid, p_media uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from rankings r where r.user_id = p_user and r.media_item_id = p_media)
      or exists (select 1 from user_media um
                  where um.user_id = p_user and um.media_item_id = p_media
                    and (um.bucket is not null or um.watched_on is not null or um.progress = 'completed'));
$$;

/**
 * Who in a social cluster this reader may be told about, right now.
 *
 * Re-derived on every read rather than trusted from when they joined: a person who has
 * since blocked the reader, unfollowed, gone suspended or private past the reader's
 * reach drops out of the count, the names and the push. Mutual follow is the rule
 * (notifications.md §2 Class C: "friend means mutual follow"), and can_view_profile is
 * stated again on top of it because a block removes follows but this must not depend on
 * that ordering.
 */
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

/**
 * Why a candidate is no longer true, or null if it still is.
 *
 * Asked by the arbiter before selecting and again by claim_push_batch at the moment of
 * sending. Every reason here is permanent for this candidate: it is suppressed, never
 * held. Things that merely delay a push (window, caps, device) are the arbiter's.
 */
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
  'Null if a proactive candidate is still true, else the permanent reason it is not: recipient inactive, preference off, title off the Watchlist, already watched, a social cluster below its threshold, or a film whose date moved, went stale or has arrived, or whose reader no longer reports a US region (region_mismatch / region_unknown). Asked before selection and again at send. Internal.';


-- ---------------------------------------------------------------------------
-- 5. The arbiter
--
-- Per reader, under a transaction-scoped advisory lock on that reader, in this order:
--
--   1. Anything past expires_at becomes `expired`, with whatever last held it.
--   2. Each due candidate (eligible_at <= now), best first by proactive.priority, then
--      oldest eligible, then id — a total order:
--        · no longer true            → suppressed, with the reason
--        · held (switch off, no zone, old client, no device, outside the evening window,
--          something better already chosen this tick, daily or weekly cap, type or title
--          cooldown) → stays pending, last_block_reason says why
--        · otherwise                 → selected: its notification is enqueued, and it
--          takes today's one slot
--   3. Losers are not queued. They wait while they are timely and expire when they are
--      not, so nothing "catches up" on Thursday about Monday.
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
  v_expired    integer;
  v_selected   integer := 0;
  v_suppressed integer := 0;
  v_held       integer := 0;
begin
  update proactive_candidates
     set state              = 'expired',
         suppression_reason = coalesce(last_block_reason, 'expired'),
         decided_at         = p_now
   where state = 'pending' and expires_at <= p_now;
  get diagnostics v_expired = row_count;

  for v_user in
    select distinct recipient_id
      from proactive_candidates
     where state = 'pending' and eligible_at is not null and eligible_at <= p_now
     order by recipient_id
  loop
    -- One arbiter per reader at a time. Two ticks overlapping take turns here, and the
    -- second sees the first one's selection in its cap counts.
    perform pg_advisory_xact_lock(hashtextextended('bingd.proactive:' || v_user::text, 0));

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
       order by _proactive_priority(type), eligible_at, id
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
                      where p.recipient_id = v_user and p.media_item_id = c.media_item_id
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
  'The central proactive budget (20261028000100). Expires untimely candidates; then per recipient, under an advisory lock, revalidates each due candidate (suppressing what is no longer true), holds what the kill switch, timezone, client version, device, the 17:00-20:00 local window, the daily cap (1 per local day), weekly cap (2 per rolling 7 days), type cooldown (72h; 7 days for resurfacing) or 7-day title cooldown forbid, and selects the single best remaining one by proactive.priority, enqueuing its notification. Losers are not queued. Internal; scheduled through _proactive_tick.';


-- ---------------------------------------------------------------------------
-- 6. The claim, rebuilt from 20260920000200
--
-- Three additions and nothing else; every reactive branch is carried across verbatim.
--
--   a. A proactive job is checked again at the moment it is sent: the kill switch, its
--      state, that a capable device still exists, and _proactive_invalid. One that fails
--      is dropped exactly as a blocked actor's is, and its candidate records why. So
--      switching proactive off stops even what is already in the queue.
--   b. Two new job fields: `goal` (goal_completed, whose push had no copy because it
--      carries no actor — the bug this fixes) and `proactive` (the type, the film's
--      date and the reader's local date, the resurfacing reason, and the social
--      cluster's count and first two names AS OF NOW — the push says who has watched
--      at send time, not at threshold time). And a proactive job's `tokens` are only the
--      recipient's devices whose build can route it (§2); a reactive job's are unchanged.
--   c. A claimed proactive candidate becomes `sent`, with the count it went out with.
--      `sent` means handed to push-sender by this claim. It is not Expo's acceptance and
--      not delivery: the sender can still drop the job (live_push_jobs) or fail to submit
--      it, and receipts are not polled.
--
-- TONIGHT OR NOT AT ALL (Fable review, MAJOR). A proactive push was selected for one
-- evening. If the drain stalls and recovers after that evening's window, or after the
-- candidate's expires_at, or on a later local day, the job is dropped here and the
-- candidate ends `expired` (reason `expired`, `outside_window` or `no_timezone`), never
-- sent late. `_proactive_claim_reason` is the whole rule, and it takes the clock.
--
-- AND NOT LATER AT THE PROVIDER (Codex re-review, MAJOR). A job claimed at 19:59 is
-- timely here, but Expo holds an undelivered message for weeks unless told otherwise, so
-- a phone that comes back online the next morning would still be woken by it. Every
-- proactive job therefore carries `proactive.deliver_by`, the earlier of expires_at and
-- 20:00 local on its selected_local_date, and push-sender sends it as Expo's documented
-- `expiration` (seconds since the epoch) and drops the message itself once it has passed.
-- Reactive jobs carry no deadline and keep the provider's default retention.
--
-- `p_now` is the instant proactive timeliness is judged at. It defaults to now() and only
-- tests pass it; the outbox lease always uses the real clock. The sender's call names
-- only p_limit, so the old one-argument form is dropped rather than left beside this one.
-- ---------------------------------------------------------------------------

/**
 * Why a queued proactive job must not be sent at `p_now`, or null if it may. In order:
 * the kill switch; AT MOST ONCE (a candidate already handed to the sender is never handed
 * over again); the candidate still selected; not past expires_at; the reader's timezone
 * known; inside 17:00-20:00 local on the same local day it was selected for; a capable
 * device still live; and _proactive_invalid.
 *
 * AT MOST ONCE (founder, 2026-10-28). Reactive pushes are at least once: an expired lease
 * or a retryable failure puts the outbox row back and the next drain re-sends it. For an
 * optional engagement push that is the wrong trade, because the ambiguous case (a sender
 * that dies around its Expo call) would re-send something the reader may already have
 * on their lock screen. So the first claim makes the candidate `sent`, and any later claim
 * of the same outbox row (a lease expiry, a settle that asked for a retry) finds it `sent`
 * and drops it. The cost, accepted deliberately: a crash before or during submission can
 * lose that one proactive push. A duplicate proactive interruption cannot happen.
 */
create or replace function _proactive_claim_reason(p_candidate uuid, p_now timestamptz)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c       proactive_candidates%rowtype;
  v_tz    text;
  v_local timestamp;
begin
  select * into c from proactive_candidates where id = p_candidate;
  if not found then
    return 'expired';
  end if;

  if not _proactive_push_enabled() then
    return 'kill_switch';
  end if;
  if c.state = 'sent' then
    return 'already_sent';
  end if;
  if c.state <> 'selected' then
    return 'expired';
  end if;
  if c.expires_at <= p_now then
    return 'expired';
  end if;

  select timezone into v_tz from account_context where user_id = c.recipient_id;
  if v_tz is null then
    return 'no_timezone';
  end if;
  v_local := p_now at time zone v_tz;
  if v_local::time <  make_time(_proactive_int('proactive.window_start_hour', 17), 0, 0)
     or v_local::time >= make_time(_proactive_int('proactive.window_end_hour', 20), 0, 0)
     or v_local::date is distinct from c.selected_local_date then
    return 'outside_window';
  end if;

  -- Per device: the capable phone may have signed out since selection, leaving only an
  -- old build. Then there is nobody this kind can safely reach.
  if not exists (select 1 from device_tokens d
                  where d.user_id = c.recipient_id and _proactive_capable_token(d)) then
    return 'client_unsupported';
  end if;

  return _proactive_invalid(c.id, p_now);
end;
$$;

comment on function _proactive_claim_reason(uuid, timestamptz) is
  'Null if a queued proactive job may be sent at p_now, else why not: kill_switch, already_sent (at most once: never handed to the sender twice), expired (state, or past expires_at), no_timezone, outside_window (outside 17:00-20:00 local, or a later local day than it was selected for), client_unsupported, or a _proactive_invalid reason. Tonight or not at all. Internal.';

drop function if exists claim_push_batch(integer);

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
             'actor_names', case when pc.type = 'watchlist_social' then (
                              select jsonb_agg(coalesce(nullif(s.display_name, ''), s.username)
                                               order by s.first_joined, s.actor_id)
                                from (select * from _proactive_social_actors(pc.id, n.recipient_id) limit 2) s
                            ) end
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

  delete from push_outbox o
   where o.notification_id = any (v_claimed)
     and o.notification_id not in (
       select (job ->> 'notification_id')::uuid from jsonb_array_elements(v_jobs) as job
     );

  -- 20261028000100 (c). Handed to push-sender. Not Expo acceptance, not delivery.
  update proactive_candidates pc
     set state               = 'sent',
         sent_at             = now(),
         actor_count_at_send = (job -> 'proactive' ->> 'actor_count')::integer
    from jsonb_array_elements(v_jobs) as job
   where pc.notification_id = (job ->> 'notification_id')::uuid
     and pc.state = 'selected';

  return v_jobs;
end;
$$;

comment on function claim_push_batch(integer, timestamptz) is
  'Claims up to p_limit queued pushes and returns everything needed to send them, recipients and tokens resolved server-side. Takes no recipient and cannot be pointed at one. Applies can_discover_profile exactly as my_notifications does, so a notification that raced a block is not pushed; an actorless notification (award_earned, 20260828000100) has nobody to check and survives -- a predicate 20260830000100 dropped by accident and 20260904000100 restored, with a test behind it. Five-minute lease with skip locked, so delivery is at least once, bounded at three settled failures and six claims. Reaps rows that have hit either ceiling. Carries feed_event_id since 20260826000600, comment_excerpt since 20260827000300, the actor''s own event for recommendation_ranked since 20260827000600, the mention branch since 20260830000100, import_job_id / import_counts since 20260917001500, and award_key / award_tier / award_family / award_tier_label for award_earned since 20260920000200 (the names under keys the pre-20260920000200 sender does not read, because it read award_name as the earned title). Since 20261028000100: goal for goal_completed; proactive for the three proactive types, which are re-checked here by _proactive_claim_reason at p_now (kill switch, state, expires_at, the reader''s 17:00-20:00 window on the local day it was selected for, a capable device, _proactive_invalid), sent only to tokens _proactive_capable_token admits, and dropped with their candidate ended (expired for timeliness, suppressed otherwise) if they no longer hold, and marked sent (handed to push-sender; not Expo acceptance or delivery) when they are returned, each with proactive.deliver_by (the earlier of expires_at and 20:00 local on its selected day), which push-sender sends as the Expo expiration. p_now defaults to now() and only tests pass it; leases use the real clock. A job it returns may still be dropped before dispatch by live_push_jobs (20260904000100).';


-- ---------------------------------------------------------------------------
-- 7. The inbox, rebuilt from 20260901000100
--
-- Two columns, three filters and one read-time date added; every join, ownership rule and excerpt condition is
-- carried across whole.
--
--   cluster_actors / cluster_count   for watchlist_social: up to three people and the
--                                    total, through _proactive_social_actors, so the row
--                                    names exactly who this reader may be told about NOW.
--   hidden                           watchlist_resurface rows (the push-only type's
--                                    carrier) are never returned, and a social row whose
--                                    every member has dropped out is not drawn.
--   theatrical date                  a theatrical_release row's payload.opens_on is the
--                                    release event's CURRENT date, and a row whose
--                                    release was withdrawn or lost its date is not drawn.
-- ---------------------------------------------------------------------------

drop function if exists my_notifications(integer);

create function my_notifications(p_limit integer default 50)
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
  -- watchlist_social only (20261028000100): up to three members, earliest first, as
  -- [{username, display_name, avatar_path}], and how many there are in all.
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
           on n.type in ('watchlist_social', 'theatrical_release')
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
    left join lateral (
      select count(*)::integer as n,
             jsonb_agg(jsonb_build_object('username', s.username,
                                          'display_name', s.display_name,
                                          'avatar_path', s.avatar_path)
                       order by s.first_joined, s.actor_id) filter (where s.rn <= 3) as actors
        from (select a.*, row_number() over (order by a.first_joined, a.actor_id) as rn
                from _proactive_social_actors(pc.id, auth.uid()) a) s
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
   order by n.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

comment on function my_notifications(integer) is
  'The caller''s own inbox, with the actor named, the subject title resolved and the row''s payload carried through. Definer for the same reason my_blocks is. Takes no recipient and cannot be asked about anybody else. Filters actors through can_discover_profile since 20260819000300. The feed-event join resolves the recipient''s own event for comment and reaction rows, the actor''s own for recommendation_ranked (20260827000600), and the event''s own for mention (20260830000100). Returns one line of the comment (20260830000100), viewer_ranked for watch_tag, and the subject event''s type (20260901000100). Since 20261028000100: cluster_actors / cluster_count for watchlist_social (re-derived at read time through _proactive_social_actors), never returns watchlist_resurface rows, drops a social row with nobody left in it, and states a theatrical_release row''s opens_on from the release event as it is now (dropping the row once that release is withdrawn or has no date).';

revoke execute on function my_notifications(integer) from public, anon;
grant execute on function my_notifications(integer) to authenticated;


-- ---------------------------------------------------------------------------
-- 8. Taps
-- ---------------------------------------------------------------------------

create or replace function record_notification_open(
  p_notification_id uuid,
  p_channel         text,
  p_destination     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_kind text;
  v_cand uuid;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_channel is null or p_channel not in ('push', 'inbox') then
    raise exception 'unknown channel' using errcode = '22023';
  end if;
  -- A closed vocabulary, not caller-supplied text (Fable review, MINOR): anything else is
  -- refused rather than stored, so nothing a client sends here can carry an id, a name or
  -- a path into the table.
  if p_destination is not null and p_destination not in (
       'profile', 'title', 'activity', 'awards', 'award-celebration', 'goals', 'import', 'inbox') then
    raise exception 'unknown destination' using errcode = '22023';
  end if;

  -- Only the caller's own notification. Any other id answers the same `ok` and records
  -- nothing, so this cannot be used to ask whether a notification exists.
  select n.type into v_kind
    from notifications n
   where n.id = p_notification_id and n.recipient_id = v_user;
  if v_kind is null then
    return jsonb_build_object('ok', true);
  end if;

  select pc.id into v_cand from proactive_candidates pc where pc.notification_id = p_notification_id;

  insert into notification_opens (user_id, notification_id, candidate_id, kind, channel, destination)
  values (v_user, p_notification_id, v_cand, v_kind, p_channel, p_destination)
  on conflict (notification_id, channel) where notification_id is not null do nothing;

  return jsonb_build_object('ok', true);
end;
$$;

comment on function record_notification_open(uuid, text, text) is
  'Records that the caller opened one of their own notifications, from a push or from the inbox, and the kind of screen it led to (one of profile, title, activity, awards, award-celebration, goals, import, inbox; anything else is refused with 22023, so no free text is stored). The first per (notification, channel) only. Any id that is not the caller''s own answers ok and records nothing. Deliberately does not call assert_can_write: it is telemetry about the caller''s own row and must never fail the tap it rides on. authenticated.';

revoke execute on function record_notification_open(uuid, text, text) from public, anon;
grant execute on function record_notification_open(uuid, text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 9. What an operator reads. Aggregates only.
-- ---------------------------------------------------------------------------

create view proactive_summary with (security_invoker = true) as
select c.type,
       c.state,
       coalesce(c.suppression_reason, c.last_block_reason) as reason,
       count(*)                                            as candidates,
       count(distinct c.recipient_id)                      as recipients,
       count(*) filter (where c.notification_id is not null) as with_notification,
       count(*) filter (where c.sent_at is not null)       as sent,
       min(c.created_at)                                   as first_at,
       max(c.created_at)                                   as last_at
  from proactive_candidates c
 group by c.type, c.state, coalesce(c.suppression_reason, c.last_block_reason);

comment on view proactive_summary is
  'Proactive candidates per (type, state, reason): how many, for how many people, how many reached the sender. service_role only.';

/**
 * Sent → opened → acted. "Acted" is the title ranked, logged or watched again by the
 * same reader within seven days of opening; a title that leaves the Watchlist because it
 * was watched is caught by the same predicate, since leaving it for that reason is a log.
 */
create view proactive_attribution with (security_invoker = true) as
select c.type,
       count(*) filter (where c.sent_at is not null)                          as sent,
       count(o.id)                                                           as opened_from_push,
       count(o.id) filter (where exists (
         select 1 from rankings r
          where r.user_id = c.recipient_id and r.media_item_id = c.media_item_id
            and r.created_at between o.opened_at and o.opened_at + interval '7 days'
       ) or exists (
         select 1 from watch_events w
          where w.user_id = c.recipient_id and w.media_item_id = c.media_item_id
            and w.recorded_at between o.opened_at and o.opened_at + interval '7 days'
       ))                                                                     as acted_within_7d,
       count(*) filter (where c.sent_at is not null and o.id is null and exists (
         select 1 from rankings r
          where r.user_id = c.recipient_id and r.media_item_id = c.media_item_id
            and r.created_at between c.sent_at and c.sent_at + interval '7 days'
       ))                                                                     as ranked_within_7d_without_open
  from proactive_candidates c
  left join notification_opens o
         on o.candidate_id = c.id and o.channel = 'push'
 where c.state = 'sent'
 group by c.type;

comment on view proactive_attribution is
  'Per proactive type: pushes sent, opened from the push, and the title acted on (ranked or a watch recorded) within 7 days of the open; plus sent and ranked within 7 days WITHOUT A RECORDED PUSH OPEN. Observational attribution, not causal measurement: a reader who opens a push may have ranked the title anyway, and an open that was not recorded counts as none. service_role only.';

revoke all on proactive_summary, proactive_attribution from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 10. Release status learns that theatrical notifications are real now
--
-- Rebuilt from 20260930000300. One change: `release_notifications_exist` (the proof that
-- nothing was being sent) now counts season premieres only, because season-premiere
-- delivery is still deferred and theatrical releases are delivered through the
-- proactive ledger from 20261028000200.
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

  -- 20261028000100: season premieres only. Theatrical delivery is live through the
  -- proactive ledger; a season-premiere row would still mean something leaked.
  select count(*) into v_sent
    from notifications where type = 'season_premiere';
  select count(*) into v_outbox
    from push_outbox o join notifications n on n.id = o.notification_id
   where n.type = 'season_premiere';

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
                               'theatrical_delivery', 'proactive_ledger'),
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
  'One call that says whether release awareness is healthy: jobs, transport, subjects read on time, evaluation keeping up, the shadow ledger''s outcomes, and how many SEASON PREMIERE notifications and outbox rows exist (must be zero: season delivery is deferred). Theatrical releases are delivered through the proactive ledger since 20261028000100 and are reported by proactive_status(). service_role only.';


-- ---------------------------------------------------------------------------
-- 11. Grants
-- ---------------------------------------------------------------------------

revoke execute on function _proactive_setting(text, jsonb)                 from public, anon, authenticated;
revoke execute on function _proactive_int(text, integer)                   from public, anon, authenticated;
revoke execute on function _proactive_push_enabled()                       from public, anon, authenticated;
revoke execute on function _proactive_generation_enabled()                 from public, anon, authenticated;
revoke execute on function _proactive_resurface_enabled()                  from public, anon, authenticated;
revoke execute on function _proactive_capable_token(device_tokens)         from public, anon, authenticated;
revoke execute on function _proactive_priority(text)                       from public, anon, authenticated;
revoke execute on function _proactive_reasons()                            from public, anon, authenticated;
revoke execute on function _proactive_title_watched(uuid, uuid)            from public, anon, authenticated;
revoke execute on function _proactive_social_actors(uuid, uuid)            from public, anon, authenticated;
revoke execute on function _proactive_invalid(uuid, timestamptz)           from public, anon, authenticated;
revoke execute on function _proactive_arbitrate(timestamptz)               from public, anon, authenticated;
revoke execute on function _notification_categories()                      from public, anon, authenticated;
revoke execute on function _apply_notification_preference()                from public, anon, authenticated;
revoke execute on function claim_push_batch(integer, timestamptz)          from public, anon, authenticated;
revoke execute on function _proactive_claim_reason(uuid, timestamptz)      from public, anon, authenticated;
revoke execute on function release_status()                                from public, anon, authenticated;

grant execute on function claim_push_batch(integer, timestamptz) to service_role;
grant execute on function release_status()          to service_role;
