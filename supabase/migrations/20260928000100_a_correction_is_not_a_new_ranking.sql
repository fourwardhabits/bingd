-- A correction is not a new ranking.
--
-- Specification: founder decision 2026-09-07 (*Update your rating* is a correction, not a
-- watch) · the T0 tranche of docs/product/watch-history-and-ranking-calibration.md,
-- approved 2026-09-19. Supersedes the unapplied PR #118, whose migration could not ship:
-- its version, 20260911000100, is already taken by the applied Helpful-reviews migration.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- `_rank_finalize` performs every re-placement -- a correction as much as a rewatch -- as a
-- DELETE of the old `rankings` row and an INSERT of the new one, inside the category lock
-- (20260826000500). Three things read that INSERT as a brand-new ranking act:
--
--   1. `rankings.created_at` took `now()`. The weekly streak is derived from that column
--      (src/features/streaks/streak.ts), so *Update your rating* in an otherwise empty
--      week counted as "ranked this week" -- PR #120 only stopped the client *celebrating*
--      it; the week was still fabricated. *Recently ranked* and the people suggestions
--      (`max(rankings.created_at)`, 20260914000100) moved the title to the front for a
--      non-event. streak.ts's header claimed a migration had fixed this; none had.
--
--   2. `rankings_leaves_watchlist` and `rankings_leaves_series_watchlist` fire on every
--      INSERT. A reader who ranked a film and then deliberately put it back on the
--      watchlist -- "I want to see this again", which 20260815040000 calls a deliberate
--      act -- lost that entry the moment they corrected the ranking. For a season, a
--      series the reader re-added after finishing it was re-evaluated away the same way.
--
--   3. A correction into another band moves `user_media.bucket`, and
--      `user_media_update_leaves_watchlist` (and its series peer) treat *any* bucket
--      change as the row "becoming watched" -- so the band-change route deleted the same
--      re-added entry a second way.
--
-- ===========================================================================
-- THE RULE, AND WHY IT IS CHRONOLOGY RATHER THAN A SWITCH
--
--   A correction keeps the instant its ranking already had. A first placement and an
--   explicit rewatch (`p_new_watch`) are new ranking acts and are stamped now.
--
-- With that true, the watchlist question answers itself by time. Every watch signal
-- removes the title from the watchlist, so any entry still present when a ranking is
-- written was either there before the ranking's instant (a stale intention the ranking
-- satisfies) or added after it (a newer, deliberate one the ranking says nothing about).
-- The rankings triggers now remove only the first kind: `watchlist.created_at <=
-- rankings.created_at`. A first placement and a rewatch are stamped now, so they remove
-- every entry exactly as before; a correction carries its old instant, so an entry
-- re-added since then survives it. No marker, no flag, no knowledge of intent inside the
-- trigger -- the row itself says when the act it stands for happened.
--
-- PR #118 considered this shape and rejected it because "the last ranking" had no
-- definition the schema kept. Preserving `created_at` through a correction is that
-- definition; it is the first half of this migration for exactly that reason.
--
-- The `user_media` half is a state rule rather than a time rule, because a collection row
-- carries no instant for the act that touched it. 20260815040000 attached the update
-- triggers to a row *becoming* watched, and a bucket moving from one value to another is
-- not that: a title that already had a bucket was already watched, and re-rating it is a
-- correction of an opinion, not a viewing. The bucket clause now requires the old bucket
-- to be absent. `watched_on` and `progress` are untouched -- a new watch date and a season
-- completing are still watch signals.
--
-- ===========================================================================
-- WHAT DELIBERATELY DOES NOT CHANGE
--
--   * A first ranking removes a watchlist entry, and finishes a series, as it always did.
--   * *Log another watch* (`p_new_watch`) is a new ranking act: stamped now, takes the
--     entry, re-evaluates the series, posts one `title_ranked` (20260826000500).
--   * A correction still posts nothing (20260826000500), still fulfils no recommendation,
--     and still re-asserts the collection row (I3).
--   * Retry and idempotency: `_rank_finalize` runs at most once per operation id; a
--     replayed finishing answer is served from the ledger (20260825000200) and never
--     reaches it.
--   * #172's session integrity (20260926000100): the session functions are not rebuilt.
--     Only `_rank_finalize`, the two watchlist trigger functions and the two
--     `user_media` update triggers are.
--   * Placement history. This keeps `created_at` meaning "the latest ranking act"; it does
--     not record re-placements. That is the ledger T2 adds.
--
-- No backfill, and none is possible: an entry a correction already removed left no trace,
-- and a `created_at` a correction already moved has no earlier value to restore.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. `_rank_finalize`, restated whole
--
-- 20260902000100's body -- its true latest definition; nothing since has replaced it --
-- with three additions, each marked 20260928000100 in place: the old row's `created_at`
-- is read before the drop, the re-inserted row keeps it for a correction, and the comment
-- says so. Everything else is transcribed unchanged, because a `create or replace` cannot
-- be partial.
-- ---------------------------------------------------------------------------

