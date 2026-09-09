-- ---------------------------------------------------------------------------
-- A correction is not another watch.
--
-- Founder decision, 2026-09-07. The Ranked menu names three acts, and the
-- database already tells two of them apart: *I watched it again* is a new watch
-- (`p_new_watch`), while *Adjust placement* and *Change your rating* are
-- corrections to an opinion already recorded -- they replace the position and
-- post no activity (20260826000500). What the schema had not carried through is
-- that a correction is ALSO not a watch signal for anything else that listens
-- for one. Two things listened, and both heard a watch where there was none.
--
-- **1. The watchlist.** A reader ranks a title, then deliberately puts it back on
-- the watchlist because they mean to see it again (`set_watchlist` permits this
-- and 20260815040000's own header calls it "a deliberate act"). They then open
-- Adjust placement. `_rank_finalize` performs a correction as a DELETE of the old
-- `rankings` row and an INSERT of the new one -- and `rankings_leaves_watchlist`
-- is an unconditional AFTER INSERT trigger, so the re-added row is deleted. A band
-- change reaches the same result by a second route: the `user_media` upsert
-- moves `bucket`, and `user_media_update_leaves_watchlist` reads that transition
-- as "becoming watched". Both are the exact mistake 20260815040000 §2 corrected
-- for `progress` and `watched_on`: a later explicit "I want to watch this again"
-- overruled by an older watch signal that nothing new had touched. The series
-- rule (20260906000100) has the same two triggers and the same defect.
--
-- **2. The placement date.** `rankings.created_at` is documented (PRD, the
-- 2026-08-30 sort contract) as "the moment the title entered their ranking,
-- which is the same instant their public *ranked X* activity already carries".
-- A correction posts no activity, so that instant must not move -- and it did,
-- because the re-inserted row took `now()`. The weekly streak reads that column
-- (`src/features/streaks/streak.ts`), whose header claims a re-ranking "cannot
-- fabricate" a week: an Adjust placement in a week with no other ranking
-- flipped *This week* to true and fired a streak celebration for a correction.
-- *Recently ranked* on the collection moved the title to the top for the same
-- non-event.
--
-- The rule, stated once:
--
--   A correction (`_rank_finalize` replacing a position with `p_new_watch`
--   false) leaves the watchlist exactly as it found it and keeps the placement
--   date the ranking already had. A first placement, and an explicit rewatch,
--   are watches and behave as they always have.
--
-- **The mechanism: a transaction-local marker, not a wider WHEN clause.** The
-- triggers cannot see intent -- an INSERT into `rankings` looks the same whether
-- it is the first placement or the replacement half of a correction, which is
-- why 20260815040000 attached the rule to the table in the first place. So
-- `_rank_finalize`, the one function that knows it is correcting, says so for
-- the duration of its two writes: `set_config('bingd.rank_correction', 'on',
-- true)`. The third argument is what makes this safe. A local setting lives for
-- the current transaction only, is discarded on commit and on abort, and is
-- never visible to another connection -- so it cannot leak across a pooled
-- session, cannot survive a raise, and cannot be set by a client, because no
-- client role reaches `_rank_finalize`. It is cleared again after the
-- `user_media` upsert so nothing later in the same transaction can shelter
-- behind it. The two trigger functions ask one question each, before anything
-- else: is this a correction? If so, return.
--
-- Considered and rejected: teaching the triggers to compare against the
-- watchlist row's own `created_at` ("only remove an entry older than the last
-- ranking"). It would need a definition of "the last ranking" the schema does
-- not keep, and it would change first-watch behaviour that is settled.
--
-- What deliberately does NOT change:
--
--   * Every other watch signal. A bare `rankings` insert, `set_bucket`,
--     `log_watched`, `set_season_progress('completed')` and a first `rank_start`
--     still remove the exact object, and still finish a series. The marker is
--     set in one function, for one branch, and nowhere else.
--   * *I watched it again* (`p_new_watch`). It is a watch: the entry leaves, the
--     series rule re-evaluates, `created_at` is now, and one activity posts --
--     20260826000500 unchanged.
--   * The one-directional rule. Nothing here re-adds anything.
--   * Retry and idempotency. The marker is set inside `_rank_finalize`, which
--     runs at most once per operation id (20260825000200); a replayed finishing
--     answer is served from the ledger and never reaches it.
--
-- No backfill, and none is possible: a watchlist row already removed by a
-- correction carries no record that it was, and a `created_at` already moved has
-- no earlier value to restore. Both are stated here so nobody goes looking.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The exact-object trigger function, restated whole
--
-- 20260815040000's body with one guard at the top. Everything that file says
-- about `security definer`, the schema-qualified relation and `pg_temp` pinned
-- last still holds and is not repeated.
-- ---------------------------------------------------------------------------

create or replace function _leave_watchlist()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A correction in flight (20260911000100). `current_setting(..., true)` is
  -- null rather than an error when the marker was never set in this session.
  if coalesce(current_setting('bingd.rank_correction', true), '') = 'on' then
    return null;
  end if;

  delete from public.watchlist
   where user_id = new.user_id
     and media_item_id = new.media_item_id;

  -- An AFTER ... FOR EACH ROW trigger's return value is ignored.
  return null;
end;
$$;

comment on function _leave_watchlist() is
  'Removes the exact (user, media item) from watchlist once it is watched or ranked. '
  'Attached to user_media and rankings by 20260815040000. Never touches a parent '
  'series when a season is written, and has no delete counterpart, so unlog does not '
  'restore an entry. Since 20260911000100 it does nothing while _rank_finalize has '
  'marked the transaction as a correction (Adjust placement, Change your rating): a '
  'correction replaces a position and is not a watch.';

-- ---------------------------------------------------------------------------
-- 2. The series trigger function, restated whole
--
-- 20260906000100's body with the same guard, placed before the cheap exit so
-- a correction takes no lock and counts nothing. The rule itself -- released
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
  -- A correction in flight (20260911000100): no season became met, so there is
  -- nothing to re-evaluate.
  if coalesce(current_setting('bingd.rank_correction', true), '') = 'on' then
    return null;
  end if;

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
  if not exists (
    select 1 from public.watchlist w
     where w.user_id = new.user_id
       and w.media_item_id = v_series
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

  delete from public.watchlist
   where user_id = new.user_id
     and media_item_id = v_series;

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
  'Since 20260911000100 it does nothing while _rank_finalize has marked the '
  'transaction as a correction.';

-- ---------------------------------------------------------------------------
-- 3. `_rank_finalize`, restated whole
--
-- 20260902000100's body with three additions, each marked `20260911000100` in
-- place: the old row's `created_at` is read before the drop; the marker is set
-- for the two writes a correction makes and cleared after them; and the new row
-- keeps the old placement date when, and only when, it is a correction. The
-- feed event, the fulfilment, the adoption and the activation are untouched and
-- restated because a `create or replace` cannot be partial.
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
  -- 20260911000100. The placement date the ranking already had, carried across a
  -- correction so the row keeps the instant its activity was announced at.
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
    -- 20260911000100. Read before the drop deletes it.
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

  -- 20260911000100. A correction is not a watch. For the two writes below --
  -- this insert and the user_media upsert -- the watchlist triggers are told so,
  -- through a setting that lives for this transaction only and is cleared again
  -- the moment those writes are done. An explicit rewatch sets nothing: it is a
  -- watch, and the entry leaves as it always did.
  if v_replaced and not p_new_watch then
    perform set_config('bingd.rank_correction', 'on', true);
  end if;

  -- The placement date is the instant the title entered the ranking, which is
  -- the instant its title_ranked activity carries (PRD, the sort contract). A
  -- correction posts no activity, so it keeps the date it had; a first placement
  -- and a rewatch are now.
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

  -- 20260911000100. Cleared unconditionally: nothing after this line is a write
  -- the watchlist rule should be blind to.
  perform set_config('bingd.rank_correction', '', true);

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
  'The one moment in the schema where a ranking is created. Carries 20260826000500''s behaviour whole: the drop happens inside the category lock, the band is recomputed there, and the title_ranked event posts iff p_new_watch or the placement created a position where there was none. Since 20260827000600 a first ranking also fulfils every outstanding delivered recommendation for the title -- once each, by the fulfilled_at guard -- and notifies the senders the feed itself would answer, pointing at the exact event it just posted. Since 20260902000100 it also adopts any award or goal announced by the insert that first put this title in the collection, when nothing of the reader''s happened in between: the Log sheet buckets before it ranks, so that announcement is a real minute older than the activity it belongs to, and a newest-first feed would otherwise show the ranking above the award it earned. Since 20260911000100 a correction (a replacement with p_new_watch false) marks its transaction with bingd.rank_correction for its rankings insert and user_media upsert, so the watchlist triggers leave a deliberately re-added entry alone, and keeps the old created_at, so the placement date does not move for a non-event. Internal.';

