-- ===========================================================================
-- Proactive notifications, part 2: three reasons to say something about a Watchlist
--
-- Specification: docs/product/proactive-notifications.md. Uses the ledger, arbiter and
-- kill switch from 20261028000100; every push below is chosen there, never here.
--
--   watchlist_social     mutual friends watched a title you saved. One inbox row per
--                        (reader, title, fixed 7-day window), updated as friends arrive;
--                        push-eligible at the SECOND distinct friend; one push at most.
--   theatrical_release   a film you saved opens in US theaters in about a week. The
--                        release-awareness state machine (20260930000100-300) decides the
--                        date and the T-7 moment; this turns its armed events into an
--                        inbox row and a candidate.
--   watchlist_resurface  one title from your Watchlist, chosen deterministically, as a
--                        push only. At most one a week, and only when nothing stronger
--                        has had the reader's attention.
--
-- Season-premiere delivery stays deferred (founder, 2026-10-28): nothing here reads
-- season events.
--
-- Nothing is scheduled by applying this. schedule_proactive_notifications() installs the
-- one job, by an operator. proactive.generation_enabled (seeded false) has to be turned
-- on before any candidate or proactive inbox row exists, and proactive.push_enabled
-- (seeded false) before anything reaches a phone.
-- ===========================================================================


-- The social trigger asks "who has this title saved" on every ranking and log. The
-- primary key is (user_id, media_item_id), which cannot answer that.
create index if not exists watchlist_by_title on watchlist (media_item_id);


-- ---------------------------------------------------------------------------
-- 1. Watchlist social
-- ---------------------------------------------------------------------------

/**
 * One qualifying activity joins one reader's cluster for one title.
 *
 * Serialised per (reader, title) with a transaction-scoped advisory lock, which is what
 * makes "one open cluster" true when two friends finish the same film at the same
 * moment: the second waits, then finds the first's cluster and joins it.
 *
 * THE WINDOW IS FIXED. It opens with the first friend and closes seven days later
 * whatever arrives in between: a late friend joins, and nothing extends it. After it
 * closes, the next friend opens a new cluster (and the 7-day title cooldown keeps that
 * one from pushing again too soon).
 */
create or replace function _proactive_social_add(
  p_recipient uuid,
  p_actor     uuid,
  p_media     uuid,
  p_event     uuid,
  p_now       timestamptz
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  c          proactive_candidates%rowtype;
  v_window   interval := make_interval(days => _proactive_int('proactive.social_window_days', 7));
  v_note     uuid;
  v_new      integer;
  v_returner boolean;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('bingd.proactive.social:' || p_recipient::text || ':' || p_media::text, 0));

  select * into c
    from proactive_candidates
   where recipient_id = p_recipient and type = 'watchlist_social' and media_item_id = p_media
     and window_ends_at > p_now
   order by created_at desc
   limit 1
     for update;

  if not found then
    -- The ledger row first, so a conflict can never leave an orphan inbox row behind.
    insert into proactive_candidates (
      recipient_id, type, dedupe_key, media_item_id, priority, state, created_at,
      eligible_at, expires_at, window_ends_at, last_block_reason
    ) values (
      p_recipient, 'watchlist_social',
      p_media::text || '@' || to_char(p_now at time zone 'UTC', 'YYYYMMDD"T"HH24MISS.US'),
      p_media, _proactive_priority('watchlist_social'), 'pending', p_now,
      null, p_now + v_window, p_now + v_window, 'below_threshold'
    )
    on conflict (recipient_id, type, dedupe_key) do nothing
    returning * into c;

    if c.id is null then
      return 'raced';
    end if;

    if not _notifies(p_recipient, 'watchlist_discovery') then
      update proactive_candidates
         set state = 'suppressed', suppression_reason = 'preference_off', decided_at = p_now,
             last_block_reason = null
       where id = c.id;
      return 'preference_off';
    end if;

    -- Actorless: who is in it is read from the cluster at read time, so a block or an
    -- unfollow takes a name out of the row without anybody rewriting it.
    insert into notifications (recipient_id, type, subject_type, subject_id, payload, created_at)
    values (p_recipient, 'watchlist_social', 'media_item', p_media,
            jsonb_build_object('candidate_id', c.id), p_now)
    returning id into v_note;

    update proactive_candidates set notification_id = v_note where id = c.id;
    c.notification_id := v_note;
  end if;

  -- A cluster the reader has switched off, or that otherwise never got an inbox row, has
  -- nothing to update.
  if c.notification_id is null then
    return 'no_inbox_row';
  end if;

  select exists (select 1 from proactive_cluster_actors
                  where candidate_id = c.id and actor_id = p_actor)
    into v_returner;

  insert into proactive_cluster_actors (candidate_id, feed_event_id, actor_id, joined_at)
  values (c.id, p_event, p_actor, p_now)
  on conflict (candidate_id, feed_event_id) do nothing;
  get diagnostics v_new = row_count;

  -- A new PERSON is news, so the row comes back to the top and unread. The same person
  -- ranking what they already logged is not.
  if v_new > 0 and not v_returner then
    update notifications set created_at = p_now, read_at = null where id = c.notification_id;
  end if;

  -- The threshold. Crossing it makes the push eligible now; the arbiter still waits for
  -- the reader's evening window, and the copy counts whoever is in the cluster then.
  if c.state = 'pending' and c.eligible_at is null
     and (select count(*) from _proactive_social_actors(c.id, p_recipient))
           >= _proactive_int('proactive.social_threshold', 2) then
    update proactive_candidates
       set eligible_at = p_now, last_block_reason = null
     where id = c.id;
    return 'eligible';
  end if;

  return 'joined';