create or replace function _rank_finalize(
  target uuid,
  item uuid,
  cat ranking_category,
  b taste_bucket,
  pos integer,
  session uuid,
  was_adjusted boolean default false,
  p_replaces boolean default false,
  p_new_watch boolean default false
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_band      record;
  v_size      integer;
  v_rank      integer;
  v_score     numeric;
  v_activated boolean;
  v_replaced  boolean := false;
  v_event_id  uuid;
  -- 20260902000100. The instant this activity sits at, which is what the adoption
  -- below moves an earlier announcement of this same act up to.
  v_causal_at timestamptz;
  -- 20260928000100. The instant the title entered the ranking, carried across a
  -- correction so the re-inserted row keeps it.
  v_kept_at   timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(target::text || cat::text, 0));

  -- The old position, dropped at the last possible moment rather than at the
  -- first (20260826000500). Everything above this line in the reader's session --
  -- opening the sheet, every comparison, every skip, closing it and coming back --
  -- left the ranking they already had exactly where it was.
  if p_replaces and exists (
    select 1 from rankings where user_id = target and media_item_id = item
  ) then
    -- 20260928000100. Read before the drop deletes it.
    select r.created_at into v_kept_at
      from rankings r
     where r.user_id = target and r.media_item_id = item;

    perform _rank_unrank_impl(target, item);
    v_replaced := true;
  end if;

  -- Recomputed inside the lock, so it reflects the ranking this insert is about
  -- to happen against rather than the one the caller saw. With the drop above, that
  -- is now also the numbering the session's offsets were computed in.
  select * into v_band from band_bounds(target, cat, b);

  -- Valid insertion points run from the top of the band to one past its end. An
  -- empty band yields hi = lo - 1, so the only valid point is lo, which is what
  -- this reduces to.
  if pos < v_band.lo or pos > v_band.hi + 1 then
    raise exception
      'refusing to place a % title at position %, outside the % band (% to %)',
      b, pos, b, v_band.lo, v_band.hi + 1
      using errcode = '22023';
  end if;

  update rankings
     set position = position + 1
   where user_id = target and category = cat and position >= pos;

  -- 20260928000100. `created_at` is the instant of the ranking act this row stands
  -- for: a first placement, or an explicit rewatch (`p_new_watch`), is now; a
  -- correction -- *Update your rating*, in the same band or another -- is not an act of
  -- its own and keeps the instant the ranking already had. The weekly streak, *Recently
  -- ranked* and the watchlist rule below all read this column, and every one of them
  -- was hearing a correction as a new ranking.
  insert into rankings (user_id, media_item_id, category, bucket, position, created_at)
  values (
    target, item, cat, b, pos,
    case when v_replaced and not p_new_watch then coalesce(v_kept_at, now()) else now() end
  );

  -- The collection row this ranking is a claim about, re-asserted from the ranking
  -- itself (20260825000200 §3). It closes I1 and I3 against anything that committed in
  -- the gap between the session opening and this transaction -- and it is the *only*
  -- writer of a provisional band change: `rank_rebucket` does not move
  -- `user_media.bucket` up front (20260826000500).
  insert into user_media (user_id, media_item_id, bucket)
  values (target, item, b)
  on conflict (user_id, media_item_id) do update
    set bucket = excluded.bucket, updated_at = now()
   where user_media.bucket is distinct from excluded.bucket;

  if session is not null then
    delete from ranking_sessions where id = session;
  end if;

  v_size  := v_band.size + 1;
  v_rank  := pos - v_band.lo + 1;
  v_score := score_for(b, v_rank, v_size);

  -- The founder's four War Dogs (20260826000500). A correction to an opinion already
  -- recorded is not a thing that happened to anybody else, so it does not become an
  -- activity. A first ranking always is one; another watch always is one. The id is
  -- kept now, because the fulfilment below points at it.
  if p_new_watch or not v_replaced then
    insert into feed_events (actor_id, type, media_item_id, payload)
    values (
      target,
      'title_ranked',
      item,
      jsonb_build_object(
        'position', pos,
        'bucket',   b,
        'category', cat,
        'score',    v_score
      )
    )
    returning id, causal_at into v_event_id, v_causal_at;

    /**
     * **The award that was announced before its own activity existed**
     * (20260902000100, and it is the mirror of the goal case).
     *
     * The Log sheet's first tap is `set_bucket`, which creates the `user_media` row --
     * "bucketing implies logging" -- and the collection award triggers fire on that
     * insert. The comparisons follow, and `title_ranked` is posted here, seconds or a
     * minute later. So the award is genuinely the OLDER row, by a real timestamp no
     * tiebreak can reach, and a newest-first feed put the ranking above the award it
     * looks like it earned. `causal_step` cannot help: it only orders rows that share a
     * `causal_at`, and these do not.
     *
     * That is the same shape as the goal completion `causal_at` was added for, pointing
     * the other way. A goal commits AFTER its cause and looks backwards to adopt it;
     * an award earned at log time commits BEFORE its cause, so the cause reaches back
     * and adopts the award.
     *
     * **Two facts decide it, and the first is stated rather than inferred.**
     *
     *   **The announcement names this title.** `feed_event_causes` (§2) is written by
     *   the collection award trigger and by a single-title goal crossing, and it is what
     *   makes this exact. It replaced a timestamp window, and independent review 76b is
     *   why: log A, log B and have B cross a tier, then rank A, and every timestamp
     *   bound available -- the row's creation, its last update, "nothing happened in
     *   between" -- is satisfied by B's award as readily as by A's. B's award was being
     *   adopted into A's group and shown to A's followers as the consequence of ranking
     *   A. Two writes seconds apart in one sitting, neither producing activity: nothing
     *   about *when* could tell them apart, so the writer says *which*.
     *
     *   **and nothing of the reader's happened in between.** That is the `not exists`,
     *   and it is `_maybe_goal_completion`'s own guard -- "is this the post it would sit
     *   directly under" -- asked from the other side. An award earned when a film was
     *   logged in March and ranked for the first time today has twenty activities
     *   between the two: it belongs where it is, and hauling it to the top of the feed
     *   would be the bug that guard was written to avoid, in a new place.
     *
     * Both the award and the goal are reached, and they arrive at different instants:
     * the Log sheet's bucket tap creates the collection row and the award triggers
     * announce there, then the sheet stamps the watch date in its own call and a goal
     * crossing announces at *that* moment. Both name this title, and both are unclaimed
     * until this ranking posts.
     *
     * When this transaction created the collection row itself the award shares
     * `causal_at` with the activity already, the strict inequality is false, nothing is
     * updated, and `causal_step` does the ordering as before.
     *
     * Only `causal_at` moves. `created_at` is untouched, so the row still says how long
     * ago it happened, and its id, payload, reactions and comments are all unchanged --
     * a feed that has already shown it re-sorts it rather than seeing a new event.
     */
    update feed_events fe
       set causal_at = v_causal_at
     where fe.actor_id = target
       and fe.type in ('award_earned', 'goal_completed')
       and fe.causal_at < v_causal_at
       and exists (
         select 1 from feed_event_causes fc
          where fc.feed_event_id = fe.id
            and fc.user_id = target
            and fc.media_item_id = item
       )
       -- `>=` and not `>`, which is a second and narrower way an old announcement could
       -- be hauled forward. A goal completed by a date taken AFTER a ranking inherits
       -- that ranking's own `causal_at` (`_maybe_goal_completion`), so it sits at the
       -- same instant as the activity that already claimed it -- and a strict `>` did
       -- not see that activity as intervening at all. Rank the same title again months
       -- later, with nothing else in between, and the old celebration moved up to the new
       -- ranking. An activity AT the announcement's instant has claimed it just as surely
       -- as one after it.
       and not exists (
         select 1
           from feed_events act
          where act.actor_id = target
            and act.type in ('title_ranked', 'season_completed', 'watchlist_added')
            and act.id <> v_event_id
            and act.causal_at >= fe.causal_at
            and act.causal_at <  v_causal_at
       );
  end if;

  -- NEW (20260827000600). A first ranking settles the recommendations that asked
  -- for it. `not v_replaced` is the same fact that just decided the feed event, so
  -- a fulfilling rank always has an event to point at -- and a Rank Again or a
  -- bucket change, being `v_replaced`, settles nothing and notifies nobody.
  --
  -- Fulfilment and notification are decided separately, in one statement: every
  -- outstanding delivered recommendation gets its timestamp -- once, ever, by the
  -- `fulfilled_at is null` guard -- and only senders the feed itself would answer
  -- get a row. `can_view_profile(sender, ranker)` refuses a block either way, a
  -- suspended sender's view of nothing, and a private ranker the sender does not
  -- follow; the active-status join refuses a suspended or half-deleted sender. A
  -- sender refused now is not queued for later: the moment passed.
  --
  -- One notification per sender because there is one recommendation row per
  -- sender (`unique (sender_id, recipient_id, media_item_id)`), each carrying its
  -- own id in the payload -- which is what the backstop index measures.
  if not v_replaced then
    with fulfilled as (
      update title_recommendations tr
         set fulfilled_at = now()
       where tr.recipient_id = target
         and tr.media_item_id = item
         and tr.state = 'delivered'
         and tr.fulfilled_at is null
      returning tr.id, tr.sender_id
    )
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    select f.sender_id,
           'recommendation_ranked',
           target,
           'feed_event',
           v_event_id,
           jsonb_build_object('recommendation_id', f.id)
      from fulfilled f
      join profiles sp
        on sp.id = f.sender_id
       and sp.status = 'active'
     where can_view_profile(f.sender_id, target)
    on conflict (((payload ->> 'recommendation_id')::uuid))
      where type = 'recommendation_ranked'
      do nothing;
  end if;

  -- PRD §28's activation, from the one place a ranking is created.
  v_activated := _maybe_activate_invite(target);

  return jsonb_build_object(
    'done', true,
    'position', pos,
    'category', cat,
    'bucket', b,
    'score', v_score,
    'adjustable', was_adjusted,
    'activated', v_activated
  );
end;
$$;

comment on function _rank_finalize(uuid, uuid, ranking_category, taste_bucket, integer, uuid, boolean, boolean, boolean) is
  'The one moment in the schema where a ranking is created. Carries 20260826000500''s behaviour whole: the drop happens inside the category lock, the band is recomputed there, and the title_ranked event posts iff p_new_watch or the placement created a position where there was none. Since 20260827000600 a first ranking also fulfils every outstanding delivered recommendation for the title -- once each, by the fulfilled_at guard -- and notifies the senders the feed itself would answer, pointing at the exact event it just posted. Since 20260902000100 it also adopts any award or goal announced by the insert that first put this title in the collection, when nothing of the reader''s happened in between: the Log sheet buckets before it ranks, so that announcement is a real minute older than the activity it belongs to, and a newest-first feed would otherwise show the ranking above the award it earned. Since 20260928000100 a correction (a replacement without p_new_watch) keeps the rankings.created_at the ranking already had, so it is not a new ranking act to the streak, Recently ranked or the watchlist rule; a first placement and an explicit rewatch are stamped now. Internal.';


-- ---------------------------------------------------------------------------
-- 2. The exact-object trigger function, restated whole
--
-- 20260815040000's body, with the chronology clause on its one statement. Everything that
-- file says about `security definer`, the schema-qualified relation and `pg_temp` pinned
-- last still holds.
-- ---------------------------------------------------------------------------