end;
$$;

comment on function _proactive_social_add(uuid, uuid, uuid, uuid, timestamptz) is
  'Adds one qualifying activity to the recipient''s open watchlist_social cluster for the title, opening one (ledger row, then an actorless inbox row) if there is none. A new person bumps the inbox row; the second distinct visible person makes the candidate eligible. Fixed 7-day window. Serialised per (recipient, title) by an advisory lock. Internal.';

/**
 * Every ranking and every log is a chance that a friend just watched something on
 * somebody's Watchlist.
 *
 * WHAT QUALIFIES, AND WHY THAT IS THE WHOLE FILTER
 *
 *   · `title_ranked` and `title_logged` only: a watch or a rank, the two things a person
 *     does when they have seen it. Not `watchlist_added` (an intention), not
 *     `ranking_batch` (an Unranked sitting working through a back catalogue: one post per
 *     sitting, a representative title, and no burst), not its draft.
 *   · Written at most a day ago. A backfill or a repair writes activity long after the
 *     fact; that is not a moment anybody should be told about.
 *   · Never during an import: `_no_activity_while_importing` already cancels the row
 *     before this can see it, and this checks `_importing()` again rather than depend on
 *     trigger order.
 *   · The reader: has this exact title saved, is active, is not the actor, follows and is
 *     followed by the actor (approved both ways), can view the actor, has not already
 *     watched or ranked it.
 *
 * A failure here must never fail the ranking that caused it, so each reader is attempted
 * in its own subtransaction and an error is a warning.
 */
create or replace function _proactive_social_on_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reader uuid;
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
  'After-insert trigger on feed_events: a title_ranked or title_logged row written now (not during an import, not a backfill) joins the watchlist_social cluster of every active mutual friend who has that title saved, can view the actor and has not watched it. Never fails the write it rides on. Internal.';

drop trigger if exists feed_events_watchlist_social on feed_events;
create trigger feed_events_watchlist_social
  after insert on feed_events
  for each row execute function _proactive_social_on_activity();


-- ---------------------------------------------------------------------------
-- 2. Theatrical release, made real
--
-- The state machine already says when: a film's event arms at T-7 on a fresh read
-- (`evaluation` pending, then `done` once _release_evaluate has run it), never on or after
-- the day (`skipped_late`), once ever. This reads those armed events for two days after
-- arming, so a reader who saves the film in that time still hears about it, and turns
-- each watchlister into an inbox row and a candidate. Every date guard of the shadow is
-- kept, and one more is added at send time (_proactive_invalid: the date has not moved,
-- the read is at most proactive.theatrical_max_read_age_hours old, and it is not yet the
-- day).
--
-- Region: a US date is only a claim about the US. Another country: nothing. Unknown:
-- the inbox row, and no push (suppressed `region_unknown`), exactly as the shadow
-- decided it.
-- ---------------------------------------------------------------------------

create or replace function _proactive_theatrical_collect(p_now timestamptz default now())
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
  v_age    interval := make_interval(hours => _proactive_int('proactive.theatrical_max_read_age_hours', 36));