create or replace function _leave_watchlist()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- 20260928000100. Chronology, for the one table whose row carries the instant of
  -- the act: an entry the reader put on the watchlist AFTER this ranking's instant is
  -- a newer, deliberate "I want to see this again" and outlives it. A first placement
  -- or an explicit rewatch is stamped now, so every older entry still leaves exactly
  -- as before; a correction re-inserts with the instant the ranking already had, so an
  -- entry re-added since then is not touched. `user_media` rows carry no such instant
  -- and keep the rule as it was: their triggers fire only on a genuine transition.
  delete from public.watchlist w
   where w.user_id = new.user_id
     and w.media_item_id = new.media_item_id
     and (tg_table_name <> 'rankings' or w.created_at <= new.created_at);

  -- An AFTER ... FOR EACH ROW trigger's return value is ignored.
  return null;
end;
$$;

comment on function _leave_watchlist() is
  'Removes the exact (user, media item) from watchlist once it is watched or ranked. '
  'Attached to user_media and rankings by 20260815040000. Never touches a parent '
  'series when a season is written, and has no delete counterpart, so unlog does not '
  'restore an entry. Since 20260928000100, when fired by a rankings insert it removes only '
  'an entry added at or before the ranking''s created_at, so a correction -- which keeps '
  'the instant the ranking already had -- leaves an entry the reader re-added since.';


-- ---------------------------------------------------------------------------
-- 3. The series trigger function, restated whole
--
-- 20260906000100's body, with the same clause in the cheap exit (so a correction takes
-- no lock over an entry it cannot remove) and on the delete. The rule itself -- released
-- normal seasons, vacuous truth, the innermost advisory lock -- is unchanged.
-- ---------------------------------------------------------------------------

create or replace function _leave_series_watchlist()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_series   uuid;
  v_released integer;
  v_unmet    integer;
begin
  -- Only a season can finish a series. Movies have no parent and a series
  -- itself can never carry a watch signal (_assert_loggable refuses it), so
  -- everything else returns on one indexed read.
  select mi.parent_id into v_series
    from public.media_items mi
   where mi.id = new.media_item_id
     and mi.kind = 'season';

  if v_series is null then
    return null;
  end if;

  -- The cheap exit, and the common one: the parent is not on this user's
  -- watchlist, so there is nothing to remove and no lock worth taking. A
  -- concurrent set_watchlist(true) this snapshot cannot see is the rewatch
  -- re-add case, which the rule deliberately leaves alone.
  --
  -- 20260928000100. The same chronology _leave_watchlist applies: fired by a rankings
  -- insert, only a series entry added at or before that ranking's instant is a
  -- candidate. A season correction keeps its instant, so a series the reader re-added
  -- after finishing it -- to watch again -- is not re-evaluated away by a non-event.
  if not exists (
    select 1 from public.watchlist w
     where w.user_id = new.user_id
       and w.media_item_id = v_series
       and (tg_table_name <> 'rankings' or w.created_at <= new.created_at)
  ) then
    return null;
  end if;

  -- Serialise against the sibling season completing on another device. Taken
  -- before counting, so the count below is over committed truth.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'series-watchlist:' || new.user_id::text || ':' || v_series::text, 0
    )
  );

  -- One pass over the released normal seasons: how many exist, and how many
  -- are still unmet under 20260815040000's own definition of a watch signal.
  select count(*),
         count(*) filter (
           where not exists (
                   select 1 from public.rankings r
                    where r.user_id = new.user_id
                      and r.media_item_id = s.id
                 )
             and not exists (
                   select 1 from public.user_media um
                    where um.user_id = new.user_id
                      and um.media_item_id = s.id
                      and (
                        um.bucket is not null
                        or um.watched_on is not null
                        or um.progress = 'completed'
                      )
                 )
         )
    into v_released, v_unmet
    from public.media_items s
   where s.parent_id = v_series
     and s.kind = 'season'
     and s.season_number > 0
     and s.release_date is not null
     and s.release_date <= current_date;

  -- Kept while anything released is unmet, and kept on vacuous truth: a series
  -- whose catalogue entry knows no released normal season has not been
  -- finished, it has not been hydrated.
  if v_released = 0 or v_unmet > 0 then
    return null;
  end if;

  delete from public.watchlist w
   where w.user_id = new.user_id
     and w.media_item_id = v_series
     and (tg_table_name <> 'rankings' or w.created_at <= new.created_at);

  -- An AFTER ... FOR EACH ROW trigger's return value is ignored.
  return null;