begin
  for e in
    select ev.*
      from release_events ev
     where ev.event_kind = 'theatrical_release'
       and ev.region = 'US'
       and ev.state = 'scheduled'
       and ev.evaluation = 'done'
       and ev.evaluated_at > p_now - interval '48 hours'
       and ev.scheduled_date > (p_now at time zone 'UTC')::date
       and ev.last_observed_at >= p_now - v_age
     order by ev.scheduled_date, ev.id
  loop
    for r in
      select w.user_id, ac.region, ac.timezone
        from watchlist w
        join profiles p on p.id = w.user_id and p.status = 'active'
        left join account_context ac on ac.user_id = w.user_id
       where w.media_item_id = e.media_item_id
         and (ac.region is null or ac.region = e.region)
         and not _proactive_title_watched(w.user_id, e.media_item_id)
       order by w.user_id
    loop
      c := null;
      insert into proactive_candidates (
        recipient_id, type, dedupe_key, media_item_id, priority, state, metadata,
        created_at, eligible_at, expires_at
      ) values (
        r.user_id, 'theatrical_release', e.id::text, e.media_item_id,
        _proactive_priority('theatrical_release'), 'pending',
        jsonb_build_object('release_event_id', e.id, 'opens_on', e.scheduled_date, 'region', e.region),
        p_now, p_now,
        -- Timely until the day before it opens, and never longer than three days: a
        -- week's notice that arrives with one day left is not what was promised.
        least(p_now + interval '72 hours',
              (e.scheduled_date::timestamp) at time zone coalesce(r.timezone, 'UTC'))
      )
      on conflict (recipient_id, type, dedupe_key) do nothing
      returning * into c;

      -- Somebody already decided this reader and this release. Once, ever.
      if c.id is null then
        continue;
      end if;
      v_made := v_made + 1;

      if not _notifies(r.user_id, 'watchlist_discovery') then
        update proactive_candidates
           set state = 'suppressed', suppression_reason = 'preference_off', decided_at = p_now
         where id = c.id;
        continue;
      end if;

      insert into notifications (recipient_id, type, subject_type, subject_id, payload, created_at)
      values (r.user_id, 'theatrical_release', 'media_item', e.media_item_id,
              jsonb_build_object('candidate_id', c.id, 'opens_on', e.scheduled_date, 'region', e.region),
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

comment on function _proactive_theatrical_collect(timestamptz) is
  'Turns release events that armed their T-7 awareness in the last 48 hours (still scheduled, still in the future, read within proactive.theatrical_max_read_age_hours) into one theatrical_release inbox row and candidate per active watchlister in the US or of unknown region, once ever per (reader, release). Unknown region keeps the inbox row and suppresses the push. Internal.';


-- ---------------------------------------------------------------------------
-- 3. Watchlist resurfacing
--
-- The method, in full (documented in proactive-notifications.md §I, and nothing else
-- influences it):
--
--   Eligible titles: on the Watchlist; released (no future release_date); not watched or
--   ranked; not the subject of any proactive push to this reader in the last 30 days.
--
--   Score, integers only:
--     +3 per mutual friend who ranked or logged it in the last 30 days, at most 3 friends
--     +2 if it is on a current Trending list (the cached TMDB week lists, under the
--        Trending shelf's own 168-hour cutoff; a season counts through its series)
--     +2 if it came out in the last 60 days
--     +1 per full 30 days it has sat on the Watchlist, at most 3
--     -2 if it was ever resurfaced before (older than the 30-day exclusion)
--
--   Ties: the longest-saved first, then the id. So the same state always picks the same
--   title, and a title just pushed is out for a month, which is the variety.
--
--   The reason line the push uses is the strongest signal that scored: friends, then
--   trending, then recent, else none.
-- ---------------------------------------------------------------------------

create or replace function _proactive_resurface_pick(p_user uuid, p_now timestamptz)
returns table (media_item_id uuid, reason text, score integer, friends integer)
language sql
stable
security definer
set search_path = public
as $$
  with trending as (
    select (jsonb_array_elements_text(l.payload -> 'ids'))::uuid as id
      from provider_list_cache l
     where l.list_key in ('trending.movie.week', 'trending.series.week')
       and l.fetched_at > p_now - interval '168 hours'
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
          where c.recipient_id = p_user and c.media_item_id = w.media_item_id
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

comment on function _proactive_resurface_pick(uuid, timestamptz) is
  'The one Watchlist title to resurface for a reader, deterministically: friends (+3 each, max 3), trending (+2), released in 60 days (+2), months saved (+1 each, max 3), resurfaced before (-2); excludes unreleased, watched, and anything pushed in 30 days; ties to the longest saved. Internal.';

/**
 * Who gets a resurfacing candidate this tick: only readers it could actually reach and
 * only when there is room for it, so a day the budget is already spent writes nothing at
 * all rather than a row that is born suppressed.
 *
 * Push-only, so it is not generated while the kill switch is off.
 */
create or replace function _proactive_resurface_collect(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start   integer  := _proactive_int('proactive.window_start_hour', 17);
  v_end     integer  := _proactive_int('proactive.window_end_hour', 20);
  v_weekly  integer  := _proactive_int('proactive.weekly_cap', 2);
  v_res_cd  interval := make_interval(days  => _proactive_int('proactive.resurface_cooldown_days', 7));
  v_quiet   interval := make_interval(hours => _proactive_int('proactive.resurface_quiet_hours', 72));
  u         record;
  pick      record;
  v_made    integer := 0;
begin
  if not _proactive_push_enabled() then
    return 0;
  end if;

  for u in
    select p.id as user_id, ac.timezone, (p_now at time zone ac.timezone) as local_now
      from profiles p
      join account_context ac on ac.user_id = p.id
     where p.status = 'active'
       and ac.timezone is not null
       and (p_now at time zone ac.timezone)::time >= make_time(v_start, 0, 0)
       and (p_now at time zone ac.timezone)::time <  make_time(v_end, 0, 0)
       -- A device whose build can route the push: per token, never per account.
       and exists (select 1 from device_tokens d where d.user_id = p.id and _proactive_capable_token(d))
       and exists (select 1 from watchlist w where w.user_id = p.id)
       and _notifies(p.id, 'watchlist_discovery')
       -- Room today, room this week, no resurfacing this week, nothing proactive lately.
       and not exists (select 1 from proactive_candidates c
                        where c.recipient_id = p.id and c.state in ('selected', 'sent')
                          and c.selected_local_date = (p_now at time zone ac.timezone)::date)
       and (select count(*) from proactive_candidates c
             where c.recipient_id = p.id and c.state in ('selected', 'sent')
               and c.selected_at > p_now - interval '7 days') < v_weekly
       and not exists (select 1 from proactive_candidates c
                        where c.recipient_id = p.id and c.type = 'watchlist_resurface'
                          and c.state in ('selected', 'sent') and c.selected_at > p_now - v_res_cd)
       and not exists (select 1 from proactive_candidates c
                        where c.recipient_id = p.id and c.state in ('selected', 'sent')
                          and c.selected_at > p_now - v_quiet)
       -- Something stronger is waiting for this evening: let it have it.
       and not exists (select 1 from proactive_candidates c
                        where c.recipient_id = p.id and c.state = 'pending'
                          and c.type <> 'watchlist_resurface'
                          and c.eligible_at is not null and c.eligible_at <= p_now)
       -- Already tried today.
       and not exists (select 1 from proactive_candidates c
                        where c.recipient_id = p.id and c.type = 'watchlist_resurface'
                          and c.dedupe_key = ((p_now at time zone ac.timezone)::date)::text)
     order by p.id
  loop
    select * into pick from _proactive_resurface_pick(u.user_id, p_now);
    if pick.media_item_id is null then
      continue;
    end if;

    insert into proactive_candidates (
      recipient_id, type, dedupe_key, media_item_id, priority, state, metadata,
      created_at, eligible_at, expires_at
    ) values (
      u.user_id, 'watchlist_resurface', (u.local_now::date)::text, pick.media_item_id,
      _proactive_priority('watchlist_resurface'), 'pending',
      jsonb_build_object('reason', pick.reason, 'score', pick.score, 'friends', pick.friends),
      p_now, p_now,
      -- Tonight or not at all: a reminder does not roll over to tomorrow.
      (u.local_now::date + make_interval(hours => v_end)) at time zone u.timezone
    )
    on conflict (recipient_id, type, dedupe_key) do nothing;

    v_made := v_made + 1;
  end loop;

  return v_made;
end;
$$;

comment on function _proactive_resurface_collect(timestamptz) is
  'For each reachable reader inside their evening window with budget to spare (no proactive push today, under the weekly cap, no resurfacing in 7 days, nothing proactive in 72 hours, nothing stronger waiting), one watchlist_resurface candidate for today, chosen by _proactive_resurface_pick, expiring at tonight''s window close. Push-only; generates nothing while the kill switch is off. Internal.';


-- ---------------------------------------------------------------------------
-- 4. The tick, its status, and the job
-- ---------------------------------------------------------------------------

create or replace function _proactive_tick(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_theatrical integer := 0;
  v_resurface  integer := 0;
begin
  -- Fail closed: no collector runs unless generation is explicitly on (seeded false).
  if _proactive_generation_enabled() then
    v_theatrical := _proactive_theatrical_collect(p_now);
    v_resurface  := _proactive_resurface_collect(p_now);
  end if;

  return jsonb_build_object('theatrical_candidates', v_theatrical,
                            'resurface_candidates', v_resurface)
         || _proactive_arbitrate(p_now);
end;
$$;

comment on function _proactive_tick(timestamptz) is
  'The scheduled proactive pass: collect theatrical and resurfacing candidates (only while proactive.generation_enabled is exactly true; seeded false), then arbitrate. One transaction: a failure rolls the whole tick back and the next repeats it; the ledger''s unique keys keep a repeat from doubling anything. Internal; scheduled as bingd-proactive-tick.';

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
    'job',         v_job,
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
  'Proactive delivery at a glance: the kill switch and generation flags, the job, candidate counts by type and state, anything selected but not claimed for 15 minutes (a stalled drain), sends and push opens in 24 hours. service_role only.';

create or replace function schedule_proactive_notifications()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old bigint;
  v_id  bigint;
begin
  if to_regclass('cron.job') is null then
    raise exception 'pg_cron is not installed on this database'
      using errcode = '55000',
            hint = 'Enable pg_cron (Supabase dashboard, Database > Extensions), then call this again.';
  end if;

  for v_old in execute $q$ select jobid from cron.job where jobname = 'bingd-proactive-tick' $q$
  loop
    execute $q$ select cron.unschedule($1) $q$ using v_old;
  end loop;

  -- Every fifteen minutes, off the quarter: the 17:00 window opens within a quarter hour.
  execute $q$ select cron.schedule('bingd-proactive-tick', '4,19,34,49 * * * *',
    'select public._proactive_tick()') $q$ into v_id;

  return jsonb_build_object('status', 'ok', 'jobid', v_id);
end;
$$;

comment on function schedule_proactive_notifications() is
  'Installs (or replaces) bingd-proactive-tick, every 15 minutes. Idempotent by job name. Scheduling does not turn pushes on: proactive.push_enabled does. service_role only.';

create or replace function unschedule_proactive_notifications()
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
  for v_id in execute $q$ select jobid from cron.job where jobname = 'bingd-proactive-tick' $q$
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

comment on function unschedule_proactive_notifications() is
  'Stops bingd-proactive-tick. Nothing is lost; pending candidates expire on their own clocks. NOT the emergency stop: that is proactive.push_enabled = false, which needs no job change. service_role only.';


-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------

revoke execute on function _proactive_social_add(uuid, uuid, uuid, uuid, timestamptz) from public, anon, authenticated;
revoke execute on function _proactive_social_on_activity()                       from public, anon, authenticated;
revoke execute on function _proactive_theatrical_collect(timestamptz)            from public, anon, authenticated;
revoke execute on function _proactive_resurface_pick(uuid, timestamptz)          from public, anon, authenticated;
revoke execute on function _proactive_resurface_collect(timestamptz)             from public, anon, authenticated;
revoke execute on function _proactive_tick(timestamptz)                          from public, anon, authenticated;
revoke execute on function proactive_status()                                    from public, anon, authenticated;
revoke execute on function schedule_proactive_notifications()                    from public, anon, authenticated;
revoke execute on function unschedule_proactive_notifications()                  from public, anon, authenticated;

grant execute on function _proactive_tick(timestamptz)          to service_role;
grant execute on function proactive_status()                    to service_role;
grant execute on function schedule_proactive_notifications()    to service_role;
grant execute on function unschedule_proactive_notifications()  to service_role;