end;
$$;

comment on function _leave_series_watchlist() is
  'Removes the PARENT SERIES from the watchlist once every currently released normal '
  'season (season_number > 0, release_date <= current_date) is watched or ranked by '
  'this user. Season 0 and undated or future seasons never block; a series with no '
  'released normal season rows in the catalogue is never removed. Peer of '
  '_leave_watchlist (20260815040000), which still governs the season''s own entry. '
  'Takes an advisory lock per (user, series) so two seasons completing concurrently '
  'converge on the removal. One-directional: unranking or unlogging re-adds nothing. '
  'Since 20260928000100, when fired by a rankings insert it considers only a series entry '
  'added at or before that ranking''s created_at, so a season correction leaves a series '
  'the reader re-added since.';


-- ---------------------------------------------------------------------------
-- 4. A re-rating is not a row becoming watched
--
-- The two `user_media` update triggers, recreated with one clause changed. The bucket
-- clause was `new.bucket is distinct from old.bucket and new.bucket is not null`, which
-- is true for loved -> fine as much as for null -> loved; it is now `old.bucket is null
-- and new.bucket is not null`. The `watched_on` and `progress` clauses are transcribed
-- unchanged from 20260815040000 and 20260906000100, as is the insert trigger, which is
-- not touched here.
-- ---------------------------------------------------------------------------

drop trigger if exists user_media_update_leaves_watchlist on user_media;

create trigger user_media_update_leaves_watchlist
  after update of bucket, watched_on, progress on user_media
  for each row
  when (
    (old.bucket is null and new.bucket is not null)
    or (new.watched_on is distinct from old.watched_on and new.watched_on is not null)
    or (new.progress is distinct from old.progress and new.progress = 'completed')
  )
  execute function _leave_watchlist();

drop trigger if exists user_media_update_leaves_series_watchlist on user_media;

create trigger user_media_update_leaves_series_watchlist
  after update of bucket, watched_on, progress on user_media
  for each row
  when (
    (old.bucket is null and new.bucket is not null)
    or (new.watched_on is distinct from old.watched_on and new.watched_on is not null)
    or (new.progress is distinct from old.progress and new.progress = 'completed')
  )
  execute function _leave_series_watchlist();
